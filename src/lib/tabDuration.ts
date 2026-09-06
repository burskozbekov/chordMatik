/**
 * Songsterr beat duration → notated value. Pure (no AlphaTab import) so it is
 * unit-testable; `songsterrToScore` maps the result onto AlphaTab's enums.
 *
 * Songsterr encodes THREE things per beat:
 *  - `duration: [num, den]` — the REAL length as a fraction of a whole note, with
 *    dots and tuplets already baked in ([3,8] = dotted quarter, [1,6] = quarter
 *    triplet, [1,24] = sixteenth triplet);
 *  - `type` — the NOTATED value's denominator (4 = quarter, 16 = sixteenth);
 *  - `dots` and `tuplet` (the group size: 3 for a triplet).
 * The old converter only looked at the fraction and rounded a quarter triplet
 * (1/6) to the nearest plain value — a dotted eighth — so triplet bars overflowed
 * and every later beat sat in the wrong place.
 */

/** Notated denominators AlphaTab can render (Whole … SixtyFourth). */
export const NOTE_DENOMINATORS = [1, 2, 4, 8, 16, 32, 64] as const;

export interface NotatedDuration {
  /** 1 = whole, 2 = half, 4 = quarter, 8 = eighth, … 64. */
  denominator: number;
  dots: number;
  /** n:m — n notes in the time of m (3:2 for a triplet). 1:1 = no tuplet. */
  tupletNumerator: number;
  tupletDenominator: number;
}

/** Standard "n in the time of m" pairing (Guitar Pro convention). */
export function tupletDenominatorFor(n: number): number {
  if (n <= 1) return 1;
  if (n === 2 || n === 4) return 3; // duplet / quadruplet in compound meter
  let m = 2;
  while (m * 2 < n) m *= 2; // 3→2, 5,6,7→4, 9..15→8, …
  return m;
}

const dotMultiplier = (dots: number) => (dots >= 2 ? 1.75 : dots === 1 ? 1.5 : 1);

/** Real length (whole notes) of a notated value. */
function valueOf(denominator: number, dots: number, n: number, m: number): number {
  return ((1 / denominator) * dotMultiplier(dots) * m) / n;
}

/**
 * Resolve a beat's notated value. `type` is authoritative when it is a valid
 * denominator and consistent with the real fraction; otherwise the fraction is
 * matched exactly against every (value, dots, tuplet) combination, and only as a
 * last resort rounded to the closest plain value (the pre-tuplet behaviour).
 */
export function notatedDuration(
  duration: [number, number] | undefined,
  dots?: number,
  tuplet?: number,
  type?: number,
): NotatedDuration {
  const n = typeof tuplet === "number" && tuplet > 1 ? Math.round(tuplet) : 1;
  const m = tupletDenominatorFor(n);
  const d = typeof dots === "number" && dots > 0 ? Math.min(2, Math.round(dots)) : 0;
  const plain = (denominator: number, dd = d) => ({
    denominator,
    dots: dd,
    tupletNumerator: n,
    tupletDenominator: n > 1 ? m : 1,
  });

  const real =
    Array.isArray(duration) && duration.length >= 2 && duration[0] > 0 && duration[1] > 0
      ? duration[0] / duration[1]
      : null;

  // 1) Explicit notated value that agrees with the real length (or no length to check).
  if (typeof type === "number" && (NOTE_DENOMINATORS as readonly number[]).includes(type)) {
    if (real === null || Math.abs(valueOf(type, d, n, m) - real) < 1e-6) return plain(type);
  }
  if (real === null) return plain(4);

  // 2) Exact match of the real length over (value, dots, tuplet).
  for (const denominator of NOTE_DENOMINATORS) {
    for (const dd of [d, 0, 1, 2]) {
      if (Math.abs(valueOf(denominator, dd, n, m) - real) < 1e-6) return plain(denominator, dd);
    }
  }
  // A tuplet field may be missing while the fraction still betrays one (1/6, 1/12…).
  if (n === 1) {
    for (const tn of [3, 5, 6, 7, 9]) {
      const tm = tupletDenominatorFor(tn);
      for (const denominator of NOTE_DENOMINATORS) {
        for (const dd of [0, 1]) {
          if (Math.abs(valueOf(denominator, dd, tn, tm) - real) < 1e-6) {
            return { denominator, dots: dd, tupletNumerator: tn, tupletDenominator: tm };
          }
        }
      }
    }
  }

  // 3) Fallback: closest plain value (never throws, keeps the bar renderable).
  let best = plain(4, 0);
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const denominator of NOTE_DENOMINATORS) {
    for (const dd of [0, 1, 2]) {
      const delta = Math.abs(valueOf(denominator, dd, n, m) - real);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = plain(denominator, dd);
      }
    }
  }
  return best;
}
