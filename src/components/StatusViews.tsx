import { motion } from "motion/react";
import { Button } from "@heroui/react";
import { AlertIcon } from "./icons";

/** Centered analyzing state. */
export function LoadingState({ name }: { name?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass mx-auto flex w-full max-w-md flex-col items-center gap-5 rounded-3xl px-8 py-12 text-center shadow-overlay"
    >
      <div className="relative grid size-16 place-items-center">
        <motion.span
          className="absolute inset-0 rounded-full border-[3px] border-brand-sky/25 border-t-brand-sky"
          animate={{ rotate: 360 }}
          transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
        />
        <span className="chord-gradient size-7 rounded-lg" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">Analyzing your song…</p>
        <p className="mt-1 truncate text-sm text-muted">
          {name ? `Decoding ${name}` : "Decoding audio on your device"}
        </p>
      </div>
    </motion.div>
  );
}

/** Centered error card with a retry/open action, and (if a song is loaded) a way back. */
export function ErrorState({
  message,
  onOpen,
  onBack,
}: {
  message: string;
  onOpen: () => void;
  onBack?: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-3xl px-8 py-10 text-center shadow-overlay"
    >
      <div className="grid size-14 place-items-center rounded-2xl bg-danger/12 text-danger">
        <AlertIcon className="size-7" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">Couldn’t analyze that file</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{message}</p>
      </div>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="secondary" size="md" onPress={onBack}>
            Go back
          </Button>
        )}
        <Button variant="primary" size="md" onPress={onOpen}>
          Try another file
        </Button>
      </div>
    </motion.div>
  );
}
