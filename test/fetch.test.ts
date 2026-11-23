import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffBetween } from "../pipeline/steps/fetch.ts";

/**
 * The fetch step's diff, on a repo made here. gh is left to the real run; this pins what parseDiff reads, whatever
 * the user's git config says.
 */
describe("diffBetween", () => {
  const repo = (config: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    // A config that would change git's output, as a user's own might.
    config.forEach((setting) => git("config", ...setting.split("=")));
    const commit = (files: Record<string, string>) => {
      Object.entries(files).forEach(([path, text]) => {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
      });
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
      return git("rev-parse", "HEAD");
    };
    return { dir, commit };
  };

  it("reads paths, counts and line numbers, a path with a space included", () => {
    const { dir, commit } = repo();
    const base = commit({ "src/a.ts": "one\ntwo\nthree\n" });
    const head = commit({ "src/a.ts": "one\n2\nthree\n", "docs/my notes.md": "new\n" });
    const files = diffBetween(dir, base, head);
    expect(files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["docs/my notes.md", 1, 0],
      ["src/a.ts", 1, 1],
    ]);
    expect(files[1]?.hunks[0]?.lines).toContainEqual(["+", null, 2, "2"]);
  });

  it("gives the same diff whatever the user's git config does to the output", () => {
    const plain = repo();
    const configured = repo([
      "diff.noprefix=true",
      "diff.mnemonicPrefix=true",
      "color.ui=always",
      "core.quotePath=true",
    ]);
    const run = ({ commit, dir }: ReturnType<typeof repo>) => {
      const base = commit({ "a b/é.ts": "x\n" });
      return diffBetween(dir, base, commit({ "a b/é.ts": "y\n" }));
    };
    expect(run(configured)).toEqual(run(plain));
    expect(run(repo()).map((file) => file.path)).toEqual(["a b/é.ts"]);
  });
});
