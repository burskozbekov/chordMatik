import { useState } from "react";
import { useAppState } from "../state/AppState";
import { baseTriad, guitarVoicing, pianoChord, ukuleleVoicing } from "../lib/voicings";
import { FretDiagram } from "./diagrams/FretDiagram";
import { PianoDiagram } from "./diagrams/PianoDiagram";
import type { Instrument } from "./ChordDiagramPanel";

const INSTRUMENTS: Instrument[] = ["guitar", "piano", "ukulele"];

/**
 * Live mode: while the video plays, chordMatik listens to the Mac's audio and
 * shows the current chord in real time — press Go live, play the song, accompany.
 * On-device; nothing is downloaded or kept.
 */
export function LiveChordView() {
  const { liveActive, liveChord, liveError, toggleLive } = useAppState();
  const [instrument, setInstrument] = useState<Instrument>("guitar");

  const isNoChord = !liveChord || liveChord.label === "N";
  const quality = baseTriad(liveChord?.quality);
  const rootPc = liveChord ? ((liveChord.rootPc % 12) + 12) % 12 : 0;

  return (
    <div className="glass rounded-3xl p-5 shadow-overlay sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="leading-tight">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            Live chords
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Press Go live, play the video, and the current chord shows in real time. On-device —
            nothing is downloaded.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleLive}
          className={
            liveActive
              ? "inline-flex items-center gap-2 rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              : "cta-gradient inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-sky-strong"
          }
        >
          <span
            className={`size-2.5 rounded-full ${liveActive ? "animate-pulse bg-white" : "bg-danger"}`}
          />
          {liveActive ? "Stop live" : "Go live"}
        </button>
      </div>

      {liveError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {liveError}
        </p>
      )}

      {liveActive && (
        <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="min-w-[6rem]">
            <span
              className={`text-6xl font-bold tracking-tight ${
                isNoChord ? "text-muted" : "text-foreground"
              }`}
            >
              {isNoChord ? "—" : liveChord!.label}
            </span>
            <p className="mt-1 text-sm text-muted">
              {isNoChord ? "listening…" : quality === "min" ? "minor" : "major"}
            </p>
          </div>

          {!isNoChord && (
            <div className="w-40 shrink-0">
              {instrument === "guitar" && (
                <FretDiagram voicing={guitarVoicing(rootPc, quality)} rootPc={rootPc} />
              )}
              {instrument === "ukulele" && (
                <FretDiagram voicing={ukuleleVoicing(rootPc, quality)} rootPc={rootPc} />
              )}
              {instrument === "piano" && <PianoDiagram chord={pianoChord(rootPc, quality)} />}
            </div>
          )}

          <div className="ml-auto flex items-center gap-0.5 self-start rounded-xl border border-border/70 bg-surface/50 p-0.5">
            {INSTRUMENTS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setInstrument(i)}
                className={`rounded-lg px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                  instrument === i
                    ? "chord-gradient text-[#06351f] shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
