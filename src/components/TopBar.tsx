import { Button } from "@heroui/react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { UploadIcon } from "./icons";
import type { ThemeMode } from "../hooks/useTheme";

interface TopBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenFile?: () => void;
  onOpenTuner?: () => void;
  onOpenMetronome?: () => void;
}

/** Sticky frosted top bar: brand on the left, actions on the right. */
export function TopBar({ theme, onToggleTheme, onOpenFile, onOpenTuner, onOpenMetronome }: TopBarProps) {
  return (
    <header className="glass sticky top-0 z-50 flex h-14 items-center justify-between gap-3 px-4 sm:px-5">
      <Logo />

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onPress={onOpenMetronome} className="gap-1.5">
          <span aria-hidden>◷</span>
          <span className="hidden sm:inline">Metronome</span>
        </Button>
        <Button variant="ghost" size="sm" onPress={onOpenTuner} className="gap-1.5">
          <span aria-hidden>🎵</span>
          <span className="hidden sm:inline">Tuner</span>
        </Button>
        <Button variant="outline" size="sm" onPress={onOpenFile} className="gap-1.5">
          <UploadIcon className="size-4" />
          <span className="hidden sm:inline">Open</span>
        </Button>

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
