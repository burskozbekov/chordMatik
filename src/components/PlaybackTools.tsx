import { useEffect, useState } from "react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import { formatTime } from "../lib/format";
import { CloseIcon, LoopIcon } from "./icons";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const clampRate = (r: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(r * 100) / 100));

/** Playback speed + A–B loop controls (sit under the transport). */
export function PlaybackTools({ engine }: { engine: AudioEngine }) {
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);

  // Keep the engine loop in sync with the marked region.
  useEffect(() => {
    if (enabled && a != null && b != null && b > a) engine.setLoop({ start: a, end: b });
    else engine.setLoop(null);
  }, [a, b, enabled, engine]);

  const markA = () => {
    const t = engine.getTime();
    setA(t);
    if (b != null && b <= t) setB(null);
  };
  const markB = () => {
    const t = engine.getTime();
    if (a == null) setA(0);
    setB(t);
  };
  const clear = () => {
    setA(null);
    setB(null);
  };

  const looping = enabled && a != null && b != null && b > a;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {/* Speed — presets + continuous ±0.05 fine control (0.25×–2×). */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Speed</span>
        <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
          <button
            type="button"
            aria-label="Slower"
            onClick={() => engine.setPlaybackRate(clampRate(engine.playbackRate - 0.05))}
            className="rounded-lg px-1.5 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
          >
            −
          </button>
          {SPEEDS.map((s) => {
            const active = Math.abs(engine.playbackRate - s) < 0.001;
            return (
              <button
                key={s}
                type="button"
                onClick={() => engine.setPlaybackRate(s)}
                className={`rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition-colors ${
                  active ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {s === 1 ? "1×" : `${s}×`}
              </button>
            );
          })}
          <button
            type="button"
            aria-label="Faster"
            onClick={() => engine.setPlaybackRate(clampRate(engine.playbackRate + 0.05))}
            className="rounded-lg px-1.5 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
          >
            +
          </button>
        </div>
        {!SPEEDS.some((s) => Math.abs(engine.playbackRate - s) < 0.001) && (
          <span className="font-mono text-[11px] tabular-nums text-foreground">
            {engine.playbackRate.toFixed(2)}×
          </span>
        )}
      </div>

      {/* A–B loop */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Loop</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={markA}
            className={`rounded-lg border px-2 py-1 text-xs font-semibold tabular-nums transition-colors ${
              a != null
                ? "border-brand-mint/60 bg-brand-mint/15 text-foreground"
                : "border-border/70 bg-surface/50 text-muted hover:text-foreground"
            }`}
          >
            A {a != null ? formatTime(a) : ""}
          </button>
          <button
            type="button"
            onClick={markB}
            className={`rounded-lg border px-2 py-1 text-xs font-semibold tabular-nums transition-colors ${
              b != null
                ? "border-brand-mint/60 bg-brand-mint/15 text-foreground"
                : "border-border/70 bg-surface/50 text-muted hover:text-foreground"
            }`}
          >
            B {b != null ? formatTime(b) : ""}
          </button>
          <button
            type="button"
            aria-label={looping ? "Disable loop" : "Enable loop"}
            onClick={() => setEnabled((e) => !e)}
            disabled={a == null || b == null}
            className={`grid size-8 place-items-center rounded-lg border transition-colors disabled:opacity-40 ${
              looping
                ? "chord-gradient border-transparent text-[#06351f]"
                : "border-border/70 bg-surface/50 text-muted hover:text-foreground"
            }`}
          >
            <LoopIcon className="size-4" />
          </button>
          {(a != null || b != null) && (
            <button
              type="button"
              aria-label="Clear loop"
              onClick={clear}
              className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <CloseIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
