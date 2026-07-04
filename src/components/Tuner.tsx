import { useEffect, useState } from "react";
import { PitchDetector } from "pitchy";
import { getAudioContext } from "../lib/audioContext";
import { CloseIcon } from "./icons";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Alternate tunings — string MIDI notes, low → high. */
const TUNINGS: Record<string, number[]> = {
  Standard: [40, 45, 50, 55, 59, 64], // E A D G B E
  "Drop D": [38, 45, 50, 55, 59, 64],
  "Half-step ↓": [39, 44, 49, 54, 58, 63], // Eb Ab Db Gb Bb Eb
  "Drop C#": [37, 44, 49, 54, 58, 63],
  "Drop C": [36, 43, 48, 53, 57, 62],
  DADGAD: [38, 45, 50, 55, 57, 62],
  "Open G": [38, 43, 50, 55, 59, 62],
  "Open D": [38, 45, 50, 54, 57, 62],
  Bass: [28, 33, 38, 43], // E A D G
  "Bass Drop D": [26, 33, 38, 43],
  Chromatic: [],
};

const noteLabel = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** Chromatic + alternate-tuning tuner (pitchy / McLeod), with mic + A4 calibration. */
export function Tuner({ onClose }: { onClose: () => void }) {
  const [tuning, setTuning] = useState("Standard");
  const [refA, setRefA] = useState(440); // calibration reference (A4 Hz)
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [freq, setFreq] = useState(0); // raw detected Hz
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let srcNode: MediaStreamAudioSourceNode | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) return;
        // Device labels are available once permission is granted.
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput",
        );
        if (!cancelled) setDevices(devs);

        ctx = getAudioContext();
        const src = ctx.createMediaStreamSource(stream);
        srcNode = src;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 4096; // longer window → stable low notes (bass)
        src.connect(analyser);
        const detector = PitchDetector.forFloat32Array(analyser.fftSize);
        detector.minVolumeDecibels = -35;
        const buf = new Float32Array(analyser.fftSize);

        const tick = () => {
          if (cancelled || !ctx) return;
          analyser.getFloatTimeDomainData(buf);
          const [pitch, clarity] = detector.findPitch(buf, ctx.sampleRate);
          if (clarity > 0.92 && pitch > 25 && pitch < 1500) {
            setFreq(Math.round(pitch * 10) / 10);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        if (!cancelled) setError(`Microphone unavailable: ${String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      try {
        srcNode?.disconnect();
      } catch {
        /* */
      }
      stream?.getTracks().forEach((t) => t.stop());
      // Shared context — do NOT close it (closing silences the song's media element).
    };
  }, [deviceId]);

  // Note math is relative to the calibration reference, so 432/440 just shifts it.
  const midiFloat = freq > 0 ? 69 + 12 * Math.log2(freq / refA) : null;
  const strings = TUNINGS[tuning];
  let target: number | null = null;
  if (midiFloat != null) {
    target =
      strings.length > 0
        ? strings.reduce((best, s) => (Math.abs(s - midiFloat) < Math.abs(best - midiFloat) ? s : best))
        : Math.round(midiFloat);
  }
  const cents = midiFloat != null && target != null ? Math.round((midiFloat - target) * 100) : 0;
  const inTune = midiFloat != null && Math.abs(cents) <= 5;
  const needle = Math.max(0, Math.min(100, 50 + cents));

  return (
    <section className="glass flex flex-col gap-3 rounded-2xl px-4 py-4 shadow-overlay">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Tuner</h3>
          <select
            value={tuning}
            onChange={(e) => setTuning(e.target.value)}
            className="rounded-lg border border-border/70 bg-surface/60 px-2 py-1 text-xs font-semibold text-foreground"
          >
            {Object.keys(TUNINGS).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          aria-label="Close tuner"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      {/* Mic + A4 calibration. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
        {devices.length > 1 && (
          <select
            value={deviceId ?? ""}
            onChange={(e) => setDeviceId(e.target.value || null)}
            className="max-w-[12rem] truncate rounded-lg border border-border/70 bg-surface/60 px-2 py-1 font-semibold text-foreground"
            title="Microphone"
          >
            <option value="">Default mic</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Microphone"}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1">
          <span>A4</span>
          <button
            type="button"
            onClick={() => setRefA((a) => Math.max(420, a - 1))}
            className="rounded-md border border-border/70 bg-surface/60 px-1.5 py-0.5 font-semibold text-foreground hover:bg-surface"
          >
            −
          </button>
          <span className="min-w-[3rem] text-center font-mono text-foreground">{refA} Hz</span>
          <button
            type="button"
            onClick={() => setRefA((a) => Math.min(460, a + 1))}
            className="rounded-md border border-border/70 bg-surface/60 px-1.5 py-0.5 font-semibold text-foreground hover:bg-surface"
          >
            +
          </button>
          {[432, 440].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setRefA(p)}
              className={`rounded-md px-1.5 py-0.5 font-semibold ${
                refA === p ? "bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="py-4 text-center text-xs text-muted">{error}</p>
      ) : (
        <div className="flex flex-col items-center gap-3 py-1">
          <div
            className={`text-5xl font-bold tabular-nums transition-colors ${
              inTune ? "text-[var(--accent)]" : "text-foreground"
            }`}
          >
            {target != null ? noteLabel(target) : "—"}
          </div>
          <div className="text-xs font-mono text-muted">
            {freq > 0 ? `${freq} Hz` : "play a string"}
            {midiFloat != null ? ` · ${cents > 0 ? "+" : ""}${cents}¢` : ""}
          </div>

          <div className="relative h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface">
            <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border" />
            <div
              className={`absolute top-0 h-full w-1.5 -translate-x-1/2 rounded-full transition-all ${
                inTune ? "bg-[var(--accent)]" : "bg-foreground/70"
              }`}
              style={{ left: `${needle}%` }}
            />
          </div>
          <div className="flex w-full max-w-xs justify-between text-[10px] text-muted">
            <span>♭</span>
            <span className={inTune ? "font-semibold text-[var(--accent)]" : ""}>in tune</span>
            <span>♯</span>
          </div>

          {strings.length > 0 && (
            <div className="mt-1 flex gap-1">
              {strings.map((s, i) => {
                const isTarget = target === s;
                return (
                  <span
                    key={i}
                    className={`grid size-8 place-items-center rounded-lg border text-xs font-semibold transition-colors ${
                      isTarget && inTune
                        ? "border-transparent bg-[var(--accent)] text-accent-foreground"
                        : isTarget
                          ? "border-[var(--accent)] text-foreground"
                          : "border-border/60 text-muted"
                    }`}
                  >
                    {NOTE_NAMES[((s % 12) + 12) % 12]}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
