import { brand } from "../../theme/tokens";
import type { FretVoicing } from "../../lib/voicings";

interface FretDiagramProps {
  voicing: FretVoicing;
  /** Pitch class of the chord root, to mark root notes. */
  rootPc: number;
  fretsShown?: number;
}

/** A fretboard chord diagram (guitar 6-string or ukulele 4-string). */
export function FretDiagram({ voicing, rootPc, fretsShown = 4 }: FretDiagramProps) {
  const { frets, tuning } = voicing;
  const nStrings = frets.length;
  const played = frets.filter((f) => f > 0);
  const maxPlayed = played.length ? Math.max(...played) : 0;
  const minPlayed = played.length ? Math.min(...played) : 1;
  const showNut = maxPlayed <= fretsShown;
  const baseFret = showNut ? 1 : minPlayed;

  // Geometry (SVG units).
  const sx = 22; // string spacing
  const fy = 30; // fret spacing
  const padX = 20;
  const top = 26;
  const gridW = (nStrings - 1) * sx;
  const gridH = fretsShown * fy;
  const w = gridW + padX * 2;
  const h = top + gridH + 18;

  const stringX = (s: number) => padX + s * sx;
  const fretY = (row: number) => top + row * fy;

  // Barre: ≥3 strings sharing the lowest played fret.
  const barreFret = minPlayed;
  const barreStrings = frets
    .map((f, s) => (f === barreFret ? s : -1))
    .filter((s) => s >= 0);
  const hasBarre = played.length > 0 && barreStrings.length >= 3;

  const lineColor = "currentColor";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-full w-full text-foreground/35"
      role="img"
      aria-label="chord diagram"
    >
      {/* Nut or base-fret label */}
      {showNut ? (
        <rect x={padX} y={top - 4} width={gridW} height={4} rx={1.5} fill={lineColor} />
      ) : (
        <text
          x={padX - 6}
          y={top + fy * 0.7}
          textAnchor="end"
          className="fill-muted"
          fontSize="11"
          fontWeight="600"
        >
          {baseFret}fr
        </text>
      )}

      {/* Frets */}
      {Array.from({ length: fretsShown + 1 }).map((_, i) => (
        <line
          key={`f${i}`}
          x1={padX}
          y1={fretY(i)}
          x2={padX + gridW}
          y2={fretY(i)}
          stroke={lineColor}
          strokeWidth={1}
          opacity={0.6}
        />
      ))}

      {/* Strings */}
      {frets.map((_, s) => (
        <line
          key={`s${s}`}
          x1={stringX(s)}
          y1={top}
          x2={stringX(s)}
          y2={top + gridH}
          stroke={lineColor}
          strokeWidth={1}
          opacity={0.6}
        />
      ))}

      {/* Barre */}
      {hasBarre && (
        <rect
          x={stringX(barreStrings[0]) - 7}
          y={fretY(barreFret - baseFret) + fy / 2 - 7}
          width={stringX(barreStrings[barreStrings.length - 1]) - stringX(barreStrings[0]) + 14}
          height={14}
          rx={7}
          fill={brand.skyStrong}
          opacity={0.92}
        />
      )}

      {/* Open / muted markers + finger dots */}
      {frets.map((f, s) => {
        const x = stringX(s);
        if (f < 0) {
          return (
            <text
              key={`m${s}`}
              x={x}
              y={top - 9}
              textAnchor="middle"
              className="fill-muted"
              fontSize="12"
              fontWeight="700"
            >
              ×
            </text>
          );
        }
        if (f === 0) {
          return (
            <circle
              key={`o${s}`}
              cx={x}
              cy={top - 13}
              r={4.5}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-muted"
            />
          );
        }
        const isRoot = (tuning[s] + f) % 12 === ((rootPc % 12) + 12) % 12;
        const cy = fretY(f - baseFret) + fy / 2;
        return (
          <circle
            key={`d${s}`}
            cx={x}
            cy={cy}
            r={7}
            fill={isRoot ? brand.mint : brand.skyStrong}
            stroke={isRoot ? brand.skyStrong : "none"}
            strokeWidth={isRoot ? 2 : 0}
          />
        );
      })}
    </svg>
  );
}
