import { describe, expect, it } from "vitest";
import annotationsJson from "./fixtures/example/review.json";
import { loadReview } from "../src/review/model.ts";
import { reviewSchema } from "../src/review/schema.ts";
import { blockKey, initialState, readingEvent, shownCounts } from "../src/ui/state.ts";
import type { DiffFile } from "../src/diff/parseDiff.ts";

const lines = (sign: "+" | "-", count: number): DiffFile["hunks"][number]["lines"] =>
  Array.from({ length: count }, (_, index) => [
    sign,
    sign === "-" ? index + 1 : null,
    sign === "+" ? index + 1 : null,
    `x${index}`,
  ]);

describe("shownCounts", () => {
  const base = reviewSchema.parse(annotationsJson);
  const files: DiffFile[] = [
    { path: "a.ts", added: 3, removed: 2, hunks: [{ context: "", lines: [...lines("-", 2), ...lines("+", 3)] }] },
    { path: "yarn.lock", added: 50, removed: 0, hunks: [{ context: "", lines: lines("+", 50) }] },
    { path: "a.test.ts", added: 4, removed: 0, hunks: [{ context: "", lines: lines("+", 4) }] },
  ];
  const review = loadReview(files, {
    ...base,
    steps: [{ id: "one", title: "One", files: ["a.ts", "yarn.lock"] }],
    blocks: { "yarn.lock": [{ title: "Lockfile", fold: "generated" }] },
    comments: [],
    decisions: [],
    tests: { files: ["a.test.ts"], tested: [], gaps: [] },
  });

  it("counts only what is on screen: not folded blocks, nor the shut tests group", () => {
    expect(shownCounts(review, initialState)).toEqual({ added: 3, removed: 2 });
  });

  it("grows as the reader opens a fold or the tests, and shrinks as they collapse a file", () => {
    const opened = { ...initialState, unfolded: new Set([blockKey("yarn.lock", 0)]), openGroups: new Set(["tests"]) };
    expect(shownCounts(review, opened)).toEqual({ added: 57, removed: 2 });
    expect(shownCounts(review, { ...opened, collapsed: new Set(["a.ts"]) })).toEqual({ added: 54, removed: 0 });
  });
});

describe("readingEvent", () => {
  const base = reviewSchema.parse(annotationsJson);
  const files: DiffFile[] = [
    { path: "yarn.lock", added: 5, removed: 0, hunks: [{ context: "", lines: lines("+", 5) }] },
  ];
  const review = loadReview(files, {
    ...base,
    steps: [{ id: "one", title: "One", files: ["yarn.lock"] }],
    blocks: { "yarn.lock": [{ title: "Lockfile", fold: "generated" }] },
    comments: [],
    decisions: [],
    tests: { files: [], tested: [], gaps: [] },
  });

  it("records opening or folding back a fold by hand, with its kind, and nothing else", () => {
    const opened = readingEvent(review, { type: "add", set: "unfolded", key: blockKey("yarn.lock", 0) });
    expect(opened).toMatchObject({ action: "open", path: "yarn.lock", hunkIndex: 0, kind: "generated" });
    expect(readingEvent(review, { type: "remove", set: "unfolded", key: blockKey("yarn.lock", 0) })?.action).toBe(
      "fold",
    );
    expect(readingEvent(review, { type: "flip", flag: "showAll" })).toBeNull();
    expect(readingEvent(review, { type: "add", set: "viewed", key: "yarn.lock" })).toBeNull();
  });
});
