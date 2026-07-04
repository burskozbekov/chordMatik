//! Global tuning estimation + correction for the CQT.
//!
//! The chroma fold and the ONNX models assume A=440 (CQT bins sit on exact
//! semitone centers). Speed-adjusted / vinyl / off-tuned recordings (common on
//! YouTube) shift ALL energy off the grid by a fraction of a semitone, biasing
//! every chord toward the wrong pitch class. We estimate that global deviation
//! from the energy-weighted distance of each bin to its nearest semitone, then
//! circularly resample the spectrogram so the energy lands back on the grid.

use super::Spectrogram;

/// Energy-weighted global tuning deviation in fractional CQT BINS (the offset of
/// spectral energy from the nearest semitone center). `bins_per_octave/12` bins
/// span one semitone. Result is in roughly [-bps/2, bps/2].
pub fn estimate_tuning_bins(spec: &Spectrogram, bins_per_octave: usize) -> f32 {
    let bps = (bins_per_octave / 12).max(1) as i32;
    if bps < 2 || spec.frames == 0 {
        return 0.0;
    }
    let mut avg = vec![0f32; spec.n_bins];
    for f in 0..spec.frames {
        let row = spec.frame(f);
        for k in 0..spec.n_bins {
            avg[k] += row[k];
        }
    }
    let mut num = 0f64;
    let mut den = 0f64;
    for (k, &m) in avg.iter().enumerate() {
        if m <= 0.0 {
            continue;
        }
        // Deviation of bin k from its nearest semitone center, in bins,
        // centered to (-bps/2, bps/2].
        let r = (k as i32) % bps;
        let dev = if r > bps / 2 { (r - bps) as f64 } else { r as f64 };
        num += m as f64 * dev;
        den += m as f64;
    }
    if den <= 0.0 {
        0.0
    } else {
        (num / den) as f32
    }
}

/// Estimate the tuning offset and, if non-negligible, resample every frame so the
/// energy re-aligns to semitone centers. Returns the applied shift (bins).
pub fn correct_tuning(spec: &mut Spectrogram, bins_per_octave: usize) -> f32 {
    let off = estimate_tuning_bins(spec, bins_per_octave).clamp(-1.5, 1.5);
    if off.abs() < 0.08 {
        return 0.0; // within a tiny fraction of a semitone — leave it.
    }
    let n = spec.n_bins;
    let mut row = vec![0f32; n];
    for f in 0..spec.frames {
        let base = f * n;
        for b in 0..n {
            // new[b] = old[b + off] — sample (interp) from the shifted position so
            // sharp energy moves down onto the semitone center, and vice versa.
            let src = b as f32 + off;
            let i0 = src.floor() as isize;
            let frac = src - i0 as f32;
            let s0 = if i0 >= 0 && (i0 as usize) < n {
                spec.data[base + i0 as usize]
            } else {
                0.0
            };
            let s1 = if (i0 + 1) >= 0 && ((i0 + 1) as usize) < n {
                spec.data[base + (i0 + 1) as usize]
            } else {
                0.0
            };
            row[b] = s0 * (1.0 - frac) + s1 * frac;
        }
        spec.data[base..base + n].copy_from_slice(&row);
    }
    off
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::Spectrogram;

    /// Spectrogram with energy concentrated at bins offset by `off` from each
    /// semitone center (bps=3 → 36 bins/oct).
    fn detuned_spec(off_in_bin: usize, n_oct: usize) -> Spectrogram {
        let bps = 3;
        let n_bins = n_oct * 12 * bps;
        let frames = 20;
        let mut data = vec![0f32; frames * n_bins];
        for f in 0..frames {
            for s in 0..(n_oct * 12) {
                let k = s * bps + off_in_bin; // energy at this offset within the semitone
                if k < n_bins {
                    data[f * n_bins + k] = 1.0;
                }
            }
        }
        Spectrogram { frames, n_bins, data }
    }

    #[test]
    fn on_tune_reads_zero() {
        let spec = detuned_spec(0, 4);
        assert!(estimate_tuning_bins(&spec, 36).abs() < 0.05);
    }

    #[test]
    fn sharp_by_one_bin_detected_and_corrected() {
        let mut spec = detuned_spec(1, 4); // +1 bin = +1/3 semitone sharp
        let est = estimate_tuning_bins(&spec, 36);
        assert!((est - 1.0).abs() < 0.1, "estimate {est} should be ≈ +1");
        let applied = correct_tuning(&mut spec, 36);
        assert!((applied - 1.0).abs() < 0.1, "applied {applied}");
        // After correction the energy should sit on the semitone centers (k % 3 == 0).
        let post = estimate_tuning_bins(&spec, 36);
        assert!(post.abs() < 0.15, "post-correction tuning {post} should be ≈ 0");
    }
}
