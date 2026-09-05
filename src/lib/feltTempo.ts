interface Seg {
  startSec: number;
}

/**
 * Pick the "felt" tempo octave from a notated/detected BPM.
 *
 * Notation sources (Songsterr) and beat trackers routinely report a ballad at
 * DOUBLE its felt pulse — Careless Whisper is notated 152 = 2×76, because the
 * eighth-note subdivision is busy. Tempo is only defined up to a power of two
 * (bar / tactus / subdivision are all "the beat"), so we keep the source value's
 * precision but fold it by 2^k to the metric level a player actually taps to.
 *
 * Evidence, as a soft weighted vote (none can be perfectly reliable):
 *  - harmonic rhythm: chords want to span ~1/2/3/4 beats (we decode chords, so
 *    this is trustworthy);
 *  - onset density: an octave so fast that beats fall in silence is wrong;
 *  - a gentle prior centred ~100 BPM (NOT the textbook 120 — that would prefer
 *    152 over 76 for this song).
 *
 * Biased to HALVE, never to double a mid/fast tempo: notation sources skew high,
 * and ×2 (double-time) over-correction is the dominant failure mode. The user
 * always has the ×2 / ÷2 buttons + per-song persistence as the override.
 */
export function feltTempo(
  notated: number,
  segments?: Seg[],
  onsets?: number[],
  measuredBpm?: number,
): number {
  if (!(notated > 0)) return notated;

  const candidates: number[] = [];
  for (let k = -2; k <= 1; k++) {
    if (k > 0 && notated >= 60) continue; // don't double mid/fast tempos — sources skew high
    const bpm = notated * 2 ** k;
    if (bpm >= 40 && bpm <= 210) candidates.push(bpm);
  }
  if (candidates.length === 0) return Math.round(notated);
  // Exactly one in-band octave (e.g. an out-of-band notated value) → use it.
  if (candidates.length === 1) return Math.round(candidates[0]);

  // The recording's measured tempo (bass-weighted onset autocorrelation) is only a
  // CONFIRMER, not an override: a single autocorrelation isn't reliable on every
  // song (it can lock to a subdivision or a non-tactus peak). So fold the precise
  // notated value to the candidate octave nearest the measurement ONLY when the
  // audio clearly matches that octave (within ~9%) AND it lands in the felt range.
  // Otherwise the measurement is untrustworthy → let the heuristic below decide.
  if (measuredBpm && measuredBpm > 0) {
    let pick = candidates[0];
    let bestD = Infinity;
    for (const c of candidates) {
      const d = Math.abs(Math.log2(c / measuredBpm));
      if (d < bestD) {
        bestD = d;
        pick = c;
      }
    }
    if (bestD < 0.12 && pick >= 55 && pick <= 165) return Math.round(pick);
  }

  // Harmonic rhythm — chord durations from consecutive chord onsets (robust to
  // however segments store their end). Skip blips and very long holds.
  const starts = (segments ?? [])
    .map((s) => s.startSec)
    .filter((x) => typeof x === "number")
    .sort((a, b) => a - b);
  const durs: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const d = starts[i] - starts[i - 1];
    if (d > 0.3 && d < 12) durs.push(d);
  }
  durs.sort((a, b) => a - b);
  const mdur = durs.length ? durs[durs.length >> 1] : 0;

  // Onset spacing — median inter-onset interval.
  const ioiArr: number[] = [];
  for (let i = 1; i < (onsets?.length ?? 0); i++) {
    const d = onsets![i] - onsets![i - 1];
    if (d > 0.08 && d < 4) ioiArr.push(d);
  }
  ioiArr.sort((a, b) => a - b);
  const mioi = ioiArr.length ? ioiArr[ioiArr.length >> 1] : 0;

  const logBell = (x: number, target: number, sigma: number) => {
    const z = Math.log(x / target) / sigma;
    return Math.exp(-0.5 * z * z);
  };

  // Harmonic rhythm only PINS the octave when chords change fast enough. If a
  // chord spans many beats even at the FASTEST candidate octave (a multi-bar
  // drone — e.g. Pulp's "Common People" verse holds one chord for bars), it lands
  // on a clean bar-multiple at EVERY octave and just votes for whichever is slower
  // (smaller beats-per-chord), wrongly halving a genuinely fast song. So we drop
  // the harmonic vote there and let the ~100 BPM prior decide (a slow-candidate
  // below ~71 BPM ⇒ the song is really the faster octave).
  const maxBpm = Math.max(...candidates);
  const minBpc = mdur > 0 ? (mdur * maxBpm) / 60 : 0; // beats/chord at the fastest octave
  const harmonicInformative = minBpc > 0 && minBpc < 6;

  const score = (bpm: number) => {
    const spb = 60 / bpm;
    // (1) soft prior ~100 BPM — the tie-break, and the decider for drones.
    let s = 0.9 * logBell(bpm, 100, 0.55);
    // (2) harmonic rhythm — chords spanning a clean small number of beats (only
    //     trusted when chords change fast enough to actually pin the octave).
    if (harmonicInformative) {
      const bpc = mdur / spb; // beats per chord
      let best = 0;
      for (const t of [1, 2, 4, 3, 8]) best = Math.max(best, logBell(bpc, t, 0.33));
      s += 1.1 * best;
      if (bpc < 0.6 || bpc > 12) s -= 0.7; // implausible chord length
    }
    // (3) onset density — penalise an octave so fast that beats fall in silence.
    if (mioi > 0 && spb < mioi * 0.7) s -= 0.6 * (1 - spb / (mioi * 0.7));
    return s;
  };

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const sc = score(c);
    if (sc > bestScore) {
      bestScore = sc;
      best = c;
    }
  }
  return Math.round(best);
}

/**
 * Whether a persisted tab-sync tempo may be RE-DERIVED (it was chosen
 * automatically and the user never touched it) or must be kept (a manual pick is
 * final). The felt octave is often decided when the tab loads — BEFORE the chord
 * analysis exists — so an "auto" value has to stay open to the evidence.
 *  - v ≥ 6 saves carry an explicit `bpmAuto` flag.
 *  - v 5 saves are auto when they equal the evidence-free derivation: that
 *    version persisted whatever octave was picked at tab-load time, blind.
 *  - older saves predate the felt-octave logic and are always re-derived.
 */
export function savedBpmIsAuto(
  saved: { bpm: number; bpmAuto?: boolean; v?: number },
  notated: number,
): boolean {
  const v = saved.v ?? 0;
  if (v >= 6) return saved.bpmAuto === true;
  if (v === 5) return saved.bpm === feltTempo(notated);
  return true;
}
