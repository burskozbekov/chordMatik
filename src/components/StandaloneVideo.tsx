import { useEffect } from "react";
import { Button } from "@heroui/react";
import { useAppState } from "../state/AppState";
import { VideoPanel } from "./VideoPanel";
import { CloseIcon, FolderOpenIcon, YouTubeIcon } from "./icons";

/**
 * The YouTube-only view: shown when a link has been pasted but no local song is
 * loaded. Plays the video in-app (official IFrame embed). To get a synced chord
 * timeline, open the matching local audio file you own.
 */
export function StandaloneVideo() {
  const { openAudioForVideo, clearYouTube } = useAppState();

  // Escape removes the video and returns to the empty screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearYouTube();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearYouTube]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
            <YouTubeIcon className="size-5 text-danger/80" />
            YouTube video
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Playing in-app. Open the matching local audio file to add a synced chord timeline.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onPress={openAudioForVideo} className="gap-1.5">
            <FolderOpenIcon className="size-4" />
            <span className="hidden sm:inline">Open audio for chords</span>
          </Button>
          <Button variant="ghost" size="sm" isIconOnly aria-label="Remove video" onPress={clearYouTube}>
            <CloseIcon className="size-4" />
          </Button>
        </div>
      </div>

      <VideoPanel />
    </div>
  );
}
