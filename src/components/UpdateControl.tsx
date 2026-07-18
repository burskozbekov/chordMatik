import { useEffect, useState } from "react";
import { appInfo, isTauri } from "../lib/tauri";
import type { AppMeta } from "../lib/types";
import { RestartIcon } from "./icons";
import {
  clearUpdateResult,
  getUpdaterState,
  restartForUpdate,
  runUpdateCheck,
  subscribeUpdater,
  type UpdaterState,
} from "../lib/updater";

/**
 * The visible update control (top bar). The app also checks silently on launch,
 * but without this there was no way to see which version you're on, force a
 * check, or find out that a check failed.
 *
 * Idle it shows the current version — click to check. When an update is staged
 * it becomes an unmissable "Restart" pill.
 */
export function UpdateControl() {
  const [s, setS] = useState<UpdaterState>(getUpdaterState);
  const [meta, setMeta] = useState<AppMeta | null>(null);

  useEffect(() => subscribeUpdater(setS), []);
  useEffect(() => {
    if (isTauri()) appInfo().then(setMeta).catch(() => {});
  }, []);

  // Let a transient result fade back to the version button.
  useEffect(() => {
    if (s.phase !== "uptodate" && s.phase !== "error") return;
    const t = window.setTimeout(clearUpdateResult, 5000);
    return () => window.clearTimeout(t);
  }, [s.phase]);

  if (!isTauri()) return null;

  const base =
    "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors";

  if (s.phase === "checking") {
    return (
      <span className={`${base} text-muted`}>
        <span className="size-3 animate-spin rounded-full border border-muted/40 border-t-muted" />
        Checking…
      </span>
    );
  }

  if (s.phase === "downloading") {
    return (
      <span className={`${base} text-foreground`}>
        <span className="size-2 animate-pulse rounded-full bg-brand-sky-strong" />
        Updating{s.progress > 0 ? ` ${Math.round(s.progress * 100)}%` : "…"}
      </span>
    );
  }

  if (s.phase === "ready") {
    return (
      <button
        type="button"
        onClick={() => void restartForUpdate()}
        title={`Update ${s.version ?? ""} is ready — restart to apply`}
        className="cta-gradient inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold"
      >
        <RestartIcon className="size-3.5" />
        Restart to update
      </button>
    );
  }

  if (s.phase === "uptodate") {
    return <span className={`${base} text-muted`}>Up to date ✓</span>;
  }

  if (s.phase === "error") {
    return (
      <button
        type="button"
        onClick={() => void runUpdateCheck(false)}
        title={s.error ?? "Update check failed"}
        className={`${base} text-danger hover:bg-surface-hover`}
      >
        Check failed · retry
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void runUpdateCheck(false)}
      title="Check for updates"
      className={`${base} text-muted hover:bg-surface-hover hover:text-foreground`}
    >
      <RestartIcon className="size-3.5" />
      {meta ? `v${meta.version}` : "Updates"}
    </button>
  );
}
