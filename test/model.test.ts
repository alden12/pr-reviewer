import { describe, expect, it } from "vitest";
import diffJson from "./fixtures/example/diff.json";
import annotationsJson from "./fixtures/example/review.json";
import { checkReview, findOccurrences, foldedRuns, foldReason, loadReview, namePattern } from "../src/review/model.ts";
import { reviewSchema } from "../src/review/schema.ts";
import type { DiffFile } from "../src/diff/parseDiff.ts";

// A made-up PR on a made-up repo, so the suite needs no real review (the committed ones stay out of the public mirror).
describe("the example review", () => {
  it("fits its diff", () => {
    expect(() => loadReview(diffJson, annotationsJson)).not.toThrow();
  });

  it("finds a defined name's definition and its uses", () => {
    const review = loadReview(diffJson, annotationsJson);
    const retryFor = review.occurrences.retryFor ?? [];
    expect(retryFor.filter((place) => place.defines).map((place) => place.path)).toEqual(["src/client.ts"]);
    expect(retryFor.filter((place) => !place.defines).map((place) => place.newNumber)).toEqual([15]);
  });

  it("traces retries through every step but leaves out comments", () => {
    const review = loadReview(diffJson, annotationsJson);
    const places = review.occurrences.retries ?? [];
    expect(new Set(places.map((place) => place.step))).toEqual(new Set(["config", "client", "app"]));
    expect(places.some((place) => /^(\/\/|\/\*)/.test(place.text))).toBe(false);
  });
});

describe("checkReview", () => {
  const file: DiffFile = {
    path: "a.ts",
    added: 1,
    removed: 0,
    hunks: [{ context: "", lines: [["+", null, 1, "const x = 1;"]] }],
  };
  const base = reviewSchema.parse(annotationsJson);
  const minimal = {
    ...base,
    steps: [{ id: "one", title: "One", files: ["a.ts"] }],
    blocks: {},
    comments: [],
    tests: { ...base.tests, files: [] },
  };

  it("passes a review that fits", () => {
    expect(checkReview(minimal, { "a.ts": file })).toEqual([]);
  });

  it("catches a block heading per hunk going out of step", () => {
    const problems = checkReview(
      { ...minimal, blocks: { "a.ts": [{ title: "One" }, { title: "Two" }] } },
      { "a.ts": file },
    );
    expect(problems).toEqual(["a.ts has 2 block headings for 1 hunks"]);
  });

  it("catches a file the review forgot to place", () => {
    expect(checkReview(minimal, { "a.ts": file, "b.ts": { ...file, path: "b.ts" } })).toEqual([
      "b.ts is in the diff but in no step, test group or not-for-review",
    ]);
  });

  it("catches a hint that would never be drawn: outside its block, on a folded span's lines, or on a comment", () => {
    const hinted: DiffFile = {
      path: "a.ts",
      added: 4,
      removed: 0,
      hunks: [
        {
          context: "",
          lines: [
            ["+", null, 1, 'import { a } from "./a";'],
            ["+", null, 2, 'import { b } from "./b";'],
            ["+", null, 3, "// why"],
            ["+", null, 4, "const x = a + b;"],
          ],
        },
      ],
    };
    const hints = [1, 2, 3, 4, 9].map((line) => ({ line, text: "a hint" }));
    const spans = [{ from: 1, to: 2, kind: "imports" as const, summary: "imports" }];
    expect(checkReview({ ...minimal, blocks: { "a.ts": [{ title: "A", hints, spans }] } }, { "a.ts": hinted })).toEqual(
      [
        "a.ts block 1 has a hint at line 9, which is not in it",
        "a.ts block 1 has a hint at line 1, inside a folded span",
        "a.ts block 1 has a hint at line 2, inside a folded span",
        "a.ts block 1 has a hint at line 3, a comment line, hidden with the comments",
      ],
    );
  });

  it("catches a comment whose anchor isn't there", () => {
    const comment = { ...base.comments[0]!, path: "a.ts", match: "nowhere" };
    expect(checkReview({ ...minimal, comments: [comment] }, { "a.ts": file })).toEqual([
      `comment "${comment.id}" matches no line in a.ts`,
    ]);
  });
});

describe("checkReview's verdict", () => {
  const file: DiffFile = {
    path: "a.ts",
    added: 1,
    removed: 0,
    hunks: [{ context: "", lines: [["+", null, 1, "const x = 1;"]] }],
  };
  const base = reviewSchema.parse(annotationsJson);
  const blocking = { ...base.comments[0]!, kind: "request-changes" as const, path: "a.ts", match: "const x" };
  const review = {
    ...base,
    steps: [{ id: "one", title: "One", files: ["a.ts"] }],
    blocks: {},
    comments: [blocking],
    tests: { ...base.tests, files: [] },
  };

  it("catches a verdict milder than a finding that requests changes", () => {
    expect(checkReview({ ...review, verdict: "comment" }, { "a.ts": file })).toEqual([
      'the verdict is "comment" but a finding requests changes',
    ]);
    expect(checkReview({ ...review, verdict: "request-changes" }, { "a.ts": file })).toEqual([]);
  });
});

describe("findOccurrences", () => {
  it("skips removed lines", () => {
    const file: DiffFile = {
      path: "a.ts",
      added: 1,
      removed: 1,
      hunks: [
        {
          context: "",
          lines: [
            ["-", 1, null, "old(name)"],
            ["+", null, 1, "new(name)"],
          ],
        },
      ],
    };
    const found = findOccurrences({ "a.ts": file }, [{ path: "a.ts", step: "one" }], { name: {} });
    expect(found.name?.map((place) => place.text)).toEqual(["new(name)"]);
  });
});

describe("foldReason", () => {
  const added = (count: number) => ({
    context: "",
    lines: Array.from({ length: count }, (_, index): DiffFile["hunks"][number]["lines"][number] => [
      "+",
      null,
      index + 1,
      `line ${index}`,
    ]),
  });
  const reviewOf = (files: DiffFile[], extra: Partial<ReturnType<typeof reviewSchema.parse>> = {}) => {
    const base = reviewSchema.parse(annotationsJson);
    const annotations = {
      ...base,
      steps: [{ id: "one", title: "One", files: files.map((file) => file.path) }],
      blocks: {},
      comments: [],
      decisions: [],
      tests: { ...base.tests, files: [], gaps: [] },
      ...extra,
    };
    return loadReview(files, annotations);
  };
  const newFile = (path: string, count: number): DiffFile => ({
    path,
    added: count,
    removed: 0,
    hunks: [added(count)],
  });

  it("folds what the review folds, but never a block holding a decision", () => {
    const decision = {
      id: "d",
      title: "Which way?",
      body: "",
      path: "GUIDE.md",
      match: "line 3",
      options: [
        { label: "This", detail: "" },
        { label: "That", detail: "" },
      ],
    };
    const review = reviewOf([newFile("GUIDE.md", 30), newFile("yarn.lock", 3), newFile("src/feature.ts", 30)], {
      decisions: [decision],
      blocks: {
        "GUIDE.md": [{ title: "The guide", fold: "new file" }],
        "yarn.lock": [{ title: "Lockfile", fold: "generated" }],
      },
    });
    expect(foldReason(review, "GUIDE.md", 0)).toBeNull();
    expect(foldReason(review, "yarn.lock", 0)).toBe("generated");
    expect(foldReason(review, "src/feature.ts", 0)).toBeNull();
  });

  it("shows only the lines around a question in a block that would have folded, and folds imports in code", () => {
    const decision = {
      id: "d",
      title: "Which way?",
      body: "",
      path: "GUIDE.md",
      match: "line 20",
      options: [
        { label: "This", detail: "" },
        { label: "That", detail: "" },
      ],
    };
    const code: DiffFile = {
      path: "src/main.ts",
      added: 6,
      removed: 0,
      hunks: [
        {
          context: "",
          lines: [
            ["+", null, 1, 'import { a } from "./a";'],
            ["+", null, 2, 'import { b } from "./b";'],
            ["+", null, 3, 'import { c } from "./c";'],
            ["+", null, 4, ""],
            ["+", null, 5, "const x = a + b + c;"],
            ["+", null, 6, "export default x;"],
          ],
        },
      ],
    };
    const review = reviewOf([newFile("GUIDE.md", 40), code], {
      decisions: [decision],
      blocks: {
        "GUIDE.md": [{ title: "The guide", fold: "new file" }],
        "src/main.ts": [{ title: "Main", spans: [{ from: 1, to: 3, kind: "imports", summary: "3 import lines" }] }],
      },
    });
    // "line 20" is line index 20: four lines either side show, the rest fold.
    expect(foldedRuns(review, "GUIDE.md", 0)).toEqual([
      { from: 0, to: 16, kind: "lines", summary: "16 more lines" },
      { from: 25, to: 40, kind: "lines", summary: "15 more lines" },
    ]);
    expect(foldedRuns(review, "src/main.ts", 0)).toEqual([
      { from: 0, to: 3, kind: "imports", summary: "3 import lines" },
    ]);
  });

  it("folds an edited line's old version with the span over its new one (FLOW-14)", () => {
    const file: DiffFile = {
      path: "src/b.ts",
      added: 2,
      removed: 1,
      hunks: [
        {
          context: "",
          lines: [
            [" ", 15, 15, 'import { x } from "./x";'],
            ["-", 16, null, 'import type { A } from "./a";'],
            ["+", null, 16, 'import { a, type A } from "./a";'],
            ["+", null, 17, 'import { b } from "./b";'],
            [" ", 17, 18, ""],
            ["-", 18, null, "const old = 1;"],
            [" ", 19, 19, "const kept = 2;"],
          ],
        },
      ],
    };
    const review = reviewOf([file], {
      blocks: { "src/b.ts": [{ title: "B", spans: [{ from: 16, to: 17, kind: "imports", summary: "imports" }] }] },
    });
    // The removed import above the span folds with it; a removed line after it, and the context, stay.
    expect(foldedRuns(review, "src/b.ts", 0).map((run) => [run.from, run.to])).toEqual([[1, 4]]);
  });

  it("leaves a deletion longer than the span showing, rather than folding it under the span's summary", () => {
    const file: DiffFile = {
      path: "src/c.ts",
      added: 2,
      removed: 3,
      hunks: [
        {
          context: "",
          lines: [
            ["-", 1, null, "function gone() {"],
            ["-", 2, null, "  return 1;"],
            ["-", 3, null, "}"],
            ["+", null, 1, 'import { a } from "./a";'],
            ["+", null, 2, 'import { b } from "./b";'],
            [" ", 4, 3, ""],
          ],
        },
      ],
    };
    const review = reviewOf([file], {
      blocks: { "src/c.ts": [{ title: "C", spans: [{ from: 1, to: 2, kind: "imports", summary: "imports" }] }] },
    });
    // Three removed lines above a two-line span are not its old version: only the new imports fold.
    expect(foldedRuns(review, "src/c.ts", 0).map((run) => [run.from, run.to])).toEqual([[3, 5]]);
  });

  it("splits a span around a line that asks something, and refuses one that lands outside its block", () => {
    const comment = { ...reviewSchema.parse(annotationsJson).comments[0]!, path: "src/a.ts", match: "line 5" };
    const file = newFile("src/a.ts", 10);
    const review = reviewOf([file], {
      comments: [comment],
      blocks: { "src/a.ts": [{ title: "A", spans: [{ from: 2, to: 9, kind: "types", summary: "interface A" }] }] },
    });
    // New line 6 is index 5, "line 5": the span folds either side of it.
    expect(foldedRuns(review, "src/a.ts", 0).map((run) => [run.from, run.to])).toEqual([
      [1, 5],
      [6, 9],
    ]);
    const annotations = {
      ...review.annotations,
      blocks: {
        "src/a.ts": [
          { title: "A", spans: [{ from: 2, to: 40, kind: "x", summary: "" }], sections: [{ line: 99, title: "Off" }] },
        ],
      },
    };
    expect(checkReview(annotations, review.files)).toEqual([
      "src/a.ts block 1 has a section at line 99, which is not in it",
      "src/a.ts block 1 has a span 2-40 whose ends are not in it",
    ]);
  });
});

describe("namePattern", () => {
  const matches = (names: string[], text: string) =>
    [...text.matchAll(namePattern(Object.fromEntries(names.map((name) => [name, {}]))))].map((match) => match[1]);

  it("matches whole names, a dollar at either end included", () => {
    expect(matches(["$state"], "let x = $state(1);")).toEqual(["$state"]);
    expect(matches(["el$"], "const el$ = ref; use(el$)")).toEqual(["el$", "el$"]);
    expect(matches(["state"], "let x = $state(1); state.go()")).toEqual(["state"]);
    expect(matches(["run"], "rerun(); run(); runner()")).toEqual(["run"]);
    expect(matches(["work.read"], "work.read(x); work.reads")).toEqual(["work.read"]);
  });
});
