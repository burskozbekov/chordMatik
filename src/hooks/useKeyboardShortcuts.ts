import { useEffect } from "react";
import type { AudioEngine } from "./useAudioEngine";

/**
 * Global transport shortcuts (when a song is loaded):
 *   Space = play/pause, ←/→ = seek ∓5s, ⇧←/⇧→ = seek ∓1s.
 *   (M = mark start, R = jump to start are handled by TabsPanel when a tab is open.)
 * Ignored while typing in inputs.
 */
export function useKeyboardShortcuts(engine: AudioEngine, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" || // Space/arrows operate the dropdown itself
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        engine.toggle();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        engine.seekBy(e.shiftKey ? -1 : -5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        engine.seekBy(e.shiftKey ? 1 : 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, enabled]);
}
