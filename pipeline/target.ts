/**
 * Which PR a run reviews, in which checkout, with which plan (DIST-1): `start` takes a bare number, meaning the repo it
 * is run in, or names the repo, as `owner/repo#123` or the PR's URL. A named repo is found among the checkouts under
 * the folder it is run from, as the home page finds them (`nestedCheckouts`), so a run started from a folder above
 * several repos (at work, above the company's) reviews the right one. The plan is the one in that folder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { nestedCheckouts, remoteOf } from "./inbox.ts";
import { planIn } from "./plan.ts";

export interface PrRef {
  /** `owner/name`, when the argument named one. */
  repo?: string;
  number: number;
}

/** `123`, `owner/repo#123` or `https://github.com/owner/repo/pull/123` (anything after the number ignored), or null. */
export function parsePrRef(text: string): PrRef | null {
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return { number: Number(bare[1]) };
  const named =
    /^([\w-]+\/[\w.-]+)#(\d+)$/.exec(text) ??
    /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(text);
  return named ? { repo: named[1]!, number: Number(named[2]) } : null;
}

/** The PR's head, which picks between several checkouts of its repo. */
export interface PrHead {
  sha: string;
  branch: string;
}

/**
 * The checkout of `repo` at or under `root`, by its `origin` remote, as its top level (`root` may be a folder inside
 * the repo, as when a run starts in `packages/reviewer`). Standing in a checkout of it picks that one. Otherwise one
 * nested under `root`; with several (a clone and its worktrees, at work the main checkout and `android-str-1022`), the
 * one already at the PR's head, then the one on its branch, then the main clone rather than a worktree, and only when
 * that still leaves more than one does it refuse, listing them. With none it says where it looked.
 */
export async function cloneOf(repo: string, root: string, head?: () => Promise<PrHead | null>): Promise<string> {
  const wanted = repo.toLowerCase();
  const [own, ...nested] = nestedCheckouts(root);
  const matches = async (checkout: string) => (await remoteOf(checkout))?.toLowerCase() === wanted;
  if (own !== undefined && (await matches(own))) return topLevel(own);
  const found = (
    await Promise.all(nested.map(async (checkout) => ((await matches(checkout)) ? [checkout] : [])))
  ).flat();
  if (found.length === 0) {
    throw new Error(`no checkout of ${repo} in ${root} or the repos under it: clone it there, or pass --clone <path>`);
  }
  if (found.length === 1) return topLevel(found[0]!);
  const pr = (await head?.()) ?? null;
  const git = (checkout: string, args: string[]) =>
    spawnSync("git", args, { cwd: checkout, encoding: "utf8" }).stdout?.trim() ?? "";
  const tiers: ((checkout: string) => boolean)[] = [
    (checkout) => pr !== null && git(checkout, ["rev-parse", "HEAD"]) === pr.sha,
    (checkout) => pr !== null && git(checkout, ["branch", "--show-current"]) === pr.branch,
    // A main clone's git dir is its own; a linked worktree's is under the main one's.
    (checkout) => git(checkout, ["rev-parse", "--git-dir"]) === git(checkout, ["rev-parse", "--git-common-dir"]),
  ];
  for (const tier of tiers) {
    const picked = found.filter(tier);
    if (picked.length === 1) return topLevel(picked[0]!);
  }
  throw new Error(
    `${found.length} checkouts of ${repo} under ${root}, and none is the one to use (at the PR's head, on its branch, or ` +
      `the only main clone). Pass --clone with one of these: it is where the diff is read from, and where the fix ` +
      `step finds the PR's branch (the clone or one of its worktrees):\n  ${found.join("\n  ")}`,
  );
}

/**
 * The checkout of `clone`'s repo that has `branch` checked out: the clone itself, or one of its worktrees (`git worktree
 * list`). The fix step commits on the PR's branch, and at work the clone was on `main` with the branch in a worktree,
 * so "fix it in the clone" couldn't be done. Undefined when none has it.
 */
export function checkoutOn(clone: string, branch: string): string | undefined {
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: clone, encoding: "utf8" });
  if (listed.status !== 0) return undefined;
  return listed.stdout
    .split("\n\n")
    .map((entry) => ({
      path: /^worktree (.+)$/m.exec(entry)?.[1],
      branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1],
    }))
    .find((worktree) => worktree.branch === branch)?.path;
}

const topLevel = (checkout: string): string =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: checkout, encoding: "utf8" }).trim();

/**
 * The folder a run was started in, as bin/pr-reviewer passes it on. Refused without: yarn's INIT_CWD under `yarn
 * workspace` is this package's folder, which holds the reviewer's own plan, so a run started that way would take its
 * rules from the wrong plan without a word.
 */
export function runFrom(env: Record<string, string | undefined>): string {
  const from = env.PR_REVIEWER_FROM;
  if (from === undefined) {
    throw new Error("run reviews with the pr-reviewer command (npx @traverso/pr-reviewer), from your plan's folder");
  }
  return from;
}

/** The PR's head commit and branch from GitHub (REST, as fetch is), or null when it can't be asked. */
const prHead = async (repo: string, number: number): Promise<PrHead | null> => {
  const asked = spawnSync("gh", ["api", `repos/${repo}/pulls/${number}`, "-q", '.head.sha + " " + .head.ref'], {
    encoding: "utf8",
  });
  const [sha, branch] = asked.status === 0 ? asked.stdout.trim().split(" ") : [];
  return sha && branch ? { sha, branch } : null;
};

/**
 * What `start` reviews: the PR, its checkout and the run's plan. The plan is the one in `from`, refused without one.
 * `clone` (the --clone flag, relative to `from`) is taken with no search, so it settles a search that found several,
 * but must be a checkout of the repo named, when one is; otherwise a bare number is the repo `from` is in, and a named
 * repo is found under it (`cloneOf`).
 */
export async function startTarget(
  target: string,
  from: string,
  clone?: string,
): Promise<{ clone: string; plan: string; number: number }> {
  const ref = parsePrRef(target);
  if (ref === null) throw new Error(`"${target}" is not a PR: give its number, owner/repo#123, or its URL`);
  const plan = planIn(from);
  if (plan === undefined)
    throw new Error(`no attraverso plan in ${from}: start a review from the folder that holds yours`);
  if (clone === undefined) {
    const found =
      ref.repo === undefined ? topLevel(from) : await cloneOf(ref.repo, from, () => prHead(ref.repo!, ref.number));
    return { clone: found, plan, number: ref.number };
  }
  const given = resolve(from, clone);
  // GitHub is asked about the clone's own repo, so a clone of another repo would review that repo's PR of the number.
  const remote = await remoteOf(given);
  if (ref.repo !== undefined && remote?.toLowerCase() !== ref.repo.toLowerCase()) {
    throw new Error(`--clone ${given} is a checkout of ${remote ?? "no GitHub repo"}, not ${ref.repo}`);
  }
  // Its top level, as the search gives, so a subfolder doesn't name the review or narrow its plans; and refused when
  // it is no checkout at all.
  const top = (() => {
    try {
      return topLevel(given);
    } catch {
      throw new Error(`--clone ${given} is not a git checkout`);
    }
  })();
  return { clone: top, plan, number: ref.number };
}
