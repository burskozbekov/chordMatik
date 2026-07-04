//! Lightweight on-device tempo + start estimation (the "auto-guess" brain).
//!
//! Classic DSP, no ML model: a spectral-flux onset envelope from the existing CQT,
//! autocorrelation for the dominant period (with a log-normal tempo prior to curb
//! octave errors), and the first strong onset for the start. Gives a (bpm, start)
//! the user then fine-tunes — exactly the role the research assigns to auto-detect.

use super::Spectrogram;

/// Half-wave-rectified spectral flux over bins `[lo, hi)`, normalized to a 0–1 peak.
/// (Log-magnitude flux is standard for onset detection — it compresses dynamics so
/// transients dominate over sustain.)
fn flux_envelope(spec: &Spectrogram, lo: usize, hi: usize) -> Vec<f32> {
    let mut env = vec![0f32; spec.frames];
    for f in 1..spec.frames {
        let cur = spec.frame(f);
        let prev = spec.frame(f - 1);
        let mut flux = 0f32;
        for k in lo..hi {
            let d = (1.0 + cur[k]).ln() - (1.0 + prev[k]).ln();
            if d > 0.0 {
                flux += d;
            }
        }
        env[f] = flux;
    }
    let max = env.iter().copied().fold(0f32, f32::max).max(1e-9);
    for x in &mut env {
        *x /= max;
    }
    env
}

/// Full-band onset envelope — used for the start anchor + onset peaks.
pub fn onset_envelope(spec: &Spectrogram) -> Vec<f32> {
    flux_envelope(spec, 0, spec.n_bins)
}

/// BASS-weighted onset envelope (bottom third of bins). The felt tactus (kick/bass)
/// sits in the low register while subdivisions (hi-hat) sit high, so autocorrelating
/// this locks onto the BEAT instead of a half/double 8th-note octave — the key to
/// getting e.g. Careless Whisper's 76 BPM instead of 152. Use for TEMPO estimation.
pub fn bass_onset_envelope(spec: &Spectrogram) -> Vec<f32> {
    flux_envelope(spec, 0, (spec.n_bins / 3).max(1))
}

/// Dominant tempo (BPM) via autocorrelation of the onset envelope, weighted by a
/// log-normal prior around 120 BPM so it doesn't lock onto a half/double octave.
pub fn estimate_tempo(env: &[f32], hop_sec: f64) -> f32 {
    let n = env.len();
    if n < 8 {
        return 120.0;
    }
    // Fractional-lag comb search: at a ~93ms hop an integer-lag autocorrelation
    // quantizes tempo by several BPM near 110, so we test BPM hypotheses on a fine
    // grid and read the onset envelope at the (interpolated) fractional lag.
    let mut best_bpm = 120.0f64;
    let mut best_score = f32::MIN;
    let mut bpm10 = 550; // 55.0 BPM
    while bpm10 <= 2050 {
        // up to 205.0 BPM, 0.25 steps below
        let bpm = bpm10 as f64 / 10.0;
        let lag = (60.0 / bpm) / hop_sec; // fractional frames
        let li = lag.floor() as usize;
        let frac = (lag - li as f64) as f32;
        if li >= 1 && li + 1 < n {
            let mut sum = 0f32;
            for i in (li + 1)..n {
                let shifted = env[i - li] * (1.0 - frac) + env[i - li - 1] * frac;
                sum += env[i] * shifted;
            }
            // log-normal prior around 120 BPM (sigma ~0.9 octaves) curbs octave errors.
            let z = (bpm / 120.0).ln() / std::f64::consts::LN_2 / 0.9;
            let score = sum * (-0.5 * z * z).exp() as f32;
            if score > best_score {
                best_score = score;
                best_bpm = bpm;
            }
        }
        bpm10 += if bpm < 100.0 { 2 } else { 3 }; // ~0.2–0.3 BPM resolution
    }
    best_bpm as f32
}

/// A fine-resolution onset envelope (log-energy flux at a ~11.6 ms hop) computed
/// straight from the waveform — for BEAT TRACKING, where the CQT's ~23 ms hop is
/// too coarse to time beats (it quantizes the tempo). Returns `(env, hop_seconds)`.
pub fn fine_onset_envelope(signal: &[f32], sr: u32) -> (Vec<f32>, f64) {
    const WIN: usize = 1024;
    const HOP: usize = 256;
    let hop_sec = HOP as f64 / sr as f64;
    if signal.len() < WIN + HOP {
        return (Vec::new(), hop_sec);
    }
    let n = (signal.len() - WIN) / HOP;
    let mut log_e = vec![0f32; n];
    for i in 0..n {
        let s = i * HOP;
        let mut e = 0f32;
        for j in 0..WIN {
            let v = signal[s + j];
            e += v * v;
        }
        log_e[i] = (1e-6 + e).ln();
    }
    let mut env = vec![0f32; n];
    for i in 1..n {
        let d = log_e[i] - log_e[i - 1];
        env[i] = d.max(0.0);
    }
    let mx = env.iter().copied().fold(0f32, f32::max).max(1e-9);
    for v in &mut env {
        *v /= mx;
    }
    (env, hop_sec)
}

/// Dynamic-programming beat tracker (Ellis 2007 / librosa-style): finds beat
/// frames that maximize onset strength while staying near the target period, so
/// the beats FOLLOW the recording's real tempo (and its drift) instead of a rigid
/// grid. `bpm` sets the target period (and hence the octave). Returns beat times
/// in seconds, sub-frame refined by parabolic interpolation around each onset.
pub fn track_beats(env: &[f32], hop_sec: f64, bpm: f32) -> Vec<f64> {
    let n = env.len();
    if n < 16 || !(bpm > 0.0) {
        return Vec::new();
    }
    let period = (((60.0 / bpm as f64) / hop_sec).round() as usize).max(2);
    let tightness = 100.0f64; // how strictly beats hug the target period

    // Normalize the onset envelope to unit std so `tightness` is scale-independent.
    let mean = env.iter().map(|&v| v as f64).sum::<f64>() / n as f64;
    let var = env.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n as f64;
    let std = var.sqrt().max(1e-9);
    let local: Vec<f64> = env.iter().map(|&v| (v as f64 - mean) / std).collect();

    let mut cum = vec![0f64; n];
    let mut back = vec![-1i64; n];
    let lo = (period / 2).max(1);
    let hi = 2 * period;
    for t in 0..n {
        let mut best = f64::NEG_INFINITY;
        let mut best_tau: i64 = -1;
        if t >= lo {
            let start = t.saturating_sub(hi);
            let end = t - lo; // ensures interval (t - tau) in [lo, hi]
            for tau in start..=end {
                let interval = (t - tau) as f64;
                let pen = (interval / period as f64).ln();
                let sc = cum[tau] - tightness * pen * pen;
                if sc > best {
                    best = sc;
                    best_tau = tau as i64;
                }
            }
        }
        if best_tau < 0 {
            cum[t] = local[t];
            back[t] = -1;
        } else {
            cum[t] = local[t] + best;
            back[t] = best_tau;
        }
    }

    // Tail = strongest cumulative score among the final period (the last beat).
    let tail_start = n.saturating_sub(period);
    let mut tail = tail_start;
    let mut best = f64::NEG_INFINITY;
    for t in tail_start..n {
        if cum[t] > best {
            best = cum[t];
            tail = t;
        }
    }

    // Backtrack the beat chain.
    let mut frames: Vec<usize> = Vec::new();
    let mut t = tail as i64;
    while t >= 0 {
        frames.push(t as usize);
        t = back[t as usize];
    }
    frames.reverse();

    // Sub-frame parabolic refinement around each beat's onset peak.
    frames
        .into_iter()
        .map(|f| {
            let mut off = 0.0f64;
            if f >= 1 && f + 1 < n {
                let (a, b, c) = (env[f - 1] as f64, env[f] as f64, env[f + 1] as f64);
                let denom = a - 2.0 * b + c;
                if denom.abs() > 1e-9 {
                    off = (0.5 * (a - c) / denom).clamp(-0.5, 0.5);
                }
            }
            (f as f64 + off) * hop_sec
        })
        .collect()
}

/// Time (s) of the first strong onset PEAK, sub-frame refined — a start anchor
/// the user nudges. Requires a local maximum (not just a rising edge) so it lands
/// on the transient, and parabolic-interpolates to beat the ~93ms frame grid.
pub fn first_onset(env: &[f32], hop_sec: f64) -> f64 {
    let thresh = 0.25; // env is peak-normalized to 1.0
    let n = env.len();
    for f in 1..n.saturating_sub(1) {
        if env[f] > thresh && env[f] >= env[f - 1] && env[f] > env[f + 1] {
            let (y0, y1, y2) = (env[f - 1], env[f], env[f + 1]);
            let denom = y0 - 2.0 * y1 + y2;
            let off = if denom.abs() > 1e-9 {
                (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) as f64
            } else {
                0.0
            };
            return (f as f64 + off) * hop_sec;
        }
    }
    // No clear peak — fall back to the first frame above threshold.
    env.iter()
        .position(|&v| v > thresh)
        .map(|f| f as f64 * hop_sec)
        .unwrap_or(0.0)
}

/// Strong onset peak times (s): local maxima above an adaptive threshold, with
/// sub-frame parabolic refinement. Used to magnetically snap the manual start
/// marker onto the nearest real transient.
pub fn onset_peaks(env: &[f32], hop_sec: f64) -> Vec<f64> {
    let n = env.len();
    if n < 3 {
        return Vec::new();
    }
    let mean = env.iter().sum::<f32>() / n as f32;
    let thresh = (mean * 1.6).max(0.12);
    let mut peaks = Vec::new();
    for i in 1..n - 1 {
        if env[i] > thresh && env[i] >= env[i - 1] && env[i] > env[i + 1] {
            let (y0, y1, y2) = (env[i - 1], env[i], env[i + 1]);
            let denom = y0 - 2.0 * y1 + y2;
            let off = if denom.abs() > 1e-9 {
                (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) as f64
            } else {
                0.0
            };
            peaks.push((i as f64 + off) * hop_sec);
        }
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::Spectrogram;

    /// Build a fake spectrogram with an energy impulse every `period` frames.
    fn click_spec(frames: usize, n_bins: usize, period: usize) -> Spectrogram {
        let mut data = vec![0f32; frames * n_bins];
        for f in 0..frames {
            if f % period == 0 {
                for k in 0..n_bins {
                    data[f * n_bins + k] = 1.0;
                }
            }
        }
        Spectrogram { frames, n_bins, data }
    }

    #[test]
    fn recovers_known_tempo() {
        // hop 2048/22050 ≈ 0.0929s; period 21 frames ≈ 1.951s/period... pick a
        // period that maps to a clean BPM. period=10 → 0.929s → ~64.6 BPM? Use a
        // period giving ~120 BPM: 60/120 = 0.5s → 0.5/0.0929 ≈ 5.38 → use 5.
        let hop = 2048.0 / 22050.0;
        let period = 5usize; // ≈ 129 BPM
        let spec = click_spec(400, 12, period);
        let env = onset_envelope(&spec);
        let bpm = estimate_tempo(&env, hop);
        let expected = 60.0 / (period as f64 * hop);
        assert!(
            (bpm as f64 - expected).abs() < 4.0,
            "bpm {bpm} vs expected {expected:.1}"
        );
    }

    #[test]
    #[ignore] // opt-in: BEAT_AUDIO=/path/to/song cargo test detect_on_real_audio -- --ignored --nocapture
    fn detect_on_real_audio() {
        let path = std::env::var("BEAT_AUDIO").expect("set BEAT_AUDIO=/path/to/audio");
        let decoded = crate::audio::decode_file(std::path::Path::new(&path)).unwrap();
        let signal = crate::audio::resample_mono(
            &decoded.samples_mono,
            decoded.sample_rate,
            crate::audio::ANALYSIS_SAMPLE_RATE,
        )
        .unwrap();
        let cqt = crate::dsp::Cqt::new(crate::dsp::CqtConfig::default());
        let spec = cqt.process(&signal);
        let hop = cqt.hop_seconds();
        let env = onset_envelope(&spec);
        println!(
            "BPM={:.1}  start={:.3}s  frames={}",
            estimate_tempo(&env, hop),
            first_onset(&env, hop),
            spec.frames
        );
    }

    #[test]
    fn picks_onset_peaks() {
        let hop = 2048.0 / 22050.0;
        let mut data = vec![0f32; 100 * 4];
        for &f in &[7usize, 25, 50] {
            for k in 0..4 {
                data[f * 4 + k] = 1.0;
            }
        }
        let spec = Spectrogram { frames: 100, n_bins: 4, data };
        let env = onset_envelope(&spec);
        let peaks = onset_peaks(&env, hop);
        // Expect peaks near each impulse frame.
        for &f in &[7usize, 25, 50] {
            let want = f as f64 * hop;
            assert!(
                peaks.iter().any(|&p| (p - want).abs() < hop),
                "no peak near {want:.3}s in {peaks:?}"
            );
        }
    }

    #[test]
    fn finds_first_onset() {
        let hop = 2048.0 / 22050.0;
        // first impulse at frame 7.
        let mut data = vec![0f32; 100 * 4];
        for k in 0..4 {
            data[7 * 4 + k] = 1.0;
            data[20 * 4 + k] = 1.0;
        }
        let spec = Spectrogram { frames: 100, n_bins: 4, data };
        let env = onset_envelope(&spec);
        let t = first_onset(&env, hop);
        assert!((t - 7.0 * hop).abs() < hop, "first onset {t}");
    }
}
