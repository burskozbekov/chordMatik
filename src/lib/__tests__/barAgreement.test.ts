import { describe, expect, it } from "vitest";
import { audioPitchWeights, barAgreement, barStartTimes } from "../barAgreement";
import type { SyncAnchor } from "../tabSync";
import type { ChordSegment, SongsterrTrack } from "../types";

const BASS = [43, 38, 33, 28]; // G D A E (Songsterr order: string 0 = highest)
const anchor = (barIndex: number, sec: number): SyncAnchor => ({
  barIndex,
  barPosition: 0,
  barOccurence: 0,
  millisecondOffset: sec * 1000,
});
const seg = (rootPc: number, startSec: number, endSec: number, quality = "maj"): ChordSegment =>
  ({ rootPc, quality, label: "x", startSec, endSec, index: 0 }) as ChordSegment;
/** A bass bar of four quarter notes (string 3 = low E) at the given MIDI pitches. */
const bar = (midis: number[]) => ({
  voices: [
    {
      beats: midis.map((m) => ({ notes: [{ string: 3, fret: m - BASS[3] }], duration: [1, 4] as [number, number] })),
    },
  ],
});
const track = (bars: unknown[]): SongsterrTrack =>
  ({ tuning: BASS, measures: bars.map((b, i) => (i === 0 ? { ...(b as object), signature: [4, 4] } : b)) }) as SongsterrTrack;

describe("barStartTimes", () => {
  it("interpolates between anchors and extrapolates outside them", () => {
    const t = barStartTimes([anchor(1, 2), anchor(3, 6)], 6)!;
    expect(t[1]).toBe(2);
    expect(t[2]).toBe(4);
    expect(t[3]).toBe(6);
    expect(t[0]).toBe(0); // one mean bar (2 s) before bar 1
    expect(t[5]).toBe(10);
  });
  it("needs two anchors", () => {
    expect(barStartTimes([anchor(0, 1)], 4)).toBeNull();
    expect(barStartTimes(null, 4)).toBeNull();
  });
});

describe("audioPitchWeights", () => {
  it("weights chord tones by the seconds they sound in the window", () => {
    const w = audioPitchWeights([seg(0, 0, 1), seg(7, 1, 3)], 0.5, 2.5); // C for 0.5 s, G for 1.5 s
    expect(w[0]).toBeCloseTo(0.5); // C: only in the C chord
    expect(w[7]).toBeCloseTo(2.0); // G: fifth of C (0.5) + root of G (1.5)
    expect(w[11]).toBeCloseTo(1.5); // B: third of G
    expect(w[1]).toBe(0);
  });
});

describe("barAgreement", () => {
  // 4 bars, 2 s each from t=0: C C G G. Bass tab: roots in bars 0,1,3; a wrong bar 2.
  const segs = [seg(0, 0, 4), seg(7, 4, 8)];
  const points = [anchor(0, 0), anchor(1, 2), anchor(2, 4), anchor(3, 6)];
  const C2 = 36;
  const G2 = 43;
  const Db2 = 37;

  it("scores chord-tone bars 1 and a wrong bar 0", () => {
    const t = track([bar([C2, C2, C2, C2]), bar([C2, 40, C2, 43]), bar([Db2, Db2, Db2, Db2]), bar([G2, G2, G2, G2])]);
    const s = barAgreement(segs, t, points);
    expect(s[0]).toBe(1);
    expect(s[1]).toBe(1); // E and G are chord tones of C
    expect(s[2]).toBe(0); // Db against G major
    expect(s[3]).toBe(1);
  });

  it("gives partial credit and no verdict for rests / no-chord spans", () => {
    const t = track([bar([C2, Db2, C2, Db2]), { voices: [{ beats: [{ rest: true, duration: [1, 1] }] }] }, bar([G2, G2, G2, G2]), bar([G2, G2, G2, G2])]);
    const s = barAgreement(segs, t, points);
    expect(s[0]).toBeCloseTo(0.5);
    expect(s[1]).toBeNull(); // rest bar
    // No chord in the recording during bar 3 → no verdict.
    const s2 = barAgreement([seg(0, 0, 4), seg(7, 4, 6), seg(-1, 6, 8, "N")], t, points);
    expect(s2[3]).toBeNull();
    expect(s2[2]).toBe(1);
  });

  it("returns all-null without anchors", () => {
    const t = track([bar([C2, C2, C2, C2])]);
    expect(barAgreement(segs, t, null)).toEqual([null]);
  });
});
