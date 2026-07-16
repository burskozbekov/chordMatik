import { describe, expect, it } from "vitest";
import { applyPins, beatSyncPoints, computeSyncPoints, subseqDtw } from "../tabSync";
import type { SyncAnchor } from "../tabSync";
import type { ChordSegment, SongsterrTrack } from "../types";

// --- fixtures ----------------------------------------------------------------
const TUNING = [40, 45, 50, 55, 59, 64]; // E A D G B E (midi)
const maj = (root: number) => [root % 12, (root + 4) % 12, (root + 7) % 12];

/** A bar whose notes spell `pcs` (all on string 0). */
function bar(pcs: number[]): unknown {
  return {
    voices: [{ beats: [{ notes: pcs.map((pc) => ({ string: 0, fret: (pc - (TUNING[0] % 12) + 24) % 12 })) }] }],
  };
}
const emptyBar = () => ({ voices: [{ beats: [{ notes: [] }] }] });

function track(bars: unknown[]): SongsterrTrack {
  (bars[0] as Record<string, unknown>) = { ...(bars[0] as object), signature: [4, 4] };
  return { tuning: TUNING, measures: bars } as unknown as SongsterrTrack;
}
function seg(rootPc: number, startSec: number, endSec: number): ChordSegment {
  return { rootPc, quality: "maj", label: "x", startSec, endSec } as unknown as ChordSegment;
}

const PROG = [0, 7, 2, 5]; // C G D F
const SPB = 2; // 120 BPM, 4/4
const chroma = (pc: number) => {
  const v = new Array(12).fill(0);
  for (const p of maj(pc)) v[p] = 1;
  return v;
};

describe("subseqDtw (open-begin alignment)", () => {
  it("finds the pattern mid-text with near-zero cost", () => {
    const A = [4, 11, 4, 11, 0, 7, 2, 5, 0, 7, 2, 5, 9, 9].map(chroma);
    const B = [0, 7, 2, 5, 0, 7, 2, 5].map(chroma);
    const { path, avgCost } = subseqDtw(A, B);
    expect(path[0]).toEqual([4, 0]); // starts at audio index 4
    expect(avgCost).toBeLessThan(0.05);
  });
});

describe("computeSyncPoints", () => {
  it("skips an intro the tab does not notate (bar 0 at 8s, not 0s)", () => {
    const segs: ChordSegment[] = [seg(4, 0, 2), seg(11, 2, 4), seg(4, 4, 6), seg(11, 6, 8)];
    let t = 8;
    for (let r = 0; r < 4; r++) for (const root of PROG) { segs.push(seg(root, t, t + SPB)); t += SPB; }
    const res = computeSyncPoints(segs, track(Array.from({ length: 16 }, (_, i) => bar(maj(PROG[i % 4])))));
    expect(res.points[0].barIndex).toBe(0);
    expect(res.points[0].millisecondOffset).toBeCloseTo(8000, -2.5);
  });

  it("back-extrapolates bar 0 over leading rest bars", () => {
    const segs: ChordSegment[] = [];
    let t = 5;
    for (let r = 0; r < 4; r++) for (const root of PROG) { segs.push(seg(root, t, t + SPB)); t += SPB; }
    const bars = [emptyBar(), emptyBar(), ...Array.from({ length: 16 }, (_, i) => bar(maj(PROG[i % 4])))];
    const res = computeSyncPoints(segs, track(bars));
    expect(res.points[0].barIndex).toBe(0);
    expect(res.points[0].millisecondOffset).toBeCloseTo(1000, -2.5); // 5s − 2×2s
  });

  it("no intro: bar 0 stays near the first chord", () => {
    const segs: ChordSegment[] = [];
    let t = 0.5;
    for (let r = 0; r < 4; r++) for (const root of PROG) { segs.push(seg(root, t, t + SPB)); t += SPB; }
    const res = computeSyncPoints(segs, track(Array.from({ length: 16 }, (_, i) => bar(maj(PROG[i % 4])))));
    expect(res.points[0].millisecondOffset).toBeCloseTo(500, -2.5);
  });

  it("REGRESSION: identical repeated bars stay on the diagonal (cosDist clamp + step penalty)", () => {
    const segs = Array.from({ length: 6 }, (_, i) => seg(0, i * SPB, (i + 1) * SPB));
    const res = computeSyncPoints(segs, track(Array.from({ length: 6 }, () => bar(maj(0)))));
    expect(res.points.length).toBeGreaterThanOrEqual(5);
    for (const p of res.points) expect(p.millisecondOffset).toBeCloseTo(p.barIndex * SPB * 1000, -2.5);
  });

  it("REGRESSION: inversion vamp (C vs C/G identical chroma) — one bar per segment", () => {
    const roots = [0, 0, 0, 0, 7, 5];
    const segs = roots.map((r, i) => seg(r, i * SPB, (i + 1) * SPB));
    const res = computeSyncPoints(segs, track(roots.map((r) => bar(maj(r)))));
    for (const p of res.points) expect(p.millisecondOffset).toBeCloseTo(p.barIndex * SPB * 1000, -2.5);
  });

  it("REGRESSION: audio far shorter than tab is demoted below the warp gate (0.45)", () => {
    const segs = PROG.map((r, i) => seg(r, i * SPB, (i + 1) * SPB)); // 8s
    const res = computeSyncPoints(segs, track(Array.from({ length: 16 }, (_, i) => bar(maj(PROG[i % 4]))))); // 16 bars
    expect(res.confidence).toBeLessThan(0.45);
  });

  it("prefers the EARLIEST match on a repeating song (loop-instance tiebreaker)", () => {
    // The 4-bar loop C G D F occurs TWICE in the audio, then trailing no-chord.
    // The tab is that single loop — it must align to the FIRST occurrence (t≈0.5s),
    // not the second (t≈8.5s).
    const segs: ChordSegment[] = [];
    let t = 0.5;
    for (let rep = 0; rep < 2; rep++)
      for (const root of PROG) {
        segs.push(seg(root, t, t + SPB));
        t += SPB;
      }
    const res = computeSyncPoints(segs, track(PROG.map((r) => bar(maj(r)))));
    expect(res.points[0].barIndex).toBe(0);
    expect(res.points[0].millisecondOffset).toBeLessThan(2000); // first loop, not the 8.5s one
  });

  it("pins the LAST bar to the end of the last CHORD, not trailing silence", () => {
    // 4 chord bars ending at 8s, then 20s of no-chord (fade/applause) to 28s.
    const segs: ChordSegment[] = PROG.map((r, i) => seg(r, i * SPB, (i + 1) * SPB));
    segs.push({ rootPc: -1, quality: "N", label: "N", startSec: 8, endSec: 28 } as unknown as ChordSegment);
    // A tab with more bars than the audio has chords → the tail-pin path fires.
    const res = computeSyncPoints(segs, track(Array.from({ length: 8 }, (_, i) => bar(maj(PROG[i % 4])))));
    const tail = res.points[res.points.length - 1];
    // Last anchor must be at/near the music end (8s), NOT the 28s silence end.
    expect(tail.millisecondOffset).toBeLessThan(12000);
  });
});

describe("beatSyncPoints (generated/AI bass follows tracked beats)", () => {
  it("maps each bar to the real beat at bar·beatsPerBar from the nearest start beat", () => {
    // 3 bars of 4/4; drifting beats every ~0.5s starting at 1.0s.
    const beats: number[] = [];
    for (let i = 0; i < 20; i++) beats.push(1.0 + i * 0.5 + (i % 4 === 0 ? 0.03 : 0)); // slight drift
    const t = track([bar(maj(0)), bar(maj(7)), bar(maj(5))]);
    const res = beatSyncPoints(t, beats, 1.0, 4);
    expect(res.points.map((p) => p.barIndex)).toEqual([0, 1, 2]);
    // bar 0 ≈ beats[0], bar 1 ≈ beats[4], bar 2 ≈ beats[8]
    expect(res.points[0].millisecondOffset).toBeCloseTo(beats[0] * 1000, -1.5);
    expect(res.points[1].millisecondOffset).toBeCloseTo(beats[4] * 1000, -1.5);
    expect(res.points[2].millisecondOffset).toBeCloseTo(beats[8] * 1000, -1.5);
  });

  it("bails (empty) without enough beats", () => {
    expect(beatSyncPoints(track([bar(maj(0))]), [1, 2], 0, 4).points).toEqual([]);
  });
});

describe("applyPins (⚓ manual bar corrections)", () => {
  const anchor = (barIndex: number, ms: number): SyncAnchor => ({
    barIndex,
    barPosition: 0,
    barOccurence: 0,
    millisecondOffset: ms,
  });
  const auto = [anchor(0, 1000), anchor(1, 3000), anchor(2, 5000), anchor(3, 7000)];

  it("returns auto unchanged with no pins", () => {
    expect(applyPins(auto, {})).toBe(auto);
  });

  it("a pin replaces its bar's auto anchor", () => {
    const out = applyPins(auto, { 1: 3400 })!;
    expect(out.find((p) => p.barIndex === 1)?.millisecondOffset).toBe(3400);
    expect(out).toHaveLength(4);
  });

  it("autos violating monotonicity around a pin are dropped", () => {
    // Pin bar 1 LATER than auto bar 2 → auto bar 2 must go.
    const out = applyPins(auto, { 1: 5500 })!;
    expect(out.map((p) => p.barIndex)).toEqual([0, 1, 3]);
    const ms = out.map((p) => p.millisecondOffset);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms); // strictly increasing
  });

  it("a pin earlier than preceding autos evicts them", () => {
    const out = applyPins(auto, { 2: 2000 })!;
    expect(out.map((p) => p.barIndex)).toEqual([0, 2, 3]);
    expect(out[1].millisecondOffset).toBe(2000);
  });

  it("contradicting pins: first (by bar) wins", () => {
    const out = applyPins(auto, { 1: 6000, 2: 4000 })!; // pin 2 earlier than pin 1 → ignored
    expect(out.find((p) => p.barIndex === 1)?.millisecondOffset).toBe(6000);
    expect(out.find((p) => p.barIndex === 2)).toBeUndefined();
  });
});
