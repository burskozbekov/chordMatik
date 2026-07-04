import { motion } from "motion/react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import { formatTime } from "../lib/format";
import { TimeDisplay } from "./TimeDisplay";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";

interface TransportProps {
  engine: AudioEngine;
  durationSec: number;
  /** Show "–:––" for the total while the duration is still unknown (e.g. video loading). */
  durationPending?: boolean;
}

/** Play/pause + skip controls with current/total time. */
export function Transport({ engine, durationSec, durationPending }: TransportProps) {
  const { isPlaying, toggle, seekBy } = engine;

  return (
    <div className="flex items-center justify-between gap-4">
      <TimeDisplay engine={engine} className="w-12 text-sm font-medium text-muted" />

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back 5 seconds"
          onClick={() => seekBy(-5)}
          className="grid size-10 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <SkipBackIcon className="size-5" />
        </button>

        <motion.button
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={toggle}
          whileTap={{ scale: 0.92 }}
          whileHover={{ scale: 1.04 }}
          transition={{ type: "spring", stiffness: 420, damping: 24 }}
          className="cta-gradient grid size-14 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-sky-strong focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          {isPlaying ? (
            <PauseIcon className="size-6" />
          ) : (
            <PlayIcon className="size-6 translate-x-[1px]" />
          )}
        </motion.button>

        <button
          type="button"
          aria-label="Forward 5 seconds"
          onClick={() => seekBy(5)}
          className="grid size-10 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <SkipForwardIcon className="size-5" />
        </button>
      </div>

      <span className="w-12 text-right text-sm font-medium tabular-nums text-muted">
        {durationPending ? "–:––" : formatTime(durationSec)}
      </span>
    </div>
  );
}
