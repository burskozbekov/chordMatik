import { useEffect, useRef, useState } from "react";
import { useAppState } from "../state/AppState";
import { getAudioContext } from "../lib/audioContext";
import { CloseIcon } from "./icons";

/**
 * Practice metronome (Web Audio lookahead scheduler). Two modes:
 *  - SYNC TO SONG: clicks lock to the loaded song's beat grid (songStartSec +
 *    n·60/songBpm), re-read against the song's clock every tick so they never
 *    drift, follow play/pause + speed, and accent the downbeat. So it doesn't
 *    click the instant you hit Start — it lands on the song's beats.
 *  - FREE: a standalone click at a user/tap BPM (no song, or sync off).
 */
export function Metronome({ onClose }: { onClose: () => void }) {
  const { engine, songBpm, songStartSec, songBeatsPerBar, songBeats } = useAppState();
  const [bpm, setBpm] = useState(songBpm > 0 ? Math.round(songBpm) : 120);
  const [beatsPerBar, setBeatsPerBar] = useState(songBeatsPerBar > 0 ? songBeatsPerBar : 4);
  const [sync, setSync] = useState(songBpm > 0);
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(0);

  const nextNoteRef = useRef(0);
  const beatRef = useRef(0);
  const nextSyncBeatRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const bpbRef = useRef(beatsPerBar);
  bpbRef.current = beatsPerBar;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const songRef = useRef({ bpm: songBpm, start: songStartSec, beats: songBeats });
  songRef.current = { bpm: songBpm, start: songStartSec, beats: songBeats };
  const tapsRef = useRef<number[]>([]);
  // Index of the next real beat to click (into songBeats), for the sync scheduler.
  const nextBeatIdxRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      // Shared context — don't close it (closing silences the song's media element).
    };
  }, []);

  // Show the song's REAL tempo: the median of the tracked beats (which ride the
  // recording, fixing a notated value that's a few BPM off), else the tab's BPM.
  useEffect(() => {
    if (songBeats && songBeats.length > 4) {
      const ibis: number[] = [];
      for (let i = 1; i < songBeats.length; i++) ibis.push(songBeats[i] - songBeats[i - 1]);
      ibis.sort((a, b) => a - b);
      const med = ibis[ibis.length >> 1];
      if (med > 0) setBpm(Math.round(60 / med));
    } else if (songBpm > 0) {
      setBpm(Math.round(songBpm));
    }
  }, [songBeats, songBpm]);

  const click = (ctx: AudioContext, time: number, accent: boolean) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  };

  const start = () => {
    const ctx = getAudioContext();
    beatRef.current = 0;
    nextNoteRef.current = ctx.currentTime + 0.1;
    nextSyncBeatRef.current = 0;
    nextBeatIdxRef.current = 0;
    setPlaying(true);
    timerRef.current = window.setInterval(() => {
      const c = getAudioContext();
      const bpb = bpbRef.current;

      // SYNC: ride the song's REAL beats while it plays (so the clicks stay locked
      // even as the recording's tempo drifts); fall back to a fixed grid if none.
      const sg = songRef.current;
      if (syncRef.current && sg.bpm > 0) {
        const eng = engineRef.current;
        if (!eng.isPlaying) return; // clicks pause with the song
        const rate = eng.playbackRate || 1;
        const songT = eng.getTime();
        const beats = sg.beats;

        if (beats && beats.length > 4) {
          // Downbeat phase: the tracked beat nearest the user's bar-1 anchor.
          let i0 = 0;
          let bestD = Infinity;
          for (let i = 0; i < beats.length; i++) {
            const d = Math.abs(beats[i] - sg.start);
            if (d < bestD) {
              bestD = d;
              i0 = i;
            }
          }
          // (re)align the next-beat pointer to the playhead (handles seeks/start).
          let idx = nextBeatIdxRef.current;
          if (idx >= beats.length || beats[idx] < songT - 0.25 || beats[idx] > songT + 2) {
            idx = beats.findIndex((t) => t >= songT - 0.02);
            if (idx < 0) idx = beats.length;
            nextBeatIdxRef.current = idx;
          }
          while (idx < beats.length && beats[idx] < songT + 0.12 * rate) {
            const beatSongT = beats[idx];
            const audioT = c.currentTime + (beatSongT - songT) / rate;
            const inBar = (((idx - i0) % bpb) + bpb) % bpb;
            if (audioT >= c.currentTime - 0.01) {
              const at = Math.max(c.currentTime, audioT);
              click(c, at, inBar === 0);
              window.setTimeout(() => setBeat(inBar), Math.max(0, (at - c.currentTime) * 1000));
            }
            idx++;
            nextBeatIdxRef.current = idx;
          }
          return;
        }

        // Fallback: fixed-BPM grid (no tracked beats available).
        const spb = 60 / sg.bpm;
        const anchor = sg.start;
        const curIdx = Math.floor((songT - anchor) / spb + 1e-6);
        if (nextSyncBeatRef.current <= curIdx || nextSyncBeatRef.current > curIdx + 8) {
          nextSyncBeatRef.current = curIdx + 1;
        }
        while (anchor + nextSyncBeatRef.current * spb < songT + 0.12 * rate) {
          const idx = nextSyncBeatRef.current;
          const beatSongT = anchor + idx * spb;
          const audioT = c.currentTime + (beatSongT - songT) / rate;
          const inBar = ((idx % bpb) + bpb) % bpb;
          if (audioT >= c.currentTime - 0.01) {
            const at = Math.max(c.currentTime, audioT);
            click(c, at, inBar === 0);
            window.setTimeout(() => setBeat(inBar), Math.max(0, (at - c.currentTime) * 1000));
          }
          nextSyncBeatRef.current = idx + 1;
        }
        return;
      }

      // FREE: a steady click at the set BPM.
      const spb = 60 / bpmRef.current;
      while (nextNoteRef.current < c.currentTime + 0.1) {
        const b = beatRef.current % bpb;
        click(c, nextNoteRef.current, b === 0);
        const at = nextNoteRef.current;
        window.setTimeout(() => setBeat(b), Math.max(0, (at - c.currentTime) * 1000));
        nextNoteRef.current += spb;
        beatRef.current += 1;
      }
    }, 25);
  };

  const stop = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setBeat(0);
  };

  const toggle = () => (playing ? stop() : start());

  const tap = () => {
    const now = performance.now();
    const taps = tapsRef.current.filter((t) => now - t < 2000);
    taps.push(now);
    tapsRef.current = taps;
    if (taps.length >= 2) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const next = Math.round(60000 / avg);
      if (next >= 30 && next <= 300) setBpm(next);
    }
  };

  const shownBpm = sync && songBpm > 0 ? Math.round(songBpm) : bpm;

  return (
    <section className="glass flex flex-col gap-4 rounded-2xl px-4 py-4 shadow-overlay">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Metronome</h3>
        <button
          type="button"
          aria-label="Close metronome"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      {songBpm > 0 && (
        <label className="flex items-center justify-center gap-1.5 text-xs font-semibold text-muted">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
          Lock to the song&apos;s beats {sync && <span className="text-[var(--accent)]">· synced</span>}
        </label>
      )}

      <div className="flex items-center justify-center gap-1.5">
        {Array.from({ length: beatsPerBar }, (_, i) => (
          <span
            key={i}
            className={`size-3 rounded-full transition-colors ${
              playing && beat === i ? (i === 0 ? "bg-[var(--accent)]" : "bg-foreground") : "bg-surface"
            }`}
          />
        ))}
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => setBpm((b) => Math.max(30, b - 1))}
          disabled={sync && songBpm > 0}
          className="rounded-lg border border-border/70 bg-surface/60 px-2 py-1 text-sm font-semibold hover:bg-surface disabled:opacity-40"
        >
          −
        </button>
        <div className="min-w-[5rem] text-center">
          <span className="text-3xl font-bold tabular-nums text-foreground">{shownBpm}</span>
          <span className="ml-1 text-xs text-muted">BPM</span>
        </div>
        <button
          type="button"
          onClick={() => setBpm((b) => Math.min(300, b + 1))}
          disabled={sync && songBpm > 0}
          className="rounded-lg border border-border/70 bg-surface/60 px-2 py-1 text-sm font-semibold hover:bg-surface disabled:opacity-40"
        >
          +
        </button>
      </div>

      <div className="flex items-center justify-center gap-2 text-xs">
        <button type="button" onClick={toggle} className="cta-gradient rounded-xl px-4 py-1.5 font-semibold">
          {playing ? "Stop" : "Start"}
        </button>
        {!(sync && songBpm > 0) && (
          <button type="button" onClick={tap} className="rounded-xl border border-border/70 bg-surface/60 px-3 py-1.5 font-semibold hover:bg-surface">
            Tap
          </button>
        )}
        <div className="flex items-center gap-1 text-muted">
          <span>Beats</span>
          <select
            value={beatsPerBar}
            onChange={(e) => setBeatsPerBar(Number(e.target.value))}
            className="rounded-lg border border-border/70 bg-surface/60 px-1.5 py-1 font-semibold text-foreground"
          >
            {[2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
