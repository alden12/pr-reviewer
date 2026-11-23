/**
 * The home page's list (INBOX-1): every open PR in this repo and the repos nested in it, joined with the reviews kept
 * on this machine.
 * Node-free, so the app and its tests share it; the reviewer's server fetches the GitHub half (`pipeline/inbox.ts`) and the
 * reviews (`api/reviews`).
 *
 * One list, newest first, rather than groups by who is waiting on whom (Alden, 2026-11-22): who wrote each PR shows
 * on its row, and a filter narrows to one person or one repo.
 */
import { z } from "zod";

/** An open PR as the reviewer's server reports it: REST's fields this page reads, with its checks' combined state. */
export const openPrSchema = z.strictObject({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  createdAt: z.string(),
  draft: z.boolean(),
  head: z.string(),
  /**
   * Every commit status and check run at the head, combined (any failure fails); null when nothing has run, `unknown`
   * when GitHub wouldn't say.
   */
  checks: z.enum(["success", "pending", "failure", "error", "unknown"]).nullable(),
  /** The reader is a requested reviewer. */
  reviewRequested: z.boolean(),
});
export type OpenPr = z.infer<typeof openPrSchema>;

/** A review folder on this machine: which PR it is of, where its run is, and that PR's state now. */
export const localReviewSchema = z.strictObject({
  name: z.string(),
  repo: z.string(),
  number: z.number().int(),
  /** The run's step (`done` once finished), or null when the folder has no `state.json` (a committed review). */
  step: z.string().nullable(),
  /** When the run last moved (its `state.json`'s newest entry), to pick the newest of several reviews of one PR. */
  updatedAt: z.string().nullable(),
  prState: z.enum(["open", "merged", "closed"]),
  /** When it merged or closed. */
  closedAt: z.string().nullable(),
});
export type LocalReview = z.infer<typeof localReviewSchema>;

export const inboxSchema = z.strictObject({
  me: z.string(),
  /** The repo this checkout is of (`owner/name`), whose PRs need no `--clone` to review; null when git can't say. */
  here: z.string().nullable(),
  open: z.array(openPrSchema),
  /** Open PRs past the first page GitHub's search returns, not listed: said on the page rather than dropped. */
  more: z.number().int(),
  reviews: z.array(localReviewSchema),
});
export type Inbox = z.infer<typeof inboxSchema>;

/** What the app knows of a bundled review, from its `review.json`. */
export interface ReviewSummary {
  name: string;
  repo: string;
  number: number;
  title: string;
  /** The head it reviewed; absent on reviews older than ARCH-4. */
  commit?: string;
  verdict: "approve" | "comment" | "request-changes";
  decisions: number;
  /** When it was put together; absent on reviews made before it was recorded. */
  reviewedAt?: string;
}

/**
 * Review names newest first: by when each was put together, then (for reviews made before that was recorded) by PR
 * number, a higher one being a later PR within its repo; a review that didn't parse goes last, by name.
 */
export function newestFirst(names: string[], reviews: ReviewSummary[]): string[] {
  const byName = new Map(reviews.map((review) => [review.name, review]));
  const when = (name: string) => byName.get(name)?.reviewedAt ?? "";
  const number = (name: string) => byName.get(name)?.number ?? -1;
  return [...names].sort(
    (left, right) => when(right).localeCompare(when(left)) || number(right) - number(left) || left.localeCompare(right),
  );
}

/** Where a PR's review stands, which picks the row's pill and its one action. */
export type ReviewState =
  | { kind: "none" }
  | { kind: "running"; name: string; step: string }
  | { kind: "current"; name: string; verdict: ReviewSummary["verdict"]; decisions: number }
  | {
      kind: "outdated";
      name: string;
      verdict: ReviewSummary["verdict"];
      decisions: number;
      /** It has a local run (`state.json`) that `review back` can send for the new head; a committed one hasn't. */
      canGoBack: boolean;
    };

export interface Row {
  pr: OpenPr;
  review: ReviewState;
  /** Waiting on the reader: a review they were asked for, or decisions in a review of theirs. */
  needsYou: boolean;
  mine: boolean;
}

const keyOf = (repo: string, number: number) => `${repo}#${number}`;

/**
 * A PR's review: its newest local run still going, else its newest review, current when it reviewed the head the PR is
 * at now. Newest is by when a run last moved; a review with no local run (a committed one) comes after any with one.
 * A review that records no commit can't be told current, so it counts as out of date: saying a review is current when
 * nobody knows is the worse mistake.
 */
function reviewStateOf(pr: OpenPr, runs: LocalReview[], reviews: ReviewSummary[]): ReviewState {
  const newestFirst = [...runs].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  const running = newestFirst.find((run) => run.step !== null && run.step !== "done");
  if (running) return { kind: "running", name: running.name, step: running.step! };
  const rank = (review: ReviewSummary) => {
    const index = newestFirst.findIndex((run) => run.name === review.name && run.step !== null);
    return index === -1 ? newestFirst.length : index;
  };
  // Ties (several with no local run) go to the last by name, as the library lists them: the newest a name can say.
  const review = reviews
    .map((each, index) => ({ each, index }))
    .sort((left, right) => rank(left.each) - rank(right.each) || right.index - left.index)[0]?.each;
  if (!review) return { kind: "none" };
  const fields = { name: review.name, verdict: review.verdict, decisions: review.decisions };
  if (review.commit !== undefined && pr.head.startsWith(review.commit)) return { kind: "current", ...fields };
  return { kind: "outdated", ...fields, canGoBack: rank(review) < newestFirst.length };
}

/** Every open PR as a row, newest first. */
export function rowsOf(inbox: Inbox, reviews: ReviewSummary[]): Row[] {
  const byKey = <Each extends { repo: string; number: number }>(list: Each[], pr: OpenPr) =>
    list.filter((each) => keyOf(each.repo, each.number) === keyOf(pr.repo, pr.number));
  return inbox.open
    .map((pr) => {
      const review = reviewStateOf(pr, byKey(inbox.reviews, pr), byKey(reviews, pr));
      const mine = pr.author === inbox.me;
      const decisionsWaiting = mine && "decisions" in review && review.decisions > 0;
      return { pr, review, mine, needsYou: pr.reviewRequested || decisionsWaiting };
    })
    .sort((left, right) => right.pr.createdAt.localeCompare(left.pr.createdAt));
}

export interface Filters {
  /** `null` for everyone, else one login. */
  author: string | null;
  repo: string | null;
  /** Show bots' PRs. Off by default: a repo nobody tends collects years of dependency bumps, which bury the rest. */
  bots: boolean;
}

/** A GitHub App's login, such as `dependabot[bot]`. */
export const isBot = (login: string): boolean => login.endsWith("[bot]");

export const filterRows = (rows: Row[], { author, repo, bots }: Filters): Row[] =>
  rows.filter(
    (row) =>
      (author === null || row.pr.author === author) &&
      (repo === null || row.pr.repo === repo) &&
      (bots || author !== null || !isBot(row.pr.author)),
  );

/** The values each filter offers, from the rows there are: the reader first among authors, then by name; bots' repos only while bots show. */
export function filterOptions(
  rows: Row[],
  me: string,
  bots = false,
): { authors: string[]; repos: string[]; bots: number } {
  const distinct = (values: string[]) => [...new Set(values)].sort((left, right) => left.localeCompare(right));
  const authors = distinct(rows.map((row) => row.pr.author).filter((author) => !isBot(author)));
  return {
    authors: authors.includes(me) ? [me, ...authors.filter((author) => author !== me)] : authors,
    // While bots are hidden, a repo with only their PRs would be a chip that shows nothing.
    repos: distinct(rows.filter((row) => bots || !isBot(row.pr.author)).map((row) => row.pr.repo)),
    /** How many PRs are bots', for the line that says they are hidden. */
    bots: rows.filter((row) => isBot(row.pr.author)).length,
  };
}

export interface PastReview {
  name: string;
  repo: string;
  number: number;
  title: string;
  state: "merged" | "closed";
  closedAt: string | null;
  verdict: ReviewSummary["verdict"] | null;
}

/** Reviews kept here whose PR has merged or closed, most recently closed first. */
export function pastReviews(inbox: Inbox, reviews: ReviewSummary[]): PastReview[] {
  return inbox.reviews
    .flatMap((local): PastReview[] => {
      if (local.prState === "open") return [];
      const review = reviews.find((each) => each.name === local.name);
      return [
        {
          name: local.name,
          repo: local.repo,
          number: local.number,
          title: review?.title ?? `#${local.number}`,
          state: local.prState,
          closedAt: local.closedAt,
          verdict: review?.verdict ?? null,
        },
      ];
    })
    .sort((left, right) => (right.closedAt ?? "").localeCompare(left.closedAt ?? ""));
}

/**
 * The command that starts a review of a PR, or sends a run back to fetch the PR's new head. A review committed in this
 * package has no run to send back (`back` reads the runs beside the plan only), so its PR is started afresh.
 */
export function reviewCommand(row: Row, here: string | null): string {
  if (row.review.kind === "outdated" && row.review.canGoBack)
    return `npx @traverso/pr-reviewer back ${row.review.name} fetch`;
  const clone = row.pr.repo === here ? "" : " --clone <path to its clone>";
  return `npx @traverso/pr-reviewer start ${row.pr.number}${clone}`;
}

/**
 * The commits a review doesn't cover: those between the head it reviewed and the PR's head now, oldest first. The
 * reviewer's server reports them (`api/since`) for an out-of-date review's banner, until FLOW-17 shows their changes too.
 */
export const sinceSchema = z.strictObject({
  head: z.string(),
  commits: z.array(z.strictObject({ sha: z.string(), subject: z.string(), url: z.string() })),
});
export type Since = z.infer<typeof sinceSchema>;

/**
 * The reviews the lists above don't link (an open PR's row, or past reviews): ones of a repo this checkout doesn't
 * hold, of a PR GitHub couldn't read, or an older run of a PR whose newer one is linked. Kept in `names`' order, so
 * the page can still reach every review without listing any twice.
 */
export function otherReviews(names: string[], rows: Row[], past: PastReview[]): string[] {
  const linked = new Set([
    ...rows.flatMap((row) => (row.review.kind === "none" ? [] : [row.review.name])),
    ...past.map((review) => review.name),
  ]);
  return names.filter((name) => !linked.has(name));
}
