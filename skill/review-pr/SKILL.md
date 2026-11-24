---
name: review-pr
description: Make a review of a pull request with pr-reviewer (@traverso/pr-reviewer) - fetch, a fresh agent's review, fixes on your own PRs, folds, the narrative, a proofread and the check - then open it in the reviewer. Use when the user asks to review a PR in the reviewer, to make or update a review, or invokes /review-pr with a PR number or URL.
---

# Review a PR with pr-reviewer

Installed by `pr-reviewer install-skill`. Invoking this skill is the user asking for the whole loop: start a run, hand
each agent step to a new agent, and move the run on after each.

The command, as installed (it runs from any folder; never a bare `npx pr-reviewer`, which is someone else's package):

```bash
{{command}} <verb> ...
```

## Start

From the folder holding the user's attraverso plan (a repo's root, or a folder above several repos):

```bash
{{command}} start <pr> [--clone <path>] [--project <plan project key>]
```

- `<pr>` is a number (the repo it is run in), `owner/repo#123`, or the PR's URL, found among the checkouts under the
  folder.
- `--clone` names the checkout to read the diff from, when `start` can't choose between several (a clone and its
  worktrees; it prefers the one at the PR's head, then the one on its branch, then the main clone).
- `--project` picks the plan's project whose review rules and Next lists apply.

## The loop

At each agent step the run prints a hand-over: the step, its prompt file, the review's folder, the clone, what to read
and write, any problems to put right, a `check:` line and a `then:` line. Then:

1. **Hand the step to a new agent** (a subagent), every agent step, not only those marked `fresh`. Give it the
   hand-over: the prompt file's path, the folder, the clone (or the `work in:` checkout the fix step names), the
   attraverso project to read, and any problems listed. Tell it to write only the files named, that it may run the
   `check:` command on them, and that it must not run `done`.
2. **When it has finished, run the `then:` command yourself** (`done <name>`). It validates what the agent wrote and
   moves the run on. If it lists problems, send them back to an agent to put right (in the file named, not by
   redoing the step), then run `done` again.

One actor writing a step's files and also running its `done` is signing off its own work; Claude Code's auto mode
blocks that, and it is the human checkpoint the split keeps. So the agent writes and checks, and you move the run on.

`{{command}} status <name>` shows where a run is and its history.

## Finish

At `Done`, serve the reviewer if it isn't running (`{{command}} serve` from the plan's folder, or the PRs tab of
`attraverso viewer` when both are installed) and give the user the link to `?review=<name>`. Say in a line or two what
the review found: how many fixed, how many decisions for them, and the verdict.

**Then ask, don't go round.** The run re-reviews the fix step's commits once; any after that are listed in the
review's header as not re-reviewed, and the proofread's issues past its one send-back are notes. If either is there,
say so and ask the user whether to go again (`{{command}} back <name> review`) rather than starting another round.
