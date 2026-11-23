/**
 * Step 1 (and again after `fix`): the PR's facts and its whole diff, from GitHub and the local clone (ARCH-4).
 *
 * **Nothing is excluded here.** What a reader is spared is the review's call, made visibly by `fold` and `judge`, so
 * `check` sees every changed file and can insist each is placed. Binary files come through with no hunks.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseDiff, type DiffFile } from "../../src/diff/parseDiff.ts";
import { hashOf, type Workspace } from "../artefacts.ts";
import { LONGEST_PARSED, type Syntax } from "../syntax.ts";

const run = (cwd: string, command: string, args: string[]) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * The fields of REST's pull request this step reads. REST rather than `gh pr view`, which goes through GraphQL: a
 * Claude Code cloud session is refused GraphQL, and REST is the interface that runs everywhere `gh` does.
 */
export interface GitHubPr {
  number: number;
  title: string;
  user: { login: string };
  base: { ref: string; repo: { full_name: string } };
  head: { ref: string; sha: string };
  state: "open" | "closed";
  merged: boolean;
  /** Set on an open PR too (GitHub's trial merge), so only `merged` says whether it is the real one. */
  merge_commit_sha: string | null;
}

/**
 * The diff between two commits as data. Two lines of context, so each hunk is close to one block. The format is
 * pinned, since parseDiff reads it: a user's own git config (no or mnemonic prefixes, forced colour, an external diff
 * tool, quoted paths) would otherwise change it. Apart from `fetchPr` so it can be tested on a repo made in the test.
 */
export function diffBetween(clone: string, base: string, head: string): DiffFile[] {
  const pinned = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  const format = ["--src-prefix=a/", "--dst-prefix=b/", "-U2", base, head];
  return parseDiff(`${run(clone, "git", [...pinned, ...format])}\n`, "");
}

/**
 * What the diff is measured from. A merged PR is in its base by now, so from where the base stood when it merged: the
 * merge commit's first parent. Otherwise the base as it is now. Only `merged` says which: GitHub fills in
 * `merge_commit_sha` on an open PR too, for its trial merge.
 */
export const baseOf = (pr: Pick<GitHubPr, "merged" | "merge_commit_sha" | "base">): string =>
  pr.merged && pr.merge_commit_sha ? `${pr.merge_commit_sha}^1` : `origin/${pr.base.ref}`;

/**
 * Each hunk's comment-only lines, read by a parser over the whole file on each side (ARCH-9): a removed line by the
 * base's text (at its old path, for a rename), an added or kept one by the head's, so a block comment that opens above
 * the hunk is still seen as one. A file left unmarked keeps the app's per-line guess: one no grammar covers, and one
 * whose needed side can't be read or is too long to parse, since marks from one side only would hide nothing on the
 * other and switch the guess off for it.
 */
export function markComments(
  files: DiffFile[],
  syntax: Syntax,
  textOf: (path: string, side: "old" | "new") => string | undefined,
): DiffFile[] {
  return files.map((file) => {
    if (!syntax.covers(file.path)) return file;
    const rowsOf = (side: "old" | "new", needed: boolean) => {
      if (!needed) return new Set<number>();
      // A rename's old side is read, and parsed, as the file it was: `.js` renamed to `.ts` was JavaScript.
      const path = side === "old" ? (file.oldPath ?? file.path) : file.path;
      const text = textOf(path, side);
      if (text === undefined || text.length > LONGEST_PARSED) return null;
      return syntax.parse(path, text)?.commentRows ?? null;
    };
    const newRows = rowsOf(
      "new",
      file.hunks.some((hunk) => hunk.lines.some(([sign]) => sign !== "-")),
    );
    const oldRows = rowsOf("old", file.removed > 0);
    if (newRows === null || oldRows === null) return file;
    return {
      ...file,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        comments: hunk.lines.flatMap(([sign, oldNumber, newNumber], index) => {
          const [rows, number] = sign === "-" ? [oldRows, oldNumber] : [newRows, newNumber];
          return number !== null && rows.has(number - 1) ? [index] : [];
        }),
      })),
    };
  });
}

/** Ours to fix only while it's open: a merged PR (re-reviewed to tune the tool, ARCH-6) is read, never pushed to. */
export const isMine = (pr: Pick<GitHubPr, "user" | "state">, me: string): boolean =>
  pr.user.login === me && pr.state === "open";

export function fetchPr(work: Workspace, clone: string, number: number, syntax?: Syntax): string {
  const gh = (args: string[]) => run(clone, "gh", args);
  const git = (args: string[]) => run(clone, "git", args);
  // `{owner}/{repo}` is filled in by gh from the clone's remote.
  const pr = JSON.parse(gh(["api", `repos/{owner}/{repo}/pulls/${number}`])) as GitHubPr;
  const repo = pr.base.repo.full_name;
  const me = gh(["api", "user", "-q", ".login"]);

  // The PR's head by its pull ref, so someone else's branch needs no checkout; the base as the remote has it now.
  git(["fetch", "-q", "origin", pr.base.ref, `pull/${number}/head`]);
  const baseCommit = git(["merge-base", baseOf(pr), pr.head.sha]);
  const show = (commit: string, path: string) => {
    try {
      return execFileSync("git", ["show", `${commit}:${path}`], {
        cwd: clone,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  };
  const diff = diffBetween(clone, baseCommit, pr.head.sha);
  // Comments marked by a parser where one reads the file, so the app hides every kind of comment, not only `//` lines.
  const files = syntax
    ? markComments(diff, syntax, (path, side) => show(side === "old" ? baseCommit : pr.head.sha, path))
    : diff;

  work.write("diff", files);
  work.write("pr", {
    repo,
    clone,
    number,
    title: pr.title,
    author: pr.user.login,
    mine: isMine(pr, me),
    base: pr.base.ref,
    head: pr.head.ref,
    baseCommit,
    headCommit: pr.head.sha,
    // The file as written, which is what check hashes again.
    diffHash: hashOf(readFileSync(work.pathOf("diff"), "utf8")),
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  });
  return `${files.length} files at ${pr.head.sha.slice(0, 7)}`;
}
