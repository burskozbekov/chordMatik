import { useEffect, useState } from "react";
import { appInfo, isTauri } from "../lib/tauri";
import type { AppMeta } from "../lib/types";
import { ShieldIcon } from "./icons";

/**
 * Slim status footer: privacy reassurance + version/OS.
 * NOTE: currently not mounted in `App.tsx` — the update control that used to
 * live here now sits in the top bar (`UpdateControl`).
 */
export function Footer() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  useEffect(() => {
    if (isTauri()) appInfo().then(setMeta).catch(() => {});
  }, []);

  return (
    <footer className="flex items-center justify-center gap-2 border-t border-border/40 bg-surface/20 px-4 py-1.5 text-[11px] text-muted backdrop-blur-sm">
      <ShieldIcon className="size-3" />
      <span>100% on-device · private by design</span>
      {meta && (
        <>
          <span className="opacity-50">·</span>
          <span className="tabular-nums">v{meta.version}</span>
          <span className="opacity-50">·</span>
          <span>{meta.os}</span>
        </>
      )}
    </footer>
  );
}
