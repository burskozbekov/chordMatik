/**
 * A single shared AudioContext for the whole app.
 *
 * WKWebView (and Safari) get flaky with multiple concurrent AudioContexts —
 * creating/closing a second context while an HTMLMediaElement (the song) is
 * playing can silence the element's audio. So the tuner, metronome, and count-in
 * all share ONE context that is created lazily and NEVER closed.
 */
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
