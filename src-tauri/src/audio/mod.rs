//! Audio decoding + resampling.
//!
//! `symphonia` handles demux/decode for every format chordMatik accepts
//! (mp3, wav, m4a/aac/alac, flac, ogg/vorbis). `rubato` converts the decoded
//! signal to the analysis sample rate used by the DSP/ML stages.
//!
//! This module is OS-agnostic: it only touches the filesystem and pure-Rust
//! DSP, so it ports to Windows unchanged.
//!
//! `capture` is the one OS-specific exception (macOS system-audio capture).

pub mod capture;

use std::fs::File;
use std::path::Path;
use std::sync::Mutex;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use rubato::{FftFixedIn, Resampler};

/// Sample rate the chord model + DSP operate at (matches BTC's 22.05 kHz).
pub const ANALYSIS_SAMPLE_RATE: u32 = 22_050;

/// 1-entry cache of the last `decode_analysis` result. Analyze, detect_beat,
/// track_beats and refine_sync all decode the SAME wav to 22.05 kHz mono back to
/// back; caching the decode saves several seconds of repeated work per song.
static DECODE_CACHE: Mutex<Option<(String, u64, u64, std::sync::Arc<Vec<f32>>)>> =
    Mutex::new(None);

/// Decode `path` to mono 22.05 kHz, memoised by (path, mtime, size). Returns a
/// shared buffer — callers read it, they don't mutate it.
pub fn decode_analysis(path: &Path) -> Result<std::sync::Arc<Vec<f32>>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();
    let key = path.to_string_lossy().to_string();
    if let Ok(guard) = DECODE_CACHE.lock() {
        if let Some((k, mt, sz, sig)) = guard.as_ref() {
            if *k == key && *mt == mtime && *sz == size {
                return Ok(sig.clone());
            }
        }
    }
    let decoded = decode_file(path)?;
    let signal = resample_mono(&decoded.samples_mono, decoded.sample_rate, ANALYSIS_SAMPLE_RATE)?;
    let sig = std::sync::Arc::new(signal);
    if let Ok(mut guard) = DECODE_CACHE.lock() {
        *guard = Some((key, mtime, size, sig.clone()));
    }
    Ok(sig)
}

/// A fully-decoded track, mixed down to mono at its source sample rate.
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    /// Mono mixdown, f32 in roughly [-1, 1], at `sample_rate`.
    pub samples_mono: Vec<f32>,
}

/// Decode any supported file to a mono f32 buffer at its native sample rate.
pub fn decode_file(path: &Path) -> Result<DecodedAudio, String> {
    let file = File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported or corrupt audio: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no decodable audio track found".to_string())?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let source_sr = codec_params.sample_rate.unwrap_or(44_100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder for this format: {e}"))?;

    let mut samples_mono: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut buf_capacity: usize = 0;
    let mut channels: u16 = codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean end of stream.
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("read error: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                channels = spec.channels.count() as u16;
                let frames = decoded.capacity();

                // (Re)allocate the conversion buffer if a packet is larger.
                if sample_buf.is_none() || frames > buf_capacity {
                    sample_buf = Some(SampleBuffer::<f32>::new(frames as u64, spec));
                    buf_capacity = frames;
                }
                let buf = sample_buf.as_mut().unwrap();
                buf.copy_interleaved_ref(decoded);

                let ch = spec.channels.count().max(1);
                samples_mono.reserve(buf.samples().len() / ch);
                for frame in buf.samples().chunks(ch) {
                    let sum: f32 = frame.iter().copied().sum();
                    samples_mono.push(sum / ch as f32);
                }
            }
            // A single corrupt packet shouldn't abort the whole decode.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(format!("decode error: {e}")),
        }
    }

    if samples_mono.is_empty() {
        return Err("decoded zero audio samples".to_string());
    }

    let duration_sec = samples_mono.len() as f64 / source_sr as f64;
    Ok(DecodedAudio {
        sample_rate: source_sr,
        channels,
        duration_sec,
        samples_mono,
    })
}

/// Decoded stereo track (L/R kept separate) at its native sample rate — used by
/// source separation, which needs the two channels. Mono sources duplicate.
#[cfg(feature = "btc")]
pub struct StereoAudio {
    pub sample_rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// Decode any supported file to two f32 channels at its native sample rate.
#[cfg(feature = "btc")]
pub fn decode_file_stereo(path: &Path) -> Result<StereoAudio, String> {
    let file = File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported or corrupt audio: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no decodable audio track found".to_string())?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let source_sr = codec_params.sample_rate.unwrap_or(44_100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder for this format: {e}"))?;

    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut buf_capacity: usize = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("read error: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let frames = decoded.capacity();
                if sample_buf.is_none() || frames > buf_capacity {
                    sample_buf = Some(SampleBuffer::<f32>::new(frames as u64, spec));
                    buf_capacity = frames;
                }
                let buf = sample_buf.as_mut().unwrap();
                buf.copy_interleaved_ref(decoded);
                let ch = spec.channels.count().max(1);
                for frame in buf.samples().chunks(ch) {
                    left.push(frame[0]);
                    right.push(if ch >= 2 { frame[1] } else { frame[0] });
                }
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(e) => return Err(format!("decode error: {e}")),
        }
    }

    if left.is_empty() {
        return Err("decoded zero audio samples".to_string());
    }
    Ok(StereoAudio {
        sample_rate: source_sr,
        left,
        right,
    })
}

/// Downsample a mono signal into `buckets` peak values normalized to [0, 1],
/// suitable for drawing a static waveform overview.
pub fn compute_peaks(samples: &[f32], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let bucket_size = (samples.len() as f64 / buckets as f64).ceil().max(1.0) as usize;
    let mut peaks: Vec<f32> = Vec::with_capacity(buckets);
    let mut global_max = f32::EPSILON;

    for chunk in samples.chunks(bucket_size) {
        let mut peak = 0.0f32;
        for &s in chunk {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        global_max = global_max.max(peak);
        peaks.push(peak);
    }

    // Normalize so the loudest peak fills the waveform height.
    let inv = 1.0 / global_max;
    for p in &mut peaks {
        *p = (*p * inv).clamp(0.0, 1.0);
    }
    peaks
}

/// Resample a mono signal to `to_sr` using a high-quality FFT resampler.
/// Returns the input unchanged when the rates already match.
pub fn resample_mono(input: &[f32], from_sr: u32, to_sr: u32) -> Result<Vec<f32>, String> {
    if input.is_empty() || from_sr == to_sr {
        return Ok(input.to_vec());
    }
    let chunk = 8192usize;
    let mut resampler = FftFixedIn::<f32>::new(from_sr as usize, to_sr as usize, chunk, 2, 1)
        .map_err(|e| format!("resampler init failed: {e}"))?;

    let est = (input.len() as u128 * to_sr as u128 / from_sr as u128) as usize + chunk;
    let mut out: Vec<f32> = Vec::with_capacity(est);
    let mut in_buf = vec![vec![0f32; chunk]; 1];
    let mut pos = 0usize;

    while pos < input.len() {
        let need = resampler.input_frames_next();
        if in_buf[0].len() != need {
            in_buf[0].resize(need, 0.0);
        }
        let n = (input.len() - pos).min(need);
        in_buf[0][..n].copy_from_slice(&input[pos..pos + n]);
        for s in &mut in_buf[0][n..need] {
            *s = 0.0;
        }
        let res = resampler
            .process(&in_buf, None)
            .map_err(|e| format!("resample failed: {e}"))?;
        out.extend_from_slice(&res[0]);
        pos += need;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    #[test]
    fn decodes_every_supported_format() {
        for name in ["tone.wav", "tone.mp3", "tone.flac", "tone.m4a", "tone.ogg"] {
            let d = decode_file(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(d.sample_rate, 44_100, "{name}: sample rate");
            assert_eq!(d.channels, 2, "{name}: channels");
            assert!(
                (d.duration_sec - 2.0).abs() < 0.3,
                "{name}: duration {} not ~2s",
                d.duration_sec
            );
            // Far above the silence floor (~1e-4) — confirms real audio decoded.
            let max = d.samples_mono.iter().fold(0f32, |m, &s| m.max(s.abs()));
            assert!(max > 0.02, "{name}: signal too quiet ({max})");
        }
    }

    #[test]
    fn peaks_are_normalized_to_unit_range() {
        let d = decode_file(&fixture("tone.wav")).unwrap();
        let peaks = compute_peaks(&d.samples_mono, 256);
        assert_eq!(peaks.len(), 256);
        assert!(peaks.iter().all(|&p| (0.0..=1.0).contains(&p)));
        let max = peaks.iter().copied().fold(0f32, f32::max);
        assert!((max - 1.0).abs() < 1e-3, "loudest peak should be ~1.0, got {max}");
    }

    #[test]
    fn missing_file_errors_cleanly() {
        assert!(decode_file(&fixture("does-not-exist.mp3")).is_err());
    }
}
