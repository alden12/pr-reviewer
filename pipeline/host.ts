/**
 * The reviewer's server side as plain web-standard handlers (DIST-2): everything the app asks a server for, so one
 * implementation serves the dev server, the `serve` command and, mounted under a path, attraverso's viewer host. A
 * handler takes a `Request` and answers a `Response`, or `undefined` for a path that isn't its own, so whoever mounts
 * it passes that on (to vite, a static file, a 404). Tied to no framework: `nodeHandler` in `serveNode.ts` adapts it to
 * `node:http`, and anything that speaks fetch (hono included) takes it as it is.
 *
 * It answers paths under `/api/` and nothing else, so vite's own requests pass by. A host mounting it under a prefix
 * (`/reviews/` in a viewer) strips the prefix first; the app asks by relative URL (`api/reviews`), so the same page
 * works at either.
 *
 * Nothing here writes to stdout: mounted in attraverso's stdio MCP process, stdout is the protocol.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewName, readingEventSchema } from "../src/review/reading.ts";
import { commitsSince, listRepos, loadInbox } from "./inbox.ts";

export interface ReviewerHostOptions {
  /** The committed reviews' folder (`reviews/`): read, never written. */
  committed: string;
  /** The runs' reviews (`.attraverso/reviews/` beside the plan, `paths.ts`): where runs write and reading is logged (KNOW-4). */
  local: string;
  /** The checkout whose repo, and the repos nested in it, the home page lists open PRs for. */
  clone: string;
}

/** A request answered, or `undefined` when the path isn't this handler's. */
export type Handler = (request: Request) => Promise<Response | undefined>;

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const status = (code: number, body = ""): Response =>
  new Response(body, { status: code, headers: { "content-type": "text/plain" } });
/** gh missing, signed out or offline: the page says so, in gh's own words. */
const failed = (error: unknown): Response => status(502, error instanceof Error ? error.message : String(error));

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Every well-named review folder under `root` that holds a `review.json`. */
const reviewNames = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root).filter((name) => isReviewName(name) && existsSync(join(root, name, "review.json")))
    : [];

export function reviewerHost({ committed, local, clone }: ReviewerHostOptions): Handler {
  const roots = { reviews: committed, "reviews.local": local } as const;

  /**
   * Every review's `review.json`, keyed by path as the app's bundled glob keys them (`../reviews/<name>/review.json`),
   * so `reviewLibrary` reads either alike. Diffs aren't in it: they are the bulk, and a page needs only its own.
   */
  const reviews = (): Response =>
    json(
      Object.fromEntries(
        Object.entries(roots).flatMap(([folder, root]) =>
          reviewNames(root).map((name) => [
            `../${folder}/${name}/review.json`,
            readJson(join(root, name, "review.json")),
          ]),
        ),
      ),
    );

  /** One review's diff: the local copy before a committed snapshot, as `reviewLibrary` prefers. */
  const diff = (name: string): Response => {
    const found = [local, committed].map((root) => join(root, name, "diff.json")).find((path) => existsSync(path));
    const data = found === undefined ? undefined : readJson(found);
    return data === undefined ? status(404) : json(data);
  };

  /** `owner/name` as GitHub has them: a login is letters, digits and hyphens; a name may hold dots, but isn't `.` or `..`. */
  const isRepo = (repo: string): boolean => {
    const [owner, name, ...rest] = repo.split("/");
    return (
      rest.length === 0 && /^[\w-]+$/.test(owner ?? "") && /^[\w.-]+$/.test(name ?? "") && ![".", ".."].includes(name!)
    );
  };

  /** The commits since a review, for its banner: `?repo=owner/name&number=7&from=<sha>`. */
  const since = (query: URLSearchParams): Promise<Response> | Response => {
    const [repo, number, from] = ["repo", "number", "from"].map((key) => query.get(key) ?? "") as [
      string,
      string,
      string,
    ];
    const valid = isRepo(repo) && /^\d+$/.test(number) && /^[0-9a-f]{7,40}$/.test(from);
    return valid ? commitsSince(repo, Number(number), from).then(json, failed) : status(400);
  };

  /** The open PRs of the ticked repos: `?repo=owner/name&repo=...`, none asked for being an empty list. */
  const inbox = (query: URLSearchParams): Promise<Response> | Response => {
    const chosen = query.getAll("repo");
    return chosen.every(isRepo) ? loadInbox([committed, local], clone, chosen).then(json, failed) : status(400);
  };

  /**
   * What the reader opens and folds back (KNOW-4), appended to a local review's `reading.jsonl` for the judge step.
   * JSON only: a page elsewhere can post plain text here without asking first, but not JSON.
   */
  const reading = async (request: Request, name: string): Promise<Response> => {
    const dir = join(local, name);
    const isJson = request.headers.get("content-type") === "application/json";
    if (!isJson || !isReviewName(name) || !existsSync(dir)) return status(404);
    const parsed = readingEventSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return status(400);
    appendFileSync(join(dir, "reading.jsonl"), `${JSON.stringify(parsed.data)}\n`);
    return new Response(null, { status: 204 });
  };

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return undefined;
    const path = url.pathname.slice(1);
    const [, route, rest] = /^api\/([^/]+)\/?(.*)$/.exec(path) ?? [];
    const name = decodeURIComponent(rest ?? "");
    const get = request.method === "GET";
    const routes: Record<string, () => Promise<Response> | Response> = {
      reviews: () => (get ? reviews() : status(405)),
      diff: () => (get && isReviewName(name) ? diff(name) : status(404)),
      repos: () => (get ? listRepos(clone).then(json, failed) : status(405)),
      inbox: () => (get ? inbox(url.searchParams) : status(405)),
      since: () => (get ? since(url.searchParams) : status(405)),
      reading: () => (request.method === "POST" ? reading(request, name) : status(405)),
    };
    return (routes[route ?? ""] ?? (() => status(404)))();
  };
}
