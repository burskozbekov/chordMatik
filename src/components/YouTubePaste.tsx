import { useAppState } from "../state/AppState";
import { YouTubeUrlInput } from "./YouTubeUrlInput";

/**
 * Standalone YouTube link box for the first-run screen: paste a link and the
 * video plays in-app right away — no local file needed. (Chord analysis still
 * requires a local audio file you own; this is playback-only.)
 */
export function YouTubePaste() {
  const { setYouTubeUrl } = useAppState();
  return (
    <YouTubeUrlInput
      onSubmit={setYouTubeUrl}
      placeholder="Paste a YouTube link to get the chords"
      submitLabel="Get chords"
      fullWidth
    />
  );
}
