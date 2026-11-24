/**
 * The decisions behind a running review's live state (`src/ui/useRun.ts`), apart from React: when to ask again, what a
 * new start replaces, and when the in-progress page reloads onto the review.
 */
import { describe, expect, it } from "vitest";
import { heldFrom, onOpen, polls, reloadsOnto, type Held } from "../src/ui/useRun";

const at = (step: string, written = false) => ({ at: step, waiting: true, written });

describe("a running review's live state", () => {
  it("polls while enabled and not done, and stops at done", () => {
    expect(polls(at("review"), true)).toBe(true);
    expect(polls(null, true)).toBe(true);
    expect(polls(at("done"), true)).toBe(false);
    expect(polls(at("review"), false)).toBe(false);
    expect(polls(null, false)).toBe(false);
  });

  it("keeps what it polled while the start is the same, and starts again from a new one", () => {
    const polled: Held = { from: "r-1\n1", run: at("narrate") };
    expect(heldFrom(polled, "r-1\n1", at("review"))).toBe(polled);
    // A finished round, then the list read again with a new round at the same step on the same folder.
    const finished: Held = { from: "r-1\n1", run: at("done", true) };
    expect(heldFrom(finished, "r-1\n2", at("review"))).toEqual({ from: "r-1\n2", run: at("review") });
    // Another run's name, or a row whose run has gone (no initial).
    expect(heldFrom(polled, "r-2\n1", at("fix"))).toEqual({ from: "r-2\n1", run: at("fix") });
    expect(heldFrom(polled, "\n1", null)).toEqual({ from: "\n1", run: null });
  });

  it("reloads only on written turning true while watched, never on a page that opened written", () => {
    expect(reloadsOnto(true, at("assemble", true))).toBe(true);
    expect(reloadsOnto(true, at("narrate"))).toBe(false);
    expect(reloadsOnto(true, { at: "narrate", waiting: true })).toBe(false);
    // Opened with review.json already there: not this one's to reload (onOpen reloads once, guarded).
    expect(reloadsOnto(false, at("proofread", true))).toBe(false);
  });

  it("reloads a page that opened written once, and says unloadable only on the open after", () => {
    // Not written yet: wait for it, whether or not this tab reloaded before.
    expect(onOpen(at("narrate"), false)).toBe("wait");
    expect(onOpen(at("narrate"), true)).toBe("wait");
    expect(onOpen({ at: "narrate", waiting: true }, false)).toBe("wait");
    // Written between main.tsx's two asks: one reload, which a fine review.json opens.
    expect(onOpen(at("proofread", true), false)).toBe("reload");
    // Written again after that reload, finished runs included: it really doesn't load, so no second reload.
    expect(onOpen(at("proofread", true), true)).toBe("unloadable");
    expect(onOpen(at("done", true), true)).toBe("unloadable");
  });
});
