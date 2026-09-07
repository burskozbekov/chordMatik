/**
 * AlphaTab is a FOLLOWER of the audio engine — the engine owns the transport.
 *
 * Yet in external-media mode AlphaTab keeps driving the media handler on its
 * own initiative: `updateSyncPoints()` re-seeks the media to ITS tick↔time
 * mapping (every anchor change), a re-render resets to bar 1, a drag across
 * beats makes a playback range, and reaching the tab's end runs `stop()` =
 * pause + seek to 0. Forwarding those to the engine yanked the audio around
 * ("the tab jumps when I press Space"). This module is the policy that decides
 * which handler calls may touch the engine — pure, so it can be unit-tested.
 */

/** Only a user's click on a beat may seek the audio. AlphaTab seeks on mouse-UP
 *  (before it raises `beatMouseUp`), so the press opens a window wide enough
 *  for a long press and the release closes it shortly after. */
export class SeekGate {
  private until = 0;

  press(now: number): void {
    this.until = now + 5000;
  }

  release(now: number): void {
    this.until = now + 300;
  }

  allows(now: number): boolean {
    return now <= this.until;
  }
}

/** Past the tab's end (song longer than the tab): AlphaTab "finishes" and
 *  rewinds to tick 0. Instead park the cursor just before the end and stop
 *  forwarding positions until the engine is back before the end. */
export class EndHold {
  private active = false;
  private endMs = 0;
  /** How far before the reported end the cursor is parked (backing-track ms). */
  static readonly MARGIN_MS = 250;

  get holding(): boolean {
    return this.active;
  }

  /** AlphaTab reported the end while the backing track sat at `lastPushedMs`.
   *  Returns the park position, or null when the hold was already active. */
  finished(lastPushedMs: number): number | null {
    if (this.active) return null;
    this.active = true;
    this.endMs = lastPushedMs;
    return Math.max(0, lastPushedMs - EndHold.MARGIN_MS);
  }

  /** What to do with a new engine position: keep holding, resume following
   *  (the engine went back before the end), or plain push (no hold). */
  next(ms: number): "hold" | "resume" | "push" {
    if (!this.active) return "push";
    if (ms >= this.endMs - EndHold.MARGIN_MS) return "hold";
    this.active = false;
    return "resume";
  }

  reset(): void {
    this.active = false;
  }
}

export interface FollowerDeps {
  now: () => number;
  offsetSec: () => number;
  seek: (sec: number) => void;
}

/** The transport part of AlphaTab's external-media handler. `play`/`pause`
 *  are deliberately inert; `seekTo` passes only inside the click window. */
export function createFollowerTransport(gate: SeekGate, hold: EndHold, deps: FollowerDeps) {
  return {
    seekTo(ms: number): void {
      if (!gate.allows(deps.now())) return;
      hold.reset();
      deps.seek(ms / 1000 + deps.offsetSec());
    },
    play(): void {
      /* the engine owns the transport */
    },
    pause(): void {
      /* the engine owns the transport */
    },
  };
}
