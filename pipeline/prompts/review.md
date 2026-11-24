# Review: find what is wrong, in every changed file

You did not write this PR. Assume it is wrong somewhere and go looking. Report; change nothing.

## Read first

- `pr.json` and `diff.json` in the review's folder: what changed and where.
- **The reviewed repo's attraverso plan**, through the attraverso tools: `get_project` (direction and protocol),
  then `search_plan` for the items the PR names and the areas it touches. Its context section `Review rules`, if
  there is one, says which files are what in this repo. Decisions already recorded there are not findings to
  reopen; a PR that contradicts one is.
- The repo's `CLAUDE.md` files (root and any nearer the changed files): its conventions are the bar.
- The surrounding code, not only the hunks, whenever a change's correctness depends on it (`git -C <clone> show
  <headCommit>:<path>`).

## What to look for

1. **Correctness and omissions.** Bugs, wrong edge cases (empty, zero, one, the largest, a reload mid-way, a
   message arriving late), races, resources not freed, state that can go stale. Comments and docs that say what
   the code doesn't do. What the PR or its items claim that isn't there.
2. **The repo's conventions**, everything its `CLAUDE.md` asks. Code written unlike its neighbours.
3. **Duplication.** Search the whole repo for a helper, type or pattern that already does what new code does
   again. Name the existing thing.
4. **Complexity.** A simpler design for the same job; options nothing needs yet; dead code; indirection that hides.
5. **Structure.** Files past a few hundred lines or doing several jobs; module boundaries crossed.
6. **Tests.** Paths with no test, and tests that would pass whether or not the code worked.
7. **Dependencies and automation.** A new dependency and what it costs; a manual step a script or check could do.

**Every file is reviewed, including ones that will fold** (lockfiles aside): config and data hide bugs too. Fewer,
solid findings beat many hunches. No praise, nothing you can't point to a line for.

## An earlier review

When the hand-over says **`since:`**, this PR was reviewed before, at that commit, and `findings.json` already holds
that review. Build on it rather than starting again:

- **Review only the new commits** (the `git diff` the hand-over names), with the same care, and the earlier
  findings in mind: a new commit may fix one, or break something it relied on.
- **Keep every earlier finding.** What became of each is recorded separately; dropping one loses that. Re-anchor any
  whose `match` is no longer on a non-removed line of the new `diff.json` (a nearby line in the same file is fine).
  Leave its body as it was: whether new code fixed it is the fix step's call. What a partial fix leaves undone is a
  new finding.
- **`files`** still names every path in the new `diff.json`: add the new ones, and replace the line for any file the
  new commits changed with one saying what has now been checked in it, across both passes: every changed file's
  line, including ones that only needed a glance.
- **New findings get their `item` the same way as on a first review** (`search_plan`); an earlier finding keeps its
  own.

On a re-run, read the plan (`get_project`, `search_plan`) only where the new commits need it: what earlier findings
already cite stands.

When it says **`same`**, this head was reviewed already: check `findings.json` still fits (every file listed, every
anchor on a line) and add only what is missing.

When it says **`full review`**, the branch was rewritten or a merge came in: review everything, as if for the first time, but reuse an
earlier finding's id where it is the same problem, so its history follows it.

## Write `findings.json`

```json
{
  "files": { "<every changed path>": "one line on what you checked in it" },
  "findings": [
    {
      "id": "short-kebab-id",
      "kind": "nit | question | request-changes",
      "path": "the file",
      "match": "text on the new line it is about (the first line containing it anchors it)",
      "title": "the problem, in a line",
      "body": "the evidence: the code or the rule it breaks, and for a bug the sequence that breaks it",
      "recommendation": "what to change, concretely",
      "clear": true,
      "options": [{ "label": "...", "detail": "...", "recommended": true }],
      "item": "optional: project:REF",
      "gap": false
    }
  ]
}
```

- **`item`**: when the finding is about something the plan already has an item for (`search_plan` for it: the
  attraverso tools take a `project`, which `list_projects` names, the one whose plan sits nearest the file), its
  ref as `project:REF`. One already on that project's Next list is shown only as "planned", out of the way, so this
  is what keeps a known problem from being raised again as new.
- **`gap`**: `true` for a path the tests don't cover, rather than a problem in the code. Anchor it on the untested
  code; its `recommendation` says what test to write. It is fixed like any finding, and one left open is listed with
  the tests.
- **`clear`** is whether the finding has one right answer a developer would just do. `false` means it is a
  decision for the PR's owner: give at least two `options`, and mark the one you recommend.
- `match` must be on a line that is in the diff and not removed.
- `files` names **every** path in `diff.json`; the check refuses a review with one missing.
- **The hand-over's `check:` line checks all of this for you** (every file listed, every `match` on a line, every
  unclear finding with options) and lists what is wrong, moving nothing on: run it rather than writing a checker of
  your own. Never run `done`: the session driving the run does, once you have finished.
