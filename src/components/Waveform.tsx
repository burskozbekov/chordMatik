import { useCallback, useEffect, useRef } from "react";
import type { AudioEngine, LoopRegion } from "../hooks/useAudioEngine";
import { brand } from "../theme/tokens";

interface WaveformProps {
  peaks: number[];
  durationSec: number;
  engine: AudioEngine;
  loopRegion?: LoopRegion | null;
  className?: string;
  height?: number;
}

/**
 * Static waveform overview with a live playhead. The bar layer + progress fill
 * are redrawn on every engine time tick (≈60 fps while playing) on a canvas, so
 * there are zero React re-renders during playback. Click or drag to seek.
 */
export function Waveform({
  peaks,
  durationSec,
  engine,
  loopRegion,
  className,
  height = 96,
}: WaveformProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: height, dpr: 1 });
  const timeRef = useRef(0);
  const seekingRef = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h } = sizeRef.current;
    if (w === 0) return;

    const isDark = document.documentElement.classList.contains("dark");
    const idle = isDark ? "rgba(230,240,244,0.16)" : "rgba(15,23,42,0.14)";

    ctx.clearRect(0, 0, w, h);

    const barPx = 3; // 2px bar + 1px gap
    const barCount = Math.max(16, Math.min(peaks.length || 1, Math.floor(w / barPx)));
    const mid = h / 2;
    const progressX = durationSec > 0 ? (timeRef.current / durationSec) * w : 0;

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, brand.sky);
    grad.addColorStop(1, brand.mint);

    for (let i = 0; i < barCount; i++) {
      // Resample peaks into this bar (take the max of the mapped range).
      const start = Math.floor((i / barCount) * peaks.length);
      const end = Math.max(start + 1, Math.floor(((i + 1) / barCount) * peaks.length));
      let p = 0;
      for (let k = start; k < end && k < peaks.length; k++) if (peaks[k] > p) p = peaks[k];

      const x = (i / barCount) * w;
      const barH = Math.max(1.5, p * (h * 0.92));
      const y = mid - barH / 2;
      ctx.fillStyle = x <= progressX ? grad : idle;
      ctx.fillRect(x, y, 2, barH);
    }

    // A–B loop region
    if (loopRegion && durationSec > 0) {
      const x0 = (loopRegion.start / durationSec) * w;
      const x1 = (loopRegion.end / durationSec) * w;
      ctx.fillStyle = isDark ? "rgba(52,211,153,0.16)" : "rgba(194,65,12,0.12)";
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.fillStyle = brand.mint;
      ctx.fillRect(x0, 0, 2, h);
      ctx.fillRect(x1 - 2, 0, 2, h);
    }

    // Playhead
    if (durationSec > 0) {
      ctx.fillStyle = brand.skyStrong;
      ctx.fillRect(Math.min(progressX, w - 2), 0, 2, h);
      ctx.beginPath();
      ctx.arc(Math.min(progressX, w - 2), mid, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? brand.sky : brand.skyStrong;
      ctx.fill();
    }
  }, [peaks, durationSec, loopRegion]);

  // DPR-aware sizing.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    const h = height;
    sizeRef.current = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }, [draw, height]);

  useEffect(() => {
    measure();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  // Drive the playhead from the engine.
  useEffect(() => {
    return engine.subscribe((t) => {
      timeRef.current = t;
      draw();
    });
  }, [engine, draw]);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const wrap = wrapRef.current;
      if (!wrap || durationSec <= 0) return;
      const rect = wrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      engine.seek(frac * durationSec);
    },
    [engine, durationSec],
  );

  return (
    <div
      ref={wrapRef}
      className={`relative w-full cursor-pointer touch-none select-none ${className ?? ""}`}
      style={{ height }}
      onPointerDown={(e) => {
        seekingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekToClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (seekingRef.current) seekToClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        seekingRef.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        seekingRef.current = false;
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
