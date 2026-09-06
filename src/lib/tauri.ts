/** Thin, typed wrappers around the Tauri bridge. */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AUDIO_EXTENSIONS } from "../theme/tokens";
import type {
  AppMeta,
  AudioInfo,
  ChordAnalysis,
  LibraryItem,
  LyricsResult,
  TabResult,
} from "./types";

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Native tab/score formats AlphaTab imports directly (Guitar Pro + MusicXML). */
export const TAB_FILE_EXTENSIONS = ["gp", "gpx", "gp7", "gp5", "gp4", "gp3", "musicxml", "xml", "mxl"];

/** Pick a Guitar Pro / MusicXML file and read its bytes (for AlphaTab api.load). */
export async function openTabFile(): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!isTauri()) return null;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Tab / Score", extensions: TAB_FILE_EXTENSIONS }],
  });
  if (!path || typeof path !== "string") return null;
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  const name = path.split(/[/\\]/).pop() ?? "tab";
  return { bytes, name };
}

/** Open a URL in the user's default browser (native app), or a new tab (web). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Save recorded video bytes to a user-chosen file. In the desktop app this
 * opens a native save dialog then writes via plugin-fs; in a plain browser
 * (dev) it falls back to a download. Returns false if the user cancelled.
 */
export async function saveRecording(
  bytes: Uint8Array,
  defaultName: string,
  mimeType = "video/mp4",
): Promise<boolean> {
  if (!isTauri()) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const ext = defaultName.split(".").pop() || "mp4";
  // Default into Downloads (within the fs capability's $HOME/** write scope) so
  // the common case never hits a forbidden-path error.
  let defaultPath = defaultName;
  try {
    const { downloadDir } = await import("@tauri-apps/api/path");
    defaultPath = `${await downloadDir()}/${defaultName}`;
  } catch {
    /* fall back to a bare filename */
  }
  const path = await save({ defaultPath, filters: [{ name: "Video", extensions: [ext] }] });
  if (!path) return false;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, bytes);
  return true;
}

/** Fetch the best guitar+bass tab for a song title (Songsterr), or null.
 *  `fresh` bypasses the on-disk pick cache (↻ Refresh — re-run the search). */
export async function fetchTabs(title: string, fresh = false): Promise<TabResult | null> {
  if (!isTauri()) return null;
  return invoke<TabResult | null>("fetch_tabs", { title, fresh });
}

/** Fetch synced/plain lyrics for a (messy) song title from lrclib, or null. */
export async function fetchLyrics(title: string): Promise<LyricsResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<LyricsResult | null>("fetch_lyrics", { title });
  } catch {
    return null;
  }
}

/** One alternate bass-tab version (Ultimate Guitar) for the version picker. */
export interface BassTabVersion {
  id: number;
  artist: string;
  song: string;
  rating: number;
  votes: number;
}

/** The highest-rated community bass tab (Ultimate Guitar), plain ASCII + rating. */
export interface RatedBassTab {
  id: number;
  artist: string;
  song: string;
  rating: number;
  votes: number;
  url: string;
  content: string;
  versions: BassTabVersion[];
}

/** Find the highest-STARRED bass tab (Ultimate Guitar) for a (messy) song title.
 *  `fresh` bypasses the on-disk pick cache (↻ refresh). */
export async function fetchBassTab(title: string, fresh = false): Promise<RatedBassTab | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<RatedBassTab | null>("fetch_bass_tab", { title, fresh });
  } catch {
    return null;
  }
}

/** Load a specific bass-tab version's ASCII content by id (version picker). */
export async function fetchBassTabContent(id: number): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("fetch_bass_tab_content", { id });
  } catch {
    return null;
  }
}

/** Fetch a specific candidate's tracks by songId — for "try another version". */
export async function fetchTabTrack(
  songId: number,
  title: string,
  artist: string,
): Promise<TabResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<TabResult | null>("fetch_tab_track", { songId, title, artist });
  } catch {
    return null;
  }
}

/** On-device tempo + first-onset + onset peaks for the sync auto-guess / snap. */
export async function detectBeat(
  wavPath: string,
): Promise<{ bpm: number; startSec: number; onsets: number[] } | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<{ bpm: number; startSec: number; onsets: number[] }>("detect_beat", {
      wavPath,
    });
  } catch {
    return null;
  }
}

/**
 * Beat positions (seconds) tracked from the recording at the given target tempo.
 * Drives the metronome so its clicks ride the song's real beats (and tempo drift)
 * instead of a fixed grid. `bpm` sets the octave; onset-following fixes the value.
 */
export async function trackBeats(wavPath: string, bpm: number): Promise<number[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<number[]>("track_beats", { wavPath, bpm });
  } catch {
    return [];
  }
}

export interface RefinedAnchor {
  barIndex: number;
  millisecondOffset: number;
  confidence: number;
}
export interface RefineResult {
  anchors: RefinedAnchor[];
  confidence: number;
}

/**
 * Phase B: refine coarse chord-DTW sync anchors to ~50ms via chroma-frame DTW in
 * the Rust core (reuses the recording's CQT). Returns null off-Tauri / on error.
 */
export async function refineSync(
  wavPath: string,
  tabFrames: number[][],
  barStartTabFrame: number[],
  coarseAnchors: { barIndex: number; millisecondOffset: number }[],
): Promise<RefineResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<RefineResult>("refine_sync", {
      wavPath,
      tabFrames,
      barStartTabFrame,
      coarseAnchors,
    });
  } catch {
    return null;
  }
}

/** Start capturing system audio (macOS). Triggers the Screen Recording prompt. */
export function startSystemCapture(): Promise<void> {
  return invoke<void>("start_system_capture");
}

/** The current chord pushed by live detection. */
export interface LiveChord {
  idx: number;
  label: string;
  rootPc: number;
  quality: string;
}

/** Start continuous live chord detection (emits "live-chord" events). */
export function startLive(): Promise<void> {
  return invoke<void>("start_live");
}

/** Stop live chord detection. */
export function stopLive(): Promise<void> {
  return invoke<void>("stop_live");
}

/** Subscribe to live chord updates. Returns an unlisten fn. */
export async function onLiveChord(cb: (c: LiveChord) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LiveChord>("live-chord", (e) => cb(e.payload));
}

/** Stop capture, returning the path to the written WAV (feed it to analyzeChords). */
export function stopSystemCapture(): Promise<string> {
  return invoke<string>("stop_system_capture");
}

/** Decode a file and return metadata + waveform peaks. */
export function loadAudio(path: string, waveformBuckets?: number): Promise<AudioInfo> {
  return invoke<AudioInfo>("load_audio", { path, waveformBuckets });
}

export function appInfo(): Promise<AppMeta> {
  return invoke<AppMeta>("app_info");
}

/**
 * Analyze a file and return its chord timeline. `ephemeral` (downloaded/captured
 * audio) keeps the entry out of the library; `force` bypasses the on-disk cache
 * so the engine actually runs again (the Re-analyze button).
 */
export function analyzeChords(
  path: string,
  ephemeral = false,
  force = false,
): Promise<ChordAnalysis> {
  return invoke<ChordAnalysis>("analyze_chords", { path, ephemeral, force });
}

/** Previously analyzed songs (local library), newest first. */
export function libraryList(): Promise<LibraryItem[]> {
  return invoke<LibraryItem[]>("library_list");
}

export function libraryRemove(hash: string): Promise<void> {
  return invoke<void>("library_remove", { hash });
}

/** Open the native file picker; returns the chosen path or null if cancelled. */
export async function openAudioDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open a song",
    filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Pick a music folder to auto-match YouTube links against. */
export async function pickMusicFolder(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: true,
    title: "Choose your music folder",
  });
  return typeof selected === "string" ? selected : null;
}

/** A local file matched to a YouTube title (0–1 confidence). */
export interface AudioMatch {
  path: string;
  name: string;
  score: number;
}

/** Find the best local-file match for a video title in `folder` (or null). */
export function findMatchingAudio(folder: string, query: string): Promise<AudioMatch | null> {
  return invoke<AudioMatch | null>("find_matching_audio", { folder, query });
}

/** A downloaded YouTube video (mp4, played locally) + a WAV for analysis + title. */
export interface YtAudio {
  audioPath: string;
  videoPath: string;
  title: string;
}

/** Download a YouTube video's audio to a local WAV (via yt-dlp). */
export function downloadYoutubeAudio(videoId: string): Promise<YtAudio> {
  return invoke<YtAudio>("download_youtube_audio", { videoId });
}

/** Update yt-dlp in place (Homebrew upgrade, or yt-dlp -U). Resolves to the new version. */
export function updateYtDlp(): Promise<string> {
  return invoke<string>("update_ytdlp");
}

/** Delete temp audio (downloaded/captured WAVs) — call on close / next song. */
export function cleanupTempAudio(): Promise<void> {
  return invoke<void>("cleanup_temp_audio");
}

/** Whether a large downloadable AI model is already on disk. */
export function modelPresent(name: string): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>("model_present", { name });
}

/** Download a large AI model on first use (streams + emits "model-download"). */
export function downloadModel(name: string): Promise<void> {
  return invoke<void>("download_model", { name });
}

export interface ModelProgress {
  name: string;
  received: number;
  total: number;
  done: boolean;
}

/** Subscribe to model-download progress. Returns an unlisten fn. */
export async function onModelProgress(cb: (p: ModelProgress) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ModelProgress>("model-download", (e) => cb(e.payload));
}

export interface TranscribedBassNote {
  startSec: number;
  durSec: number;
  midi: number;
}

/** Transcribe the song's bass line from the recording (basic-pitch). Needs the model. */
export function transcribeBass(wavPath: string): Promise<TranscribedBassNote[]> {
  return invoke<TranscribedBassNote[]>("transcribe_bass", { wavPath });
}

/** Convert an absolute file path to a webview-playable source URL. */
export function toAudioSrc(path: string): string {
  return convertFileSrc(path);
}

/** Basename of a path (handles both `/` and `\`). */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** File extension (lowercase, no dot), or "" if none. */
export function fileExt(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a path looks like one of our supported audio files. */
export function isSupportedAudio(path: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(fileExt(path));
}
