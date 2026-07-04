import { useEffect, useState } from "react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import { formatTime } from "../lib/format";

/** Live current-time readout. Re-renders ≤ once/second (only when m:ss flips). */
export function TimeDisplay({ engine, className }: { engine: AudioEngine; className?: string }) {
  const [label, setLabel] = useState("0:00");
  useEffect(
    () =>
      engine.subscribe((t) => {
        setLabel(formatTime(t)); // React bails out when the string is unchanged
      }),
    [engine],
  );
  return (
    <span className={`tabular-nums ${className ?? ""}`} aria-label="current time">
      {label}
    </span>
  );
}
