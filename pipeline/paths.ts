/**
 * Where the reviewer's own files are (DIST-1.2), the same whether the pipeline runs from source (`pipeline/*.ts`
 * through vite-node) or from the package's build (`dist/pipeline/*.js` on plain Node): everything is found from the
 * package's root, the nearest folder above this file holding its `package.json`, rather than from this file's own
 * folder, which differs between the two.
 *
 * And where a run's reviews go (DIST-1.3): `.attraverso/reviews/<name>/` beside the plan the run was started from,
 * never inside the package, which an install puts in `node_modules`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const rootFrom = (folder: string): string =>
  existsSync(join(folder, "package.json")) || dirname(folder) === folder ? folder : rootFrom(dirname(folder));

/** The package's root folder. */
export const PACKAGE = rootFrom(import.meta.dirname);

/** The agent steps' prompts, shipped as they are. */
export const PROMPTS = join(PACKAGE, "pipeline", "prompts");

/** The `review-pr` skill the package ships, which `install-skill` copies where a session finds it. */
export const SKILL = join(PACKAGE, "skill", "review-pr", "SKILL.md");

/** The command a hand-over tells the driving agent to run next, by its full path (see `run.ts`). */
export const BIN = join(PACKAGE, "bin", "pr-reviewer");

/** The built app, one file. */
export const PAGE = join(PACKAGE, "dist", "index.html");

/** Whether this is the package's build running (`dist/pipeline/`), rather than the source: by this package's own path. */
export const RUNS_BUILT = import.meta.dirname.startsWith(join(PACKAGE, "dist") + sep);

/** The grammars the build copies in (DIST-1.1), which the build reads; source reads them from their packages. */
export const BUILT_GRAMMARS = join(PACKAGE, "dist", "grammars");

/**
 * What a review folder keeps in git: the two files the app reads, so a review reads anywhere the repo is (a phone
 * included); the working files beside them are the run's and stay out.
 */
const IGNORED =
  "# Written by pr-reviewer: a review's working files stay out, what the app reads is committed.\n*/*\n!*/diff.json\n!*/review.json\n";

/** Where the reviews of runs started from `plan`'s folder go, made or not: for a reader, which makes nothing. */
export const reviewsFolderOf = (plan: string): string => join(dirname(plan), ".attraverso", "reviews");

/** The reviews of runs started from `plan`'s folder, made with its `.gitignore` the first time. */
export function reviewsOf(plan: string): string {
  const folder = reviewsFolderOf(plan);
  if (!existsSync(join(folder, ".gitignore"))) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ".gitignore"), IGNORED);
  }
  return folder;
}
