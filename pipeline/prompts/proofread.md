# Proofread: does the review read right, as the reader first sees it?

`view.md` in the review's folder is the review drawn as text exactly as the app first shows it: headings, the code
that shows, every fold as one line (`[…kind] summary`), findings as `>>>` lines, code comments hidden. Read it the
way the reader will, top to bottom, and find where it doesn't do what it should. You are judging the presentation,
not the code: the review step already did that.

## What it should do

The goal: **the minimum the reader needs, clearly, and more a click away.** Read the reader's `Reading
preferences` (the reviewer's plan, project `pr-reviewer`, through the attraverso tools) and the reviewed repo's
`Review rules`; then check, at every heading and every run of code:

1. **Every heading earns its place, and matches what is under it.** A heading naming something that is folded away
   below it, or a section heading over code it doesn't describe, is wrong. So is a heading that repeats the code,
   one that only breaks up lines without saying what its part does, and a long stretch under one heading that would
   read clearer as two short steps (about 10 lines each is the aim).
2. **Like is treated alike.** Two type declarations, one shown and one folded; two near-identical functions, both in
   full; a summary that says less than its neighbour's. Inconsistency is the reader's first sign the review can't be
   trusted.
3. **What shows is worth reading.** Code that shows in full but reads as boilerplate, repetition, plumbing or data
   should be a span with a summary; say what span, and what its summary should say.
4. **What folds is safe to fold.** A fold that hides the point of a file (the change itself, a type that *is* the
   change, the step list of a pipeline) should show.
5. **Summaries tell the reader whether to open them.** `[…object] const x = { a, b and 4 more }` is a list of keys;
   a good summary says what the thing is for.
6. **Dense lines get a hint.** A line you had to read twice (a regex, a chained filter, a three-part condition)
   with no hint (`› ...` above it) should have one; a hint that only repeats its line should go.
7. **Findings sit where they are about**, and nothing that asks for the reader is behind a fold.

## Write `proofread.json`

```json
{
  "issues": [
    { "where": "pipeline/pipeline.ts, section \"Each agent step's own checks\"", "problem": "what is wrong, and what it should be instead", "back": "judge" }
  ]
}
```

- **`back`** is the step whose file is to blame: `judge` for what folds and what spans say (folds.json), `narrate`
  for headings, sections, hints, whys and the reading order (narrative.json), `review` for a finding in the wrong place.
- Be concrete: name the lines or the span, and say what it should be. The step it goes back to fixes exactly what
  you wrote.
- **An empty list means it reads right.** Don't raise taste for its own sake: the bar is that the reader would
  stumble, or read what they didn't need to.
