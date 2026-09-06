import { useEffect, useRef } from "react";
import { Button } from "@heroui/react";
import { useAppState } from "../state/AppState";
import { AlertIcon } from "./icons";
import { CARD_HTML, LOADER_CSS } from "./loaderCss";

/**
 * Shown while a pasted YouTube link is turned into chords (download → analyze).
 * A 70s CQT-spectrogram loader: shimmering frequency cells, a decode head that
 * sweeps left→right crystallizing chord labels out of the noise, and a filling
 * percentage. The animation is imperative (built into a ref div); cleaned up on
 * unmount. No embedded player.
 */
/** A download failure whose usual cause is an outdated yt-dlp. */
const looksLikeStaleYtDlp = (msg: string | null) =>
  /yt-dlp|403|forbidden|sign in to confirm|nsig|not a bot/i.test(msg ?? "");

export function FetchingState() {
  const { ytFetchState, ytFetchError, openDialog, reset, updateYtDlpAndRetry } = useAppState();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ytFetchState === "error" || ytFetchState === "updating") return;
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = CARD_HTML;
    const cancel = runLoader(root);
    return () => {
      cancel();
      root.innerHTML = "";
    };
  }, [ytFetchState]);

  if (ytFetchState === "updating") {
    return (
      <div className="glass mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-3xl px-8 py-10 text-center shadow-overlay">
        <span className="size-9 animate-spin rounded-full border-[3px] border-brand-sky/25 border-t-brand-sky" />
        <div>
          <p className="text-base font-semibold text-foreground">Updating yt-dlp…</p>
          <p className="mt-1 text-sm text-muted">About a minute, then the download retries.</p>
        </div>
      </div>
    );
  }

  if (ytFetchState === "error") {
    const stale = looksLikeStaleYtDlp(ytFetchError);
    return (
      <div className="glass mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-3xl px-8 py-10 text-center shadow-overlay">
        <div className="grid size-14 place-items-center rounded-2xl bg-danger/12 text-danger">
          <AlertIcon className="size-7" />
        </div>
        <div>
          <p className="text-base font-semibold text-foreground">Couldn’t get the chords</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {ytFetchError ?? "Try another link, or open the song’s audio file."}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {stale && (
            <Button variant="primary" size="md" onPress={() => void updateYtDlpAndRetry()}>
              Update yt-dlp
            </Button>
          )}
          <Button variant={stale ? "outline" : "primary"} size="md" onPress={reset}>
            Back
          </Button>
          <Button variant="outline" size="md" onPress={openDialog}>
            Open a file
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{LOADER_CSS}</style>
      <div ref={rootRef} className="cm-loader" />
    </>
  );
}

/** Drives the spectrogram loader inside `root`. Returns a cancel fn. */
function runLoader(root: HTMLElement): () => void {
  const q = (s: string) => root.querySelector(s) as HTMLElement | null;
  const grid = q("#cmGrid");
  const chordsBox = q("#cmChords");
  const scan = q("#cmScan");
  const numEl = q("#cmNum");
  const fill = q("#cmFill");
  const wordsBox = q(".cm-words");
  if (!grid || !chordsBox || !scan || !numEl || !fill || !wordsBox) return () => {};

  const COLS = 40;
  const ROWS = 12;
  const cells: HTMLElement[][] = [];
  for (let c = 0; c < COLS; c++) {
    const col = document.createElement("div");
    col.className = "cm-col";
    const arr: HTMLElement[] = [];
    for (let r = 0; r < ROWS; r++) {
      const cell = document.createElement("div");
      cell.className = "cm-cell";
      col.appendChild(cell);
      arr.push(cell);
    }
    grid.appendChild(col);
    cells.push(arr);
  }

  const labels = ["Cmaj7", "Am7", "F", "G7", "Dm7", "Em", "Bb", "Asus4", "C/E", "G", "Fmaj7", "D7"];
  const slots = [8, 18, 28, 38, 50, 60, 70, 80, 88];
  const xs = [10, 21, 32, 43, 55, 66, 77, 86, 93];
  const ys = [34, 60, 30, 55, 40, 64, 36, 58, 44];
  const chordEls: { el: HTMLElement; thr: number; lit: boolean }[] = [];
  for (let i = 0; i < slots.length; i++) {
    const el = document.createElement("div");
    el.className = "cm-chord";
    el.style.left = xs[i] + "%";
    el.style.top = ys[i] + "%";
    el.innerHTML = labels[i % labels.length].replace(/(maj7|m7|sus4|7|\/E)/, "<b>$1</b>");
    chordsBox.appendChild(el);
    chordEls.push({ el, thr: slots[i], lit: false });
  }

  // gradient color helper: deep emerald → fresh mint
  const gcol = (t: number) => {
    const r = Math.round(8 + (110 - 8) * t);
    const g = Math.round(168 + (231 - 168) * t);
    const b = Math.round(107 + (183 - 107) * t);
    return `rgb(${r},${g},${b})`;
  };

  let pct = 0;
  let scanPhase = 0;
  let lastFlick = 0;
  let target = 0;
  let cancelled = false;
  let rafId = 0;
  const timers: number[] = [];
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // Static frame for reduced-motion: a calm, non-flickering spectrogram.
  const paintStatic = () => {
    scan.style.left = `calc(50% - 32px)`;
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const energy = r < 4 ? 0.8 : r < 7 ? 0.45 : 0.2;
        const cell = cells[c][r];
        cell.style.opacity = (0.12 + energy * 0.7).toFixed(2);
        cell.style.transform = `scaleY(${(0.5 + energy * 0.5).toFixed(2)})`;
        cell.style.backgroundColor = gcol(Math.min(1, 0.4 + (r / ROWS) * 0.5));
      }
    }
  };

  const frame = (ts: number) => {
    if (cancelled) return;
    scanPhase += 0.0065;
    if (scanPhase > 1) scanPhase -= 1;
    scan.style.left = `calc(${scanPhase * 100}% - 32px)`;
    const headCol = Math.round(scanPhase * COLS);

    if (ts - lastFlick > 55) {
      lastFlick = ts;
      const crystal = pct / 100;
      for (let c = 0; c < COLS; c++) {
        let d = Math.abs(c - headCol);
        if (d > COLS / 2) d = COLS - d;
        const near = Math.max(0, 1 - d / 6);
        const solved = c < crystal * COLS;
        for (let r = 0; r < ROWS; r++) {
          const base = Math.random();
          let energy = base * 0.5 + near * 0.6;
          if (solved) {
            const harm = r < 4 ? 0.85 : r < 7 ? 0.45 : 0.18;
            energy = harm * (0.8 + 0.2 * base) + near * 0.35;
          }
          const cell = cells[c][r];
          cell.style.opacity = Math.min(1, 0.05 + energy * 0.95).toFixed(2);
          cell.style.transform = `scaleY(${(0.45 + energy * 0.55).toFixed(2)})`;
          const t = Math.min(1, (solved ? 0.7 : 0.15) + near * 0.4 + (r / ROWS) * 0.15);
          cell.style.backgroundColor = gcol(t);
        }
      }
    }
    rafId = requestAnimationFrame(frame);
  };
  // Under prefers-reduced-motion, paint one static frame instead of the
  // per-frame flicker loop; the fill % + chord lighting still progress below.
  if (reduce) paintStatic();
  else rafId = requestAnimationFrame(frame);

  const setPct = (p: number) => {
    pct = p;
    numEl.textContent = String(Math.floor(p));
    fill.style.width = p + "%";
    for (const ch of chordEls) {
      if (!ch.lit && p >= ch.thr) {
        ch.lit = true;
        ch.el.classList.add("lit");
      }
    }
  };

  const nudge = () => {
    if (cancelled) return;
    target = Math.min(99, target + 6 + Math.random() * 16);
    if (target >= 99) {
      timers.push(
        window.setTimeout(() => {
          for (const ch of chordEls) {
            ch.lit = false;
            ch.el.classList.remove("lit");
          }
          target = 0;
          setPct(0);
        }, 900),
      );
    }
    timers.push(window.setTimeout(nudge, 380 + Math.random() * 520));
  };
  timers.push(window.setTimeout(nudge, 250));

  timers.push(
    window.setInterval(() => {
      if (cancelled) return;
      if (pct < target) setPct(pct + Math.max(0.4, (target - pct) * 0.12));
    }, 30),
  );

  const phrases = ["Getting the video…", "Finding the chords…", "Mapping the harmony…", "Finding the chords…"];
  let widx = 0;
  timers.push(
    window.setInterval(() => {
      if (cancelled) return;
      const cur = wordsBox.querySelector(".cm-word") as HTMLElement | null;
      widx = (widx + 1) % phrases.length;
      const next = document.createElement("span");
      next.className = "cm-word down";
      next.textContent = phrases[widx];
      wordsBox.appendChild(next);
      void next.offsetWidth;
      if (cur) {
        cur.classList.remove("in");
        cur.classList.add("up");
      }
      next.classList.remove("down");
      next.classList.add("in");
      timers.push(
        window.setTimeout(() => {
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        }, 600),
      );
    }, 2600),
  );

  setPct(0);

  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    for (const id of timers) {
      clearTimeout(id);
      clearInterval(id);
    }
  };
}
