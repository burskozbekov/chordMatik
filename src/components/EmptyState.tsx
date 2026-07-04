import { YouTubePaste } from "./YouTubePaste";
import { LibrarySection } from "./LibrarySection";
import { FolderOpenIcon } from "./icons";

interface EmptyStateProps {
  onOpenFile?: () => void;
}

/** Minimal first screen: paste a YouTube link (or open a file) → chords to play along. */
export function EmptyState({ onOpenFile }: EmptyStateProps) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4">
      <div className="w-full">
        <YouTubePaste />
      </div>

      <button
        type="button"
        onClick={onOpenFile}
        className="inline-flex items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-foreground"
      >
        <FolderOpenIcon className="size-4" />
        or open an audio file
      </button>

      <LibrarySection />
    </div>
  );
}
