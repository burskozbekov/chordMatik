import { useAppState } from "../state/AppState";
import { YouTubeUrlInput } from "./YouTubeUrlInput";

/**
 * Always-visible paste bar at the top: drop a YouTube link to open it as a NEW
 * tab (the current song stays in the strip, instantly restorable). Pasting a
 * valid link opens it immediately. Hidden on the first-run screen, which already
 * has its own big paste box.
 */
export function NewTabBar() {
  const { openYouTubeUrl, song } = useAppState();
  if (!song) return null;
  return (
    <div className="mb-2">
      <YouTubeUrlInput
        onSubmit={openYouTubeUrl}
        placeholder="Paste a YouTube link to open it in a new tab"
        submitLabel="New tab"
        autoSubmitOnPaste
        fullWidth
      />
    </div>
  );
}
