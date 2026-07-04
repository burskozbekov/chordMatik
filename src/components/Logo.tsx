/** Logo lockup: the real app icon + wordmark. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <img
        src="/app-icon.png"
        alt=""
        className="size-9 shadow-[0_6px_16px_-6px_rgba(52,211,153,0.65)] rounded-xl"
        draggable={false}
      />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">
        chord<span className="text-brand-sky-strong dark:text-brand-sky">Matik</span>
      </span>
    </div>
  );
}
