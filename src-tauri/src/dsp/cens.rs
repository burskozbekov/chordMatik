//! CENS (Chroma Energy Normalized Statistics) features + banded DTW for the
//! fine, chroma-frame tab↔recording alignment (Phase B of tab sync).
//!
//! CENS folds away exactly what differs between a real recording and a
//! synthesized tab — local dynamics, timbre, articulation — keeping pitch-class
//! content, which is what makes cross-"version" DTW alignment robust. The SAME
//! pipeline must run on both sides (audio chroma + synthesized tab chroma);
//! asymmetric normalization is the classic silent failure.
//!
//! Constants verified against librosa.feature.chroma_cens + synctoolbox: quant
//! steps [0.05,0.1,0.2,0.4], weight 0.25/step, L1 silence threshold 0.001,
//! normalized symmetric Hann smoothing, final L2. We deliberately do NOT
//! downsample (d=1) — we need the ~93 ms frame resolution for sub-bar sync.

/// Parameters for the CENS pipeline (defaults are the verified canonical values,
/// with ell rescaled to our 10.766 fps grid and downsample disabled).
#[derive(Clone, Copy, Debug)]
pub struct CensParams {
    pub quant_steps: [f32; 4],
    pub quant_weights: [f32; 4],
    /// Hann smoothing length in frames (~1.0 s at 10.766 fps).
    pub ell: usize,
    /// Downsample factor — 1 keeps full ~93 ms resolution (do NOT raise for sync).
    pub downsample: usize,
    /// Frames whose L1 energy is below this are treated as no-content (uniform).
    pub l1_thresh: f32,
}

impl Default for CensParams {
    fn default() -> Self {
        Self {
            quant_steps: [0.05, 0.1, 0.2, 0.4],
            quant_weights: [0.25, 0.25, 0.25, 0.25],
            ell: 11,
            downsample: 1,
            l1_thresh: 0.001,
        }
    }
}

const UNIFORM: [f32; 12] = [0.288_675_13; 12]; // 1/sqrt(12), unit-L2

/// Normalized symmetric (fftbins=false) Hann window of effective length `ell`.
/// Equivalent to librosa `get_window('hann', ell+2, fftbins=False)` with the two
/// zero endpoints dropped, then divided by its sum (so taps sum to 1).
fn hann_norm(ell: usize) -> Vec<f32> {
    let ell = ell.max(1);
    let mut w: Vec<f32> = (0..ell)
        .map(|n| {
            0.5 - 0.5
                * (2.0 * std::f32::consts::PI * (n as f32 + 1.0) / (ell as f32 + 1.0)).cos()
        })
        .collect();
    let sum: f32 = w.iter().sum();
    if sum > 0.0 {
        for x in &mut w {
            *x /= sum;
        }
    }
    w
}

/// Raw per-frame pitch-class energy (summed, NOT normalized) → CENS sequence.
pub fn cens(raw: &[[f32; 12]], p: &CensParams) -> Vec<[f32; 12]> {
    // (a) L1 normalize (silence → uniform) then (b) quantize.
    let mut quant: Vec<[f32; 12]> = Vec::with_capacity(raw.len());
    for c in raw {
        let s: f32 = c.iter().map(|v| v.abs()).sum();
        if s < p.l1_thresh {
            quant.push(UNIFORM);
            continue;
        }
        let mut q = [0f32; 12];
        for k in 0..12 {
            let v = c[k] / s;
            let mut acc = 0f32;
            for (st, w) in p.quant_steps.iter().zip(p.quant_weights.iter()) {
                if v > *st {
                    acc += *w;
                }
            }
            q[k] = acc;
        }
        quant.push(q);
    }

    // (c) smooth each pitch class along time with the normalized Hann (zero-pad).
    let win = hann_norm(p.ell);
    let half = win.len() / 2;
    let n = quant.len();
    let mut smoothed: Vec<[f32; 12]> = Vec::with_capacity(n);
    for i in 0..n {
        let mut acc = [0f32; 12];
        for (wi, &w) in win.iter().enumerate() {
            let idx = i as isize + wi as isize - half as isize;
            if idx >= 0 && (idx as usize) < n {
                let src = &quant[idx as usize];
                for k in 0..12 {
                    acc[k] += w * src[k];
                }
            }
        }
        smoothed.push(acc);
    }

    // (d) downsample + (e) final L2 per output frame.
    let step = p.downsample.max(1);
    let mut out: Vec<[f32; 12]> = Vec::with_capacity(n / step + 1);
    let mut i = 0;
    while i < n {
        let mut q = smoothed[i];
        let nrm = q.iter().map(|v| v * v).sum::<f32>().sqrt();
        if nrm > 1e-9 {
            for v in &mut q {
                *v /= nrm;
            }
        } else {
            q = UNIFORM;
        }
        out.push(q);
        i += step;
    }
    out
}

#[inline]
fn cos_cost(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let mut dot = 0f32;
    for k in 0..12 {
        dot += a[k] * b[k];
    }
    1.0 - dot // unit-L2 inputs → cosine distance in [0, 2]
}

/// Banded DTW with a per-row band center supplied from the coarse (Phase A) path.
/// Returns the warp path (audio_idx, tab_idx) ascending + the per-step cost.
pub fn banded_fine_dtw(
    a: &[[f32; 12]],
    b: &[[f32; 12]],
    center: &[usize],
    radius: usize,
) -> (Vec<(usize, usize)>, Vec<f32>) {
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return (Vec::new(), Vec::new());
    }
    let inf = f32::INFINITY;
    let band = |i: usize| -> (usize, usize) {
        let c = center.get(i).copied().unwrap_or((i * m) / n.max(1)).min(m - 1);
        (c.saturating_sub(radius), (c + radius).min(m - 1))
    };

    // Small penalty on axis (non-diagonal) moves so the path prefers the diagonal
    // in flat-cost regions (sustained chords) instead of wandering — far smaller
    // than any real chroma mismatch, so it only breaks ties, never overrides a
    // genuine tempo warp.
    const OFF_DIAG: f32 = 0.002;

    // Full accumulated-cost matrix; only band cells are filled (rest stay INF).
    // OPEN-BEGIN: the tab (b) may enter at ANY audio frame — every first-tab-frame
    // cell (j == 0) is a free start, so an intro the tab doesn't notate is skipped
    // for free instead of pinning tab-frame-0 to audio-frame-0. The band (centred
    // on the coarse open-begin anchors) keeps this near the right entry.
    let mut d = vec![inf; n * m];
    for i in 0..n {
        let (lo, hi) = band(i);
        for j in lo..=hi {
            let c = cos_cost(&a[i], &b[j]);
            let mut best = if j == 0 { 0.0 } else { inf };
            if i > 0 {
                best = best.min(d[(i - 1) * m + j] + OFF_DIAG);
            }
            if j > 0 {
                best = best.min(d[i * m + (j - 1)] + OFF_DIAG);
            }
            if i > 0 && j > 0 {
                best = best.min(d[(i - 1) * m + (j - 1)]);
            }
            d[i * m + j] = c + if best.is_finite() { best } else { 0.0 };
        }
    }

    // Endpoint: prefer the natural (n-1, m-1); else the min-cost cell of the last row band.
    let (lo, hi) = band(n - 1);
    let mut j = (m - 1).clamp(lo, hi);
    if !d[(n - 1) * m + j].is_finite() {
        let mut bv = inf;
        for jj in lo..=hi {
            if d[(n - 1) * m + jj] < bv {
                bv = d[(n - 1) * m + jj];
                j = jj;
            }
        }
    }
    let mut i = n - 1;
    let mut path: Vec<(usize, usize)> = Vec::new();
    let mut costs: Vec<f32> = Vec::new();
    loop {
        path.push((i, j));
        costs.push(cos_cost(&a[i], &b[j]));
        // Open-begin: stop as soon as the tab's first frame is reached, at whatever
        // audio frame it entered (not forced back to audio 0).
        if j == 0 {
            break;
        }
        let up = if i > 0 { d[(i - 1) * m + j] + OFF_DIAG } else { inf };
        let left = if j > 0 { d[i * m + (j - 1)] + OFF_DIAG } else { inf };
        let diag = if i > 0 && j > 0 { d[(i - 1) * m + (j - 1)] } else { inf };
        let mn = up.min(left).min(diag);
        if !mn.is_finite() {
            break;
        }
        if mn == diag {
            i -= 1;
            j -= 1;
        } else if mn == up {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    path.reverse();
    costs.reverse();
    (path, costs)
}

/// Convert a warp path into one anchor per bar: (barIndex, recMs, confidence).
/// recMs = the recording time of the first audio frame matched at/after the bar's
/// tab-frame start; confidence = 1 − mean cosine cost in a ±5-step window.
pub fn path_to_bar_anchors(
    path: &[(usize, usize)],
    costs: &[f32],
    bar_start_tab_frame: &[usize],
    hop_seconds: f64,
) -> Vec<(usize, f64, f64)> {
    let mut out: Vec<(usize, f64, f64)> = Vec::new();
    if path.is_empty() {
        return out;
    }
    let mut pi = 0usize;
    let mut last_ms = -1.0f64;
    for (b, &tf) in bar_start_tab_frame.iter().enumerate() {
        while pi < path.len() && path[pi].1 < tf {
            pi += 1;
        }
        if pi >= path.len() {
            break;
        }
        let ms = path[pi].0 as f64 * hop_seconds * 1000.0;
        if ms <= last_ms {
            continue; // strictly increasing — AlphaTab interpolates the rest
        }
        let lo = pi.saturating_sub(5);
        let hi = (pi + 5).min(costs.len());
        let mean = if hi > lo {
            costs[lo..hi].iter().sum::<f32>() / (hi - lo) as f32
        } else {
            1.0
        };
        let conf = (1.0 - mean).clamp(0.0, 1.0) as f64;
        out.push((b, ms, conf));
        last_ms = ms;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> f32 {
        // tiny LCG for deterministic synthetic data
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f32) / (1u64 << 31) as f32
    }

    fn synth_chroma(n: usize) -> Vec<[f32; 12]> {
        let mut seed = 42u64;
        (0..n)
            .map(|t| {
                let root = (t / 20) % 12; // a chord change every 20 frames
                let mut c = [0f32; 12];
                for &iv in &[0usize, 4, 7] {
                    c[(root + iv) % 12] = 1.0 + 0.2 * rng(&mut seed);
                }
                c
            })
            .collect()
    }

    #[test]
    fn cens_is_unit_l2() {
        let raw = synth_chroma(60);
        let c = cens(&raw, &CensParams::default());
        assert_eq!(c.len(), 60);
        for f in &c {
            let n: f32 = f.iter().map(|v| v * v).sum::<f32>().sqrt();
            assert!((n - 1.0).abs() < 1e-3 || n < 1e-6, "frame L2 = {n}");
        }
    }

    #[test]
    fn self_consistency_identity_diagonal() {
        // Feeding the same sequence as both inputs must return the diagonal with ~0 cost.
        let raw = synth_chroma(120);
        let a = cens(&raw, &CensParams::default());
        let center: Vec<usize> = (0..a.len()).collect();
        let (path, costs) = banded_fine_dtw(&a, &a, &center, 30);
        let mean: f32 = costs.iter().sum::<f32>() / costs.len() as f32;
        assert!(mean < 0.02, "self-match mean cost {mean} should be ~0");
        // The path should be essentially the diagonal.
        let off = path.iter().map(|(i, j)| (*i as i64 - *j as i64).abs()).max().unwrap();
        assert!(off <= 1, "self-match should stay on the diagonal, max off {off}");
    }

    #[test]
    fn recovers_known_offset() {
        // Prepend N silent frames to the "audio"; every matched index should shift by N.
        let raw = synth_chroma(100);
        let tab = cens(&raw, &CensParams::default());
        let n_pad = 15;
        let mut padded = vec![[0f32; 12]; n_pad];
        padded.extend_from_slice(&raw);
        let audio = cens(&padded, &CensParams::default());
        let center: Vec<usize> = (0..audio.len()).map(|i| i.saturating_sub(n_pad)).collect();
        let (path, _costs) = banded_fine_dtw(&audio, &tab, &center, 40);
        // For a tab frame well inside the body, the matched audio frame ≈ tab + n_pad.
        let probe_tab = 60usize;
        let matched = path.iter().find(|(_, j)| *j == probe_tab).map(|(i, _)| *i);
        let ai = matched.expect("tab frame should be matched");
        let err = (ai as i64 - (probe_tab + n_pad) as i64).abs();
        assert!(err <= 3, "offset recovery err {err} frames (≈{}ms)", err * 93);
    }

    #[test]
    fn open_begin_skips_intro_for_bar_zero() {
        // A 15-frame intro the tab doesn't cover: tab frame 0 must enter at ~frame
        // 15, NOT be pinned to audio frame 0 (the closed-start bug this fixes).
        let raw = synth_chroma(100);
        let tab = cens(&raw, &CensParams::default());
        let n_pad = 15;
        let mut padded = vec![[0f32; 12]; n_pad];
        padded.extend_from_slice(&raw);
        let audio = cens(&padded, &CensParams::default());
        let center: Vec<usize> = (0..audio.len()).map(|i| i.saturating_sub(n_pad)).collect();
        let (path, _costs) = banded_fine_dtw(&audio, &tab, &center, 40);
        // Earliest audio frame matched to tab frame 0.
        let entry = path.iter().find(|(_, j)| *j == 0).map(|(i, _)| *i).expect("tab 0 matched");
        assert!(
            (entry as i64 - n_pad as i64).abs() <= 4,
            "tab bar 0 entered at audio {entry}, expected ≈{n_pad} (intro must be skipped)"
        );
    }
}
