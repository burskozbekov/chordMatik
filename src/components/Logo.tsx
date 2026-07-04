import { ChordMarkIcon } from "./icons";

/** Logo lockup: gradient glyph tile + wordmark. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <div className="chord-gradient grid size-9 place-items-center rounded-2xl text-[#06351f] shadow-[0_6px_16px_-6px_rgba(52,211,153,0.65)]">
        <ChordMarkIcon className="size-5" strokeWidth={2} />
      </div>
      <span className="text-[15px] font-semibold tracking-tight text-foreground">
        chord<span className="text-brand-sky-strong dark:text-brand-sky">Matik</span>
      </span>
    </div>
  );
}
