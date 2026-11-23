/**
 * Step 6: `review.json`, put together by code from what the steps before wrote, so no agent copies facts or folds by
 * hand: the PR's facts from `pr.json`, the reading from `narrative.json`, folds from `folds.json`, and each finding
 * placed by what became of it (CHECK-11): fixed ones listed as fixed, a choice as a decision, the rest as comments.
 * A finding about an item already on the plan's Next list is captured and known, so it is only listed as planned
 * (CHECK-12). One the fix step filed for later is planned too, unless it blocks.
 */
import type { Artefact } from "../artefacts.ts";
import type { Block, Decision, ReviewComment } from "../../src/review/schema.ts";

export interface AssembleInput {
  pr: Artefact<"pr">;
  findings: Artefact<"findings">;
  /** Absent on someone else's PR, where nothing is ours to fix. */
  outcomes: Artefact<"outcomes"> | null;
  folds: Artefact<"folds">;
  narrative: Artefact<"narrative">;
  /** Whether a plan item (`project:REF`) is on its project's Next list. */
  onNext: (item: string) => boolean;
  /** Commits after the review that won't be reviewed again, short shas: said in the review, so nothing hides. */
  notReReviewed?: string[];
  /** Each file a commit the review didn't look at again touched, with those commits' short shas. */
  changedSinceReview?: Record<string, string[]>;
  /** When the review was put together (ISO time), for listing reviews newest first. Given, so a test stays fixed. */
  reviewedAt?: string;
}

type Finding = Artefact<"findings">["findings"][number];
type Placed =
  | { as: "planned"; item: string }
  | { as: "fixed"; detail: string; commit?: string }
  | { as: "decision"; decision: Decision }
  | { as: "comment"; comment: ReviewComment };

/** Where one finding goes in the review. */
function place(finding: Finding, outcomes: AssembleInput["outcomes"], onNext: AssembleInput["onNext"]): Placed {
  const { clear, options, fix, item, gap, ...shared } = finding;
  const asDecision = (choices: Decision["options"], body = finding.body): Placed => ({
    as: "decision",
    decision: {
      id: finding.id,
      title: finding.title,
      body,
      path: finding.path,
      match: finding.match,
      options: choices,
    },
  });
  const asComment = {
    as: "comment" as const,
    comment: { ...shared, ...(fix ? { fix } : {}), ...(item ? { item } : {}) },
  };
  const outcome = outcomes?.[finding.id];
  // Known and planned, so out of the way: but never a finding that blocks (the verdict must still see it), and never
  // one the fix step put to the reader as a decision.
  const quiet = finding.kind !== "request-changes" && outcome?.outcome !== "fixed" && outcome?.outcome !== "decision";
  if (item !== undefined && quiet && onNext(item)) return { as: "planned", item };
  if (outcome === undefined) return !clear && options && options.length >= 2 ? asDecision(options) : asComment;
  if (outcome.outcome === "fixed") {
    return { as: "fixed", detail: outcome.detail, ...(outcome.commit ? { commit: outcome.commit } : {}) };
  }
  if (outcome.outcome === "decision") return asDecision(outcome.options, outcome.body ?? finding.body);
  // Filed for later: captured, so listed as planned; a blocking one stays under its line, since putting it off is
  // still the reader's call to see.
  if (outcome.outcome === "filed") {
    if (finding.kind !== "request-changes") return { as: "planned", item: outcome.item };
    return {
      as: "comment",
      comment: {
        ...asComment.comment,
        item: outcome.item,
        body: `${finding.body}\n\nFiled as ${outcome.item}: ${outcome.why}`.trim(),
      },
    };
  }
  // Weighed and left: the reader sees why, rather than a finding that looks unread.
  return {
    as: "comment",
    comment: { ...asComment.comment, body: `${finding.body}\n\nNot fixed: ${outcome.why}`.trim() },
  };
}

export function assemble({
  pr,
  findings,
  outcomes,
  folds,
  narrative,
  onNext,
  notReReviewed = [],
  changedSinceReview = {},
  reviewedAt,
}: AssembleInput): Artefact<"review"> {
  const placed = findings.findings.map((finding) => ({ finding, placed: place(finding, outcomes, onNext) }));
  // Headings from the narrative, folds from `folds.json`; a file the narrative left unheaded still folds, under its
  // fold's name.
  const blocks = Object.fromEntries(
    Object.entries(folds).flatMap(([path, fileFolds]): [string, Block[]][] => {
      const headings = narrative.blocks[path];
      if (headings === undefined && fileFolds.every((entry) => entry.fold === null && !entry.spans?.length)) return [];
      return [
        [
          path,
          fileFolds.map((entry, index) => {
            const heading = headings?.[index] ?? { title: entry.fold ?? "" };
            return {
              ...heading,
              ...(entry.fold === null ? {} : { fold: entry.fold }),
              ...(entry.spans && entry.spans.length > 0 ? { spans: entry.spans } : {}),
            };
          }),
        ],
      ];
    }),
  );
  return {
    pr: {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      head: pr.head,
      base: pr.base,
      commit: pr.headCommit,
      diffHash: pr.diffHash,
      ...(notReReviewed.length > 0 ? { notReReviewed } : {}),
      ...(Object.keys(changedSinceReview).length > 0 ? { changedSinceReview } : {}),
      ...(reviewedAt ? { reviewedAt } : {}),
      files: pr.files,
      added: pr.added,
      removed: pr.removed,
      gist: narrative.gist,
      tryIt: narrative.tryIt,
    },
    verdict: narrative.verdict,
    steps: narrative.steps,
    blocks,
    notForReview: narrative.notForReview,
    // A gap left open is listed with the tests; any other finding sits under its line.
    tests: {
      ...narrative.tests,
      gaps: placed.flatMap(({ finding, placed: where }) =>
        where.as === "comment" && finding.gap
          ? [
              {
                id: finding.id,
                title: finding.title,
                recommendation: finding.recommendation,
                ...(finding.fix ? { fix: finding.fix } : {}),
              },
            ]
          : [],
      ),
    },
    comments: placed.flatMap(({ finding, placed: where }) =>
      where.as === "comment" && !finding.gap ? [where.comment] : [],
    ),
    decisions: placed.flatMap(({ placed: where }) => (where.as === "decision" ? [where.decision] : [])),
    fixed: placed.flatMap(({ finding, placed: where }) =>
      where.as === "fixed"
        ? [{ title: finding.title, detail: where.detail, ...(where.commit ? { commit: where.commit } : {}) }]
        : [],
    ),
    planned: placed.flatMap(({ finding, placed: where }) =>
      where.as === "planned" ? [{ title: finding.title, item: where.item }] : [],
    ),
    names: narrative.names,
    ...(narrative.translation ? { translation: narrative.translation } : {}),
  };
}
