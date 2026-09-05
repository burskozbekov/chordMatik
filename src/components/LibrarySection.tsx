import { motion } from "motion/react";
import { useAppState } from "../state/AppState";
import { formatTime } from "../lib/format";
import { ChordMarkIcon, CloseIcon } from "./icons";

/** Short label for the engine that produced a cached analysis. */
function engineLabel(engine: string): string {
  if (engine === "chordnet") return "ChordNet";
  if (engine === "btc") return "BTC";
  return "built-in";
}

/** "Recent songs" list backed by the on-disk analysis cache. */
export function LibrarySection() {
  const { library, openPath, removeFromLibrary } = useAppState();
  if (library.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.18, ease: [0.19, 1, 0.22, 1] }}
      className="w-full"
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground">Recent songs</h2>
        <span className="text-xs text-muted">{library.length} cached</span>
      </div>

      <div className="glass divide-y divide-border/50 overflow-hidden rounded-2xl">
        {library.map((item) => (
          <div
            key={item.hash}
            className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-hover"
          >
            <button
              type="button"
              onClick={() => void openPath(item.path)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-sky/12 text-brand-sky-strong dark:text-brand-sky">
                <ChordMarkIcon className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {item.name}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {formatTime(item.durationSec)} · {item.chordCount} chords ·{" "}
                  {engineLabel(item.engine)}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.name} from library`}
              onClick={() => void removeFromLibrary(item.hash)}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
            >
              <CloseIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
