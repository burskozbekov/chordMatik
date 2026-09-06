import { describe, expect, it } from "vitest";
import { notatedDuration, tupletDenominatorFor } from "../tabDuration";

describe("notatedDuration (Songsterr beat → notated value)", () => {
  it("plain values pass through", () => {
    expect(notatedDuration([1, 4], 0, undefined, 4)).toMatchObject({ denominator: 4, dots: 0, tupletNumerator: 1 });
    expect(notatedDuration([1, 8])).toMatchObject({ denominator: 8, dots: 0, tupletNumerator: 1 });
    expect(notatedDuration([1, 1])).toMatchObject({ denominator: 1, dots: 0 });
  });

  it("dotted values keep the dot (3/8 = dotted quarter)", () => {
    expect(notatedDuration([3, 8], 1, undefined, 4)).toMatchObject({ denominator: 4, dots: 1 });
    expect(notatedDuration([3, 8])).toMatchObject({ denominator: 4, dots: 1 }); // dots field missing
  });

  it("quarter triplet (the real Songsterr encoding: [1,6], tuplet 3, type 4)", () => {
    // The bug: this used to round to a DOTTED EIGHTH and overflow the bar.
    expect(notatedDuration([1, 6], 0, 3, 4)).toEqual({
      denominator: 4,
      dots: 0,
      tupletNumerator: 3,
      tupletDenominator: 2,
    });
  });

  it("sixteenth triplet ([1,24], tuplet 3, type 16) and eighth triplet ([1,12], tuplet 3)", () => {
    expect(notatedDuration([1, 24], 0, 3, 16)).toMatchObject({ denominator: 16, tupletNumerator: 3, tupletDenominator: 2 });
    expect(notatedDuration([1, 12], 0, 3)).toMatchObject({ denominator: 8, tupletNumerator: 3, tupletDenominator: 2 });
  });

  it("infers a tuplet from the fraction alone when the tuplet field is missing", () => {
    expect(notatedDuration([1, 6])).toMatchObject({ denominator: 4, tupletNumerator: 3, tupletDenominator: 2 });
    expect(notatedDuration([1, 20])).toMatchObject({ denominator: 16, tupletNumerator: 5, tupletDenominator: 4 });
  });

  it("quintuplet / sextuplet / septuplet pairings", () => {
    expect(tupletDenominatorFor(3)).toBe(2);
    expect(tupletDenominatorFor(5)).toBe(4);
    expect(tupletDenominatorFor(6)).toBe(4);
    expect(tupletDenominatorFor(7)).toBe(4);
    expect(tupletDenominatorFor(9)).toBe(8);
    expect(tupletDenominatorFor(2)).toBe(3);
    expect(notatedDuration([1, 20], 0, 5, 16)).toMatchObject({ denominator: 16, tupletNumerator: 5, tupletDenominator: 4 });
  });

  it("a contradicting `type` is ignored in favour of the real length", () => {
    // type says quarter but the length is an eighth → eighth.
    expect(notatedDuration([1, 8], 0, undefined, 4)).toMatchObject({ denominator: 8, dots: 0 });
  });

  it("garbage never throws and stays renderable", () => {
    expect(notatedDuration(undefined)).toMatchObject({ denominator: 4 });
    expect(notatedDuration([0, 0])).toMatchObject({ denominator: 4 });
    expect(notatedDuration([7, 64])).toMatchObject({ denominator: 16, dots: 2 }); // double-dotted sixteenth
    expect(notatedDuration([5, 32]).denominator).toBeGreaterThan(0); // odd ratio → closest
  });
});
