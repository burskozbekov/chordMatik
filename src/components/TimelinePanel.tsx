import { useMemo } from "react";
import { Button } from "@heroui/react";
import { motion } from "motion/react";
import { useAppState } from "../state/AppState";
import { estimateKey } from "../lib/key";
import { detectSections } from "../lib/sections";
import { ChordTimeline } from "./ChordTimeline";
import { AlertIcon, BoltIcon, SparkleIcon } from "./icons";

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

interface TimelinePanelProps {
  transpose?: number;
  useFlats?: boolean;
}

/** Header + the synced timeline, with analyzing/error/empty states. */
export function TimelinePanel({ transpose = 0, useFlats = false }: TimelinePanelProps) {
  const {
    engine,
    analysis,
    analysisStatus,
    analysisError,
    reanalyze,
    pickTabStart,
    setPickTabStart,
    setTabStartRequest,
    availableTabs,
  } = useAppState();
  const eng = analysis?.engine;
  const isNeural = eng === "btc" || eng === "chordnet";
  const engineLabel =
    eng === "chordnet" ? "ChordNet · inversions" : eng === "btc" ? "BTC model" : "Built-in engine";

  const keyEst = useMemo(() => (analysis ? estimateKey(analysis.segments) : null), [analysis]);
  const sections = useMemo(
    () => (analysis ? detectSections(analysis.segments, analysis.durationSec) : []),
    [analysis],
  );
  const keyName =
    keyEst && keyEst.confidence > 0.3
      ? `${(useFlats ? FLAT_NAMES : SHARP_NAMES)[((keyEst.tonicPc + transpose) % 12 + 12) % 12]} ${keyEst.mode}`
      : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Chord timeline</h3>
          {analysis && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-surface/60 px-2 py-0.5 text-[11px] font-medium text-muted">
              {isNeural ? <SparkleIcon className="size-3" /> : <BoltIcon className="size-3" />}
              {engineLabel} · {analysis.segments.length} chords
            </span>
          )}
          {keyName && (
            <span
              className="rounded-full border border-border/70 bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-foreground"
              title="Estimated key (Krumhansl-Schmuckler over the chord track)"
            >
              Key: {keyName}
            </span>
          )}
        </div>
        {analysisStatus === "done" && (
          <Button variant="ghost" size="sm" onPress={reanalyze} className="text-muted">
            Re-analyze
          </Button>
        )}
      </div>

      {analysisStatus === "analyzing" ? (
        <Analyzing />
      ) : analysisStatus === "error" ? (
        <Errored message={analysisError ?? "Analysis failed."} onRetry={reanalyze} />
      ) : analysis && analysis.segments.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {pickTabStart && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--accent)]/50 bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-3 py-1.5 text-xs font-semibold text-foreground">
              <span>📍 Click the chord where the tab&apos;s bar 1 begins.</span>
              <button
                type="button"
                onClick={() => setPickTabStart(false)}
                className="rounded-lg px-2 py-0.5 text-muted transition-colors hover:bg-surface hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
          {sections.length > 1 && (
            <div className="flex h-5 w-full gap-px overflow-hidden rounded-lg" title="Song sections (click to jump)">
              {sections.map((s, i) => {
                const frac = (s.endSec - s.startSec) / Math.max(0.001, analysis.durationSec);
                const tint = 10 + ((s.label.charCodeAt(0) - 65) % 6) * 12;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => engine.seek(s.startSec)}
                    title={`${s.label} · ${Math.round(s.startSec)}s`}
                    className="grid place-items-center text-[10px] font-bold text-foreground/80 transition-opacity hover:opacity-80"
                    style={{
                      flexGrow: frac,
                      flexBasis: 0,
                      background: `color-mix(in oklab, var(--accent) ${tint}%, transparent)`,
                    }}
                  >
                    {frac > 0.04 ? s.label : ""}
                  </button>
                );
              })}
            </div>
          )}
          <ChordTimeline
            analysis={analysis}
            engine={engine}
            transpose={transpose}
            useFlats={useFlats}
            picking={pickTabStart}
            availableTabs={availableTabs}
            onPick={(t, which) => {
              setTabStartRequest({ time: t, which: which ?? null });
              setPickTabStart(false);
            }}
          />
        </div>
      ) : analysis ? (
        <Empty />
      ) : (
        <Analyzing />
      )}
    </section>
  );
}

function Analyzing() {
  return (
    <div className="relative grid h-44 w-full place-items-center overflow-hidden rounded-3xl border border-border/60 bg-surface/40">
      <motion.div
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-brand-sky/10 to-transparent"
        animate={{ x: ["-100%", "100%"] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="z-10 flex flex-col items-center gap-3">
        <div className="relative grid size-11 place-items-center">
          <motion.span
            className="absolute inset-0 rounded-full border-[3px] border-brand-sky/25 border-t-brand-sky"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
          />
          <span className="chord-gradient size-5 rounded-md" />
        </div>
        <p className="text-sm font-medium text-muted">Finding chords…</p>
      </div>
    </div>
  );
}

function Errored({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-44 w-full flex-col items-center justify-center gap-3 rounded-3xl border border-danger/30 bg-danger/5 px-6 text-center">
      <div className="grid size-11 place-items-center rounded-2xl bg-danger/12 text-danger">
        <AlertIcon className="size-6" />
      </div>
      <p className="max-w-md text-sm text-muted">{message}</p>
      <Button variant="primary" size="sm" onPress={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Empty() {
  return (
    <div className="grid h-44 w-full place-items-center rounded-3xl border border-border/60 bg-surface/40 text-center">
      <p className="text-sm text-muted">No chords were detected in this track.</p>
    </div>
  );
}
