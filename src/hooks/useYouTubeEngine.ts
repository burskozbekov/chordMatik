import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioEngine, LoopRegion } from "./useAudioEngine";

/** DOM id of the element the YouTube IFrame player replaces. */
export const YT_CONTAINER_ID = "cmk-youtube-player";

type TimeListener = (time: number) => void;

/* Minimal YT IFrame API surface we use (avoids an extra @types dep). */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setPlaybackRate(rate: number): void;
  getVideoData?(): { title?: string; author?: string; video_id?: string };
  destroy(): void;
}

let apiPromise: Promise<void> | null = null;
export function loadYouTubeApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    const w = window as unknown as { YT?: { Player: unknown }; onYouTubeIframeAPIReady?: () => void };
    if (w.YT && w.YT.Player) {
      resolve();
      return;
    }
    // If the script never loads (offline, blocked, CSP), fail instead of hanging
    // forever — and reset the cache so a later retry can re-attempt the load.
    let settled = false;
    const fail = (tag?: HTMLScriptElement) => {
      if (settled) return;
      settled = true;
      apiPromise = null;
      tag?.remove();
      reject(new Error("Could not load the YouTube player."));
    };
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      if (settled) return;
      settled = true;
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => fail(tag);
    document.head.appendChild(tag);
    window.setTimeout(() => fail(tag), 12_000);
  });
  return apiPromise;
}

/** Map a YouTube IFrame onError code to a user-facing message. */
function youTubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return "That YouTube link looks invalid.";
    case 5:
      return "This video can’t be played here.";
    case 100:
      return "Video not found — it may be private or removed.";
    case 101:
    case 150:
      return "The owner doesn’t allow this video to be embedded.";
    case 153:
      return "YouTube blocked this embed in the desktop app. Open it on YouTube instead.";
    default:
      return "This video couldn’t be played.";
  }
}

/**
 * A YouTube-backed playback engine with the same interface as the local audio
 * engine, so the timeline/diagram/transport sync to the embedded video. `offset`
 * (seconds) aligns the video to the locally-analyzed chord track: engine time =
 * videoTime − offset.
 *
 * The video is played via YouTube's official IFrame Player API (embedding only —
 * no audio is downloaded or extracted).
 */
export function useYouTubeEngine(videoId: string | null, offset: number): AudioEngine & {
  /** Player/network error message, or null. Drives the in-player error banner. */
  error: string | null;
  /** The embedded video's title once known (used for auto file-matching). */
  videoTitle: string | null;
} {
  const playerRef = useRef<YTPlayer | null>(null);
  const listenersRef = useRef<Set<TimeListener>>(new Set());
  const rafRef = useRef<number | null>(null);
  const loopRef = useRef<LoopRegion | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const [isPlaying, setIsPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setRateState] = useState(1);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState<string | null>(null);

  const emit = useCallback((t: number) => {
    listenersRef.current.forEach((cb) => cb(t));
  }, []);

  const getTime = useCallback(() => {
    const p = playerRef.current;
    const raw = p?.getCurrentTime ? p.getCurrentTime() : 0;
    return raw - offsetRef.current;
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
      const p = playerRef.current;
      if (!p) return;
      const t = getTime();
      const lp = loopRef.current;
      if (lp && t >= lp.end) {
        p.seekTo(lp.start + offsetRef.current, true);
      }
      emit(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [emit, getTime]);

  // Create / tear down the player when the video changes.
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    let attempts = 40;
    setError(null);
    setVideoTitle(null);

    // getVideoData() can be empty right at onReady — poll briefly for the title.
    const grabTitle = (p: YTPlayer, tries: number) => {
      if (cancelled) return;
      const title = p.getVideoData?.()?.title;
      if (title) setVideoTitle(title);
      else if (tries > 0) window.setTimeout(() => grabTitle(p, tries - 1), 400);
    };

    const create = () => {
      if (cancelled) return;
      const el = document.getElementById(YT_CONTAINER_ID);
      if (!el) {
        if (attempts-- > 0) window.setTimeout(create, 50);
        return;
      }
      loadYouTubeApi()
        .then(() => {
          if (cancelled) return;
          const YT = (
            window as unknown as { YT: { Player: new (id: string, cfg: unknown) => YTPlayer } }
          ).YT;
          playerRef.current = new YT.Player(YT_CONTAINER_ID, {
            videoId,
            playerVars: {
              autoplay: 0,
              controls: 1,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              // Identify the host so YouTube accepts the embed (else error 153).
              origin: window.location.origin,
              widget_referrer: window.location.origin,
            },
            events: {
              onReady: (e: { target: YTPlayer }) => {
                if (cancelled) return;
                setReady(true);
                // True video length; the sync offset only shifts playback time,
                // never the duration (see getTime/seek).
                setDuration(Math.max(0, e.target.getDuration()));
                grabTitle(e.target, 8);
                emit(getTime());
              },
              onStateChange: (e: { data: number; target: YTPlayer }) => {
                // 1 playing, 2 paused, 0 ended, 3 buffering
                if (e.data === 1) {
                  setIsPlaying(true);
                  startLoop();
                } else {
                  setIsPlaying(false);
                  if (e.data !== 3) stopLoop();
                  emit(getTime());
                }
              },
              onError: (e: { data: number }) => {
                if (cancelled) return;
                setError(youTubeErrorMessage(e.data));
                setIsPlaying(false);
                stopLoop();
              },
            },
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Could not load the YouTube player.");
        });
    };
    create();

    return () => {
      cancelled = true;
      stopLoop();
      try {
        // Pause first so no IFrame callbacks fire mid-teardown.
        playerRef.current?.pauseVideo();
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      setReady(false);
      setIsPlaying(false);
      setDuration(0);
    };
  }, [videoId, emit, getTime, startLoop, stopLoop]);

  const play = useCallback(() => playerRef.current?.playVideo(), []);
  const pause = useCallback(() => playerRef.current?.pauseVideo(), []);
  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const seek = useCallback(
    (t: number) => {
      const p = playerRef.current;
      if (!p) return;
      p.seekTo(Math.max(0, t) + offsetRef.current, true);
      emit(t);
    },
    [emit],
  );
  const seekBy = useCallback((delta: number) => seek(getTime() + delta), [seek, getTime]);

  const setPlaybackRate = useCallback((rate: number) => {
    setRateState(rate);
    playerRef.current?.setPlaybackRate(rate);
  }, []);

  const setLoop = useCallback((next: LoopRegion | null) => {
    loopRef.current = next && next.end > next.start ? next : null;
    setLoopState(loopRef.current);
  }, []);

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
    isReady: ready,
    error,
    videoTitle,
    duration,
    playbackRate,
    loop,
    setLoop,
    load: () => {},
    unload: () => pause(),
    play,
    pause,
    toggle,
    seek,
    seekBy,
    setPlaybackRate,
    getTime,
    subscribe,
    audioEl: null,
  };
}
