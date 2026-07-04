import type { ReactNode } from "react";
import { brand } from "../../theme/tokens";
import type { PianoChord } from "../../lib/voicings";

interface PianoDiagramProps {
  chord: PianoChord;
  /** Number of octaves to render. */
  octaves?: number;
}

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
// Black key after these white indices (0-based within an octave's whites).
const BLACK_AFTER: Record<number, number> = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };

/** A piano keyboard highlighting a chord's notes (root distinct). */
export function PianoDiagram({ chord, octaves = 2 }: PianoDiagramProps) {
  const noteSet = new Set(chord.notes.map((n) => ((n % 12) + 12) % 12));
  const rootPc = ((chord.rootPc % 12) + 12) % 12;

  const whiteW = 16;
  const whiteH = 70;
  const blackW = 10;
  const blackH = 44;
  const whitesPerOct = 7;
  const totalWhites = whitesPerOct * octaves;
  const w = totalWhites * whiteW;
  const h = whiteH;

  const fillFor = (pc: number, isWhite: boolean) => {
    if (pc === rootPc) return brand.mint;
    if (noteSet.has(pc)) return brand.skyStrong;
    return isWhite ? "transparent" : "currentColor";
  };

  const whites: ReactNode[] = [];
  const blacks: ReactNode[] = [];

  for (let oct = 0; oct < octaves; oct++) {
    for (let i = 0; i < whitesPerOct; i++) {
      const idx = oct * whitesPerOct + i;
      const x = idx * whiteW;
      const pc = WHITE_PCS[i];
      const active = noteSet.has(pc);
      whites.push(
        <rect
          key={`w${idx}`}
          x={x}
          y={0}
          width={whiteW}
          height={whiteH}
          rx={2}
          fill={active ? fillFor(pc, true) : "var(--surface)"}
          stroke="currentColor"
          strokeOpacity={0.45}
          strokeWidth={1}
        />,
      );
      // Black key to the right of this white, if any.
      if (i in BLACK_AFTER) {
        const bpc = BLACK_AFTER[i];
        const bx = x + whiteW - blackW / 2;
        blacks.push(
          <rect
            key={`b${idx}`}
            x={bx}
            y={0}
            width={blackW}
            height={blackH}
            rx={2}
            fill={noteSet.has(bpc) ? fillFor(bpc, false) : "var(--foreground)"}
            fillOpacity={noteSet.has(bpc) ? 1 : 0.82}
          />,
        );
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-full w-full text-muted"
      role="img"
      aria-label="piano chord diagram"
    >
      {whites}
      {blacks}
    </svg>
  );
}
