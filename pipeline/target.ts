/**
 * Which PR a run reviews, in which checkout, with which plan (DIST-1): `start` takes a bare number, meaning the repo it
 * is run in, or names the repo, as `owner/repo#123` or the PR's URL. A named repo is found among the checkouts under
 * the folder it is run from, as the home page finds them (`nestedCheckouts`), so a run started from a folder above
 * several repos (at work, above the company's) reviews the right one. The plan is the one in that folder.
 */
import { execFileSync } from "node:child_process";
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

/**
 * The checkout of `repo` at or under `root`, by its `origin` remote, as its top level (`root` may be a folder inside
 * the repo, as when a run starts in `packages/reviewer`). Standing in a checkout of it picks that one. Otherwise
 * exactly one must be nested under `root`: with several (a clone and its worktrees beside it), it refuses and lists
 * them rather than reviewing whichever sorts first, and with none it says where it looked.
 */
export async function cloneOf(repo: string, root: string): Promise<string> {
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
  if (found.length > 1) {
    throw new Error(
      `${found.length} checkouts of ${repo} under ${root}, pass --clone with one of:\n  ${found.join("\n  ")}`,
    );
  }
  return topLevel(found[0]!);
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
    const found = ref.repo === undefined ? topLevel(from) : await cloneOf(ref.repo, from);
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
