/**
 * Step 7: whether the review can be trusted to show the PR. Every problem names the step whose output is wrong, and
 * the runner sends the review back there; going back means correcting that step's file, not redoing its work.
 *
 * - **Fit** (`checkReview`, the app's own load check): steps, block headings and anchors line up with the diff.
 * - **Coverage:** every changed file was reviewed (step 2) and placed (a step, tests, or not-for-review).
 * - **Pin:** the review is of the PR's head as it is now, and `diff.json` is the one fetched there (ARCH-4).
 * - **Signposts:** no block shows more than `LONG_BLOCK` lines in a row without a heading over them, since with comments
 *   hidden there is nothing else to steer by.
 * - **Proofread:** what the proofread step found reading the review as the reader first sees it.
 */
import { readFileSync } from "node:fs";
import { checkReview, foldedRuns, foldReason, loadReview, type Review } from "../../src/review/model.ts";
import { commentMarks } from "../../src/review/comments.ts";
import { hashOf, type Workspace } from "../artefacts.ts";
import { MAX_REREVIEWS, reReviewPlan, type CommitSinceReview } from "../loops.ts";
import type { StepId } from "../pipeline.ts";

export interface Problem {
  problem: string;
  /** The step to go back to. */
  back: StepId;
  /** From the proofread: a reading, not a fault, so it sends the review back only once. */
  proofread?: boolean;
  /** Why, when it bounds a loop (`loops.ts`): commits to review, or the PR moving on by itself. */
  reason?: "unreviewed" | "moved";
}

/** The commits since the review last finished, and how many rounds of re-review they have already caused. */
export interface SinceReview {
  commits: CommitSinceReview[];
  rounds: number;
}

/**
 * Lines a block can show in a row with no heading over them. Alden, 2026-11-22: a block "maybe 10-20 lines long", kept
 * clear and focussed by short storytelling headings, one per part, rather than one heading anywhere excusing the rest.
 * The narrate prompt aims for about 10; past this the check sends it back.
 */
export const LONG_BLOCK = 20;

/**
 * The longest run of code each block shows with no heading over it (the block's title starts one, each section another),
 * as problems for the narrative when past `LONG_BLOCK`. Counted: shown new and unchanged lines, not blank ones, not
 * folded ones, and not comments where comments are hidden.
 */
export function unsignposted(review: Review): Problem[] {
  // Only files read in a step: tests are folded into their own group, and their names say what each case is.
  const read = new Set(review.annotations.steps.flatMap((step) => step.files));
  return Object.entries(review.files).flatMap(([path, file]) =>
    file.hunks.flatMap((hunk, hunkIndex) => {
      if (!read.has(path) || foldReason(review, path, hunkIndex) !== null) return [];
      const block = review.annotations.blocks[path]?.[hunkIndex];
      const headings = new Set((block?.sections ?? []).map((section) => section.line));
      const runs = foldedRuns(review, path, hunkIndex);
      const isComment = commentMarks(hunk, path);
      const counts = ([sign, , , text]: (typeof hunk.lines)[number], index: number) =>
        sign !== "-" &&
        text.trim() !== "" &&
        !isComment(index) &&
        !runs.some((run) => index >= run.from && index < run.to);
      // Walk the block: a section's line starts a new stretch, and the longest stretch is kept with where it began.
      const { longest } = hunk.lines.reduce(
        (walk, line, index) => {
          const newNumber = line[2];
          const fresh = newNumber !== null && headings.has(newNumber);
          const current = fresh ? { length: 0, from: newNumber } : walk.current;
          const from = current.from ?? newNumber;
          const grown = counts(line, index) ? { length: current.length + 1, from } : { ...current, from };
          return { current: grown, longest: grown.length > walk.longest.length ? grown : walk.longest };
        },
        {
          current: { length: 0, from: null as number | null },
          longest: { length: 0, from: null as number | null },
        },
      );
      return longest.length > LONG_BLOCK
        ? [
            {
              problem: `${path} block ${hunkIndex + 1} shows ${longest.length} lines in a row with no heading, from line ${longest.from}: give each part a short storytelling heading (about 10 lines each)`,
              back: "narrate" as const,
            },
          ]
        : [];
    }),
  );
}

/** Which step's file a `checkReview` message is about. Anchors come from findings; the rest is the narrative's. */
export const ownerOf = (message: string): StepId => (/^(comment|decision) "/.test(message) ? "review" : "narrate");

/**
 * `liveHead` is the PR's head on GitHub now, or null when it could not be asked (offline). `since` is what happened
 * after the review last finished: commits that need reviewing (new work, or a fix for a blocking finding) go back to
 * the review step, for at most `MAX_REREVIEWS` rounds; the rest, and any past the cap, are listed in the review as
 * not re-reviewed (`loops.ts`).
 */
export function checkWorkspace(
  work: Workspace,
  liveHead: string | null,
  since: SinceReview = { commits: [], rounds: 0 },
): Problem[] {
  const pr = work.read("pr");
  const diff = work.read("diff");
  const review = work.read("review");
  const findings = work.read("findings");
  const files = Object.fromEntries(diff.map((file) => [file.path, file]));

  const fit = checkReview(review, files).map((problem) => ({ problem, back: ownerOf(problem) }));
  const unreviewed = diff
    .filter((file) => findings.files[file.path] === undefined)
    .map((file) => ({
      problem: `${file.path} is changed but findings.json says nothing was checked in it`,
      back: "review" as const,
    }));
  const placed = new Set([...review.steps.flatMap((step) => step.files), ...review.tests.files]);
  const unplacedButNoted = review.notForReview
    .filter((entry) => placed.has(entry.path))
    .map((entry) => ({ problem: `${entry.path} is both in the review and not for review`, back: "narrate" as const }));
  const unreviewedCommits = (
    reReviewPlan(since.commits, since.rounds).review
      ? [
          {
            problem: `${since.commits.length} commits since the review need reviewing (round ${since.rounds + 1} of ${MAX_REREVIEWS})`,
            back: "review" as const,
            reason: "unreviewed" as const,
          },
        ]
      : []
  ) satisfies Problem[];
  const pin = [
    ...(liveHead === null || liveHead === pr.headCommit
      ? []
      : [
          {
            problem: `the PR has moved on to ${liveHead} since it was fetched at ${pr.headCommit}`,
            // New commits nobody reviewed: back to the start, so the review step sees them (ARCH-5 makes it cheaper).
            back: "fetch" as const,
            reason: "moved" as const,
          },
        ]),
    ...(review.pr.commit === pr.headCommit
      ? []
      : [
          {
            problem: `the review is of ${review.pr.commit ?? "no commit"} but the PR's head is ${pr.headCommit}`,
            back: "refetch" as const,
          },
        ]),
    ...(hashOf(readFileSync(work.pathOf("diff"), "utf8")) === pr.diffHash
      ? []
      : [
          {
            problem: "diff.json is not the diff fetched at the head (edited, or fetched since)",
            back: "refetch" as const,
          },
        ]),
  ];
  // What the proofread saw in the review as the reader first sees it, each back to the step that made it.
  const proofread = work.has("proofread")
    ? work
        .read("proofread")
        .issues.map((issue) => ({ problem: `${issue.where}: ${issue.problem}`, back: issue.back, proofread: true }))
    : [];
  // Only once the review fits its diff, since drawing it needs that.
  const signposts = fit.length === 0 ? unsignposted(loadReview(diff, review)) : [];
  return [...pin, ...unreviewedCommits, ...unreviewed, ...fit, ...unplacedButNoted, ...signposts, ...proofread];
}
