import type { ChordSegment, SongsterrBeat, SongsterrMeasure, SongsterrTrack } from "./types";

// 4-string bass, high→low. pitch(MIDI) = BASS_TUNING[songsterrString] + fret.
export const BASS_TUNING = [43, 38, 33, 28]; // G2 D2 A1 E1
const MAX_FRET = 20;

/** Lowest bass-register MIDI (at/above the low-E string, 28) for a pitch class. */
function bassMidi(pc: number): number {
  let m = (((pc % 12) + 12) % 12) + 24; // C1 octave (24..35)
  while (m < 28) m += 12; // raise to the open low-E string
  return m; // 28..39
}

interface Fretting {
  string: number;
  fret: number;
}

/**
 * Fret a MIDI sequence on the bass via shortest-path DP: minimise hand movement
 * (string + fret distance) while preferring low frets. Standard optimal-tablature
 * formulation — keeps the line playable instead of jumping all over the neck.
 */
export function assignFrets(midis: number[]): Fretting[] {
  const cands: Fretting[][] = midis.map((m) => {
    const c: Fretting[] = [];
    for (let s = 0; s < 4; s++) {
      const fret = m - BASS_TUNING[s];
      if (fret >= 0 && fret <= MAX_FRET) c.push({ string: s, fret });
    }
    return c.length ? c : [{ string: 3, fret: Math.max(0, Math.min(MAX_FRET, m - BASS_TUNING[3])) }];
  });
  const n = cands.length;
  if (n === 0) return [];
  const cost = cands.map((cs) => cs.map(() => Infinity));
  const back = cands.map((cs) => cs.map(() => 0));
  cands[0].forEach((c, j) => (cost[0][j] = c.fret / 24));
  for (let i = 1; i < n; i++) {
    cands[i].forEach((cur, j) => {
      cands[i - 1].forEach((prev, k) => {
        const trans = Math.abs(cur.fret - prev.fret) * 0.15 + Math.abs(cur.string - prev.string) * 0.5;
        const c = cost[i - 1][k] + trans + cur.fret / 24;
        if (c < cost[i][j]) {
          cost[i][j] = c;
          back[i][j] = k;
        }
      });
    });
  }
  let best = 0;
  cost[n - 1].forEach((c, j) => {
    if (c < cost[n - 1][best]) best = j;
  });
  const out: Fretting[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = cands[i][best];
    best = back[i][best];
  }
  return out;
}

/**
 * Generate a playable bass tab straight from the detected chords — the bass plays
 * each chord's bass note (the detected inversion bass `bassPc`, else the root)
 * once per beat. Because we always have chords, this gives a musically-correct
 * bass line for ANY song, covering the (many) songs Songsterr lacks or mismatches.
 * Returns a `SongsterrTrack` so the existing converter + renderer are reused.
 */
export function bassFromChords(
  segments: ChordSegment[],
  bpm: number,
  startSec: number,
  beatsPerBar = 4,
): SongsterrTrack | null {
  if (!segments?.length || !(bpm > 0)) return null;
  const spb = 60 / bpm;
  const endSec = segments[segments.length - 1].endSec;
  if (!(endSec > startSec)) return null;

  // One slot per beat from bar 1: the active chord's bass pitch class, or rest.
  const slots: (number | null)[] = [];
  for (let t = Math.max(0, startSec); t < endSec && slots.length < 4096; t += spb) {
    const seg = segments.find((s) => t >= s.startSec && t < s.endSec);
    if (!seg || seg.rootPc < 0 || seg.quality === "N") {
      slots.push(null);
      continue;
    }
    slots.push(typeof seg.bassPc === "number" && seg.bassPc >= 0 ? seg.bassPc : seg.rootPc);
  }
  if (!slots.some((s) => s !== null)) return null;

  // Fret the sounding beats (rests excluded), remembering their slot positions.
  const sounding = slots
    .map((pc, i) => ({ pc, i }))
    .filter((x): x is { pc: number; i: number } => x.pc !== null);
  const frets = assignFrets(sounding.map((x) => bassMidi(x.pc)));
  const fretBySlot = new Map<number, Fretting>();
  sounding.forEach((x, k) => fretBySlot.set(x.i, frets[k]));

  const q: [number, number] = [1, 4]; // a quarter note per beat
  const measures = [];
  for (let i = 0; i < slots.length; i += beatsPerBar) {
    const beats = [];
    for (let b = i; b < i + beatsPerBar && b < slots.length; b++) {
      const fr = fretBySlot.get(b);
      beats.push(
        fr
          ? { notes: [{ string: fr.string, fret: fr.fret }], duration: q }
          : { rest: true, duration: q },
      );
    }
    measures.push({ voices: [{ beats }], signature: [beatsPerBar, 4] as [number, number] });
  }

  return {
    name: "chordMatik bass",
    instrument: "Bass",
    instrumentId: 33,
    tuning: BASS_TUNING,
    strings: 4,
    measures,
    automations: { tempo: [{ measure: 0, bpm }] },
  };
}

export interface TranscribedNote {
  startSec: number;
  durSec: number;
  midi: number;
}

const NOTE_VALUES = [8, 6, 4, 3, 2, 1]; // exact note durations in 8th-note units

/**
 * Quantize REAL transcribed bass notes (from basic-pitch) onto the song's beat
 * grid and build a tab. Samples an 8th-note grid for the sounding note, run-length
 * encodes, splits each run at bar lines + into exact note values, and frets via the
 * same shortest-path DP. Returns a `SongsterrTrack` the existing renderer reuses.
 */
export function bassFromTranscription(
  notes: TranscribedNote[],
  bpm: number,
  startSec: number,
  beatsPerBar = 4,
): SongsterrTrack | null {
  if (!notes?.length || !(bpm > 0)) return null;
  const spb = 60 / bpm;
  const slotDur = spb / 2; // an 8th note
  const slotsPerBar = beatsPerBar * 2;
  const bar1 = Math.max(0, startSec);
  const lastEnd = Math.max(...notes.map((n) => n.startSec + n.durSec));
  if (!(lastEnd > bar1)) return null;

  // The bass MIDI sounding at each 8th-note slot (sampled near its start), or null.
  const slots: (number | null)[] = [];
  for (let t = bar1; t < lastEnd && slots.length < 8192; t += slotDur) {
    const tm = t + slotDur * 0.4;
    let midi: number | null = null;
    for (const n of notes) {
      if (tm >= n.startSec && tm < n.startSec + n.durSec) {
        midi = n.midi;
        break;
      }
    }
    slots.push(midi);
  }
  if (!slots.some((s) => s !== null)) return null;

  // Run-length encode, then fret the note runs as one movement-minimizing sequence.
  interface Seg {
    midi: number | null;
    len: number;
    fret?: Fretting;
  }
  const segs: Seg[] = [];
  for (let i = 0; i < slots.length; ) {
    const m = slots[i];
    let len = 1;
    while (i + len < slots.length && slots[i + len] === m) len++;
    segs.push({ midi: m, len });
    i += len;
  }
  const noteSegs = segs.filter((s) => s.midi !== null);
  const frets = assignFrets(noteSegs.map((s) => s.midi as number));
  noteSegs.forEach((s, k) => (s.fret = frets[k]));

  // Build measures: split each run at bar lines, then into exact note values.
  const measures: SongsterrMeasure[] = [];
  let beats: SongsterrBeat[] = [];
  let inBar = 0;
  const flush = () => {
    measures.push({ voices: [{ beats }], signature: [beatsPerBar, 4] });
    beats = [];
    inBar = 0;
  };
  for (const s of segs) {
    let rem = s.len;
    while (rem > 0) {
      const take = Math.min(rem, slotsPerBar - inBar);
      for (let chunk = take; chunk > 0; ) {
        const v = NOTE_VALUES.find((x) => x <= chunk) ?? 1;
        const duration: [number, number] = [v, 8];
        beats.push(
          s.midi === null || !s.fret
            ? { rest: true, duration }
            : { notes: [{ string: s.fret.string, fret: s.fret.fret }], duration },
        );
        chunk -= v;
      }
      inBar += take;
      rem -= take;
      if (inBar >= slotsPerBar) flush();
    }
  }
  // Pad the final partial bar with rest(s) so every measure is complete.
  if (beats.length) {
    let pad = slotsPerBar - inBar;
    while (pad > 0) {
      const v = NOTE_VALUES.find((x) => x <= pad) ?? 1;
      beats.push({ rest: true, duration: [v, 8] });
      pad -= v;
    }
    flush();
  }

  return {
    name: "chordMatik AI bass",
    instrument: "Bass",
    instrumentId: 33,
    tuning: BASS_TUNING,
    strings: 4,
    measures,
    automations: { tempo: [{ measure: 0, bpm }] },
  };
}
