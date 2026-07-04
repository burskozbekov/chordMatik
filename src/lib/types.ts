/** Shared types mirroring the Rust command return shapes. */

export interface AudioInfo {
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** Per-bucket peak amplitudes in [0, 1] for the waveform overview. */
  peaks: number[];
}

export interface AppMeta {
  name: string;
  version: string;
  os: string;
}

export interface ChordSegment {
  startSec: number;
  endSec: number;
  /** Raw model label, e.g. "C", "G#m", "N". */
  label: string;
  /** Root pitch class 0–11 (C=0), or -1 for no-chord. */
  rootPc: number;
  quality: "maj" | "min" | "N" | string;
  /** Bass pitch class for slash chords (inversions), or -1 for root position. */
  bassPc?: number;
  /** Index in the engine's vocabulary. */
  index: number;
}

/** A Songsterr track (raw native note model) — input to the AlphaTab converter. */
export interface SongsterrTrack {
  name?: string;
  instrument?: string;
  instrumentId?: number;
  tuning?: number[]; // MIDI per string, high→low
  strings?: number;
  frets?: number;
  measures?: SongsterrMeasure[];
  automations?: { tempo?: { measure: number; bpm: number }[] };
}
export interface SongsterrMeasure {
  voices?: { beats?: SongsterrBeat[] }[];
  signature?: [number, number];
  marker?: { text?: string };
}
export interface SongsterrBeat {
  notes?: { string: number; fret: number; ghost?: boolean; tie?: boolean; dead?: boolean }[];
  duration?: [number, number]; // [numerator, denominator]
  dots?: number;
  rest?: boolean;
  type?: number;
  chord?: { text?: string };
}

/** The instruments a song's tab can be shown for. */
export type TabInstrument = "guitar" | "bass" | "piano" | "drums";

/** Result of fetching guitar/bass tabs for a song. */
export interface TabCandidate {
  songId: number;
  artist: string;
  title: string;
  score: number;
  views: number;
  hasChords: boolean;
}

export interface TabResult {
  songId: number;
  artist: string;
  title: string;
  guitar: SongsterrTrack | null;
  bass: SongsterrTrack | null;
  drums?: SongsterrTrack | null;
  piano?: SongsterrTrack | null;
  /** Ranked alternates for audio cross-validation / "try another version". */
  candidates?: TabCandidate[];
}

export interface LyricsResult {
  /** LRC-format synced lyrics ("[mm:ss.xx] line"), or null. */
  synced: string | null;
  plain: string | null;
  artist: string;
  title: string;
}

export interface ChordAnalysis {
  /** "chroma" (built-in) or "btc" (ONNX model). */
  engine: string;
  frameHopSec: number;
  durationSec: number;
  segments: ChordSegment[];
  /** Measured felt-tactus tempo (BPM) from the recording's bass onset track, 0 if unknown. */
  bpm: number;
}

export interface LibraryItem {
  hash: string;
  path: string;
  name: string;
  durationSec: number;
  engine: string;
  chordCount: number;
  /** Unix seconds. */
  savedAt: number;
}

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type AnalysisStatus = "idle" | "analyzing" | "done" | "error";

export interface LoadedSong {
  path: string;
  name: string;
  info: AudioInfo;
  /** Webview-playable source URL (asset protocol). */
  src: string;
  /** True for downloaded/captured temp songs that must never be cached. */
  ephemeral?: boolean;
}
