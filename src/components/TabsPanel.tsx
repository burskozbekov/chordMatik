import { useEffect, useMemo, useRef, useState } from "react";
import { detectBeat, fetchTabs, fetchTabTrack, openTabFile, trackBeats } from "../lib/tauri";
import { useAiBass as useAiBassTranscription } from "../hooks/useAiBass";
import { feltTempo } from "../lib/feltTempo";
import { bassFromChords, bassFromTranscription } from "../lib/bassFromChords";
import { tabAgreement } from "../lib/tabMatch";
import { useAppState } from "../state/AppState";
import {
  applyPins,
  beatSyncPoints,
  computeSyncPoints,
  fitTwoAnchors,
  manualSyncPoints,
  refineSyncPoints,
  type SyncResult,
} from "../lib/tabSync";
import type { TabInstrument, TabResult } from "../lib/types";
import { SyncEditor } from "./SyncEditor";
import { TabView } from "./TabView";
import { RatedBassTab } from "./RatedBassTab";
import { useSyncHistory } from "../hooks/useSyncHistory";

type State = "idle" | "loading" | "done" | "none";
const INSTRUMENTS: TabInstrument[] = ["guitar", "bass", "piano", "drums"];
/** Use the chord-DTW warp (drift-following) only when it's at least this confident;
 *  below it we fall back to the straight constant-tempo map (a bad warp is worse). */
const WARP_MIN_CONFIDENCE = 0.45;

/**
 * Fetches the best-matching guitar + bass tab (Songsterr) and shows real
 * tablature with a playback cursor synced to the recording.
 *
 * Sync is MANUAL by default (the reliable, ML-free model every pro tool uses):
 * the user places where bar 1 starts on the waveform + a BPM, which fully
 * determines a drift-free constant-tempo map. "Auto-guess" pre-fills start + BPM
 * from our chord analysis; "Drifts" enables the non-linear chord/chroma warp for
 * rubato/live takes.
 */
export function TabsPanel({ title }: { title: string }) {
  const {
    analysis,
    song,
    engine,
    renameSong,
    setSongBpm,
    setSongStartSec,
    setSongBeatsPerBar,
    songBeats,
    setSongBeats,
    pickTabStart,
    setPickTabStart,
    tabStartRequest,
    setTabStartRequest,
    setAvailableTabs,
  } = useAppState();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<TabResult | null>(null);
  const [which, setWhich] = useState<TabInstrument>("guitar");
  const [notation, setNotation] = useState(false);
  // ONE bass source (a single segmented control, not 4 mutually-fighting toggles):
  //  songsterr = the structured Songsterr bass tab (default, follows playback)
  //  auto      = a bass generated from our detected chords (any song)
  //  ai        = the real bass transcribed from the recording (basic-pitch)
  //  rated     = the highest-starred Ultimate Guitar text tab (opt-in reference)
  type BassSource = "songsterr" | "auto" | "ai" | "rated";
  const [bassSource, setBassSource] = useState<BassSource>("songsterr");
  const lastTitle = useRef<string>("");

  // Manual sync model: start of bar 1 (s) + tempo (BPM).
  const [startSec, setStartSec] = useState(0);
  const [bpm, setBpm] = useState(120);
  const [drift, setDrift] = useState(true);
  const [refined, setRefined] = useState<SyncResult | null>(null);
  const [guessing, setGuessing] = useState(false);
  const [onsets, setOnsets] = useState<number[]>([]);
  // Audio cross-validation: how well the shown tab matches the decoded chords.
  const [match, setMatch] = useState<{ score: number; sChord: number; shift: number } | null>(null);
  const validatedRef = useRef<number | null>(null);
  // Match menu: per-candidate audio-agreement scores, computed lazily on open.
  const [matchMenu, setMatchMenu] = useState(false);
  const [candScores, setCandScores] = useState<Record<number, number | "loading" | "err">>({});
  const scoringRef = useRef(false);
  // A "start from a chord" pick that ALSO switches instrument: the switch changes
  // syncKey → the restore effect would reload the saved start and clobber the pick.
  // Park the picked start here so the restore applies it instead.
  const pendingStartRef = useRef<number | null>(null);
  // A user-loaded Guitar Pro / MusicXML file (AlphaTab native) — overrides Songsterr.
  const [customTab, setCustomTab] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [customTracks, setCustomTracks] = useState<string[]>([]);
  const [customTrackIdx, setCustomTrackIdx] = useState(0);

  const loadCustomTab = async () => {
    const f = await openTabFile();
    if (!f) return;
    setCustomTracks([]);
    setCustomTrackIdx(0);
    setCustomTab(f);
  };

  useEffect(() => {
    if (!title || title === lastTitle.current) return;
    lastTitle.current = title;
    let cancelled = false;
    setState("loading");
    setResult(null);
    setMatch(null);
    setMatchMenu(false);
    setCandScores({});
    validatedRef.current = null;
    fetchTabs(title)
      .then((r) => {
        if (cancelled) return;
        if (r && (r.guitar || r.bass)) {
          setResult(r);
          setWhich(INSTRUMENTS.find((k) => r[k]) ?? "guitar");
          setState("done");
        } else {
          setState("none");
        }
      })
      .catch(() => {
        if (!cancelled) setState("none");
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  // Audio cross-validation: SCORE the chosen tab against the decoded chords for
  // the "Match %" badge. Synchronous + once per pick (claims validatedRef up
  // front so it can't re-enter), and deliberately does NOT auto-fetch alternates
  // or swap the tab — that ran async during playback and froze the UI. Switching
  // versions is now manual via "↻ Other version".
  useEffect(() => {
    const segs = analysis?.segments;
    if (!result || !segs || segs.length < 4) return;
    if (validatedRef.current === result.songId) return;
    validatedRef.current = result.songId;
    try {
      const t = result.guitar ?? result.bass;
      const a = t ? tabAgreement(segs, t, segs[segs.length - 1]?.endSec) : null;
      setMatch(a?.verifiable ? { score: a.score, sChord: a.sChord, shift: a.shift } : null);
    } catch {
      setMatch(null);
    }
  }, [result, analysis]);

  // Auto-reselect: when the picked tab clearly MISMATCHES the recording (✗ zone),
  // score the other Songsterr candidates against the audio and switch to the best.
  // Runs at most once per song, awaits candidates sequentially (network-bound, no
  // UI freeze), and never overrides a manual "Other version" choice.
  const autoPickRef = useRef<string | null>(null);
  const userPickRef = useRef<string | null>(null);
  useEffect(() => {
    const segs = analysis?.segments;
    const cands = result?.candidates ?? [];
    if (!result || !match || !segs || segs.length < 4 || cands.length < 2) return;
    if (match.sChord >= 0.45) return; // current pick is fine (≈/✓ zone)
    if (userPickRef.current === title || autoPickRef.current === title) return;
    autoPickRef.current = title;
    let cancelled = false;
    (async () => {
      const endSec = segs[segs.length - 1]?.endSec;
      let best: {
        sChord: number;
        score: number;
        shift: number;
        alt: TabResult | null;
      } = { sChord: match.sChord, score: match.score, shift: match.shift, alt: null };
      for (const c of cands) {
        if (cancelled) return;
        if (c.songId === result.songId) continue;
        const alt = await fetchTabTrack(c.songId, c.title, c.artist);
        if (cancelled) return;
        const t = alt?.guitar ?? alt?.bass;
        if (!alt || !t) continue;
        try {
          const a = tabAgreement(segs, t, endSec);
          // Swap only for a clear improvement — not for noise.
          if (a?.verifiable && a.sChord > best.sChord + 0.08) {
            best = { sChord: a.sChord, score: a.score, shift: a.shift, alt };
          }
        } catch {
          /* ignore this candidate */
        }
      }
      if (cancelled || !best.alt) return;
      validatedRef.current = best.alt.songId;
      setMatch({ score: best.score, sChord: best.sChord, shift: best.shift });
      // Keep the candidate list so "Other version" still works after the swap.
      setResult({ ...best.alt, candidates: result.candidates });
    })();
    return () => {
      cancelled = true;
    };
  }, [match, result, analysis, title]);

  // Onsets are audio-only — clear when the recording changes (re-fetched on guess).
  useEffect(() => setOnsets([]), [song?.path]);
  // Reset the bass source to the structured Songsterr tab when the song changes.
  useEffect(() => {
    setBassSource("songsterr");
  }, [song?.path]);

  // AI bass transcription (basic-pitch + optional Demucs HQ) — see useAiBass.
  const { aiNotes, aiState, hqReady, hqProgress, runAiBass, enableHq } = useAiBassTranscription(
    song?.path,
    () => {
      setWhich("bass");
      setBassSource("ai");
    },
    () => setBassSource("songsterr"),
  );

  // Meter (beats/bar) from any Songsterr track, else 4/4 — drives the generated bass.
  const meterBeats = useMemo(() => {
    const t = result?.bass ?? result?.guitar ?? result?.piano ?? result?.drums;
    const n = t?.measures?.find((m) => Array.isArray(m.signature))?.signature?.[0];
    return typeof n === "number" && n >= 2 && n <= 12 ? n : 4;
  }, [result]);
  // Bass tab generated straight from the detected chords (root/inversion per beat).
  const autoBass = useMemo(
    () => (analysis ? bassFromChords(analysis.segments, bpm, startSec, meterBeats) : null),
    [analysis, bpm, startSec, meterBeats],
  );
  // Use the generated bass when toggled on, OR whenever Songsterr has no bass track.
  // AI bass: real transcription (basic-pitch) quantized to the beat grid.
  const aiTrack = useMemo(
    () => (aiNotes ? bassFromTranscription(aiNotes, bpm, startSec, meterBeats) : null),
    [aiNotes, bpm, startSec, meterBeats],
  );
  // Effective source: "songsterr" silently falls back to "auto" when the song has
  // no real Songsterr bass, so the bass tab is never simply blank.
  const effBass: BassSource =
    which === "bass" && bassSource === "songsterr" && !result?.bass && !!autoBass
      ? "auto"
      : bassSource;
  const useAiBass = which === "bass" && effBass === "ai" && !!aiTrack;
  const showRated = which === "bass" && effBass === "rated";
  const useGenBass = which === "bass" && effBass === "auto" && !!autoBass;
  const activeTrack = useMemo(() => {
    if (useAiBass) return aiTrack;
    if (useGenBass) return autoBass;
    return result ? (result[which] ?? null) : null;
  }, [useAiBass, aiTrack, useGenBass, autoBass, result, which]);
  // Keep `which` on an instrument that actually has a track (e.g. after a
  // cross-validation swap to a candidate that lacks the current instrument).
  // Bass is exempt: it's always offer-able (rated/AI/generated), so we must NOT
  // bounce off "bass" when Songsterr lacks a bass track — those are its target songs.
  useEffect(() => {
    if (result && which !== "bass" && !result[which]) {
      setWhich(INSTRUMENTS.find((k) => result[k]) ?? "guitar");
    }
  }, [result, which]);
  // Time-signature numerator from the tab (beats per bar) — drives the count-in
  // length + the metronome's accent grid. Defaults to 4/4.
  const beatsPerBar = useMemo(() => {
    const sig = activeTrack?.measures?.find((m) => Array.isArray(m.signature))?.signature;
    const n = sig?.[0];
    return typeof n === "number" && n >= 2 && n <= 12 ? n : 4;
  }, [activeTrack]);

  // Default guesses: first detected chord for the start, Songsterr BPM for tempo.
  const firstChordSec = useMemo(() => {
    const seg = analysis?.segments?.find((s) => s.rootPc >= 0);
    return seg ? Math.round(seg.startSec * 100) / 100 : 0;
  }, [analysis]);
  const baseTempo = useMemo(() => {
    const t = (result?.guitar ?? result?.bass)?.automations?.tempo?.[0]?.bpm;
    return typeof t === "number" && t > 0 ? Math.round(t) : 120;
  }, [result]);
  // Restore a saved calibration for this (recording, tab, instrument), else seed
  // from the auto-defaults. Persisted so the user calibrates a song only once.
  const syncKey = useMemo(
    () => (result?.songId ? `tabsync:${song?.path ?? ""}:${result.songId}:${which}` : null),
    [result?.songId, which, song?.path],
  );
  // Tracks the last AUTO-seeded start for this syncKey. While the current start
  // still equals it (user hasn't touched), the chord-alignment may upgrade it —
  // a manual start is never overridden.
  const autoSeedRef = useRef<{ key: string; value: number } | null>(null);
  // The seed value queued by setStartSec but not yet rendered. The save effect
  // waits for it, so a syncKey switch can't persist the PREVIOUS song's numbers
  // under the new key during the one-commit gap.
  const seedApplyRef = useRef<{ key: string; value: number } | null>(null);
  useEffect(() => {
    if (!syncKey) return;
    // A just-picked "start from a chord" (that switched instrument) overrides the
    // saved/auto start for the newly-selected instrument; consume it once.
    const pending = pendingStartRef.current;
    pendingStartRef.current = null;
    if (pending != null && !engine.isPlaying) engine.seek(pending);
    try {
      const saved = JSON.parse(localStorage.getItem(syncKey) || "null");
      if (saved && typeof saved.startSec === "number" && typeof saved.bpm === "number") {
        // An auto-seeded save is recomputable: RE-seed from the current default
        // (heals a stale 0 persisted before analysis finished) and stay
        // upgradeable by the alignment. A user-adjusted save is final.
        const restored =
          pending != null ? pending : saved.auto === true ? firstChordSec : saved.startSec;
        autoSeedRef.current =
          pending == null && saved.auto === true ? { key: syncKey, value: restored } : null;
        seedApplyRef.current = { key: syncKey, value: restored };
        setStartSec(restored);
        // Migrate pre-felt saves: an old auto-seed stored the raw (often doubled)
        // Songsterr tempo. If the saved BPM is exactly that raw value and predates
        // the felt-octave logic (no v), octave-correct it. User-adjusted values
        // (≠ raw) and new saves (v≥2) are respected as-is.
        // Re-derive BPM with the measured-tempo logic for older saves (v<4) so
        // existing songs get the right felt octave automatically; the user's manual
        // START is always kept. v≥4 saves (already measured-derived) are trusted.
        setBpm(
          saved.v >= 5
            ? saved.bpm
            : feltTempo(baseTempo, analysis?.segments, onsets, analysis?.bpm),
        );
        // Drift-following is now ON by default; re-default older saves (v<3) to on
        // so already-synced songs stop drifting too. v≥3 respects the user's choice.
        setDrift(saved.v >= 3 ? !!saved.drift : true);
        return;
      }
    } catch {
      /* ignore */
    }
    // Fresh song: seed from the first detected chord; the chord-alignment effect
    // below upgrades this to the tab's true entry as soon as it's available.
    autoSeedRef.current = pending == null ? { key: syncKey, value: firstChordSec } : null;
    seedApplyRef.current = { key: syncKey, value: pending ?? firstChordSec };
    setStartSec(pending ?? firstChordSec);
    setBpm(feltTempo(baseTempo, analysis?.segments, onsets, analysis?.bpm));
    setDrift(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey, firstChordSec, baseTempo]);
  useEffect(() => {
    if (!syncKey) return;
    // A freshly-queued seed hasn't rendered yet — saving now would persist the
    // PREVIOUS song/instrument's numbers under this key. Wait for it to land.
    const queued = seedApplyRef.current;
    if (queued && queued.key === syncKey) {
      if (Math.abs(startSec - queued.value) > 1e-9) return;
      seedApplyRef.current = null;
    }
    const seed = autoSeedRef.current;
    const auto = seed?.key === syncKey && Math.abs(startSec - seed.value) < 0.0005;
    try {
      localStorage.setItem(syncKey, JSON.stringify({ startSec, bpm, drift, auto, v: 5 }));
    } catch {
      /* ignore */
    }
  }, [syncKey, startSec, bpm, drift]);

  // Undo/redo (Cmd+Z / Cmd+Shift+Z) for the sync calibration — see useSyncHistory.
  useSyncHistory(syncKey, startSec, bpm, drift, (s) => {
    setStartSec(s.s);
    setBpm(s.b);
    setDrift(s.d);
  });

  // Chord-DTW anchors — used for "Auto-guess" + as the warp base in Drifts mode.
  const syncResult = useMemo(() => {
    if (!activeTrack || !analysis?.segments?.length) return null;
    return computeSyncPoints(analysis.segments, activeTrack);
  }, [activeTrack, analysis]);

  // Where the tab's bar 1 REALLY begins in the recording, from the open-begin
  // chord alignment (which skips intros the tab doesn't notate). Null when the
  // match isn't confident enough to trust.
  const alignedStartSec = useMemo(() => {
    // Generated/AI bass tracks are BUILT from startSec — aligning them back to
    // the audio would feed startSec into itself. Songsterr tracks only.
    if (useGenBass || useAiBass) return null;
    if (!syncResult || syncResult.confidence < WARP_MIN_CONFIDENCE) return null;
    const p0 = syncResult.points[0];
    if (!p0 || p0.barIndex !== 0) return null;
    return Math.round(p0.millisecondOffset) / 1000;
  }, [syncResult, useGenBass, useAiBass]);

  // Upgrade an untouched auto-seeded start to the aligned tab entry. A start the
  // user has moved (≠ the recorded seed) is never overridden.
  useEffect(() => {
    if (alignedStartSec == null || !syncKey) return;
    const seed = autoSeedRef.current;
    if (!seed || seed.key !== syncKey) return;
    // Epsilon below the finest (Shift = 1 ms) nudge, so ANY manual move counts.
    if (Math.abs(startSec - seed.value) > 0.0005) return; // user-adjusted — keep it
    if (Math.abs(alignedStartSec - startSec) < 0.0005) return; // already there
    autoSeedRef.current = { key: syncKey, value: alignedStartSec };
    setStartSec(alignedStartSec);
  }, [alignedStartSec, syncKey, startSec]);

  // Drifts mode: refine the chord warp with chroma-frame DTW (Rust, async).
  // Skipped for generated/AI bass — their warp is discarded anyway (see `warp`),
  // so the WAV decode + CQT would be pure waste (and refire on every start nudge).
  useEffect(() => {
    setRefined(null);
    if (
      !drift ||
      useGenBass ||
      useAiBass ||
      !syncResult ||
      syncResult.points.length < 2 ||
      syncResult.confidence < WARP_MIN_CONFIDENCE ||
      !activeTrack ||
      !song?.path
    )
      return;
    let cancelled = false;
    refineSyncPoints(syncResult, activeTrack, song.path).then((r) => {
      if (!cancelled && r !== syncResult) setRefined(r);
    });
    return () => {
      cancelled = true;
    };
  }, [drift, useGenBass, useAiBass, syncResult, activeTrack, song?.path]);

  // Share the song's BPM (Songsterr tab tempo, user-calibrated) app-wide so the
  // metronome + count-in match it. The notated tab BPM is the most accurate source.
  useEffect(() => {
    setSongBpm(activeTrack ? bpm : 0);
    setSongStartSec(activeTrack ? startSec : 0);
    setSongBeatsPerBar(activeTrack ? beatsPerBar : 4);
  }, [bpm, startSec, beatsPerBar, activeTrack, setSongBpm, setSongStartSec, setSongBeatsPerBar]);

  // Track the recording's REAL beats so the metronome rides them (and the song's
  // tempo drift) instead of a fixed grid. Recompute only when the song or the tempo
  // OCTAVE changes — small ± nudges keep the beats (they follow the audio anyway).
  const beatOctave = bpm > 30 ? Math.round(Math.log2(bpm)) : 0;
  useEffect(() => {
    let alive = true;
    if (!song?.path || !activeTrack || !(bpm > 30)) {
      setSongBeats([]);
      return;
    }
    trackBeats(song.path, bpm)
      .then((b) => alive && setSongBeats(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.path, beatOctave, !!activeTrack, setSongBeats]);

  const manual = useMemo(
    () => (activeTrack ? manualSyncPoints(activeTrack, startSec, bpm) : null),
    [activeTrack, startSec, bpm],
  );
  // The drift-following warp, but only when the chord match is confident enough;
  // otherwise a bad warp is worse than a straight tempo, so fall back to manual.
  const warpBase =
    syncResult && syncResult.points.length >= 2 && syncResult.confidence >= WARP_MIN_CONFIDENCE
      ? syncResult
      : null;
  // The generated/AI bass is built AT the felt tempo + start, so the chord-DTW warp
  // (made for Songsterr tabs, unreliable on single-note bass bars) is skipped —
  // instead we ride the recording's REAL tracked beats (follows tempo drift too),
  // falling back to the manual constant-tempo map when no beats are available.
  const beatSync = useMemo(
    () =>
      (useGenBass || useAiBass) && activeTrack && drift && songBeats.length > 4
        ? beatSyncPoints(activeTrack, songBeats, startSec, meterBeats)
        : null,
    [useGenBass, useAiBass, activeTrack, drift, songBeats, startSec, meterBeats],
  );
  const warp = drift && !useGenBass && !useAiBass ? refined ?? warpBase : null;
  const autoSyncPoints =
    (warp ?? (beatSync && beatSync.points.length >= 2 ? beatSync : null) ?? manual)?.points ?? null;
  // ⚓ user-pinned bars (bar → ms), persisted per syncKey — authoritative overrides
  // for stubborn spots where the automatic sync is off.
  const [pins, setPins] = useState<Record<number, number>>({});
  const [pinMode, setPinMode] = useState(false);
  useEffect(() => {
    setPinMode(false);
    if (!syncKey) {
      setPins({});
      return;
    }
    try {
      setPins(JSON.parse(localStorage.getItem(`tabpins:${syncKey}`) || "{}") ?? {});
    } catch {
      setPins({});
    }
  }, [syncKey]);
  const savePins = (next: Record<number, number>) => {
    setPins(next);
    if (!syncKey) return;
    try {
      if (Object.keys(next).length) localStorage.setItem(`tabpins:${syncKey}`, JSON.stringify(next));
      else localStorage.removeItem(`tabpins:${syncKey}`);
    } catch {
      /* ignore */
    }
  };
  const pinBarAtPlayhead = (barIndex: number) => {
    savePins({ ...pins, [barIndex]: Math.round(engine.getTime() * 1000) });
  };
  const syncPoints = useMemo(
    () => applyPins(autoSyncPoints, pins),
    [autoSyncPoints, pins],
  );
  // Bar-start times (s) for the wave's anchor ticks — SEE where the sync lands.
  const anchorSecs = useMemo(
    () => (syncPoints ?? []).map((p) => p.millisecondOffset / 1000),
    [syncPoints],
  );

  // M = mark the start at the live playhead (tap while listening); R = jump to
  // the marked start (then Space plays from there). Bound once via refs.
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const startRef = useRef(startSec);
  startRef.current = startSec;
  const activeRef = useRef(false);
  activeRef.current = state === "done" && !!activeTrack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      )
        return;
      const eng = engineRef.current;
      if (e.code === "KeyM") {
        e.preventDefault();
        const v = Math.max(0, Math.round(eng.getTime() * 1000) / 1000);
        setStartSec(v);
        if (!eng.isPlaying) eng.seek(v);
      } else if (e.code === "KeyR") {
        e.preventDefault();
        eng.seek(startRef.current);
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // Nudge the bar-1 start with arrow keys for precise alignment:
        // Shift = 1 ms (millimetric), plain = 10 ms, Alt/Option = 100 ms.
        e.preventDefault();
        const step = e.shiftKey ? 0.001 : e.altKey ? 0.1 : 0.01;
        const dir = e.code === "ArrowRight" ? 1 : -1;
        const v = Math.max(0, Math.round((startRef.current + dir * step) * 1000) / 1000);
        setStartSec(v);
        if (!eng.isPlaying) eng.seek(v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Consume a "set start from a chord" pick made in the chord timeline. MUST be
  // before the early return below so the hook order never changes. (Inlines the
  // adjustStart logic, which is only defined further down the render path.)
  useEffect(() => {
    if (tabStartRequest == null) return;
    const v = Math.max(0, Math.round(tabStartRequest.time * 1000) / 1000);
    const w = tabStartRequest.which;
    const target = w && result?.[w] ? w : null;
    if (target && target !== which) {
      // Switching instrument reloads the saved start — defer the pick so the
      // restore effect applies it instead of clobbering it.
      pendingStartRef.current = v;
      setWhich(target);
    } else {
      setStartSec(v);
      if (!engine.isPlaying) engine.seek(v);
    }
    setTabStartRequest(null);
  }, [tabStartRequest, engine, result, which, setTabStartRequest]);

  // Publish which instruments this song has a tab for → the chord-timeline
  // right-click "Start … tab here" menu only offers what actually exists.
  useEffect(() => {
    setAvailableTabs(INSTRUMENTS.filter((k) => result?.[k]));
  }, [result, setAvailableTabs]);

  // No Songsterr tab (yet / found) and no custom file → offer to generate one
  // from the chords, or open a tab file.
  if ((state === "idle" || state === "none") && !customTab && !useGenBass && !useAiBass && !showRated) {
    return (
      <section className="glass flex items-center justify-between gap-2 rounded-2xl px-4 py-2.5 shadow-overlay">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Tabs</h3>
          <span className="text-[11px] text-muted">
            {aiState === "working"
              ? "🤖 Transcribing the bass…"
              : aiState === "error"
                ? "🤖 Couldn’t transcribe"
                : state === "none"
                  ? "No Songsterr tab found"
                  : "Searching…"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {song?.path && (
            <button
              type="button"
              disabled={aiState === "working"}
              onClick={runAiBass}
              title="Transcribe the REAL bass line from the recording (AI, ~a few seconds)"
              className="cta-gradient rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-60"
            >
              {aiState === "working" ? "🤖 …" : "🤖 AI bass"}
            </button>
          )}
          {autoBass && (
            <button
              type="button"
              onClick={() => {
                setWhich("bass");
                setBassSource("auto");
              }}
              title="Build a bass tab from the detected chords (works for any song)"
              className="rounded-lg border border-border/70 bg-surface/50 px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface"
            >
              ✨ Chord bass
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setWhich("bass");
              setBassSource("rated");
            }}
            title="Find the highest-rated community bass tab (Ultimate Guitar) for this song"
            className="rounded-lg border border-border/70 bg-surface/50 px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface"
          >
            ⭐ Rated
          </button>
          <button
            type="button"
            onClick={loadCustomTab}
            title="Open a Guitar Pro (.gp/.gp5) or MusicXML file"
            className="rounded-lg border border-border/70 bg-surface/50 px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface"
          >
            📁 Open tab file
          </button>
        </div>
      </section>
    );
  }

  const track = activeTrack;
  // Bass is always available — we can generate it from the chords for any song.
  // Bass is always offer-able (rated/AI/generated), even when Songsterr has none.
  const present = INSTRUMENTS.filter((k) => result?.[k] || k === "bass");

  // Set the start AND move the playhead there (when paused) so the tab snaps to
  // bar 1 and Space then plays from exactly this point.
  const adjustStart = (sec: number) => {
    const v = Math.max(0, Math.round(sec * 1000) / 1000);
    setStartSec(v);
    if (!engine.isPlaying) engine.seek(v);
  };
  const nudgeStart = (d: number) => adjustStart(startSec + d);

  const autoGuess = async () => {
    setGuessing(true);
    try {
      // 1. Audio-based detector (tempo + first onset) — works even if the tab mismatches.
      // The START prefers the chord-alignment's bar-1 time (skips intros the tab
      // doesn't notate); the mix's first onset is only the fallback.
      if (song?.path) {
        const beat = await detectBeat(song.path);
        if (beat) {
          if (Array.isArray(beat.onsets)) setOnsets(beat.onsets);
          if (beat.bpm > 30 && beat.bpm < 320) {
            adjustStart(alignedStartSec ?? beat.startSec);
            // Fold the precise notated tab tempo to the freshly-detected felt octave
            // (or use the detection directly when there's no notated tempo).
            setBpm(
              feltTempo(
                baseTempo || Math.round(beat.bpm),
                analysis?.segments,
                beat.onsets,
                Math.round(beat.bpm),
              ),
            );
            return;
          }
        }
      }
      // 2. Chord-DTW two-anchor fit.
      if (syncResult && syncResult.points.length >= 2 && track) {
        const p = syncResult.points;
        const fit = fitTwoAnchors(
          track,
          { bar: p[0].barIndex, timeSec: p[0].millisecondOffset / 1000 },
          { bar: p[p.length - 1].barIndex, timeSec: p[p.length - 1].millisecondOffset / 1000 },
        );
        if (fit && fit.bpm > 30 && fit.bpm < 320) {
          adjustStart(fit.startSec);
          setBpm(feltTempo(Math.round(fit.bpm), analysis?.segments, onsets, analysis?.bpm));
          return;
        }
      }
      // 3. Fall back to first chord + Songsterr BPM (octave-corrected).
      adjustStart(firstChordSec);
      setBpm(feltTempo(baseTempo, analysis?.segments, onsets, analysis?.bpm));
    } finally {
      setGuessing(false);
    }
  };
  const reset = () => {
    // Back to the AUTO state: prefer the aligned tab entry over the raw first
    // chord, and re-arm the auto seed so future alignment improvements still
    // apply (otherwise Reset would leave the song worse than a fresh load).
    const target = alignedStartSec ?? firstChordSec;
    if (syncKey) autoSeedRef.current = { key: syncKey, value: target };
    adjustStart(target);
    setBpm(feltTempo(baseTempo, analysis?.segments, onsets, analysis?.bpm));
    setDrift(true);
    savePins({});
    setPinMode(false);
  };

  // Score every candidate's audio agreement for the Match menu (lazy, sequential;
  // fetches are disk-cached so reopening is instant). Stale runs stop on song change.
  const scoreCandidates = async () => {
    if (scoringRef.current) return;
    const segs = analysis?.segments;
    const cands = result?.candidates ?? [];
    if (!segs || segs.length < 4 || !cands.length || !result) return;
    scoringRef.current = true;
    const forTitle = title;
    try {
      const endSec = segs[segs.length - 1]?.endSec;
      const have = { ...candScores };
      if (match) have[result.songId] = match.sChord;
      setCandScores(have);
      for (const c of cands) {
        if (lastTitle.current !== forTitle) return; // song changed — stop
        if (have[c.songId] !== undefined && have[c.songId] !== "err") continue;
        setCandScores((m) => ({ ...m, [c.songId]: "loading" }));
        const alt = await fetchTabTrack(c.songId, c.title, c.artist);
        if (lastTitle.current !== forTitle) return;
        const t = alt?.guitar ?? alt?.bass;
        let v: number | "err" = "err";
        if (alt && t) {
          try {
            const a = tabAgreement(segs, t, endSec);
            if (a?.verifiable) v = a.sChord;
          } catch {
            /* unscorable candidate */
          }
        }
        have[c.songId] = v;
        setCandScores((m) => ({ ...m, [c.songId]: v }));
      }
    } finally {
      scoringRef.current = false;
    }
  };

  // Switch to a specific candidate from the Match menu (locks out auto-reselect).
  const pickCandidate = async (songId: number) => {
    setMatchMenu(false);
    const c = (result?.candidates ?? []).find((x) => x.songId === songId);
    if (!c || !result || songId === result.songId) return;
    const alt = await fetchTabTrack(c.songId, c.title, c.artist);
    if (!alt) return;
    userPickRef.current = title;
    validatedRef.current = alt.songId;
    const segs = analysis?.segments;
    const t = alt.guitar ?? alt.bass;
    const a =
      segs && segs.length >= 4 && t ? tabAgreement(segs, t, segs[segs.length - 1]?.endSec) : null;
    setMatch(a?.verifiable ? { score: a.score, sChord: a.sChord, shift: a.shift } : null);
    setResult({ ...alt, candidates: result.candidates });
    if (!alt[which]) setWhich(alt.guitar ? "guitar" : "bass");
  };

  // Re-run the Songsterr search live (bypass the pick cache), e.g. after the pick
  // logic improved. Rebuilds the result + candidate scores.
  const refreshTabs = async () => {
    setMatchMenu(false);
    setCandScores({});
    userPickRef.current = null;
    autoPickRef.current = null;
    const r = await fetchTabs(title, true);
    if (r && (r.guitar || r.bass)) {
      validatedRef.current = null;
      setResult(r);
      if (!r[which]) setWhich(INSTRUMENTS.find((k) => r[k]) ?? "guitar");
    }
  };

  // Manual override: fetch the next-ranked Songsterr version (when our auto-pick
  // still isn't the recording's arrangement). Locks the choice from auto-reselect.
  const cycleVersion = async () => {
    const cands = result?.candidates ?? [];
    if (!result || cands.length < 2) return;
    const idx = Math.max(0, cands.findIndex((c) => c.songId === result.songId));
    const next = cands[(idx + 1) % cands.length];
    if (!next || next.songId === result.songId) return;
    const alt = await fetchTabTrack(next.songId, next.title, next.artist);
    if (!alt) return;
    userPickRef.current = title; // a manual choice locks out the auto-reselect
    validatedRef.current = alt.songId;
    const segs = analysis?.segments;
    const t = alt.guitar ?? alt.bass;
    const a = segs && segs.length >= 4 && t ? tabAgreement(segs, t, segs[segs.length - 1]?.endSec) : null;
    setMatch(a?.verifiable ? { score: a.score, sChord: a.sChord, shift: a.shift } : null);
    // Keep the candidate list so cycling keeps working past the first swap.
    setResult({ ...alt, candidates: result.candidates });
    setWhich(alt.guitar ? "guitar" : "bass");
  };

  return (
    <section className="glass flex flex-col gap-3 rounded-2xl px-4 py-3 shadow-overlay">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="shrink-0 text-sm font-semibold text-foreground">Tabs</h3>
          {!customTab &&
            (editingTitle ? (
              <input
                autoFocus
                defaultValue={title}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    renameSong(titleDraft || title);
                    setEditingTitle(false);
                  } else if (e.key === "Escape") {
                    setEditingTitle(false);
                  }
                }}
                onBlur={() => {
                  if (titleDraft.trim() && titleDraft !== title) renameSong(titleDraft);
                  setEditingTitle(false);
                }}
                className="min-w-0 flex-1 rounded-md border border-[var(--accent)]/50 bg-surface px-1.5 py-0.5 text-[11px] text-foreground outline-none"
                placeholder="Artist — Song"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(title);
                  setEditingTitle(true);
                }}
                title="Rename this song — fixes tabs, lyrics & rated bass when the file/YouTube title is wrong"
                className="group flex min-w-0 items-center gap-1 text-[11px] text-muted transition-colors hover:text-foreground"
              >
                <span className="truncate">{title}</span>
                <span className="shrink-0 opacity-40 group-hover:opacity-100">✏️</span>
              </button>
            ))}
          {customTab && (
            <span className="inline-flex items-center gap-1.5">
              <span className="truncate text-[11px] font-medium text-foreground">📁 {customTab.name}</span>
              <button
                type="button"
                aria-label="Close custom tab"
                title="Close — back to Songsterr"
                onClick={() => setCustomTab(null)}
                className="grid size-4 place-items-center rounded text-xs text-muted/70 transition-colors hover:bg-danger/15 hover:text-danger"
              >
                ✕
              </button>
            </span>
          )}
          {!customTab && useAiBass && (
            <span className="shrink-0 text-[11px] font-medium text-[var(--accent)]">
              🤖 chordMatik · AI bass (from audio)
            </span>
          )}
          {!customTab && !useAiBass && aiState === "working" && (
            <span className="shrink-0 text-[11px] font-medium text-[var(--accent)]">
              🤖 Transcribing the bass…
            </span>
          )}
          {!customTab && !useAiBass && aiState === "error" && (
            <span className="shrink-0 text-[11px] font-medium text-red-600 dark:text-red-400">
              🤖 Couldn’t transcribe
            </span>
          )}
          {!customTab && !useAiBass && useGenBass && (
            <span className="shrink-0 text-[11px] font-medium text-[var(--accent)]">
              ✨ chordMatik · auto bass
            </span>
          )}
          {!customTab && !useAiBass && result && !useGenBass && (
            <span className="truncate text-[11px] text-muted">
              {result.artist} — {result.title} · Songsterr
            </span>
          )}
          {!customTab && !useAiBass && !useGenBass && match && state === "done" && (which === "guitar" || which === "bass") && (
            <span className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setMatchMenu((v) => !v);
                  if (!matchMenu) void scoreCandidates();
                }}
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                  match.sChord >= 0.62
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : match.sChord >= 0.45
                      ? "bg-amber-400/20 text-amber-600 dark:text-amber-400"
                      : "bg-red-400/20 text-red-600 dark:text-red-400"
                }`}
                title={`How well this tab matches the recording's chords — click to compare versions${
                  match.shift ? ` · detected ${match.shift > 6 ? match.shift - 12 : match.shift} semitone offset (capo/tuning)` : ""
                }`}
              >
                {match.sChord >= 0.62 ? "✓ " : match.sChord >= 0.45 ? "≈ " : "✗ "}
                Match {Math.round(match.sChord * 100)}%
                {(result?.candidates?.length ?? 0) >= 2 ? " ▾" : ""}
              </button>
              {matchMenu && (result?.candidates?.length ?? 0) >= 2 && (
                <>
                  <button
                    type="button"
                    aria-label="Close"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setMatchMenu(false)}
                  />
                  <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border/70 bg-[var(--surface)] p-1 shadow-overlay">
                    {[...(result?.candidates ?? [])]
                      .sort((a, b) => {
                        const sa = candScores[a.songId];
                        const sb = candScores[b.songId];
                        return (typeof sb === "number" ? sb : -1) - (typeof sa === "number" ? sa : -1);
                      })
                      .map((c) => {
                        const s = candScores[c.songId];
                        const cur = c.songId === result?.songId;
                        return (
                          <button
                            key={c.songId}
                            type="button"
                            onClick={() => void pickCandidate(c.songId)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors hover:bg-surface ${
                              cur ? "bg-[var(--accent)]/10" : ""
                            }`}
                          >
                            <span
                              className={`w-10 shrink-0 text-right font-mono text-[10px] font-semibold ${
                                typeof s === "number"
                                  ? s >= 0.62
                                    ? "text-[var(--accent)]"
                                    : s >= 0.45
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-red-600 dark:text-red-400"
                                  : "text-muted"
                              }`}
                            >
                              {typeof s === "number" ? `${Math.round(s * 100)}%` : s === "loading" ? "…" : "—"}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {c.artist} — {c.title}
                            </span>
                            {cur && <span className="shrink-0 text-[10px] text-muted">current</span>}
                          </button>
                        );
                      })}
                    <button
                      type="button"
                      onClick={() => void refreshTabs()}
                      title="Re-run the Songsterr search (ignore the cached pick)"
                      className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border/50 px-2 py-1 text-left text-[11px] text-muted transition-colors hover:bg-surface hover:text-foreground"
                    >
                      <span className="w-10 shrink-0 text-right">↻</span>
                      <span>Refresh versions</span>
                    </button>
                  </div>
                </>
              )}
            </span>
          )}
          {!customTab && !useAiBass && !useGenBass && !match && result && (result.candidates?.length ?? 0) >= 2 && (
            <button
              type="button"
              onClick={cycleVersion}
              title="Fetch a different Songsterr version of this song"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              ↻ Other version
            </button>
          )}
          {!customTab && which === "bass" && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface/60 p-0.5 text-[10px] font-semibold">
              {([
                ["songsterr", "Songsterr", "The structured Songsterr bass tab (follows playback)", !!result?.bass],
                ["auto", "✨ Auto", "Bass generated from the detected chords (any song)", !!autoBass],
                ["ai", aiState === "working" ? "🤖 …" : "🤖 AI", "Transcribe the REAL bass from the recording (basic-pitch)", true],
                ["rated", "⭐ Rated", "Highest-rated Ultimate Guitar text tab (reference — no cursor)", true],
              ] as const).map(([src, label, tip, enabled]) => (
                <button
                  key={src}
                  type="button"
                  disabled={!enabled || (src === "ai" && aiState === "working")}
                  title={tip}
                  onClick={() => {
                    if (src === "ai") {
                      if (effBass !== "ai") runAiBass();
                    } else {
                      setBassSource(src);
                    }
                  }}
                  className={`rounded-md px-2 py-0.5 transition-colors disabled:opacity-30 ${
                    effBass === src
                      ? "bg-[var(--accent)] text-accent-foreground"
                      : "text-muted hover:bg-surface hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
              {effBass === "ai" && (
                <button
                  type="button"
                  disabled={aiState === "working" || hqProgress !== null}
                  onClick={enableHq}
                  title="Isolate the bass with Demucs first for a much cleaner transcription (downloads a 316MB model once)"
                  className="rounded-md px-1.5 py-0.5 text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-40"
                >
                  {hqProgress !== null ? `🎚️ ${hqProgress}%` : hqReady ? "🎚️ HQ ✓" : "🎚️ HQ"}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {customTab ? (
            customTracks.length >= 2 && (
              <select
                value={customTrackIdx}
                onChange={(e) => setCustomTrackIdx(Number(e.target.value))}
                title="Pick a track from the file"
                className="max-w-[12rem] rounded-lg border border-border/70 bg-surface/50 px-2 py-1 text-xs font-semibold text-foreground"
              >
                {customTracks.map((n, i) => (
                  <option key={i} value={i}>
                    {n}
                  </option>
                ))}
              </select>
            )
          ) : (
            <>
              {/* Tab ↔ standard-notation view, same segmented style as the rest. */}
              {(which === "guitar" || which === "bass") && (
                <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
                  <button
                    type="button"
                    onClick={() => setNotation(false)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                      !notation ? "chord-gradient text-[#06351f] shadow-sm" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Tab
                  </button>
                  <button
                    type="button"
                    onClick={() => setNotation(true)}
                    title="Standard notation alongside the tab"
                    className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                      notation ? "chord-gradient text-[#06351f] shadow-sm" : "text-muted hover:text-foreground"
                    }`}
                  >
                    ♪ Notes
                  </button>
                </div>
              )}
              {present.length >= 2 && (
                <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
                  {present.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setWhich(t)}
                      className={`rounded-lg px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                        which === t ? "chord-gradient text-[#06351f] shadow-sm" : "text-muted hover:text-foreground"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="flex items-center rounded-xl border border-border/70 bg-surface/50 p-0.5">
            <button
              type="button"
              onClick={loadCustomTab}
              title="Open your own Guitar Pro (.gp/.gp5) or MusicXML file"
              className="rounded-lg px-3 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
            >
              📁 File
            </button>
          </div>
        </div>
      </div>

      {showRated ? (
        <RatedBassTab title={title} />
      ) : customTab ? (
        <>
          {song && (
            <SyncEditor
              peaks={song.info.peaks}
              durationSec={song.info.durationSec}
              engine={engine}
              startSec={startSec}
              onsets={onsets}
              onStartChange={adjustStart}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
            <span className="font-semibold uppercase tracking-wide">Start</span>
            <HelpDot text="Tap M (or trim the wave) right as the tab's bar 1 lands · Space plays · R jumps to the start · ← → nudge (Shift = 1 ms, Alt = 0.1 s) · pick a track on the right" />
            <NudgeButton label="−0.1" onClick={() => nudgeStart(-0.1)} />
            <NudgeButton label="−10ms" onClick={() => nudgeStart(-0.01)} />
            <span className="min-w-[3.6rem] text-center font-mono text-foreground">
              {startSec.toFixed(2)}s
            </span>
            <NudgeButton label="+10ms" onClick={() => nudgeStart(0.01)} />
            <NudgeButton label="+0.1" onClick={() => nudgeStart(0.1)} />
            <NudgeButton label="⟸ playhead" onClick={() => adjustStart(engine.getTime())} />
          </div>
          <TabView
            key={`custom-${customTab.name}`}
            customBytes={customTab.bytes}
            customTrackIndex={customTrackIdx}
            onTracks={setCustomTracks}
            offsetSec={startSec}
            rate={1}
            syncPoints={null}
          />
        </>
      ) : state === "loading" ? (
        <div className="grid h-24 place-items-center text-xs text-muted">Finding tabs…</div>
      ) : track ? (
        <>
          {/* Manual sync: drop where bar 1 starts, set the tempo. */}
          {song && (
            <SyncEditor
              peaks={song.info.peaks}
              durationSec={song.info.durationSec}
              engine={engine}
              startSec={startSec}
              onsets={onsets}
              anchors={anchorSecs}
              onStartChange={adjustStart}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
            <span className="font-semibold uppercase tracking-wide">Sync</span>
            <HelpDot text="The start is auto-aligned — fine-tune only if it's off. Tap M right as bar 1 lands · right-click a chord above → Start tab here · R jumps to the start, Space plays · ← → nudge (Shift = 1 ms, Alt = 0.1 s) · scroll the wave to zoom" />
            <div className="flex items-center gap-1">
              <NudgeButton label="−0.1" onClick={() => nudgeStart(-0.1)} />
              <NudgeButton label="−10ms" onClick={() => nudgeStart(-0.01)} />
              <span className="min-w-[4.3rem] text-center font-mono text-foreground">
                {startSec.toFixed(3)}s
              </span>
              <NudgeButton label="+10ms" onClick={() => nudgeStart(0.01)} />
              <NudgeButton label="+0.1" onClick={() => nudgeStart(0.1)} />
              <button
                type="button"
                onClick={() => adjustStart(engine.getTime())}
                title="Mark start: tap (or press M) right as bar 1 hits while the song plays"
                className="rounded-md bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] px-2 py-0.5 font-semibold text-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_30%,transparent)]"
              >
                ⦿ M
              </button>
              <button
                type="button"
                onClick={() => setPickTabStart(!pickTabStart)}
                title="From a chord: click the chord in the timeline above where the tab's bar 1 begins"
                className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                  pickTabStart
                    ? "bg-[var(--accent)] text-accent-foreground"
                    : "bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--accent)_30%,transparent)]"
                }`}
              >
                📍{pickTabStart ? " Pick a chord…" : ""}
              </button>
              <NudgeButton
                label="▶"
                title="Play from just before the start (test it)"
                onClick={() => {
                  engine.seek(Math.max(0, startSec - 1.2));
                  engine.play();
                }}
              />
              <button
                type="button"
                onClick={() => setPinMode((v) => !v)}
                title={
                  pinMode
                    ? "Pin mode ON: pause where a bar truly starts, then click that bar in the tab to pin it there. Click again to exit."
                    : `Pin a bar: pause at the true spot, then click the bar in the tab${Object.keys(pins).length ? ` · ${Object.keys(pins).length} pinned (Reset clears)` : ""}`
                }
                className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                  pinMode
                    ? "bg-[var(--accent)] text-accent-foreground"
                    : Object.keys(pins).length
                      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--accent)_30%,transparent)]"
                }`}
              >
                ⚓{pinMode ? " Click a bar…" : Object.keys(pins).length ? ` ${Object.keys(pins).length}` : ""}
              </button>
            </div>
            <div className="flex items-center gap-1">
              <NudgeButton label="÷2" onClick={() => setBpm((b) => Math.max(20, Math.round(b / 2)))} />
              <NudgeButton label="−" onClick={() => setBpm((b) => b - 1)} />
              <span
                className="min-w-[2.6rem] text-center font-mono text-foreground"
                title={
                  baseTempo > 0 && bpm !== baseTempo
                    ? `Songsterr notates ${baseTempo} BPM (often double the felt tempo) — ×2/÷2 to flip`
                    : "Tempo"
                }
              >
                {bpm} BPM
              </span>
              <NudgeButton label="+" onClick={() => setBpm((b) => b + 1)} />
              <NudgeButton label="×2" onClick={() => setBpm((b) => Math.min(320, b * 2))} />
            </div>
            <button
              type="button"
              onClick={autoGuess}
              disabled={guessing}
              className="rounded-md bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] px-2 py-0.5 font-semibold text-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_28%,transparent)] disabled:opacity-50"
              title="Detect start + tempo from the recording (then fine-tune)"
            >
              {guessing ? "…" : "✨ Auto"}
            </button>
            <label
              className="flex items-center gap-1 font-semibold"
              title="Follow drift: warp the cursor to the recording's REAL tempo (live/rubato songs). Falls back to a straight constant tempo when the chord match is too weak."
            >
              <input type="checkbox" checked={drift} onChange={(e) => setDrift(e.target.checked)} />
              Drift
            </label>
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-2 py-0.5 font-semibold text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              Reset
            </button>
          </div>
          <TabView
            syncPoints={syncPoints}
            key={`tab-${result?.songId ?? "x"}`}
            track={track}
            title={`${result?.title}`}
            kind={which}
            notation={notation}
            offsetSec={0}
            rate={1}
            onBarClick={pinMode ? pinBarAtPlayhead : undefined}
          />
        </>
      ) : null}
    </section>
  );
}

function NudgeButton({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-md border border-border/70 bg-surface/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground transition-colors hover:bg-surface"
    >
      {label}
    </button>
  );
}

/** A tiny "?" that carries the how-to as a hover tooltip — keeps the UI clean. */
function HelpDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="grid size-4 shrink-0 cursor-help place-items-center rounded-full border border-border/70 bg-surface/60 text-[9px] font-bold text-muted"
    >
      ?
    </span>
  );
}
