# Working rules

How Alden and Claude work on this repo day to day, each with its reason. Carried over from another of
Alden's repos (the parts that aren't about that repo's deploys and engine), so a cloud
session, which can't see Claude's local memory, has them too. Rules marked **(Mac)** are about his
machine and don't apply in a cloud session.

## Git and pull requests

- **Branch before committing; never commit to master.** Stage files by name, never `git add -A` or `.`.
- **Destructive git needs Alden's say-so each time:** `reset --hard`, force pushes, deleting branches,
  rewriting history.
- **Before pushing to a PR's branch, check it's still open** (`gh api repos/{owner}/{repo}/pulls/<n> -q
  .state`, REST, since a cloud session is refused the GraphQL that `gh pr view` uses); a merged one means
  branching from `origin/master` instead. Set plan items to done once their PR merges, without waiting to
  be told.
- **A ✅ at the start of a PR title is Alden's approval marker**, not GitHub's review state; never add
  it yourself. Approval isn't merging: an item goes to `done` only when its PR merges.
- **Batch pushes**, and put the plan update in the code commit before pushing, so each PR run covers a
  finished change rather than every fix.

## The plan (attraverso.yaml)

- **Change it only through the attraverso MCP tools**, never by hand: hand edits drift from the tool's
  layout and skip its ids and timestamps. If the server is down, say so and ask rather than editing.
- **`set_next` replaces the whole list**: read it first and pass the merged list.
- **`search_plan` before filing**, so a decision already recorded isn't made again weaker.
- **Keep statuses current.** Opening a PR for an item sets it to `review` in the same change; it goes
  to `done` when the PR merges. Fix a stale status as soon as you notice it.

## Code and data

- **Never state a number that wasn't measured** or read from code or a tool: run the measurement, or
  say it's an estimate or unknown. Alden decides on them.
- **No ticket refs in strings anything reads at runtime** (tool names and descriptions, UI text, error
  messages). Refs belong in code comments, commits and the plan.
- **Scratch scripts that need the repo's imports** go in `scripts/zz-<what>.ts` and are deleted after
  use; other temporary files go in the session's scratchpad.

## Reviews

- **Make a review through the pipeline** (`npx @attraverso/pr-reviewer start`, the `review-pr` skill), never by writing
  `review.json` by hand: the hand-written ones are how a stale note got past the check (ARCH-4). A step that cannot
  do what a review needs is a change to that step or its prompt, made in the open.
- **The review step is a fresh agent**, never the session that wrote the PR: it reviews what is there, not what was
  meant.
- **On our own PRs, fix what is clear and ask only what is a decision** (CHECK-11), and say what was fixed.
- **A rule about a repo's files goes in that repo's plan** (`Review rules`), never in `pipeline/rules.ts`, whose
  defaults must hold for any repo.

