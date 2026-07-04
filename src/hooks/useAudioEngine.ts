import { useCallback, useEffect, useRef, useState } from "react";

type TimeListener = (time: number) => void;

export interface LoopRegion {
  start: number;
  end: number;
}

export interface AudioEngine {
  isPlaying: boolean;
  isReady: boolean;
  duration: number;
  playbackRate: number;
  loop: LoopRegion | null;
  setLoop: (loop: LoopRegion | null) => void;
  /** Point the engine at a new source URL. */
  load: (src: string) => void;
  /** Release the current source so the temp file is no longer held open. */
  unload: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Seek to an absolute time (seconds), clamped to the track. */
  seek: (time: number) => void;
  seekBy: (delta: number) => void;
  setPlaybackRate: (rate: number) => void;
  /** Cheap synchronous read of the current time. */
  getTime: () => number;
  /**
   * Subscribe to time updates. While playing, fires every animation frame
   * (≈60 Hz) so consumers can drive smooth visuals without React re-renders.
   * Also fires immediately and on seek/pause. Returns an unsubscribe fn.
   */
  subscribe: (cb: TimeListener) => () => void;
  /** The underlying media element (a <video>, displayable when the song has video). */
  audioEl: HTMLMediaElement | null;
}

/**
 * Owns a single HTMLAudioElement. Playback + currentTime live here; React
 * state is only used for coarse flags (playing/ready/duration/rate) so the
 * high-frequency time signal never thrashes the component tree.
 */
export function useAudioEngine(): AudioEngine {
  const elRef = useRef<HTMLMediaElement | null>(null);
  if (elRef.current === null && typeof document !== "undefined") {
    // A <video> element (not <audio>) so YouTube-sourced songs can show their
    // picture; for local audio files it just plays the sound (never displayed).
    const el = document.createElement("video");
    el.preload = "auto";
    el.playsInline = true;
    elRef.current = el;
  }

  const listenersRef = useRef<Set<TimeListener>>(new Set());
  const rafRef = useRef<number | null>(null);
  const loopRef = useRef<LoopRegion | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setRate] = useState(1);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);

  const setLoop = useCallback((next: LoopRegion | null) => {
    loopRef.current = next && next.end > next.start ? next : null;
    setLoopState(loopRef.current);
  }, []);

  const emit = useCallback((t: number) => {
    listenersRef.current.forEach((cb) => cb(t));
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current != null) return;
    const tick = () => {
      const el = elRef.current;
      if (!el) return;
      const lp = loopRef.current;
      if (lp && el.currentTime >= lp.end) {
        el.currentTime = lp.start;
      }
      emit(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [emit]);

  // Wire element events once.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onPlay = () => {
      setIsPlaying(true);
      startLoop();
    };
    const onPause = () => {
      setIsPlaying(false);
      stopLoop();
      emit(el.currentTime);
    };
    const onEnded = () => {
      setIsPlaying(false);
      stopLoop();
      emit(el.currentTime);
    };
    const onLoaded = () => {
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setIsReady(true);
      emit(el.currentTime);
    };
    const onSeeked = () => emit(el.currentTime);
    const onTimeUpdate = () => emit(el.currentTime);

    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("durationchange", onLoaded);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("durationchange", onLoaded);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("timeupdate", onTimeUpdate);
      stopLoop();
    };
  }, [emit, startLoop, stopLoop]);

  // Tear down the element on unmount.
  useEffect(() => {
    return () => {
      const el = elRef.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      stopLoop();
    };
  }, [stopLoop]);

  const load = useCallback(
    (src: string) => {
      const el = elRef.current;
      if (!el) return;
      setIsReady(false);
      setDuration(0);
      setIsPlaying(false);
      el.src = src;
      el.playbackRate = playbackRate;
      el.currentTime = 0;
      loopRef.current = null;
      setLoopState(null);
      el.load();
      emit(0);
    },
    [emit, playbackRate],
  );

  const unload = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load(); // drop the decoded buffers + file handle for the old source
    stopLoop();
    setIsReady(false);
    setDuration(0);
    setIsPlaying(false);
    emit(0);
  }, [emit, stopLoop]);

  const play = useCallback(() => {
    elRef.current?.play().catch(() => {
      /* autoplay rejection / not ready — ignored */
    });
  }, []);

  const pause = useCallback(() => elRef.current?.pause(), []);

  const toggle = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (el.paused) play();
    else pause();
  }, [play, pause]);

  const seek = useCallback(
    (time: number) => {
      const el = elRef.current;
      if (!el) return;
      const dur = Number.isFinite(el.duration) ? el.duration : time;
      el.currentTime = Math.max(0, Math.min(time, dur || time));
      emit(el.currentTime);
    },
    [emit],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const el = elRef.current;
      if (!el) return;
      seek((el.currentTime || 0) + delta);
    },
    [seek],
  );

  const setPlaybackRate = useCallback((rate: number) => {
    setRate(rate);
    if (elRef.current) elRef.current.playbackRate = rate;
  }, []);

  const getTime = useCallback(() => elRef.current?.currentTime ?? 0, []);

  const subscribe = useCallback(
    (cb: TimeListener) => {
      listenersRef.current.add(cb);
      cb(getTime());
      return () => {
        listenersRef.current.delete(cb);
      };
    },
    [getTime],
  );

  return {
    isPlaying,
    isReady,
    duration,
    playbackRate,
    loop,
    setLoop,
    load,
    unload,
    play,
    pause,
    toggle,
    seek,
    seekBy,
    setPlaybackRate,
    getTime,
    subscribe,
    audioEl: elRef.current,
  };
}
