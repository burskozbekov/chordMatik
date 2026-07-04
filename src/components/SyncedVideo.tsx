import { useEffect, useRef, useState } from "react";
import { loadYouTubeApi } from "../hooks/useYouTubeEngine";
import type { AudioEngine } from "../hooks/useAudioEngine";

const CONTAINER_ID = "cmk-synced-video";

interface SyncedYTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  mute(): void;
  destroy(): void;
}

/**
 * Watch-only video pinned to the audio player: the official YouTube embed,
 * muted, that follows the local audio's time (seek on drift, play/pause to
 * match). The downloaded audio drives playback + chords; this is just the
 * picture. Muted → no double audio.
 */
export function SyncedVideo({ videoId, engine }: { videoId: string; engine: AudioEngine }) {
  const playerRef = useRef<SyncedYTPlayer | null>(null);
  const readyRef = useRef(false);
  const [failed, setFailed] = useState(false);

  // Create / tear down the muted player when the video changes.
  useEffect(() => {
    let cancelled = false;
    let attempts = 40;
    readyRef.current = false;
    setFailed(false);

    const create = () => {
      if (cancelled) return;
      const el = document.getElementById(CONTAINER_ID);
      if (!el) {
        if (attempts-- > 0) window.setTimeout(create, 50);
        return;
      }
      void loadYouTubeApi().then(() => {
        if (cancelled) return;
        const YT = (window as unknown as { YT: { Player: new (id: string, cfg: unknown) => SyncedYTPlayer } }).YT;
        playerRef.current = new YT.Player(CONTAINER_ID, {
          videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            mute: 1,
            origin: window.location.origin,
            widget_referrer: window.location.origin,
          },
          events: {
            onReady: (e: { target: SyncedYTPlayer }) => {
              if (cancelled) return;
              e.target.mute();
              readyRef.current = true;
              // Align to the current audio position immediately.
              e.target.seekTo(Math.max(0, engine.getTime()), true);
              if (engine.isPlaying) e.target.playVideo();
            },
            // If YouTube refuses the embed, just hide it — audio + chords work.
            onError: () => {
              if (!cancelled) setFailed(true);
            },
          },
        });
      });
    };
    create();

    return () => {
      cancelled = true;
      readyRef.current = false;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Follow the audio engine's time — correct drift on each tick / on seek.
  useEffect(() => {
    return engine.subscribe((t) => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      if (Math.abs(p.getCurrentTime() - t) > 0.5) p.seekTo(Math.max(0, t), true);
    });
  }, [engine]);

  // Match play/pause.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (engine.isPlaying) p.playVideo();
    else p.pauseVideo();
  }, [engine.isPlaying]);

  if (failed) return null;

  return (
    <div className="mx-auto w-full max-w-[280px]">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black/90">
        <div id={CONTAINER_ID} aria-label="YouTube video" role="application" />
      </div>
    </div>
  );
}
