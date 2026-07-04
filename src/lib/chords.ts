/** Chord-label helpers: transpose, capo, and display formatting. */
import type { ChordSegment } from "./types";

export const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export function transposePc(pc: number, semitones: number): number {
  return (((pc + semitones) % 12) + 12) % 12;
}

export interface DisplayChord {
  /** e.g. "C", "G#m", "Cmaj7", or "—" for no-chord. */
  label: string;
  rootName: string;
  rootPc: number;
  quality: string;
  isNoChord: boolean;
}

/** Quality → display suffix. Kept in sync with the Rust `chords::QUALITIES`. */
const QUALITY_SUFFIX: Record<string, string> = {
  maj: "",
  min: "m",
  dim: "dim",
  aug: "aug",
  min6: "m6",
  maj6: "6",
  min7: "m7",
  minmaj7: "mM7",
  maj7: "maj7",
  dom7: "7",
  dim7: "dim7",
  hdim7: "m7b5",
  sus2: "sus2",
  sus4: "sus4",
};

/**
 * Resolve a segment to a display chord after applying a transpose (in
 * semitones). `useFlats` picks the accidental spelling.
 */
export function chordDisplay(
  seg: Pick<ChordSegment, "rootPc" | "quality"> & { bassPc?: number },
  semitones = 0,
  useFlats = false,
): DisplayChord {
  if (seg.rootPc < 0 || seg.quality === "N") {
    return { label: "—", rootName: "—", rootPc: -1, quality: "N", isNoChord: true };
  }
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  const pc = transposePc(seg.rootPc, semitones);
  const rootName = names[pc];
  const suffix = QUALITY_SUFFIX[seg.quality] ?? (seg.quality === "min" ? "m" : "");
  let label = rootName + suffix;
  // Slash chord (inversion): append "/bass", transposed by the same amount.
  if (seg.bassPc != null && seg.bassPc >= 0) {
    const bpc = transposePc(seg.bassPc, semitones);
    if (bpc !== pc) label += `/${names[bpc]}`;
  }
  return { label, rootName, rootPc: pc, quality: seg.quality, isNoChord: false };
}

/** Pretty ± semitone label, e.g. 0 → "0", 2 → "+2", -3 → "−3". */
export function formatSemitones(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}
