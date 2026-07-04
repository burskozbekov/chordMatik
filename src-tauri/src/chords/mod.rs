//! Chord vocabulary + decoding.
//!
//! The neural network (or the built-in chroma engine) yields per-frame scores
//! over the 25-class maj/min vocabulary. Decoding to time-stamped segments is
//! done here in plain Rust: median smoothing + a simple Viterbi over chord
//! states, then merge consecutive identical frames into segments.

use serde::{Deserialize, Serialize};

/// Large-vocabulary BTC: 12 roots × 14 qualities (= 168) + X (168, unknown) +
/// N (169, no chord) = 170 classes, in the model's index order
/// (`utils/chords.py::convert_to_id_voca`): id = root*14 + quality_offset.
pub const NUM_CHORDS: usize = 170;
pub const NUM_QUALITIES: usize = 14;
pub const X_INDEX: usize = 168;
pub const N_INDEX: usize = 169;

pub const ROOT_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// (canonical quality, display suffix) in the model's quality-offset order. Kept
/// in sync with the frontend `chordDisplay` + the export `build_idx_to_chord`.
pub const QUALITIES: [(&str, &str); NUM_QUALITIES] = [
    ("min", "m"),
    ("maj", ""),
    ("dim", "dim"),
    ("aug", "aug"),
    ("min6", "m6"),
    ("maj6", "6"),
    ("min7", "m7"),
    ("minmaj7", "mM7"),
    ("maj7", "maj7"),
    ("dom7", "7"),
    ("dim7", "dim7"),
    ("hdim7", "m7b5"),
    ("sus2", "sus2"),
    ("sus4", "sus4"),
];

/// Human label for a chord index (e.g. 1 → "C", 0 → "Cm", 9 → "C7", 169 → "N").
/// X (unknown, 168) renders as "N" so the UI treats it as no-chord.
pub fn chord_label(idx: usize) -> String {
    if idx >= X_INDEX {
        return "N".to_string();
    }
    let root = idx / NUM_QUALITIES;
    let q = idx % NUM_QUALITIES;
    if root >= 12 {
        return "N".to_string();
    }
    format!("{}{}", ROOT_NAMES[root], QUALITIES[q].1)
}

pub fn chord_root_pc(idx: usize) -> i32 {
    if idx >= X_INDEX {
        -1
    } else {
        (idx / NUM_QUALITIES) as i32
    }
}

pub fn chord_quality(idx: usize) -> &'static str {
    if idx >= X_INDEX {
        "N"
    } else {
        QUALITIES[idx % NUM_QUALITIES].0
    }
}

/// A decoded chord region.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChordSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub label: String,
    pub root_pc: i32,
    pub quality: String,
    /// Bass pitch class for slash chords (inversions), or -1 for root position.
    #[serde(default = "neg_one")]
    pub bass_pc: i32,
    /// Chord index in the vocabulary (engine-specific).
    pub index: usize,
}

fn neg_one() -> i32 {
    -1
}

/// Snap segment boundaries to the recording's tracked BEATS: chord changes land
/// on beats in real music, but frame-quantized Viterbi boundaries sit up to a
/// hop (~93 ms) off. A boundary moves to the nearest beat only when it's within
/// `min(0.12 s, 0.35 × median-IBI)` — a genuinely off-beat change stays put.
/// Segments squeezed to nothing by snapping are dropped (their neighbor absorbs
/// the span), so output boundaries stay strictly increasing.
pub fn snap_segments_to_beats(segments: &mut Vec<ChordSegment>, beats: &[f64]) {
    if segments.is_empty() || beats.len() < 4 {
        return;
    }
    let mut ibis: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    ibis.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let med_ibi = ibis[ibis.len() / 2];
    let tol = 0.12f64.min(0.35 * med_ibi);
    if !(tol > 0.0) {
        return;
    }
    let snap = |t: f64| -> f64 {
        // beats is sorted — binary search for the nearest one.
        let i = beats.partition_point(|&b| b < t);
        let mut best = t;
        let mut bd = tol;
        for &b in beats[i.saturating_sub(1)..(i + 1).min(beats.len())].iter() {
            let d = (b - t).abs();
            if d < bd {
                bd = d;
                best = b;
            }
        }
        best
    };

    // Snap the shared boundaries (segment i's end == segment i+1's start).
    let n = segments.len();
    for i in 0..n {
        if i > 0 {
            segments[i].start_sec = snap(segments[i].start_sec);
        }
        if i + 1 < n {
            segments[i].end_sec = snap(segments[i].end_sec);
        }
    }
    // Keep boundaries consistent + strictly increasing; drop collapsed segments.
    for i in 0..n - 1 {
        let e = segments[i].end_sec;
        segments[i + 1].start_sec = e;
    }
    segments.retain(|s| s.end_sec - s.start_sec > 0.03);
}

/// L2-normalized binary triad templates for the 24 maj/min chords.
fn chord_templates() -> [[f32; 12]; 24] {
    let mut t = [[0f32; 12]; 24];
    for root in 0..12 {
        // Major: root, M3, P5
        for &pc in &[root, (root + 4) % 12, (root + 7) % 12] {
            t[root][pc] = 1.0;
        }
        // Minor: root, m3, P5
        for &pc in &[root, (root + 3) % 12, (root + 7) % 12] {
            t[12 + root][pc] = 1.0;
        }
    }
    for tpl in &mut t {
        let norm = tpl.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in tpl.iter_mut() {
                *v /= norm;
            }
        }
    }
    t
}

/// Median-filter each pitch-class series over time (odd window).
pub fn median_filter_chroma(chroma: &mut [[f32; 12]], window: usize) {
    if window < 3 || chroma.len() < window {
        return;
    }
    let half = window / 2;
    let src = chroma.to_vec();
    let n = src.len();
    let mut scratch = vec![0f32; window];
    for t in 0..n {
        let lo = t.saturating_sub(half);
        let hi = (t + half + 1).min(n);
        for pc in 0..12 {
            let count = hi - lo;
            for (i, frame) in src[lo..hi].iter().enumerate() {
                scratch[i] = frame[pc];
            }
            let slice = &mut scratch[..count];
            slice.sort_by(|a, b| a.partial_cmp(b).unwrap());
            chroma[t][pc] = slice[count / 2];
        }
    }
}

/// Per-frame emission scores over the 25-class vocabulary from chroma.
/// Chord scores are cosine similarity (chroma is pre-normalized); "N" gets a
/// fixed bias so silent/ambiguous frames fall through to no-chord.
pub fn chroma_emissions(chroma: &[[f32; 12]]) -> Vec<[f32; NUM_CHORDS]> {
    const N_BIAS: f32 = 0.45;
    let templates = chord_templates(); // 24: 0..11 maj, 12..23 min
    let mut out = Vec::with_capacity(chroma.len());
    for frame in chroma {
        let mut e = [0f32; NUM_CHORDS];
        // The chroma engine only distinguishes maj/min triads; place each score
        // at its 170-class index (maj → root*14+1, min → root*14+0). The other
        // 12 qualities stay 0 (chroma can't tell them apart) — BTC handles those.
        for (c, tpl) in templates.iter().enumerate() {
            let mut dot = 0f32;
            for pc in 0..12 {
                dot += frame[pc] * tpl[pc];
            }
            let (root, q_off) = if c < 12 { (c, 1usize) } else { (c - 12, 0usize) };
            e[root * NUM_QUALITIES + q_off] = dot;
        }
        e[N_INDEX] = N_BIAS;
        out.push(e);
    }
    out
}

/// Viterbi over chord states. Transition cost is 0 to stay, `-lambda` to switch
/// (constant), which favors longer, musically stable segments.
pub fn viterbi(emissions: &[[f32; NUM_CHORDS]], lambda: f32) -> Vec<usize> {
    let t = emissions.len();
    if t == 0 {
        return Vec::new();
    }
    let mut dp = emissions[0];
    let mut back = vec![[0usize; NUM_CHORDS]; t];

    for ti in 1..t {
        // Top-2 of the previous column to evaluate "switch" cheaply.
        let (mut a1, mut m1, mut a2, mut m2) = (0usize, f32::NEG_INFINITY, 0usize, f32::NEG_INFINITY);
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

        let mut next = [0f32; NUM_CHORDS];
        for s in 0..NUM_CHORDS {
            let stay = dp[s];
            let (change_best, change_arg) = if a1 != s { (m1, a1) } else { (m2, a2) };
            let change = change_best - lambda;
            if stay >= change {
                next[s] = emissions[ti][s] + stay;
                back[ti][s] = s;
            } else {
                next[s] = emissions[ti][s] + change;
                back[ti][s] = change_arg;
            }
        }
        dp = next;
    }

    // Backtrack from the best final state.
    let mut best = 0usize;
    let mut bestv = f32::NEG_INFINITY;
    for (s, &v) in dp.iter().enumerate() {
        if v > bestv {
            bestv = v;
            best = s;
        }
    }
    let mut path = vec![0usize; t];
    path[t - 1] = best;
    for ti in (1..t).rev() {
        path[ti - 1] = back[ti][path[ti]];
    }
    path
}

/// Convert a per-frame chord path into time-stamped segments, merging very
/// short segments into their neighbor.
pub fn build_segments(path: &[usize], hop_sec: f64, duration_sec: f64) -> Vec<ChordSegment> {
    const MIN_DUR: f64 = 0.2;
    /// Hold the previous chord through no-chord (N/X) gaps shorter than this —
    /// the model marks uncertain frames as "no chord"; for play-along, bridging
    /// brief gaps reads far better than blank "—" segments. Longer gaps (real
    /// instrumental breaks / silence) are kept as no-chord.
    const HOLD_N_DUR: f64 = 3.0;
    if path.is_empty() {
        return Vec::new();
    }

    // Group consecutive identical frames.
    let mut raw: Vec<(usize, usize, usize)> = Vec::new(); // (idx, start_frame, end_frame_excl)
    let mut start = 0usize;
    for i in 1..=path.len() {
        if i == path.len() || path[i] != path[start] {
            raw.push((path[start], start, i));
            start = i;
        }
    }

    let to_sec = |frame: usize| (frame as f64 * hop_sec).min(duration_sec);
    let mut segs: Vec<ChordSegment> = raw
        .into_iter()
        .map(|(idx, s, e)| ChordSegment {
            start_sec: to_sec(s),
            end_sec: if e >= path.len() { duration_sec } else { to_sec(e) },
            label: chord_label(idx),
            root_pc: chord_root_pc(idx),
            quality: chord_quality(idx).to_string(),
            bass_pc: -1,
            index: idx,
        })
        .collect();

    // Absorb sub-MIN_DUR segments into the previous one, then coalesce.
    let mut merged: Vec<ChordSegment> = Vec::with_capacity(segs.len());
    for seg in segs.drain(..) {
        if let Some(last) = merged.last_mut() {
            let dur = seg.end_sec - seg.start_sec;
            if dur < MIN_DUR {
                last.end_sec = seg.end_sec; // drop the blip, extend previous
                continue;
            }
            // Bridge brief no-chord (N/X, root_pc < 0) gaps by holding the chord.
            if seg.root_pc < 0 && last.root_pc >= 0 && dur < HOLD_N_DUR {
                last.end_sec = seg.end_sec;
                continue;
            }
            if last.index == seg.index {
                last.end_sec = seg.end_sec;
                continue;
            }
        }
        merged.push(seg);
    }
    merged
}

/// Full decode from per-frame emissions to segments (median already applied to
/// the chroma upstream; this smooths + Viterbi + segments).
pub fn decode(
    emissions: &[[f32; NUM_CHORDS]],
    hop_sec: f64,
    duration_sec: f64,
) -> Vec<ChordSegment> {
    const LAMBDA: f32 = 0.20;
    let path = viterbi(emissions, LAMBDA);
    build_segments(&path, hop_sec, duration_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        assert_eq!(chord_label(1), "C"); // root 0, maj
        assert_eq!(chord_label(0), "Cm"); // root 0, min
        assert_eq!(chord_label(2), "Cdim");
        assert_eq!(chord_label(9), "C7"); // root 0, dom7
        assert_eq!(chord_label(14), "C#m"); // root 1, min
        assert_eq!(chord_label(X_INDEX), "N");
        assert_eq!(chord_label(N_INDEX), "N");
        assert_eq!(chord_quality(0), "min");
        assert_eq!(chord_quality(1), "maj");
        assert_eq!(chord_quality(13), "sus4");
        assert_eq!(chord_root_pc(14), 1); // C#m
        assert_eq!(chord_root_pc(N_INDEX), -1);
    }

    #[test]
    fn viterbi_prefers_stable_path() {
        // Two frames clearly C, one noisy frame — should stay on C.
        let c = 0usize;
        let mut e = [[0f32; NUM_CHORDS]; 3];
        e[0][c] = 1.0;
        e[1][5] = 0.55; // slightly favors F mid-way
        e[1][c] = 0.5;
        e[2][c] = 1.0;
        let path = viterbi(&e, 0.20);
        assert_eq!(path, vec![c, c, c]);
    }

    #[test]
    fn segments_merge_blips() {
        let path = vec![0, 0, 0, 5, 0, 0, 0]; // single-frame blip (idx 5) inside idx 0 (Cm)
        let segs = build_segments(&path, 0.1, 0.7);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].label, "Cm"); // idx 0 = root C, min
    }

    fn seg(start: f64, end: f64) -> ChordSegment {
        ChordSegment {
            start_sec: start,
            end_sec: end,
            label: "C".into(),
            root_pc: 0,
            quality: "maj".into(),
            bass_pc: -1,
            index: 1,
        }
    }

    #[test]
    fn snap_moves_near_boundaries_onto_beats() {
        // Beats every 0.5 s; boundaries 60-80 ms off must land ON beats,
        // and the shared boundary stays shared.
        let beats: Vec<f64> = (0..40).map(|i| i as f64 * 0.5).collect();
        let mut segs = vec![seg(0.03, 2.06), seg(2.06, 3.94), seg(3.94, 6.0)];
        snap_segments_to_beats(&mut segs, &beats);
        assert!((segs[0].end_sec - 2.0).abs() < 1e-9, "2.06 → 2.0, got {}", segs[0].end_sec);
        assert_eq!(segs[1].start_sec, segs[0].end_sec);
        assert!((segs[1].end_sec - 4.0).abs() < 1e-9, "3.94 → 4.0, got {}", segs[1].end_sec);
    }

    #[test]
    fn snap_leaves_genuinely_offbeat_boundaries_alone() {
        // 0.25 s from every beat (beats at 0.5 s grid) > tol → untouched.
        let beats: Vec<f64> = (0..40).map(|i| i as f64 * 0.5).collect();
        let mut segs = vec![seg(0.0, 2.25), seg(2.25, 6.0)];
        snap_segments_to_beats(&mut segs, &beats);
        assert!((segs[0].end_sec - 2.25).abs() < 1e-9, "off-beat boundary moved");
    }

    #[test]
    fn snap_drops_collapsed_segments() {
        // A 40 ms sliver whose both boundaries snap to the SAME beat vanishes.
        let beats: Vec<f64> = (0..40).map(|i| i as f64 * 0.5).collect();
        let mut segs = vec![seg(0.0, 1.96), seg(1.96, 2.03), seg(2.03, 4.0)];
        snap_segments_to_beats(&mut segs, &beats);
        assert_eq!(segs.len(), 2, "sliver should be dropped");
        assert!(segs.windows(2).all(|w| w[1].start_sec >= w[0].end_sec - 1e-9));
    }
}
