import { useEffect, useRef, useState } from "react";
import { useAppState } from "../state/AppState";
import { cleanupTempAudio } from "../lib/tauri";
import { CloseIcon } from "./icons";

interface SongTab {
  path: string;
  name: string;
  videoId?: string;
}

const TABS_KEY = "chordmatik:tabs";
const SESS_LIST = "chordmatik:sessions";
const sessKey = (n: string) => `chordmatik:session:${n}`;

function load<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function persist(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota / disabled */
  }
}

/**
 * Multi-song tabs + saveable sessions. Each loaded song becomes a tab; switching
 * re-opens it (local file via openPath, YouTube via its videoId — reusing the
 * cached download/analysis, so it's instant). A "session" is a named snapshot of
 * the open tabs, persisted to localStorage so you can reopen it later and resume.
 */
export function SongTabs() {
  const { song, songVideoId, openTab, reset } = useAppState();
  const [tabs, setTabs] = useState<SongTab[]>(() => load(TABS_KEY, []));
  const [sessions, setSessions] = useState<string[]>(() => load(SESS_LIST, []));
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const vidRef = useRef<string | null>(null);
  vidRef.current = songVideoId;
  const lastPathRef = useRef<string | null>(null);

  // Upsert the active song into the tab list: a newly-opened song moves to the
  // end; a RENAME of the current song (same path, new name) updates its label in
  // place — the strip used to keep showing the old title until the next switch.
  useEffect(() => {
    if (!song) return;
    const switched = lastPathRef.current !== song.path;
    lastPathRef.current = song.path;
    setTabs((prev) => {
      const entry = { path: song.path, name: song.name, videoId: vidRef.current ?? undefined };
      const idx = prev.findIndex((t) => t.path === song.path);
      const next =
        idx >= 0 && !switched
          ? prev.map((t, i) => (i === idx ? { ...t, ...entry } : t))
          : [...prev.filter((t) => t.path !== song.path), entry];
      persist(TABS_KEY, next);
      return next;
    });
  }, [song?.path, song?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restores instantly from the in-session memory cache if already loaded;
  // otherwise loads it (YouTube via id, local via path) — see AppState.openTab.
  const switchTo = (t: SongTab) => {
    void openTab(t);
  };

  const closeTab = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      persist(TABS_KEY, next);
      return next;
    });
  };

  const clearAllTabs = () => {
    setTabs([]);
    persist(TABS_KEY, []);
    setConfirmClear(false);
    // This is the EXPLICIT "delete everything" action: unload the current song
    // (so its file isn't in use), drop to the empty screen, and permanently
    // delete every downloaded/captured file to free the disk. (Normal quit/close
    // keeps them, so reopening tabs stays instant — only Clear all wipes them.)
    reset();
    void cleanupTempAudio().catch(() => {});
  };

  const saveSession = () => {
    const name = saveName.trim();
    if (!name) return;
    persist(sessKey(name), tabs);
    setSessions((prev) => {
      const next = prev.includes(name) ? prev : [...prev, name];
      persist(SESS_LIST, next);
      return next;
    });
    setSaveName("");
    setMenuOpen(false);
  };

  const openSession = (name: string) => {
    const saved = load<SongTab[]>(sessKey(name), []);
    setMenuOpen(false);
    if (!saved.length) return;
    setTabs(saved);
    persist(TABS_KEY, saved);
    switchTo(saved[saved.length - 1]); // resume on the last-active song
  };

  const deleteSession = (name: string) => {
    try {
      localStorage.removeItem(sessKey(name));
    } catch {
      /* */
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s !== name);
      persist(SESS_LIST, next);
      return next;
    });
  };

  // Cmd+T = new tab (blank slate to add a song); Cmd+W = close the active tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey) return;
      if (e.code === "KeyT") {
        e.preventDefault();
        reset();
      } else if (e.code === "KeyW") {
        e.preventDefault();
        const cur = song;
        if (!cur) return;
        const idx = tabs.findIndex((t) => t.path === cur.path);
        const next = idx >= 0 ? tabs[idx + 1] ?? tabs[idx - 1] : undefined;
        closeTab(cur.path);
        if (next) switchTo(next);
        else reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, tabs]);

  if (tabs.length === 0 && sessions.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      <div className="tab-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5">
        {tabs.map((t) => {
          const active = song?.path === t.path;
          return (
            <div
              key={t.path}
              className={`group flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${
                active
                  ? "border-transparent bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] font-semibold text-foreground"
                  : "border-border/70 bg-surface/50 text-muted hover:text-foreground"
              }`}
            >
              <button type="button" onClick={() => switchTo(t)} className="max-w-[14rem] truncate">
                {t.videoId ? "▶ " : ""}
                {t.name}
              </button>
              <button
                type="button"
                aria-label="Close tab"
                title="Remove this tab"
                onClick={() => closeTab(t.path)}
                className="grid size-4 shrink-0 place-items-center rounded text-muted/70 transition-colors hover:bg-danger/15 hover:text-danger"
              >
                <CloseIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Clear all — guarded by an inline confirmation (tabs are costly to reload). */}
      {tabs.length > 0 &&
        (confirmClear ? (
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1 text-xs">
            <span className="font-semibold text-foreground">
              Delete all {tabs.length} + their downloads?
            </span>
            <button
              type="button"
              onClick={clearAllTabs}
              title="Permanently deletes every tab AND every downloaded file (frees disk) — you'll have to re-download them"
              className="rounded-md bg-danger px-2 py-0.5 font-semibold text-white"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="rounded-md px-1.5 py-0.5 font-semibold text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            title="Remove all tabs"
            className="shrink-0 rounded-lg border border-border/70 bg-surface/50 px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
          >
            Clear all
          </button>
        ))}

      {/* Sessions menu */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-lg border border-border/70 bg-surface/50 px-2 py-1 text-xs font-semibold text-muted hover:text-foreground"
        >
          Sessions ▾
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-xl border border-border/70 bg-surface p-2 shadow-overlay">
            <div className="flex items-center gap-1">
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveSession()}
                placeholder="Save current tabs as…"
                className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1 text-xs outline-none"
              />
              <button
                type="button"
                onClick={saveSession}
                className="cta-gradient rounded-md px-2 py-1 text-xs font-semibold"
              >
                Save
              </button>
            </div>
            {sessions.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5 border-t border-border/50 pt-2">
                {sessions.map((s) => (
                  <div key={s} className="group flex items-center justify-between rounded-md px-1.5 py-1 text-xs hover:bg-background">
                    <button type="button" onClick={() => openSession(s)} className="min-w-0 flex-1 truncate text-left font-medium text-foreground">
                      {s}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete session ${s}`}
                      onClick={() => deleteSession(s)}
                      className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-60"
                    >
                      <CloseIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
