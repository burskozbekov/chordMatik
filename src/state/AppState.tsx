import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { demoAnalysis, demoSong, isDemoRequested } from "../lib/demo";
import { useAudioEngine, type AudioEngine } from "../hooks/useAudioEngine";
import { useYouTubeEngine } from "../hooks/useYouTubeEngine";
import { parseYouTubeId } from "../lib/youtube";
import {
  analyzeChords,
  downloadYoutubeAudio,
  fileName,
  isSupportedAudio,
  isTauri,
  libraryList,
  libraryRemove,
  loadAudio,
  onLiveChord,
  openAudioDialog,
  pickMusicFolder,
  startLive,
  startSystemCapture,
  stopLive,
  stopSystemCapture,
  toAudioSrc,
  type LiveChord,
} from "../lib/tauri";
import type {
  AnalysisStatus,
  ChordAnalysis,
  LibraryItem,
  LoadedSong,
  LoadStatus,
  TabInstrument,
} from "../lib/types";

export type PlaybackMode = "audio" | "youtube";

/** Auto file-match status for the pasted YouTube link. */
export interface MatchStatus {
  state: "idle" | "searching" | "matched" | "nomatch";
  name?: string;
}

/** Progress of fetching chords for a pasted YouTube link (download → analyze). */
export type YtFetchState = "idle" | "downloading" | "analyzing" | "error";

/** A "set tab start from a chord" request: the recording time + which tab to show. */
export interface TabStartRequest {
  time: number;
  which: TabInstrument | null;
}

interface AppState {
  status: LoadStatus;
  error: string | null;
  song: LoadedSong | null;
  /** The active playback engine (local audio OR YouTube), per `playbackMode`. */
  engine: AudioEngine;
  analysisStatus: AnalysisStatus;
  analysis: ChordAnalysis | null;
  analysisError: string | null;
  library: LibraryItem[];
  // --- Playback source (Phase 8) ---
  playbackMode: PlaybackMode;
  youtubeId: string | null;
  /** Player/network error for the embedded YouTube video, or null. */
  youtubeError: string | null;
  /** Seconds the video leads the analyzed track (engine time = videoTime − offset). */
  syncOffset: number;
  /** Attach a YouTube video (URL or ID). Returns false if it can't be parsed. */
  setYouTubeUrl: (url: string) => boolean;
  clearYouTube: () => void;
  setPlaybackMode: (mode: PlaybackMode) => void;
  setSyncOffset: (seconds: number) => void;
  // --- Paste a YouTube link → fetch its audio → on-device chords ---
  /** Progress while getting chords for a pasted link (download → analyze). */
  ytFetchState: YtFetchState;
  /** Error from the YouTube fetch, or null. */
  ytFetchError: string | null;
  /** The loaded song's source video id (for the watch-along video), or null. */
  songVideoId: string | null;
  /** The song's best-known BPM (Songsterr/calibrated/detected); 0 = unknown. */
  songBpm: number;
  setSongBpm: (bpm: number) => void;
  /** Time (s) of bar 1 / beat 1 — the beat-grid phase for a synced metronome. */
  songStartSec: number;
  setSongStartSec: (s: number) => void;
  /** Beats per bar (time-signature numerator) from the tab; count-in + metronome. */
  songBeatsPerBar: number;
  setSongBeatsPerBar: (n: number) => void;
  /** Real beat times (s) tracked from the recording — the metronome rides these
   * actual beats (following tempo drift) instead of a rigid BPM grid. Empty = none. */
  songBeats: number[];
  setSongBeats: (b: number[]) => void;
  /** True while picking the tab's bar-1 start by clicking a chord in the timeline. */
  pickTabStart: boolean;
  setPickTabStart: (v: boolean) => void;
  /** A recording time + optional instrument requested as the tab start; consumed by TabsPanel. */
  tabStartRequest: TabStartRequest | null;
  setTabStartRequest: (t: TabStartRequest | null) => void;
  /** Instruments the loaded song actually has a tab for (published by TabsPanel),
   *  so the chord-timeline right-click menu only offers what exists. */
  availableTabs: TabInstrument[];
  setAvailableTabs: (t: TabInstrument[]) => void;
  // --- Auto file-matching: paste a link → find the song in your music folder ---
  /** The user's music folder to auto-match YouTube links against, or null. */
  musicFolder: string | null;
  /** Progress of the current auto-match attempt. */
  matchStatus: MatchStatus;
  /** Open a picker to set the music folder. */
  chooseMusicFolder: () => Promise<void>;
  /** Forget the music folder (disables auto-matching). */
  clearMusicFolder: () => void;
  // --- Live chords: continuously detect the current chord while audio plays ---
  /** True while live detection is running. */
  liveActive: boolean;
  /** The current detected chord, or null. */
  liveChord: LiveChord | null;
  /** Error from live mode (e.g. permission denied), or null. */
  liveError: string | null;
  /** Toggle live chord detection on/off. */
  toggleLive: () => void;
  // --- On-device "record chords from the playing video" (macOS) ---
  /** True while capturing system audio. */
  capturing: boolean;
  /** Error from the last capture attempt (e.g. permission denied), or null. */
  captureError: string | null;
  /** Start capturing the system audio (the playing video) to analyze on-device. */
  startCapture: () => Promise<void>;
  /** Stop capturing, then analyze what was captured and show the synced timeline. */
  stopCaptureAndAnalyze: () => Promise<void>;
  /** Open the native picker, then load + prepare the chosen song. */
  openDialog: () => Promise<void>;
  /** Like openDialog, but keeps the attached YouTube video (for synced chords). */
  openAudioForVideo: () => Promise<void>;
  /** Load a song from an absolute path (used by drag & drop too). */
  openPath: (path: string) => Promise<void>;
  /** Rename the current song (a YouTube/file title is often wrong). Persisted per
   *  path; every title-keyed lookup (tabs, lyrics, rated bass) re-runs. */
  renameSong: (name: string) => void;
  /** Dismiss an analyze error and return to the current song (or the empty state). */
  dismissError: () => void;
  /** Open a song TAB — restores it instantly from memory if already loaded this session. */
  openTab: (t: { path: string; name?: string; videoId?: string }) => Promise<void>;
  /** Open a pasted YouTube link as a new tab (keeps the current song as a tab). */
  openYouTubeUrl: (url: string) => boolean;
  reanalyze: () => void;
  removeFromLibrary: (hash: string) => Promise<void>;
  reset: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const audioEngine = useAudioEngine();
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [song, setSong] = useState<LoadedSong | null>(null);
  const songRef = useRef<LoadedSong | null>(null);
  songRef.current = song;
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("idle");
  const [analysis, setAnalysis] = useState<ChordAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [playbackMode, setPlaybackModeState] = useState<PlaybackMode>("audio");
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const [syncOffset, setSyncOffset] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [liveActive, setLiveActive] = useState(false);
  const [liveChord, setLiveChord] = useState<LiveChord | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveUnlistenRef = useRef<null | (() => void)>(null);
  const mountedRef = useRef(true);
  const [musicFolder, setMusicFolderState] = useState<string | null>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem("cmk.musicFolder") : null,
  );
  const [matchStatus, setMatchStatus] = useState<MatchStatus>({ state: "idle" });
  const [ytFetchState, setYtFetchState] = useState<YtFetchState>("idle");
  const [ytFetchError, setYtFetchError] = useState<string | null>(null);
  const [songVideoId, setSongVideoId] = useState<string | null>(null);
  // The song's best-known BPM + the time (s) of bar 1 / beat 1 (the manual-sync
  // start anchor), shared so the metronome + count-in lock to the song's rhythm.
  const [songBpm, setSongBpm] = useState(0);
  const [songStartSec, setSongStartSec] = useState(0);
  const [songBeatsPerBar, setSongBeatsPerBar] = useState(4);
  const [songBeats, setSongBeats] = useState<number[]>([]);
  // "Set tab start from a chord": pick mode + the recording time (s) the chord
  // timeline requests as the tab's bar-1 start (a one-shot signal TabsPanel consumes).
  const [pickTabStart, setPickTabStart] = useState(false);
  const [tabStartRequest, setTabStartRequest] = useState<TabStartRequest | null>(null);
  const [availableTabs, setAvailableTabs] = useState<TabInstrument[]>([]);
  const loadTokenRef = useRef(0);
  const matchAttemptRef = useRef("");
  const ytFetchRef = useRef("");
  // In-session cache of fully-loaded songs (keyed by path) → switching back to a
  // tab is INSTANT: no re-download, no decode, no re-analyze, no loading UI.
  const loadedRef = useRef(
    new Map<string, { loaded: LoadedSong; analysis: ChordAnalysis | null; videoId: string | null }>(),
  );

  const ytEngine = useYouTubeEngine(playbackMode === "youtube" ? youtubeId : null, syncOffset);
  const engine = playbackMode === "youtube" ? ytEngine : audioEngine;
  const youtubeError = playbackMode === "youtube" ? ytEngine.error : null;

  // Stable refs so the source switchers can pause the inactive engine without
  // depending on the (per-render) engine objects.
  const audioRef = useRef(audioEngine);
  audioRef.current = audioEngine;
  const ytRef = useRef(ytEngine);
  ytRef.current = ytEngine;

  const teardownLive = useCallback(() => {
    liveUnlistenRef.current?.();
    liveUnlistenRef.current = null;
    setLiveActive(false);
    setLiveChord(null);
    if (isTauri()) void stopLive().catch(() => {});
  }, []);

  const setPlaybackMode = useCallback((mode: PlaybackMode) => {
    setPlaybackModeState(mode);
    if (mode === "youtube") audioRef.current.pause();
    else ytRef.current.pause();
  }, []);

  const setYouTubeUrl = useCallback((url: string) => {
    const id = parseYouTubeId(url);
    if (!id) return false;
    audioRef.current.pause();
    // Just record the id — the download effect fetches the audio. We stay in
    // audio mode (no embedded player during the fetch, so no embed errors).
    setYoutubeId(id);
    setSyncOffset(0);
    setCapturing(false);
    setCaptureError(null);
    setMatchStatus({ state: "idle" });
    ytFetchRef.current = "";
    setYtFetchState("idle");
    setYtFetchError(null);
    return true;
  }, []);

  const clearYouTube = useCallback(() => {
    ytRef.current.pause();
    teardownLive();
    setYoutubeId(null);
    setSyncOffset(0);
    setPlaybackModeState("audio");
    setCapturing(false);
    setCaptureError(null);
    setMatchStatus({ state: "idle" });
    ytFetchRef.current = "";
    setYtFetchState("idle");
    setYtFetchError(null);
  }, [teardownLive]);

  const refreshLibrary = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setLibrary(await libraryList());
    } catch {
      /* ignore — library is best-effort */
    }
  }, []);

  const removeFromLibrary = useCallback(
    async (hash: string) => {
      if (!isTauri()) return;
      try {
        await libraryRemove(hash);
        await refreshLibrary();
      } catch {
        /* ignore */
      }
    },
    [refreshLibrary],
  );

  const runAnalysis = useCallback(
    async (path: string, token: number, ephemeral = false) => {
      setAnalysis(null);
      setAnalysisError(null);
      setAnalysisStatus("analyzing");
      try {
        const result = await analyzeChords(path, ephemeral);
        if (token !== loadTokenRef.current) return;
        setAnalysis(result);
        setAnalysisStatus("done");
        // Cache the result so re-opening this tab restores chords with no re-analyze.
        const cached = loadedRef.current.get(path);
        if (cached) cached.analysis = result;
        void refreshLibrary();
      } catch (e) {
        if (token !== loadTokenRef.current) return;
        setAnalysisError(typeof e === "string" ? e : String(e));
        setAnalysisStatus("error");
      }
    },
    [refreshLibrary],
  );

  // Persisted per-path title overrides (a downloaded YouTube/file title is often
  // wrong; one rename re-keys tabs + lyrics + rated bass).
  const titleOverride = useCallback((path: string, fallback: string): string => {
    try {
      const map = JSON.parse(localStorage.getItem("cmk.titleOverrides") || "{}");
      const v = map?.[path];
      return typeof v === "string" && v.trim() ? v : fallback;
    } catch {
      return fallback;
    }
  }, []);
  const renameSong = useCallback(
    (name: string) => {
      const s = songRef.current;
      const clean = name.trim();
      if (!s || !clean) return;
      try {
        const map = JSON.parse(localStorage.getItem("cmk.titleOverrides") || "{}");
        map[s.path] = clean;
        localStorage.setItem("cmk.titleOverrides", JSON.stringify(map));
      } catch {
        /* ignore */
      }
      const renamed = { ...s, name: clean };
      setSong(renamed);
      const entry = loadedRef.current.get(s.path);
      if (entry) entry.loaded = renamed; // keep the session cache in sync
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openPath = useCallback(
    async (
      path: string,
      opts?: {
        keepYouTube?: boolean;
        ephemeral?: boolean;
        name?: string;
        /** Play this source instead of `path` (e.g. the mp4 while analyzing the wav). */
        playbackSrc?: string;
        /** YouTube id of the song's video → show the in-app video player. */
        videoId?: string;
      },
    ) => {
      if (!path) return;
      if (!isSupportedAudio(path)) {
        setStatus("error");
        setError(`Unsupported file type: ${fileName(path)}`);
        return;
      }
      if (!isTauri()) {
        setStatus("error");
        setError("Audio analysis runs in the desktop app. Launch with `npm run tauri dev`.");
        return;
      }

      const token = ++loadTokenRef.current;
      setSongVideoId(null); // cleared here; the YouTube fetch sets it after.
      teardownLive(); // a loaded song shows the full timeline; live is redundant
      // New song → reset playback source to local audio, UNLESS the caller wants
      // to keep the attached YouTube video (analyze the file for chords, then sync
      // them to the video already playing).
      if (!opts?.keepYouTube) {
        ytRef.current.pause();
        setYoutubeId(null);
        setSyncOffset(0);
        setPlaybackModeState("audio");
      }
      audioRef.current.pause();
      setStatus("loading");
      setError(null);
      try {
        const info = await loadAudio(path);
        if (token !== loadTokenRef.current) return; // superseded by a newer open
        const loaded: LoadedSong = {
          path,
          name: titleOverride(path, opts?.name ?? fileName(path)),
          info,
          src: toAudioSrc(opts?.playbackSrc ?? path),
          ephemeral: opts?.ephemeral ?? false,
        };
        audioRef.current.load(loaded.src);
        setSong(loaded);
        // Remember this fully-loaded song so switching back to its tab is instant
        // (analysis filled in by runAnalysis below once it completes).
        loadedRef.current.set(path, {
          loaded,
          analysis: null,
          videoId: opts?.videoId ?? null,
        });
        // Set here (inside openPath) so they aren't lost to the fetch effect's
        // cancellation when setSong changes that effect's deps. Clearing the
        // fetch state here is what flips the loader off (the effect's own
        // `setYtFetchState("idle")` is cancelled by this very setSong).
        setSongVideoId(opts?.videoId ?? null);
        setYtFetchState("idle");
        setYtFetchError(null);
        setStatus("ready");
        void runAnalysis(path, token, opts?.ephemeral);
      } catch (e) {
        if (token !== loadTokenRef.current) return;
        setStatus("error");
        const msg = typeof e === "string" ? e : `Could not analyze this file. ${String(e)}`;
        setError(msg);
        // If this load was a YouTube fetch, surface it on the fetch UI too so the
        // loader doesn't hang (the effect's catch never fires — we threw here).
        if (opts?.videoId) {
          setYtFetchState("error");
          setYtFetchError(msg);
        }
      }
    },
    [runAnalysis, teardownLive],
  );

  const openDialog = useCallback(async () => {
    try {
      const path = await openAudioDialog();
      if (path) await openPath(path);
    } catch (e) {
      setStatus("error");
      setError(`Could not open the file picker. ${String(e)}`);
    }
  }, [openPath]);

  // Open a local file for chord analysis while keeping the current YouTube video
  // attached — used by the standalone video view's "Open audio" button.
  const openAudioForVideo = useCallback(async () => {
    try {
      const path = await openAudioDialog();
      if (path) await openPath(path);
    } catch (e) {
      setStatus("error");
      setError(`Could not open the file picker. ${String(e)}`);
    }
  }, [openPath]);

  const chooseMusicFolder = useCallback(async () => {
    try {
      const folder = await pickMusicFolder();
      if (folder) {
        localStorage.setItem("cmk.musicFolder", folder);
        setMusicFolderState(folder);
        matchAttemptRef.current = ""; // re-match against the new folder
        setMatchStatus({ state: "idle" });
      }
    } catch {
      /* ignore — user cancelled or picker failed */
    }
  }, []);

  const clearMusicFolder = useCallback(() => {
    localStorage.removeItem("cmk.musicFolder");
    setMusicFolderState(null);
    setMatchStatus({ state: "idle" });
  }, []);

  const startLiveMode = useCallback(async () => {
    if (!isTauri()) {
      setLiveError("Live runs in the desktop app (npm run tauri dev).");
      return;
    }
    setLiveError(null);
    setLiveChord(null);
    try {
      const unlisten = await onLiveChord((c) => setLiveChord(c));
      // If the provider unmounted while we awaited registration, the cleanup
      // already ran (and saw a null ref) — drop this listener now so it can't leak.
      if (!mountedRef.current) {
        unlisten();
        return;
      }
      liveUnlistenRef.current = unlisten;
      await startLive();
      setLiveActive(true);
    } catch (e) {
      liveUnlistenRef.current?.();
      liveUnlistenRef.current = null;
      setLiveActive(false);
      setLiveError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const toggleLive = useCallback(() => {
    if (liveActive) teardownLive();
    else void startLiveMode();
  }, [liveActive, teardownLive, startLiveMode]);

  const startCapture = useCallback(async () => {
    if (!isTauri()) {
      setCaptureError("Recording runs in the desktop app (npm run tauri dev).");
      return;
    }
    setCaptureError(null);
    try {
      await startSystemCapture();
      setCapturing(true);
    } catch (e) {
      setCapturing(false);
      setCaptureError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const stopCaptureAndAnalyze = useCallback(async () => {
    setCapturing(false);
    let wavPath: string;
    try {
      wavPath = await stopSystemCapture();
    } catch (e) {
      setCaptureError(typeof e === "string" ? e : String(e));
      return;
    }
    setCaptureError(null);
    // Analyze the captured audio in pure audio mode (no video). Ephemeral: the
    // captured WAV is deleted from disk right after analysis.
    await openPath(wavPath, {
      ephemeral: true,
      name: ytRef.current.videoTitle ?? "Recorded from video",
    });
  }, [openPath]);

  const reanalyze = useCallback(() => {
    // Bump the token so a concurrent in-flight load can't clobber this result,
    // and preserve `ephemeral` so re-analyzing a YouTube/captured song never
    // gets persisted into the local library.
    if (song) void runAnalysis(song.path, ++loadTokenRef.current, song.ephemeral);
  }, [song, runAnalysis]);

  // Dev/demo bootstrap: `?demo` outside Tauri loads a bundled clip + mock chords.
  useEffect(() => {
    if (isTauri() || !isDemoRequested()) return;
    const demo = demoSong();
    audioRef.current.load(demo.src);
    setSong(demo);
    setStatus("ready");
    setAnalysis(demoAnalysis(demo.info.durationSec));
    setAnalysisStatus("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the local library on startup.
  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // Paste a YouTube link → download its audio (yt-dlp) → analyze on-device →
  // full synced chord chart. The audio is ephemeral (deleted after analysis).
  useEffect(() => {
    if (!isTauri() || !youtubeId || song) return;
    if (ytFetchRef.current === youtubeId) return;
    ytFetchRef.current = youtubeId;
    const id = youtubeId;
    let cancelled = false;
    setYtFetchError(null);
    setYtFetchState("downloading");
    void (async () => {
      try {
        const audio = await downloadYoutubeAudio(id);
        if (cancelled) return;
        setYtFetchState("analyzing");
        // Analyze the extracted WAV (ephemeral → deleted after), but PLAY the
        // local mp4 so the user sees the video, perfectly synced to the chords.
        // openPath sets songVideoId itself (survives this effect's cancellation).
        // openPath flips ytFetchState→idle (or →error) itself; doing it here
        // would be a no-op since openPath's setSong cancels this effect.
        await openPath(audio.audioPath, {
          ephemeral: true,
          name: audio.title,
          playbackSrc: audio.videoPath,
          videoId: id,
        });
      } catch (e) {
        if (cancelled) return;
        setYtFetchState("error");
        setYtFetchError(typeof e === "string" ? e : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [youtubeId, song, openPath]);

  // Stop live capture if the provider ever unmounts.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      liveUnlistenRef.current?.();
      if (isTauri()) void stopLive().catch(() => {});
    };
  }, []);

  const reset = useCallback(() => {
    // unload() (not just pause) so the <video> drops its src + decoded buffers,
    // releasing its hold on the temp mp4 (swept on quit / next download).
    audioRef.current.unload();
    ytRef.current.pause();
    teardownLive();
    loadTokenRef.current++;
    setSong(null);
    setStatus("idle");
    setError(null);
    setAnalysis(null);
    setAnalysisStatus("idle");
    setAnalysisError(null);
    setYoutubeId(null);
    setSyncOffset(0);
    setPlaybackModeState("audio");
    setCapturing(false);
    setCaptureError(null);
    setMatchStatus({ state: "idle" });
    ytFetchRef.current = "";
    setYtFetchState("idle");
    setYtFetchError(null);
    setSongVideoId(null);
    // Temp audio is kept until the app actually quits (handled in Rust), so
    // closing a song does NOT delete it.
  }, [teardownLive]);

  const openTab = useCallback(
    async (t: { path: string; name?: string; videoId?: string }) => {
      if (!t.path || song?.path === t.path) return; // already the active tab
      const cached = loadedRef.current.get(t.path);
      if (cached) {
        // Already loaded this session → restore instantly, no flow at all.
        const token = ++loadTokenRef.current;
        teardownLive();
        ytRef.current.pause();
        setYoutubeId(null);
        setSyncOffset(0);
        setPlaybackModeState("audio");
        setCapturing(false);
        setCaptureError(null);
        setMatchStatus({ state: "idle" });
        ytFetchRef.current = "";
        setYtFetchState("idle");
        setYtFetchError(null);
        setError(null);
        audioRef.current.pause();
        audioRef.current.load(cached.loaded.src);
        setSong(cached.loaded);
        setSongVideoId(cached.videoId);
        setStatus("ready");
        if (cached.analysis) {
          setAnalysis(cached.analysis);
          setAnalysisError(null);
          setAnalysisStatus("done");
        } else {
          // Rare: tab switched away before analysis finished — resume it.
          void runAnalysis(t.path, token, cached.loaded.ephemeral);
        }
        return;
      }
      // Cold (first open / after app restart) → load it the normal way.
      if (t.videoId) {
        reset();
        setYouTubeUrl(`https://www.youtube.com/watch?v=${t.videoId}`);
      } else {
        await openPath(t.path);
      }
    },
    [song?.path, teardownLive, runAnalysis, reset, setYouTubeUrl, openPath],
  );

  /** Open a pasted YouTube link as a NEW tab: the current song stays in the tab
   *  strip (and the in-memory cache) while this one loads as the active tab.
   *  Returns false for an invalid link (so the input can flag it). */
  const openYouTubeUrl = useCallback(
    (url: string) => {
      if (!parseYouTubeId(url)) return false;
      reset(); // clear the active song (it remains a tab) so the fetch effect fires
      setYouTubeUrl(url);
      return true;
    },
    [reset, setYouTubeUrl],
  );

  /** Dismiss an analyze error and go back to the current song (or empty state). */
  const dismissError = useCallback(() => {
    setError(null);
    setStatus(song ? "ready" : "idle");
  }, [song]);

  const value = useMemo<AppState>(
    () => ({
      status,
      error,
      song,
      engine,
      analysisStatus,
      analysis,
      analysisError,
      library,
      playbackMode,
      youtubeId,
      youtubeError,
      syncOffset,
      ytFetchState,
      ytFetchError,
      songVideoId,
      songBpm,
      setSongBpm,
      songStartSec,
      setSongStartSec,
      songBeatsPerBar,
      setSongBeatsPerBar,
      songBeats,
      setSongBeats,
      pickTabStart,
      setPickTabStart,
      tabStartRequest,
      setTabStartRequest,
      availableTabs,
      setAvailableTabs,
      musicFolder,
      matchStatus,
      chooseMusicFolder,
      clearMusicFolder,
      liveActive,
      liveChord,
      liveError,
      toggleLive,
      capturing,
      captureError,
      startCapture,
      stopCaptureAndAnalyze,
      setYouTubeUrl,
      clearYouTube,
      setPlaybackMode,
      setSyncOffset,
      openDialog,
      openAudioForVideo,
      openPath,
      renameSong,
      dismissError,
      openTab,
      openYouTubeUrl,
      reanalyze,
      removeFromLibrary,
      reset,
    }),
    [
      status,
      error,
      song,
      engine,
      analysisStatus,
      analysis,
      analysisError,
      library,
      playbackMode,
      youtubeId,
      youtubeError,
      syncOffset,
      ytFetchState,
      ytFetchError,
      songVideoId,
      songBpm,
      songStartSec,
      songBeatsPerBar,
      songBeats,
      pickTabStart,
      tabStartRequest,
      availableTabs,
      musicFolder,
      matchStatus,
      chooseMusicFolder,
      clearMusicFolder,
      liveActive,
      liveChord,
      liveError,
      toggleLive,
      capturing,
      captureError,
      startCapture,
      stopCaptureAndAnalyze,
      setYouTubeUrl,
      clearYouTube,
      setPlaybackMode,
      setSyncOffset,
      openDialog,
      openAudioForVideo,
      openPath,
      renameSong,
      dismissError,
      openTab,
      openYouTubeUrl,
      reanalyze,
      removeFromLibrary,
      reset,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
