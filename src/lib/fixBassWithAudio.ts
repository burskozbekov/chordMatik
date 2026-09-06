/**
 * "Fix with audio" for a Songsterr BASS tab: replace notes that contradict the
 * recording. Two independent on-device signals must AGREE against the tab
 * before a note is touched — the AI transcription (basic-pitch, the note that
 * actually sounds there) and the chord analysis (the bass pitch class of the
 * chord playing there). A note that matches either signal is left alone, so
 * transcription noise can't "correct" a right note, and a correct fill under a
 * different chord tone survives too.
 */
import type { ChordSegment, SongsterrBeat, SongsterrTrack } from "./types";
import type { TranscribedBassNote } from "./tauri";
import type { SyncAnchor } from "./tabSync";
import { barStartTimes } from "./barAgreement";
import { durWhole } from "./tabChroma";

export interface FixResult {
  track: SongsterrTrack;
  /** Notes replaced. */
  fixed: number;
  /** Bar indexes that received at least one fix. */
  bars: number[];
}

function chordBassPcAt(segs: ChordSegment[], t: number): number {
  // segments are sorted by start — binary search the one covering t.
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (t < s.startSec) hi = mid - 1;
    else if (t >= s.endSec) lo = mid + 1;
    else return s.rootPc < 0 || s.quality === "N" ? -1 : s.bassPc != null && s.bassPc >= 0 ? s.bassPc : s.rootPc;
  }
  return -1;
}

/** The transcribed note with the largest overlap with [t0, t1), or null. */
function soundingNote(notes: TranscribedBassNote[], t0: number, t1: number): TranscribedBassNote | null {
  let best: TranscribedBassNote | null = null;
  let bestOv = 0;
  for (const n of notes) {
    const ov = Math.min(n.startSec + n.durSec, t1) - Math.max(n.startSec, t0);
    if (ov > bestOv) {
      bestOv = ov;
      best = n;
    }
  }
  if (!best) return null;
  const span = Math.min(best.durSec, t1 - t0);
  return bestOv >= 0.5 * span && best.durSec >= 0.08 ? best : null;
}

/** Place `midi` on the instrument: same string if it fits, else the closest position. */
function place(
  midi: number,
  string: number,
  fret: number,
  tuning: number[],
  maxFret: number,
): { string: number; fret: number } | null {
  const same = midi - tuning[string];
  if (same >= 0 && same <= maxFret) return { string, fret: same };
  let best: { string: number; fret: number } | null = null;
  let bestD = Infinity;
  for (let s = 0; s < tuning.length; s++) {
    const f = midi - tuning[s];
    if (f < 0 || f > maxFret) continue;
    const d = Math.abs(f - fret) + Math.abs(s - string) * 2;
    if (d < bestD) {
      bestD = d;
      best = { string: s, fret: f };
    }
  }
  return best;
}

export function fixBassWithAudio(
  track: SongsterrTrack,
  notes: TranscribedBassNote[],
  segs: ChordSegment[],
  points: SyncAnchor[] | null,
): FixResult {
  const measures = track.measures ?? [];
  const starts = barStartTimes(points, measures.length);
  const tuning = (track.tuning ?? []).filter((n) => Number.isFinite(n));
  if (!starts || !tuning.length || !notes.length || !segs.length) return { track, fixed: 0, bars: [] };
  const maxFret = typeof track.frets === "number" && track.frets > 0 ? track.frets : 20;
  const lowest = Math.min(...tuning);
  const highest = Math.max(...tuning) + maxFret;
  const sorted = [...segs].sort((a, b) => a.startSec - b.startSec);
  let fixed = 0;
  const bars: number[] = [];
  let tsNum = 4;
  let tsDen = 4;

  const out = measures.map((m, b) => {
    const sig = m.signature;
    if (Array.isArray(sig) && sig.length === 2 && sig[0] && sig[1]) {
      tsNum = sig[0];
      tsDen = sig[1];
    }
    const barWhole = tsNum / tsDen;
    const t0 = starts[b];
    const t1 = starts[b + 1];
    if (!(t1 > t0)) return m;
    let touched = false;
    const voices = (m.voices ?? []).map((v) => {
      let cum = 0;
      const beats = (v.beats ?? []).map((beat): SongsterrBeat => {
        const dw = durWhole(beat);
        const f0 = cum / barWhole;
        const f1 = (cum + dw) / barWhole;
        cum += dw;
        const ns = beat.notes;
        if (beat.rest || !Array.isArray(ns) || ns.length !== 1) return beat;
        const n = ns[0];
        if (n.tie || n.dead || n.ghost) return beat;
        const open = tuning[n.string];
        if (typeof open !== "number" || !Number.isFinite(n.fret)) return beat;
        const bt0 = t0 + f0 * (t1 - t0);
        const bt1 = t0 + f1 * (t1 - t0);
        const heard = soundingNote(notes, bt0, bt1);
        if (!heard) return beat;
        const heardPc = ((heard.midi % 12) + 12) % 12;
        const tabPc = (((open + n.fret) % 12) + 12) % 12;
        if (heardPc === tabPc) return beat;
        const chordPc = chordBassPcAt(sorted, bt0 + 0.25 * (bt1 - bt0));
        if (chordPc !== heardPc) return beat; // the two signals must agree
        // Bring the heard note into the instrument's range, then place it.
        let midi = heard.midi;
        while (midi < lowest) midi += 12;
        while (midi > highest) midi -= 12;
        const pos = place(midi, n.string, n.fret, tuning, maxFret);
        if (!pos) return beat;
        fixed++;
        touched = true;
        return { ...beat, notes: [{ ...n, string: pos.string, fret: pos.fret }] };
      });
      return { ...v, beats };
    });
    if (touched) bars.push(b);
    return { ...m, voices };
  });
  return { track: fixed ? { ...track, measures: out } : track, fixed, bars };
}
