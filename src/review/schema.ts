import { z } from "zod";

/**
 * A review's annotations: everything the tool adds on top of the diff (reviews/<name>/review.json). Assembled by the
 * pipeline (`pipeline/pipeline.ts`) from each step's output; a review committed by hand before the pipeline existed predates it.
 */

/** A one-click fix: a commit to the PR's branch, or a follow-up filed instead of growing the PR (CHECK-10). */
const commitFixSchema = z.strictObject({
  kind: z.literal("commit"),
  label: z.string(),
  file: z.string(),
  message: z.string(),
  /** The change, as diff lines: sign, line number (null where unknown, as for a new test), text. */
  patch: z.array(z.tuple([z.enum(["+", "-", " "]), z.number().int().nullable(), z.string()])),
});
const followUpFixSchema = z.strictObject({
  kind: z.literal("follow-up"),
  label: z.string(),
  title: z.string(),
  draft: z.string(),
});
export const fixSchema = z.discriminatedUnion("kind", [commitFixSchema, followUpFixSchema]);

/** What a finding asks for (CHECK-7): a nit to take or leave, a question, or a change that blocks. */
export const severitySchema = z.enum(["nit", "question", "request-changes"]);

/** Shared by review comments and test gaps: what's wrong, what to do, and the fix. */
const findingFields = {
  id: z.string().min(1),
  title: z.string(),
  recommendation: z.string(),
  /** A one-click fix, when there is one to offer. */
  fix: fixSchema.optional(),
};

export const commentSchema = z.strictObject({
  ...findingFields,
  kind: severitySchema,
  path: z.string(),
  /** Anchors the comment under the first new line containing this text. */
  match: z.string().min(1),
  body: z.string(),
  /** The plan item it is about but which isn't on Next (`project:REF`): offered as "Add to Next" (CHECK-12). */
  item: z.string().optional(),
});

export const testGapSchema = z.strictObject(findingFields);

/** A heading at a new line inside a block. */
export const sectionSchema = z.strictObject({
  line: z.number().int(),
  title: z.string(),
  why: z.string().optional(),
});

/**
 * A one-line hint above a new line, like a code comment the review writes: what a short block or a dense line is
 * doing, where it isn't worth a section of its own. Shown with the code, so never above a folded line.
 */
export const hintSchema = z.strictObject({
  line: z.number().int(),
  text: z.string().min(1).max(100),
});

/**
 * New lines `from` to `to` (inclusive) folded to one line saying what they are, like `interface Context: work, clone,
 * number and 2 more`. Removed lines between them fold with them. Never over a line holding a finding or decision.
 */
export const spanSchema = z.strictObject({
  from: z.number().int(),
  to: z.number().int(),
  /** What kind of thing it is: `imports`, `types`, `object`, `repeat`, or the review's own word. */
  kind: z.string(),
  summary: z.string(),
});

/**
 * A block is one git hunk. Folded blocks show as one greyed line naming their kind (FLOW-4). `fold` is decided by the
 * pipeline's fold and judge steps (the repo's rules, then judgement), so the app applies it and knows no rules itself.
 */
export const blockSchema = z.strictObject({
  title: z.string(),
  why: z.string().optional(),
  fold: z.string().optional(),
  /**
   * Code comments in the block worth reading as explanations, each named by its first line's new line
   * number. Every comment reads as prose; these are drawn out as the ones that explain the change.
   */
  explains: z.array(z.number().int()).optional(),
  /**
   * Storytelling headings inside the block (FLOW-12): one per function or part, at the new line it starts on, so
   * wherever the eye lands there is a line saying what it is for. The block's own title summarises the hunk.
   */
  sections: z.array(sectionSchema).optional(),
  /** Short hints above a line, lighter than a section: for what a few lines or one dense line are doing. */
  hints: z.array(hintSchema).optional(),
  /** Runs of lines folded to one summary line: types, long object literals, near-duplicates (FLOW-4, FLOW-11). */
  spans: z.array(spanSchema).optional(),
});

/**
 * Something the author fixed while reviewing its own PR: a finding with a clear direction is fixed rather than asked
 * about, and listed here so nothing changes unseen.
 */
export const fixedSchema = z.strictObject({
  title: z.string(),
  detail: z.string().optional(),
  /** The commit that fixed it. */
  commit: z.string().optional(),
});

/** One way a decision could go. */
export const optionSchema = z.strictObject({
  label: z.string(),
  detail: z.string(),
  recommended: z.boolean().optional(),
});

/**
 * A question only the reader can settle, with the ways it could go. Anchored under a line like a comment (`path` and
 * `match`), or, without them, shown at the top.
 */
export const decisionSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  path: z.string().optional(),
  match: z.string().min(1).optional(),
  options: z.array(optionSchema).min(2),
});

export const stepSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  /** A short name for the file tree; the title up to its colon if left out. */
  short: z.string().optional(),
  files: z.array(z.string()).min(1),
});

/** A name the reader can click to follow (FLOW-9). Occurrences are found in the diff itself. */
export const followNameSchema = z.strictObject({
  /** What the name is, shown beside it in the popover. */
  what: z.string().optional(),
  /** List every place by step, to trace a value through the layers, rather than definition then uses. */
  trace: z.boolean().optional(),
  /** Where it's defined when the PR doesn't touch the definition. */
  outside: z.string().optional(),
});

/** Code in a less familiar language, read in a familiar one, line by line under the real code (FLOW-8). */
export const translationSchema = z.strictObject({
  /** The language shown, e.g. "TypeScript". */
  into: z.string(),
  /** File path, then new line number, then the line in `into`. */
  lines: z.record(z.string(), z.record(z.string(), z.string())),
});

export const reviewSchema = z.strictObject({
  pr: z.strictObject({
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    head: z.string(),
    base: z.string(),
    /** The head commit reviewed, and a hash of the diff fetched at it (ARCH-4): a review of an older push is stale. */
    commit: z.string().optional(),
    diffHash: z.string().optional(),
    /** Commits after the review that needed reviewing again and weren't, past the cap on re-review rounds. Never a nit's fix. */
    notReReviewed: z.array(z.string()).optional(),
    /** Each file changed after the review by a commit it didn't look at again, with those commits: shown on its header. */
    changedSinceReview: z.record(z.string(), z.array(z.string())).optional(),
    /** When the pipeline put the review together (ISO time): the lists of reviews put the newest first. */
    reviewedAt: z.string().optional(),
    /** The PR's own totals, counted from the diff by the pipeline. */
    files: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    gist: z.string(),
    tryIt: z.string(),
  }),
  verdict: z.enum(["approve", "comment", "request-changes"]),
  steps: z.array(stepSchema).min(1),
  blocks: z.record(z.string(), z.array(blockSchema)),
  notForReview: z.array(z.strictObject({ path: z.string(), why: z.string() })),
  tests: z.strictObject({
    files: z.array(z.string()),
    tested: z.array(z.string()),
    gaps: z.array(testGapSchema),
  }),
  comments: z.array(commentSchema),
  decisions: z.array(decisionSchema).default([]),
  fixed: z.array(fixedSchema).default([]),
  /** Findings already on the plan's Next list: captured and known, so out of the way (CHECK-12). */
  planned: z.array(z.strictObject({ title: z.string(), item: z.string() })).default([]),
  // Identifiers only: a name is matched in the code and written into the page's markup, so nothing else may be one.
  names: z.record(z.string().regex(/^[\w$.]+$/, "a followable name is an identifier"), followNameSchema),
  translation: translationSchema.optional(),
});

export type Fix = z.infer<typeof fixSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type ReviewComment = z.infer<typeof commentSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type DecisionOption = z.infer<typeof optionSchema>;
export type TestGap = z.infer<typeof testGapSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Hint = z.infer<typeof hintSchema>;
export type Span = z.infer<typeof spanSchema>;
export type Step = z.infer<typeof stepSchema>;
export type FollowName = z.infer<typeof followNameSchema>;
export type ReviewAnnotations = z.infer<typeof reviewSchema>;
