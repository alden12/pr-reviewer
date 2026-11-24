/**
 * The pipeline's command line (`pr-reviewer`, bin/pr-reviewer). The state machine is `runner.ts`; this wires it to
 * the real steps, the local driver (printing what an agent step needs) and GitHub.
 *
 *   npx @traverso/pr-reviewer start <pr> [--clone <path>] [--name <name>] [--project <key>]
 *
 * `<pr>` is its number, in the repo the run is started in, or `owner/repo#123` or the PR's URL, found among the
 * checkouts under the folder the run is started in (`target.ts`), so a run from a folder above several repos reviews
 * the right one. It is started through bin/pr-reviewer, in the folder holding the plan (`plan.ts`), which supplies the
 * rules and Next lists; the reviewed checkout's own plan, if it has one, isn't read.
 *   npx @traverso/pr-reviewer check <name>             check the agent step's files, without moving on (read-only)
 *   npx @traverso/pr-reviewer done <name>              the agent step's files are written: check them, carry on
 *   npx @traverso/pr-reviewer status <name>
 *   npx @traverso/pr-reviewer back <name> <step>       go back to a step by hand
 *
 * `--clone` overrides the checkout found, `--name` defaults to `<repo>-<pr>`; the review's folder is
 * `.attraverso/reviews/<name>/` beside the plan (`paths.ts`). From source it runs with vite-node, which compiles core's
 * library in; the package runs its build (`dist/pipeline/run.js`) on plain Node.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { ARTEFACTS, workspace } from "./artefacts.ts";
import { pipeline, STEP_IDS, type StepId } from "./pipeline.ts";
import { commitsSinceReview, reReviewRounds } from "./loops.ts";
import { advance, check, finish, type AgentDriver, type Runner } from "./runner.ts";
import { BIN, PACKAGE, PROMPTS, RUNS_BUILT, reviewsOf } from "./paths.ts";
import { planIn } from "./plan.ts";
import { runFrom, startTarget } from "./target.ts";
import { DONE, hasState, loadState, logged, proofreadSendBacks, saveState, type ReviewState } from "./state.ts";

/**
 * The command a hand-over prints for the next move. Installed, it is the package by name and exact version, which runs
 * from any folder and lasts: the path a run's own copy has (`~/.npm/_npx/<hash>/...`) is a cache entry that differs per
 * install, so the MCP server's copy and the session's had different ones. From source it is `bin/pr-reviewer` by its
 * full path, since `yarn workspace` needs this monorepo and a run can start in a folder above it.
 */
const version = (JSON.parse(readFileSync(`${PACKAGE}/package.json`, "utf8")) as { version: string }).version;
const command = (args: string[]) => `${RUNS_BUILT ? `npx -y @traverso/pr-reviewer@${version}` : BIN} ${args.join(" ")}`;

/**
 * Prints what the agent step needs, for the session driving the run to do. Every agent step goes to a new agent, which
 * writes the step's files and may `check` them; the session runs `done`. One actor writing a step's output and then
 * moving the pipeline on looks like signing off its own work, which Claude Code's auto mode blocks (it did, on a judge
 * step at work), so the hand-over says who does which.
 */
const localDriver = (name: string): AgentDriver => ({
  handOver(id, step, context, problems, brief) {
    const files = (names: (keyof typeof ARTEFACTS)[]) => names.map((artefact) => ARTEFACTS[artefact].file).join(", ");
    const lines = [
      `-> ${id}: ${step.does} (agent${step.fresh ? ", fresh: a new agent that did not write the PR" : ", a new agent"})`,
      `   prompt:  ${join(PROMPTS, step.prompt)}`,
      `   folder:  ${context.work.dir}`,
      `   clone:   ${context.clone}`,
      `   reads:   ${[files(step.reads), ...(step.alsoReads ?? [])].join(", ")}`,
      `   writes:  ${files(step.writes)}`,
      ...brief.map((line) => `   ${line}`),
      ...(problems.length > 0 ? ["   sent back to put right:", ...problems.map((problem) => `     - ${problem}`)] : []),
      `   check:   ${command(["check", name])}   # read-only, for the agent that writes the files`,
      `   then:    the session driving the run, not that agent, runs: ${command(["done", name])}`,
    ];
    console.log(lines.join("\n"));
  },
});

/** The PR's head on GitHub now, or null when it cannot be asked (offline). */
const liveHead = (state: ReviewState) => () => {
  try {
    // REST, as in the fetch step: GraphQL (`gh pr view`) is refused in a cloud session.
    const args = ["api", `repos/{owner}/{repo}/pulls/${state.number}`, "-q", ".head.sha"];
    return execFileSync("gh", args, { cwd: state.clone, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const runnerFor = (name: string, dir: string): Runner => ({
  steps: pipeline,
  driver: localDriver(name),
  contextOf: (state) => ({
    work: workspace(dir),
    clone: state.clone,
    ...(state.plan ? { plan: state.plan } : {}),
    number: state.number,
    ...(state.project ? { project: state.project } : {}),
    sinceReview: () => {
      const work = workspace(dir);
      const head = work.has("pr") ? work.read("pr").headCommit : "";
      return {
        commits: commitsSinceReview(work, state.clone, state.reviewedHead, head),
        rounds: reReviewRounds(state),
      };
    },
    proofreadSentBack: workspace(dir).has("pr") ? proofreadSendBacks(state, workspace(dir).read("pr").headCommit) : 0,
    liveHead: liveHead(state),
  }),
  log: (line) => console.log(line),
});

const isStep = (value: string): value is StepId => (STEP_IDS as string[]).includes(value);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { clone: { type: "string" }, name: { type: "string" }, project: { type: "string" } },
  });
  const [verb, target, extra] = positionals;
  // A run's reviews are beside the plan it was started from (`paths.ts`), so every verb runs from that folder.
  const dirOf = (name: string, plan = planIn(runFrom(process.env))) => {
    if (plan === undefined)
      throw new Error("no attraverso plan here: run pr-reviewer from the folder that holds yours");
    return join(reviewsOf(plan), name);
  };
  const ended = (name: string, state: ReviewState) => {
    if (state.at === DONE) console.log(`Done: open the app with ?review=${name}`);
  };

  if (verb === "start" && target !== undefined) {
    const { clone, plan, number } = await startTarget(target, runFrom(process.env), values.clone);
    const name = values.name ?? `${basename(clone)}-${number}`;
    const dir = dirOf(name, plan);
    mkdirSync(dir, { recursive: true });
    const fresh: ReviewState = {
      clone,
      plan,
      number,
      ...(values.project ? { project: values.project } : {}),
      at: "fetch",
      waiting: false,
      problems: [],
      history: [],
    };
    // Starting again keeps what was learned: the history, and the head last reviewed, which the review builds on.
    const earlier = hasState(dir) ? loadState(dir) : null;
    saveState(
      dir,
      earlier === null
        ? fresh
        : {
            ...fresh,
            history: earlier.history,
            ...(earlier.reviewedHead ? { reviewedHead: earlier.reviewedHead } : {}),
          },
    );
    // A start opens a new count of re-review rounds (loops.ts).
    saveState(dir, logged(loadState(dir), "start", "started", { reset: true }));
    console.log(`Reviewing #${number} in ${clone} as ${name}`);
    return ended(name, await advance(dir, runnerFor(name, dir)));
  }
  if (verb === "done" && target !== undefined) {
    const dir = dirOf(target);
    const problems = await finish(dir, runnerFor(target, dir));
    if (problems.length > 0) {
      console.log(`${loadState(dir).at} is not finished:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
      process.exitCode = 1;
    }
    return ended(target, loadState(dir));
  }
  if (verb === "check" && target !== undefined) {
    const dir = dirOf(target);
    const problems = check(dir, runnerFor(target, dir));
    const at = loadState(dir).at;
    console.log(
      problems.length === 0
        ? `${at}: the files check out. Not moved on: the session driving the run runs done.`
        : `${at} is not finished:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    if (problems.length > 0) process.exitCode = 1;
    return;
  }
  if (verb === "status" && target !== undefined) {
    const state = loadState(dirOf(target));
    const waitingOn = pipeline[state.at as StepId]?.by === "agent" ? "an agent" : "a person: it stopped";
    console.log(`${target}: at ${state.at}${state.waiting ? ` (waiting on ${waitingOn})` : ""}`);
    state.history.forEach((entry) => console.log(`  ${entry.at}  ${entry.step}: ${entry.note}`));
    state.problems.forEach((problem) => console.log(`  to put right: ${problem}`));
    return;
  }
  if (verb === "back" && target !== undefined && extra !== undefined && isStep(extra)) {
    const dir = dirOf(target);
    saveState(dir, {
      ...logged(loadState(dir), extra, "back by hand", { reset: true }),
      at: extra,
      waiting: false,
      problems: [],
    });
    return ended(target, await advance(dir, runnerFor(target, dir)));
  }
  console.error(`usage: see the comment at the top of pipeline/run.ts (steps: ${STEP_IDS.join(", ")})`);
  process.exitCode = 1;
}

await main();
