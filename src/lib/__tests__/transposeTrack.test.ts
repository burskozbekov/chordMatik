import { describe, expect, it } from "vitest";
import { signedShift, transposeChordName, transposeTrack } from "../transposeTrack";
import type { SongsterrTrack } from "../types";

const GUITAR = [64, 59, 55, 50, 45, 40]; // Songsterr order: string 0 = high E

function track(beats: { string: number; fret: number }[][], tuning = GUITAR): SongsterrTrack {
  return {
    tuning,
    measures: [{ voices: [{ beats: beats.map((notes) => ({ notes, duration: [1, 4] as [number, number] })) }] }],
  };
}
const notesOf = (t: SongsterrTrack) =>
  t.measures![0].voices![0].beats!.map((b) => (b.notes ?? []).map((n) => [n.string, n.fret]));
const midi = (t: SongsterrTrack, s: number, f: number) => t.tuning![s] + f;

describe("signedShift", () => {
  it("maps the circular OTI shift to a signed semitone offset", () => {
    expect(signedShift(0)).toBe(0);
    expect(signedShift(1)).toBe(1);
    expect(signedShift(11)).toBe(-1);
    expect(signedShift(6)).toBe(6);
    expect(signedShift(7)).toBe(-5);
  });
});

describe("transposeTrack", () => {
  it("returns the same object for 0 and never mutates the input", () => {
    const t = track([[{ string: 0, fret: 3 }]]);
    expect(transposeTrack(t, 0)).toBe(t);
    const up = transposeTrack(t, 2);
    expect(notesOf(t)).toEqual([[[0, 3]]]);
    expect(notesOf(up)).toEqual([[[0, 5]]]);
  });

  it("keeps the same string when the shifted fret is on the neck", () => {
    const t = track([[{ string: 5, fret: 3 }]]); // G on low E
    expect(notesOf(transposeTrack(t, -1))).toEqual([[[5, 2]]]);
    expect(notesOf(transposeTrack(t, 12))).toEqual([[[5, 15]]]);
  });

  it("moves to the closest other string when the fret would go negative, keeping the pitch", () => {
    const t = track([[{ string: 4, fret: 0 }]]); // open A
    const down = transposeTrack(t, -1); // G# → low E string fret 4
    const [[[s, f]]] = notesOf(down);
    expect(midi(down, s, f)).toBe(midi(t, 4, 0) - 1);
    expect(s).toBe(5);
    expect(f).toBe(4);
  });

  it("keeps a note that cannot go lower (open low E shifted down)", () => {
    const t = track([[{ string: 5, fret: 0 }]]);
    expect(notesOf(transposeTrack(t, -1))).toEqual([[[5, 0]]]);
  });

  it("never puts two notes of one beat on the same string", () => {
    // Open D (string 3) and A-string fret 0 → shift −1: D→C# would move to the A
    // string (fret 4) but the A note itself moves to E-string fret 4 first.
    const t = track([[{ string: 4, fret: 0 }, { string: 3, fret: 0 }]]);
    const down = transposeTrack(t, -1);
    const strings = notesOf(down)[0].map(([s]) => s);
    expect(new Set(strings).size).toBe(2);
    for (const [s, f] of notesOf(down)[0]) {
      expect([midi(t, 4, 0) - 1, midi(t, 3, 0) - 1]).toContain(midi(down, s, f));
    }
  });

  it("transposes chord symbols and keeps the accidental style", () => {
    expect(transposeChordName("Am7", 2)).toBe("Bm7");
    expect(transposeChordName("Bb", -1)).toBe("A");
    expect(transposeChordName("Eb", 1)).toBe("E");
    expect(transposeChordName("C/G", -1)).toBe("B/F#");
    expect(transposeChordName("Db/F", 1)).toBe("D/Gb");
    expect(transposeChordName("N.C.", 3)).toBe("N.C.");
  });

  it("works for a 4-string bass tuning", () => {
    const t = track([[{ string: 3, fret: 3 }]], [43, 38, 33, 28]); // G on low E
    expect(notesOf(transposeTrack(t, -1))).toEqual([[[3, 2]]]);
  });
});
