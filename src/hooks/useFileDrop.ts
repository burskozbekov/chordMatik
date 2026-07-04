import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface FileDropHandlers {
  onDrop: (paths: string[]) => void;
  onOverChange?: (isOver: boolean) => void;
}

/**
 * Subscribe to Tauri's native file drag-and-drop. The OS-level drop is handled
 * by Tauri (not HTML5 DnD), which is the only way to get real file paths.
 * No-ops gracefully when not running inside Tauri (e.g. browser preview).
 */
export function useFileDrop({ onDrop, onOverChange }: FileDropHandlers) {
  // Keep latest callbacks without resubscribing.
  const dropRef = useRef(onDrop);
  const overRef = useRef(onOverChange);
  dropRef.current = onDrop;
  overRef.current = onOverChange;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const webview = getCurrentWebview();
        const un = await webview.onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            overRef.current?.(true);
          } else if (p.type === "leave") {
            overRef.current?.(false);
          } else if (p.type === "drop") {
            overRef.current?.(false);
            dropRef.current(p.paths ?? []);
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* not in Tauri — drag & drop unavailable */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
