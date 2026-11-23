/**
 * The reviewer served on its own (DIST-2): the built app (`yarn build`'s one `dist/index.html`) and `host.ts`'s
 * handlers on `node:http`, so reviews, the home page's PRs and the reading log work with no dev server. `serve.ts` is
 * the command that runs it; from DIST-2's second slice, attraverso's viewer mounts the same handlers instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { reviewerHost, type ReviewerHostOptions } from "./host.ts";
import { nodeHandler } from "./serveNode.ts";
import { PAGE } from "./paths.ts";

/** The server: the host's routes, and the built page for every other path (`?review=` picks one in the page). */
export function createReviewerServer(options: ReviewerHostOptions, page = PAGE): Server {
  if (!existsSync(page)) throw new Error(`no built app at ${page}: run \`yarn build\` in the reviewer's folder first`);
  const html = readFileSync(page);
  const handle = nodeHandler(reviewerHost(options));
  return createServer((request, response) =>
    handle(request, response, () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        return response.end();
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : html);
    }),
  );
}
