/**
 * A review whose run hasn't written `review.json` yet, which happens at assemble, after narrate: the page says where
 * the run is rather than falling back to the home page, which read as the link (or the run) being broken. Asked of
 * the server's `api/run/<name>`, from the run's own `state.json`, and kept current while it runs (`useRun`).
 */
import { useEffect, useState } from "react";
import { clearReopened, markReopened, onOpen, reloadsOnto, reopened, useRun, type RunState } from "./useRun";

export type { RunState } from "./useRun";

/** What each agent step is doing, in the reader's words; a code step runs in seconds, so it needs none. */
const DOING: Record<string, string> = {
  review: "reviewing the code",
  fix: "fixing what has a clear answer",
  judge: "checking what is folded away",
  narrate: "writing the reading",
  proofread: "proofreading the review",
};

export function RunInProgress({ name, run: first }: { name: string; run: RunState }) {
  // Kept current while it runs, and the page reloads onto the review once there is one to open: on `written` turning
  // true while watched (`reloadsOnto`). A page that opened with it true reloads once, in case assemble wrote it between
  // main.tsx's two asks, and says the review couldn't be loaded only when it opens written again (`onOpen`).
  const run = useRun(name, first) ?? first;
  const [opening] = useState(() => onOpen(first, reopened(name)));
  useEffect(() => {
    if (opening === "reload") {
      markReopened(name);
      window.location.reload();
    } else if (opening === "unloadable") clearReopened(name);
  }, [name, opening]);
  const [seenUnwritten, setSeenUnwritten] = useState(first.written !== true);
  if (!seenUnwritten && run.written !== true) setSeenUnwritten(true);
  useEffect(() => {
    if (reloadsOnto(seenUnwritten, run)) window.location.reload();
  }, [seenUnwritten, run]);
  const unloadable = run.written === true && !seenUnwritten && opening === "unloadable";
  const pr = run.number === undefined ? name : `#${run.number}${run.title ? ` ${run.title}` : ""}`;
  const doing = DOING[run.at];
  return (
    <main className="run-in-progress">
      <p>
        <a href="./">← Pull requests</a>
      </p>
      <h1>{pr}</h1>
      <p>
        <span className="spinner" aria-hidden="true" /> The review is in progress, at the <strong>{run.at}</strong> step
        {doing ? ` (${doing})` : ""}.
        {run.waiting
          ? " A Claude Code session drives it with the review-pr skill: this step waits on an agent there."
          : ""}
      </p>
      {unloadable ? (
        <p className="load-error">
          The review is written, but the app couldn't load it: its <code>review.json</code> may be unreadable.
        </p>
      ) : (
        <p>The review opens here by itself once it is written.</p>
      )}
      <p className="run-command">
        Where it is: <code>npx -y @traverso/pr-reviewer status {name}</code>, from the folder holding your plan
      </p>
    </main>
  );
}
