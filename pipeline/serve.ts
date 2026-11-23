/**
 * The reviewer on its own, with no dev server (DIST-2): `server.ts`'s server on loopback.
 *
 *   npx @traverso/pr-reviewer serve [--port 5181] [--clone <checkout>]
 *
 * Run from the folder holding the plan, as reviews are: it serves the reviews beside that plan (`.attraverso/reviews/`,
 * `paths.ts`) and lists the open PRs of the repos under it, or of `--clone`.
 */
import { join, resolve } from "node:path";
import { PACKAGE, reviewsOf } from "./paths.ts";
import { planIn } from "./plan.ts";
import { createReviewerServer } from "./server.ts";

// Where it was run: bin/pr-reviewer says, else yarn's INIT_CWD (the folder `yarn serve` was run in), else the cwd.
const from = process.env.PR_REVIEWER_FROM ?? process.env.INIT_CWD ?? process.cwd();
const plan = planIn(from);
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const port = Number(flag("--port") ?? 5181);
const server = createReviewerServer({
  committed: join(PACKAGE, "reviews"),
  // The reviews of runs started here, beside its plan; without one, the package's own (a checkout of it).
  local: plan === undefined ? join(PACKAGE, "reviews.local") : reviewsOf(plan),
  clone: resolve(from, flag("--clone") ?? "."),
});
// Loopback only: the reading log writes to disk, and the home page speaks to GitHub as whoever is signed in to gh.
server.listen(port, "127.0.0.1", () => console.error(`pr-reviewer on http://127.0.0.1:${port}`));
