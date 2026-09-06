import { useState } from "react";
import { TopBar } from "./components/TopBar";
import { OrganicBackground } from "./components/OrganicBackground";
import { Tuner } from "./components/Tuner";
import { Metronome } from "./components/Metronome";
import { SongTabs } from "./components/SongTabs";
import { NewTabBar } from "./components/NewTabBar";
import { EmptyState } from "./components/EmptyState";
import { Player } from "./components/Player";
import { FetchingState } from "./components/FetchingState";
import { DropOverlay } from "./components/DropOverlay";
import { AutoUpdater } from "./components/AutoUpdater";
import { ErrorState, LoadingState } from "./components/StatusViews";
import { useTheme } from "./hooks/useTheme";
import { useFileDrop } from "./hooks/useFileDrop";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAppState } from "./state/AppState";
import { isSupportedAudio } from "./lib/tauri";

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const { status, error, song, engine, ytFetchState, openDialog, openPath, dismissError } =
    useAppState();
  const [dragOver, setDragOver] = useState(false);
  const [showTuner, setShowTuner] = useState(false);
  const [showMetronome, setShowMetronome] = useState(false);

  useKeyboardShortcuts(engine, Boolean(song));
  useFileDrop({
    onDrop: (paths) => {
      // Only open a supported AUDIO file. Ignore stray drops (e.g. an image)
      // instead of trying to analyze them and getting stuck on an error screen.
      const audio = paths.find(isSupportedAudio);
      if (audio) void openPath(audio);
    },
    onOverChange: setDragOver,
  });

  const fetching =
    ytFetchState === "updating" || ytFetchState === "downloading" || ytFetchState === "analyzing";

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <OrganicBackground />
      <TopBar
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenFile={openDialog}
        onOpenTuner={() => setShowTuner(true)}
        onOpenMetronome={() => setShowMetronome(true)}
      />

      {showTuner && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onClick={() => setShowTuner(false)}>
          <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <Tuner onClose={() => setShowTuner(false)} />
          </div>
        </div>
      )}
      {showMetronome && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onClick={() => setShowMetronome(false)}>
          <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <Metronome onClose={() => setShowMetronome(false)} />
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4 pt-2 sm:px-6 empty:pt-0">
        <NewTabBar />
        <SongTabs />
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
          {status === "loading" ? (
            <LoadingState name={song?.name} />
          ) : status === "error" ? (
            <ErrorState
              message={error ?? "Unknown error"}
              onOpen={openDialog}
              onBack={song ? dismissError : undefined}
            />
          ) : song ? (
            <Player />
          ) : fetching || ytFetchState === "error" ? (
            <FetchingState />
          ) : (
            <EmptyState onOpenFile={openDialog} />
          )}
        </div>
      </main>

      <DropOverlay visible={dragOver} />
      <AutoUpdater />
    </div>
  );
}
