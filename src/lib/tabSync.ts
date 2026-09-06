/**
 * Automatic tab-to-recording sync via chord-sequence alignment (Phase A).
 *
 * We already compute a chord timeline for the actual recording (real timestamps).
 * The Songsterr tab implies a chord per bar. Dynamic Time Warping (DTW) between the
 * two chord sequences yields a non-linear, drift-following correspondence that we
 * turn into AlphaTab FlatSyncPoint anchors (bar -> recording millisecond). AlphaTab
 * then interpolates the cursor between anchors. This replaces the brittle global
 * (offset, rate) map and survives tempo drift / a different-but-same-progression
 * performance. A confidence score lets callers fall back to the linear map.
 *
 * Granularity here is per-bar / per-chord-change (~1 bar precision); the chroma-frame
 * refinement that pushes this toward ±50ms lives in a later phase.
 */
import type { ChordSegment, SongsterrTrack } from "./types";
import { HOP_SECONDS, synthTabFrames } from "./tabChroma";
import { refineSync } from "./tauri";

/** Matches AlphaTab's FlatSyncPoint (structural — avoids a namespace import). */
export interface SyncAnchor {
  barIndex: number;
  barPosition: number;
  barOccurence: number;
  millisecondOffset: number;
}

export interface SyncResult {
  points: SyncAnchor[];
  /** 0–1; higher = the tab's chord progression matches the recording better. */
  confidence: number;
}

/** Cumulative bar-start position in QUARTER notes (from running time signatures). */
export function barStartQuarters(track: SongsterrTrack): number[] {
  const measures = track.measures ?? [];
  const starts: number[] = [];
  let cum = 0;
  let tsNum = 4;
  let tsDen = 4;
  for (let i = 0; i < measures.length; i++) {
    const sig = measures[i]?.signature;
    if (Array.isArray(sig) && sig.length === 2 && sig[0] && sig[1]) {
      tsNum = sig[0];
      tsDen = sig[1];
    }
    starts[i] = cum;
    cum += tsNum * (4 / tsDen);
  }
  return starts;
}

/**
 * Manual sync: a constant-tempo linear map. One anchor (start of bar 0) + a BPM
 * fully determine drift-free sync for a click-track recording — the industry-
 * standard minimal model. Emits one FlatSyncPoint per bar so AlphaTab follows our
 * line exactly regardless of the tab's own (possibly different) tempo automations.
 */
export function manualSyncPoints(track: SongsterrTrack, startSec: number, bpm: number): SyncResult {
  const starts = barStartQuarters(track);
  if (starts.length < 1 || !(bpm > 0)) return { points: [], confidence: 0 };
  const spq = 60 / bpm; // seconds per quarter note
  const points: SyncAnchor[] = starts.map((q, bar) => ({
    barIndex: bar,
    barPosition: 0,
    barOccurence: 0,
    millisecondOffset: Math.max(0, (startSec + q * spq) * 1000),
  }));
  return { points, confidence: 1 };
}

/**
 * Beat-following sync for a GENERATED/AI bass tab: map each bar to the recording's
 * real tracked beat time (from the DP beat tracker), so the tab rides the actual
 * groove — including tempo drift — instead of a rigid constant-tempo grid. The
 * generated bass is built AT (startSec, bpm), so bar b starts at beat b·beatsPerBar
 * counted from the tracked beat nearest `startSec`.
 */
export function beatSyncPoints(
  track: SongsterrTrack,
  beats: number[],
  startSec: number,
  beatsPerBar: number,
): SyncResult {
  const nBars = (track.measures ?? []).length;
  if (nBars < 1 || beats.length < 4 || !(beatsPerBar >= 1)) return { points: [], confidence: 0 };
  // Index of the tracked beat nearest bar 1.
  let i0 = 0;
  let bestD = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i] - startSec);
    if (d < bestD) {
      bestD = d;
      i0 = i;
    }
  }
  const points: SyncAnchor[] = [];
  let lastMs = -1;
  for (let b = 0; b < nBars; b++) {
    const bi = i0 + b * beatsPerBar;
    if (bi >= beats.length) break;
    const ms = Math.max(0, beats[bi] * 1000);
    if (ms <= lastMs) continue;
    points.push({ barIndex: b, barPosition: 0, barOccurence: 0, millisecondOffset: ms });
    lastMs = ms;
  }
  return { points, confidence: points.length >= 2 ? 1 : 0 };
}

/**
 * Fuse STRUCTURE (chord-DTW bar anchors: which bar starts roughly where, incl.
 * skipped sections) with TIMING (the recording's tracked beats). Each anchor is
 * snapped to the nearest beat; between two anchors the bars are laid out by
 * BEAT COUNT, so a tempo change under a held chord (invisible to chroma) still
 * moves the cursor on the beat. A span whose beat count doesn't fit its bar
 * count (a stretched/extra section, or beats the tracker lost) keeps only its
 * end anchors and AlphaTab interpolates — never a wrong dense grid. A tracker
 * running at double or half the notated pulse is recognised per span.
 */
export function beatQuantizeAnchors(
  points: SyncAnchor[],
  beats: number[],
  beatsPerBar: number,
  nBars: number,
): SyncAnchor[] {
  if (points.length === 0 || beats.length < 4 || !(beatsPerBar >= 1)) return points;
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  ibis.sort((a, b) => a - b);
  const medIbi = ibis[ibis.length >> 1];
  if (!(medIbi > 0)) return points;
  const tol = 0.35 * medIbi;
  const nearest = (sec: number): number => {
    let lo = 0;
    let hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < sec) lo = mid + 1;
      else hi = mid;
    }
    let k = lo;
    if (k > 0 && Math.abs(beats[k - 1] - sec) < Math.abs(beats[k] - sec)) k = k - 1;
    return Math.abs(beats[k] - sec) <= tol ? k : -1;
  };
  // Beats per bar for a span, if its count fits the notated meter at the
  // tracker's pulse (1×, 2× or ½×) within 12 %; else null (structural stretch).
  const stepFor = (nBeats: number, nSpanBars: number): number | null => {
    const c = nBeats / nSpanBars;
    for (const mult of [1, 2, 0.5]) {
      if (Math.abs(c / (beatsPerBar * mult) - 1) <= 0.12) return c;
    }
    return null;
  };

  const knots = points.map((p) => {
    const sec = p.millisecondOffset / 1000;
    const k = nearest(sec);
    return { bar: p.barIndex, beat: k, sec: k >= 0 ? beats[k] : sec };
  });
  const out: SyncAnchor[] = [];
  const push = (bar: number, sec: number) =>
    out.push({ barIndex: bar, barPosition: 0, barOccurence: 0, millisecondOffset: Math.max(0, sec * 1000) });

  let usedStep: number | null = null; // last accepted beats-per-bar (for extrapolation)
  for (let a = 0; a < knots.length; a++) {
    const ka = knots[a];
    const kb = knots[a + 1];
    if (kb && ka.beat >= 0 && kb.beat >= 0 && kb.bar > ka.bar) {
      const step = stepFor(kb.beat - ka.beat, kb.bar - ka.bar);
      if (step) {
        usedStep = step;
        for (let b = ka.bar; b < kb.bar; b++) {
          const idx = Math.round(ka.beat + (b - ka.bar) * step);
          if (idx < beats.length) push(b, beats[idx]);
        }
        continue;
      }
    }
    push(ka.bar, ka.sec); // endpoints only for this span (interpolated by AlphaTab)
  }

  // Extrapolate by beat count beyond the first/last anchor (leading rest bars,
  // an outro the chords never reached) at the tracker's pulse.
  const step = usedStep ?? beatsPerBar;
  const first = knots[0];
  if (first.beat >= 0 && first.bar > 0) {
    const lead: SyncAnchor[] = [];
    for (let b = first.bar - 1; b >= 0; b--) {
      const idx = Math.round(first.beat - (first.bar - b) * step);
      if (idx < 0) break;
      lead.unshift({ barIndex: b, barPosition: 0, barOccurence: 0, millisecondOffset: Math.max(0, beats[idx] * 1000) });
    }
    out.unshift(...lead);
  }
  const lastK = knots[knots.length - 1];
  if (lastK.beat >= 0) {
    for (let b = lastK.bar + 1; b < nBars; b++) {
      const idx = Math.round(lastK.beat + (b - lastK.bar) * step);
      if (idx >= beats.length) break;
      push(b, beats[idx]);
    }
  }

  // Strictly increasing in both bar and time (AlphaTab requirement).
  const clean: SyncAnchor[] = [];
  for (const p of out) {
    const prev = clean[clean.length - 1];
    if (prev && (p.barIndex <= prev.barIndex || p.millisecondOffset <= prev.millisecondOffset)) continue;
    clean.push(p);
  }
  return clean;
}

/**
 * Overlay the user's ⚓ PINNED bars onto an automatic anchor set. A pin is
 * authoritative: it replaces the auto anchor for its bar, and any auto anchor
 * that would break monotonicity around a pin (earlier bar at a later time, etc.)
 * is dropped. Pins that contradict EARLIER pins are ignored (first wins), so the
 * output is always a valid strictly-increasing anchor sequence.
 */
export function applyPins(
  auto: SyncAnchor[] | null,
  pins: Record<number, number>,
): SyncAnchor[] | null {
  const pinArr = Object.entries(pins)
    .map(([b, ms]) => ({ barIndex: Number(b), ms }))
    .filter((p) => Number.isFinite(p.barIndex) && Number.isFinite(p.ms) && p.ms >= 0)
    .sort((a, b) => a.barIndex - b.barIndex);
  if (!pinArr.length) return auto;
  // Keep only pins that are monotonic vs earlier pins.
  const pinsClean: typeof pinArr = [];
  for (const p of pinArr) {
    if (!pinsClean.length || p.ms > pinsClean[pinsClean.length - 1].ms) pinsClean.push(p);
  }
  const pinBars = new Set(pinsClean.map((p) => p.barIndex));
  const merged: SyncAnchor[] = [];
  let pi = 0;
  let lastMs = -1;
  const pushPin = (p: { barIndex: number; ms: number }) => {
    // A pin overrides: drop trailing autos that sit at/after its time.
    while (merged.length && merged[merged.length - 1].millisecondOffset >= p.ms) merged.pop();
    merged.push({ barIndex: p.barIndex, barPosition: 0, barOccurence: 0, millisecondOffset: p.ms });
    lastMs = p.ms;
  };
  for (const a of auto ?? []) {
    while (pi < pinsClean.length && pinsClean[pi].barIndex <= a.barIndex) pushPin(pinsClean[pi++]);
    if (pinBars.has(a.barIndex)) continue; // replaced by the pin
    if (a.millisecondOffset <= lastMs) continue; // violates a pin before it
    // Must also stay BELOW the next pin's time (it covers a later bar).
    if (pi < pinsClean.length && a.millisecondOffset >= pinsClean[pi].ms) continue;
    merged.push(a);
    lastMs = a.millisecondOffset;
  }
  while (pi < pinsClean.length) pushPin(pinsClean[pi++]);
  return merged;
}

/**
 * Solve (startSec, bpm) from two (bar, time) anchors — the two-tap fit that nails
 * both offset and tempo with no ML and no dependence on the notated BPM.
 */
export function fitTwoAnchors(
  track: SongsterrTrack,
  a0: { bar: number; timeSec: number },
  a1: { bar: number; timeSec: number },
): { startSec: number; bpm: number } | null {
  const starts = barStartQuarters(track);
  const q0 = starts[a0.bar];
  const q1 = starts[a1.bar];
  if (q0 === undefined || q1 === undefined || q1 === q0 || a1.timeSec === a0.timeSec) return null;
  const spq = (a1.timeSec - a0.timeSec) / (q1 - q0); // seconds per quarter
  if (!(spq > 0)) return null;
  return { startSec: a0.timeSec - q0 * spq, bpm: 60 / spq };
}

/** Chord-quality → semitone intervals from the root (the 14 engine qualities). */
const QUALITY_INTERVALS: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  min6: [0, 3, 7, 9],
  maj6: [0, 4, 7, 9],
  min7: [0, 3, 7, 10],
  minmaj7: [0, 3, 7, 11],
  maj7: [0, 4, 7, 11],
  dom7: [0, 4, 7, 10],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

/** 12-d binary chroma for a detected chord, or null for no-chord. */
export function segChroma(seg: ChordSegment): number[] | null {
  if (seg.rootPc < 0 || seg.quality === "N") return null;
  const intervals = QUALITY_INTERVALS[seg.quality] ?? [0, 4, 7];
  const v = new Array<number>(12).fill(0);
  for (const iv of intervals) v[(seg.rootPc + iv) % 12] = 1;
  if (typeof seg.bassPc === "number" && seg.bassPc >= 0) v[seg.bassPc % 12] = 1;
  return v;
}

/** 12-d chroma per bar from the tab's notes (string+fret → pitch class). */
export function barChromas(track: SongsterrTrack): number[][] {
  const tuning = (track.tuning ?? []).filter((n) => Number.isFinite(n));
  const measures = track.measures ?? [];
  return measures.map((m) => {
    const v = new Array<number>(12).fill(0);
    for (const voice of m.voices ?? []) {
      for (const beat of voice.beats ?? []) {
        for (const note of beat.notes ?? []) {
          const open = tuning[note.string];
          if (typeof open !== "number") continue;
          v[(((open + note.fret) % 12) + 12) % 12] += 1;
        }
      }
    }
    return v;
  });
}

function cosDist(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < 12; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  if (na === 0 || nb === 0) return 1;
  // Clamp: float error can make identical vectors return -2e-16 instead of 0,
  // which flips DTW's tie-breaking toward maximal zigzag paths (negative cost
  // REWARDS extra steps) and skews anchors by whole bars in repeated sections.
  return Math.max(0, 1 - dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

/** Banded DTW (Sakoe-Chiba). Returns the warp path + mean per-step cost. */
export function dtw(
  A: number[][],
  B: number[][],
  band: number,
): { path: Array<[number, number]>; avgCost: number } {
  const n = A.length;
  const m = B.length;
  const INF = Infinity;
  const D: Float64Array[] = Array.from({ length: n }, () => new Float64Array(m).fill(INF));
  const dist = (i: number, j: number) => cosDist(A[i], B[j]);

  for (let i = 0; i < n; i++) {
    const center = Math.floor((i * m) / n);
    const lo = Math.max(0, center - band);
    const hi = Math.min(m - 1, center + band);
    for (let j = lo; j <= hi; j++) {
      const c = dist(i, j);
      if (i === 0 && j === 0) {
        D[i][j] = c;
        continue;
      }
      let best = INF;
      if (i > 0) best = Math.min(best, D[i - 1][j]);
      if (j > 0) best = Math.min(best, D[i][j - 1]);
      if (i > 0 && j > 0) best = Math.min(best, D[i - 1][j - 1]);
      D[i][j] = c + (best === INF ? 0 : best);
    }
  }

  const path: Array<[number, number]> = [];
  let i = n - 1;
  let j = m - 1;
  let total = 0;
  let steps = 0;
  while (i > 0 || j > 0) {
    path.push([i, j]);
    total += dist(i, j);
    steps++;
    const up = i > 0 ? D[i - 1][j] : INF;
    const left = j > 0 ? D[i][j - 1] : INF;
    const diag = i > 0 && j > 0 ? D[i - 1][j - 1] : INF;
    const mn = Math.min(up, left, diag);
    if (mn === diag) {
      i--;
      j--;
    } else if (mn === up) {
      i--;
    } else {
      j--;
    }
  }
  path.push([0, 0]);
  total += dist(0, 0);
  steps++;
  path.reverse();
  return { path, avgCost: total / steps };
}

/**
 * Subsequence DTW (Müller / librosa `subseq=True`): align ALL of the tab's bars
 * (B) to ANY contiguous stretch of the recording's chord segments (A) — the
 * alignment may start and end anywhere in the audio. This is what makes the tab
 * enter exactly where its music actually starts instead of being pinned to the
 * recording's first detected chord (which an intro the tab doesn't notate, a
 * pickup, or an early misdetection would otherwise drag to bar 0).
 * Sizes here are tiny (segments × bars ≈ 10⁴ cells), so no band is needed.
 */
/** Gap penalties for structural skips: `open` once per run + `extend` per unit. */
export interface SkipPenalty {
  open: number;
  extend: number;
  max: number;
}
export interface SubseqOptions {
  /** Skip runs of AUDIO segments — the recording repeats/adds material the tab lacks. */
  audioSkip?: SkipPenalty | null;
  /** Skip runs of TAB bars — the tab has material the recording cut (edit, fade). */
  tabSkip?: SkipPenalty | null;
}
/** Cheaper than absorbing ≥3 mismatching units (each ~0.6–1.0 cosine distance),
 *  dearer than a single misdetected chord (absorbed as before). */
export const DEFAULT_SKIPS: Required<SubseqOptions> = {
  audioSkip: { open: 0.5, extend: 0.35, max: 64 },
  tabSkip: { open: 0.5, extend: 0.35, max: 48 },
};

export interface SubseqResult {
  path: Array<[number, number]>;
  /** Mean per-unit cost INCLUDING skip penalties (so a heavily-skipped alignment
   *  can't masquerade as a confident one). */
  avgCost: number;
  /** Audio segments the alignment jumped over (recording-only material). */
  skippedAudio: number;
  /** Tab bars the alignment jumped over (tab-only material). */
  skippedBars: number;
}

export function subseqDtw(A: number[][], B: number[][], opts: SubseqOptions = DEFAULT_SKIPS): SubseqResult {
  const n = A.length; // audio chord segments (the "text")
  const m = B.length; // tab bars (the "pattern" — consumed, bar skips excepted)
  const INF = Infinity;
  if (n === 0 || m === 0) return { path: [], avgCost: 1, skippedAudio: 0, skippedBars: 0 };
  const dist = (i: number, j: number) => cosDist(A[i], B[j]);
  const aSkip = opts.audioSkip ?? null;
  const tSkip = opts.tabSkip ?? null;
  // Micro-penalty on non-diagonal steps: among otherwise-TIED paths (e.g. a run
  // of identical bars over identical segments, where every cell costs exactly 0)
  // it makes the diagonal strictly cheapest, so bars can't silently pile up on
  // one segment. ~1e-6 × path length is noise next to real chroma distances.
  const STEP_PEN = 1e-6;

  // Tiny start-position bias: on a REPEATING song, the same loop matches equally
  // well at several audio positions (all cost ~0), and without a tiebreaker the
  // DP can lock onto a LATER repeat — the tab then plays a whole section ahead of
  // the recording, invisibly to the confidence gate. Bias the free-start toward
  // the EARLIEST position so ties resolve to the song's actual beginning. The
  // bias (max ~1e-4 across the whole track) is far below any real chroma distance,
  // so it only breaks exact ties.
  const START_BIAS = 1e-4;
  const startBias = (i: number) => (i / Math.max(1, n)) * START_BIAS;

  // D[j*n+i]: cost of aligning tab bars 0..j ending at audio segment i.
  // Back-pointers: 0 start · 1 up · 2 left · 3 diag · 4+k skip k audio segments
  // (from (j-1, i-1-k)) · 1000+k skip k tab bars (from (j-1-k, i-1)) ·
  // 2000+j skipped the tab's first j bars (free start at bar j).
  const D = new Float64Array(m * n).fill(INF);
  const bp = new Int32Array(m * n);
  for (let i = 0; i < n; i++) D[i] = dist(i, 0) + startBias(i); // free start, earliest wins ties
  for (let j = 1; j < m; j++) {
    const row = j * n;
    const prev = (j - 1) * n;
    for (let i = 0; i < n; i++) {
      const c = dist(i, j);
      let best = D[prev + i] + STEP_PEN; // up
      let move = 1;
      if (i > 0) {
        const left = D[row + i - 1] + STEP_PEN;
        if (left < best) {
          best = left;
          move = 2;
        }
        const diag = D[prev + i - 1];
        if (diag <= best) {
          best = diag;
          move = 3;
        }
        if (aSkip) {
          // Bar j-1 ended at segment i-1-k; segments i-k..i-1 are unmatched.
          const kmax = Math.min(aSkip.max, i - 1);
          for (let k = 1; k <= kmax; k++) {
            const v = D[prev + i - 1 - k] + aSkip.open + k * aSkip.extend;
            if (v < best) {
              best = v;
              move = 4 + k;
            }
          }
        }
        if (tSkip) {
          // Bars j-k..j-1 are unmatched; bar j-1-k ended at segment i-1.
          const kmax = Math.min(tSkip.max, j - 1);
          for (let k = 1; k <= kmax; k++) {
            const v = D[(j - 1 - k) * n + i - 1] + tSkip.open + k * tSkip.extend;
            if (v < best) {
              best = v;
              move = 1000 + k;
            }
          }
        }
      }
      if (tSkip && j <= tSkip.max) {
        // The tab opens with bars the recording doesn't have: start at bar j.
        const v = startBias(i) + tSkip.open + j * tSkip.extend;
        if (v < best) {
          best = v;
          move = 2000 + j;
        }
      }
      if (best < INF) {
        D[row + i] = c + best;
        bp[row + i] = move;
      }
    }
  }

  // Free end: best last-row cell.
  const last = (m - 1) * n;
  let end = 0;
  for (let i = 1; i < n; i++) if (D[last + i] < D[last + end]) end = i;
  if (!Number.isFinite(D[last + end])) return { path: [], avgCost: 1, skippedAudio: 0, skippedBars: 0 };

  // Backtrack to row 0 (or a start-skip); wherever we land is the audio start.
  const path: Array<[number, number]> = [];
  let j = m - 1;
  let i = end;
  let total = 0;
  let units = 0;
  let skippedAudio = 0;
  let skippedBars = 0;
  for (;;) {
    path.push([i, j]);
    total += dist(i, j);
    units++;
    if (j === 0) break;
    const move = bp[j * n + i];
    if (move === 3) {
      i--;
      j--;
    } else if (move === 1) {
      j--;
    } else if (move === 2) {
      i--;
    } else if (move >= 2000) {
      const k = move - 2000;
      skippedBars += k;
      total += (tSkip?.open ?? 0) + k * (tSkip?.extend ?? 0);
      units += k;
      break;
    } else if (move >= 1000) {
      const k = move - 1000;
      skippedBars += k;
      total += (tSkip?.open ?? 0) + k * (tSkip?.extend ?? 0);
      units += k;
      j -= 1 + k;
      i--;
    } else if (move >= 4) {
      const k = move - 4;
      skippedAudio += k;
      total += (aSkip?.open ?? 0) + k * (aSkip?.extend ?? 0);
      units += k;
      i -= 1 + k;
      j--;
    } else {
      break; // start marker
    }
  }
  path.reverse();
  return { path, avgCost: units ? total / units : 1, skippedAudio, skippedBars };
}

/**
 * Align the recording's chord timeline to the tab's per-bar chords and emit
 * AlphaTab sync-point anchors (one per bar, at the recording time that bar starts).
 */
export function computeSyncPoints(segs: ChordSegment[], track: SongsterrTrack): SyncResult {
  const A: number[][] = [];
  const Atime: number[] = [];
  for (const s of segs) {
    const c = segChroma(s);
    if (c) {
      A.push(c);
      Atime.push(s.startSec);
    }
  }
  const B = barChromas(track);
  if (A.length < 4 || B.length < 2) return { points: [], confidence: 0 };

  // Trim leading/trailing EMPTY tab bars (count-in / rest bars have no notes, so
  // they can't be matched against audio chroma) — align only the content span.
  // Bar 0 is then back-extrapolated over the leading rests below.
  const hasNotes = (v: number[]) => v.some((x) => x > 0);
  let firstContent = B.findIndex(hasNotes);
  if (firstContent < 0) firstContent = 0;
  let lastContent = B.length - 1;
  while (lastContent > firstContent && !hasNotes(B[lastContent])) lastContent--;
  const Bc = B.slice(firstContent, lastContent + 1);
  if (Bc.length < 2) return { points: [], confidence: 0 };

  // Open-begin/open-end alignment: the tab may start anywhere in the recording.
  const { path, avgCost } = subseqDtw(A, Bc);
  if (path.length === 0) return { points: [], confidence: 0 };

  // First recording time aligned to each distinct bar (content-bar → real bar).
  const barTime = new Map<number, number>();
  for (const [ai, bj] of path) {
    const bar = bj + firstContent;
    if (!barTime.has(bar)) barTime.set(bar, Atime[ai]);
  }

  const points: SyncAnchor[] = [];
  let lastMs = -1;
  for (const bj of [...barTime.keys()].sort((x, y) => x - y)) {
    const ms = (barTime.get(bj) ?? 0) * 1000;
    if (ms <= lastMs) continue; // keep strictly increasing — AlphaTab interpolates the rest
    points.push({ barIndex: bj, barPosition: 0, barOccurence: 0, millisecondOffset: ms });
    lastMs = ms;
  }

  // Always anchor bar 0: without it AlphaTab interpolates the whole intro from
  // (0ms, tick0) to the first real anchor, squashing every bar before it. Back-
  // extrapolate from the first two anchors (constant-tempo within the intro).
  // If the extrapolation lands BEFORE the recording starts (the tab notates more
  // leading rest than the audio has), we can't know bar 0's true time — emit no
  // bar-0 anchor so callers (alignedStartSec) don't trust a clamped-to-0 lie.
  if (points.length >= 2 && points[0].barIndex > 0) {
    const a = points[0];
    const b = points[1];
    const span = b.barIndex - a.barIndex;
    if (span > 0) {
      const msPerBar = (b.millisecondOffset - a.millisecondOffset) / span;
      const bar0Ms = a.millisecondOffset - msPerBar * a.barIndex;
      if (bar0Ms >= 0 && bar0Ms < a.millisecondOffset) {
        points.unshift({ barIndex: 0, barPosition: 0, barOccurence: 0, millisecondOffset: bar0Ms });
      }
    }
  }

  // Always anchor the LAST bar to where the recording's harmony actually ends.
  // Otherwise a tab whose final bars the chord-DTW never reached (a fade-out, an
  // outro the detector heard as no-chord) collapses them onto the last matched
  // anchor and AlphaTab then extrapolates at the NOTATED tempo — the classic
  // "drifts + goes out of tempo toward the end". Pinning the end instead spreads
  // those bars across the real remaining time.
  const lastBar = B.length - 1;
  // End of the last segment that actually carries a CHORD — NOT segs[last].endSec,
  // which includes a trailing no-chord tail (silence / applause / a long fade the
  // detector heard as no-chord). Pinning the final bar to the absolute end would
  // stretch the last content bars across that dead air, drifting the outro. Fall
  // back to the absolute end only if nothing has a chord.
  let musicEndSec = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segChroma(segs[i])) {
      musicEndSec = segs[i].endSec;
      break;
    }
  }
  const recEndMs = (musicEndSec || (segs.length ? segs[segs.length - 1].endSec : 0)) * 1000;
  const tail = points[points.length - 1];
  if (tail && tail.barIndex < lastBar && recEndMs > tail.millisecondOffset + 1) {
    points.push({ barIndex: lastBar, barPosition: 0, barOccurence: 0, millisecondOffset: recEndMs });
  }

  let confidence = Math.max(0, Math.min(1, 1 - avgCost));
  // Physical sanity: if the matched audio span implies an impossible bar rate
  // (audio much shorter than the tab → surplus bars crammed onto one segment),
  // the alignment is nonsense no matter how cheap its path was. <0.7 s/bar is
  // beyond ~340 BPM in 4/4 — scale confidence down toward zero.
  const matchedSpanSec = Atime[path[path.length - 1][0]] - Atime[path[0][0]];
  const secPerBar = matchedSpanSec / Math.max(1, Bc.length - 1);
  if (secPerBar < 0.7) confidence *= Math.max(0, secPerBar / 0.7);
  return { points, confidence };
}

/**
 * Phase B: refine coarse anchors to ~50 ms via chroma-frame DTW in the Rust core.
 * Synthesizes the tab's chroma frames here, hands them + the coarse anchors to the
 * `refine_sync` command, then gates the result (per-anchor + global) so it can
 * never regress Phase A. Returns the coarse result unchanged on any failure.
 */
export async function refineSyncPoints(
  coarse: SyncResult,
  track: SongsterrTrack,
  wavPath: string,
): Promise<SyncResult> {
  if (coarse.points.length < 2 || !wavPath) return coarse;
  const { frames, barStartFrame } = synthTabFrames(track, HOP_SECONDS);
  if (frames.length < 4) return coarse;

  const coarseAnchors = coarse.points.map((p) => ({
    barIndex: p.barIndex,
    millisecondOffset: p.millisecondOffset,
  }));
  const res = await refineSync(wavPath, frames, barStartFrame, coarseAnchors);
  if (!res || res.anchors.length < 2) return coarse;
  // Global guard: only adopt the fine pass if it didn't get worse than Phase A.
  if (res.confidence < Math.max(0.4, 0.9 * coarse.confidence)) return coarse;

  const coarseByBar = new Map(coarse.points.map((p) => [p.barIndex, p.millisecondOffset]));
  // The Rust fine DTW is CLOSED-start (its path always pins audio 0 ↔ tab 0), so
  // over a skipped intro it emits bogus anchors at ~0 ms. The open-begin coarse
  // pass owns WHERE the tab enters — refined anchors may only nudge (±½ bar),
  // never jump before the coarse entry. Drop anything earlier than that floor.
  const coarseStartMs = coarse.points[0].millisecondOffset;
  const floorMs = Math.max(0, coarseStartMs - 400);
  const merged: SyncAnchor[] = [];
  let lastMs = -1;
  for (const a of res.anchors) {
    // Per-anchor gate: trust the refined ms only when locally confident; else fall
    // back to the coarse ms for that bar. If the bar is ABSENT from the coarse set
    // (a sustained-chord bar the coarse pass de-duplicated away) there IS no
    // fallback — SKIP it entirely so AlphaTab interpolates smoothly between the
    // trusted neighbours, instead of keeping the low-confidence refined value that
    // wandered within the ±2-bar band and marched the cursor unevenly.
    let ms: number;
    if (a.confidence >= 0.55) {
      ms = a.millisecondOffset;
    } else {
      const c = coarseByBar.get(a.barIndex);
      if (c === undefined) continue; // no fallback for a de-duped bar → drop, interpolate
      ms = c;
    }
    if (ms < floorMs) continue; // closed-start artifact inside the skipped intro
    if (ms <= lastMs) continue;
    merged.push({ barIndex: a.barIndex, barPosition: 0, barOccurence: 0, millisecondOffset: ms });
    lastMs = ms;
  }
  // Keep the aligned entry: if the intro-artifact filter dropped bar 0 (or the
  // earliest bars), restore the coarse leading anchors in front.
  const lead: SyncAnchor[] = [];
  for (const p of coarse.points) {
    if (merged.length && p.barIndex >= merged[0].barIndex) break;
    if (merged.length && p.millisecondOffset >= merged[0].millisecondOffset) break;
    lead.push({ ...p });
  }
  merged.unshift(...lead);
  if (merged.length < 2) return coarse;
  return { points: merged, confidence: res.confidence };
}
