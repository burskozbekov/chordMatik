import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import type { ChordAnalysis, ChordSegment, TabInstrument } from "../lib/types";
import { chordDisplay } from "../lib/chords";
import { formatTime } from "../lib/format";

interface ChordTimelineProps {
  analysis: ChordAnalysis;
  engine: AudioEngine;
  /** Transpose applied to displayed labels (semitones). */
  transpose?: number;
  useFlats?: boolean;
  /** Horizontal zoom (pixels per second). */
  pxPerSec?: number;
  /** When true, left-clicking a chord reports its start via onPick (not seek). */
  picking?: boolean;
  /** Set the tab start at a chord's time; `which` (from right-click) also picks the tab. */
  onPick?: (timeSec: number, which?: TabInstrument) => void;
  /** Instruments the song actually has a tab for — the right-click menu offers these. */
  availableTabs?: TabInstrument[];
}

const PLAYHEAD_FRAC = 0.36;

/**
 * The synced, horizontally-scrolling chord ribbon — the app's centerpiece.
 *
 * Performance model: the ribbon is translated every animation frame via a
 * single imperative `transform` (GPU compositor, no React re-render). The
 * active-chord highlight is React state that flips only on chord boundaries
 * (≈ once per second), so the block list re-renders rarely. Result: 60 fps.
 */
export function ChordTimeline({
  analysis,
  engine,
  transpose = 0,
  useFlats = false,
  pxPerSec = 104,
  picking = false,
  onPick,
  availableTabs,
}: ChordTimelineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeRef = useRef(-1);
  // Right-click context menu: pick this chord as the guitar/bass tab start.
  const [menu, setMenu] = useState<{ x: number; y: number; time: number } | null>(null);

  const segments = analysis.segments;
  const totalWidth = Math.max(analysis.durationSec * pxPerSec, 1);

  const blocks = useMemo(
    () =>
      segments.map((seg) => ({
        seg,
        x: seg.startSec * pxPerSec,
        w: Math.max((seg.endSec - seg.startSec) * pxPerSec, 2),
      })),
    [segments, pxPerSec],
  );

  // Binary search for the segment covering time `t`.
  const findActive = useMemo(() => {
    const starts = segments.map((s) => s.startSec);
    return (t: number) => {
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
      if (ans >= 0 && t >= segments[ans].endSec) {
        // In a gap (shouldn't happen with contiguous segments) — keep last.
      }
      return ans;
    };
  }, [segments]);

  // Position the ribbon so time `t` sits under the playhead, and update the
  // active-block highlight. Reads clientWidth fresh so the playhead line
  // (CSS left: 36%) and the transform always agree.
  const applyAt = useCallback(
    (t: number) => {
      const wrap = wrapRef.current;
      const ribbon = ribbonRef.current;
      if (!wrap || !ribbon) return;
      const playheadX = wrap.clientWidth * PLAYHEAD_FRAC;
      ribbon.style.transform = `translate3d(${playheadX - t * pxPerSec}px, 0, 0)`;
      const idx = findActive(t);
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActiveIdx(idx);
      }
    },
    [pxPerSec, findActive],
  );

  // Drive from playback (≈60 fps while playing; one tick on seek/pause).
  useEffect(() => engine.subscribe(applyAt), [engine, applyAt]);

  // Re-apply on layout settle / resize so alignment stays correct when paused.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => applyAt(engine.getTime()));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [applyAt, engine]);

  return (
    <>
    <div
      ref={wrapRef}
      className={`relative h-32 w-full overflow-hidden rounded-3xl border bg-surface/40 ${
        picking ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40" : "border-border/60"
      }`}
    >
      {/* edge fades */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-16 bg-gradient-to-r from-surface/70 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-16 bg-gradient-to-l from-surface/70 to-transparent" />

      {/* playhead */}
      <div
        className="pointer-events-none absolute inset-y-3 z-30 w-0.5 rounded-full bg-brand-sky-strong/90 shadow-[0_0_14px_2px_rgba(52,211,153,0.5)] dark:bg-brand-sky"
        style={{ left: `${PLAYHEAD_FRAC * 100}%` }}
      />
      <div
        className="pointer-events-none absolute top-1 z-30 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wider text-brand-sky-strong/80 dark:text-brand-sky/80"
        style={{ left: `${PLAYHEAD_FRAC * 100}%` }}
      >
        now
      </div>

      {/* ribbon */}
      <div
        ref={ribbonRef}
        className="absolute inset-y-0 left-0 flex items-stretch py-3 will-change-transform"
        style={{ width: totalWidth }}
      >
        {blocks.map(({ seg, w }, i) => (
          <ChordBlock
            key={i}
            seg={seg}
            width={w}
            transpose={transpose}
            useFlats={useFlats}
            picking={picking}
            state={i === activeIdx ? "active" : i < activeIdx ? "past" : "future"}
            onSeek={() =>
              picking && onPick ? onPick(seg.startSec) : engine.seek(seg.startSec + 0.002)
            }
            onContext={
              onPick
                ? (e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, time: seg.startSec });
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
    {menu && onPick && (
      <>
        <div
          className="fixed inset-0 z-[80]"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        />
        <div
          className="fixed z-[81] min-w-[190px] overflow-hidden rounded-xl border border-border/70 bg-surface text-sm shadow-overlay"
          style={{
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - (54 + (availableTabs?.length || 2) * 42)),
          }}
        >
          <div className="border-b border-border/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Start tab at {formatTime(menu.time)}
          </div>
          {(availableTabs?.length ? availableTabs : (["guitar", "bass"] as TabInstrument[])).map(
            (instr) => (
              <button
                key={instr}
                type="button"
                onClick={() => {
                  onPick(menu.time, instr);
                  setMenu(null);
                }}
                className="block w-full px-3 py-2 text-left font-medium text-foreground transition-colors hover:bg-surface-hover"
              >
                Start {instr} tab here
              </button>
            ),
          )}
        </div>
      </>
    )}
    </>
  );
}

interface ChordBlockProps {
  seg: ChordSegment;
  width: number;
  transpose: number;
  useFlats: boolean;
  state: "past" | "active" | "future";
  picking?: boolean;
  onSeek: () => void;
  onContext?: (e: MouseEvent) => void;
}

function ChordBlock({ seg, width, transpose, useFlats, state, picking, onSeek, onContext }: ChordBlockProps) {
  const disp = chordDisplay(seg, transpose, useFlats);
  const showLabel = width >= 26;
  const isActive = state === "active";

  return (
    <button
      type="button"
      onClick={onSeek}
      onContextMenu={onContext}
      style={{ width }}
      className={`group relative h-full shrink-0 px-[3px] outline-none ${
        picking ? "cursor-cell" : ""
      }`}
      aria-label={
        picking
          ? `Set the tab start at ${disp.label} (${seg.startSec.toFixed(1)}s)`
          : `${disp.label} at ${seg.startSec.toFixed(1)}s`
      }
    >
      <span
        className={[
          "flex h-full items-center justify-center rounded-2xl border transition-all duration-300 ease-out",
          picking ? "group-hover:ring-2 group-hover:ring-[var(--accent)]" : "",
          isActive
            ? "chord-gradient scale-[1.04] border-transparent text-[#06351f] shadow-[0_12px_30px_-10px_rgba(134,239,172,0.65)]"
            : disp.isNoChord
              ? "border-border/60 bg-surface/40 text-muted"
              : state === "past"
                ? "border-border bg-surface/60 text-foreground/45 group-hover:text-foreground/75"
                : "border-border bg-surface text-foreground/85 shadow-surface group-hover:border-brand-sky/60",
        ].join(" ")}
      >
        {showLabel && (
          <span
            className={`select-none font-semibold tracking-tight ${
              isActive ? "text-2xl" : "text-lg"
            } ${disp.isNoChord ? "text-base font-normal" : ""}`}
          >
            {disp.label}
          </span>
        )}
      </span>
    </button>
  );
}
