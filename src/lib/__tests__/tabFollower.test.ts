import { describe, expect, it, vi } from "vitest";
import { EndHold, SeekGate, createFollowerTransport } from "../tabFollower";

describe("SeekGate — only a beat click may seek the audio", () => {
  it("is closed until the user presses a beat", () => {
    const g = new SeekGate();
    expect(g.allows(1000)).toBe(false);
  });

  it("opens on press for a long press and closes shortly after release", () => {
    const g = new SeekGate();
    g.press(1000);
    expect(g.allows(1000)).toBe(true);
    expect(g.allows(4000)).toBe(true); // a 3-second press still seeks on release
    g.release(4000);
    expect(g.allows(4250)).toBe(true); // AlphaTab's mouse-up seek lands right after
    expect(g.allows(4400)).toBe(false); // a later AlphaTab-initiated seek is refused
  });

  it("does not stay open forever after a press without a release", () => {
    const g = new SeekGate();
    g.press(0);
    expect(g.allows(5000)).toBe(true);
    expect(g.allows(5001)).toBe(false);
  });
});

describe("createFollowerTransport — AlphaTab never drives the engine", () => {
  const make = () => {
    const seek = vi.fn();
    let now = 10_000;
    const gate = new SeekGate();
    const hold = new EndHold();
    const t = createFollowerTransport(gate, hold, {
      now: () => now,
      offsetSec: () => 0.5,
      seek,
    });
    return { t, gate, hold, seek, setNow: (v: number) => (now = v) };
  };

  it("drops seeks that did not come from a click (updateSyncPoints, stop, re-render)", () => {
    const { t, seek } = make();
    t.seekTo(12_345);
    t.seekTo(0);
    expect(seek).not.toHaveBeenCalled();
  });

  it("forwards a click seek with the sync offset applied", () => {
    const { t, gate, seek } = make();
    gate.press(10_000);
    t.seekTo(12_000);
    expect(seek).toHaveBeenCalledWith(12.5);
  });

  it("ignores AlphaTab's own play/pause requests entirely", () => {
    const { t, seek } = make();
    expect(() => {
      t.play();
      t.pause();
    }).not.toThrow();
    expect(seek).not.toHaveBeenCalled();
  });

  it("a click seek releases an end-of-tab hold", () => {
    const { t, gate, hold } = make();
    hold.finished(200_000);
    expect(hold.holding).toBe(true);
    gate.press(10_000);
    t.seekTo(1_000);
    expect(hold.holding).toBe(false);
  });
});

describe("EndHold — song longer than the tab", () => {
  it("parks just before the end, holds while the song plays on, resumes when sought back", () => {
    const h = new EndHold();
    expect(h.next(5_000)).toBe("push");
    expect(h.finished(100_000)).toBe(99_750);
    expect(h.holding).toBe(true);
    expect(h.finished(100_040)).toBeNull(); // AlphaTab re-finishes every tick — once is enough
    expect(h.next(100_040)).toBe("hold");
    expect(h.next(130_000)).toBe("hold"); // the outro keeps playing, cursor stays parked
    expect(h.next(99_760)).toBe("hold"); // still inside the parked margin
    expect(h.next(20_000)).toBe("resume"); // R / chord click / restart from 0
    expect(h.holding).toBe(false);
    expect(h.next(20_040)).toBe("push");
  });

  it("never parks before 0 and can be reset by a new grid", () => {
    const h = new EndHold();
    expect(h.finished(100)).toBe(0);
    h.reset();
    expect(h.holding).toBe(false);
    expect(h.next(50)).toBe("push");
  });
});
