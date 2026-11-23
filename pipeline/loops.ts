/**
 * **Every loop in the pipeline, and what bounds it**, in one place to keep an eye on. A run goes round when the check
 * sends a review back, and on our own PR when the fix step's commits have to be reviewed; each needs an end, or two
 * agents that disagree (or keep finding nits in each other's fixes) go round for ever. #153 found the first of these
 * the hard way: every clear finding was fixed, every fix was a commit, every commit was reviewed, and every review
 * found a new nit.
 *
 * | Loop | Bound |
 * | --- | --- |
 * | the fix step's commits back to review | only commits that need it (new work, or a fix for a blocking finding), at most `MAX_REREVIEWS` round; the rest are listed in the review as not re-reviewed, with the command to go again, so a person decides |
 * | the proofread's issues back to judge or narrate | once per head (`proofreadSendBacks`); after that, notes |
 * | anything back to the same step | `MAX_SENDBACKS_PER_STEP` per head since a person last stepped in, then the run stops for one |
 * | the runner's moves in one go | `STEP_IDS.length * 3` (`runner.ts`) |
 */
import { spawnSync } from "node:child_process";
import type { Workspace } from "./artefacts.ts";
import type { ReviewState } from "./state.ts";

/**
 * The commits after the review that no agent will look at: all of them when no round of re-review is due (each was a
 * nit's fix, plan-only, or past the cap), none when one is, since that round reads them. Their files say so in their
 * headers (`filesChangedBy`).
 */
export const notLookedAt = (commits: CommitSinceReview[], rounds: number): string[] =>
  reReviewPlan(commits, rounds).review ? [] : commits.map((commit) => commit.sha);

/**
 * Rounds of re-review the fix step's commits can cause, before they are listed rather than reviewed again. One: it
 * checks the first fixes (the ones for real findings) didn't break anything, and on #153 every round after the first
 * found mostly nits in the last round's fixes. Past it, the reader is asked rather than the run going round.
 */
export const MAX_REREVIEWS = 1;
/** Times the review can be sent back to one step at one head before the run stops for a person. */
export const MAX_SENDBACKS_PER_STEP = 3;

/** A commit since the review last finished, and whether reviewing it is worth a round. */
export interface CommitSinceReview {
  sha: string;
  /** A commit the fix step recorded for one or more findings, or one touching only plan files (bookkeeping). */
  fix: boolean;
  /** It fixed a finding that requests changes: a fix to something that mattered can bring a problem that matters. */
  blocking: boolean;
}

/**
 * The commits between the head last reviewed and `head`, oldest first, each marked from the fix step's outcomes. A
 * commit no outcome names is new work, so it always needs review, unless it touches only plan files.
 */
export function commitsSinceReview(
  work: Workspace,
  clone: string,
  reviewedHead: string | undefined,
  head: string,
): CommitSinceReview[] {
  if (reviewedHead === undefined || reviewedHead === head) return [];
  const listed = spawnSync("git", ["rev-list", "--reverse", `${reviewedHead}..${head}`], {
    cwd: clone,
    encoding: "utf8",
  });
  // Fail closed: when git can't say what came since (the reviewed head isn't in this clone), treat it as new work to
  // review rather than as nothing.
  if (listed.status !== 0 || head === "") return [{ sha: head || reviewedHead, fix: false, blocking: false }];
  const outcomes = work.has("outcomes") ? work.read("outcomes") : {};
  const kinds = new Map(
    work.has("findings") ? work.read("findings").findings.map((finding) => [finding.id, finding.kind]) : [],
  );
  const fixes = Object.entries(outcomes).flatMap(([id, outcome]) =>
    outcome.outcome === "fixed" && outcome.commit
      ? [{ commit: outcome.commit, blocking: kinds.get(id) === "request-changes" }]
      : [],
  );
  // A commit touching only plan files is bookkeeping (an item filed, a status moved), like a nit's fix: filing is
  // meant to cost no round. Unknown files (git can't say) count as work.
  const planOnly = (sha: string) => {
    const changed = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
      cwd: clone,
      encoding: "utf8",
    });
    const files = changed.status === 0 ? changed.stdout.split("\n").filter(Boolean) : [];
    return files.length > 0 && files.every(isPlanFile);
  };
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((sha) => {
      const fixed = fixes.filter((fix) => sha.startsWith(fix.commit) || fix.commit.startsWith(sha));
      return { sha, fix: fixed.length > 0 || planOnly(sha), blocking: fixed.some((fix) => fix.blocking) };
    });
}

/**
 * Each file the given commits touch, with the commits (short shas) that touched it: for a file's header to say it
 * changed after the review and wasn't reviewed again. Empty when git can't say.
 */
export function filesChangedBy(clone: string, shas: string[]): Record<string, string[]> {
  return shas.reduce<Record<string, string[]>>((byFile, sha) => {
    const changed = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
      cwd: clone,
      encoding: "utf8",
    });
    const files = changed.status === 0 ? changed.stdout.split("\n").filter(Boolean) : [];
    return files.reduce((all, file) => ({ ...all, [file]: [...(all[file] ?? []), sha.slice(0, 7)] }), byFile);
  }, {});
}

/** A plan file or one of its side files: `attraverso.yaml` (or a legacy `*.apm.yaml`) and its `.attraverso/` folder. */
export const isPlanFile = (path: string): boolean =>
  /(^|\/)(attraverso\.yaml|[^/]+\.apm\.yaml)$/.test(path) || /(^|\/)\.(attraverso|apm)\//.test(path);

/** Whether any of these commits is worth a round of review: new work, or a fix for a blocking finding. */
export const needsReReview = (commits: CommitSinceReview[]): boolean =>
  commits.some((commit) => !commit.fix || commit.blocking);

/**
 * What to do with the commits since the review, decided once for the check and the review file alike: send them back
 * for review (they need it, and the rounds aren't used up), or list the ones that needed it in the review as not
 * re-reviewed. A fix for a nit is never listed: skipping it is the design, and its commit is shown with what it fixed,
 * so listing it too made a routine run read as one with something left to look at.
 */
export function reReviewPlan(commits: CommitSinceReview[], rounds: number): { review: boolean; listed: string[] } {
  if (needsReReview(commits) && rounds < MAX_REREVIEWS) return { review: true, listed: [] };
  const needed = commits.filter((commit) => !commit.fix || commit.blocking);
  return { review: false, listed: needed.map((commit) => commit.sha.slice(0, 7)) };
}

/** The steps a `back` by hand can go to that ask for another round of review; a `back` to a later step redoes it. */
const ASKS_FOR_REVIEW = new Set(["fetch", "review"]);

/**
 * Rounds of re-review the fix step's commits have caused since the PR last moved on by itself (a push of new work)
 * or a person last asked for one (a `start`, or a `back` by hand to fetch or review): each a send-back marked
 * `unreviewed`. A `back` to judge or narrate only redoes that step, so tidying a heading can't buy another round.
 */
export function reReviewRounds(state: ReviewState): number {
  const since = state.history.findLastIndex(
    (entry) =>
      entry.step === "start" ||
      (entry.reset === true && ASKS_FOR_REVIEW.has(entry.step)) ||
      entry.sentBack?.reason === "moved",
  );
  return state.history.slice(since + 1).filter((entry) => entry.sentBack?.reason === "unreviewed").length;
}

/**
 * Times the review has been sent back to `step` at `head` since a person last stepped in (a `start`, or a `back` by
 * hand): after a stop, their next try gets the full count again, not one go.
 */
export function sendBacksTo(state: ReviewState, step: string, head: string): number {
  const since = state.history.findLastIndex((entry) => entry.reset === true);
  return state.history.slice(since + 1).filter((entry) => entry.sentBack?.to === step && entry.sentBack.head === head)
    .length;
}
