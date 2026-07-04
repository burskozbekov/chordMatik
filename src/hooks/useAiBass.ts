import { useEffect, useState } from "react";
import {
  downloadModel,
  modelPresent,
  onModelProgress,
  transcribeBass,
  type TranscribedBassNote,
} from "../lib/tauri";

/**
 * AI bass transcription state + actions (basic-pitch, with optional Demucs HQ
 * isolation). Owns: the transcribed notes (cached per song), the working/error
 * state, and the one-time 316 MB HQ model download with progress. Extracted
 * verbatim from TabsPanel — behaviour-identical. The caller wires `onEnterAi`
 * (switch the view to the AI bass source) and `onFail` (fall back).
 */
export function useAiBass(
  songPath: string | undefined,
  onEnterAi: () => void,
  onFail: () => void,
) {
  const [aiNotes, setAiNotes] = useState<TranscribedBassNote[] | null>(null);
  const [aiState, setAiState] = useState<"idle" | "working" | "error">("idle");
  // HQ: Demucs bass isolation before transcription. Once downloaded, every
  // AI-bass run uses it. `hqProgress` is the download % (null when idle).
  const [hqReady, setHqReady] = useState(false);
  const [hqProgress, setHqProgress] = useState<number | null>(null);

  // The transcription is recording-specific — clear it when the song changes.
  useEffect(() => {
    setAiNotes(null);
    setAiState("idle");
  }, [songPath]);

  // Is the Demucs HQ model already on disk? (Then every AI-bass run is HQ.)
  useEffect(() => {
    modelPresent("demucs-bass").then(setHqReady).catch(() => {});
  }, []);

  // Transcribe the real bass from the audio (download the model first if needed).
  // Uses Demucs isolation automatically once that model is present.
  const runAiBass = async () => {
    onEnterAi();
    if (aiNotes || aiState === "working" || !songPath) return;
    setAiState("working");
    try {
      if (!(await modelPresent("basic-pitch"))) await downloadModel("basic-pitch");
      const notes = await transcribeBass(songPath);
      setAiNotes(notes);
      setAiState(notes.length ? "idle" : "error");
    } catch {
      setAiState("error");
      onFail();
    }
  };

  // Enable HQ: download the Demucs bass model (with progress) then (re)transcribe —
  // the isolated bass gives a much cleaner tab.
  const enableHq = async () => {
    if (aiState === "working" || hqProgress !== null || !songPath) return;
    onEnterAi();
    setAiState("working");
    let un: (() => void) | null = null;
    try {
      if (!(await modelPresent("demucs-bass"))) {
        setHqProgress(0);
        un = await onModelProgress((p) => {
          if (p.name === "demucs-bass" && p.total > 0)
            setHqProgress(Math.round((p.received / p.total) * 100));
        });
        await downloadModel("demucs-bass");
      }
      setHqProgress(null);
      setHqReady(true);
      if (!(await modelPresent("basic-pitch"))) await downloadModel("basic-pitch");
      const notes = await transcribeBass(songPath);
      setAiNotes(notes);
      setAiState(notes.length ? "idle" : "error");
    } catch {
      setAiState("error");
    } finally {
      un?.();
      setHqProgress(null);
    }
  };

  return { aiNotes, aiState, hqReady, hqProgress, runAiBass, enableHq };
}
