# pr-reviewer

A tool to make reviewing pull requests faster and clearer: a plain summary of what a PR is for, its
files in the order the code runs, the feature's architecture as a diagram, and findings that are
mostly nits unless they really matter.

Early days. It is developed in a private monorepo beside [attraverso](https://github.com/alden12/attraverso),
whose plan files it reads, and mirrored here commit by commit, so a pull request opened here is ported in by hand.

## Using it

Early, on npm as `@traverso/pr-reviewer`. It needs Node 22, the GitHub CLI (`gh`, signed in) and an
[attraverso](https://github.com/alden12/attraverso) plan: reviews run from the folder holding your `attraverso.yaml`,
which supplies the repo's review rules, and the PR's repo is found among the checkouts under that folder.

```bash
cd <the folder holding your attraverso.yaml>
npx @traverso/pr-reviewer start owner/repo#123    # or the PR's URL, or a number for the repo you're in
npx @traverso/pr-reviewer done <name>              # after each agent step has written its files
npx @traverso/pr-reviewer status <name>
npx @traverso/pr-reviewer serve                    # the app, on http://127.0.0.1:5181
```

Some steps are code, the rest prompts for an agent such as Claude Code to follow: each hand-over prints the prompt
file, the review's folder and the command to run next (`pipeline/pipeline.ts` lists the steps in order). A review is
a folder under `.attraverso/reviews/<name>/` beside your plan: `diff.json`, the PR's whole diff, and `review.json`,
everything the tool adds, are committed so the review reads anywhere the repo is; the working files beside them are
ignored.

## Working on it

```bash
yarn install
yarn dev       # the app on http://localhost:5181
yarn verify    # typecheck, lint, format check, tests and build
```

`test/fixtures/example/` is a small made-up review to see the shape of one.

`CLAUDE.md` is the guide to working on it.

## Licence

Apache-2.0: see `LICENSE`.
