import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBassTab,
  fetchBassTabContent,
  openExternal,
  type RatedBassTab as RatedBassTabData,
} from "../lib/tauri";
import { useAppState } from "../state/AppState";

/** Five stars filled to the nearest whole rating (out of 5). */
function Stars({ rating }: { rating: number }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="text-[var(--accent)]" title={`${rating.toFixed(2)} / 5`}>
      {"★".repeat(full)}
      <span className="text-muted">{"★".repeat(5 - full)}</span>
    </span>
  );
}

/**
 * Shows the highest-RATED community bass tab (Ultimate Guitar) for a song title,
 * as plain ASCII. A real, human-made, star-rated tab — not our on-device guess.
 * Independent of Songsterr, so it works even when the file's title is off.
 */
export function RatedBassTab({ title }: { title: string }) {
  const { engine, songStartSec, song } = useAppState();
  const [data, setData] = useState<RatedBassTabData | null>(null);
  const [state, setState] = useState<"loading" | "done" | "none">("loading");
  const [content, setContent] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pickError, setPickError] = useState(false);
  // Off by default: a plain-text tab has no timing, so this proportional scroll
  // is only a rough aid — the structured (Songsterr) tab is the one that follows.
  const [follow, setFollow] = useState(false);
  const [curLine, setCurLine] = useState(-1);
  // Bumped on every song change; async results from a stale song are dropped.
  const genRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLineRef = useRef(-1);

  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    setState("loading");
    setData(null);
    setContent("");
    setActiveId(null);
    setSwitching(false);
    setPickError(false);
    fetchBassTab(title).then((d) => {
      if (gen !== genRef.current) return; // song changed mid-fetch
      if (d) {
        setData(d);
        setContent(d.content);
        setActiveId(d.id);
        setState("done");
      } else {
        setState("none");
      }
    });
  }, [title]);

  const active = useMemo(
    () => data?.versions.find((v) => v.id === activeId) ?? data,
    [data, activeId],
  );

  const lines = useMemo(() => content.split("\n"), [content]);
  // Group non-blank lines into blocks (tab systems / sections) so the highlight
  // covers the whole current system, not a single string line.
  const blockOf = useMemo(() => {
    const ids: number[] = [];
    let b = -1;
    let prevBlank = true;
    for (const ln of lines) {
      if (ln.trim() === "") {
        ids.push(-1);
        prevBlank = true;
      } else {
        if (prevBlank) b += 1;
        ids.push(b);
        prevBlank = false;
      }
    }
    return ids;
  }, [lines]);
  const curBlock = curLine >= 0 ? blockOf[curLine] ?? -1 : -1;

  // Follow playback: scroll + highlight the current system, proportional to the
  // song's progress. A plain-text community tab carries no timing, so this maps
  // the whole song uniformly onto the tab — an approximate cursor, not the
  // note-exact one the structured (Songsterr) tab has.
  useEffect(() => {
    if (!follow || lines.length < 2) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dur = song?.info.durationSec ?? 0;
      if (!engine.isPlaying || dur <= songStartSec) return;
      const prog = (engine.getTime() - songStartSec) / (dur - songStartSec);
      const idx = Math.max(0, Math.min(lines.length - 1, Math.floor(prog * lines.length)));
      if (idx === lastLineRef.current) return;
      lastLineRef.current = idx;
      setCurLine(idx);
      const cont = scrollRef.current;
      const el = cont?.children[idx] as HTMLElement | undefined;
      if (cont && el) {
        cont.scrollTo({ top: el.offsetTop - cont.clientHeight / 2, behavior: "smooth" });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [follow, engine, song, songStartSec, lines.length]);

  const pickVersion = async (id: number) => {
    if (!data || id === activeId || switching) return;
    const gen = genRef.current;
    setSwitching(true);
    setPickError(false);
    const c = await fetchBassTabContent(id);
    if (gen !== genRef.current) return; // song changed mid-fetch — drop stale result
    setSwitching(false);
    if (c) {
      setContent(c);
      setActiveId(id);
    } else {
      setPickError(true);
    }
  };

  if (state === "loading") {
    return (
      <div className="grid h-24 place-items-center text-xs text-muted">
        Finding the top-rated bass tab…
      </div>
    );
  }
  if (state === "none" || !data) {
    return (
      <div className="grid h-24 place-items-center px-4 text-center text-xs text-muted">
        No community bass tab found for “{title}”.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-foreground">
          {active?.artist} — {active?.song}
        </span>
        <span className="flex items-center gap-1">
          <Stars rating={active?.rating ?? 0} />
          <span className="text-muted">
            {(active?.rating ?? 0).toFixed(2)} · {active?.votes ?? 0} votes
          </span>
        </span>
        {data.versions.length > 1 && (
          <label className="flex items-center gap-1 text-muted">
            Version
            <select
              value={activeId ?? ""}
              onChange={(e) => pickVersion(Number(e.target.value))}
              className="rounded border border-border/70 bg-surface px-1 py-0.5 text-foreground"
            >
              {data.versions.map((v, i) => (
                <option key={v.id} value={v.id}>
                  #{i + 1} · ★{v.rating.toFixed(1)} ({v.votes})
                </option>
              ))}
            </select>
          </label>
        )}
        {pickError && <span className="text-[var(--danger,#e5484d)]">· that version has no tab</span>}
        <label
          className="flex items-center gap-1 text-muted"
          title="Auto-scroll + highlight the tab as the song plays (proportional to progress)"
        >
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button
          type="button"
          onClick={() => openExternal(data.url || `https://tabs.ultimate-guitar.com/tab/${data.id}`)}
          className="text-muted underline transition-colors hover:text-foreground"
        >
          Ultimate Guitar ↗
        </button>
      </div>
      <div
        ref={scrollRef}
        className={`tab-scroll max-h-[520px] overflow-auto rounded-lg bg-surface/60 p-3 font-mono text-[12px] leading-[1.55] text-foreground transition-opacity ${
          switching ? "opacity-40" : ""
        }`}
      >
        {lines.map((ln, i) => (
          <div
            key={i}
            className={
              blockOf[i] >= 0 && blockOf[i] === curBlock
                ? "whitespace-pre rounded-sm bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]"
                : "whitespace-pre"
            }
          >
            {ln || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
