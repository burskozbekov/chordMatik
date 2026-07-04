/**
 * Synthesize the Songsterr tab into a per-frame pitch-class histogram on the same
 * ~93 ms grid as the recording's CQT, plus each bar's start frame. This is the
 * symbolic side of the Phase-B chroma alignment; the Rust side runs the IDENTICAL
 * CENS pipeline on these raw histograms and on the audio chroma, then DTW-aligns
 * them. Timing matches songsterrToScore.ts (duration [num,den] = whole-note
 * fraction with dots baked in; tempo from automations; bar length = time signature).
 */
import type { SongsterrBeat, SongsterrTrack } from "./types";

/** CQT hop / sample rate — MUST equal the Rust cqt.hop_seconds() (2048/22050). */
export const HOP_SECONDS = 2048 / 22050;

export interface TabSynth {
  /** [totalFrames][12] raw (un-normalized) pitch-class energy. */
  frames: number[][];
  /** Frame index at which each bar (master bar) begins. */
  barStartFrame: number[];
}

const dotMult = (d: number) => 1 + (d >= 1 ? 0.5 : 0) + (d >= 2 ? 0.25 : 0);

/** Beat length in whole notes. */
function durWhole(beat: SongsterrBeat): number {
  const d = beat.duration;
  if (Array.isArray(d) && d.length >= 2 && d[0] > 0 && d[1] > 0) return d[0] / d[1];
  return 0.25 * dotMult(beat.dots ?? 0);
}

export function synthTabFrames(track: SongsterrTrack, hopSeconds = HOP_SECONDS): TabSynth {
  const tuning = (track.tuning ?? []).filter((n) => Number.isFinite(n));
  const measures = track.measures ?? [];

  const tempoByMeasure = new Map<number, number>();
  for (const a of track.automations?.tempo ?? []) {
    if (typeof a?.measure === "number" && typeof a?.bpm === "number" && a.bpm > 0) {
      tempoByMeasure.set(a.measure, a.bpm);
    }
  }
  let curTempo = track.automations?.tempo?.[0]?.bpm ?? 120;

  // Pass 1: bar starts + every sounding note as (pc, onsetSec, endSec).
  const notes: Array<{ pc: number; onset: number; end: number }> = [];
  const barStartSec: number[] = [];
  let tSec = 0;
  let tsNum = 4;
  let tsDen = 4;
  for (let i = 0; i < measures.length; i++) {
    if (tempoByMeasure.has(i)) curTempo = tempoByMeasure.get(i) ?? curTempo;
    const m = measures[i];
    const sig = m?.signature;
    if (Array.isArray(sig) && sig.length === 2 && sig[0] && sig[1]) {
      tsNum = sig[0];
      tsDen = sig[1];
    }
    const spw = 240 / curTempo; // seconds per whole note (tempo = quarter-notes/min)
    barStartSec[i] = tSec;
    for (const voice of m?.voices ?? []) {
      let cum = 0;
      for (const beat of voice?.beats ?? []) {
        const dw = durWhole(beat);
        const onset = tSec + cum * spw;
        if (!beat.rest) {
          for (const note of beat.notes ?? []) {
            const open = tuning[note.string];
            if (typeof open !== "number") continue;
            const pc = (((open + note.fret) % 12) + 12) % 12;
            notes.push({ pc, onset, end: onset + dw * spw });
          }
        }
        cum += dw;
      }
    }
    tSec += (tsNum / tsDen) * spw; // bar length = time signature
  }

  const totalFrames = Math.max(1, Math.ceil(tSec / hopSeconds) + 1);
  const frames: number[][] = Array.from({ length: totalFrames }, () => new Array(12).fill(0));
  for (const nt of notes) {
    const f0 = Math.max(0, Math.floor(nt.onset / hopSeconds));
    const f1 = Math.min(totalFrames - 1, Math.ceil(nt.end / hopSeconds));
    for (let f = f0; f <= f1; f++) frames[f][nt.pc] += 1;
  }
  const barStartFrame = barStartSec.map((s) => Math.round(s / hopSeconds));
  return { frames, barStartFrame };
}
