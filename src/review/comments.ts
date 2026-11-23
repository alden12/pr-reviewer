import type { Hunk } from "../diff/parseDiff";

/**
 * Code comments inside a block, read as prose: a run of comment lines becomes one note, so an
 * explanation the author wrote reads as a sentence rather than as code. Translation notes (`// TS:`
 * comments, a TypeScript reading above Rust, as one reviewed repo writes them) are told apart, since the review's own
 * translation does their job when it's on (FLOW-8).
 */

/**
 * Whether a file's comments are code comments, to be read as prose. Only in code: in Markdown a line starting `*` is
 * a bullet and in YAML `#` is a heading's cousin, so reading them as comments would turn a document into notes.
 */
export const commentsAreProse = (path: string): boolean => /\.(rs|ts|tsx|js|jsx|mjs|cjs)$/.test(path);

/** Comment lines, which hold prose about the code rather than code: the guess by prefix, for a hunk with no marks. */
export const isCommentLine = (text: string): boolean => /^\s*(\/\/|\/\*|\*|\*\/)/.test(text);

/**
 * Which of a hunk's lines are comments. The parser's marks when the pipeline made them (ARCH-9), which see a CSS
 * comment's unmarked middle lines and JSX's `{/* *\/}`, and leave a code line with a comment at its end as code; the
 * prefix guess otherwise, for a review from before the marks or a language with no grammar.
 */
export function commentMarks(hunk: Hunk, path: string): (lineIndex: number) => boolean {
  if (hunk.comments !== undefined) {
    const marked = new Set(hunk.comments);
    return (lineIndex) => marked.has(lineIndex);
  }
  if (!commentsAreProse(path)) return () => false;
  return (lineIndex) => isCommentLine(hunk.lines[lineIndex]?.[3] ?? "");
}

/**
 * A line with its comment marker and one following space removed: `//`, `///`, `//!`, `/**`, ` *`, `*\/`, `#`, and
 * JSX's braces around `/* *\/`.
 */
export const stripMarker = (text: string): string =>
  text.replace(/^\s*\{?\s*(\/\/\/|\/\/!|\/\/|\/\*\*|\/\*|\*\/|\*|#)\s?/, "").replace(/\s*\*\/\s*\}?\s*$/, "");

const startsTranslation = (stripped: string) => /^TS:/.test(stripped.trim());

export type Segment =
  | { kind: "line"; lineIndex: number }
  | {
      kind: "note";
      lineIndices: number[];
      sign: "+" | " " | "-";
      /** The first line's new line number: what `explains` in a review names. */
      firstNumber: number | null;
      translation: boolean;
    };

/**
 * A hunk's lines as segments: code lines one by one, and comment lines grouped into notes. A note is
 * consecutive comment lines of the same kind of change, removed ones included, so hiding comments hides both sides
 * of a reworded one. A translation note runs from its `TS:` line through the indented lines after it, so the plain
 * comment that often follows starts a note of its own.
 */
export function segmentHunk(hunk: Hunk, path: string): Segment[] {
  const isComment = commentMarks(hunk, path);
  return hunk.lines.reduce<Segment[]>((segments, [sign, , newNumber, text], lineIndex) => {
    // Removed comments are notes too, so hiding comments hides both sides of a reworded one, not only the new side.
    if (!isComment(lineIndex)) return [...segments, { kind: "line", lineIndex }];
    const stripped = stripMarker(text);
    const last = segments.at(-1);
    const continues =
      last?.kind === "note" &&
      last.sign === sign &&
      last.lineIndices.at(-1) === lineIndex - 1 &&
      !startsTranslation(stripped) &&
      (!last.translation || /^\s/.test(stripped));
    if (continues) return [...segments.slice(0, -1), { ...last, lineIndices: [...last.lineIndices, lineIndex] }];
    return [
      ...segments,
      {
        kind: "note",
        lineIndices: [lineIndex],
        sign,
        firstNumber: newNumber,
        translation: startsTranslation(stripped),
      },
    ];
  }, []);
}

/** A note's text as paragraphs: lines joined with spaces, a blank comment line starting a new paragraph. */
export function noteParagraphs(lines: string[]): string[] {
  return lines
    .map((line) => stripMarker(line).trim())
    .reduce<string[][]>(
      (paragraphs, line) =>
        line === "" ? [...paragraphs, []] : [...paragraphs.slice(0, -1), [...(paragraphs.at(-1) ?? []), line]],
      [[]],
    )
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(" "));
}

/**
 * Where a changed line actually changed, for lines changed in place: a run of removed lines straight followed by as
 * many added ones pairs them up, and each pair's common start and end are trimmed off. What is left is the change,
 * as [start, end) in each line's text. A pair with little in common is left out, since marking nearly the whole line
 * says nothing the line's colour does not.
 */
export function changedRanges(hunk: Hunk): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>();
  const lines = hunk.lines;
  const runEnd = (from: number, sign: string) => {
    const at = lines.slice(from).findIndex(([lineSign]) => lineSign !== sign);
    return at === -1 ? lines.length : from + at;
  };
  const starts = lines.flatMap(([sign], index) => (sign === "-" && lines[index - 1]?.[0] !== "-" ? [index] : []));
  starts.forEach((removedStart) => {
    const addedStart = runEnd(removedStart, "-");
    const addedEnd = runEnd(addedStart, "+");
    if (addedEnd - addedStart !== addedStart - removedStart) return;
    Array.from({ length: addedStart - removedStart }, (_, offset) => [
      removedStart + offset,
      addedStart + offset,
    ]).forEach(([removedIndex, addedIndex]) => {
      const before = lines[removedIndex!]![3];
      const after = lines[addedIndex!]![3];
      const limit = Math.min(before.length, after.length);
      const prefix = Array.from({ length: limit }).findIndex((_, at) => before[at] !== after[at]);
      const common = prefix === -1 ? limit : prefix;
      const suffixLimit = limit - common;
      const suffixAt = Array.from({ length: suffixLimit }).findIndex(
        (_, at) => before[before.length - 1 - at] !== after[after.length - 1 - at],
      );
      const suffix = suffixAt === -1 ? suffixLimit : suffixAt;
      if (common + suffix < Math.max(before.length, after.length) / 3) return;
      ranges.set(removedIndex!, [common, before.length - suffix]);
      ranges.set(addedIndex!, [common, after.length - suffix]);
    });
  });
  return ranges;
}
