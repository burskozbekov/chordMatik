import { useEffect, useRef, useState } from "react";
import type { AudioEngine } from "./useAudioEngine";
import type { ChordSegment } from "../lib/types";

/**
 * Track the chord segment under the playhead. Re-renders only when the active
 * segment changes (≈ once per chord), not every frame. Returns the active and
 * upcoming segments.
 */
export function useActiveChord(engine: AudioEngine, segments: ChordSegment[]) {
  const [idx, setIdx] = useState(-1);
  const idxRef = useRef(-2);

  useEffect(() => {
    idxRef.current = -2;
    const starts = segments.map((s) => s.startSec);
    const find = (t: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    };
    return engine.subscribe((t) => {
      const i = find(t);
      if (i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
      }
    });
  }, [engine, segments]);

  return {
    active: idx >= 0 ? segments[idx] ?? null : null,
    next: idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : null,
    index: idx,
  };
}
