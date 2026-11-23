# pr-reviewer

A tool to help Alden review pull requests: show what a PR is for and how it flows, hide what doesn't
need a human, and flag only what matters.

Moved into ai-project-manager on 2026-11-19 (`apm:PLAT-10`) from its own repo, as the workspace
`packages/reviewer`, mirrored to the public `alden12/pr-reviewer` by `yarn export:reviewer` at the repo root (DIST-1)
without its plan, `docs/` or `reviews/`, which quote private repos' code. The VS Code extension (`apm:DIST-11`) is
to host it beside the plan viewer. Its pipeline reads the reviewed repo's plan through core's library, and **the dependency runs one
way**: the reviewer imports core, core never imports the reviewer.

The idea list, direction and decisions live in **`packages/reviewer/attraverso.yaml`** (project `pr-reviewer`),
served by the repo's `.mcp.json` beside the other two plan files: `get_project` with project `pr-reviewer` first
(its `protocol` section is the operating manual), `search_plan` before designing anything.

Comments in the code cite the plan with a bare item ref (`FLOW-3`, `CHECK-2.1`).

**In the public mirror**, the plan, the writing style imported below, the `review-pr` skill and the repo-root
scripts this file names are absent: they live in the private repo it is exported from. The code, its tests and
`yarn verify` are all here.

## Working rules and style

@.claude/working-rules.md
@../../.claude/style.md

## Layout

Two halves: **the pipeline** that makes a review, and **the app** that renders one.

A review is a folder under `.attraverso/reviews/<name>/` beside the plan the run was started from (this repo's root, for
its own PRs; `pipeline/paths.ts`). The app reads two files from it, which are committed so a review reads anywhere the
repo is, a phone included: `diff.json` (the PR's whole
diff) and `review.json` (everything the tool adds: steps, block headings and whys, folds, findings, decisions, what
was fixed, test gaps, followable names). The pipeline's working files sit beside them.

- `pipeline/pipeline.ts`: **the steps, in order, like a CI workflow**: read this first. Code steps are in
  `pipeline/steps/`, agent steps are prompts in `pipeline/prompts/`, the files between them and their schemas are
  `pipeline/artefacts.ts`, and `pipeline/run.ts` walks the list, keeping each review's place in `state.json`.
- `pipeline/rules.ts`: file classes and the default rules; **a repo's own rules are in its plan**, the `Review
  rules` context section (`pipeline/plan.ts` reads it, KNOW-2). Nothing in the tool names one repo's files.
- `pipeline/spans.ts` (with `imports.ts`): runs inside a hunk code can summarise (imports, types, long objects),
  as long as **the reader's `Reading preferences`** (a section of this package's own plan, KNOW-3) say.
  Every language is read by **tree-sitter** (`pipeline/syntax.ts`, ARCH-9), one table of node types per grammar
  (`pipeline/grammars.ts`: TypeScript and JavaScript, Rust, Go, Python, Kotlin, Swift, Scala); a language with no
  table falls back to `imports.ts`'s regex. The fetch step also marks each hunk's comment lines from the parse, for
  every grammar there (scripts and CSS included), so the app hides comments without parsing anything itself.
- `src/diff/parseDiff.ts`: unified diff text to data, and its zod schema.
- `src/review/schema.ts`: the zod schema for `review.json`.
- `src/review/model.ts`: joins the two, checks the annotations fit the diff (`checkReview`, run on every load and
  by the pipeline's check step), indexes followable names, and applies folds and spans (never over a finding or
  decision). The app decides nothing about what to hide: it draws what the review says.
- `src/ui/`: the components. `state.ts` is the view's reducer; `App.tsx` lays it out.
- `pipeline/host.ts`: **the server side, as web-standard handlers** (DIST-2): the reviews, the home page's PRs, the
  commits-since banner and the reading log, under `/api/`. The dev server and `serve` (`pipeline/server.ts`) mount
  them (`serveNode.ts` adapts them to `node:http`), as attraverso's viewer will from DIST-2's second slice; the app asks for
  them by relative URL. Without a server, the built file reads the committed reviews bundled into it.
- `docs/prototypes/`: the throwaway HTML prototypes this grew from. Not maintained.

## Coding conventions

Carried over from another of Alden's repos until this repo earns its own.

- **zod at every untrusted boundary** (tool inputs, parsed external data). Keep validation (reject with
  a message) distinct from coercion (clamp or normalise a trusted value).
- **Functional and declarative**: `map`/`filter`/`reduce` and immutable transforms over loops and
  mutation. No unbounded loops (`while (true)`): put the exit in the condition.
- **Full descriptive names**, lambdas included (`files.map((file) => ...)`, not `(f) =>`).
- **No nested ternaries.** One level is fine; past that use an early return, a named function or a map.
- **Object maps over `switch`** for key-based dispatch, so the cases are data.
- **Split files before they get unwieldy**: a few hundred lines or several responsibilities.
- **Leave files formatted** (`yarn format`). No em-dash characters in committed text.

## Commands

Run from `packages/reviewer` (or `yarn workspace @traverso/pr-reviewer <script>` from the root, whose `typecheck` and
`test` include this package).

- `yarn dev`: the app on http://localhost:5181.
- `yarn verify`: typecheck, lint, format check, tests and build. Run before committing.
- `yarn build`: one self-contained `dist/index.html`, so a review can be opened or shared as a file.
- `npx @traverso/pr-reviewer start|done|status|back` (`bin/pr-reviewer`, the package's `bin`, linked here by `yarn
  install`; never a bare `npx pr-reviewer`, since the registry's `pr-reviewer` is someone else's): make a review with the pipeline, started in the folder holding the plan, which
  gives the rules and Next lists. `<pr>` is a number (the repo it is run in), `owner/repo#123` or the PR's URL (found
  among the checkouts under that folder, so a plan above several repos works). It passes on where it was run from and
  runs from this folder; `yarn workspace` can't start a run, since its nested yarn records this package's folder,
  whose plan is the reviewer's own. The `review-pr` skill (`.claude/skills/` at the repo root) drives its agent steps.
  Every verb runs from the plan's folder too (usage atop `pipeline/run.ts`). Here it runs the source with vite-node,
  which compiles core's library in; installed, the build on plain Node.
- `npx @traverso/pr-reviewer serve`: the built app and its server for the reviews beside the plan, no dev server.
- `yarn build` also builds the pipeline for the package (`vite.pipeline.config.ts`: `dist/pipeline/`, and the
  tree-sitter runtime and grammars copied into `dist/grammars/`). Publish from the public mirror with `npm publish`
  (a normal release, public from `publishConfig`; only attraverso's own previews take the `alpha` tag); Alden's, never
  a session's.
- `yarn format`: Prettier.
