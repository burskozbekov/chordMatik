import { useEffect, useState } from "react";
import { motion } from "motion/react";

/** A short demo progression — purely decorative preview of the real timeline. */
const DEMO_CHORDS = ["C", "G", "Am", "F", "C", "G", "Dm7", "E"] as const;

/**
 * Non-functional preview of the synced chord timeline shown in the empty
 * state. A gradient "active" pill slides between blocks via shared layout
 * animation to hint at how playback will drive the real timeline.
 */
export function TimelinePreview() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % DEMO_CHORDS.length);
    }, 1150);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      aria-hidden
      className="relative w-full overflow-hidden rounded-2xl border border-border/70 bg-surface/50 p-3 shadow-surface"
    >
      {/* edge fades to suggest horizontal scroll */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-surface/80 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-surface/80 to-transparent" />

      <div className="flex items-stretch gap-2">
        {DEMO_CHORDS.map((chord, i) => {
          const isActive = i === active;
          return (
            <div
              key={`${chord}-${i}`}
              className="relative flex h-16 flex-1 items-center justify-center"
            >
              {isActive && (
                <motion.div
                  layoutId="preview-active-pill"
                  className="chord-gradient absolute inset-0 rounded-xl shadow-[0_10px_24px_-10px_rgba(134,239,172,0.7)]"
                  transition={{ type: "spring", stiffness: 380, damping: 34 }}
                />
              )}
              <div
                className={`absolute inset-0 rounded-xl border transition-colors duration-300 ${
                  isActive ? "border-transparent" : "border-border/60 bg-surface/70"
                }`}
              />
              <span
                className={`relative z-[1] text-lg font-semibold tabular-nums tracking-tight transition-colors duration-200 ${
                  isActive ? "text-[#06351f]" : "text-foreground/70"
                }`}
              >
                {chord}
              </span>
            </div>
          );
        })}
      </div>

      {/* faux playhead position indicator */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border/60">
        <motion.div
          className="chord-gradient h-full rounded-full"
          animate={{ width: `${((active + 1) / DEMO_CHORDS.length) * 100}%` }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
        />
      </div>
    </div>
  );
}
