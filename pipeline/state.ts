/**
 * Where one review is in the pipeline, kept in its folder as `state.json`, so a run survives the session that started
 * it: the step it is at, whether that step was handed to an agent, why it is there when `check` sent it back, and a
 * line per step run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { STEP_IDS, type StepId } from "./pipeline.ts";

export const DONE = "done";

export const stateSchema = z.strictObject({
  clone: z.string(),
  /**
   * The plan in the folder the run was started in: its rules, its Next lists. Optional only so a run started before
   * there was one still loads, with no rules or Next lists until it is started again.
   */
  plan: z.string().optional(),
  number: z.number().int(),
  project: z.string().optional(),
  at: z.enum([DONE, ...STEP_IDS]),
  /** The step at `at` is an agent's and was handed over: the run waits for `review done`. */
  waiting: z.boolean(),
  /** What the step at `at` has to put right, when `check` sent the review back to it. */
  problems: z.array(z.string()),
  history: z.array(
    z.strictObject({
      step: z.string(),
      at: z.string(),
      note: z.string(),
      /**
       * When the step sent the review back: to which step, at which head, whether the proofread's issues were why, and
       * the reason when it bounds a loop (`loops.ts`): new commits to review, or the PR moving on by itself.
       */
      sentBack: z
        .strictObject({
          to: z.string().optional(),
          head: z.string(),
          proofread: z.boolean(),
          reason: z.enum(["unreviewed", "moved"]).optional(),
        })
        .optional(),
      /** A person stepped in here (a `start`, or a `back` by hand): the backstop's count starts again after it. */
      reset: z.literal(true).optional(),
    }),
  ),
  /**
   * The head the review step last finished at (ARCH-5): a later run reviews only the commits since it, building on the
   * earlier findings, unless the branch was rewritten.
   */
  reviewedHead: z.string().optional(),
});
export type ReviewState = z.infer<typeof stateSchema>;

const fileOf = (dir: string) => join(dir, "state.json");
export const hasState = (dir: string) => existsSync(fileOf(dir));
export const loadState = (dir: string): ReviewState => stateSchema.parse(JSON.parse(readFileSync(fileOf(dir), "utf8")));
export const saveState = (dir: string, state: ReviewState): void =>
  writeFileSync(fileOf(dir), `${JSON.stringify(state, null, 2)}\n`);

/** The step after `id` in the list, or done after the last. */
export const following = (id: StepId): StepId | typeof DONE => STEP_IDS[STEP_IDS.indexOf(id) + 1] ?? DONE;

/** `state` with a step's line added. */
export const logged = (
  state: ReviewState,
  step: string,
  note: string,
  extra: Pick<ReviewState["history"][number], "sentBack" | "reset"> = {},
): ReviewState => ({
  ...state,
  history: [...state.history, { step, at: new Date().toISOString(), note, ...extra }],
});

/**
 * How many times the proofread's issues sent the review back at `head`. Counted from send-backs (a structured field,
 * not the log's wording), not proofread runs, since the check also sends a review back for its own reasons; and per
 * head, so only a new commit starts again.
 */
export const proofreadSendBacks = (state: ReviewState, head: string): number =>
  state.history.filter((entry) => entry.sentBack?.proofread === true && entry.sentBack.head === head).length;
