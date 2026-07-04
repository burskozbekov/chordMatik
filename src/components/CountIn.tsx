import { useEffect, useState } from "react";
import { getAudioContext } from "../lib/audioContext";

/**
 * A one-bar count-in at the top of the screen, ticking at the song's BPM and
 * beats-per-bar (Web Audio clicks + a big counter that counts up 1→N), then
 * calls onDone (→ start playback) one beat after the last click so the song's
 * downbeat lands where beat 1 of the next bar would — i.e. it leads INTO the
 * song's grid, accenting the downbeat just like the synced metronome.
 */
export function CountIn({
  bpm,
  beatsPerBar = 4,
  songBeats,
  startSec = 0,
  onDone,
}: {
  bpm: number;
  beatsPerBar?: number;
  /** The recording's tracked beats — the count-in matches the local groove near bar 1. */
  songBeats?: number[];
  startSec?: number;
  onDone: () => void;
}) {
  const beats = Math.max(1, Math.round(beatsPerBar));
  const [shown, setShown] = useState(1);

  useEffect(() => {
    const ctx = getAudioContext();
    // Prefer the real local beat spacing at bar 1 over the (possibly-off) global
    // BPM, so the count-in feels exactly like the song you're about to play.
    let spb = 60 / Math.max(30, bpm);
    if (songBeats && songBeats.length > 4) {
      let i0 = 0;
      let bd = Infinity;
      for (let i = 0; i < songBeats.length; i++) {
        const d = Math.abs(songBeats[i] - startSec);
        if (d < bd) {
          bd = d;
          i0 = i;
        }
      }
      const iv: number[] = [];
      for (let i = Math.max(1, i0 - 3); i <= Math.min(songBeats.length - 1, i0 + 3); i++) {
        const d = songBeats[i] - songBeats[i - 1];
        if (d > 0.2 && d < 2) iv.push(d);
      }
      if (iv.length) {
        iv.sort((a, b) => a - b);
        spb = iv[iv.length >> 1];
      }
    }
    const t0 = ctx.currentTime + 0.12;
    const timers: number[] = [];

    for (let i = 0; i < beats; i++) {
      const at = t0 + i * spb;
      const accent = i % beats === 0; // downbeat (the "1")
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = accent ? 1500 : 1000;
      gain.gain.setValueAtTime(accent ? 0.5 : 0.35, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.06);
      const n = i + 1;
      timers.push(
        window.setTimeout(() => setShown(n), Math.max(0, (at - ctx.currentTime) * 1000)),
      );
    }
    // Hand off one beat after the final click → the song begins on the next "1".
    const totalMs = (t0 - ctx.currentTime + beats * spb) * 1000;
    const done = window.setTimeout(onDone, totalMs);

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center pt-24">
      <div
        className={`grid size-32 place-items-center rounded-3xl text-7xl font-bold shadow-overlay transition-colors ${
          shown === 1
            ? "bg-[var(--accent)] text-accent-foreground"
            : "bg-surface text-foreground"
        }`}
      >
        {shown}
      </div>
    </div>
  );
}
