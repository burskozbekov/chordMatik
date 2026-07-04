import { useEffect, useRef } from "react";

/** One undoable sync calibration snapshot: start (s), tempo (BPM), drift on/off. */
interface Snapshot {
  s: number;
  b: number;
  d: boolean;
}

/**
 * Undo/redo history for a tab's sync calibration (start / tempo / drift), keyed by
 * `syncKey` so each (recording, tab, instrument) has its own timeline.
 *
 * Cmd+Z steps back, Cmd+Shift+Z forward — a fat-fingered nudge or a bad auto-guess
 * is always recoverable. Rapid nudges within 500 ms coalesce into one step; the
 * stack is capped at 200; an undo-applied change never re-records itself (the
 * `applying` guard). Extracted verbatim from TabsPanel — behaviour-identical.
 */
export function useSyncHistory(
  syncKey: string | null,
  startSec: number,
  bpm: number,
  drift: boolean,
  apply: (s: Snapshot) => void,
) {
  const histRef = useRef<{
    key: string | null;
    stack: Snapshot[];
    idx: number;
    applying: boolean;
    lastPush: number;
  }>({ key: null, stack: [], idx: -1, applying: false, lastPush: 0 });

  // Record each committed (start, bpm, drift) change into the history.
  useEffect(() => {
    const h = histRef.current;
    if (h.key !== syncKey) {
      h.key = syncKey;
      h.stack = [{ s: startSec, b: bpm, d: drift }];
      h.idx = 0;
      h.applying = false;
      h.lastPush = 0;
      return;
    }
    if (h.applying) {
      h.applying = false;
      return;
    }
    const cur = h.stack[h.idx];
    if (cur && cur.s === startSec && cur.b === bpm && cur.d === drift) return;
    const now = Date.now();
    h.stack.splice(h.idx + 1); // a new edit clears the redo tail
    if (now - h.lastPush < 500 && h.idx > 0) {
      h.stack[h.idx] = { s: startSec, b: bpm, d: drift }; // coalesce rapid nudges
    } else {
      h.stack.push({ s: startSec, b: bpm, d: drift });
      h.idx++;
    }
    h.lastPush = now;
    if (h.stack.length > 200) {
      h.stack.shift();
      h.idx--;
    }
  }, [syncKey, startSec, bpm, drift]);

  // Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo), except while typing.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const step = (s: Snapshot) => {
      histRef.current.applying = true;
      applyRef.current(s);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const h = histRef.current;
      if (e.shiftKey) {
        if (h.idx < h.stack.length - 1) {
          h.idx++;
          step(h.stack[h.idx]);
        }
      } else if (h.idx > 0) {
        h.idx--;
        step(h.stack[h.idx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
