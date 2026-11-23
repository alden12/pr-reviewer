import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { reviewerHost } from "./pipeline/host.ts";
import { nodeHandler } from "./pipeline/serveNode.ts";
import { reviewsOf } from "./pipeline/paths.ts";

/**
 * The reviewer's server side in the dev server (DIST-2): the same handlers the `serve` command and attraverso's viewer
 * mount, so the reviews, the home page's PRs, the commits-since banner and the reading log (KNOW-4) are answered one
 * way everywhere. Never in the build, which is a file made to be shared.
 */
const host = (): Plugin => ({
  name: "reviewer-host",
  configureServer(server) {
    const here = import.meta.dirname;
    // Runs here start from the repo's root plan, so their reviews are beside it (`paths.ts`); the public mirror, with
    // no plan above it, keeps the package's own folder.
    // Only in the monorepo, beside core: a checkout of the public mirror has no plan above it of its own, and whatever
    // is two folders up there is someone else's. (The plan's name only: this config can't load plan.ts, which imports
    // core's source.)
    const plan = join(here, "..", "..", "attraverso.yaml");
    const inMonorepo = existsSync(join(here, "..", "core", "package.json")) && existsSync(plan);
    const local = inMonorepo ? reviewsOf(plan) : join(here, "reviews.local");
    const handler = reviewerHost({ committed: join(here, "reviews"), local, clone: here });
    server.middlewares.use(nodeHandler(handler));
  },
});

// One self-contained HTML file on build, so a review can be opened or shared as a single page.
export default defineConfig({
  plugins: [react(), viteSingleFile(), host()],
  server: { port: 5181 },
  test: { include: ["test/**/*.test.ts"] },
});
