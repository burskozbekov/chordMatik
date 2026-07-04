/**
 * Audio cross-validation for a candidate tab — does this tab actually match the
 * recording chordMatik decoded? We compare the tab's per-bar chord chromas to our
 * decoded chord progression, made transposition-INVARIANT (a capo / alt-tuning /
 * transposed tab shifts every pitch class by a constant δ, i.e. a circular
 * rotation — the Optimal-Transposition-Index idea from cover-song ID). We find
 * the best δ via a 12-lag histogram correlation, run ONE banded DTW at that δ
 * (reusing the existing sync DTW), and blend in a forgiving duration check.
 *
 * Used to pick the best of several Songsterr candidates and to reject an
 * irrelevant tab (wrong song / wrong version) → fall back to "chords only".
 */
import type { ChordSegment, SongsterrTrack } from "./types";
import { barChromas, barStartQuarters, dtw, segChroma } from "./tabSync";

export interface TabAgreement {
  /** Overall 0..1 (higher = better match). */
  score: number;
  /** Transposition-invariant chord-progression agreement (the dominant signal). */
  sChord: number;
  /** Duration agreement (tab length vs audio length); 1 when unknown. */
  sTempo: number;
  /** δ* semitones (audio − tab) — the detected capo / transpose offset. */
  shift: number;
  /** False when there wasn't enough decoded chord data to judge (fail open). */
  verifiable: boolean;
}

const UNVERIFIABLE: TabAgreement = { score: 1, sChord: 1, sTempo: 1, shift: 0, verifiable: false };

/** Rotate a 12-d pitch-class vector up by d semitones. */
function rotate(v: number[], d: number): number[] {
  const out = new Array<number>(12);
  for (let p = 0; p < 12; p++) out[p] = v[(((p - d) % 12) + 12) % 12];
  return out;
}

/** Total length of the tab in quarter notes (for the duration check). */
function totalQuarters(track: SongsterrTrack): number {
  const starts = barStartQuarters(track);
  const n = starts.length;
  if (n === 0) return 0;
  const lastBar = n >= 2 ? starts[n - 1] - starts[n - 2] : 4;
  return starts[n - 1] + lastBar;
}

/**
 * Score how well `track` matches the decoded `segs`. `audioDurSec` (e.g. the last
 * chord segment's endSec) enables the duration check.
 */
export function tabAgreement(
  segs: ChordSegment[],
  track: SongsterrTrack,
  audioDurSec?: number,
): TabAgreement {
  const A: number[][] = [];
  for (const s of segs) {
    const c = segChroma(s);
    if (c) A.push(c);
  }
  const B = barChromas(track);
  if (A.length < 4 || B.length < 2) return UNVERIFIABLE;
  // Guard: skip rather than run 3× banded DTW on a pathologically large sequence
  // (keeps the synchronous scoring off the main thread's critical path).
  if (A.length > 800 || B.length > 800) return UNVERIFIABLE;

  // OTI: best circular shift δ* aligning the (duration-pooled) chord histograms.
  const hA = new Array<number>(12).fill(0);
  for (const v of A) for (let p = 0; p < 12; p++) hA[p] += v[p];
  const hB = new Array<number>(12).fill(0);
  for (const v of B) for (let p = 0; p < 12; p++) hB[p] += v[p];
  let shift = 0;
  let bestDot = -1;
  for (let d = 0; d < 12; d++) {
    let dot = 0;
    for (let p = 0; p < 12; p++) dot += hA[p] * hB[(((p - d) % 12) + 12) % 12];
    if (dot > bestDot) {
      bestDot = dot;
      shift = d;
    }
  }

  // Chord-progression agreement: one banded DTW at δ* (try δ*±1, keep best).
  const band = Math.max(15, Math.round(0.2 * Math.max(A.length, B.length)));
  let sChord = 0;
  for (const d of [shift, (shift + 1) % 12, (shift + 11) % 12]) {
    const Bd = B.map((v) => rotate(v, d));
    const { avgCost } = dtw(A, Bd, band);
    const s = Math.max(0, Math.min(1, 1 - avgCost));
    if (s > sChord) {
      sChord = s;
      shift = d;
    }
  }

  // Duration agreement — tab (bars × notated beat) vs audio length; forgiving
  // (tabs often omit repeats/outros), log-normal so half/double length is penalized.
  let sTempo = 1;
  const notatedBpm = track.automations?.tempo?.[0]?.bpm;
  if (audioDurSec && audioDurSec > 1 && typeof notatedBpm === "number" && notatedBpm > 0) {
    const tabDur = totalQuarters(track) * (60 / notatedBpm);
    if (tabDur > 1) {
      const r = Math.log(tabDur / audioDurSec);
      sTempo = Math.exp(-(r * r) / (2 * 0.35 * 0.35));
    }
  }

  const score = 0.7 * sChord + 0.3 * sTempo;
  return { score, sChord, sTempo, shift, verifiable: true };
}
