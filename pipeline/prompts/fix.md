# Fix: do what has a clear answer, put the rest to the reader

This is our own PR, so a finding with a clear direction is **fixed, not asked about**, the way you would while
developing. Only a real decision reaches the reader, with its options and a recommendation (`CHECK-11` in the
reviewer's plan).

## For each finding in `findings.json`

- **Clear, and right:** fix it in the checkout the hand-over's `work in:` line names (the clone, or a worktree holding
  the PR's branch; when it says none has the branch, check it out first as it says). Follow the repo's working rules:
  run its checks, commit with a message saying what and why, and push once at the end, with any plan updates in the
  same push. Record it as `fixed`.
- **A choice the reader has to make** (product direction, scope, a trade-off with no right answer): record it as a
  `decision` with at least two options, the one you recommend marked. You may sharpen the reviewer's options.
- **Right, but too big for this PR** (a refactor, a new feature, anything that would need its own review): file it
  as an item on the plan (the attraverso tools, in the project the finding's area belongs to) and record it as
  `filed` with the item. It is listed as planned, and costs no round of review.
- **Wrong, or not worth it:** record it as a `comment` with why, so the reader can see it was weighed.

Disagreeing with a finding is fine; leaving one unrecorded is not.

## Fix it once

Every commit you push is reviewed again if it is new work or fixes a finding that requests changes, for at most
one round (`pipeline/loops.ts`); after that the reader decides whether to go again. A fix that brings a new problem costs a round, so get it right the first time:

- **Fix the class, not the instance.** A finding in heuristic code (a guess at syntax, a regex over source, a list
  of special cases) usually has neighbours the reviewer didn't name. Ask what the general fix is (a real parser, a
  shared helper, a schema) before patching the one case; patching cases one at a time is how #153 went round four
  times on one scanner.
- **Test the neighbours.** Beside the case reported, write the two or three next to it (the same thing at the start
  of a line, nested, in another language, empty) and see they pass before you commit.
- **Read your own diff.** Before pushing, read `git diff` of what you're about to push as the reviewer will:
  stale comments, a name that no longer fits, a field nothing reads, a test that would pass either way.
- **One commit for the round**, with every fix in it, so the next review is one pass over one diff.
- **A nit isn't worth a risky fix.** If the clean fix for a nit is large, file it (`filed`) or record it as a
  `comment` with why, rather than rewriting working code to satisfy it. A fix that touches more than the finding's
  own lines and their tests is usually one to file.

## Write `outcomes.json`

```json
{
  "<finding id>": { "outcome": "fixed", "detail": "what changed, in a line", "commit": "sha" },
  "<finding id>": { "outcome": "decision", "body": "optional: the question, rephrased", "options": [{ "label": "...", "detail": "...", "recommended": true }, { "label": "...", "detail": "..." }] },
  "<finding id>": { "outcome": "filed", "item": "pr-reviewer:FLOW-24", "why": "why it waits for its own PR" },
  "<finding id>": { "outcome": "comment", "why": "why it stays a comment" }
}
```

The run fetches the diff again after this, so the review is of the head you pushed. A fixed finding's anchor may be
gone by then, which is fine: fixed ones are listed, not anchored.

Check what you wrote with the hand-over's `check:` line, which lists what is wrong and moves nothing on. Never run
`done`: the session driving the run does, once you have finished.
