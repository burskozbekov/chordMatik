/**
 * Lightweight key (tonic + mode) estimation from the chord track via
 * Krumhansl-Schmuckler profile correlation. We already have the chords with
 * durations, so this is essentially free and shows in the header (Chordify-style).
 */
import type { ChordSegment } from "./types";

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

export interface KeyEstimate {
  tonicPc: number;
  mode: "major" | "minor";
  /** e.g. "A minor". */
  name: string;
  /** 0–1 (best correlation, clamped). */
  confidence: number;
}

export function estimateKey(segments: ChordSegment[]): KeyEstimate | null {
  // Duration-weighted pitch-class profile from chord tones (root emphasized).
  const prof = new Array<number>(12).fill(0);
  for (const s of segments) {
    if (s.rootPc < 0 || s.quality === "N") continue;
    const dur = Math.max(0, s.endSec - s.startSec);
    if (dur <= 0) continue;
    const intervals = QUALITY_INTERVALS[s.quality] ?? [0, 4, 7];
    for (const iv of intervals) prof[(s.rootPc + iv) % 12] += dur;
    prof[s.rootPc] += dur * 0.6; // the root carries the most key weight
  }
  if (prof.reduce((a, b) => a + b, 0) <= 0) return null;

  let best: KeyEstimate | null = null;
  let bestScore = -2;
  for (let t = 0; t < 12; t++) {
    for (const [mode, ks] of [
      ["major", KS_MAJOR],
      ["minor", KS_MINOR],
    ] as const) {
      // Rotate the C-profile so index pc lines up with tonic t.
      const rotated = Array.from({ length: 12 }, (_, pc) => ks[(pc - t + 12) % 12]);
      const score = pearson(prof, rotated);
      if (score > bestScore) {
        bestScore = score;
        best = {
          tonicPc: t,
          mode,
          name: `${NOTE_NAMES[t]} ${mode}`,
          confidence: Math.max(0, Math.min(1, score)),
        };
      }
    }
  }
  return best;
}
