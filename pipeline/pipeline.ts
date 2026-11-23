/**
 * **How a review is made, top to bottom** (the **Review pipeline** context section in the reviewer's plan). Read this
 * file like a CI workflow: each entry is one step, run in order, by code or by an agent, writing the files named.
 *
 * - **Code steps** are functions under `steps/`: the facts (the diff, file classes), presentation (folds) and checks.
 * - **Agent steps** are prompts under `prompts/`, prose, so what a review asks for can change without code. An agent
 *   step needs the reviewed repo's attraverso plan and tools; locally a Claude Code session runs them (the
 *   `review-pr` skill), and a CI run could hand the same prompt to the API (`AgentDriver` in `run.ts`).
 * - **Between steps, only the files are fixed:** each is validated against its schema (`artefacts.ts`) before the
 *   next step runs, plus whatever a step's `verify` adds.
 * - **`check` sends a review back** to the step whose file is wrong, and the run carries on from there.
 *
 * `run.ts` walks this list and records where a review is in `state.json` (`state.ts`).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkReview, findLine, loadReview } from "../src/review/model.ts";
import { renderReview } from "./render.ts";
import { alikeRuns } from "./alike.ts";
import { filesChangedBy, notLookedAt, reReviewPlan } from "./loops.ts";
import type { ArtefactName, Workspace } from "./artefacts.ts";
import { assemble } from "./steps/assemble.ts";
import { checkWorkspace, ownerOf, type Problem, type SinceReview } from "./steps/check.ts";
import { fetchPr } from "./steps/fetch.ts";
import { foldByRules, keepJudged } from "./steps/fold.ts";
import { loadSyntax } from "./syntax.ts";
import { DEFAULT_RULES } from "./rules.ts";
import { nextLists, READER, readingPreferences, repoRules } from "./plan.ts";

export interface Context {
  work: Workspace;
  clone: string;
  /** The run's plan (`plan.ts`), in the folder it was started in; undefined when there is none, for no rules. */
  plan?: string;
  number: number;
  /** The project in the run's plan holding the review rules; its first project when unset. */
  project?: string;
  /**
   * How many times the proofread's issues have sent the review back at the PR's current head. They do so once per
   * head; after that they are left as notes, so a reader-taste disagreement between agents can't loop.
   */
  proofreadSentBack?: number;
  /** The commits since the review last finished (ARCH-5), and the rounds of re-review they've caused (`loops.ts`). */
  sinceReview?: () => SinceReview;
  /** The PR's head on GitHub now, for the pin check; null when it cannot be asked. */
  liveHead: () => string | null;
}

/** What a run remembers from the ones before it (`state.json`), as a step's brief sees it. */
export interface Earlier {
  reviewedHead?: string | undefined;
}

interface StepBase {
  /** What the step is for, in a line: printed as the run goes. */
  does: string;
  /** Runs only when this holds; skipped (and recorded as skipped) otherwise. */
  when?: (context: Context) => boolean;
  writes: ArtefactName[];
}
export interface CodeStep extends StepBase {
  by: "code";
  /** A line on what it did, or the problems that send the review back. */
  run: (context: Context) => Promise<string | Problem[]>;
}
export interface AgentStep extends StepBase {
  by: "agent";
  /** Its prompt, under `prompts/`. */
  prompt: string;
  reads: ArtefactName[];
  /** Files it reads that aren't step outputs with a schema (`view.md`, the review drawn as text). */
  alsoReads?: string[];
  /** Run by an agent that did not write the PR, so it reviews what is there rather than what was meant. */
  fresh?: boolean;
  /** Problems with what it wrote beyond its schema; the step stays open until there are none. */
  verify?: (context: Context) => string[];
  /** Lines added to the hand-over for this run, beyond the prompt: what is different this time. */
  brief?: (context: Context, earlier: Earlier) => string[];
  /** Finishing this step records the PR's head as reviewed (`reviewedHead`), for the next run to start from. */
  recordsHead?: boolean;
}
export type Step = CodeStep | AgentStep;

const isOwnPr = ({ work }: Context) => work.read("pr").mine;

/**
 * The review is whole: every changed file says what was checked in it, every finding not yet fixed sits under a line of
 * the diff, and one left to the reader (not `clear`) has options to choose from. Caught here rather than at the last
 * step.
 */
export const reviewIsWhole = ({ work }: Context): string[] => {
  const diff = work.read("diff");
  const files = Object.fromEntries(diff.map((file) => [file.path, file]));
  const { files: checked, findings } = work.read("findings");
  // A finding already fixed is listed, not anchored, and the fix usually changed its line: a re-review keeps it without
  // its anchor having to survive.
  const outcomes = work.has("outcomes") ? work.read("outcomes") : {};
  return [
    ...diff.filter((file) => checked[file.path] === undefined).map((file) => `${file.path} is not in "files"`),
    ...findings
      .filter((finding) => outcomes[finding.id]?.outcome !== "fixed" && !findLine(files, finding.path, finding.match))
      .map((finding) => `finding "${finding.id}" matches no line in ${finding.path}`),
    ...findings
      .filter((finding) => !finding.clear && (finding.options?.length ?? 0) < 2)
      .map((finding) => `finding "${finding.id}" is not clear but has fewer than two options`),
  ];
};

/** On our own PR every finding has an outcome: fixed, put to the reader, or left as a comment. */
const everyFindingDecided = ({ work }: Context): string[] => {
  const outcomes = work.read("outcomes");
  return work
    .read("findings")
    .findings.filter((finding) => outcomes[finding.id] === undefined)
    .map((finding) => `finding "${finding.id}" has no outcome`);
};

/** Folds line up with the diff: one per hunk. */
const foldsFit = ({ work }: Context): string[] => {
  const folds = work.read("folds");
  return work
    .read("diff")
    .filter((file) => folds[file.path]?.length !== file.hunks.length)
    .map((file) => `${file.path} has ${folds[file.path]?.length ?? 0} folds for ${file.hunks.length} hunks`);
};

/**
 * One heading per hunk for every file the narrative heads, each with a title. Assemble fills a missing one with an
 * empty title, so a short list (a commit since narrate added a hunk) would otherwise slide the headings onto the wrong
 * hunks without the review's own count check seeing it.
 */
export const headingsFit = ({ work }: Context): string[] => {
  const { blocks } = work.read("narrative");
  const files = Object.fromEntries(work.read("diff").map((file) => [file.path, file]));
  return Object.entries(blocks).flatMap(([path, headings]) => {
    const hunks = files[path]?.hunks.length;
    if (hunks === undefined) return [`${path} has headings but is not in the diff`];
    const empty = headings.flatMap((heading, index) =>
      heading.title.trim() === "" ? [`${path} block ${index + 1} has no title`] : [],
    );
    return headings.length === hunks ? empty : [`${path} has ${headings.length} headings for ${hunks} hunks`, ...empty];
  });
};

/** Whether `item` (`project:REF`) is on its project's Next list. */
const onNext = (next: Record<string, string[]>, item: string): boolean => {
  const [key = "", ref = ""] = item.split(":");
  return (next[key] ?? []).includes(ref);
};

/**
 * What the review step builds on (ARCH-5): the head it last finished at. The commits since it, when they are only
 * the PR's own; a full review when the branch was rewritten (a force push, a rebase) or a merge came in since (a
 * diff across a merge holds everything the base brought, none of it the PR's). At the same head, the earlier review
 * stands and is only checked.
 */
export function sinceLastReview({ clone, work }: Context, { reviewedHead: reviewed }: Earlier): string[] {
  const head = work.read("pr").headCommit;
  if (reviewed === undefined || !work.has("findings")) return [];
  const short = reviewed.slice(0, 7);
  if (reviewed === head) {
    return [
      `same:    reviewed at this head (${short}) already: findings.json stands; check it fits and add what's missing`,
    ];
  }
  const git = (args: string[]) => spawnSync("git", args, { cwd: clone, encoding: "utf8" });
  if (git(["merge-base", "--is-ancestor", reviewed, head]).status !== 0) {
    return [`full review: the branch was rewritten since it was reviewed at ${short}`];
  }
  if (git(["rev-list", "--merges", `${reviewed}..${head}`]).stdout.trim() !== "") {
    return [`full review: a merge came in since it was reviewed at ${short}, so a diff from there isn't the PR's own`];
  }
  return [
    `since:   reviewed before at ${short}: review only git diff ${short} ${head.slice(0, 7)},`,
    '         building on findings.json (see the prompt\'s "An earlier review")',
  ];
}

/**
 * The judge's hand-over lists the near-duplicate candidates code found (FLOW-11), in what still shows: each a run of
 * chunks shaped alike. Code only proposes; the judge decides which become a `repeat` span.
 */
export function alikeBrief({ work }: Context): string[] {
  const folds = work.read("folds");
  const found = work.read("diff").flatMap((file) =>
    file.hunks.flatMap((hunk, hunkIndex) => {
      const entry = folds[file.path]?.[hunkIndex];
      // Code a reader reads, by the class the fold step gave it (so the repo's own rules count): not tests, folded in
      // their group, nor stylesheets and markup.
      const readable = entry?.class === "code" && !/\.(css|scss|less|html)$/.test(file.path);
      if (entry === undefined || entry.fold !== null || !readable) return [];
      const hidden = (number: number) => (entry.spans ?? []).some((span) => number >= span.from && number <= span.to);
      return alikeRuns(hunk, hidden).map(
        (run) =>
          `           ${file.path} ${run.from}-${run.to}: ${run.count} chunks alike, from \`${run.first.slice(0, 60)}\``,
      );
    }),
  );
  return found.length === 0
    ? []
    : ["alike:   near-duplicate candidates, for you to fold as repeats or leave:", ...found];
}

const fetchStep = async ({ work, clone, number }: Context) => fetchPr(work, clone, number, await loadSyntax());

export const pipeline = {
  fetch: {
    by: "code",
    does: "Fetch the PR's facts and its whole diff",
    writes: ["pr", "diff"],
    run: fetchStep,
  },
  review: {
    by: "agent",
    does: "Review every changed file with the repo's context",
    prompt: "review.md",
    fresh: true,
    reads: ["pr", "diff"],
    writes: ["findings"],
    verify: reviewIsWhole,
    brief: sinceLastReview,
    recordsHead: true,
  },
  fix: {
    by: "agent",
    does: "Fix what has a clear answer; put the rest to the reader",
    prompt: "fix.md",
    when: isOwnPr,
    reads: ["pr", "diff", "findings"],
    writes: ["outcomes"],
    verify: everyFindingDecided,
  },
  refetch: {
    by: "code",
    does: "Fetch the diff again, so the review is of the final head",
    writes: ["pr", "diff"],
    run: fetchStep,
  },
  fold: {
    by: "code",
    does: "Fold by the repo's rules, then the defaults; summarise imports, types and long objects",
    writes: ["folds"],
    run: async ({ work, clone, plan, project }) => {
      const { rules, from } = plan === undefined ? { rules: [], from: "no plan" } : await repoRules(plan, project);
      const preferences = await readingPreferences(READER.planFile, READER.project);
      const head = work.read("pr").headCommit;
      const sourceOf = (path: string) => {
        const shown = spawnSync("git", ["show", `${head}:${path}`], {
          cwd: clone,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });
        return shown.status === 0 ? shown.stdout : undefined;
      };
      const syntax = await loadSyntax();
      const fresh = foldByRules(work.read("diff"), [...rules, ...DEFAULT_RULES], preferences, sourceOf, syntax);
      const folds = work.has("folds") ? keepJudged(fresh, work.read("folds")) : fresh;
      work.write("folds", folds);
      const entries = Object.values(folds).flat();
      const folded = entries.filter((entry) => entry.fold !== null).length;
      const spans = entries.reduce((sum, entry) => sum + (entry.spans?.length ?? 0), 0);
      return `${folded} blocks folded, ${spans} spans (${rules.length} repo rules, from ${from})`;
    },
  },
  judge: {
    by: "agent",
    brief: alikeBrief,
    does: "Check the folds both ways, and teach the repo's rules what was learned",
    prompt: "judge.md",
    reads: ["pr", "diff", "findings", "folds"],
    writes: ["folds"],
    verify: foldsFit,
  },
  narrate: {
    by: "agent",
    does: "Write the reading: gist, steps in reading order, each block's title and why",
    prompt: "narrate.md",
    reads: ["pr", "diff", "findings", "outcomes", "folds"],
    writes: ["narrative"],
    verify: headingsFit,
  },
  assemble: {
    by: "code",
    does: "Put review.json together from the files above",
    writes: ["review"],
    run: async ({ work, clone, plan, sinceReview }) => {
      const outcomes = work.has("outcomes") && work.read("pr").mine ? work.read("outcomes") : null;
      const findings = work.read("findings");
      const keys = findings.findings.flatMap((finding) => (finding.item ? [finding.item.split(":")[0]!] : []));
      const next = plan === undefined ? {} : await nextLists(plan, keys);
      const since = sinceReview?.();
      work.write(
        "review",
        assemble({
          pr: work.read("pr"),
          findings,
          outcomes,
          folds: work.read("folds"),
          narrative: work.read("narrative"),
          onNext: (item) => onNext(next, item),
          // Commits after the review that needed reviewing again and won't be (past the cap), said in the review.
          notReReviewed: since ? reReviewPlan(since.commits, since.rounds).listed : [],
          // And every file a commit the review didn't look at again touched (a nit's fix, a plan-only commit, one past
          // the cap), for its header to say so: code no agent read is never shown as if one had.
          changedSinceReview: filesChangedBy(clone, since ? notLookedAt(since.commits, since.rounds) : []),
          reviewedAt: new Date().toISOString(),
        }),
      );
      return "review.json written";
    },
  },
  render: {
    by: "code",
    does: "Draw the review as the reader first sees it, as text",
    writes: [],
    run: async ({ work }): Promise<string | Problem[]> => {
      // A review that doesn't fit its diff can't be drawn: send it back as the check would, rather than throw.
      const diff = work.read("diff");
      const misfits = checkReview(work.read("review"), Object.fromEntries(diff.map((file) => [file.path, file])));
      if (misfits.length > 0) return misfits.map((problem) => ({ problem, back: ownerOf(problem) }));
      writeFileSync(join(work.dir, "view.md"), renderReview(loadReview(diff, work.read("review"))));
      return "view.md written";
    },
  },
  proofread: {
    by: "agent",
    does: "Read the review as the reader first sees it, against the reader's preferences and the repo's rules",
    prompt: "proofread.md",
    fresh: true,
    reads: ["review"],
    alsoReads: ["view.md"],
    writes: ["proofread"],
  },
  check: {
    by: "code",
    does: "Check the review fits the diff, covers every file, and is of the PR's head",
    writes: [],
    run: async (context) => {
      const all = checkWorkspace(context.work, context.liveHead(), context.sinceReview?.());
      const settled = (context.proofreadSentBack ?? 0) >= 1;
      const problems = settled ? all.filter((problem) => !problem.proofread) : all;
      if (problems.length > 0) return problems;
      // Left after a round of send-backs: said in full, so they reach the run's log and history, not only a count.
      const notes = all.filter((problem) => problem.proofread).map((problem) => problem.problem);
      if (notes.length === 0) return "the review fits its PR";
      const noun = notes.length === 1 ? "note" : "notes";
      return [`the review fits its PR; proofread ${noun} left after a round of send-backs:`, ...notes].join("\n  - ");
    },
  },
} satisfies Record<string, Step>;

export type StepId = keyof typeof pipeline;
/** The steps in the order they run. */
export const STEP_IDS = Object.keys(pipeline) as StepId[];
export const stepOf = (id: StepId): Step => pipeline[id];
