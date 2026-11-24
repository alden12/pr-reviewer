/**
 * Where a run looks (DIST-1): which PR an argument names, which checkout holds it, and the plan it reads, the one in the
 * folder it was started in, including the layout at work, where that plan sits above several repos.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlan } from "attraverso/library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextLists, planIn, repoRules, runPlans } from "../pipeline/plan.ts";
import { checkoutOn, cloneOf, parsePrRef, runFrom, startTarget } from "../pipeline/target.ts";

// Opening a plan boots PGlite, a second or more on a busy CI runner (master's run after #164 timed out at vitest's 5s).
vi.setConfig({ testTimeout: 30_000 });

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A scratch folder, resolved so paths compare equal on macOS (`/var` is `/private/var`). */
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-target-")));
  folders.push(dir);
  return dir;
};
const repo = (path: string, remote?: string) => {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: path });
  return path;
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
/** A clone with a commit on `main`, and a worktree beside it on `feature` (as at work: the clone on main). */
const cloneWithWorktree = (work: string) => {
  const main = repo(join(work, "web"), "git@github.com:acme/web.git");
  git(main, ["checkout", "-q", "-b", "main"]);
  git(main, ["commit", "-q", "--allow-empty", "-m", "one"]);
  const tree = join(work, "web-feature");
  git(main, ["worktree", "add", "-q", "-b", "feature", tree]);
  git(tree, ["commit", "-q", "--allow-empty", "-m", "two"]);
  return { main, tree: realpathSync(tree), head: git(tree, ["rev-parse", "HEAD"]) };
};
/** A plan whose `work` project holds review rules, written through core's library as a real plan is. */
const rulesPlan = async (): Promise<string> => {
  const plan = await openPlan({});
  await plan.createProject({ key: "work", name: "Work", type: "software" });
  const rule = ["```yaml", "rules:", '  - match: "**/*.snap"', "    class: generated", "    why: snapshots", "```"];
  const work = await plan.project("work");
  await work.setSection("Review rules", rule.join("\n"));
  const item = await work.createItem({ area: "WEB", title: "Ship the thing" });
  await work.setNext([item.ref]);
  const yaml = await plan.toYaml();
  await plan.close();
  return yaml;
};

describe("parsePrRef", () => {
  it("reads a number, owner/repo#number and a PR's URL", () => {
    expect(parsePrRef("160")).toEqual({ number: 160 });
    expect(parsePrRef("#160")).toEqual({ number: 160 });
    expect(parsePrRef("acme/web.app#42")).toEqual({ repo: "acme/web.app", number: 42 });
    expect(parsePrRef("https://github.com/acme/web/pull/42")).toEqual({ repo: "acme/web", number: 42 });
    expect(parsePrRef("https://github.com/acme/web/pull/42/files#diff-1")).toEqual({ repo: "acme/web", number: 42 });
  });

  it("refuses what isn't one", () => {
    ["", "abc", "acme#42", "acme/web#", "https://github.com/acme/web/issues/42", "../x#1"].forEach((text) =>
      expect(parsePrRef(text), text).toBeNull(),
    );
  });
});

describe("cloneOf", () => {
  it("finds a repo nested under the folder a run starts in, by its remote, either URL form", async () => {
    const work = scratch();
    const web = repo(join(work, "company", "web"), "git@github.com:acme/web.git");
    const api = repo(join(work, "company", "api"), "https://github.com/acme/API");
    expect(await cloneOf("acme/web", work)).toBe(web);
    expect(await cloneOf("acme/api", work)).toBe(api);
  });

  it("gives the repo's top level when the run starts in a folder inside it", async () => {
    const work = scratch();
    const web = repo(join(work, "web"), "git@github.com:acme/web.git");
    const deep = join(web, "packages", "app");
    mkdirSync(deep, { recursive: true });
    expect(await cloneOf("acme/web", deep)).toBe(web);
    expect(await cloneOf("acme/web", join(web, "packages"))).toBe(web);
  });

  it("refuses to pick between several checkouts of the repo, unless the run stands in one", async () => {
    const work = scratch();
    const main = repo(join(work, "web"), "git@github.com:acme/web.git");
    const copy = repo(join(work, "web-copy"), "https://github.com/acme/web");
    repo(join(work, "api"), "git@github.com:acme/api.git");
    await expect(cloneOf("acme/web", work)).rejects.toThrow(/2 checkouts of acme\/web .*--clone[^]*web\n[^]*web-copy/);
    expect(await cloneOf("acme/web", main)).toBe(main);
    expect(await cloneOf("acme/web", copy)).toBe(copy);
    expect(await cloneOf("acme/api", work)).toBe(join(work, "api"));
  });

  it("picks among a clone and its worktree: the one at the PR's head, then on its branch, then the main clone", async () => {
    const work = scratch();
    const { main, tree, head } = cloneWithWorktree(work);
    expect(await cloneOf("acme/web", work, async () => ({ sha: head, branch: "elsewhere" }))).toBe(tree);
    expect(await cloneOf("acme/web", work, async () => ({ sha: "0".repeat(40), branch: "feature" }))).toBe(tree);
    // GitHub unreachable, or the PR's branch checked out nowhere: the main clone, not the worktree.
    expect(await cloneOf("acme/web", work, async () => null)).toBe(main);
    expect(await cloneOf("acme/web", work)).toBe(main);
  });

  it("says where it looked when the repo isn't there", async () => {
    const work = scratch();
    repo(join(work, "web"), "git@github.com:acme/web.git");
    await expect(cloneOf("acme/other", work)).rejects.toThrow(/no checkout of acme\/other in .*--clone/);
  });
});

describe("checkoutOn", () => {
  it("finds the checkout with a branch, the clone's own or a worktree's, or none", () => {
    const work = scratch();
    const { main, tree } = cloneWithWorktree(work);
    expect(checkoutOn(main, "feature")).toBe(tree);
    expect(checkoutOn(tree, "main")).toBe(main);
    expect(checkoutOn(main, "gone")).toBeUndefined();
  });
});

describe("the run's plan", () => {
  it("is the plan in the run's folder, attraverso.yaml before a legacy one beside it", () => {
    const work = scratch();
    expect(planIn(work)).toBeUndefined();
    writeFileSync(join(work, "old.apm.yaml"), "projects: []\n");
    expect(planIn(work)).toBe(join(work, "old.apm.yaml"));
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    expect(planIn(work)).toBe(join(work, "attraverso.yaml"));
  });

  it("gives the rules, whatever plan the reviewed repo under it holds", async () => {
    const work = scratch();
    writeFileSync(join(work, "attraverso.yaml"), await rulesPlan());
    const web = repo(join(work, "company", "web"));
    writeFileSync(join(web, "attraverso.yaml"), "projects: []\n");
    const { rules, from } = await repoRules(join(work, "attraverso.yaml"));
    expect(rules.map((rule) => rule.match)).toEqual(["**/*.snap"]);
    expect(from).toBe("attraverso.yaml (work)");
  });

  it("reads Next lists from it and the plans committed beside it in its repo, never the reviewed repo's", async () => {
    const work = repo(scratch());
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    mkdirSync(join(work, "tools"));
    writeFileSync(join(work, "tools", "attraverso.yaml"), await rulesPlan());
    execFileSync("git", ["add", "."], { cwd: work });
    const web = repo(join(work, "company", "web"));
    writeFileSync(join(web, "attraverso.yaml"), await rulesPlan());
    const plan = join(work, "attraverso.yaml");
    expect(runPlans(plan)).toEqual([plan, join(work, "tools", "attraverso.yaml")]);
    expect(await nextLists(plan, ["work"])).toEqual({ work: ["WEB-1"] });
    expect(runPlans(join(web, "attraverso.yaml"))).toEqual([join(web, "attraverso.yaml")]);
  });

  it("is just the one plan when its folder is no repo", () => {
    const work = scratch();
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    expect(runPlans(join(work, "attraverso.yaml"))).toEqual([join(work, "attraverso.yaml")]);
  });
});

describe("start", () => {
  it("takes the plan in the folder it was run from, and the named repo's checkout under it", async () => {
    const work = scratch();
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    const web = repo(join(work, "company", "web"), "git@github.com:acme/web.git");
    expect(await startTarget("acme/web#42", work)).toEqual({
      clone: web,
      plan: join(work, "attraverso.yaml"),
      number: 42,
    });
  });

  it("refuses a folder with no plan, and what isn't a PR", async () => {
    const work = scratch();
    repo(join(work, "web"), "git@github.com:acme/web.git");
    await expect(startTarget("acme/web#42", work)).rejects.toThrow(/no attraverso plan in/);
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    await expect(startTarget("acme#42", work)).rejects.toThrow(/is not a PR/);
  });

  it("takes --clone as given, so it settles several checkouts, and resolves it from the run's folder", async () => {
    const work = scratch();
    writeFileSync(join(work, "attraverso.yaml"), "projects: []\n");
    repo(join(work, "web"), "git@github.com:acme/web.git");
    const copy = repo(join(work, "web-copy"), "git@github.com:acme/web.git");
    await expect(startTarget("acme/web#42", work)).rejects.toThrow(/2 checkouts/);
    expect((await startTarget("acme/web#42", work, "web-copy")).clone).toBe(copy);
    await expect(startTarget("acme/api#42", work, "web-copy")).rejects.toThrow(/checkout of acme\/web, not acme\/api/);
    await expect(startTarget("https://github.com/acme/api/pull/42", work, copy)).rejects.toThrow(/not acme\/api/);
    // A subfolder of the right repo is its top level, as the search gives; a folder that is no checkout is refused.
    mkdirSync(join(copy, "packages"));
    expect((await startTarget("acme/web#42", work, join(copy, "packages"))).clone).toBe(copy);
    await expect(startTarget("42", work, work)).rejects.toThrow(/is not a git checkout/);
    // A bare number from a folder that is no repo: --clone names it, with no git lookup to fail.
    expect((await startTarget("42", work, copy)).clone).toBe(copy);
  });

  it("is a bare number's repo when run from that repo's root", async () => {
    const web = repo(scratch(), "git@github.com:acme/web.git");
    writeFileSync(join(web, "attraverso.yaml"), "projects: []\n");
    expect(await startTarget("#7", web)).toEqual({ clone: web, plan: join(web, "attraverso.yaml"), number: 7 });
  });

  it("is started through bin/pr-reviewer, never yarn's INIT_CWD", () => {
    expect(runFrom({ PR_REVIEWER_FROM: "/work" })).toBe("/work");
    expect(() => runFrom({ INIT_CWD: "/work/packages/reviewer" })).toThrow(/pr-reviewer command/);
  });
});
