import { useEffect, useState } from "react";
import { isTauri } from "../lib/tauri";
import {
  getUpdaterState,
  runUpdateCheck,
  subscribeUpdater,
  type UpdaterState,
} from "../lib/updater";

/**
 * Silent startup updater. On launch it asks GitHub Releases whether a newer
 * *signed* build exists; if so it downloads + stages it in the background. The
 * update applies on the next launch — no prompts, no forced restart. A small
 * passive pill confirms when one was staged; failures are swallowed so a bad
 * network / missing release never disrupts the app.
 *
 * The manual "Check for updates" control lives in the footer and shares the
 * same store (`lib/updater`), so the two never run or download twice.
 *
 * Note: only does anything in a *bundled, signed* build — under
 * `npm run tauri dev` `check()` simply errors (caught + ignored).
 */
export function AutoUpdater() {
  const [s, setS] = useState<UpdaterState>(getUpdaterState);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeUpdater(setS), []);

  useEffect(() => {
    if (!isTauri()) return;
    void runUpdateCheck(true); // silent: no "up to date" / error noise on launch
    // People leave the app open for days — check again every 6 hours so a new
    // release still reaches them without a relaunch (the store dedupes runs).
    const id = window.setInterval(() => void runUpdateCheck(true), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-dismiss the "ready" pill (passive, not a prompt).
  useEffect(() => {
    if (s.phase !== "ready") return;
    setDismissed(false);
    const t = window.setTimeout(() => setDismissed(true), 8000);
    return () => window.clearTimeout(t);
  }, [s.phase]);

  const show = s.phase === "downloading" || (s.phase === "ready" && !dismissed);
  if (!show) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] -translate-x-1/2">
      <div className="glass flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-foreground shadow-overlay">
        {s.phase === "downloading" ? (
          <>
            <span className="size-2 animate-pulse rounded-full bg-brand-sky-strong" />
            Downloading update{s.version ? ` ${s.version}` : ""}
            {s.progress > 0 ? ` · ${Math.round(s.progress * 100)}%` : "…"}
          </>
        ) : (
          <>
            <span className="size-2 rounded-full bg-brand-sky" />
            Update ready · applies on next launch
          </>
        )}
      </div>
    </div>
  );
}
