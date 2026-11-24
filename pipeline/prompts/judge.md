# Judge: are the folds right, both ways?

`folds.json` has, for every hunk, whether it starts folded and why, from the repo's rules and the defaults. Folding
is only where reading starts: the reader can open any fold. The goal is **the minimal set of information the reader
needs, clearly presented, with more a click away**.

## Check both ways

- **Folded but should show:** a config change that alters behaviour, a data file that is the point of the PR, a doc
  the reader has to agree with. Set its `fold` to `null`.
- **Shown but could fold:** a mechanical change (a rename across files, a reflow, a moved block), boilerplate, a
  long new doc whose title says enough. Give it a short `fold` label (`rename`, `moved`, `reflow`, `docs`).
- Anything holding a finding or decision always shows whatever its fold says, so don't spend time there.

## Inside a block: spans

Each entry may carry `spans`: runs of new lines (`from` and `to`, inclusive new line numbers) folded to one summary
line. Code has already found imports, type declarations and long object literals; read their summaries and fix any
that say less than they could.

- **Add the ones only judgement finds: near-duplicates** (FLOW-11). The hand-over's `alike:` lines are code's
  candidates (chunks shaped alike once names and strings are blanked): look at each, and fold the ones that really
  do the same thing; code can't tell that, only that they look it. Look beyond them too. Where several blocks of code do essentially the
  same thing (four functions each calling git a slightly different way, a run of near-identical test cases), leave
  the first one shown as the example and fold the rest as one span, kind `repeat`, its summary naming what they are
  and how they differ ("3 more git calls like this: merge-base, diff, rev-parse").
- **Drop a span that hides the point**: a type that *is* the change, an object whose keys are what the PR is about.
- A span never covers a line with a finding or decision on it; the app splits around those anyway.

Set `source` on every entry you change to `judge: <why>`.

## Learn the reader

The reader's preferences are the `Reading preferences` section of the reviewer's plan (project `pr-reviewer`):
prose for you, and a yaml block the fold step reads (`spans: { imports, types, objects }`, each `false` or a line
count). Follow the prose. **When the tools serve no `pr-reviewer` project, or it has no such section (a run anywhere
but the reviewer's own repo), use the defaults and say so in your hand-back**: imports, types and long objects fold as
the fold step already folded them, and nothing else is assumed about the reader. Then read the reading logs from past reviews (`*/reading.jsonl` in the folders beside this
review's folder: each line one fold the reader opened or folded back, with its `kind`). Where a pattern holds across
more than one review (every `types` span opened, `generated` folds never opened), **propose** the change to Alden in
your hand-back rather than writing it: preferences are his to set. When he has said one outright, write it in.

## Teach the repo

When a change is about the kind of file rather than this one PR (this repo's plan files always fold; its
`fixtures/` never do), write it into the reviewed repo's attraverso plan so the next review starts from it:
the `Review rules` context section (`get_context`, then `set_context` with the whole section). It holds prose for
the reviewing agent and one fenced yaml block the code reads:

```yaml
rules:
  - match: "attraverso.yaml"     # a glob: * within a folder, ** across folders
    class: generated             # generated | data | docs | config | test | code
    fold: always                 # optional: always | never, over the class's own policy
    why: "read on the board, not as YAML"
```

Repo rules come before the defaults and the first match wins. Cite the PR as the rule's source
(`sources` on `set_context`, kind `docs`, detail the PR's URL). A one-off belongs only in `folds.json`.

Write `folds.json` back with the same shape: one entry per hunk, in order.
