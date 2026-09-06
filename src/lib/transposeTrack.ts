/**
 * Transpose a Songsterr track by a number of semitones so its notes sound in the
 * RECORDING's key. The audio cross-validation (tabMatch) already detects the
 * offset (a pitch-shifted YouTube upload, a tab written in standard tuning for
 * an Eb-tuned record, a capo the tab doesn't mention); this turns that number
 * into playable fret positions instead of leaving it in a tooltip.
 *
 * Notes are re-fretted on the SAME string when the shifted fret is still on the
 * neck; otherwise the closest position on another string is used (never two
 * notes of one beat on one string). A note that cannot go any lower (an open
 * low string shifted down) is kept as written — the honest fix there is to tune
 * down, which the UI hint says.
 */
import type { SongsterrBeat, SongsterrMeasure, SongsterrTrack } from "./types";

const ROOTS_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROOTS_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const ROOT_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8,
  Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11, "E#": 5, Fb: 4, "B#": 0,
};

/** Transpose a chord symbol ("Am7", "Bb", "C/G") — keeps the accidental style. */
export function transposeChordName(text: string, semitones: number): string {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(text.trim());
  if (!m) return text;
  const flats = /b/.test(m[1]) || (m[3] ? /b/.test(m[3]) : false);
  const names = flats ? ROOTS_FLAT : ROOTS_SHARP;
  const shift = (name: string) => {
    const pc = ROOT_PC[name];
    return pc === undefined ? name : names[(((pc + semitones) % 12) + 12) % 12];
  };
  return `${shift(m[1])}${m[2]}${m[3] ? `/${shift(m[3])}` : ""}`;
}

function transposeBeat(
  beat: SongsterrBeat,
  tuning: number[],
  maxFret: number,
  semitones: number,
): SongsterrBeat {
  const notes = beat.notes;
  const out: SongsterrBeat = { ...beat };
  if (typeof beat.chord?.text === "string" && beat.chord.text) {
    out.chord = { ...beat.chord, text: transposeChordName(beat.chord.text, semitones) };
  }
  if (!Array.isArray(notes) || notes.length === 0) return out;

  const used = new Set<number>();
  const placed = notes.map((n) => {
    const open = tuning[n.string];
    if (typeof open !== "number" || !Number.isFinite(n.fret)) return { ...n };
    const target = open + n.fret + semitones;
    // Same string first.
    const sameFret = n.fret + semitones;
    if (sameFret >= 0 && sameFret <= maxFret && !used.has(n.string)) {
      used.add(n.string);
      return { ...n, fret: sameFret };
    }
    // Else the closest position on any free string.
    let best: { string: number; fret: number } | null = null;
    for (let s = 0; s < tuning.length; s++) {
      if (used.has(s)) continue;
      const f = target - tuning[s];
      if (f < 0 || f > maxFret) continue;
      const dist = Math.abs(f - n.fret) + Math.abs(s - n.string) * 2;
      if (!best || dist < Math.abs(best.fret - n.fret) + Math.abs(best.string - n.string) * 2) {
        best = { string: s, fret: f };
      }
    }
    if (best) {
      used.add(best.string);
      return { ...n, string: best.string, fret: best.fret };
    }
    used.add(n.string);
    return { ...n }; // unplayable (below the lowest open string) — keep as written
  });
  out.notes = placed;
  return out;
}

/** A transposed copy of `track` (the input is never mutated). 0 → the same object. */
export function transposeTrack(track: SongsterrTrack, semitones: number): SongsterrTrack {
  if (!semitones || !track) return track;
  const tuning = (track.tuning ?? []).filter((n) => Number.isFinite(n));
  if (tuning.length === 0) return track;
  const maxFret = typeof track.frets === "number" && track.frets > 0 ? track.frets : 24;
  const measures: SongsterrMeasure[] = (track.measures ?? []).map((m) => ({
    ...m,
    voices: (m.voices ?? []).map((v) => ({
      ...v,
      beats: (v.beats ?? []).map((b) => transposeBeat(b, tuning, maxFret, semitones)),
    })),
  }));
  return { ...track, measures };
}

/** Signed semitone offset (audio − tab) from a 0..11 circular shift: 11 → −1. */
export function signedShift(shift: number): number {
  const s = ((Math.round(shift) % 12) + 12) % 12;
  return s > 6 ? s - 12 : s;
}
