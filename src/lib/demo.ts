/**
 * Dev/demo mode (`?demo` in the URL, outside Tauri). Loads a bundled clip and a
 * matching mock analysis so the player + timeline can be previewed in a plain
 * browser without the Rust backend. Harmless in production (gated on `?demo`
 * and non-Tauri).
 */
import type { ChordAnalysis, LoadedSong } from "./types";

const PROGRESSION = [
  { rootPc: 0, quality: "maj", label: "C", index: 0 },
  { rootPc: 7, quality: "maj", label: "G", index: 7 },
  { rootPc: 9, quality: "min", label: "Am", index: 21 },
  { rootPc: 5, quality: "maj", label: "F", index: 5 },
] as const;

export function isDemoRequested(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
}

export function demoAnalysis(durationSec = 8): ChordAnalysis {
  const segDur = durationSec / PROGRESSION.length;
  const segments = PROGRESSION.map((c, i) => ({
    startSec: i * segDur,
    endSec: (i + 1) * segDur,
    label: c.label,
    rootPc: c.rootPc,
    quality: c.quality,
    index: c.index,
  }));
  return { engine: "chroma", frameHopSec: 0.0929, durationSec, segments, bpm: 120 };
}

function demoPeaks(n = 900): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / n) * Math.PI * 4));
    out.push(Math.min(1, env * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.6)))));
  }
  return out;
}

export function demoSong(): LoadedSong {
  return {
    path: "demo.wav",
    name: "Demo · C – G – Am – F",
    src: "/demo.wav",
    info: {
      path: "demo.wav",
      durationSec: 8,
      sampleRate: 44100,
      channels: 2,
      peaks: demoPeaks(),
    },
  };
}
