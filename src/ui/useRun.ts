/**
 * Where a review's run is, kept current while it runs: the server's `api/run/<name>`, read from the run's own
 * `state.json` on disk, every few seconds. Local only (no GitHub call), so polling costs a small file read, and it
 * stops once the run is done, so a finished review costs nothing.
 */
import { useEffect, useState } from "react";

export interface RunState {
  /** The step it is at, or `done`. */
  at: string;
  /** That step was handed to an agent, and the run waits for it. */
  waiting: boolean;
  /** `review.json` exists, so there is a review to open (written at assemble, before the last steps). */
  written?: boolean;
  number?: number;
  title?: string;
  repo?: string;
}

/** How often a running review is asked about: often enough to feel live, rarely enough to cost nothing. */
export const RUN_POLL_MS = 3000;

/** What the hook holds: the run, and which start it grew from (`from`), so a new start replaces it. */
export interface Held {
  from: string;
  run: RunState | null;
}

/**
 * What the hook holds now: what it had, while the caller's start is the one it grew from, else the caller's new
 * `initial`. A start is the run's name and where `initial` came from, so a row whose list was read again starts from
 * that newer word, even when it names the same step: a finished run's `done` must not outlive a new round on the
 * same folder, which would read as finished and never be asked about.
 */
export const heldFrom = (held: Held, from: string, initial: RunState | null): Held =>
  held.from === from ? held : { from, run: initial };

/** Whether to keep asking: not for a caller with no run (`enabled` false), and not once it is done. */
export const polls = (run: RunState | null, enabled: boolean): boolean => enabled && run?.at !== "done";

/**
 * Whether a page waiting on a run should reload onto its review: only once `written` has been seen false and then
 * true. A page that opened with it already true is one the app couldn't open (its `review.json` there but not
 * loadable), so reloading would only land back here, at once and forever.
 */
export const reloadsOnto = (seenUnwritten: boolean, run: RunState): boolean => seenUnwritten && run.written === true;

/**
 * What a page waiting on a run does as it opens: `wait` while there is no `review.json`; with one already there, `reload`
 * once and only then `unloadable`. main.tsx asks `api/reviews` before `api/run`, so assemble can write the review
 * between the two and the page opens written although a reload would open it: one reload tells that race from a file
 * that really doesn't load, and `reopened` (a mark set before that reload) is what stops it being a loop.
 */
export const onOpen = (run: RunState, reopened: boolean): "wait" | "reload" | "unloadable" =>
  run.written !== true ? "wait" : reopened ? "unloadable" : "reload";

/** The per-tab mark that a page opened written and reloaded once, by review name, so the next open says why. */
const reopenKey = (name: string): string => `pr-reviewer:reopened:${name}`;

/**
 * Whether this tab already reloaded once for `name`. True as well when storage can't be read or written (a private
 * window, blocked site data), since the one reload then couldn't be marked and would repeat forever.
 */
export const reopened = (name: string): boolean => {
  try {
    if (sessionStorage.getItem(reopenKey(name)) !== null) return true;
    // Probed with the mark's own key and put back, so a second call (StrictMode's) reads the same answer.
    sessionStorage.setItem(reopenKey(name), "1");
    sessionStorage.removeItem(reopenKey(name));
    return false;
  } catch {
    return true;
  }
};

/** Sets the mark, just before the one reload. */
export const markReopened = (name: string): void => {
  try {
    sessionStorage.setItem(reopenKey(name), "1");
  } catch {
    // `reopened` found storage writable a moment ago; nothing better to do than reload unmarked.
  }
};

/** Clears the mark, once the review opens or the error has been shown, so a later visit gets its one reload again. */
export const clearReopened = (name: string): void => {
  try {
    sessionStorage.removeItem(reopenKey(name));
  } catch {
    // Nothing was stored, then.
  }
};

/**
 * The run's state, starting from `initial` and asked again every `RUN_POLL_MS` until it is done; null when unknown.
 * `enabled` false asks nothing, for a caller that has a run only sometimes (a hook can't be called conditionally).
 * `since` says which answer `initial` came from (a list's load, say): a new one starts the hook again from it.
 */
export function useRun(name: string, initial: RunState | null = null, enabled = true, since = ""): RunState | null {
  const from = `${name}\n${since}`;
  const [stored, setStored] = useState<Held>({ from, run: initial });
  const held = heldFrom(stored, from, initial);
  // Set during render, as React has a prop change adjust state: the stale run is never drawn or polled from.
  if (held !== stored) setStored(held);
  const polling = polls(held.run, enabled);
  useEffect(() => {
    if (!polling) return;
    let current = true;
    const ask = () =>
      fetch(`api/run/${encodeURIComponent(name)}`)
        .then((response) => (response.ok ? (response.json() as Promise<RunState>) : null))
        .then((state) => {
          if (current && state !== null) setStored({ from, run: state });
        })
        .catch(() => undefined);
    void ask();
    const timer = window.setInterval(() => void ask(), RUN_POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [name, from, polling]);
  return held.run;
}
