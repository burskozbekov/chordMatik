//! ChordNet (music-x-lab ISMIR2019 structured 6-head model) inference via ONNX
//! Runtime. Produces 7ths/sus/dim chords WITH inversions (slash chords).
//! Compiled only with `--features btc` (reuses the `ort` dependency).
//!
//! Pipeline matches the reference: 288-bin CQT (36 bins/oct, fmin F#0, hop 512),
//! |CQT| magnitude (no log), slice bins [18:270] → 252; run the net → 6 per-frame
//! head LOGITS (triad/bass/7/9/11/13); decode each frame into root+quality+bass;
//! Viterbi on the triad head to smooth the main chord; per-segment dominant
//! bass + extension. The standard CQT is ~equivalent to the reference's
//! hybrid_cqt for this model (verified: 96.5% triad agreement).

use std::path::Path;

use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

use crate::chords::{ChordSegment, ROOT_NAMES};
use crate::dsp::{Cqt, CqtConfig};

const N_BINS: usize = 288;
const SLICE_LO: usize = 18;
const SPEC_DIM: usize = 252;
const FMIN_FSHARP0: f32 = 23.124_651; // librosa.note_to_hz('F#0')
const TRIAD_DIM: usize = 73; // N + 6 triad types × 12 roots

fn argmax(row: &[f32]) -> usize {
    let mut best = 0usize;
    let mut bv = f32::NEG_INFINITY;
    for (i, &v) in row.iter().enumerate() {
        if v > bv {
            bv = v;
            best = i;
        }
    }
    best
}

/// (triad_type, seventh, thirteenth) → a canonical quality string (the same set
/// the frontend `chordDisplay` + `chords::QUALITIES` understand).
/// Triad types from the model's head order: 0=maj,1=min,2=sus4,3=sus2,4=dim,5=aug.
fn quality_of(triad: usize, s7: usize, s13: usize) -> &'static str {
    match triad {
        0 => match (s7, s13) {
            (2, _) => "dom7", // maj + b7
            (1, _) => "maj7", // maj + 7
            (0, 1) => "maj6", // maj + add13(6)
            _ => "maj",
        },
        1 => match (s7, s13) {
            (2, _) => "min7",
            (1, _) => "minmaj7",
            (0, 1) => "min6",
            _ => "min",
        },
        4 => match s7 {
            3 => "dim7",
            2 => "hdim7",
            _ => "dim",
        },
        2 => "sus4",
        3 => "sus2",
        5 => "aug",
        _ => "maj",
    }
}

/// Small stable id per quality, for run-length grouping keys.
fn qid(quality: &str) -> u64 {
    [
        "maj", "min", "dim", "aug", "maj6", "min6", "maj7", "min7", "dom7", "minmaj7", "dim7",
        "hdim7", "sus2", "sus4",
    ]
    .iter()
    .position(|&q| q == quality)
    .map(|p| p as u64)
    .unwrap_or(31)
}

fn suffix_of(quality: &str) -> &'static str {
    match quality {
        "min" => "m",
        "dim" => "dim",
        "aug" => "aug",
        "maj6" => "6",
        "min6" => "m6",
        "maj7" => "maj7",
        "min7" => "m7",
        "dom7" => "7",
        "minmaj7" => "mM7",
        "dim7" => "dim7",
        "hdim7" => "m7b5",
        "sus2" => "sus2",
        "sus4" => "sus4",
        _ => "", // maj
    }
}

/// Viterbi over the 73-state triad head (logit emissions, constant switch cost).
fn viterbi_triad(triad: &[f32], frames: usize, dim: usize) -> Vec<usize> {
    const LAMBDA: f32 = 2.0;
    if frames == 0 {
        return Vec::new();
    }
    let row = |t: usize| &triad[t * dim..t * dim + dim];
    let mut dp: Vec<f32> = row(0).to_vec();
    let mut back = vec![vec![0usize; dim]; frames];
    for t in 1..frames {
        // top-2 of previous column for the cheap "switch" evaluation
        let (mut a1, mut m1, mut a2, mut m2) =
            (0usize, f32::NEG_INFINITY, 0usize, f32::NEG_INFINITY);
        for (s, &v) in dp.iter().enumerate() {
            if v > m1 {
                m2 = m1;
                a2 = a1;
                m1 = v;
                a1 = s;
            } else if v > m2 {
                m2 = v;
                a2 = s;
            }
        }
        let em = row(t);
        let mut next = vec![0f32; dim];
        for s in 0..dim {
            let stay = dp[s];
            let (cb, ca) = if a1 != s { (m1, a1) } else { (m2, a2) };
            let change = cb - LAMBDA;
            if stay >= change {
                next[s] = em[s] + stay;
                back[t][s] = s;
            } else {
                next[s] = em[s] + change;
                back[t][s] = ca;
            }
        }
        dp = next;
    }
    let mut best = 0usize;
    let mut bv = f32::NEG_INFINITY;
    for (s, &v) in dp.iter().enumerate() {
        if v > bv {
            bv = v;
            best = s;
        }
    }
    let mut path = vec![0usize; frames];
    path[frames - 1] = best;
    for t in (1..frames).rev() {
        path[t - 1] = back[t][path[t]];
    }
    path
}

/// Run ChordNet on a mono signal → time-stamped chord segments (with inversions).
/// Returns `(segments, hop_seconds)`.
pub fn analyze(signal: &[f32], model_path: &Path) -> Result<(Vec<ChordSegment>, f64), String> {
    let cfg = CqtConfig {
        sr: 22050,
        fmin: FMIN_FSHARP0,
        bins_per_octave: 36,
        n_bins: N_BINS,
        hop: 512,
    };
    let cqt = Cqt::new(cfg);
    let mut spec = cqt.process(signal);
    // Re-align detuned recordings (speed-adjusted/vinyl/off-A440) to the semitone
    // grid the model was trained on; a no-op for already-in-tune audio.
    crate::dsp::tuning::correct_tuning(&mut spec, cfg.bins_per_octave);
    let hop_sec = cqt.hop_seconds();
    let frames = spec.frames;
    if frames == 0 || spec.n_bins < N_BINS {
        return Ok((Vec::new(), hop_sec));
    }

    // Raw |CQT| magnitude, sliced to the model's 252 bins (no log).
    let mut input = Array3::<f32>::zeros((1, frames, SPEC_DIM));
    for f in 0..frames {
        let base = f * spec.n_bins;
        for b in 0..SPEC_DIM {
            input[[0, f, b]] = spec.data[base + SLICE_LO + b];
        }
    }

    let mut session = Session::builder()
        .map_err(|e| format!("ort session builder failed: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("failed to load chordnet: {e}"))?;
    let tensor = Tensor::from_array(input).map_err(|e| format!("input tensor failed: {e}"))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("chordnet inference failed: {e}"))?;

    // 6 heads in export order: triad(73), bass(13), s7(4), s9(4), s11(3), s13(3).
    let head = |i: usize| -> Result<(usize, Vec<f32>), String> {
        let (shape, data) = outputs[i]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("failed to read head {i}: {e}"))?;
        let dim = *shape.last().ok_or("empty head shape")? as usize;
        Ok((dim, data.to_vec()))
    };
    let (_td, triad) = head(0)?;
    let (bd, bass) = head(1)?;
    let (d7, s7) = head(2)?;
    let (d13, s13) = head(5)?;

    let triad_path = viterbi_triad(&triad, frames, TRIAD_DIM);

    // Decode every frame into (root, quality, bass), keyed for run-length grouping.
    struct F {
        root: i32,
        bass: i32,
        quality: &'static str,
        key: u64,
    }
    let mut decoded: Vec<F> = Vec::with_capacity(frames);
    for t in 0..frames {
        let ti = triad_path[t];
        if ti == 0 {
            decoded.push(F { root: -1, bass: -1, quality: "N", key: u64::MAX });
            continue;
        }
        let triad_type = (ti - 1) / 12;
        let root = ((ti - 1) % 12) as i32;
        let a7 = argmax(&s7[t * d7..t * d7 + d7]);
        let a13 = argmax(&s13[t * d13..t * d13 + d13]);
        let quality = quality_of(triad_type, a7, a13);
        // bass head: 0 = root position, else absolute PC = idx-1.
        let bi = argmax(&bass[t * bd..t * bd + bd]);
        let bass = if bi == 0 || (bi as i32 - 1) == root { -1 } else { bi as i32 - 1 };
        let key = (((root + 1) as u64) << 20) | (((bass + 2) as u64) << 8) | qid(quality);
        decoded.push(F { root, bass, quality, key });
    }

    // Run-length group → segments, merging blips + bridging brief N gaps.
    const MIN_DUR: f64 = 0.2;
    const HOLD_N_DUR: f64 = 3.0;
    let dur = spec.frames as f64 * hop_sec;
    let to_sec = |fr: usize| (fr as f64 * hop_sec).min(dur);

    let mk = |f: &F, s: usize, e: usize| -> ChordSegment {
        let label = if f.root < 0 {
            "N".to_string()
        } else {
            let mut l = format!("{}{}", ROOT_NAMES[f.root as usize], suffix_of(f.quality));
            if f.bass >= 0 {
                l.push('/');
                l.push_str(ROOT_NAMES[f.bass as usize]);
            }
            l
        };
        ChordSegment {
            start_sec: to_sec(s),
            end_sec: to_sec(e),
            label,
            root_pc: f.root,
            quality: f.quality.to_string(),
            bass_pc: f.bass,
            index: triad_path.get(s).copied().unwrap_or(0),
        }
    };

    let mut segs: Vec<ChordSegment> = Vec::new();
    let mut start = 0usize;
    for i in 1..=frames {
        if i == frames || decoded[i].key != decoded[start].key {
            let mut seg = mk(&decoded[start], start, if i >= frames { frames } else { i });
            if i >= frames {
                seg.end_sec = dur;
            }
            // merge blips + bridge brief no-chord gaps into the previous chord.
            if let Some(last) = segs.last_mut() {
                let d = seg.end_sec - seg.start_sec;
                if d < MIN_DUR
                    || (seg.root_pc < 0 && last.root_pc >= 0 && d < HOLD_N_DUR)
                    || (last.label == seg.label)
                {
                    last.end_sec = seg.end_sec;
                    start = i;
                    continue;
                }
            }
            segs.push(seg);
            start = i;
        }
    }
    Ok((segs, hop_sec))
}
