import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashOf, workspace, type Artefact } from "../pipeline/artefacts.ts";
import {
  pipeline,
  alikeBrief,
  reviewIsWhole,
  headingsFit,
  STEP_IDS,
  type AgentStep,
  type Context,
  type Step,
  type StepId,
} from "../pipeline/pipeline.ts";
import { advance, check, finish, type Runner } from "../pipeline/runner.ts";
import {
  commitsSinceReview,
  filesChangedBy,
  isPlanFile,
  MAX_REREVIEWS,
  notLookedAt,
  needsReReview,
  reReviewPlan,
  reReviewRounds,
  sendBacksTo,
} from "../pipeline/loops.ts";
import { rulesIn } from "../pipeline/plan.ts";
import { classify, DEFAULT_RULES, globToRegExp } from "../pipeline/rules.ts";
import { following, loadState, proofreadSendBacks, saveState, type ReviewState } from "../pipeline/state.ts";
import { assemble } from "../pipeline/steps/assemble.ts";
import { checkWorkspace, LONG_BLOCK, unsignposted } from "../pipeline/steps/check.ts";
import { loadReview } from "../src/review/model.ts";
import { foldByRules } from "../pipeline/steps/fold.ts";
import { baseOf, isMine } from "../pipeline/steps/fetch.ts";
import type { DiffFile } from "../src/diff/parseDiff.ts";

const added = (path: string, count: number, removed = 0): DiffFile => ({
  path,
  added: count,
  removed,
  hunks: [
    {
      context: "",
      lines: Array.from({ length: count }, (_, index): DiffFile["hunks"][number]["lines"][number] => [
        "+",
        null,
        index + 1,
        `line ${index}`,
      ]),
    },
  ],
});

describe("globs", () => {
  it("matches within a folder with *, across folders with **, and ** may match no folder", () => {
    expect(globToRegExp("**/yarn.lock").test("yarn.lock")).toBe(true);
    expect(globToRegExp("**/yarn.lock").test("packages/core/yarn.lock")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("classify", () => {
  it("takes the first rule that matches, the repo's before the defaults", () => {
    const repo = [{ match: "**/attraverso.yaml", class: "generated" as const }];
    expect(classify("packages/x/attraverso.yaml", [...repo, ...DEFAULT_RULES]).class).toBe("generated");
    expect(classify("config.yaml", DEFAULT_RULES).class).toBe("data");
    expect(classify("src/a.test.ts", DEFAULT_RULES).class).toBe("test");
    expect(classify("src/a.ts", DEFAULT_RULES)).toEqual({ class: "code", rule: null });
    expect(classify("tools/build.py", DEFAULT_RULES).class).toBe("code");
    expect(classify("src/ui/styles.css", DEFAULT_RULES).class).toBe("code");
    expect(classify(".env.example", DEFAULT_RULES).class).toBe("config");
  });
});

describe("foldByRules", () => {
  it("folds generated files always, big data, long new docs, and never code", () => {
    const folds = foldByRules(
      [
        added("yarn.lock", 3, 1),
        added("package.json", 6, 1),
        added("fixtures/big.json", 60, 1),
        added("GUIDE.md", 30),
        added("short.md", 5),
        added("src/feature.ts", 300),
      ],
      DEFAULT_RULES,
    );
    const first = (path: string) => folds[path]?.[0]?.fold;
    expect(first("yarn.lock")).toBe("generated");
    expect(first("package.json")).toBeNull();
    expect(first("fixtures/big.json")).toBe("data");
    expect(first("GUIDE.md")).toBe("new file");
    expect(first("short.md")).toBeNull();
    expect(first("src/feature.ts")).toBeNull();
  });

  it("lets a rule fold or show whatever its class would do, and says which rule", () => {
    const folds = foldByRules(
      [added("small.json", 3, 1), added("fixtures/huge.json", 80, 1)],
      [
        { match: "small.json", class: "data", fold: "always", why: "settings nobody reads" },
        { match: "fixtures/**", class: "data", fold: "never" },
        ...DEFAULT_RULES,
      ],
    );
    expect(folds["small.json"]?.[0]).toMatchObject({ fold: "data", source: "rule small.json: settings nobody reads" });
    expect(folds["fixtures/huge.json"]?.[0]?.fold).toBeNull();
  });
});

describe("the repo's rules section", () => {
  it("reads the fenced yaml block, and nothing from a section without one", () => {
    const section =
      'Prose for the agent.\n\n```yaml\nrules:\n  - match: "attraverso.yaml"\n    class: generated\n```\n';
    expect(rulesIn(section)).toEqual([{ match: "attraverso.yaml", class: "generated" }]);
    expect(rulesIn("Only prose.")).toEqual([]);
  });

  it("refuses rules that don't fit, rather than folding by a guess", () => {
    expect(() => rulesIn("```yaml\nrules:\n  - match: x\n    class: secret\n```")).toThrow(/doesn't fit/);
  });
});

describe("the step list", () => {
  it("runs review before its fixes, fetches again after them, and checks last", () => {
    expect(STEP_IDS.indexOf("review")).toBeLessThan(STEP_IDS.indexOf("fix"));
    expect(following("fix")).toBe("refetch");
    expect(STEP_IDS.at(-1)).toBe("check");
    expect(following("check")).toBe("done");
  });
});

const pr: Artefact<"pr"> = {
  repo: "me/repo",
  clone: "/clone",
  number: 1,
  title: "A change",
  author: "me",
  mine: true,
  base: "main",
  head: "feature",
  baseCommit: "b".repeat(40),
  headCommit: "h".repeat(40),
  diffHash: "",
  files: 1,
  added: 3,
  removed: 0,
};
const finding = (id: string, clear: boolean, withOptions = false): Artefact<"findings">["findings"][number] => ({
  id,
  kind: "question",
  path: "src/a.ts",
  match: "line 1",
  title: `Finding ${id}`,
  body: "",
  recommendation: "",
  clear,
  ...(withOptions
    ? {
        options: [
          { label: "One", detail: "" },
          { label: "Two", detail: "" },
        ],
      }
    : {}),
});
const narrative: Artefact<"narrative"> = {
  gist: "Does a thing",
  tryIt: "yarn dev",
  verdict: "comment",
  steps: [{ id: "one", title: "One", files: ["src/a.ts"] }],
  blocks: { "src/a.ts": [{ title: "The thing" }] },
  notForReview: [],
  tests: { files: [], tested: [] },
  names: {},
};

describe("assemble", () => {
  const findings = {
    files: { "src/a.ts": "read" },
    findings: [finding("f", true), finding("d", false, true), finding("c", true)],
  };
  const folds = { "src/a.ts": [{ fold: null, source: "default (code)" }] };

  it("lists what was fixed, puts a choice as a decision, and leaves the rest as comments", () => {
    const review = assemble({
      onNext: () => false,
      pr,
      findings,
      folds,
      narrative,
      outcomes: {
        f: { outcome: "fixed", detail: "Renamed it", commit: "abc1234" },
        d: {
          outcome: "decision",
          options: [
            { label: "A", detail: "" },
            { label: "B", detail: "" },
          ],
        },
        c: { outcome: "comment", why: "Disagree" },
      },
    });
    expect(review.fixed).toEqual([{ title: "Finding f", detail: "Renamed it", commit: "abc1234" }]);
    expect(review.decisions.map((decision) => decision.id)).toEqual(["d"]);
    expect(review.comments.map((comment) => comment.id)).toEqual(["c"]);
    expect(review.comments[0]?.body).toBe("Not fixed: Disagree");
    expect(review.pr.commit).toBe(pr.headCommit);
  });

  it("lists a finding whose item is on Next as planned, and offers the rest to add", () => {
    const withItems = {
      files: {},
      findings: [
        { ...finding("known", true), item: "pr-reviewer:ARCH-5" },
        { ...finding("new", true), item: "pr-reviewer:FLOW-1" },
      ],
    };
    const review = assemble({
      onNext: (item) => item === "pr-reviewer:ARCH-5",
      pr,
      findings: withItems,
      folds,
      narrative,
      outcomes: { known: { outcome: "comment", why: "" }, new: { outcome: "comment", why: "" } },
    });
    expect(review.planned).toEqual([{ title: "Finding known", item: "pr-reviewer:ARCH-5" }]);
    const blocking = assemble({
      onNext: () => true,
      pr,
      findings: {
        files: {},
        findings: [{ ...finding("known", true), kind: "request-changes", item: "pr-reviewer:ARCH-5" }],
      },
      folds,
      narrative,
      outcomes: { known: { outcome: "comment", why: "" } },
    });
    expect(blocking.planned).toEqual([]);
    expect(review.comments.map((comment) => [comment.id, comment.item])).toEqual([["new", "pr-reviewer:FLOW-1"]]);
  });

  it("lists a finding filed for later as planned, unless it blocks, which stays under its line with the item", () => {
    const filed = { outcome: "filed" as const, item: "pr-reviewer:FLOW-24", why: "A refactor of its own" };
    const nit = assemble({
      onNext: () => false,
      pr,
      findings: { files: {}, findings: [finding("n", true)] },
      folds,
      narrative,
      outcomes: { n: filed },
    });
    expect(nit.planned).toEqual([{ title: "Finding n", item: "pr-reviewer:FLOW-24" }]);
    expect(nit.comments).toEqual([]);
    const blocker = assemble({
      onNext: () => true,
      pr,
      findings: { files: {}, findings: [{ ...finding("b", true), kind: "request-changes" }] },
      folds,
      narrative,
      outcomes: { b: filed },
    });
    expect(blocker.planned).toEqual([]);
    expect(blocker.comments.map((comment) => [comment.item, comment.body])).toEqual([
      ["pr-reviewer:FLOW-24", "Filed as pr-reviewer:FLOW-24: A refactor of its own"],
    ]);
  });

  it("lists the commits not re-reviewed in the review, and nothing when there are none", () => {
    const base = { pr, findings: { files: {}, findings: [] }, folds, narrative, outcomes: {}, onNext: () => false };
    expect(assemble({ ...base, notReReviewed: ["abc1234"] }).pr.notReReviewed).toEqual(["abc1234"]);
    expect(assemble(base).pr.notReReviewed).toBeUndefined();
  });

  it("lists an open test gap with the tests, and a fixed one as fixed", () => {
    const review = assemble({
      onNext: () => false,
      pr,
      findings: {
        files: {},
        findings: [
          { ...finding("open", true), gap: true },
          { ...finding("done", true), gap: true },
        ],
      },
      folds,
      narrative,
      outcomes: { open: { outcome: "comment", why: "later" }, done: { outcome: "fixed", detail: "Tested" } },
    });
    expect(review.tests.gaps.map((gap) => gap.id)).toEqual(["open"]);
    expect(review.comments).toEqual([]);
    expect(review.fixed.map((item) => item.title)).toEqual(["Finding done"]);
  });

  it("on someone else's PR, fixes nothing: a finding with options is a decision, the rest comments", () => {
    const review = assemble({
      onNext: () => false,
      pr: { ...pr, mine: false },
      findings,
      folds,
      narrative,
      outcomes: null,
    });
    expect(review.fixed).toEqual([]);
    expect(review.decisions.map((decision) => decision.id)).toEqual(["d"]);
    expect(review.comments.map((comment) => comment.id)).toEqual(["f", "c"]);
  });

  it("takes folds from folds.json, and folds a file the narrative left unheaded under its fold's name", () => {
    const review = assemble({
      onNext: () => false,
      pr,
      findings: { files: {}, findings: [] },
      folds: { ...folds, "yarn.lock": [{ fold: "generated", source: "default (generated)" }] },
      narrative,
      outcomes: {},
    });
    expect(review.blocks["yarn.lock"]).toEqual([{ title: "generated", fold: "generated" }]);
    expect(review.blocks["src/a.ts"]).toEqual([{ title: "The thing" }]);
  });
});

describe("check", () => {
  const setUp = () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "review-")));
    const diff = [added("src/a.ts", 3)];
    work.write("diff", diff);
    const hashed = { ...pr, diffHash: hashOf(`${JSON.stringify(diff)}\n`) };
    work.write("pr", hashed);
    work.write("findings", { files: { "src/a.ts": "read" }, findings: [] });
    work.write(
      "review",
      assemble({
        onNext: () => false,
        pr: hashed,
        findings: work.read("findings"),
        folds: {},
        narrative,
        outcomes: {},
      }),
    );
    return work;
  };

  it("passes a review that fits, covers every file, and is of the head", () => {
    expect(checkWorkspace(setUp(), pr.headCommit)).toEqual([]);
  });

  it("sends a review of an older head back to the start, so new commits are reviewed, and an unreviewed file to review", () => {
    const work = setUp();
    work.write("findings", { files: {}, findings: [] });
    const problems = checkWorkspace(work, "n".repeat(40));
    expect(problems.map((problem) => problem.back)).toEqual(["fetch", "review"]);
  });

  it("sends commits after the review back only when one needs it, and only for a few rounds", () => {
    const work = setUp();
    const commit = (fix: boolean, blocking: boolean) => ({ sha: "c".repeat(40), fix, blocking });
    const backs = (commits: ReturnType<typeof commit>[], rounds: number) =>
      checkWorkspace(work, null, { commits, rounds }).map((problem) => [problem.back, problem.reason]);
    // New work, and a fix for a blocking finding, are reviewed; a fix for a nit isn't.
    expect(backs([commit(false, false)], 0)).toEqual([["review", "unreviewed"]]);
    expect(backs([commit(true, true)], 0)).toEqual([["review", "unreviewed"]]);
    expect(backs([commit(true, false)], 0)).toEqual([]);
    // Past the cap, nothing goes back: the commits are listed in the review instead.
    expect(backs([commit(false, false)], 1)).toEqual([]);
    expect(backs([], 0)).toEqual([]);
  });

  it("sends each proofread issue back to its step, marked as a reading", () => {
    const work = setUp();
    work.write("proofread", {
      issues: [{ where: "src/a.ts", problem: "a heading names a folded type", back: "narrate" }],
    });
    expect(checkWorkspace(work, null)).toEqual([
      { problem: "src/a.ts: a heading names a folded type", back: "narrate", proofread: true },
    ]);
  });

  it("lets the proofread send the review back once, then leaves its issues as notes", async () => {
    const work = setUp();
    work.write("proofread", { issues: [{ where: "x", problem: "y", back: "judge" }] });
    const context = (rounds: number) => ({
      work,
      clone: "/clone",
      number: 1,
      liveHead: () => null,
      proofreadSentBack: rounds,
    });
    expect(await pipeline.check.run(context(0))).toHaveLength(1);
    expect(await pipeline.check.run(context(1))).toBe(
      "the review fits its PR; proofread note left after a round of send-backs:\n  - x: y",
    );
  });

  it("asks for a heading over every stretch longer than LONG_BLOCK, not one heading anywhere", () => {
    const reviewOf = (
      count: number,
      sections?: { line: number; title: string }[],
      path = "src/a.ts",
      commented = false,
    ) => {
      const plain = added(path, count);
      const asComment = (line: DiffFile["hunks"][number]["lines"][number]): typeof line => [
        line[0],
        line[1],
        line[2],
        `// ${line[3]}`,
      ];
      const hunks = plain.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map(asComment) }));
      const diff = [commented ? { ...plain, hunks } : plain];
      const assembled = assemble({
        onNext: () => false,
        pr,
        findings: { files: { [path]: "read" }, findings: [] },
        folds: { [path]: [{ fold: null, source: "default (code)" }] },
        narrative: {
          ...narrative,
          steps: [{ id: "one", title: "One", files: [path] }],
          blocks: { [path]: [{ title: "A", ...(sections ? { sections } : {}) }] },
        },
        outcomes: {},
      });
      return loadReview(diff, assembled);
    };
    expect(unsignposted(reviewOf(LONG_BLOCK + 1)).map((problem) => problem.back)).toEqual(["narrate"]);
    expect(unsignposted(reviewOf(LONG_BLOCK))).toEqual([]);
    // One heading on the first line leaves the same stretch under it; one halfway splits it in two that fit.
    expect(unsignposted(reviewOf(LONG_BLOCK + 1, [{ line: 1, title: "Part one" }]))[0]?.problem).toContain(
      `${LONG_BLOCK + 1} lines in a row with no heading, from line 1`,
    );
    expect(unsignposted(reviewOf(LONG_BLOCK * 2, [{ line: LONG_BLOCK + 1, title: "Part two" }]))).toEqual([]);
    expect(
      unsignposted(reviewOf(LONG_BLOCK * 2 + 1, [{ line: LONG_BLOCK + 1, title: "Part two" }]))[0]?.problem,
    ).toContain(`from line ${LONG_BLOCK + 1}`);
    // Comment lines count only where the app shows them: hidden in TypeScript, drawn as code in a language it can't
    // tell prose comments in.
    expect(unsignposted(reviewOf(LONG_BLOCK + 1, undefined, "src/a.ts", true))).toEqual([]);
    expect(unsignposted(reviewOf(LONG_BLOCK + 1, undefined, "src/a.go", true))).toHaveLength(1);
  });

  it("notices a diff.json edited after it was fetched", () => {
    const work = setUp();
    writeFileSync(work.pathOf("diff"), JSON.stringify([added("src/a.ts", 3)], null, 1));
    expect(checkWorkspace(work, null).map((problem) => problem.back)).toEqual(["refetch"]);
  });
});

describe("the review step's verify", () => {
  it("names a file left out, a finding with no line, and a decision with nothing to choose", () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "review-")));
    work.write("diff", [added("src/a.ts", 3), added("src/b.ts", 1)]);
    work.write("findings", {
      files: { "src/a.ts": "read" },
      findings: [finding("gone", true), finding("open", false)].map((each, index) =>
        index === 0 ? { ...each, match: "nowhere" } : each,
      ),
    });
    expect(reviewIsWhole({ work } as Context)).toEqual([
      'src/b.ts is not in "files"',
      'finding "gone" matches no line in src/a.ts',
      'finding "open" is not clear but has fewer than two options',
    ]);
    // Once fixed, a finding whose line the fix changed is listed, not anchored, so a re-review can keep it.
    work.write("outcomes", { gone: { outcome: "fixed", detail: "" } });
    expect(reviewIsWhole({ work } as Context)).not.toContain('finding "gone" matches no line in src/a.ts');
  });
});

describe("the narrate step's verify", () => {
  it("names a file with fewer headings than hunks, and a heading with no title", () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "narrate-")));
    const twoHunks = {
      ...added("src/a.ts", 2),
      hunks: [added("src/a.ts", 1).hunks[0]!, added("src/a.ts", 1).hunks[0]!],
    };
    work.write("diff", [twoHunks, added("src/b.ts", 1)]);
    const narrative = (blocks: Record<string, { title: string }[]>) => ({
      gist: "",
      tryIt: "",
      verdict: "approve" as const,
      steps: [{ id: "one", title: "One", files: ["src/a.ts", "src/b.ts"] }],
      blocks,
      notForReview: [],
      tests: { files: [], tested: [] },
      names: {},
    });
    work.write("narrative", narrative({ "src/a.ts": [{ title: "A" }], "src/b.ts": [{ title: " " }] }));
    expect(headingsFit({ work } as Context)).toEqual([
      "src/a.ts has 1 headings for 2 hunks",
      "src/b.ts block 1 has no title",
    ]);
    work.write(
      "narrative",
      narrative({ "src/a.ts": [{ title: "A" }, { title: "and B" }], "src/b.ts": [{ title: "B" }] }),
    );
    expect(headingsFit({ work } as Context)).toEqual([]);
  });
});

describe("proofread send-backs", () => {
  it("count only send-backs that carried proofread issues, at this head", () => {
    const back = (proofread: boolean, head: string) => ({
      step: "check",
      at: "",
      note: "",
      sentBack: { head, proofread },
    });
    const state: ReviewState = {
      clone: "/clone",
      number: 1,
      at: "check",
      waiting: false,
      problems: [],
      history: [back(false, "a".repeat(40)), back(true, "a".repeat(40)), { step: "review", at: "", note: "done" }],
    };
    expect(proofreadSendBacks(state, "a".repeat(40))).toBe(1);
    expect(proofreadSendBacks(state, "b".repeat(40))).toBe(0);
  });
});

describe("loop guards", () => {
  const at = (step: string, sentBack?: NonNullable<ReviewState["history"][number]["sentBack"]>) => ({
    step,
    at: "",
    note: "",
    ...(sentBack ? { sentBack } : {}),
  });
  const stateWith = (history: ReviewState["history"]): ReviewState => ({
    clone: "/clone",
    number: 1,
    at: "check",
    waiting: false,
    problems: [],
    history,
  });

  it("count re-review rounds since the run started or the PR moved on by itself", () => {
    const unreviewed = (head: string) => at("check", { to: "review", head, proofread: false, reason: "unreviewed" });
    const history = [unreviewed("a"), at("start"), unreviewed("b"), unreviewed("c")];
    expect(reReviewRounds(stateWith(history))).toBe(2);
    const moved = at("check", { to: "fetch", head: "c", proofread: false, reason: "moved" });
    expect(reReviewRounds(stateWith([...history, moved, unreviewed("d")]))).toBe(1);
    // A person asking for another round (`back` by hand) gives a fresh one.
    const asked = { step: "review", at: "", note: "back by hand", reset: true as const };
    expect(reReviewRounds(stateWith([...history, asked]))).toBe(0);
    expect(reReviewRounds(stateWith([...history, { ...asked, step: "fetch" }]))).toBe(0);
    // Going back by hand to redo a later step (a heading in narrate) is no request for another round.
    expect(reReviewRounds(stateWith([...history, { ...asked, step: "narrate" }]))).toBe(2);
    expect(reReviewRounds(stateWith([...history, { ...asked, step: "judge" }]))).toBe(2);
  });

  it("stop the run for a person when one step is sent back to too often at one head", async () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "stop-")));
    work.write("pr", { ...pr, headCommit: "h".repeat(40) });
    const sentBack = { to: "narrate", head: "h".repeat(40), proofread: false };
    const dir = work.dir;
    saveState(dir, {
      ...stateWith([at("check", sentBack), at("check", sentBack), at("check", sentBack)]),
      at: "check",
    });
    const steps = Object.fromEntries(STEP_IDS.map((id) => [id, pipeline[id]])) as Record<StepId, Step>;
    const runner: Runner = {
      steps: {
        ...steps,
        check: { by: "code", does: "check", writes: [], run: async () => [{ problem: "still off", back: "narrate" }] },
      },
      driver: { handOver: () => {} },
      contextOf: () => ({ work, clone: "/clone", number: 1, liveHead: () => null }),
      log: () => {},
    };
    const state = await advance(dir, runner);
    expect(state).toMatchObject({ at: "check", waiting: true });
    expect(state.problems[0]).toMatch(/^stopped: sent back to narrate 3 times/);
  });

  it("decide once what to do with commits since the review: send back, or list", () => {
    const commit = (fix: boolean, blocking: boolean) => ({ sha: "abcdef0123", fix, blocking });
    expect(reReviewPlan([], 0)).toEqual({ review: false, listed: [] });
    expect(reReviewPlan([commit(false, false)], 0)).toEqual({ review: true, listed: [] });
    expect(reReviewPlan([commit(false, false)], 3)).toEqual({ review: false, listed: ["abcdef0"] });
    // A nit's fix is never listed, alone or beside new work past the cap: it is shown with what it fixed.
    expect(reReviewPlan([commit(true, false)], 0)).toEqual({ review: false, listed: [] });
    expect(reReviewPlan([commit(true, false), commit(true, true)], 3)).toEqual({ review: false, listed: ["abcdef0"] });
  });

  it("fail closed: when git can't list the commits since, they need review", () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "work-")));
    const notARepo = mkdtempSync(join(tmpdir(), "none-"));
    expect(needsReReview(commitsSinceReview(work, notARepo, "a".repeat(40), "b".repeat(40)))).toBe(true);
    expect(needsReReview(commitsSinceReview(work, notARepo, "a".repeat(40), ""))).toBe(true);
    expect(commitsSinceReview(work, notARepo, undefined, "b".repeat(40))).toEqual([]);
  });

  it("start the backstop's count again when a person steps in", () => {
    const sentBack = { to: "narrate", head: "h", proofread: false };
    const three = [at("check", sentBack), at("check", sentBack), at("check", sentBack)];
    expect(sendBacksTo(stateWith(three), "narrate", "h")).toBe(3);
    const stepIn = (step: string) => ({ step, at: "", note: "", reset: true as const });
    expect(sendBacksTo(stateWith([...three, stepIn("narrate")]), "narrate", "h")).toBe(0);
    expect(sendBacksTo(stateWith([...three, stepIn("start"), at("check", sentBack)]), "narrate", "h")).toBe(1);
    // The wording of a note doesn't count: only the field does.
    expect(sendBacksTo(stateWith([...three, { step: "narrate", at: "", note: "back by hand" }]), "narrate", "h")).toBe(
      3,
    );
  });

  it("mark each commit since the review from the fix step's outcomes", () => {
    const dir = mkdtempSync(join(tmpdir(), "commits-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    const commit = (text: string) => {
      writeFileSync(join(dir, "f.txt"), text);
      git("add", "f.txt");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", text);
      return git("rev-parse", "HEAD");
    };
    const reviewed = commit("reviewed");
    const nitFix = commit("nit fix");
    const blockingFix = commit("blocking fix");
    const newWork = commit("new work");
    // Filing an item: a commit to the plan only, which costs no round.
    mkdirSync(join(dir, ".attraverso"), { recursive: true });
    writeFileSync(join(dir, "attraverso.yaml"), "filed");
    writeFileSync(join(dir, ".attraverso", "layout.yaml"), "x: 1");
    git("add", "attraverso.yaml", ".attraverso/layout.yaml");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "filed");
    const filed = git("rev-parse", "HEAD");
    const work = workspace(mkdtempSync(join(tmpdir(), "work-")));
    work.write("findings", {
      files: {},
      findings: [
        { ...finding("nit", true), kind: "nit" },
        { ...finding("block", true), kind: "request-changes" },
      ],
    });
    work.write("outcomes", {
      nit: { outcome: "fixed", detail: "", commit: nitFix.slice(0, 7) },
      block: { outcome: "fixed", detail: "", commit: blockingFix.slice(0, 7) },
    });
    const commits = commitsSinceReview(work, dir, reviewed, filed);
    expect(commits.map((each) => [each.fix, each.blocking])).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
    expect(commits[2]!.sha).toBe(newWork);
    expect(needsReReview(commits.slice(3))).toBe(false);
    // The files each commit touched, for a file's header to say it changed after the review.
    expect(filesChangedBy(dir, [nitFix, filed])).toEqual({
      "f.txt": [nitFix.slice(0, 7)],
      "attraverso.yaml": [filed.slice(0, 7)],
      ".attraverso/layout.yaml": [filed.slice(0, 7)],
    });
    // A round that is due reads every commit, so none is marked; once none is (only nits and filing, or past the
    // cap), all are.
    expect(notLookedAt(commits, 0)).toEqual([]);
    expect(notLookedAt(commits, MAX_REREVIEWS)).toEqual(commits.map((each) => each.sha));
    expect(notLookedAt(commits.slice(3), 0)).toEqual([filed]);
    expect(needsReReview(commits.slice(0, 1))).toBe(false);
    // The plan files, a legacy one and its folder included, and nothing that only resembles one.
    expect(
      ["attraverso.yaml", "packages/x/attraverso.yaml", "a.apm.yaml", ".apm/m.yaml", ".attraverso/layout.yaml"].every(
        isPlanFile,
      ),
    ).toBe(true);
    expect(["attraverso.yaml.bak", "src/attraverso.ts", "docs/attraverso.yaml.md"].some(isPlanFile)).toBe(false);
    expect(needsReReview(commits)).toBe(true);
  });
});

describe("the judge's near-duplicate brief", () => {
  it("looks only at code the reader reads, by the class the fold step gave it", () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "alike-")));
    const twice = [
      "const a = list.filter((x) => x.ok).map((x) => x.id);",
      "const b = list.filter((x) => x.ok).map((x) => x.id);",
      "",
      "const c = list.filter((x) => x.ok).map((x) => x.id);",
      "const d = list.filter((x) => x.ok).map((x) => x.id);",
    ];
    const file = (path: string): DiffFile => ({
      path,
      added: 5,
      removed: 0,
      hunks: [
        {
          context: "",
          lines: twice.map((text, index): DiffFile["hunks"][number]["lines"][number] => ["+", null, index + 1, text]),
        },
      ],
    });
    work.write("diff", [file("src/a.ts"), file("src/a.test.ts"), file("src/a.css")]);
    const entry = (fileClass: "code" | "test") => [{ fold: null, source: "", class: fileClass }];
    work.write("folds", { "src/a.ts": entry("code"), "src/a.test.ts": entry("test"), "src/a.css": entry("code") });
    const brief = alikeBrief({ work, clone: "/clone", number: 1, liveHead: () => null });
    expect(brief.filter((line) => line.includes("src/"))).toEqual([expect.stringContaining("src/a.ts 1-5")]);
  });
});

describe("the render step", () => {
  it("sends a review that doesn't fit its diff back, rather than throwing", async () => {
    const work = workspace(mkdtempSync(join(tmpdir(), "render-")));
    work.write("diff", [added("src/a.ts", 3)]);
    const fitting = assemble({
      onNext: () => false,
      pr,
      findings: { files: {}, findings: [] },
      folds: {},
      narrative,
      outcomes: {},
    });
    work.write("review", { ...fitting, blocks: { "src/a.ts": [{ title: "One" }, { title: "Two" }] } });
    const result = await pipeline.render.run({ work, clone: "/clone", number: 1, liveHead: () => null });
    expect(result).toEqual([{ problem: "src/a.ts has 2 block headings for 1 hunks", back: "narrate" }]);
  });
});

describe("the runner", () => {
  /** Every step a stand-in that records it ran; `overrides` replaces some. */
  const setUp = (overrides: Partial<Record<StepId, Step>>) => {
    const ran: string[] = [];
    const handed: string[] = [];
    const code = (id: StepId): Step => ({
      by: "code",
      does: id,
      writes: [],
      run: async () => {
        ran.push(id);
        return "ok";
      },
    });
    const steps = Object.fromEntries(STEP_IDS.map((id) => [id, overrides[id] ?? code(id)])) as Record<StepId, Step>;
    const dir = mkdtempSync(join(tmpdir(), "runner-"));
    const runner: Runner = {
      steps,
      driver: { handOver: (id) => handed.push(id) },
      contextOf: () => ({ work: workspace(dir), clone: "/clone", number: 1, liveHead: () => null }),
      log: () => {},
    };
    const start: ReviewState = { clone: "/clone", number: 1, at: "fetch", waiting: false, problems: [], history: [] };
    saveState(dir, start);
    return { ran, handed, dir, runner };
  };
  const agent = (writes: Step["writes"], verify?: () => string[]): AgentStep => ({
    by: "agent",
    does: "think",
    prompt: "x.md",
    reads: [],
    writes,
    ...(verify ? { verify } : {}),
  });

  it("records the head a step that reviews finished at, for the next run to build on", async () => {
    const { dir, runner } = setUp({ review: { ...agent([]), recordsHead: true } });
    workspace(dir).write("pr", { ...pr, headCommit: "abc" });
    await advance(dir, runner);
    await finish(dir, runner);
    expect(loadState(dir).reviewedHead).toBe("abc");
  });

  it("runs code steps until an agent step, hands it over, and waits", async () => {
    const { ran, handed, dir, runner } = setUp({ review: agent([]) });
    const state = await advance(dir, runner);
    expect(ran).toEqual(["fetch"]);
    expect(handed).toEqual(["review"]);
    expect(state).toMatchObject({ at: "review", waiting: true });
  });

  it("skips a step whose `when` does not hold", async () => {
    const { ran, dir, runner } = setUp({ fix: { ...pipeline.refetch, run: async () => "fixed", when: () => false } });
    await advance(dir, runner);
    expect(ran).not.toContain("fix");
    expect(loadState(dir).history.find((entry) => entry.step === "fix")?.note).toBe("skipped");
  });

  it("keeps an agent step open while its files don't fit or its verify objects, then carries on", async () => {
    const objections = ["not yet"];
    const { ran, dir, runner } = setUp({ review: agent(["findings"], () => objections) });
    await advance(dir, runner);
    expect((await finish(dir, runner))[0]).toMatch(/findings/);
    workspace(dir).write("findings", { files: {}, findings: [] });
    expect(await finish(dir, runner)).toEqual(["not yet"]);
    objections.length = 0;
    expect(await finish(dir, runner)).toEqual([]);
    expect(ran.at(-1)).toBe("check");
    expect(loadState(dir).at).toBe("done");
  });

  it("checks an agent step's files as finish does, but leaves the run where it was", async () => {
    const objections = ["not yet"];
    const { dir, runner } = setUp({ review: agent(["findings"], () => objections) });
    await advance(dir, runner);
    const before = loadState(dir);
    expect(check(dir, runner)[0]).toMatch(/findings/);
    workspace(dir).write("findings", { files: {}, findings: [] });
    expect(check(dir, runner)).toEqual(["not yet"]);
    objections.length = 0;
    // The files check out, and still nothing moves: the agent may run this, and only `done` carries on.
    expect(check(dir, runner)).toEqual([]);
    expect(loadState(dir)).toEqual(before);
    expect(before).toMatchObject({ at: "review", waiting: true });
    // Refused where finish is: not waiting on an agent.
    expect(await finish(dir, runner)).toEqual([]);
    expect(() => check(dir, runner)).toThrow(/not waiting on an agent/);
  });

  it("refuses to check a code step that stopped the run, as finish does", () => {
    const { dir, runner } = setUp({});
    saveState(dir, { ...loadState(dir), at: "render", waiting: true });
    expect(() => check(dir, runner)).toThrow(/code step/);
  });

  it("records a proofread send-back through the runner, at the head it happened", async () => {
    const { dir, runner } = setUp({
      narrate: agent([]),
      check: {
        by: "code",
        does: "check",
        writes: [],
        run: async () => [{ problem: "a heading names a folded type", back: "narrate", proofread: true }],
      },
    });
    workspace(dir).write("pr", { ...pr, headCommit: "h".repeat(40) });
    saveState(dir, { ...loadState(dir), at: "check" });
    await advance(dir, runner);
    expect(proofreadSendBacks(loadState(dir), "h".repeat(40))).toBe(1);
  });

  it("sends a failed check back to the earliest step named, with only that step's problems", async () => {
    let checks = 0;
    const { dir, runner } = setUp({
      judge: agent([]),
      check: {
        by: "code",
        does: "check",
        writes: [],
        run: async () => {
          checks += 1;
          return checks > 1
            ? "ok"
            : [
                { problem: "narrative is off", back: "narrate" },
                { problem: "folds are off", back: "fold" },
              ];
        },
      },
    });
    saveState(dir, { ...loadState(dir), at: "assemble" });
    const state = await advance(dir, runner);
    expect(state).toMatchObject({ at: "judge", waiting: true, problems: [] });
    expect(state.history.map((entry) => entry.note)).toContain("back to fold: 1 problems");
  });
});

describe("fetch's reading of a PR", () => {
  const pr = { base: { ref: "master", repo: { full_name: "o/r" } }, user: { login: "me" } };
  it("measures a merged PR from its merge's first parent, and an open one from its base, trial merge or not", () => {
    expect(baseOf({ ...pr, merged: true, merge_commit_sha: "abc" })).toBe("abc^1");
    expect(baseOf({ ...pr, merged: false, merge_commit_sha: "trial" })).toBe("origin/master");
    expect(baseOf({ ...pr, merged: false, merge_commit_sha: null })).toBe("origin/master");
  });
  it("calls a PR ours only while it is open and by us", () => {
    expect(isMine({ ...pr, state: "open" }, "me")).toBe(true);
    expect(isMine({ ...pr, state: "closed" }, "me")).toBe(false);
    expect(isMine({ ...pr, state: "open" }, "someone")).toBe(false);
  });
});
