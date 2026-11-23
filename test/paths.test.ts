/**
 * Where the reviewer finds its own files and puts a run's reviews (DIST-1.2, DIST-1.3): from the package's root, the
 * same from source as from the build, and beside the run's plan, in a folder whose `.gitignore` keeps only what the
 * app reads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BIN, PACKAGE, PAGE, PROMPTS, reviewsOf, RUNS_BUILT } from "../pipeline/paths.ts";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("the package's own files", () => {
  it("are found from the package's root", () => {
    expect(JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).name).toBe("@attraverso/pr-reviewer");
    expect(existsSync(join(PROMPTS, "review.md"))).toBe(true);
    expect(existsSync(BIN)).toBe(true);
    expect(PAGE).toBe(join(PACKAGE, "dist", "index.html"));
    // Source, here, whatever a build has left in dist/; the build's side is the packed-package test's (DIST-1.6).
    expect(RUNS_BUILT).toBe(false);
  });
});

describe("reviewsOf", () => {
  it("is .attraverso/reviews beside the plan, keeping only diff.json and review.json in git", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-paths-")));
    folders.push(work);
    execFileSync("git", ["init", "-q"], { cwd: work });
    const plan = join(work, "attraverso.yaml");
    writeFileSync(plan, "projects: []\n");
    const reviews = reviewsOf(plan);
    expect(reviews).toBe(join(work, ".attraverso", "reviews"));
    ["diff.json", "review.json", "state.json", "findings.json"].forEach((file) => {
      mkdirSync(join(reviews, "app-1"), { recursive: true });
      writeFileSync(join(reviews, "app-1", file), "{}");
    });
    const kept = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: work, encoding: "utf8" });
    expect(kept.trim().split("\n").sort()).toEqual([
      ".attraverso/reviews/.gitignore",
      ".attraverso/reviews/app-1/diff.json",
      ".attraverso/reviews/app-1/review.json",
      "attraverso.yaml",
    ]);
  });

  it("leaves a .gitignore that is already there", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-paths-")));
    folders.push(work);
    mkdirSync(join(work, ".attraverso", "reviews"), { recursive: true });
    writeFileSync(join(work, ".attraverso", "reviews", ".gitignore"), "mine\n");
    reviewsOf(join(work, "attraverso.yaml"));
    expect(readFileSync(join(work, ".attraverso", "reviews", ".gitignore"), "utf8")).toBe("mine\n");
  });
});
