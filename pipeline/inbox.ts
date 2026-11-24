/**
 * The GitHub half of the home page (INBOX-1), for the dev server: the open PRs in this checkout's repo and the repos
 * nested in it, and the state of each PR a review on this machine is of. Over REST through `gh api`, never GraphQL,
 * which a Claude Code cloud session is refused (as `pipeline/steps/fetch.ts`).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Inbox, LocalReview, OpenPr, Since } from "../src/inbox/rows.ts";

const run = promisify(execFile);

/**
 * One REST call, tried twice: GitHub now and then answers with an empty body (seen 2026-11-22 on a commit's check runs
 * while CI was writing them), which gh reports as "unexpected end of JSON input", and the same call works a moment
 * later.
 */
const gh = async <Result>(path: string, query: Record<string, string> = {}, tries = 2): Promise<Result> => {
  const fields = Object.entries(query).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
  try {
    const { stdout } = await run("gh", ["api", "-X", "GET", path, ...fields], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as Result;
  } catch (error) {
    if (tries <= 1) throw error;
    return gh(path, query, tries - 1);
  }
};

/**
 * Lookups run at once: repos listed, or PRs' checks (two `gh` calls each, statuses and check runs together), so at
 * most about twice this many processes run: bounded, where one per PR at once was a hundred PRs' worth.
 */
const CONCURRENT_LOOKUPS = 8;

/** `each` over `items`, at most `limit` at a time, results in order. */
export async function mapLimited<Item, Result>(
  items: Item[],
  limit: number,
  each: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const worker = async (): Promise<void> => {
    const next = queue.shift();
    if (!next) return;
    results[next.index] = await each(next.item);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** An open PR as `repos/{repo}/pulls` lists it: everything a row needs but its checks. */
export interface ListedPull {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  draft?: boolean;
  user: { login: string };
  head: { sha: string };
  requested_reviewers?: { login: string }[];
}
interface SearchItem {
  number: number;
}
export interface Pull {
  head: { sha: string };
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
}
type Checks = OpenPr["checks"];

/**
 * Commit statuses and check runs at a commit, as one state: any failure fails, then anything unfinished is pending,
 * then success. Both, because a repo posts one or the other: this one a `checks` status (PLAT-7), one on plain
 * GitHub Actions only check runs. Null when nothing has run.
 */
export function combinedChecks(statuses: string[], runs: { status: string; conclusion: string | null }[]): Checks {
  const states = [
    ...statuses,
    ...runs.map((each) => {
      if (each.status !== "completed") return "pending";
      return ["success", "neutral", "skipped"].includes(each.conclusion ?? "") ? "success" : "failure";
    }),
  ];
  if (states.length === 0) return null;
  if (states.some((state) => state === "failure" || state === "error")) return "failure";
  return states.some((state) => state === "pending") ? "pending" : "success";
}

/**
 * The checks at a PR's head, or `unknown` when GitHub wouldn't say even on a second try: one PR's checks are not worth
 * the whole page, and null would claim nothing ran.
 */
async function checksAt(repo: string, sha: string): Promise<Checks> {
  const [status, checkRuns] = await Promise.all([
    gh<{ statuses: { state: string }[] }>(`repos/${repo}/commits/${sha}/status`),
    // A page of 100, GitHub's most: the default 30 could leave a failure on a later page reading as green.
    gh<{ check_runs: { status: string; conclusion: string | null }[] }>(`repos/${repo}/commits/${sha}/check-runs`, {
      per_page: "100",
    }),
  ]).catch(() => [null, null] as const);
  if (status === null || checkRuns === null) return "unknown";
  return combinedChecks(
    status.statuses.map((each) => each.state),
    checkRuns.check_runs,
  );
}

/** A listed pull as a row's PR, with its checks. */
export const toOpenPr = (repo: string, pull: ListedPull, me: string, checks: Checks): OpenPr => ({
  repo,
  number: pull.number,
  title: pull.title,
  author: pull.user.login,
  url: pull.html_url,
  createdAt: pull.created_at,
  draft: pull.draft ?? false,
  head: pull.head.sha,
  checks,
  reviewRequested: (pull.requested_reviewers ?? []).some((reviewer) => reviewer.login === me),
});

/** GitHub's most per page, and so the most open PRs one call lists for a repo. */
const PAGE = 100;

/**
 * One repo's open PRs (INBOX-1.1): one call lists them with their heads and requested reviewers, which a search then a
 * call per PR took two rounds to give. A repo with more than a page also asks search for how many there are and for
 * the reader's own past the page (theirs, and those asking for their review), so neither is lost to the cut.
 */
async function repoPulls(repo: string, me: string): Promise<{ pulls: ListedPull[]; more: number }> {
  const listed = await gh<ListedPull[]>(`repos/${repo}/pulls`, { state: "open", per_page: String(PAGE) });
  if (listed.length < PAGE) return { pulls: listed, more: 0 };
  const search = (q: string) =>
    gh<{ items: SearchItem[]; total_count: number }>("search/issues", {
      q: `is:pr is:open repo:${repo}${q}`,
      per_page: String(PAGE),
    });
  const [all, authored, requested] = await Promise.all([
    search(""),
    search(` author:${me}`),
    search(` review-requested:${me}`),
  ]);
  const have = new Set(listed.map((pull) => pull.number));
  const missing = [...new Set([...authored.items, ...requested.items].map((item) => item.number))].filter(
    (number) => !have.has(number),
  );
  const fetched = await mapLimited(missing, CONCURRENT_LOOKUPS, (number) =>
    gh<ListedPull>(`repos/${repo}/pulls/${number}`),
  );
  return { pulls: [...listed, ...fetched], more: Math.max(0, all.total_count - listed.length - fetched.length) };
}

/** The open PRs in `repos`, with their checks, and how many a repo had past what was listed. */
async function openPrs(me: string, repos: string[]): Promise<{ open: OpenPr[]; more: number }> {
  const perRepo = await mapLimited(repos, CONCURRENT_LOOKUPS, async (repo) => ({
    repo,
    ...(await repoPulls(repo, me)),
  }));
  const listed = perRepo.flatMap(({ repo, pulls }) => pulls.map((pull) => ({ repo, pull })));
  const open = await mapLimited(listed, CONCURRENT_LOOKUPS, async ({ repo, pull }) =>
    toOpenPr(repo, pull, me, await checksAt(repo, pull.head.sha)),
  );
  return { open, more: perRepo.reduce((total, each) => total + each.more, 0) };
}

/** Who `gh` is signed in as, asked once per server: it doesn't change while the server runs. */
let login: Promise<string> | undefined;
const whoAmI = (): Promise<string> =>
  (login ??= gh<{ login: string }>("user").then(
    (user) => user.login,
    (error: unknown) => {
      // A failure (offline, signed out) is asked again next time rather than remembered.
      login = undefined;
      throw error;
    },
  ));

/**
 * Merged and closed PRs, remembered for the server's life: they can't reopen into a different past, so a past review's
 * PR costs one call ever rather than one per page load. An open one is asked each time.
 */
const settled = new Map<string, Pull>();
const pullState = async (key: string): Promise<Pull | null> => {
  const known = settled.get(key);
  if (known) return known;
  const [repo, number] = key.split("#") as [string, string];
  const pull = await gh<Pull>(`repos/${repo}/pulls/${number}`).catch(() => null);
  if (pull && pull.state === "closed") settled.set(key, pull);
  return pull;
};

const readJson = <Shape>(path: string): Shape => JSON.parse(readFileSync(path, "utf8")) as Shape;

/**
 * Each review under `roots`, once by name: the PR it is of, and its run's step and last move from `state.json`. The PR comes
 * from `review.json`, or from the run's `pr.json` before assemble has written one, so a first run still going shows as
 * running rather than as no review (whose Review button would restart it).
 */
export function reviewFolders(roots: string[]): Omit<LocalReview, "prState" | "closedAt">[] {
  const found = roots.flatMap((root) =>
    existsSync(root)
      ? readdirSync(root).flatMap((name: string) => {
          const folder = join(root, name);
          const source = ["review.json", "pr.json"].map((file) => join(folder, file)).find((path) => existsSync(path));
          if (source === undefined) return [];
          try {
            const parsed = readJson<{ pr?: { repo: string; number: number }; repo?: string; number?: number }>(source);
            const pr = parsed.pr ?? { repo: parsed.repo, number: parsed.number };
            if (typeof pr.repo !== "string" || typeof pr.number !== "number") return [];
            const statePath = join(folder, "state.json");
            const state = existsSync(statePath) ? readJson<{ at: string; history: { at: string }[] }>(statePath) : null;
            const updatedAt = state?.history.at(-1)?.at ?? null;
            return [{ name, repo: pr.repo, number: pr.number, step: state?.at ?? null, updatedAt }];
          } catch {
            // A folder mid-write, or not a review: left off the list rather than failing the page.
            return [];
          }
        })
      : [],
  );
  // A review committed as a snapshot and still kept locally is one review: the copy with a run wins, as in the app's
  // library, so it is listed once and with its run's step.
  const byName = found.reduce(
    (kept, folder) => (kept.has(folder.name) && folder.step === null ? kept : kept.set(folder.name, folder)),
    new Map<string, (typeof found)[number]>(),
  );
  return [...byName.values()];
}

/**
 * The review folders of the listed repos, each with its PR's state now. A PR `gh` couldn't read (deleted, or a repo
 * this login can't see) is left off rather than shown as anything.
 */
export function joinReviews(
  folders: Omit<LocalReview, "prState" | "closedAt">[],
  pulls: Map<string, Pull | null>,
  repos: string[],
): LocalReview[] {
  return folders
    .filter((folder) => repos.includes(folder.repo))
    .flatMap((folder): LocalReview[] => {
      const pull = pulls.get(`${folder.repo}#${folder.number}`);
      if (!pull) return [];
      const prState = pull.state === "open" ? "open" : pull.merged ? "merged" : "closed";
      return [{ ...folder, prState, closedAt: pull.merged_at ?? pull.closed_at }];
    });
}

/** Folders never searched for nested repos: dependencies and build output hold none worth listing, and are large. */
const SKIPPED = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/**
 * The checkout at `root` and every git repo nested inside it (a folder with its own `.git`, a directory or a submodule's
 * file), down to `depth` levels: the repos whose PRs the home page lists.
 */
export function nestedCheckouts(root: string, depth = 4): string[] {
  const walk = (folder: string, level: number): string[] => {
    if (level > depth) return [];
    const entries = (() => {
      try {
        return readdirSync(folder, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    const nested = entries
      .filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name))
      .flatMap((entry) => walk(join(folder, entry.name), level + 1));
    const isRepo = level > 0 && entries.some((entry) => entry.name === ".git");
    return isRepo ? [folder, ...nested] : nested;
  };
  return [root, ...walk(root, 0)];
}

/** `owner/name` from a GitHub remote's URL, over SSH or HTTPS. */
export const repoFromRemote = (url: string): string | null =>
  /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;

/** A checkout's `owner/name`, from its `origin` remote; null for a folder that isn't a repo, or isn't on GitHub. */
export const remoteOf = async (checkout: string): Promise<string | null> =>
  repoFromRemote(
    (await run("git", ["remote", "get-url", "origin"], { cwd: checkout }).catch(() => ({ stdout: "" }))).stdout,
  );

/**
 * The repos the home page can list (this checkout's first, then those nested in it), read from disk with no call to
 * GitHub, so the page can offer them as a checklist before anything slow runs: a folder of many nested repos is
 * hundreds of PRs, and only the ticked repos are asked about (Alden, 2026-11-24).
 */
export async function listRepos(clone: string): Promise<{ here: string | null; repos: string[] }> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: clone }).catch(() => ({ stdout: clone }));
  const remotes = await Promise.all(nestedCheckouts(top.stdout.trim()).map(remoteOf));
  return {
    here: remotes[0] ?? null,
    repos: [...new Set(remotes.filter((remote): remote is string => remote !== null))],
  };
}

/**
 * Everything the home page shows, for the reader `gh` is signed in as; `clone` is this checkout. Only the repos in
 * `chosen` that the checkout holds are asked about: one it doesn't hold is ignored rather than trusted from a query.
 */
export async function loadInbox(reviewRoots: string[], clone: string, chosen: string[]): Promise<Inbox> {
  const [me, found] = await Promise.all([whoAmI(), listRepos(clone)]);
  const repos = found.repos.filter((repo) => chosen.includes(repo));
  // Past reviews follow the same repos as the open list.
  const folders = reviewFolders(reviewRoots).filter((folder) => repos.includes(folder.repo));
  const keys = [...new Set(folders.map((folder) => `${folder.repo}#${folder.number}`))];
  // Beside the open list rather than after it, so they add no round: a settled PR costs nothing after its first load.
  const [{ open, more }, looked] = await Promise.all([
    openPrs(me, repos),
    mapLimited(keys, CONCURRENT_LOOKUPS, async (key) => [key, await pullState(key)] as const),
  ]);
  return { me, here: found.here, open, more, reviews: joinReviews(folders, new Map(looked), repos) };
}

/** The PR's head now, and the commits after `reviewed` up to it (GitHub's compare, one call). */
export async function commitsSince(repo: string, number: number, reviewed: string): Promise<Since> {
  const pull = await gh<Pull>(`repos/${repo}/pulls/${number}`);
  if (pull.head.sha.startsWith(reviewed)) return { head: pull.head.sha, commits: [] };
  const compare = await gh<{ commits: { sha: string; html_url: string; commit: { message: string } }[] }>(
    `repos/${repo}/compare/${reviewed}...${pull.head.sha}`,
  );
  return {
    head: pull.head.sha,
    commits: compare.commits.map((each) => ({
      sha: each.sha,
      subject: each.commit.message.split("\n")[0]!,
      url: each.html_url,
    })),
  };
}
