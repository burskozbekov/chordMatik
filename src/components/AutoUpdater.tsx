import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { isTauri } from "../lib/tauri";

type Phase = "idle" | "downloading" | "ready" | "error";

/**
 * Silent auto-updater. On startup it asks GitHub Releases whether a newer
 * *signed* build exists; if so it downloads + installs it in the background.
 * The update applies the next time the app is launched — no prompts, no forced
 * restart (the app's update policy is "fully automatic"). A small passive pill
 * briefly confirms when an update was staged; failures are swallowed so a bad
 * network / missing release never disrupts the app.
 *
 * Note: this only does anything in a *bundled, signed* build — under
 * `npm run tauri dev` `check()` simply errors (caught + ignored).
 */
export function AutoUpdater() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const update = await check();
        if (!update || cancelled) return;
        setVersion(update.version);
        setPhase("downloading");
        await update.downloadAndInstall();
        if (!cancelled) setPhase("ready");
      } catch (err) {
        // Best-effort: an update failure must never block the app.
        console.warn("[updater] check/install failed:", err);
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-dismiss the "ready" pill after a few seconds (passive, not a prompt).
  useEffect(() => {
    if (phase !== "ready") return;
    const t = window.setTimeout(() => setPhase("idle"), 6000);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase !== "downloading" && phase !== "ready") return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] -translate-x-1/2">
      <div className="glass flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-foreground shadow-overlay">
        {phase === "downloading" ? (
          <>
            <span className="size-2 animate-pulse rounded-full bg-brand-sky-strong" />
            Downloading update{version ? ` ${version}` : ""}…
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
