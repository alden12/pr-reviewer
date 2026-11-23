/**
 * What each step of the pipeline writes, and where: the contracts between steps. **A step is free in how it does its
 * job and fixed only in what it hands on**, so every file a step writes is validated against its schema here before
 * the next step runs, whichever step (code or agent) wrote it.
 *
 * Everything for one review is in one folder, `.attraverso/reviews/<name>/` beside the run's plan (`paths.ts`): the
 * working files below, ignored by git, beside the `diff.json` and `review.json` the app reads, which are committed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isRef } from "attraverso/library";
import { diffSchema } from "../src/diff/parseDiff.ts";
import { fileClassSchema } from "./rules.ts";
import {
  blockSchema,
  optionSchema,
  reviewSchema,
  severitySchema,
  stepSchema,
  translationSchema,
  followNameSchema,
  fixSchema,
  spanSchema,
} from "../src/review/schema.ts";

/** `project:REF`, the ref as core's own ticket model allows it. */
const isItem = (item: string): boolean => {
  const [project = "", ref = "", ...extra] = item.split(":");
  return extra.length === 0 && /^[\w-]+$/.test(project) && isRef(ref);
};

/** The PR's facts, from GitHub and git, never typed (ARCH-4). Written by `fetch`. */
export const prSchema = z.strictObject({
  repo: z.string(),
  /** The local clone the diff came from. */
  clone: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  /** The PR is the reviewer's own and still open, so clear findings are fixed rather than commented on (CHECK-11). */
  mine: z.boolean(),
  base: z.string(),
  head: z.string(),
  /** The merge base and head commits the diff is between. */
  baseCommit: z.string(),
  headCommit: z.string(),
  /** sha256 of `diff.json`, so a review can tell it is still of the diff it was written against. */
  diffHash: z.string(),
  files: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
});

/**
 * One thing the reviewing agent found. `clear` is its call on whether the finding has one right answer (fixed on our
 * own PR) or needs the reader to choose (a decision, with `options`).
 */
export const findingSchema = z.strictObject({
  id: z.string().min(1),
  kind: severitySchema,
  path: z.string(),
  /** Anchors it under the first new line containing this text. */
  match: z.string().min(1),
  title: z.string(),
  body: z.string(),
  recommendation: z.string(),
  clear: z.boolean(),
  options: z.array(optionSchema).optional(),
  fix: fixSchema.optional(),
  /**
   * A path the tests don't cover (CHECK-2), rather than a problem in the code. It goes through the fix step like any
   * finding, and one left open is listed with the tests rather than under a line.
   */
  gap: z.boolean().optional(),
  /** The plan item the finding is about, if one exists (`project:REF`, found with search_plan): CHECK-12. */
  item: z.string().refine(isItem, "an item is project:REF, as pr-reviewer:CHECK-12").optional(),
});

/** Written by `review`: every changed file with what was checked in it, and the findings. */
export const findingsSchema = z.strictObject({
  /** Path to one line on what was looked at: a file folded later was still reviewed (Review pipeline, step 2). */
  files: z.record(z.string(), z.string()),
  findings: z.array(findingSchema),
});

/** What became of each finding on our own PR. Written by `fix`. */
export const outcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("fixed"), detail: z.string(), commit: z.string().optional() }),
  z.strictObject({
    outcome: z.literal("decision"),
    body: z.string().optional(),
    options: z.array(optionSchema).min(2),
  }),
  z.strictObject({ outcome: z.literal("comment"), why: z.string() }),
  // Right, but too big for this PR: filed on the plan rather than fixed now, so a nit never becomes a refactor and its
  // commit never costs a round of review.
  z.strictObject({
    outcome: z.literal("filed"),
    item: z.string().refine(isItem, "an item is project:REF, as pr-reviewer:CHECK-12"),
    why: z.string(),
  }),
]);
export const outcomesSchema = z.record(z.string(), outcomeSchema);

/** One block's fold, with where it came from. Written by `fold`, revised by `judge`. */
export const foldSchema = z.strictObject({
  fold: z.string().nullable(),
  /** `default`, `rule <glob>` or `judge`, and why. */
  source: z.string(),
  /** What the file is, by the repo's rules then the defaults (`rules.ts`), for later steps to go by. */
  class: fileClassSchema.optional(),
  /** A hash of the hunk's lines, so a later run can tell the hunk is unchanged and keep the judge's call on it. */
  hunk: z.string().optional(),
  /** The hunk's first new line number, so a kept call's spans can follow the hunk when it moves. */
  at: z.number().int().optional(),
  /** Runs inside the hunk folded to a summary line: found by code (`spans.ts`), grouped and reworded by `judge`. */
  spans: z.array(spanSchema).optional(),
});
/** Path to one entry per hunk, in order. */
export const foldsSchema = z.record(z.string(), z.array(foldSchema));

/** Everything the narrative step decides: the reading of the PR. Written by `narrate`. */
export const narrativeSchema = z.strictObject({
  gist: z.string(),
  tryIt: z.string(),
  verdict: reviewSchema.shape.verdict,
  steps: z.array(stepSchema).min(1),
  /** Path to one heading per hunk, with its sections; folds and spans come from `folds.json`, so none here. */
  blocks: z.record(z.string(), z.array(blockSchema.omit({ fold: true, spans: true }))),
  notForReview: reviewSchema.shape.notForReview,
  /** The test files and what they cover. Gaps are findings (`gap`), so the review step finds them, not the author. */
  tests: z.strictObject({
    files: z.array(z.string()),
    tested: z.array(z.string()),
  }),
  names: z.record(z.string(), followNameSchema),
  translation: translationSchema.optional(),
});

/**
 * What the proofread step found reading the review as the reader first sees it (`view.md`): each a problem with the
 * reading, and the step whose file is to blame. Empty when it reads right. The check sends each back to its step.
 */
export const proofreadSchema = z.strictObject({
  issues: z.array(
    z.strictObject({
      problem: z.string().min(1),
      back: z.enum(["judge", "narrate", "review"]),
      /** Where in view.md: the file, and the heading or line. */
      where: z.string(),
    }),
  ),
});

/** The working files, by name. The order is the pipeline's. */
export const ARTEFACTS = {
  pr: { file: "pr.json", schema: prSchema },
  diff: { file: "diff.json", schema: diffSchema },
  findings: { file: "findings.json", schema: findingsSchema },
  outcomes: { file: "outcomes.json", schema: outcomesSchema },
  folds: { file: "folds.json", schema: foldsSchema },
  narrative: { file: "narrative.json", schema: narrativeSchema },
  review: { file: "review.json", schema: reviewSchema },
  proofread: { file: "proofread.json", schema: proofreadSchema },
} as const;
export type ArtefactName = keyof typeof ARTEFACTS;
export type Artefact<Name extends ArtefactName> = z.infer<(typeof ARTEFACTS)[Name]["schema"]>;

/** One review's folder and typed access to its files. */
export function workspace(dir: string) {
  const pathOf = (name: ArtefactName) => join(dir, ARTEFACTS[name].file);
  const has = (name: ArtefactName) => existsSync(pathOf(name));
  /** Read and validate; throws naming the file and what is wrong, which is what an agent step needs to hear. */
  const read = <Name extends ArtefactName>(name: Name): Artefact<Name> => {
    const result = ARTEFACTS[name].schema.safeParse(JSON.parse(readFileSync(pathOf(name), "utf8")));
    if (!result.success)
      throw new Error(`${ARTEFACTS[name].file} does not fit its schema: ${z.prettifyError(result.error)}`);
    return result.data as Artefact<Name>;
  };
  const write = <Name extends ArtefactName>(name: Name, value: Artefact<Name>): void =>
    writeFileSync(pathOf(name), `${JSON.stringify(value, null, name === "diff" ? undefined : 2)}\n`);
  return { dir, pathOf, has, read, write };
}
export type Workspace = ReturnType<typeof workspace>;

/** The hash `pr.json` pins: of the diff as written to disk. */
export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
