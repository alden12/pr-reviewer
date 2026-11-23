import { describe, expect, it } from "vitest";
import type { DiffLine } from "../src/diff/parseDiff.ts";
import { changedRanges, noteParagraphs, segmentHunk } from "../src/review/comments.ts";

const hunk = (lines: [DiffLine[0], string][]) => ({
  context: "",
  lines: lines.map(([sign, text], index): DiffLine => [
    sign,
    sign === "+" ? null : index + 1,
    sign === "-" ? null : index + 1,
    text,
  ]),
});
const shape = (lines: [DiffLine[0], string][]) =>
  segmentHunk(hunk(lines), "src/a.rs").map((segment) =>
    segment.kind === "line" ? "code" : `${segment.translation ? "ts" : "note"}:${segment.lineIndices.join(",")}`,
  );

describe("segmentHunk", () => {
  it("groups a doc comment into one note above its code", () => {
    expect(
      shape([
        ["+", "/// Fade the rest of the group,"],
        ["+", "/// over twelve ms."],
        ["+", "fn choke() {"],
      ]),
    ).toEqual(["note:0,1", "code"]);
  });

  it("splits a note where the kind of change does", () => {
    expect(
      shape([
        [" ", "// kept"],
        ["+", "// added"],
      ]),
    ).toEqual(["note:0", "note:1"]);
  });

  it("makes removed comment lines a note of their own, so hiding comments hides both sides", () => {
    expect(
      shape([
        ["-", "// gone"],
        ["+", "// new"],
      ]),
    ).toEqual(["note:0", "note:1"]);
  });

  it("keeps a TS: translation with its indented lines, and starts the plain comment after it anew", () => {
    expect(
      shape([
        ["+", "// TS:"],
        ["+", "//   const voice = this.voiceMut(slot);"],
        ["+", "// `as i32` narrows to a whole number."],
        ["+", "let voice = self.voice_mut(slot);"],
      ]),
    ).toEqual(["ts:0,1", "note:2", "code"]);
  });

  it("names a note by its first line's new number", () => {
    const [note] = segmentHunk(hunk([["+", "// one"]]), "src/a.ts");
    expect(note).toMatchObject({ kind: "note", firstNumber: 1 });
  });
});

describe("noteParagraphs", () => {
  it("reads a block comment as sentences, a blank line making a new paragraph", () => {
    expect(
      noteParagraphs(["/**", " * A pad's default group,", " * from its note.", " *", " * Hats share 1.", " */"]),
    ).toEqual(["A pad's default group, from its note.", "Hats share 1."]);
  });
});

describe("segmentHunk outside code", () => {
  it("leaves a Markdown bullet as a line rather than reading it as a comment", () => {
    const lines: [DiffLine[0], string][] = [
      ["+", "* a bullet, not a comment"],
      ["+", "plain text"],
    ];
    expect(segmentHunk(hunk(lines), "README.md").map((segment) => segment.kind)).toEqual(["line", "line"]);
  });
});

describe("changedRanges", () => {
  it("marks only what changed in a line changed in place", () => {
    const ranges = changedRanges(
      hunk([
        [" ", "scripts: {"],
        ["-", '"test": "a && b",'],
        ["+", '"test": "a && b && c",'],
      ]),
    );
    expect(ranges.get(1)).toEqual([15, 15]);
    expect(ranges.get(2)).toEqual([15, 20]);
  });

  it("marks nothing when the lines have little in common, or the runs differ in length", () => {
    expect(
      changedRanges(
        hunk([
          ["-", "alpha"],
          ["+", "omega zeta"],
        ]),
      ).size,
    ).toBe(0);
    expect(
      changedRanges(
        hunk([
          ["-", "one"],
          ["+", "one!"],
          ["+", "two"],
        ]),
      ).size,
    ).toBe(0);
  });
});

describe("the parser's comment marks", () => {
  const marked = (texts: string[], comments: number[]) => ({
    context: "",
    lines: texts.map((text, index): DiffLine => ["+", null, index + 1, text]),
    comments,
  });

  it("win over the prefix guess both ways", () => {
    // A CSS comment's middle line has no marker; a `*` selector line is not a comment.
    const hunk = marked(["/* the header", "   stays on top */", "* {", "  margin: 0;", "}"], [0, 1]);
    expect(segmentHunk(hunk, "src/a.css").map((segment) => segment.kind)).toEqual(["note", "line", "line", "line"]);
  });

  it("read JSX's and Python's markers off as prose", () => {
    expect(noteParagraphs(["{/* the toolbar */}"])).toEqual(["the toolbar"]);
    expect(noteParagraphs(["# a Python comment"])).toEqual(["a Python comment"]);
  });
});
