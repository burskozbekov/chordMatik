import { Button } from "@heroui/react";
import { formatSemitones } from "../lib/chords";
import type { Instrument } from "./ChordDiagramPanel";

interface PracticeControlsProps {
  transpose: number;
  capo: number;
  instrument: Instrument;
  useFlats: boolean;
  onTranspose: (n: number) => void;
  onCapo: (n: number) => void;
  onInstrument: (i: Instrument) => void;
  onUseFlats: (v: boolean) => void;
}

const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: "guitar", label: "Guitar" },
  { id: "piano", label: "Piano" },
  { id: "ukulele", label: "Ukulele" },
];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Transpose + capo steppers and an instrument segmented control. */
export function PracticeControls({
  transpose,
  capo,
  instrument,
  useFlats,
  onTranspose,
  onCapo,
  onInstrument,
  onUseFlats,
}: PracticeControlsProps) {
  return (
    <div className="glass flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-4">
        <Stepper
          label="Transpose"
          display={formatSemitones(transpose)}
          onDec={() => onTranspose(clamp(transpose - 1, -11, 11))}
          onInc={() => onTranspose(clamp(transpose + 1, -11, 11))}
          onReset={() => onTranspose(0)}
        />
        <Stepper
          label="Capo"
          display={capo === 0 ? "Off" : String(capo)}
          onDec={() => onCapo(clamp(capo - 1, 0, 11))}
          onInc={() => onCapo(clamp(capo + 1, 0, 11))}
          onReset={() => onCapo(0)}
        />
        {/* Accidental spelling — sharps (A♯) vs flats (B♭). */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Keys</span>
          <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
            {[
              { flat: false, label: "♯" },
              { flat: true, label: "♭" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => onUseFlats(o.flat)}
                title={o.flat ? "Use flats (e.g. B♭)" : "Use sharps (e.g. A♯)"}
                className={`grid size-7 place-items-center rounded-lg text-sm font-semibold transition-colors ${
                  useFlats === o.flat
                    ? "chord-gradient text-[#06351f] shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
        {INSTRUMENTS.map((ins) => {
          const active = ins.id === instrument;
          return (
            <button
              key={ins.id}
              type="button"
              onClick={() => onInstrument(ins.id)}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                active
                  ? "chord-gradient text-[#06351f] shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {ins.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stepper({
  label,
  display,
  onDec,
  onInc,
  onReset,
}: {
  label: string;
  display: string;
  onDec: () => void;
  onInc: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
        <Button variant="ghost" size="sm" isIconOnly aria-label={`${label} down`} onPress={onDec}>
          <span className="text-base leading-none">−</span>
        </Button>
        <button
          type="button"
          onClick={onReset}
          title="Reset"
          className="min-w-[3ch] px-1 text-center text-sm font-semibold tabular-nums text-foreground"
        >
          {display}
        </button>
        <Button variant="ghost" size="sm" isIconOnly aria-label={`${label} up`} onPress={onInc}>
          <span className="text-base leading-none">+</span>
        </Button>
      </div>
    </div>
  );
}
