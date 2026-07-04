/**
 * Chord voicings for diagrams. Frets are absolute (0 = open, -1 = muted).
 * Common first-position shapes are hand-curated; everything else falls back to
 * movable barre shapes so every maj/min chord resolves to a valid voicing.
 */

export type Quality = "maj" | "min";

/**
 * Reduce any of the 14 large-vocabulary qualities to the closest triad the
 * diagrams can draw. The "Now playing" label still shows the full quality
 * (e.g. Cmaj7); only the fretboard/piano shape is the base triad.
 */
export function baseTriad(quality: string | undefined): Quality {
  switch (quality) {
    case "min":
    case "min6":
    case "min7":
    case "minmaj7":
    case "dim":
    case "dim7":
    case "hdim7":
      return "min";
    default: // maj, maj6, maj7, dom7, aug, sus2, sus4, …
      return "maj";
  }
}

export interface FretVoicing {
  /** Fret per string, low→high. 0 = open, -1 = muted. */
  frets: number[];
  /** Open-string tuning pitch classes, low→high (for labeling). */
  tuning: number[];
}

// ---------------------------------------------------------------- Guitar -----
// Standard tuning EADGBE (pitch classes), low→high.
const GUITAR_TUNING = [4, 9, 2, 7, 11, 4];

// Curated open/first-position shapes keyed by "<root> <quality>".
const GUITAR_OPEN: Record<string, number[]> = {
  "0 maj": [-1, 3, 2, 0, 1, 0], // C
  "2 maj": [-1, -1, 0, 2, 3, 2], // D
  "4 maj": [0, 2, 2, 1, 0, 0], // E
  "5 maj": [1, 3, 3, 2, 1, 1], // F (barre)
  "7 maj": [3, 2, 0, 0, 0, 3], // G
  "9 maj": [-1, 0, 2, 2, 2, 0], // A
  "11 maj": [-1, 2, 4, 4, 4, 2], // B (barre)
  "2 min": [-1, -1, 0, 2, 3, 1], // Dm
  "4 min": [0, 2, 2, 0, 0, 0], // Em
  "9 min": [-1, 0, 2, 2, 1, 0], // Am
};

// Movable barre shapes (semitone offsets from the barre fret; -1 = muted).
const E_SHAPE_MAJ = [0, 2, 2, 1, 0, 0];
const A_SHAPE_MAJ = [-1, 0, 2, 2, 2, 0];
const E_SHAPE_MIN = [0, 2, 2, 0, 0, 0];
const A_SHAPE_MIN = [-1, 0, 2, 2, 1, 0];

function applyBarre(shape: number[], fret: number): number[] {
  return shape.map((o) => (o < 0 ? -1 : o + fret));
}

export function guitarVoicing(rootPc: number, quality: Quality): FretVoicing {
  const key = `${((rootPc % 12) + 12) % 12} ${quality}`;
  if (GUITAR_OPEN[key]) {
    return { frets: GUITAR_OPEN[key], tuning: GUITAR_TUNING };
  }
  const eMaj = quality === "maj" ? E_SHAPE_MAJ : E_SHAPE_MIN;
  const aMaj = quality === "maj" ? A_SHAPE_MAJ : A_SHAPE_MIN;
  const eFret = (((rootPc - 4) % 12) + 12) % 12 || 12; // avoid 0 → use 12 (octave)
  const aFret = (((rootPc - 9) % 12) + 12) % 12 || 12;
  const eVoicing = applyBarre(eMaj, eFret);
  const aVoicing = applyBarre(aMaj, aFret);
  // Prefer the lower-position (more playable) shape.
  const frets = eFret <= aFret ? eVoicing : aVoicing;
  return { frets, tuning: GUITAR_TUNING };
}

// --------------------------------------------------------------- Ukulele -----
// Standard reentrant tuning GCEA.
const UKE_TUNING = [7, 0, 4, 9];

const UKE_OPEN: Record<string, number[]> = {
  "0 maj": [0, 0, 0, 3], // C
  "2 maj": [2, 2, 2, 0], // D
  "4 maj": [4, 4, 4, 2], // E
  "5 maj": [2, 0, 1, 0], // F
  "7 maj": [0, 2, 3, 2], // G
  "9 maj": [2, 1, 0, 0], // A
  "0 min": [0, 3, 3, 3], // Cm
  "2 min": [2, 2, 1, 0], // Dm
  "4 min": [0, 4, 3, 2], // Em
  "5 min": [1, 0, 1, 3], // Fm
  "7 min": [0, 2, 3, 1], // Gm
  "9 min": [2, 0, 0, 0], // Am
};

export function ukuleleVoicing(rootPc: number, quality: Quality): FretVoicing {
  const pc = ((rootPc % 12) + 12) % 12;
  const key = `${pc} ${quality}`;
  if (UKE_OPEN[key]) return { frets: UKE_OPEN[key], tuning: UKE_TUNING };
  // Movable A-shape: major 2-1-0-0, minor 2-0-0-0 (root on the G string).
  const n = (((pc - 9) % 12) + 12) % 12 || 12;
  const shape = quality === "maj" ? [2, 1, 0, 0] : [2, 0, 0, 0];
  return { frets: shape.map((o) => o + n), tuning: UKE_TUNING };
}

// ----------------------------------------------------------------- Piano -----
export interface PianoChord {
  /** Pitch classes to highlight (0–11). */
  notes: number[];
  rootPc: number;
}

export function pianoChord(rootPc: number, quality: Quality): PianoChord {
  const r = ((rootPc % 12) + 12) % 12;
  const third = quality === "maj" ? 4 : 3;
  return { notes: [r, (r + third) % 12, (r + 7) % 12], rootPc: r };
}
