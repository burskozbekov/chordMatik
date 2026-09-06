/**
 * Audio-verified bars: how well each bar of the tab agrees with what the
 * recording actually plays there. Community tabs contain mistakes; we already
 * decode the recording's chords on-device, so every bar can carry a verdict:
 * the fraction of the bar's notes (pitch classes, weighted by how often they
 * occur) that belong to a chord sounding during that bar. 1 = every note is a
 * chord tone of what's playing, 0 = none is. Bars without notes, or bars the
 * detector heard as no-chord, get no verdict (null).
 */
import type { ChordSegment, SongsterrTrack } from "./types";
import { barChromas, segChroma, type SyncAnchor } from "./tabSync";

/** Start time (s) of every bar from sparse sync anchors — `nBars + 1` entries,
 *  the last being the END of the final bar. Anchored bars exactly, bars between
 *  anchors interpolated linearly, bars outside extrapolated at the mean anchored
 *  bar length. Null without at least two anchors. */
export function barStartTimes(points: SyncAnchor[] | null, nBars: number): number[] | null {
  if (!points || points.length < 2 || nBars <= 0) return null;
  const anchors = points.filter((p) => p.barIndex >= 0).sort((a, b) => a.barIndex - b.barIndex);
  if (anchors.length < 2) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const meanBar =
    (last.millisecondOffset - first.millisecondOffset) / 1000 / Math.max(1, last.barIndex - first.barIndex);
  const out = new Array<number>(nBars + 1);
  let ai = 0;
  for (let b = 0; b <= nBars; b++) {
    while (ai + 1 < anchors.length && anchors[ai + 1].barIndex <= b) ai++;
    const a = anchors[ai];
    if (b < first.barIndex) {
      out[b] = first.millisecondOffset / 1000 - (first.barIndex - b) * meanBar;
    } else if (b >= last.barIndex) {
      out[b] = last.millisecondOffset / 1000 + (b - last.barIndex) * meanBar;
    } else {
      const nxt = anchors[ai + 1];
      const frac = (b - a.barIndex) / Math.max(1, nxt.barIndex - a.barIndex);
      out[b] = (a.millisecondOffset + frac * (nxt.millisecondOffset - a.millisecondOffset)) / 1000;
    }
  }
  return out;
}

/** Pitch classes sounding in [t0, t1): weight = seconds each class is a chord tone. */
export function audioPitchWeights(segs: ChordSegment[], t0: number, t1: number): number[] {
  const w = new Array<number>(12).fill(0);
  for (const s of segs) {
    if (s.endSec <= t0 || s.startSec >= t1) continue;
    const c = segChroma(s);
    if (!c) continue;
    const ov = Math.min(s.endSec, t1) - Math.max(s.startSec, t0);
    if (ov <= 0) continue;
    for (let pc = 0; pc < 12; pc++) if (c[pc]) w[pc] += ov;
  }
  return w;
}

/** Per-bar agreement in [0,1], or null where there is no verdict to give. */
export function barAgreement(
  segs: ChordSegment[],
  track: SongsterrTrack,
  points: SyncAnchor[] | null,
): (number | null)[] {
  const nBars = (track.measures ?? []).length;
  const starts = barStartTimes(points, nBars);
  const tab = barChromas(track);
  const out: (number | null)[] = new Array(nBars).fill(null);
  if (!starts || !segs.length) return out;
  const lastEnd = segs[segs.length - 1].endSec;
  for (let b = 0; b < nBars; b++) {
    const t0 = starts[b];
    const t1 = starts[b + 1];
    if (!(t1 > t0) || t0 >= lastEnd) continue;
    const notes = tab[b];
    const total = notes.reduce((s, x) => s + x, 0);
    if (total === 0) continue; // rest bar — nothing to judge
    const w = audioPitchWeights(segs, t0, t1);
    const covered = Math.max(...w);
    if (covered < 0.3 * (t1 - t0)) continue; // mostly no-chord — no verdict
    // A pitch class "sounds" when it is a chord tone for ≥ 20 % of the bar.
    const thresh = 0.2 * (t1 - t0);
    let ok = 0;
    for (let pc = 0; pc < 12; pc++) if (notes[pc] > 0 && w[pc] >= thresh) ok += notes[pc];
    out[b] = ok / total;
  }
  return out;
}
