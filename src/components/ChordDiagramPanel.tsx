import { AnimatePresence, motion } from "motion/react";
import { useAppState } from "../state/AppState";
import { useActiveChord } from "../hooks/useActiveChord";
import { chordDisplay, transposePc } from "../lib/chords";
import { baseTriad, guitarVoicing, pianoChord, ukuleleVoicing } from "../lib/voicings";
import { FretDiagram } from "./diagrams/FretDiagram";
import { PianoDiagram } from "./diagrams/PianoDiagram";

export type Instrument = "guitar" | "piano" | "ukulele";

interface ChordDiagramPanelProps {
  instrument: Instrument;
  transpose: number;
  capo: number;
  useFlats?: boolean;
}

/** "Now playing" current chord with its diagram for the chosen instrument. */
export function ChordDiagramPanel({ instrument, transpose, capo, useFlats = false }: ChordDiagramPanelProps) {
  const { engine, analysis } = useAppState();
  const { active, next } = useActiveChord(engine, analysis?.segments ?? []);

  const sounding = active ? chordDisplay(active, transpose, useFlats) : null;
  const nextDisp = next ? chordDisplay(next, transpose, useFlats) : null;
  const isNoChord = !sounding || sounding.isNoChord;

  // Guitar/ukulele shapes drop by the capo amount; piano shows sounding notes.
  const shapePc =
    active && !isNoChord ? transposePc(active.rootPc, transpose - capo) : 0;
  const quality = baseTriad(active?.quality);
  const shapeLabel =
    active && !isNoChord
      ? chordDisplay({ rootPc: transposePc(active.rootPc, transpose - capo), quality }, 0, useFlats).label
      : "";

  return (
    <section className="glass flex items-center gap-4 rounded-2xl px-5 py-3">
      {/* Current chord */}
      <div className="flex min-w-[5.5rem] flex-col justify-center">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Now playing
        </span>
        <div className="flex items-baseline gap-2">
          <span className="relative inline-grid">
            <AnimatePresence initial={false}>
              <motion.span
                key={sounding?.label ?? "—"}
                initial={{ scale: 0.68, opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ scale: 1, opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ scale: 0.9, opacity: 0, y: -8, filter: "blur(4px)" }}
                transition={{ type: "spring", stiffness: 460, damping: 24, mass: 0.6 }}
                className={`col-start-1 row-start-1 text-4xl font-bold tracking-tight ${
                  isNoChord ? "text-muted" : "text-foreground"
                }`}
              >
                {sounding?.label ?? "—"}
              </motion.span>
            </AnimatePresence>
          </span>
          {nextDisp && (
            <span className="text-xs text-muted">
              → <span className="font-semibold text-foreground/70">{nextDisp.label}</span>
            </span>
          )}
        </div>
        {capo > 0 && !isNoChord && instrument !== "piano" && (
          <span className="mt-1 w-fit rounded-md bg-brand-sky/12 px-2 py-0.5 text-[11px] font-medium text-brand-sky-strong dark:text-brand-sky">
            Capo {capo} · play {shapeLabel}
          </span>
        )}
      </div>

      {/* Diagram */}
      <div className="flex flex-1 items-center justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {isNoChord ? (
            <div className="grid h-[104px] w-full place-items-center text-sm text-muted">—</div>
          ) : (
            <motion.div
              key={`${instrument}-${shapePc}-${quality}`}
              initial={{ opacity: 0, scale: 0.92, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={{ type: "spring", stiffness: 380, damping: 28, mass: 0.7 }}
              className="flex items-center justify-center"
            >
              {instrument === "piano" ? (
                <div className="h-[96px] w-full max-w-[260px]">
                  <PianoDiagram chord={pianoChord(transposePc(active!.rootPc, transpose), quality)} />
                </div>
              ) : (
                <div className="h-[112px] w-full max-w-[170px]">
                  <FretDiagram
                    voicing={
                      instrument === "guitar"
                        ? guitarVoicing(shapePc, quality)
                        : ukuleleVoicing(shapePc, quality)
                    }
                    rootPc={shapePc}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
