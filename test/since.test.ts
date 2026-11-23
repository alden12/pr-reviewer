import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspace } from "../pipeline/artefacts.ts";
import { sinceLastReview, type Context } from "../pipeline/pipeline.ts";
import { foldByRules, keepJudged } from "../pipeline/steps/fold.ts";
import { isReviewName } from "../src/review/reading.ts";

/** A repo with commits a, b (on a's line) and c (rewritten, off it). */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "since-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (text: string) => {
    writeFileSync(join(dir, "f.txt"), text);
    git("add", "f.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", text);
    return git("rev-parse", "HEAD");
  };
  const a = commit("a");
  const b = commit("b");
  git("checkout", "-q", "--orphan", "other");
  const c = commit("c");
  return { dir, a, b, c };
}

const contextAt = (clone: string, head: string, withFindings = true): Context => {
  const work = workspace(mkdtempSync(join(tmpdir(), "work-")));
  work.write("pr", {
    repo: "me/repo",
    clone,
    number: 1,
    title: "",
    author: "me",
    mine: true,
    base: "main",
    head: "feature",
    baseCommit: "",
    headCommit: head,
    diffHash: "",
    files: 0,
    added: 0,
    removed: 0,
  });
  if (withFindings) work.write("findings", { files: {}, findings: [] });
  return { work, clone, number: 1, liveHead: () => null };
};

describe("sinceLastReview", () => {
  it("names the new commits when the PR moved on from the reviewed head", () => {
    const { dir, a, b } = repo();
    const brief = sinceLastReview(contextAt(dir, b), { reviewedHead: a });
    expect(brief[0]).toContain(`git diff ${a.slice(0, 7)} ${b.slice(0, 7)}`);
  });

  it("asks for a full review when the branch was rewritten, says nothing on a first review, and notes a same-head re-run", () => {
    const { dir, b, c } = repo();
    expect(sinceLastReview(contextAt(dir, c), { reviewedHead: b })[0]).toMatch(/^full review/);
    expect(sinceLastReview(contextAt(dir, b), {})).toEqual([]);
    expect(sinceLastReview(contextAt(dir, b), { reviewedHead: b })[0]).toMatch(/^same:/);
    expect(sinceLastReview(contextAt(dir, b, false), { reviewedHead: "x" })).toEqual([]);
  });
});

describe("a merge since the last review", () => {
  it("asks for a full review, since a diff across a merge is not the PR's own", () => {
    const { dir, a, b } = repo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "side", a);
    writeFileSync(join(dir, "g.txt"), "from the base");
    git("add", "g.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base work");
    git("checkout", "-q", "-b", "pr", b);
    git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "side");
    const merged = git("rev-parse", "HEAD");
    const reviewed = git("rev-parse", "HEAD^1");
    expect(sinceLastReview(contextAt(dir, merged), { reviewedHead: reviewed })[0]).toMatch(/^full review: a merge/);
  });
});

describe("keepJudged", () => {
  it("keeps the judge's call on a hunk that hasn't changed, and drops it where the hunk did", () => {
    const fresh = {
      "a.ts": [
        { fold: null, source: "default (code)", hunk: "same" },
        { fold: null, source: "default (code)", hunk: "new" },
      ],
    };
    const earlier = {
      "a.ts": [
        { fold: "moved in", source: "judge: moved", hunk: "same" },
        { fold: "moved in", source: "judge: moved", hunk: "old" },
      ],
    };
    expect(keepJudged(fresh, earlier)["a.ts"]?.map((entry) => entry.fold)).toEqual(["moved in", null]);
  });

  it("moves a kept call's spans with its hunk, and hashes a hunk by its text, not where it sits", () => {
    const span = { from: 12, to: 15, kind: "repeat", summary: "the same again" };
    const moved = keepJudged(
      { "a.ts": [{ fold: null, source: "default (code)", hunk: "same", at: 13 }] },
      { "a.ts": [{ fold: null, source: "judge: repeats", hunk: "same", at: 10, spans: [span] }] },
    );
    expect(moved["a.ts"]?.[0]?.spans).toEqual([{ ...span, from: 15, to: 18 }]);
    const lines = (start: number) => ({ context: "", lines: [["+", null, start, "x"] as ["+", null, number, string]] });
    const hashAt = (start: number) =>
      foldByRules([{ path: "a.ts", added: 1, removed: 0, hunks: [lines(start)] }], [])["a.ts"]?.[0]?.hunk;
    expect(hashAt(1)).toBe(hashAt(40));
  });
});

describe("isReviewName", () => {
  it("takes one folder name, never a way out of it", () => {
    expect(isReviewName("example-app-153")).toBe(true);
    expect(isReviewName("..")).toBe(false);
    expect(isReviewName("a/b")).toBe(false);
    expect(isReviewName(".hidden")).toBe(false);
  });
});
