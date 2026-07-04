import { AnimatePresence, motion } from "motion/react";
import { UploadIcon } from "./icons";

/** Full-window overlay shown while a file is dragged over the app. */
export function DropOverlay({
  visible,
  replacingVideo,
}: {
  visible: boolean;
  /** A YouTube video is currently showing — warn that dropping replaces it. */
  replacingVideo?: boolean;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="pointer-events-none fixed inset-0 z-[100] grid place-items-center p-6"
          style={{ background: "color-mix(in oklab, var(--background) 55%, transparent)" }}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 320, damping: 26 }}
            className="glass flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-brand-sky/60 px-8 py-12 text-center shadow-overlay"
          >
            <div className="chord-gradient grid size-16 place-items-center rounded-2xl text-[#06351f]">
              <UploadIcon className="size-8" strokeWidth={2} />
            </div>
            <div>
              <p className="text-lg font-semibold text-foreground">Drop your song to analyze</p>
              <p className="mt-1 text-sm text-muted">
                {replacingVideo
                  ? "This replaces the current video. Processed on your device — nothing is uploaded."
                  : "It’s processed on your device — nothing is uploaded."}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
