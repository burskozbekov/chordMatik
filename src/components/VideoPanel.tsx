import { YT_CONTAINER_ID } from "../hooks/useYouTubeEngine";
import { useAppState } from "../state/AppState";
import { isTauri, openExternal } from "../lib/tauri";
import { youTubeWatchUrl } from "../lib/youtube";
import { Transport } from "./Transport";
import { PlaybackTools } from "./PlaybackTools";
import { AlertIcon, FolderOpenIcon, SparkleIcon, YouTubeIcon } from "./icons";

/** In-app YouTube player (official IFrame embed) + transport + alignment offset. */
export function VideoPanel() {
  const { engine, analysis, youtubeId, youtubeError, syncOffset, setSyncOffset } = useAppState();
  // With a local analysis we know the track length; standalone (no song) we
  // fall back to the video's own duration reported by the YouTube engine.
  const duration = analysis?.durationSec ?? engine.duration;
  const loading = !engine.isReady && !youtubeError;
  const openOnYouTube = () => {
    if (youtubeId) void openExternal(youTubeWatchUrl(youtubeId));
  };

  return (
    <div className="glass rounded-3xl p-4 shadow-overlay sm:p-5">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black/90">
        {/* Replaced in place by the YouTube iframe (same id). The overlays below
            are kept permanently mounted (visibility toggled) so React never
            inserts/removes a sibling next to the API-replaced node. */}
        <div id={YT_CONTAINER_ID} aria-label="YouTube video player" role="application" />

        <div
          className={`pointer-events-none absolute inset-0 grid place-items-center transition-opacity duration-200 ${
            loading ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden={!loading}
        >
          <span className="size-9 animate-spin rounded-full border-[3px] border-white/25 border-t-white/90" />
        </div>

        <div
          className={`absolute inset-0 grid place-items-center bg-black/85 px-6 text-center transition-opacity duration-200 ${
            youtubeError ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          role={youtubeError ? "alert" : undefined}
          aria-hidden={!youtubeError}
        >
          <div className="flex max-w-sm flex-col items-center gap-3">
            <AlertIcon className="size-7 text-danger" />
            <p className="text-sm font-medium text-white/90">{youtubeError}</p>
            <OpenOnYouTubeButton onPress={openOnYouTube} variant="solid" />
          </div>
        </div>
      </div>

      {!youtubeError && (
        <>
          <div className="mt-4">
            <Transport
              engine={engine}
              durationSec={duration}
              durationPending={!analysis && !engine.isReady}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
            <PlaybackTools engine={engine} />
            <div className="flex items-center gap-3">
              {/* The sync offset only matters once there's a chord track to align. */}
              {analysis && <OffsetNudge value={syncOffset} onChange={setSyncOffset} />}
              {/* Escape hatch: some embeds (esp. packaged desktop builds) are
                  blocked by YouTube and only play on youtube.com. */}
              <OpenOnYouTubeButton onPress={openOnYouTube} variant="ghost" />
            </div>
          </div>

          {/* No chords yet (standalone video): get the chord chart from the file. */}
          {!analysis && isTauri() && <CaptureBar />}
        </>
      )}
    </div>
  );
}

/**
 * Getting the chord chart for a pasted link: chordMatik downloads the audio
 * (yt-dlp), analyzes it on-device, then shows the full scrolling chart with
 * seek + look-ahead. The audio is deleted right after analysis.
 */
function CaptureBar() {
  const { ytFetchState, ytFetchError, openAudioForVideo } = useAppState();

  if (ytFetchState === "downloading" || ytFetchState === "analyzing") {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border/60 bg-surface/40 p-3.5">
        <span className="size-5 animate-spin rounded-full border-[3px] border-brand-sky/25 border-t-brand-sky" />
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-foreground">
            {ytFetchState === "downloading"
              ? "Getting the audio from YouTube…"
              : "Finding the chords on your device…"}
          </p>
          <p className="text-[11px] text-muted">
            One moment — then the full chord chart appears. Audio is deleted after.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-2xl border border-border/60 bg-surface/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-sky/12 text-brand-sky-strong dark:text-brand-sky">
            <SparkleIcon className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold text-foreground">
              {ytFetchState === "error" ? "Couldn’t get the chords" : "Get the chord chart"}
            </p>
            <p className="text-[11px] text-muted">
              {ytFetchState === "error"
                ? (ytFetchError ?? "Try another link, or open the song's file.")
                : "chordMatik downloads the audio and finds the chords on your device."}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void openAudioForVideo()}
          className="cta-gradient inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-sky-strong"
        >
          <FolderOpenIcon className="size-4" />
          Open a file instead
        </button>
      </div>
    </div>
  );
}

function OpenOnYouTubeButton({
  onPress,
  variant,
}: {
  onPress: () => void;
  variant: "solid" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={
        variant === "solid"
          ? "inline-flex items-center gap-1.5 rounded-xl bg-white/95 px-3 py-1.5 text-sm font-semibold text-black/85 transition-colors hover:bg-white"
          : "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      }
    >
      <YouTubeIcon className={variant === "solid" ? "size-4" : "size-3.5"} />
      Open on YouTube
    </button>
  );
}

function OffsetNudge({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const display = value === 0 ? "0.0s" : `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}s`;
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[11px] font-semibold uppercase tracking-wide text-muted"
        title="Shift the chord track to line up with the video"
      >
        Sync
      </span>
      <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-surface/50 p-0.5">
        <button
          type="button"
          aria-label="Chords earlier"
          onClick={() => onChange(round1(value - 0.1))}
          className="grid size-7 place-items-center rounded-lg text-base leading-none text-muted hover:bg-surface-hover hover:text-foreground"
        >
          −
        </button>
        <button
          type="button"
          title="Reset"
          onClick={() => onChange(0)}
          className="min-w-[3.6ch] px-1 text-center text-sm font-semibold tabular-nums text-foreground"
        >
          {display}
        </button>
        <button
          type="button"
          aria-label="Chords later"
          onClick={() => onChange(round1(value + 0.1))}
          className="grid size-7 place-items-center rounded-lg text-base leading-none text-muted hover:bg-surface-hover hover:text-foreground"
        >
          +
        </button>
      </div>
    </div>
  );
}
