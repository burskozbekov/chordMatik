//! Constant-Q Transform via FFT with sparse spectral kernels (Brown–Puckette),
//! plus chroma folding. Parameters match the BTC model's expected input
//! (`librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048)`,
//! fmin = C1), so the same CQT feeds both the built-in chroma engine and the
//! optional BTC ONNX path.

use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

pub mod cens;
pub mod tempo;
pub mod tuning;

/// C1 in Hz — librosa's default `fmin` for CQT.
pub const FMIN_C1: f32 = 32.703_196;

#[derive(Clone, Copy)]
pub struct CqtConfig {
    pub sr: u32,
    pub fmin: f32,
    pub bins_per_octave: usize,
    pub n_bins: usize,
    pub hop: usize,
}

impl Default for CqtConfig {
    fn default() -> Self {
        Self {
            sr: 22_050,
            fmin: FMIN_C1,
            bins_per_octave: 24,
            n_bins: 144,
            hop: 2048,
        }
    }
}

/// A row-major [frames × n_bins] magnitude spectrogram.
pub struct Spectrogram {
    pub frames: usize,
    pub n_bins: usize,
    pub data: Vec<f32>,
}

impl Spectrogram {
    #[inline]
    pub fn frame(&self, i: usize) -> &[f32] {
        &self.data[i * self.n_bins..(i + 1) * self.n_bins]
    }
}

/// Conjugated CQT spectral kernel for one bin, stored sparsely.
struct SparseKernel {
    indices: Vec<usize>,
    re: Vec<f32>,
    im: Vec<f32>,
}

pub struct Cqt {
    cfg: CqtConfig,
    fft: Arc<dyn Fft<f32>>,
    fft_size: usize,
    kernels: Vec<SparseKernel>,
}

fn next_pow2(n: usize) -> usize {
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p
}

#[inline]
fn hann(n: usize, len: usize) -> f32 {
    if len <= 1 {
        return 1.0;
    }
    0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (len as f32 - 1.0)).cos()
}

impl Cqt {
    pub fn new(cfg: CqtConfig) -> Self {
        let q = 1.0 / (2f32.powf(1.0 / cfg.bins_per_octave as f32) - 1.0);

        // Longest kernel is the lowest bin; size the FFT to hold it.
        let max_len = (q * cfg.sr as f32 / cfg.fmin).ceil() as usize;
        let fft_size = next_pow2(max_len.max(cfg.hop * 2));

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];

        let mut kernels = Vec::with_capacity(cfg.n_bins);
        for k in 0..cfg.n_bins {
            let f_k = cfg.fmin * 2f32.powf(k as f32 / cfg.bins_per_octave as f32);
            let len = ((q * cfg.sr as f32 / f_k).round() as usize)
                .clamp(1, fft_size)
                .min(fft_size);

            // Centered, windowed complex exponential → FFT → conjugate → sparse.
            let mut buf = vec![Complex32::new(0.0, 0.0); fft_size];
            let start = (fft_size - len) / 2;
            let norm = 1.0 / len as f32;
            for n in 0..len {
                let w = hann(n, len) * norm;
                let phase = 2.0 * std::f32::consts::PI * f_k * n as f32 / cfg.sr as f32;
                buf[start + n] = Complex32::new(w * phase.cos(), w * phase.sin());
            }
            fft.process_with_scratch(&mut buf, &mut scratch);

            let max_abs = buf.iter().fold(0f32, |m, c| m.max(c.norm())).max(1e-12);
            let thresh = max_abs * 5e-3;
            let mut indices = Vec::new();
            let mut re = Vec::new();
            let mut im = Vec::new();
            for (f, c) in buf.iter().enumerate() {
                if c.norm() > thresh {
                    indices.push(f);
                    re.push(c.re);
                    im.push(-c.im); // store conjugate for correlation
                }
            }
            kernels.push(SparseKernel { indices, re, im });
        }

        Self {
            cfg,
            fft,
            fft_size,
            kernels,
        }
    }

    /// Compute the CQT magnitude spectrogram of a mono signal.
    pub fn process(&self, signal: &[f32]) -> Spectrogram {
        let n_bins = self.cfg.n_bins;
        let hop = self.cfg.hop;
        let half = (self.fft_size / 2) as isize;
        let frames = if signal.is_empty() {
            0
        } else {
            signal.len().div_ceil(hop)
        };

        let mut data = vec![0f32; frames * n_bins];
        let mut buf = vec![Complex32::new(0.0, 0.0); self.fft_size];
        let mut scratch = vec![Complex32::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let inv = 1.0 / self.fft_size as f32;

        for frame in 0..frames {
            let begin = (frame * hop) as isize - half;
            // Load a centered, zero-padded window.
            for (m, slot) in buf.iter_mut().enumerate() {
                let idx = begin + m as isize;
                slot.re = if idx >= 0 && (idx as usize) < signal.len() {
                    signal[idx as usize]
                } else {
                    0.0
                };
                slot.im = 0.0;
            }
            self.fft.process_with_scratch(&mut buf, &mut scratch);

            let row = &mut data[frame * n_bins..(frame + 1) * n_bins];
            for (k, kernel) in self.kernels.iter().enumerate() {
                let mut acc_re = 0f32;
                let mut acc_im = 0f32;
                for j in 0..kernel.indices.len() {
                    let x = buf[kernel.indices[j]];
                    let kr = kernel.re[j];
                    let ki = kernel.im[j];
                    acc_re += x.re * kr - x.im * ki;
                    acc_im += x.re * ki + x.im * kr;
                }
                row[k] = (acc_re * acc_re + acc_im * acc_im).sqrt() * inv;
            }
        }

        Spectrogram {
            frames,
            n_bins,
            data,
        }
    }

    pub fn hop_seconds(&self) -> f64 {
        self.cfg.hop as f64 / self.cfg.sr as f64
    }
}

/// Fold a CQT magnitude spectrogram into a [frames × 12] chromagram.
/// Each frame's 12-vector is L2-normalized (zero frames stay zero).
/// Per-frame pitch-class energy, SUMMED but NOT normalized — the raw input to the
/// CENS pipeline (which does its own L1/quantize/L2). Folding is identical to
/// [`chromagram`]; only the final L2 step is omitted (normalizing twice biases
/// CENS's quantizer).
pub fn chroma_raw(spec: &Spectrogram, bins_per_octave: usize) -> Vec<[f32; 12]> {
    let bins_per_semitone = (bins_per_octave / 12).max(1);
    let mut out = Vec::with_capacity(spec.frames);
    for f in 0..spec.frames {
        let row = spec.frame(f);
        let mut chroma = [0f32; 12];
        for (k, &mag) in row.iter().enumerate() {
            let semitone = (k as f32 / bins_per_semitone as f32).round() as i32;
            let pc = ((semitone % 12) + 12) % 12;
            chroma[pc as usize] += mag;
        }
        out.push(chroma);
    }
    out
}

pub fn chromagram(spec: &Spectrogram, bins_per_octave: usize) -> Vec<[f32; 12]> {
    let bins_per_semitone = (bins_per_octave / 12).max(1);
    let mut out = Vec::with_capacity(spec.frames);
    for f in 0..spec.frames {
        let row = spec.frame(f);
        let mut chroma = [0f32; 12];
        for (k, &mag) in row.iter().enumerate() {
            // Nearest semitone, then pitch class.
            let semitone = (k as f32 / bins_per_semitone as f32).round() as i32;
            let pc = ((semitone % 12) + 12) % 12;
            chroma[pc as usize] += mag;
        }
        let norm = chroma.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 1e-9 {
            for v in &mut chroma {
                *v /= norm;
            }
        }
        out.push(chroma);
    }
    out
}
