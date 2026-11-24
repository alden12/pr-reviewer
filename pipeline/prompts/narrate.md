# Narrate: the reading of the PR

The reader should get what the PR is for and how it flows without reading every line, and be able to dig into any
of it. Write for someone who knows the repo but not this change. Plain words, short; the repo's writing style
(its `CLAUDE.md`) applies.

**Every heading makes sense on its own**, read cold by someone whose eye just landed on it. The reader skims, so a
heading can't lean on the one above it, on the code below it, or on a comment the view hides:

- **Name the things, don't point at them.** No "those", "it", "neither" or "the page" standing for something said
  elsewhere: "Your PRs past the first 100 are added, and the rest counted", not "The page plus those, and how many
  open PRs neither holds".
- **Say what it does for the reader, in a whole thought**, not a compressed list of the code's nouns. If it takes a
  second read to work out what a heading means, rewrite it.
- **Don't copy the code's comments.** They are written for someone reading the code around them; say the point again
  in your own words.
- Longer and clear beats short and cryptic.

## Read

`pr.json`, `diff.json`, `findings.json`, `outcomes.json` (if there is one) and `folds.json`, plus the items the PR
names in the repo's attraverso plan, for what it was meant to do.

## Write `narrative.json`

Its shape, with every field (the optional ones marked by the notes below; `verdict` is one of the three). `blocks` is
keyed by the file's path, with one entry per hunk in the file's order, as many as `diff.json` has hunks for it:

```json
{
  "gist": "what the PR does for its user, in a sentence or two",
  "tryIt": "gh pr checkout 42 && yarn dev",
  "verdict": "approve",
  "steps": [{ "id": "load", "title": "Where the list comes from", "short": "Load", "files": ["src/load.ts"] }],
  "blocks": {
    "src/load.ts": [
      {
        "title": "what this hunk does",
        "why": "only when the title doesn't make it obvious",
        "explains": [12],
        "sections": [{ "line": 10, "title": "what the part from line 10 does", "why": "optional" }],
        "hints": [{ "line": 14, "text": "a few words on a dense line" }]
      }
    ]
  },
  "notForReview": [{ "path": "yarn.lock", "why": "the lockfile, from the package.json change" }],
  "tests": { "files": ["test/load.test.ts"], "tested": ["loading an empty list"] },
  "names": { "loadList": { "what": "reads the list from disk", "trace": true } }
}
```

- **`gist`**: what the PR does for its user, in a sentence or two. Not a list of files.
- **`tryIt`**: the command to see it working (`gh pr checkout <n> && ...`).
- **`verdict`**: `approve`, `comment` or `request-changes`. Never milder than a finding left open: one that requests
  changes and wasn't fixed means `request-changes`.
- **`steps`**: the PR in reading order, the way the change flows (where data enters, then what it passes through),
  not alphabetical. Each `{ id, title, short?, files }`. Every changed file is in a step, in `tests.files`, or in
  `notForReview` with a reason (lockfiles, the plan file, generated output).
- **`blocks`**: for each file in a step, one heading per hunk, in order: `{ title, why?, explains?, sections?,
hints? }`. The title says what the hunk does; `why` only when it isn't obvious from the title. A folded hunk still
  needs a heading, since it is what the reader sees in its place. `explains` lists the new line numbers of code
  comments worth reading as the explanation.
- **`sections`** on a block: storytelling headings inside it, `{ line, title, why? }` at the new line a part starts
  on, so wherever the eye lands there is a line saying what that part is for. **A short heading over each part of the
  story, about 10 shown lines under each**: a function, a step in it, a case. Never more than 20 lines in a row
  without one (the check sends a longer stretch back), and never a heading just to break up lines: each says what
  its part does in the story, so the block reads as a few short steps. None in a hunk short enough to read at a
  glance. A hunk that only changes comments is low value and stays out of the way: a short heading for its placeholder
  ("X's doc brought up to date"), never the behaviour it describes, which the code's own block heads. **The code's
  own comments are hidden by default**, so a section is where what's worth knowing from them goes: say it in the
  title or why, in your words, rather than leaving it in a comment the reader won't see. A folded span still gets its
  section above it: the heading is what tells the reader whether to open it.
- **`hints`** on a block: short hints above a line, `{ line, text }`, lighter than a section, like a comment the
  review writes: what a few lines or one dense line are doing, where that isn't worth a heading of its own. A
  regex, a chained filter, a condition with three parts, a number whose meaning isn't on the line. A few words
  (under ~60 characters, 100 at most), not a sentence about why: `sections` carry the story, hints only help read
  the line. Never above a line inside a folded span, and never repeating the line ("calls fetch").
- **`tests`**: `{ files, tested }`: the test files, and what they cover in a phrase each. Gaps are not yours to
  write: the review step finds them as findings, so the fix step can close them.
- **`names`**: identifiers worth clicking to follow through the diff, `{ "<name>": { what?, trace?, outside? } }`.
  Only the few that carry the change.

Findings, decisions and what was fixed are placed by the run from `findings.json` and `outcomes.json`: don't repeat
them here.

Check what you wrote with the hand-over's `check:` line, which lists what is wrong and moves nothing on. Never run
`done`: the session driving the run does, once you have finished.
