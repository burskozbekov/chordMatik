/**
 * Update state shared by the silent startup check and the manual
 * "Check for updates" button, so the two can never run (or download) twice.
 *
 * A tiny module-level store instead of context: the updater is a singleton
 * concern and both consumers live in different parts of the tree.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./tauri";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "uptodate"
  | "downloading"
  | "ready"
  | "error";

export interface UpdaterState {
  phase: UpdatePhase;
  /** Version being installed, when known. */
  version: string | null;
  error: string | null;
  /** 0–1 while downloading (0 when the server sends no content-length). */
  progress: number;
}

let state: UpdaterState = { phase: "idle", version: null, error: null, progress: 0 };
const listeners = new Set<(s: UpdaterState) => void>();
let busy = false;

function set(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function getUpdaterState(): UpdaterState {
  return state;
}

export function subscribeUpdater(cb: (s: UpdaterState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

/** Reset a transient result ("up to date" / error) back to idle. */
export function clearUpdateResult() {
  if (state.phase === "uptodate" || state.phase === "error") {
    set({ phase: "idle", error: null });
  }
}

/**
 * Check GitHub Releases and, if a newer signed build exists, download + stage it.
 * `silent` (startup) hides the "already up to date" and error states so a bad
 * network never nags; the manual button passes `false` to surface everything.
 */
export async function runUpdateCheck(silent = false): Promise<void> {
  if (!isTauri() || busy) return;
  busy = true;
  set({ phase: "checking", error: null, progress: 0 });
  try {
    const update: Update | null = await check();
    if (!update) {
      set({ phase: silent ? "idle" : "uptodate", version: null });
      return;
    }
    set({ phase: "downloading", version: update.version, progress: 0 });

    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") {
        total = e.data.contentLength ?? 0;
      } else if (e.event === "Progress") {
        downloaded += e.data.chunkLength;
        if (total > 0) set({ progress: Math.min(1, downloaded / total) });
      } else if (e.event === "Finished") {
        set({ progress: 1 });
      }
    });
    set({ phase: "ready" });
  } catch (err) {
    // An update failure must never block the app.
    console.warn("[updater] check/install failed:", err);
    set({ phase: silent ? "idle" : "error", error: String(err) });
  } finally {
    busy = false;
  }
}

/** Relaunch so a staged update takes effect immediately. */
export async function restartForUpdate(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
