import { AnimatePresence, motion } from "motion/react";
import { Button } from "@heroui/react";
import { MoonIcon, SunIcon } from "./icons";
import type { ThemeMode } from "../hooks/useTheme";

interface ThemeToggleProps {
  theme: ThemeMode;
  onToggle: () => void;
}

/** Icon-only theme switch with a cross-fading sun/moon. */
export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Button
      variant="ghost"
      size="md"
      isIconOnly
      aria-label={label}
      onPress={onToggle}
      className="text-foreground/80"
    >
      <span className="relative grid size-5 place-items-center">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={theme}
            initial={{ y: -8, opacity: 0, rotate: -30 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            exit={{ y: 8, opacity: 0, rotate: 30 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 grid place-items-center"
          >
            {isDark ? <MoonIcon className="size-5" /> : <SunIcon className="size-5" />}
          </motion.span>
        </AnimatePresence>
      </span>
    </Button>
  );
}
