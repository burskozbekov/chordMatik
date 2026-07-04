import { useState, type ClipboardEvent } from "react";
import { Button } from "@heroui/react";
import { YouTubeIcon } from "./icons";

interface YouTubeUrlInputProps {
  /** Attach the pasted value. Return false to show the inline error. */
  onSubmit: (url: string) => boolean;
  placeholder: string;
  submitLabel: string;
  /** Stretch to the container width (used on the empty screen). */
  fullWidth?: boolean;
  /** Fire onSubmit immediately when a valid link is pasted (no Enter needed). */
  autoSubmitOnPaste?: boolean;
}

/**
 * Shared paste-a-YouTube-link control used both on the first-run screen
 * (standalone playback) and inside the player (attach a video to a song).
 */
export function YouTubeUrlInput({
  onSubmit,
  placeholder,
  submitLabel,
  fullWidth,
  autoSubmitOnPaste,
}: YouTubeUrlInputProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);

  const submit = () => {
    if (onSubmit(url)) {
      setUrl("");
      setError(false);
    } else {
      setError(true);
    }
  };

  // Open the moment a valid link is pasted; an invalid paste just fills the input.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (!autoSubmitOnPaste) return;
    const text = e.clipboardData.getData("text").trim();
    if (text && onSubmit(text)) {
      e.preventDefault();
      setUrl("");
      setError(false);
    }
  };

  return (
    <div className={`flex flex-col gap-1 ${fullWidth ? "w-full" : ""}`}>
      <div className="glass flex items-center gap-2 rounded-2xl px-2.5 py-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg text-danger/80">
          <YouTubeIcon className="size-[18px]" />
        </span>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="YouTube URL"
          aria-invalid={error}
          className={`min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none ${
            error ? "text-danger" : ""
          }`}
        />
        <Button variant="primary" size="sm" onPress={submit} isDisabled={!url.trim()}>
          {submitLabel}
        </Button>
      </div>
      {error && (
        <span role="alert" className="px-2 text-xs text-danger">
          Enter a valid YouTube link or 11-character video ID.
        </span>
      )}
    </div>
  );
}
