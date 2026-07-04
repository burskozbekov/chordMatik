import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import { brand } from "../theme/tokens";

interface SyncEditorProps {
  peaks: number[];
  durationSec: number;
  engine: AudioEngine;
  /** Recording time (s) where the tab's bar 1 begins. */
  startSec: number;
  /** Detected onset times (s) — drawn as ticks; the start handle snaps to them. */
  onsets?: number[];
  /** Bar-start times (s) from the active sync — drawn as ticks along the top so you
   *  can SEE where each bar lands and whether the cursor is tracking. */
  anchors?: number[];
  onStartChange: (sec: number) => void;
  height?: number;
}

/** Snap a time to the nearest onset within `window` seconds, else unchanged. */
function snapToOnset(sec: number, onsets: number[], window = 0.05): number {
  let best = sec;
  let bestD = window;
  for (const o of onsets) {
    const d = Math.abs(o - sec);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

const ZOOMS = [1, 2, 4, 8, 16, 32];

/**
 * Waveform with a live playhead + a draggable START marker, and zoom for ~10ms
 * placement precision. Click/drag the body to scrub; drag the green handle (or
 * use the page nudge buttons / arrow keys) to set the start. Zoomed, the view
 * windows around the start marker so you can land it on the exact transient.
 */
export function SyncEditor({
  peaks,
  durationSec,
  engine,
  startSec,
  onsets,
  anchors,
  onStartChange,
  height = 72,
}: SyncEditorProps) {
  const onsetsRef = useRef<number[]>(onsets ?? []);
  onsetsRef.current = onsets ?? [];
  const anchorsRef = useRef<number[]>(anchors ?? []);
  anchorsRef.current = anchors ?? [];
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: height });
  const timeRef = useRef(0);
  const startRef = useRef(startSec);
  startRef.current = startSec;
  const modeRef = useRef<"none" | "scrub" | "handle">("none");
  const [zoom, setZoom] = useState(1);

  // Visible window [viewStart, viewEnd], centered on the start marker when zoomed.
  const viewRef = useRef({ start: 0, end: durationSec });
  const computeView = useCallback(() => {
    if (durationSec <= 0) return { start: 0, end: 1 };
    const span = durationSec / zoom;
    let s = startRef.current - span / 2;
    s = Math.max(0, Math.min(durationSec - span, s));
    if (zoom <= 1) s = 0;
    return { start: s, end: (zoom <= 1 ? durationSec : s + span) };
  }, [durationSec, zoom]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || durationSec <= 0) return;
    const view = computeView();
    viewRef.current = view;
    const span = Math.max(1e-6, view.end - view.start);

    const isDark = document.documentElement.classList.contains("dark");
    const idle = isDark ? "rgba(230,240,244,0.16)" : "rgba(15,23,42,0.14)";
    ctx.clearRect(0, 0, w, h);

    const mid = h / 2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, brand.sky);
    grad.addColorStop(1, brand.mint);
    const timeToX = (t: number) => ((t - view.start) / span) * w;
    const progressX = timeToX(timeRef.current);

    const startX = timeToX(startRef.current);
    const cols = Math.max(16, Math.floor(w / 3));
    const i0 = (view.start / durationSec) * peaks.length;
    const i1 = (view.end / durationSec) * peaks.length;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(i0 + (c / cols) * (i1 - i0));
      const b = Math.max(a + 1, Math.floor(i0 + ((c + 1) / cols) * (i1 - i0)));
      let p = 0;
      for (let k = a; k < b && k < peaks.length; k++) if (k >= 0 && peaks[k] > p) p = peaks[k];
      const x = (c / cols) * w;
      const barH = Math.max(1.5, p * (h * 0.9));
      // Intro (left of the start) is dimmed — the "trimmed" lead-in.
      if (x < startX - 1) ctx.fillStyle = isDark ? "rgba(230,240,244,0.1)" : "rgba(15,23,42,0.08)";
      else ctx.fillStyle = x <= progressX ? grad : idle;
      ctx.fillRect(x, mid - barH / 2, 2, barH);
    }

    // Shade the trimmed intro region.
    if (startX > 0) {
      ctx.fillStyle = isDark ? "rgba(0,0,0,0.16)" : "rgba(15,23,42,0.05)";
      ctx.fillRect(0, 0, Math.min(startX, w), h);
    }

    // Onset ticks (faint, bottom edge) — the snap targets.
    const ons = onsetsRef.current;
    if (ons.length) {
      ctx.fillStyle = isDark ? "rgba(230,240,244,0.33)" : "rgba(15,23,42,0.28)";
      for (const o of ons) {
        if (o < view.start || o > view.end) continue;
        ctx.fillRect(timeToX(o), h - 6, 1, 6);
      }
    }

    // Bar anchors (accent ticks along the TOP) — where each bar of the tab lands.
    // Watch the playhead cross them: on-beat crossings = the cursor is tracking.
    const anc = anchorsRef.current;
    if (anc.length) {
      ctx.fillStyle = brand.mint;
      for (const t of anc) {
        if (t < view.start || t > view.end) continue;
        ctx.fillRect(timeToX(t), 0, 1, 7);
      }
    }

    // START = a bold trim handle (drag the green edge left/right to trim the intro).
    const sx = startX;
    if (sx >= -10 && sx <= w + 10) {
      ctx.fillStyle = "#0fb578";
      ctx.fillRect(sx - 1.5, 0, 3, h); // boundary line
      ctx.fillRect(sx - 9, mid - 12, 8, 24); // grab tab on the intro side
      ctx.fillStyle = isDark ? "#06351f" : "#ffffff";
      for (let i = -1; i <= 1; i++) ctx.fillRect(sx - 6, mid + i * 4 - 0.5, 3, 1.5); // grip lines
    }

    // Playhead.
    if (progressX >= 0 && progressX <= w) {
      ctx.fillStyle = brand.skyStrong;
      ctx.fillRect(progressX, 0, 1.5, h);
    }
  }, [peaks, durationSec, computeView]);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    sizeRef.current = { w, h: height };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }, [draw, height]);

  useEffect(() => {
    measure();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => engine.subscribe((t) => {
    timeRef.current = t;
    draw();
  }), [engine, draw]);

  // Redraw when the bar anchors change (a new sync / warp lands).
  useEffect(() => {
    draw();
  }, [anchors, draw]);

  useEffect(draw, [draw, startSec, zoom, onsets]);

  // Scroll-wheel zoom (non-passive so we can preventDefault the page scroll).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const i = ZOOMS.indexOf(z);
        return e.deltaY < 0
          ? ZOOMS[Math.min(ZOOMS.length - 1, i + 1)]
          : ZOOMS[Math.max(0, i - 1)];
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const secAtX = useCallback((clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || durationSec <= 0) return 0;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = viewRef.current;
    return v.start + frac * (v.end - v.start);
  }, [durationSec]);

  return (
    <div className="relative">
      <div
        ref={wrapRef}
        tabIndex={0}
        className="relative w-full cursor-pointer touch-none select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-sky-strong"
        style={{ height }}
        onPointerDown={(e) => {
          const wrap = wrapRef.current;
          if (!wrap) return;
          wrap.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const rect = wrap.getBoundingClientRect();
          const v = viewRef.current;
          const startX = ((startRef.current - v.start) / (v.end - v.start)) * rect.width;
          const x = e.clientX - rect.left;
          // Anywhere in the (dimmed) intro region, or just right of the handle,
          // is a TRIM: drag the green edge to where bar 1 hits. Right of it scrubs.
          if (x <= startX + 10) {
            modeRef.current = "handle";
            onStartChange(secAtX(e.clientX));
          } else {
            modeRef.current = "scrub";
            engine.seek(secAtX(e.clientX));
          }
        }}
        onPointerMove={(e) => {
          if (modeRef.current === "handle") onStartChange(secAtX(e.clientX));
          else if (modeRef.current === "scrub") engine.seek(secAtX(e.clientX));
        }}
        onPointerUp={(e) => {
          // Magnetically snap the dropped start to the nearest detected onset.
          if (modeRef.current === "handle" && onsetsRef.current.length) {
            onStartChange(snapToOnset(startRef.current, onsetsRef.current));
          }
          modeRef.current = "none";
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          modeRef.current = "none";
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.001 : 0.01;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onStartChange(Math.max(0, startRef.current - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onStartChange(startRef.current + step);
          }
        }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
      <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-surface/80 px-1 py-0.5 text-[10px] font-semibold text-muted backdrop-blur">
        <button
          type="button"
          aria-label="Zoom out"
          className="px-1 hover:text-foreground"
          onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}
        >
          −
        </button>
        <span className="min-w-[2rem] text-center font-mono">{zoom}×</span>
        <button
          type="button"
          aria-label="Zoom in"
          className="px-1 hover:text-foreground"
          onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}
        >
          +
        </button>
      </div>
    </div>
  );
}
