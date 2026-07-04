import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioEngine } from "../hooks/useAudioEngine";
import type { ChordSegment } from "../lib/types";
import { chordDisplay } from "../lib/chords";
import { getAudioContext } from "../lib/audioContext";
import { saveRecording } from "../lib/tauri";
import { CloseIcon, PauseIcon, PlayIcon } from "./icons";

/**
 * Webcam studio: a live mirrored self-view (PiP) composited with the current
 * chord overlay, plus a record button that captures the composite + mixed
 * (microphone + song) audio to an mp4. So the chords you see are burned into
 * the saved video. All client-side (getUserMedia + canvas.captureStream +
 * MediaRecorder); WKWebView only writes video/mp4 (H.264/AAC).
 */

const REC_W = 1280;
const REC_H = 720;

/** One AudioContext + song source per media element (createMediaElementSource
 *  can only be called ONCE per element, and re-routes its audio into the graph —
 *  so the source is connected to ctx.destination permanently to stay audible). */
const ELEMENT_GRAPHS = new WeakMap<
  HTMLMediaElement,
  { ctx: AudioContext; songSrc: MediaElementAudioSourceNode }
>();

function songGraph(el: HTMLMediaElement) {
  let g = ELEMENT_GRAPHS.get(el);
  if (!g) {
    const ctx = getAudioContext(); // shared app-wide context (WKWebView dislikes multiple)
    const songSrc = ctx.createMediaElementSource(el);
    songSrc.connect(ctx.destination); // keep the song audible
    g = { ctx, songSrc };
    ELEMENT_GRAPHS.set(el, g);
  }
  return g;
}

/** Index of the chord segment under time `t` (binary search, segments sorted). */
function findActive(segments: ChordSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startSec <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, w: number, h: number) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// Ribbon layout — mirrors the in-app ChordTimeline (NOW line, time-proportional
// pills, active chord in the green gradient).
const NOW_FRAC = 0.38;
const PX_PER_SEC = 120;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw the scrolling chord ribbon (like the app's timeline) onto the video. */
function drawRibbon(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  segments: ChordSegment[],
  t: number,
  transpose: number,
) {
  const stripH = Math.round(H * 0.3);
  const top = H - stripH;
  const back = ctx.createLinearGradient(0, top, 0, H);
  back.addColorStop(0, "rgba(5,30,20,0)");
  back.addColorStop(1, "rgba(5,30,20,0.5)");
  ctx.fillStyle = back;
  ctx.fillRect(0, top, W, stripH);

  const nowX = Math.round(W * NOW_FRAC);
  const cy = top + Math.round(stripH * 0.56);
  const pillH = Math.round(stripH * 0.5);
  const activeH = Math.round(stripH * 0.64);
  const gap = 8;
  const active = findActive(segments, t);

  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    const x0 = nowX + (seg.startSec - t) * PX_PER_SEC + gap / 2;
    const x1 = nowX + (seg.endSec - t) * PX_PER_SEC - gap / 2;
    if (x1 < -30 || x0 > W + 30) continue;
    const pw = x1 - x0;
    if (pw < 3) continue;
    const isActive = k === active;
    const ph = isActive ? activeH : pillH;
    const py = cy - ph / 2;
    const rad = Math.min(24, ph / 2);

    roundRectPath(ctx, x0, py, pw, ph, rad);
    if (isActive) {
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "#08a86b");
      g.addColorStop(0.5, "#14c97e");
      g.addColorStop(1, "#34d399");
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      const past = seg.endSec <= t;
      ctx.fillStyle = past ? "rgba(245,253,247,0.55)" : "rgba(245,253,247,0.92)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(200,232,210,0.7)";
      ctx.stroke();
    }

    const disp = chordDisplay(seg, transpose);
    if (pw >= 30 && disp.label) {
      ctx.save();
      roundRectPath(ctx, x0, py, pw, ph, rad);
      ctx.clip();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (isActive) {
        ctx.fillStyle = "#06351f";
        ctx.font = `700 ${Math.round(activeH * 0.5)}px Inter, system-ui, sans-serif`;
      } else {
        const past = seg.endSec <= t;
        ctx.fillStyle = past ? "rgba(18,53,40,0.5)" : "#123528";
        ctx.font = `600 ${Math.round(pillH * 0.46)}px Inter, system-ui, sans-serif`;
      }
      ctx.fillText(disp.label, x0 + pw / 2, cy + 2);
      ctx.restore();
    }
  }

  // NOW playhead + label.
  ctx.save();
  ctx.strokeStyle = "rgba(16,185,129,0.95)";
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(52,211,153,0.6)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(nowX, top + Math.round(stripH * 0.12));
  ctx.lineTo(nowX, H - Math.round(stripH * 0.08));
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "rgba(167,243,208,0.95)";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${Math.round(H * 0.024)}px Inter, system-ui, sans-serif`;
  ctx.fillText("NOW", nowX, top + Math.round(stripH * 0.1));

  // Small brand watermark, top-left.
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `600 ${Math.round(H * 0.03)}px Inter, system-ui, sans-serif`;
  ctx.fillText("chordMatik", Math.round(W * 0.04), Math.round(H * 0.07));
}

interface CameraStudioProps {
  engine: AudioEngine;
  segments: ChordSegment[];
  transpose: number;
  onClose: () => void;
}

export function CameraStudio({ engine, segments, transpose, onClose }: CameraStudioProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const loopRef = useRef<number | null>(null);
  const recTeardownRef = useRef<(() => void) | null>(null);

  // Keep the latest chord inputs available to the long-lived draw loop.
  const segRef = useRef(segments);
  segRef.current = segments;
  const transRef = useRef(transpose);
  transRef.current = transpose;

  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Acquire the camera + start the composite draw loop on mount; tear down on unmount.
  useEffect(() => {
    let cancelled = false;
    let usedRvfc = false; // so cleanup cancels with the right API (rVFC ≠ rAF)
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v || !canvas) return;
    canvas.width = REC_W;
    canvas.height = REC_H;
    const ctx = canvas.getContext("2d");

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: REC_W }, height: { ideal: REC_H } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        v.srcObject = stream;
        v.muted = true;
        await v.play().catch(() => {});
        setReady(true);

        const rvfc = (v as unknown as { requestVideoFrameCallback?: (cb: () => void) => number })
          .requestVideoFrameCallback;
        usedRvfc = !!rvfc;
        const draw = () => {
          if (cancelled || !ctx) return;
          // Webcam, mirrored (selfie), drawn to cover the canvas.
          ctx.save();
          ctx.translate(REC_W, 0);
          ctx.scale(-1, 1);
          drawCover(ctx, v, REC_W, REC_H);
          ctx.restore();
          // Chord ribbon (un-mirrored so it reads correctly), like the app timeline.
          drawRibbon(ctx, REC_W, REC_H, segRef.current, engine.getTime(), transRef.current);
          schedule();
        };
        const schedule = () => {
          if (cancelled) return;
          if (rvfc) loopRef.current = rvfc.call(v, draw);
          else loopRef.current = requestAnimationFrame(draw);
        };
        schedule();
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string })?.name;
        setError(
          name === "NotAllowedError"
            ? "Camera/microphone access was denied. Allow it in System Settings → Privacy & Security."
            : `Couldn't open the camera: ${String(e)}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      const id = loopRef.current;
      if (id != null) {
        const cancelRvfc = (v as unknown as { cancelVideoFrameCallback?: (h: number) => void })
          .cancelVideoFrameCallback;
        if (usedRvfc && cancelRvfc) cancelRvfc.call(v, id);
        else cancelAnimationFrame(id);
      }
      recTeardownRef.current?.();
      const r = recRef.current;
      if (r && r.state !== "inactive") r.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // engine is stable for the song; segments/transpose are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recording follows playback: the timer only ticks while the song is actually
  // playing (frozen when paused).
  useEffect(() => {
    if (!recording || !engine.isPlaying) return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [recording, engine.isPlaying]);

  // Pause/resume the recorder with playback, so pausing the song doesn't bake a
  // dead (frozen video + silence) gap into the recording.
  useEffect(() => {
    if (!recording) return;
    const rec = recRef.current;
    if (!rec) return;
    try {
      if (engine.isPlaying && rec.state === "paused") rec.resume();
      else if (!engine.isPlaying && rec.state === "recording") rec.pause();
    } catch {
      /* pause/resume unsupported — recording just continues */
    }
  }, [recording, engine.isPlaying]);

  const startRecording = useCallback(async () => {
    const canvas = canvasRef.current;
    const camStream = streamRef.current;
    if (!canvas || !camStream) return;
    setSaved(false);
    setError(null);
    setElapsed(0);
    try {
      const { ctx, songSrc } = songGraph(engine.audioEl as HTMLMediaElement);
      await ctx.resume(); // a context made outside a gesture starts suspended
      const dest = ctx.createMediaStreamDestination();
      const micSrc = ctx.createMediaStreamSource(camStream);
      songSrc.connect(dest); // mix song + mic into one audio track for the recording
      micSrc.connect(dest);

      const canvasStream = canvas.captureStream(30);
      const mixed = new MediaStream([
        canvasStream.getVideoTracks()[0],
        ...dest.stream.getAudioTracks(),
      ]);

      const mime = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
      const rec = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      // Disconnect ONLY the recording taps — keep songSrc → ctx.destination so
      // the song stays audible after recording stops.
      recTeardownRef.current = () => {
        try {
          songSrc.disconnect(dest);
          micSrc.disconnect();
        } catch {
          /* already torn down */
        }
        recTeardownRef.current = null;
      };
      rec.onstop = async () => {
        recTeardownRef.current?.();
        // Use the recorder's ACTUAL negotiated container, not the requested one
        // (WKWebView gives mp4; a browser-dev fallback may give webm) so the
        // file isn't mislabeled.
        const outMime = rec.mimeType || mime || "video/mp4";
        const ext = outMime.includes("webm") ? "webm" : "mp4";
        const blob = new Blob(chunksRef.current, { type: outMime });
        chunksRef.current = [];
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        try {
          const ok = await saveRecording(
            new Uint8Array(await blob.arrayBuffer()),
            `chordMatik-${stamp}.${ext}`,
            outMime,
          );
          if (ok) setSaved(true);
        } catch (e) {
          setError(`Couldn't save: ${String(e)}`);
        }
      };
      rec.start(1000); // 1s timeslice → periodic flush, more robust than one giant blob
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(`Couldn't start recording: ${String(e)}`);
    }
  }, [engine]);

  const stopRecording = useCallback(() => {
    const r = recRef.current;
    if (r && r.state !== "inactive") r.stop();
    recRef.current = null;
    setRecording(false);
  }, []);

  // While the camera is open, Space drives the studio: first press plays the
  // song AND starts recording; later presses pause/resume (recording follows).
  // A capture-phase listener that stops propagation overrides the global
  // play/pause Space shortcut so the two don't fight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!ready) {
        engine.toggle();
      } else if (!recording) {
        engine.play();
        void startRecording();
      } else {
        engine.toggle();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ready, recording, engine, startRecording]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="fixed bottom-4 right-4 z-[90] w-72 select-none">
      <video ref={videoRef} className="hidden" playsInline muted />
      <div className="glass overflow-hidden rounded-2xl shadow-overlay">
        <div className="relative aspect-video w-full bg-black">
          <canvas ref={canvasRef} className="h-full w-full object-cover" />
          {!ready && !error && (
            <div className="absolute inset-0 grid place-items-center text-xs text-white/80">
              Starting camera…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 grid place-items-center p-3 text-center text-[11px] leading-snug text-white/90">
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera"
            className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/45 text-white/90 transition-colors hover:bg-black/70"
          >
            <CloseIcon className="size-3.5" />
          </button>
          {recording && (
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium text-white">
              <span
                className={`size-2 rounded-full ${engine.isPlaying ? "animate-pulse bg-red-500" : "bg-white/70"}`}
              />
              {mm}:{ss}
              {!engine.isPlaying && " · paused"}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-2.5 py-2">
          <button
            type="button"
            onClick={engine.toggle}
            aria-label={engine.isPlaying ? "Pause" : "Play"}
            className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface text-foreground transition-colors hover:bg-surface/70"
          >
            {engine.isPlaying ? (
              <PauseIcon className="size-4" />
            ) : (
              <PlayIcon className="size-4 translate-x-px" />
            )}
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {saved
              ? "Saved ✓"
              : recording
                ? engine.isPlaying
                  ? "Recording…"
                  : "Paused"
                : "Chords burned into the video"}
          </span>
          {recording ? (
            <button
              type="button"
              onClick={stopRecording}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <span className="size-2.5 rounded-[2px] bg-white" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={startRecording}
              disabled={!ready}
              className="cta-gradient inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold outline-none disabled:opacity-50"
            >
              <span className="size-2.5 rounded-full bg-red-500" />
              Record
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
