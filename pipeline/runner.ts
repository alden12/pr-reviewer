/**
 * The state machine that walks `pipeline.ts`, apart from the command line (`run.ts`) so it can be tested with stand-in
 * steps. Code steps run here; at an agent step the run hands over to a driver and waits, and `finish` picks it up once
 * the agent has written its files.
 */
import { STEP_IDS, type AgentStep, type Context, type Step, type StepId } from "./pipeline.ts";
import { MAX_SENDBACKS_PER_STEP, sendBacksTo } from "./loops.ts";
import { DONE, following, loadState, logged, saveState, type ReviewState } from "./state.ts";

/**
 * Who runs an agent step. Locally it is the Claude Code session driving the run (the `review-pr` skill), so handing
 * over is printing what to do. A CI run would be a second driver that sends the same prompt to the API with the
 * attraverso tools attached, waits, and calls `finish` itself; nothing else here would change.
 */
export interface AgentDriver {
  /** `brief` is what this run adds to the prompt (the step's own `brief`), `problems` what it was sent back for. */
  handOver(id: StepId, step: AgentStep, context: Context, problems: string[], brief: string[]): void;
}

export interface Runner {
  steps: Record<StepId, Step>;
  driver: AgentDriver;
  contextOf: (state: ReviewState) => Context;
  log: (line: string) => void;
}

/** One move of the machine from `state`: a step skipped, handed over, run on, or sent back. */
async function move(state: ReviewState, runner: Runner): Promise<ReviewState> {
  if (state.at === DONE || state.waiting) return state;
  const id = state.at;
  const step = runner.steps[id];
  const context = runner.contextOf(state);
  if (step.when && !step.when(context)) {
    runner.log(`   ${id}: skipped`);
    return { ...logged(state, id, "skipped"), at: following(id), problems: [] };
  }
  if (step.by === "agent") {
    runner.driver.handOver(id, step, context, state.problems, step.brief?.(context, state) ?? []);
    return { ...logged(state, id, "handed over"), waiting: true };
  }
  const result = await step.run(context);
  if (typeof result === "string") {
    runner.log(`   ${id}: ${result}`);
    return { ...logged(state, id, result), at: following(id), problems: [] };
  }
  // Sent back: to the earliest step named, carrying every problem for it.
  const back = STEP_IDS.find((candidate) => result.some((problem) => problem.back === candidate))!;
  const mine = result.filter((problem) => problem.back === back).map((problem) => problem.problem);
  runner.log(`   ${id}: ${result.length} problems, back to ${back}`);
  result.forEach((problem) => runner.log(`     - ${problem.problem}`));
  // Recorded as a field, at which head and whether the proofread's issues went back, so its send-backs can be counted.
  const proofread = result.some((problem) => problem.proofread && problem.back === back);
  const head = context.work.has("pr") ? context.work.read("pr").headCommit : "";
  const reason = result.find((problem) => problem.back === back && problem.reason)?.reason;
  // The backstop under every other bound (loops.ts): sent back to one step too often at one head, the run stops for a
  // person rather than going round again.
  if (sendBacksTo(state, back, head) >= MAX_SENDBACKS_PER_STEP) {
    const stop = `stopped: sent back to ${back} ${MAX_SENDBACKS_PER_STEP} times at this head; a person needs to look`;
    runner.log(`   ${stop}`);
    return { ...logged(state, id, stop), waiting: true, problems: [stop, ...mine] };
  }
  const note = `back to ${back}: ${mine.length} problems${proofread ? ", from the proofread" : ""}`;
  const sentBack = { to: back, head, proofread, ...(reason ? { reason } : {}) };
  return { ...logged(state, id, note, { sentBack }), at: back, problems: mine };
}

/**
 * Run from where the review is until an agent step (handed over) or the end. Bounded, and says so if the bound is
 * ever hit: every way back lands before an agent step, so an ordinary pass stops at one long before.
 */
export async function advance(dir: string, runner: Runner): Promise<ReviewState> {
  const limit = STEP_IDS.length * 3;
  const final = await Array.from({ length: limit }).reduce<Promise<ReviewState>>(
    async (previous) => move(await previous, runner),
    Promise.resolve(loadState(dir)),
  );
  saveState(dir, final);
  if (final.at !== DONE && !final.waiting)
    runner.log(`Stopped after ${limit} moves at ${final.at}: something is looping`);
  return final;
}

/**
 * The agent step's files are written: validate them against their schemas, then the step's own `verify`. Returns the
 * problems, leaving the step open, or carries on with an empty list.
 */
export async function finish(dir: string, runner: Runner): Promise<string[]> {
  const state = loadState(dir);
  if (state.at === DONE || !state.waiting)
    throw new Error(`the review is not waiting on an agent (it is at ${state.at})`);
  const step = runner.steps[state.at];
  if (step.by !== "agent") {
    throw new Error(`${state.at} is a code step that stopped the run: see status, then go back to a step by hand`);
  }
  const context = runner.contextOf(state);
  const unreadable = step.writes.flatMap((artefact) => {
    try {
      context.work.read(artefact);
      return [];
    } catch (cause) {
      return [cause instanceof Error ? cause.message : String(cause)];
    }
  });
  const problems = unreadable.length > 0 ? unreadable : (step.verify?.(context) ?? []);
  if (problems.length > 0) return problems;
  const reviewedHead = step.recordsHead ? { reviewedHead: context.work.read("pr").headCommit } : {};
  saveState(dir, {
    ...logged(state, state.at, doneNote(context)),
    at: following(state.at),
    waiting: false,
    problems: [],
    ...reviewedHead,
  });
  await advance(dir, runner);
  return [];
}

/** An agent step's history line: done, and at which head, so rounds of a step can be counted per head. */
const doneNote = (context: Context): string =>
  context.work.has("pr") ? `done at ${context.work.read("pr").headCommit.slice(0, 7)}` : "done";
