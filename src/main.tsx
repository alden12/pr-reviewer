import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { reviewLibrary, sourceOf } from "./review/library";
import { loadReview } from "./review/model";
import { App } from "./ui/App";
import type { ReadingEvent } from "./ui/state";
import { Picker } from "./ui/Picker";
import { Home } from "./ui/Home";
import { RunInProgress, type RunState } from "./ui/RunInProgress";
import { clearReopened } from "./ui/useRun";
import { newestFirst, summaryOf, type ReviewSummary } from "./inbox/rows";
import "./ui/styles.css";

/**
 * In attraverso's pane (`?in=pane`, the viewer's iframe on a wide screen): every link opens in the whole window, since
 * a review needs the full width and a PR's page is GitHub's, and the page is marked so its styles fit the pane.
 */
if (new URLSearchParams(window.location.search).get("in") === "pane") {
  const base = document.createElement("base");
  base.target = "_top";
  document.head.append(base);
  document.documentElement.classList.add("in-pane");
}

/**
 * The committed reviews, bundled in: `reviews/<name>/`, so a review can be read anywhere the repo is, a phone
 * included. What the page reads when there is no server, as when the built file is opened or shared on its own.
 */
const bundled = import.meta.glob<unknown>("../reviews/*/{diff,review}.json", { eager: true, import: "default" });

/** JSON from the reviewer's server (`pipeline/host.ts`), by a URL relative to the page, or null when there is none. */
const ask = async (path: string): Promise<unknown> => {
  try {
    const response = await fetch(path);
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
};

/**
 * Every review there is, from the server when there is one (DIST-2): this package's committed ones and the runs'
 * (`.attraverso/reviews/<name>/` beside the plan), read from disk on each load, so a review made after the page was
 * built shows. Without a server, the bundled ones, which are only this package's: a runs' folder belongs to whoever's
 * plan it is beside, and bundling it is DIST-1.3's to decide.
 */
const fromServer = await ask("api/reviews");
const { served, files: source } = sourceOf(fromServer, bundled);
const library = reviewLibrary(source);
const requested = new URLSearchParams(window.location.search).get("review");
const chosen = library.choose(requested);
// The review opens, so a reload the in-progress page made for it (`onOpen`) is spent: the next one gets its own.
if (chosen !== null) clearReopened(chosen);
const files = chosen === null ? null : library.filesOf(chosen);
/** The chosen review's diff: asked for when served (the list carries no diffs, they are the bulk), else bundled. */
const diffOf = async (): Promise<unknown> => {
  if (chosen === null || files === null) return null;
  return served ? ask(`api/diff/${encodeURIComponent(chosen)}`) : files.diff;
};
const diff = await diffOf();

/** A run asked for by name that has no review yet: where it is, from the server (`api/run`). */
const running =
  served && requested !== null && chosen === null
    ? ((await ask(`api/run/${encodeURIComponent(requested)}`)) as RunState | null)
    : null;

const root = createRoot(document.getElementById("root")!);
/** What the home page needs of each review; one that doesn't parse is left off. */
const summaries = (): ReviewSummary[] =>
  library.names.flatMap((name) => summaryOf(name, library.filesOf(name)?.annotations) ?? []);

/** The reviews newest first, for the lists of them (`newestFirst`). */
const ordered = (): string[] => newestFirst(library.names, summaries());

if (running !== null && requested !== null) {
  document.title = `${running.number === undefined ? requested : `#${running.number}`}: review in progress`;
  root.render(
    <StrictMode>
      <RunInProgress name={requested} run={running} />
    </StrictMode>,
  );
} else if (chosen !== null && files !== null && diff === null) {
  // The review is listed but its diff didn't come (gone since, or unreadable): say so, rather than showing the list as
  // though the link were wrong.
  document.title = "Review not loaded";
  root.render(
    <StrictMode>
      <p className="load-error">
        Couldn't load the diff for {chosen}. Its review is listed, so the diff may have been removed or be unreadable.
      </p>
    </StrictMode>,
  );
} else if (files === null || diff === null) {
  // The home page asks GitHub through the server; without one, the page lists what is bundled.
  document.title = served ? "Pull requests" : "Reviews";
  root.render(
    served ? (
      <StrictMode>
        <Home reviews={summaries()} names={ordered()} />
      </StrictMode>
    ) : (
      <Picker names={ordered()} />
    ),
  );
} else {
  const review = loadReview(diff, files.annotations);
  // What the reader opens and folds back, logged by the server beside a local review (KNOW-4).
  const record =
    served && library.isLocal(chosen!)
      ? (event: ReadingEvent) =>
          void fetch(`api/reading/${encodeURIComponent(chosen!)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event),
          })
      : undefined;
  document.title = `#${review.annotations.pr.number} ${review.annotations.pr.title}`;
  // Back to the open PRs when served; without a server, to the list of reviews, which only exists with more than one.
  const home = served ? "Pull requests" : library.names.length > 1 ? "Reviews" : undefined;
  root.render(
    <StrictMode>
      <App review={review} {...(record ? { record } : {})} {...(home ? { home } : {})} />
    </StrictMode>,
  );
}
