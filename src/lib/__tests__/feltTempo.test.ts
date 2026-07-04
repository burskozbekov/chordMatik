import { describe, expect, it } from "vitest";
import { feltTempo } from "../feltTempo";

describe("feltTempo octave folding", () => {
  it("folds a notated ballad down to its felt pulse (152 → 76)", () => {
    // Prior ~100 BPM: 76 beats 152 with no other evidence.
    expect(feltTempo(152)).toBe(76);
  });

  it("keeps a genuinely fast tempo (138 stays 138)", () => {
    expect(feltTempo(138)).toBe(138);
  });

  it("leaves an already-felt value alone (76, 93)", () => {
    expect(feltTempo(76)).toBe(76);
    expect(feltTempo(93)).toBe(93);
  });

  it("passes non-positive through unchanged", () => {
    expect(feltTempo(0)).toBe(0);
  });

  describe("measured-tempo confirmer", () => {
    it("adopts the octave the measurement clearly matches (measured 150 → 152)", () => {
      expect(feltTempo(152, undefined, undefined, 150)).toBe(152);
    });

    it("IGNORES a measurement too far from any octave (>~9%) — heuristic wins", () => {
      // 138 is 13.9% from 152 and 82% from 76 → neither within tolerance → 76.
      expect(feltTempo(152, undefined, undefined, 138)).toBe(76);
    });

    it("confirms the fast octave when the audio agrees (measured 138 → 138)", () => {
      expect(feltTempo(138, undefined, undefined, 138)).toBe(138);
    });
  });
});
