import { describe, expect, it } from "vitest";
import { fixBassWithAudio } from "../fixBassWithAudio";
import type { SyncAnchor } from "../tabSync";
import type { ChordSegment, SongsterrTrack } from "../types";

const BASS = [43, 38, 33, 28];
const anchor = (barIndex: number, sec: number): SyncAnchor => ({
  barIndex,
  barPosition: 0,
  barOccurence: 0,
  millisecondOffset: sec * 1000,
});
const seg = (rootPc: number, startSec: number, endSec: number, bassPc = -1): ChordSegment =>
  ({ rootPc, quality: "maj", label: "x", startSec, endSec, bassPc, index: 0 }) as ChordSegment;
const bar = (midis: number[]) => ({
  voices: [{ beats: midis.map((m) => ({ notes: [{ string: 3, fret: m - BASS[3] }], duration: [1, 4] as [number, number] })) }],
});
const track = (bars: unknown[]): SongsterrTrack =>
  ({ tuning: BASS, frets: 20, measures: bars.map((b, i) => (i === 0 ? { ...(b as object), signature: [4, 4] } : b)) }) as SongsterrTrack;
const midiOf = (t: SongsterrTrack, b: number, beat: number) => {
  const n = t.measures![b].voices![0].beats![beat].notes![0];
  return t.tuning![n.string] + n.fret;
};
const points = [anchor(0, 0), anchor(1, 2), anchor(2, 4)]; // 2 s bars from 0
const note = (startSec: number, durSec: number, midi: number) => ({ startSec, durSec, midi });
const C2 = 36;
const G2 = 43;
const E2 = 40;

describe("fixBassWithAudio", () => {
  it("replaces a note that BOTH the transcription and the chord contradict", () => {
    // Bar 0 is C major; the tab plays G2 on beat 3 but the recording (and the chord's
    // bass, C) say C2 there.
    const t = track([bar([C2, C2, G2, C2]), bar([G2, G2, G2, G2])]);
    const heard = [note(0, 2, C2), note(2, 2, G2)];
    const r = fixBassWithAudio(t, heard, [seg(0, 0, 2), seg(7, 2, 4)], points);
    expect(r.fixed).toBe(1);
    expect(r.bars).toEqual([0]);
    expect(midiOf(r.track, 0, 2)).toBe(C2);
    expect(midiOf(r.track, 0, 0)).toBe(C2); // untouched
    expect(midiOf(t, 0, 2)).toBe(G2); // input not mutated
  });

  it("leaves a note alone when only ONE signal disagrees", () => {
    const t = track([bar([C2, C2, G2, C2])]);
    // Transcription hears E2 on beat 3, but the chord's bass is C → no fix.
    expect(fixBassWithAudio(t, [note(0, 1, C2), note(1, 1, E2)], [seg(0, 0, 2)], points).fixed).toBe(0);
    // Chord bass says E (C/E) but the transcription hears the tab's G → no fix.
    expect(fixBassWithAudio(t, [note(0, 2, G2)], [seg(0, 0, 2, 4)], points).fixed).toBe(0);
  });

  it("honours inversions: C/E with E heard fixes a wrong C", () => {
    const t = track([bar([C2, C2, C2, C2])]);
    const r = fixBassWithAudio(t, [note(0, 2, E2)], [seg(0, 0, 2, 4)], points);
    expect(r.fixed).toBe(4);
    for (let k = 0; k < 4; k++) expect(midiOf(r.track, 0, k)).toBe(E2);
  });

  it("skips rests, chords and tied notes, and needs anchors + notes", () => {
    const t = {
      tuning: BASS,
      measures: [
        {
          signature: [4, 4],
          voices: [
            {
              beats: [
                { rest: true, duration: [1, 4] },
                { notes: [{ string: 3, fret: 15 }, { string: 2, fret: 15 }], duration: [1, 4] },
                { notes: [{ string: 3, fret: 15, tie: true }], duration: [1, 4] },
                { notes: [{ string: 3, fret: 15 }], duration: [1, 4] },
              ],
            },
          ],
        },
      ],
    } as unknown as SongsterrTrack;
    const r = fixBassWithAudio(t, [note(0, 2, C2)], [seg(0, 0, 2)], points);
    expect(r.fixed).toBe(1); // only the plain single note on beat 4
    expect(fixBassWithAudio(t, [], [seg(0, 0, 2)], points).fixed).toBe(0);
    expect(fixBassWithAudio(t, [note(0, 2, C2)], [seg(0, 0, 2)], null).fixed).toBe(0);
  });

  it("brings the heard pitch into the instrument's range and keeps the string when possible", () => {
    const t = track([bar([G2 + 12, G2 + 12, G2 + 12, G2 + 12])]); // G3 on the E string, fret 27 → out of range? no: 55-28=27 > 20
    // Tab plays G3 (needs fret 27 on string 3 — impossible; the fixture only cares about the fix)
    const heard = [note(0, 2, 24)]; // C1 — below the bass range → raised to C2
    const r = fixBassWithAudio(t, heard, [seg(0, 0, 2)], points);
    expect(r.fixed).toBe(4);
    expect(midiOf(r.track, 0, 0)).toBe(C2);
  });
});
