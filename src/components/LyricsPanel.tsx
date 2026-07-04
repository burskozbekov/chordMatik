import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../state/AppState";
import { fetchLyrics } from "../lib/tauri";
import type { LyricsResult } from "../lib/types";

interface Line {
  time: number;
  text: string;
}

const STAMP = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;

/** Parse LRC ("[mm:ss.xx] line") into time-sorted lines (a line may repeat). */
function parseLrc(lrc: string): Line[] {
  const lines: Line[] = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(STAMP)];
    if (stamps.length === 0) continue;
    const text = raw.replace(STAMP, "").trim();
    for (const m of stamps) {
      const sec = Number(m[2].replace(":", "."));
      lines.push({ time: Number(m[1]) * 60 + sec, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** No timestamps — spread plain lines across the song so they still highlight
 *  (rough; click a line to jump if it drifts). Skips a short intro/outro. */
function estimatePlain(plain: string, duration: number): Line[] {
  const texts = plain.split("\n").map((s) => s.trim());
  if (texts.length === 0 || !(duration > 0)) return [];
  const start = duration * 0.06;
  const span = Math.max(1, duration * 0.96 - start);
  return texts.map((text, i) => ({ time: start + (i / texts.length) * span, text }));
}

/**
 * Synced song lyrics (lrclib) at the bottom — karaoke-style: the current line is
 * highlighted and auto-scrolled to center, click a line to jump there. Falls back
 * to plain text, and hides itself entirely when no lyrics are found.
 */
export function LyricsPanel({ title }: { title: string }) {
  const { engine, analysis } = useAppState();
  const [data, setData] = useState<LyricsResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "none">("idle");
  const [activeIdx, setActiveIdx] = useState(-1);
  const [userOffset, setUserOffset] = useState(0);
  const activeRef = useRef(-1);
  const lastTitle = useRef("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!title || title === lastTitle.current) return;
    lastTitle.current = title;
    let cancelled = false;
    setState("loading");
    setData(null);
    setActiveIdx(-1);
    setUserOffset(0);
    activeRef.current = -1;
    fetchLyrics(title)
      .then((r) => {
        if (cancelled) return;
        if (r && (r.synced || r.plain)) {
          setData(r);
          setState("done");
        } else {
          setState("none");
        }
      })
      .catch(() => {
        if (!cancelled) setState("none");
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  const lines = useMemo(() => {
    if (data?.synced) return parseLrc(data.synced);
    if (data?.plain && analysis?.durationSec) return estimatePlain(data.plain, analysis.durationSec);
    return [];
  }, [data, analysis?.durationSec]);

  // Synced LRC times are relative to the official recording's start, but our
  // audio often has a YouTube intro/title-card before the music. Anchor LRC-0 to
  // where the music actually starts (first detected chord) + a manual nudge.
  // (Estimated/plain lines are already in our audio's time → manual nudge only.)
  const baseOffset = useMemo(
    () => (data?.synced ? (analysis?.segments.find((s) => s.rootPc >= 0)?.startSec ?? 0) : 0),
    [data?.synced, analysis],
  );
  const offset = Math.round((baseOffset + userOffset) * 1000) / 1000;

  // Follow playback — binary-search the current line, update only on change.
  useEffect(() => {
    if (lines.length === 0) return;
    return engine.subscribe((t) => {
      const pos = t - offset; // playback time → position in the LRC timeline
      let lo = 0;
      let hi = lines.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= pos + 0.15) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActiveIdx(idx);
      }
    });
  }, [engine, lines, offset]);

  // Keep the active line centered.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || activeIdx < 0) return;
    const el = box.querySelector(`[data-line="${activeIdx}"]`) as HTMLElement | null;
    if (el) {
      box.scrollTo({
        top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2,
        behavior: "smooth",
      });
    }
  }, [activeIdx]);

  if (state === "idle" || state === "none") return null;

  return (
    <section className="glass flex flex-col gap-2 rounded-2xl px-4 py-3 shadow-overlay">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Lyrics</h3>
        {data && (
          <span className="min-w-0 truncate text-[11px] text-muted">
            {data.artist} — {data.title} · lrclib
          </span>
        )}
        {data && !data.synced && data.plain && (
          <span
            className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="lrclib had no timed lyrics — spread evenly; click a line to jump"
          >
            ≈ estimated timing
          </span>
        )}
        {lines.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-muted">
            <span className="mr-0.5 hidden sm:inline">sync</span>
            <button
              type="button"
              onClick={() => setUserOffset((o) => Math.round((o - 0.2) * 1000) / 1000)}
              title="Lyrics lagging behind the song? tap to advance them"
              className="rounded px-1.5 py-0.5 font-semibold transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              −
            </button>
            <span className="min-w-[3.4rem] text-center font-mono text-foreground">
              {offset >= 0 ? "+" : ""}
              {offset.toFixed(2)}s
            </span>
            <button
              type="button"
              onClick={() => setUserOffset((o) => Math.round((o + 0.2) * 1000) / 1000)}
              title="Lyrics running ahead of the song? tap to delay them"
              className="rounded px-1.5 py-0.5 font-semibold transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              +
            </button>
          </div>
        )}
      </div>

      {state === "loading" ? (
        <div className="grid h-24 place-items-center text-xs text-muted">Finding lyrics…</div>
      ) : lines.length > 0 ? (
        <div ref={boxRef} className="h-56 overflow-y-auto px-1 text-center">
          {lines.map((l, i) => (
            <p
              key={i}
              data-line={i}
              onClick={() => engine.seek(Math.max(0, l.time + offset))}
              title="Jump the song here"
              className={`cursor-pointer rounded-lg py-1 transition-all duration-300 hover:bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] ${
                i === activeIdx
                  ? "text-xl font-bold text-[var(--accent)]"
                  : i < activeIdx
                    ? "text-sm text-muted/45 hover:text-foreground"
                    : "text-sm text-muted hover:text-foreground"
              }`}
            >
              {l.text || "♪"}
            </p>
          ))}
        </div>
      ) : data?.plain ? (
        <div className="h-56 overflow-y-auto whitespace-pre-wrap px-1 text-sm leading-relaxed text-muted">
          {data.plain}
        </div>
      ) : null}
    </section>
  );
}
