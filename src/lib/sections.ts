/**
 * Lightweight song-section detection from the chord track (no beats needed).
 * Windows the song into a chord-content profile, greedily merges similar windows
 * into homogeneous segments, then labels repeats A/B/C… by profile similarity.
 * Generic labels (not intro/verse/chorus) but enough to see structure + jump.
 */
import type { ChordSegment } from "./types";

const QUALITY_INTERVALS: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  min6: [0, 3, 7, 9], maj6: [0, 4, 7, 9], min7: [0, 3, 7, 10], minmaj7: [0, 3, 7, 11],
  maj7: [0, 4, 7, 11], dom7: [0, 4, 7, 10], dim7: [0, 3, 6, 9], hdim7: [0, 3, 6, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
};

export interface Section {
  startSec: number;
  endSec: number;
  /** Repeat label: A, B, C… (same letter = similar chord content). */
  label: string;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // inputs are unit-normalized
}

function windowHist(segs: ChordSegment[], lo: number, hi: number): number[] {
  const h = new Array<number>(12).fill(0);
  for (const s of segs) {
    if (s.rootPc < 0 || s.quality === "N" || s.endSec <= lo || s.startSec >= hi) continue;
    const ov = Math.min(s.endSec, hi) - Math.max(s.startSec, lo);
    if (ov <= 0) continue;
    for (const iv of QUALITY_INTERVALS[s.quality] ?? [0, 4, 7]) h[(s.rootPc + iv) % 12] += ov;
  }
  return normalize(h);
}

export function detectSections(segs: ChordSegment[], duration: number): Section[] {
  if (segs.length === 0 || duration <= 0) return [];
  const WIN = 2.0;
  const nWin = Math.max(1, Math.ceil(duration / WIN));
  const hists = Array.from({ length: nWin }, (_, i) => windowHist(segs, i * WIN, (i + 1) * WIN));

  // Greedy homogeneous segmentation.
  type Seg = { startWin: number; endWin: number; mean: number[]; count: number };
  const out: Seg[] = [];
  let cur: Seg = { startWin: 0, endWin: 1, mean: hists[0].slice(), count: 1 };
  for (let i = 1; i < nWin; i++) {
    if (cosine(hists[i], normalize(cur.mean)) < 0.6) {
      out.push(cur);
      cur = { startWin: i, endWin: i + 1, mean: hists[i].slice(), count: 1 };
    } else {
      for (let k = 0; k < 12; k++) cur.mean[k] = (cur.mean[k] * cur.count + hists[i][k]) / (cur.count + 1);
      cur.count += 1;
      cur.endWin = i + 1;
    }
  }
  out.push(cur);

  // Merge segments shorter than 3 windows (~6s) into the previous one.
  const merged: Seg[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.endWin - s.startWin < 3) {
      prev.endWin = s.endWin;
    } else {
      merged.push({ ...s, mean: normalize(s.mean) });
    }
  }
  if (merged.length <= 1) return [];

  // Label by repetition.
  const labelHists: number[][] = [];
  return merged.map((s) => {
    const mean = normalize(s.mean);
    let idx = labelHists.findIndex((h) => cosine(mean, h) > 0.9);
    if (idx < 0) {
      idx = labelHists.length;
      labelHists.push(mean);
    }
    return {
      startSec: s.startWin * WIN,
      endSec: Math.min(duration, s.endWin * WIN),
      label: String.fromCharCode(65 + (idx % 26)),
    };
  });
}
