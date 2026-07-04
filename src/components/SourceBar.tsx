import { type ReactNode } from "react";
import { Button } from "@heroui/react";
import { useAppState } from "../state/AppState";
import { YouTubeUrlInput } from "./YouTubeUrlInput";
import { CloseIcon, YouTubeIcon } from "./icons";

/**
 * Source switcher: paste a YouTube link to watch the video in-app, then toggle
 * between local audio and the synced YouTube player. The chord analysis always
 * comes from the local file — nothing is downloaded from YouTube.
 */
export function SourceBar() {
  const { youtubeId, playbackMode, setPlaybackMode, setYouTubeUrl, clearYouTube } = useAppState();

  if (!youtubeId) {
    return (
      <YouTubeUrlInput
        onSubmit={setYouTubeUrl}
        placeholder="Paste a YouTube link to watch the video in-app"
        submitLabel="Add video"
      />
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
        <SourceTab active={playbackMode === "audio"} onClick={() => setPlaybackMode("audio")}>
          Local audio
        </SourceTab>
        <SourceTab active={playbackMode === "youtube"} onClick={() => setPlaybackMode("youtube")}>
          <span className="flex items-center gap-1.5">
            <YouTubeIcon className="size-3.5" /> YouTube
          </span>
        </SourceTab>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onPress={clearYouTube}
        className="gap-1 text-muted"
        aria-label="Remove video"
      >
        <CloseIcon className="size-3.5" />
        <span className="hidden sm:inline">Remove video</span>
      </Button>
    </div>
  );
}

function SourceTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
        active ? "chord-gradient text-[#06351f] shadow-sm" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
