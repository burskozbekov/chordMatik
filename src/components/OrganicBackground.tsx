/**
 * Soft, slowly-drifting gradient blobs behind the (glass) content — the app's
 * "organic" ambient layer. Pure CSS (GPU transforms), sits below everything,
 * and freezes for reduced-motion users via the global media query.
 */
export function OrganicBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="cmk-blob"
        style={{
          width: "58vw",
          height: "58vw",
          left: "-12vw",
          top: "-16vh",
          opacity: 0.5,
          background:
            "radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--accent) 38%, transparent), transparent 68%)",
          animation: "cmk-blob-a 34s ease-in-out infinite",
        }}
      />
      <div
        className="cmk-blob"
        style={{
          width: "52vw",
          height: "52vw",
          right: "-14vw",
          top: "-10vh",
          opacity: 0.45,
          background:
            "radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--color-brand-mint) 52%, transparent), transparent 66%)",
          animation: "cmk-blob-b 44s ease-in-out infinite",
        }}
      />
      <div
        className="cmk-blob"
        style={{
          width: "48vw",
          height: "48vw",
          left: "32vw",
          bottom: "-22vh",
          opacity: 0.4,
          background:
            "radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--color-brand-sky) 50%, transparent), transparent 66%)",
          animation: "cmk-blob-c 38s ease-in-out infinite",
        }}
      />
    </div>
  );
}
