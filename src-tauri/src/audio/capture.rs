//! macOS system-audio capture via ScreenCaptureKit.
//!
//! Captures whatever is currently playing on the Mac's display audio (e.g. the
//! embedded YouTube player), mixes it down to mono f32, and writes a 32-bit
//! float WAV that feeds straight into the existing analyze pipeline
//! (`audio::decode_file` reads it back via symphonia → CQT → chord decode).
//!
//! Policy note: this captures audio that is *already audible and already
//! decoded* on the user's machine. It never downloads or extracts a remote
//! stream — it is the on-device, consented analogue of "play it once and the
//! app listens", not a YouTube ripper.

use std::path::PathBuf;

/// Sample rate requested from ScreenCaptureKit. The analyze path resamples to
/// `ANALYSIS_SAMPLE_RATE` regardless, so the exact value only needs to be sane.
const CAPTURE_SAMPLE_RATE: u32 = 48_000;

/// Outcome of a capture: where the WAV landed + how long it is.
pub struct CaptureResult {
    pub wav_path: PathBuf,
    pub duration_sec: f64,
}

/// Write mono f32 PCM to a 32-bit-float WAV. Errors on empty capture, which is
/// how a silently-denied permission surfaces (no error is raised by the OS).
fn write_mono_f32_wav(
    path: &PathBuf,
    samples: &[f32],
    sample_rate: u32,
) -> Result<CaptureResult, String> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    if samples.is_empty() || sample_rate == 0 {
        return Err(
            "No audio was captured. Make sure the video is playing, and grant chordMatik \
             Screen Recording access in System Settings › Privacy & Security, then relaunch."
                .into(),
        );
    }
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut w = WavWriter::create(path, spec).map_err(|e| format!("wav create: {e}"))?;
    for &s in samples {
        w.write_sample(s).map_err(|e| format!("wav write: {e}"))?;
    }
    w.finalize().map_err(|e| format!("wav finalize: {e}"))?;
    Ok(CaptureResult {
        wav_path: path.clone(),
        duration_sec: samples.len() as f64 / sample_rate as f64,
    })
}

/// Begin capturing system audio. Triggers the Screen Recording permission
/// prompt on first use.
pub fn start() -> Result<CaptureSession, String> {
    #[cfg(target_os = "macos")]
    {
        macos::CaptureSession::start()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("system audio capture is only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
pub use macos::CaptureSession;

/// Stub so the rest of the app (commands, state) compiles on non-macOS targets.
#[cfg(not(target_os = "macos"))]
pub struct CaptureSession;

#[cfg(not(target_os = "macos"))]
impl CaptureSession {
    pub fn stop_and_write(self, _out: PathBuf) -> Result<CaptureResult, String> {
        Err("system audio capture is only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{write_mono_f32_wav, CaptureResult, CAPTURE_SAMPLE_RATE};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use screencapturekit::prelude::*;

    struct Sink {
        mono: Vec<f32>,
        /// Keep at most this many samples (0 = unbounded). Live mode caps to a
        /// rolling window; Record keeps everything.
        cap: usize,
    }

    struct AudioHandler {
        sink: Arc<Mutex<Sink>>,
    }

    impl SCStreamOutputTrait for AudioHandler {
        fn did_output_sample_buffer(
            &self,
            sample: CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type != SCStreamOutputType::Audio {
                return;
            }
            let Some(list) = sample.audio_buffer_list() else {
                return;
            };
            let n = list.num_buffers();
            if n == 0 {
                return;
            }
            // ScreenCaptureKit delivers non-interleaved 32-bit float PCM: one
            // AudioBuffer per channel. Mix down to mono by averaging channels.
            let frames = (0..n)
                .filter_map(|i| list.get(i))
                .map(|b| b.data().len() / 4)
                .min()
                .unwrap_or(0);
            if frames == 0 {
                return;
            }
            let mut mono = vec![0.0f32; frames];
            let mut nchan = 0usize;
            for i in 0..n {
                if let Some(buf) = list.get(i) {
                    let bytes = buf.data();
                    // The CoreMedia block-buffer pointer carries no alignment
                    // guarantee, so reinterpreting &[u8] as *const f32 would be UB.
                    // Decode each 4-byte little-endian float instead.
                    for (fr, chunk) in bytes.chunks_exact(4).take(frames).enumerate() {
                        mono[fr] += f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    }
                    nchan += 1;
                }
            }
            if nchan > 1 {
                let inv = 1.0 / nchan as f32;
                for m in mono.iter_mut() {
                    *m *= inv;
                }
            }
            if let Ok(mut s) = self.sink.lock() {
                s.mono.extend_from_slice(&mono);
                if s.cap != 0 && s.mono.len() > s.cap {
                    let drop = s.mono.len() - s.cap;
                    s.mono.drain(0..drop);
                }
            }
        }
    }

    /// Shared SCStream setup: tiny video (required) + system audio capture.
    fn build_stream(sink: Arc<Mutex<Sink>>) -> Result<SCStream, String> {
        let content = SCShareableContent::get().map_err(|e| format!("screen content: {e}"))?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or("no display found for audio capture")?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();
        let config = SCStreamConfiguration::new()
            .with_width(128)
            .with_height(128)
            .with_captures_audio(true)
            .with_sample_rate(CAPTURE_SAMPLE_RATE as i32)
            .with_channel_count(2);
        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(AudioHandler { sink }, SCStreamOutputType::Audio);
        stream
            .start_capture()
            .map_err(|e| format!("start capture: {e}"))?;
        Ok(stream)
    }

    pub struct CaptureSession {
        stream: SCStream,
        sink: Arc<Mutex<Sink>>,
    }
    // SAFETY: the SCStream + sink are only touched from the start/stop command
    // handlers, serialized behind the Tauri-managed Mutex<Option<_>>.
    unsafe impl Send for CaptureSession {}

    impl CaptureSession {
        pub fn start() -> Result<Self, String> {
            let sink = Arc::new(Mutex::new(Sink {
                mono: Vec::new(),
                cap: 0, // unbounded — Record keeps the whole take
            }));
            let stream = build_stream(sink.clone())?;
            Ok(Self { stream, sink })
        }

        pub fn stop_and_write(self, out: PathBuf) -> Result<CaptureResult, String> {
            self.stream
                .stop_capture()
                .map_err(|e| format!("stop capture: {e}"))?;
            let sink = self
                .sink
                .lock()
                .map_err(|_| "capture sink poisoned".to_string())?;
            write_mono_f32_wav(&out, &sink.mono, CAPTURE_SAMPLE_RATE)
        }
    }

    /// Thread-safe reader over the rolling buffer — the detector worker holds a
    /// clone of this and pulls windows without touching the (non-Sync) stream.
    #[derive(Clone)]
    pub struct LiveReader {
        sink: Arc<Mutex<Sink>>,
    }

    impl LiveReader {
        /// Copy out the most recent `seconds` of mono audio (≤ the rolling cap).
        pub fn snapshot(&self, seconds: f32) -> Vec<f32> {
            let want = (CAPTURE_SAMPLE_RATE as f32 * seconds) as usize;
            match self.sink.lock() {
                Ok(s) => {
                    let start = s.mono.len().saturating_sub(want);
                    s.mono[start..].to_vec()
                }
                Err(_) => Vec::new(),
            }
        }
    }

    /// Continuous capture into a rolling window, for live chord detection.
    pub struct LiveCapture {
        stream: SCStream,
        sink: Arc<Mutex<Sink>>,
    }
    // SAFETY: see CaptureSession — accessed only behind the managed Mutex.
    unsafe impl Send for LiveCapture {}

    impl LiveCapture {
        pub fn start() -> Result<Self, String> {
            // Keep the last ~6 s so each detection window is always available.
            let sink = Arc::new(Mutex::new(Sink {
                mono: Vec::new(),
                cap: CAPTURE_SAMPLE_RATE as usize * 6,
            }));
            let stream = build_stream(sink.clone())?;
            Ok(Self { stream, sink })
        }

        /// A cloneable reader for the worker thread.
        pub fn reader(&self) -> LiveReader {
            LiveReader {
                sink: self.sink.clone(),
            }
        }

        pub fn stop(self) {
            let _ = self.stream.stop_capture();
        }
    }
}

/// Sample rate of captured audio (before the analysis pipeline resamples it).
pub fn capture_sample_rate() -> u32 {
    CAPTURE_SAMPLE_RATE
}

#[cfg(target_os = "macos")]
pub use macos::LiveCapture;

#[cfg(not(target_os = "macos"))]
pub struct LiveCapture;
#[cfg(not(target_os = "macos"))]
#[derive(Clone)]
pub struct LiveReader;

#[cfg(not(target_os = "macos"))]
impl LiveCapture {
    pub fn start() -> Result<Self, String> {
        Err("live capture is only supported on macOS".into())
    }
    pub fn reader(&self) -> LiveReader {
        LiveReader
    }
    pub fn stop(self) {}
}

#[cfg(not(target_os = "macos"))]
impl LiveReader {
    pub fn snapshot(&self, _seconds: f32) -> Vec<f32> {
        Vec::new()
    }
}
