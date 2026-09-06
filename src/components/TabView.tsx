import { useEffect, useRef } from "react";
import * as alphaTab from "@coderline/alphatab";
import { songsterrToScore, type TabKind } from "../lib/songsterrToScore";
import { useAppState } from "../state/AppState";
import type { SongsterrTrack } from "../lib/types";
import type { SyncAnchor } from "../lib/tabSync";

interface ExtOutput {
  handler: unknown;
  updatePosition(currentTimeMs: number): void;
}

/** Which staves to show: tab/notation for guitar+bass, notation-only for piano+drums. */
function profileFor(kind: TabKind, notation: boolean): alphaTab.StaveProfile {
  if (kind === "drums" || kind === "piano") return alphaTab.StaveProfile.Score;
  return notation ? alphaTab.StaveProfile.ScoreTab : alphaTab.StaveProfile.Tab;
}

/**
 * Renders one Songsterr track as tablature (AlphaTab) and syncs the playback
 * cursor to chordMatik's audio via AlphaTab's EXTERNAL-MEDIA mode.
 *
 * Two sync modes:
 *  - AUTO: `syncPoints` (FlatSyncPoint anchors from chord-DTW) are applied to the
 *    score; we feed raw recording time and AlphaTab warps tick<->ms between anchors,
 *    following tempo drift. `offsetSec` is a global fine-tune nudge.
 *  - FALLBACK (no/low-confidence anchors): the old linear map
 *    tabTime = (recTime - offsetSec) * rate.
 *
 * Layout is HORIZONTAL + lazy so only visible bars lay out (workers don't resolve
 * under tauri://, so everything is on the main thread — page layout froze on long
 * tabs). Driven from engine.subscribe() so it works for both engines.
 */
export function TabView({
  track,
  title,
  offsetSec,
  rate,
  syncPoints,
  kind = "guitar",
  notation = false,
  customBytes,
  customTrackIndex = 0,
  onTracks,
  onBarClick,
  barScores,
}: {
  track?: SongsterrTrack | null;
  title?: string;
  offsetSec: number;
  rate: number;
  syncPoints: SyncAnchor[] | null;
  kind?: TabKind;
  notation?: boolean;
  /** Raw Guitar Pro / MusicXML bytes — AlphaTab loads natively (all tracks + notation). */
  customBytes?: Uint8Array;
  customTrackIndex?: number;
  /** Reports the loaded file's track names (for the track picker). */
  onTracks?: (names: string[]) => void;
  /** Fires with the BAR index the user clicked in the tab (⚓ pin-bar mode). */
  onBarClick?: (barIndex: number) => void;
  /** Audio-verified bars: per-bar agreement 0–1 with the recording (null = no
   *  verdict), drawn as a coloured strip above each bar. */
  barScores?: (number | null)[] | null;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { engine } = useAppState();
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const scoreRef = useRef<alphaTab.model.Score | null>(null);
  const onTracksRef = useRef(onTracks);
  onTracksRef.current = onTracks;
  const onBarClickRef = useRef(onBarClick);
  onBarClickRef.current = onBarClick;
  const outputRef = useRef<ExtOutput | null>(null);
  const wiredRef = useRef(false);
  // While re-rendering/re-laying-out a score, AlphaTab resets its player to bar 1
  // and would pause/seek our engine via the handler — suppress that so playback
  // continues. A DEADLINE (not a boolean) so overlapping render+notation toggles
  // can't un-suppress each other early.
  const suppressUntilRef = useRef(0);
  const offsetRef = useRef(offsetSec);
  offsetRef.current = offsetSec;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const syncRef = useRef(syncPoints);
  syncRef.current = syncPoints;
  const scoresRef = useRef<(number | null)[] | null>(barScores ?? null);
  scoresRef.current = barScores ?? null;
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Paint the audio-verified strips: one per bar, placed from AlphaTab's bar
  // bounds (surface pixels, the same frame its own cursor uses), in an overlay
  // that lives inside the AlphaTab element so it scrolls with the score.
  const paintScores = () => {
    const el = elRef.current;
    const api = apiRef.current;
    if (!el || !api) return;
    let overlay = overlayRef.current;
    if (!overlay || overlay.parentElement !== el) {
      overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "5";
      el.appendChild(overlay);
      overlayRef.current = overlay;
    }
    overlay.replaceChildren();
    const scores = scoresRef.current;
    const lookup = api.boundsLookup;
    if (!scores || !lookup) return;
    for (const sys of lookup.staffSystems) {
      for (const mb of sys.bars) {
        const s = scores[mb.index];
        if (s == null) continue;
        const b = mb.visualBounds;
        const strip = document.createElement("div");
        strip.style.position = "absolute";
        strip.style.left = `${b.x}px`;
        strip.style.top = `${Math.max(0, b.y - 7)}px`;
        strip.style.width = `${Math.max(2, b.w - 2)}px`;
        strip.style.height = "4px";
        strip.style.borderRadius = "9999px";
        strip.style.opacity = "0.9";
        strip.style.pointerEvents = "auto";
        strip.style.background = s >= 0.62 ? "var(--accent)" : s >= 0.45 ? "#f59e0b" : "#ef4444";
        strip.title = `Bar ${mb.index + 1}: ${Math.round(s * 100)}% of its notes fit the chords the recording plays here`;
        overlay.appendChild(strip);
      }
    }
  };

  // Recording time (s) → tab time (s) fed to updatePosition.
  const mapTime = (t: number) => {
    if (syncRef.current && syncRef.current.length > 0) return Math.max(0, t - offsetRef.current);
    return Math.max(0, (t - offsetRef.current) * rateRef.current);
  };

  // Create the AlphaTab API + wire it to our engine ONCE. Switching guitar/bass
  // (or any track) must NOT tear this down — re-creating the whole API runs a
  // synchronous render that froze the UI. The score is (re)rendered separately.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let unsub: (() => void) | null = null;
    let poll = 0;
    let lastPush = 0;

    const wire = () => {
      const a = apiRef.current;
      if (wiredRef.current || !a) return;
      const output = a.player?.output as unknown as ExtOutput | undefined;
      if (!output || typeof output.updatePosition !== "function") return;
      // CRITICAL: don't wire until the media's duration is known. AlphaTab's
      // external-media player reads backingTrackDuration on wiring; a 0 duration
      // reads as an empty/finished track, so it immediately pause/seeks our engine
      // — locking playback (no sound, time never advances). The poll retries until
      // the media's loadedmetadata fires and duration > 0.
      if (!(engineRef.current.duration > 0)) return;
      wiredRef.current = true;
      outputRef.current = output;
      try {
        a.updateSyncPoints();
      } catch {
        /* */
      }

      output.handler = {
        get backingTrackDuration() {
          // Never report 0 — AlphaTab treats a 0-length backing track as finished
          // and stops driving playback. Fall back to a "very long" value.
          const d = engineRef.current.duration;
          return (Number.isFinite(d) && d > 0 ? d : 36000) * 1000;
        },
        // Track the practice speed so AlphaTab's animated beat cursor extrapolates
        // at the RIGHT rate between our position updates — a hard-coded 1 made the
        // cursor lag then jerk at 1.5×/2× playback.
        get playbackRate() {
          return engineRef.current.playbackRate || 1;
        },
        masterVolume: 1,
        seekTo: (ms: number) => {
          if (Date.now() >= suppressUntilRef.current)
            engineRef.current.seek(ms / 1000 + offsetRef.current);
        },
        play: () => {
          if (Date.now() >= suppressUntilRef.current) engineRef.current.play();
        },
        pause: () => {
          if (Date.now() >= suppressUntilRef.current) engineRef.current.pause();
        },
      };

      let lastT = -1;
      unsub = engineRef.current.subscribe((t: number) => {
        const now = Date.now();
        // A seek (R, chord click, lyric click…) — never throttle it, and scroll
        // the tab view to the cursor even while paused (AlphaTab only auto-
        // scrolls during playback).
        const jumped = lastT >= 0 && Math.abs(t - lastT) > 1.5;
        lastT = t;
        // Push more often at faster practice speeds so the animated cursor has
        // less to extrapolate between updates (less visible drift/stutter).
        const throttle = engineRef.current.playbackRate > 1.05 ? 20 : 40;
        if (!jumped && now - lastPush < throttle) return;
        lastPush = now;
        try {
          output.updatePosition(mapTime(t) * 1000);
        } catch {
          /* */
        }
        if (jumped) {
          window.setTimeout(() => {
            try {
              apiRef.current?.scrollToCursor();
            } catch {
              /* */
            }
          }, 60);
        }
      });

      try {
        if (engineRef.current.isPlaying) a.play();
        else a.pause();
      } catch {
        /* */
      }
    };

    try {
      const api = new alphaTab.AlphaTabApi(el, {
        core: {
          useWorkers: false,
          enableLazyLoading: true,
          smuflFontSources: new Map([
            ["woff2", "/font/Bravura.woff2"],
            ["woff", "/font/Bravura.woff"],
          ]),
        },
        display: {
          scale: 0.8,
          layoutMode: alphaTab.LayoutMode.Horizontal,
          staveProfile: profileFor(kind, notation),
        },
        player: {
          playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
          enableCursor: true,
          enableAnimatedBeatCursor: true,
          scrollMode: alphaTab.ScrollMode.Continuous,
          scrollElement: scrollRef.current ?? undefined,
          nativeBrowserSmoothScroll: false,
        },
      });
      apiRef.current = api;
      el.style.position = "relative"; // the verdict overlay is positioned inside it
      api.postRenderFinished.on(paintScores);
      api.playerReady.on(wire);
      // ⚓ pin-bar mode: report which BAR the user clicked (beat → its bar index).
      api.beatMouseDown.on((beat) => {
        try {
          const barIndex = beat?.voice?.bar?.index;
          if (typeof barIndex === "number") onBarClickRef.current?.(barIndex);
        } catch {
          /* */
        }
      });
      // Report a custom-loaded file's track names (for the track picker).
      api.scoreLoaded.on((score) => {
        scoreRef.current = score;
        try {
          onTracksRef.current?.(
            (score.tracks ?? []).map((t, i) => t.name || t.shortName || `Track ${i + 1}`),
          );
        } catch {
          /* */
        }
      });

      // Retry wiring for ~16s — long enough to also cover the media's
      // loadedmetadata (the duration gate in wire() waits for duration > 0).
      let tries = 0;
      poll = window.setInterval(() => {
        if (wiredRef.current || tries++ > 80) {
          window.clearInterval(poll);
          return;
        }
        wire();
      }, 200);
    } catch (e) {
      console.warn("[tab] init failed", e);
    }

    return () => {
      window.clearInterval(poll);
      unsub?.();
      wiredRef.current = false;
      outputRef.current = null;
      const a = apiRef.current;
      apiRef.current = null;
      scoreRef.current = null;
      try {
        a?.destroy();
      } catch {
        /* */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)render the score when the track changes — reuses the existing API, so
  // switching guitar/bass is a cheap re-render, not a full teardown + rebuild.
  // Playback keeps running: suppress the handler while AlphaTab resets the new
  // score to bar 1, then re-sync AlphaTab to the engine's live position/state.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    suppressUntilRef.current = Date.now() + 450;
    try {
      // Switching instrument (kind) re-renders here (NOT a remount, so playback
      // keeps running) — apply the right staves for the new instrument first.
      api.settings.display.staveProfile = profileFor(kind, notation);
      try {
        api.updateSettings();
      } catch {
        /* */
      }
      if (customBytes) {
        // A user file (Guitar Pro / MusicXML) — AlphaTab parses it natively, with
        // all instruments (guitar/bass/drums/piano) + notation. Render one track.
        api.load(customBytes.slice().buffer, [customTrackIndex]);
      } else if (track) {
        const score = songsterrToScore(track, title, kind);
        scoreRef.current = score;
        if (syncRef.current && syncRef.current.length > 0) {
          try {
            score.applyFlatSyncPoints(syncRef.current);
          } catch {
            /* */
          }
        }
        api.renderScore(score);
        if (wiredRef.current) {
          try {
            api.updateSyncPoints();
          } catch {
            /* */
          }
        }
      }
    } catch (e) {
      console.warn("[tab] render failed", e);
    }
    // After the new score settles, stop suppressing + re-seat AlphaTab on the
    // engine's current time / play state (so the cursor follows, playback intact).
    const t = window.setTimeout(() => {
      const a = apiRef.current;
      const eng = engineRef.current;
      if (!a || !wiredRef.current) return;
      try {
        outputRef.current?.updatePosition(mapTime(eng.getTime()) * 1000);
        if (eng.isPlaying) a.play();
        else a.pause();
      } catch {
        /* */
      }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, title, kind, customBytes, customTrackIndex]);

  // Toggle standard notation at runtime (no score rebuild). Suppress the handler
  // during the re-layout so playback isn't disturbed, then re-seat the cursor.
  const firstNotation = useRef(true);
  useEffect(() => {
    if (firstNotation.current) {
      firstNotation.current = false;
      return; // the initial profile is already set in the API config
    }
    const api = apiRef.current;
    if (!api) return;
    suppressUntilRef.current = Date.now() + 450;
    try {
      api.settings.display.staveProfile = profileFor(kind, notation);
    } catch {
      /* */
    }
    try {
      api.updateSettings();
    } catch {
      /* */
    }
    try {
      api.render();
    } catch {
      /* */
    }
    const t = window.setTimeout(() => {
      const eng = engineRef.current;
      if (!wiredRef.current) return;
      try {
        outputRef.current?.updatePosition(mapTime(eng.getTime()) * 1000);
        if (eng.isPlaying) apiRef.current?.play();
        else apiRef.current?.pause();
      } catch {
        /* */
      }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notation]);

  // Mirror play/pause so the cursor shows/animates.
  useEffect(() => {
    const a = apiRef.current;
    if (!a || !wiredRef.current) return;
    try {
      if (engine.isPlaying) a.play();
      else a.pause();
    } catch {
      /* */
    }
  }, [engine.isPlaying]);

  // Repaint the verdict strips when the scores change (bounds are already there).
  useEffect(() => {
    paintScores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barScores]);

  // Re-apply sync anchors + re-seat the cursor when sync inputs change.
  useEffect(() => {
    const score = scoreRef.current;
    try {
      score?.applyFlatSyncPoints(syncPoints ?? []);
      apiRef.current?.updateSyncPoints();
      outputRef.current?.updatePosition(mapTime(engineRef.current.getTime()) * 1000);
    } catch {
      /* */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPoints, offsetSec, rate]);

  return (
    <div
      ref={scrollRef}
      className="relative w-full overflow-x-auto overflow-y-hidden rounded-xl bg-white p-2 text-black"
      style={{ height: 220 }}
    >
      <div ref={elRef} />
    </div>
  );
}
