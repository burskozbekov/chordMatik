import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Button } from "@heroui/react";
import { useAppState } from "../state/AppState";
import { parseYouTubeId } from "../lib/youtube";
import { Waveform } from "./Waveform";
import { TimeDisplay } from "./TimeDisplay";
import { formatTime } from "../lib/format";
import { PlaybackTools } from "./PlaybackTools";
import { TimelinePanel } from "./TimelinePanel";
import { PracticeControls } from "./PracticeControls";
import { ChordDiagramPanel, type Instrument } from "./ChordDiagramPanel";
import { YouTubeUrlInput } from "./YouTubeUrlInput";
import { CameraStudio } from "./CameraStudio";
import { TabsPanel } from "./TabsPanel";
import { LyricsPanel } from "./LyricsPanel";
import { CountIn } from "./CountIn";
import {
  CameraIcon,
  CloseIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  RestartIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "./icons";

const clampRate = (r: number) => Math.min(2, Math.max(0.25, Math.round(r * 100) / 100));

/** Paste a new YouTube link to switch songs (resets, then loads the new one). */
function SwitchSongBar() {
  const { reset, setYouTubeUrl } = useAppState();
  return (
    <YouTubeUrlInput
      onSubmit={(url) => {
        if (!parseYouTubeId(url)) return false;
        reset();
        return setYouTubeUrl(url);
      }}
      placeholder="Paste another YouTube link to switch songs"
      submitLabel="Switch"
      fullWidth
    />
  );
}

/** The loaded-song view: header, player, practice controls, diagram + timeline. */
export function Player() {
  const { song, engine, analysis, analysisStatus, songVideoId, songBpm, songBeatsPerBar, songBeats, songStartSec, openDialog, reset } =
    useAppState();
  const [transpose, setTranspose] = useState(0);
  const [capo, setCapo] = useState(0);
  const [instrument, setInstrument] = useState<Instrument>("guitar");
  const [useFlats, setUseFlats] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const videoBoxRef = useRef<HTMLDivElement>(null);

  // Mount the engine's <video> element into the video box (for YouTube-sourced
  // songs). The transport + native controls both drive it; chords stay synced.
  useEffect(() => {
    const box = videoBoxRef.current;
    const el = engine.audioEl as HTMLVideoElement | null;
    if (!box || !el || !songVideoId) return;
    el.controls = true;
    el.className = "h-full w-full bg-black object-contain";
    box.appendChild(el);
    return () => {
      el.controls = false;
      if (el.parentNode === box) box.removeChild(el);
    };
  }, [engine.audioEl, songVideoId]);

  if (!song) return null;
  const { info, name } = song;
  const hasChords = analysisStatus === "done";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="mx-auto flex w-full max-w-4xl flex-col gap-3"
    >
      {/* Sticky control strip — play/pause, count-in, camera stay within reach
          even when scrolled down to the tab below. */}
      <div className="sticky top-0 z-30 flex items-center gap-1.5 rounded-2xl border border-border/60 bg-[color-mix(in_oklab,var(--surface)_85%,transparent)] px-2.5 py-1.5 shadow-overlay backdrop-blur-md">
        <button
          type="button"
          aria-label="Restart"
          onClick={() => engine.seek(songStartSec > 0 ? songStartSec : 0)}
          title={songStartSec > 0 ? "Restart from bar 1 (R)" : "Restart from the beginning"}
          className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <RestartIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label={engine.isPlaying ? "Pause" : "Play"}
          onClick={engine.toggle}
          className="cta-gradient grid size-9 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-sky-strong"
        >
          {engine.isPlaying ? (
            <PauseIcon className="size-4" />
          ) : (
            <PlayIcon className="size-4 translate-x-[1px]" />
          )}
        </button>
        <button
          type="button"
          aria-label="Back 5 seconds"
          onClick={() => engine.seekBy(-5)}
          className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <SkipBackIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Forward 5 seconds"
          onClick={() => engine.seekBy(5)}
          className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <SkipForwardIcon className="size-4" />
        </button>
        <div className="flex items-center gap-1 pl-1 text-xs font-medium text-muted">
          <TimeDisplay engine={engine} className="w-10 tabular-nums" />
          <span className="opacity-40">/</span>
          <span className="w-10 tabular-nums">
            {info.durationSec ? formatTime(info.durationSec) : "–:––"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-surface/50 p-0.5">
            <button
              type="button"
              aria-label="Slower"
              onClick={() => engine.setPlaybackRate(clampRate(engine.playbackRate - 0.05))}
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-muted transition-colors hover:text-foreground"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => engine.setPlaybackRate(1)}
              title="Reset speed to 1×"
              className="min-w-[2.9rem] rounded px-1 py-0.5 text-center font-mono text-xs font-semibold tabular-nums text-foreground transition-colors hover:bg-surface"
            >
              {engine.playbackRate.toFixed(2)}×
            </button>
            <button
              type="button"
              aria-label="Faster"
              onClick={() => engine.setPlaybackRate(clampRate(engine.playbackRate + 0.05))}
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-muted transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              // Reset to the marked bar-1 start (or the very beginning), then
              // count in and play FROM there — never from the middle.
              engine.pause();
              engine.seek(songStartSec > 0 ? songStartSec : 0);
              setCountIn(true);
            }}
            disabled={countIn}
            title={`Count in at ${songBpm > 0 ? Math.round(songBpm) : 120} BPM from ${
              songStartSec > 0 ? "the marked start" : "the beginning"
            }, then play`}
            className="inline-flex items-center gap-1 rounded-lg border border-border/70 bg-surface/70 px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface disabled:opacity-50"
          >
            ⏱ Count-in
          </button>
          <button
            type="button"
            onClick={() => setShowCamera((v) => !v)}
            aria-label={showCamera ? "Close camera" : "Open camera"}
            className={
              showCamera
                ? "inline-flex items-center gap-1 rounded-lg border border-[var(--accent)]/60 bg-[var(--accent)]/15 px-2 py-1 text-xs font-semibold text-[var(--accent)] transition-colors"
                : "inline-flex items-center gap-1 rounded-lg border border-border/70 bg-surface/70 px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface"
            }
          >
            <CameraIcon className="size-3.5" strokeWidth={2} />
            {showCamera ? "Close" : "Camera"}
          </button>
        </div>
      </div>

      {/* Header: title + switch-song box + actions, all on one compact row. */}
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 shrink truncate text-base font-semibold tracking-tight text-foreground">
          {name}
        </h2>
        <div className="ml-auto hidden min-w-0 flex-1 sm:block">
          <SwitchSongBar />
        </div>
        <Button variant="ghost" size="sm" isIconOnly aria-label="Open a file" onPress={openDialog}>
          <FolderOpenIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" isIconOnly aria-label="Close song" onPress={reset}>
          <CloseIcon className="size-4" />
        </Button>
      </div>

      {/* Player: video (YouTube-sourced) or thin waveform (local file), then
          transport + speed/loop tools. */}
      <div className="glass rounded-2xl px-4 py-3 shadow-overlay">
        {songVideoId ? (
          <div
            ref={videoBoxRef}
            className="relative mx-auto aspect-video w-full max-w-sm overflow-hidden rounded-xl bg-black"
          />
        ) : (
          <Waveform
            peaks={info.peaks}
            durationSec={info.durationSec}
            engine={engine}
            loopRegion={engine.loop}
            height={26}
          />
        )}
        <div className="mt-2 border-t border-border/50 pt-2">
          <PlaybackTools key={song.path} engine={engine} />
        </div>
      </div>

      {/* The synced chord ribbon — Chordify centerpiece, right under the player. */}
      <TimelinePanel transpose={transpose} useFlats={useFlats} />

      {/* Practice controls + current-chord diagram (once chords are ready). */}
      {hasChords && (
        <>
          <PracticeControls
            transpose={transpose}
            capo={capo}
            instrument={instrument}
            useFlats={useFlats}
            onTranspose={setTranspose}
            onCapo={setCapo}
            onInstrument={setInstrument}
            onUseFlats={setUseFlats}
          />
          <ChordDiagramPanel
            instrument={instrument}
            transpose={transpose}
            capo={capo}
            useFlats={useFlats}
          />
        </>
      )}

      {/* Real guitar/bass tablature (Songsterr), fetched + cached; skips if none. */}
      <TabsPanel title={song.name} />

      {/* Synced lyrics (lrclib) at the very bottom — hides if none found. */}
      <LyricsPanel title={song.name} />

      {showCamera && (
        <CameraStudio
          engine={engine}
          segments={analysis?.segments ?? []}
          transpose={transpose}
          onClose={() => setShowCamera(false)}
        />
      )}

      {countIn && (
        <CountIn
          bpm={songBpm > 0 ? songBpm : 120}
          beatsPerBar={songBeatsPerBar > 0 ? songBeatsPerBar : 4}
          songBeats={songBeats}
          startSec={songStartSec}
          onDone={() => {
            setCountIn(false);
            engine.play();
          }}
        />
      )}
    </motion.div>
  );
}
