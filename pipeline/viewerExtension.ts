/**
 * The reviewer inside attraverso's viewer (DIST-2.2): what the package exports as `@attraverso/pr-reviewer/host`, for
 * the viewer's host to find at startup and serve under its own path when the reviewer is installed beside it. Core
 * never imports this package; it tries the import by name and does without it when it isn't there.
 *
 * The contract is core's, structural so neither package imports the other's types: `viewerExtension({ plans })` gives
 * a `prefix`, a `label` for the viewer's tab, and `handle(request)`, a web-standard handler that answers what is
 * under the prefix and returns undefined for anything else. Everything under it is this package's: `host.ts`'s routes
 * at `<prefix>/api/...` (the app asks by relative URL, so they line up) and the built app for every other path.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewerHost } from "./host.ts";
import { PACKAGE, PAGE, reviewsOf } from "./paths.ts";

const PREFIX = "/reviews";

export interface ViewerExtensionOptions {
  /** The plan files the viewer serves, its primary first: the reviews are beside that one, and its repo's PRs listed. */
  plans: string[];
}

export function viewerExtension({ plans }: ViewerExtensionOptions) {
  const plan = plans[0];
  const host = reviewerHost({
    committed: join(PACKAGE, "reviews"),
    local: plan === undefined ? join(PACKAGE, "reviews.local") : reviewsOf(plan),
    clone: plan === undefined ? process.cwd() : dirname(plan),
  });
  const page = (): Response =>
    existsSync(PAGE)
      ? new Response(readFileSync(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("The reviewer's app has not been built.", { status: 503 });

  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return undefined;
    // The page asks for `api/...` relative to itself, so it must be at the folder's URL, slash included.
    if (url.pathname === PREFIX) return Response.redirect(new URL(`${PREFIX}/${url.search}`, url), 301);
    const inner = new URL(url.pathname.slice(PREFIX.length) + url.search, url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const stripped = new Request(inner, {
      method: request.method,
      headers: request.headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    } as RequestInit);
    const answered = await host(stripped);
    if (answered !== undefined) return answered;
    return request.method === "GET" || request.method === "HEAD" ? page() : new Response(null, { status: 405 });
  };

  return { prefix: PREFIX, label: "PRs", handle };
}
