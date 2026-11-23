import { diffSchema, type DiffFile, type Hunk } from "../diff/parseDiff";
import { commentMarks, segmentHunk } from "./comments";
import { reviewSchema, type FollowName, type ReviewAnnotations, type Span } from "./schema";

/** Where a line is in the review: its file, which hunk (block), and which line of that hunk. */
export interface LineLocation {
  path: string;
  hunkIndex: number;
  lineIndex: number;
}

export interface Occurrence extends LineLocation {
  step: string;
  newNumber: number | null;
  text: string;
  /** The line declares it (`const`, `let` or `fn`), rather than using it. */
  defines: boolean;
}

export interface Review {
  annotations: ReviewAnnotations;
  files: Record<string, DiffFile>;
  /** The reviewable files in flow order, each with its step. */
  order: { path: string; step: string }[];
  occurrences: Record<string, Occurrence[]>;
  /** The line each review comment, and each anchored decision, sits under: the first new line containing its `match`. */
  commentAnchors: Record<string, LineLocation>;
}

/** The first new (or unchanged) line in `path` containing `match`, if any. */
export function findLine(files: Record<string, DiffFile>, path: string, match: string): LineLocation | undefined {
  const hunks = files[path]?.hunks ?? [];
  const found = hunks
    .flatMap((hunk, hunkIndex) => hunk.lines.map((line, lineIndex) => ({ line, hunkIndex, lineIndex })))
    .find(({ line: [sign, , , text] }) => sign !== "-" && text.includes(match));
  return found && { path, hunkIndex: found.hunkIndex, lineIndex: found.lineIndex };
}

/** A followable name as a regex: its dots and dollars literal. */
const literal = (name: string) => name.replace(/[.$]/g, "\\$&");
/**
 * A whole name's edges. Not `\b`: `$` is part of a name (`$state`) but not a word character, so `\b` never sits
 * beside one and a name starting or ending in `$` would never match.
 */
const NAME_START = "(?<![\\w$])";
const NAME_END = "(?![\\w$])";

/** Every name the review lets you follow, as one regex of whole names. Empty input matches nothing. */
export const namePattern = (names: Record<string, FollowName>): RegExp => {
  const keys = Object.keys(names);
  return keys.length === 0 ? /(?!)/g : new RegExp(`${NAME_START}(${keys.map(literal).join("|")})${NAME_END}`, "g");
};

/** Each followable name's places in the PR's new code, in flow order. Comments and removed lines are left out. */
export function findOccurrences(
  files: Record<string, DiffFile>,
  order: { path: string; step: string }[],
  names: Record<string, FollowName>,
): Record<string, Occurrence[]> {
  const pattern = namePattern(names);
  const places = order.flatMap(({ path, step }) =>
    (files[path]?.hunks ?? []).flatMap((hunk, hunkIndex) => {
      const isComment = commentMarks(hunk, path);
      return hunk.lines.flatMap(([sign, , newNumber, text], lineIndex) => {
        if (sign === "-" || isComment(lineIndex)) return [];
        const found = [...new Set(text.match(pattern) ?? [])];
        return found.map((name) => ({
          name,
          occurrence: {
            path,
            step,
            hunkIndex,
            lineIndex,
            newNumber,
            text: text.trim(),
            defines: new RegExp(`\\b(const|let|fn)\\s+${literal(name)}${NAME_END}`).test(text),
          },
        }));
      });
    }),
  );
  return Object.fromEntries(
    Object.keys(names).map((name) => [
      name,
      places.filter((place) => place.name === name).map((place) => place.occurrence),
    ]),
  );
}

/**
 * Problems that would make the review mislead: annotations that don't line up with the diff. Hand-written
 * annotations drift easily (a block heading per hunk, in order), so this runs on every load and in the tests.
 */
export function checkReview(annotations: ReviewAnnotations, files: Record<string, DiffFile>): string[] {
  const stepFiles = annotations.steps.flatMap((step) => step.files);
  const missing = [...stepFiles, ...annotations.tests.files]
    .filter((path) => !files[path])
    .map((path) => `${path} is in the review but not in the diff`);
  const placed = new Set([
    ...stepFiles,
    ...annotations.tests.files,
    ...annotations.notForReview.map((entry) => entry.path),
  ]);
  const unplaced = Object.keys(files)
    .filter((path) => !placed.has(path))
    .map((path) => `${path} is in the diff but in no step, test group or not-for-review`);
  const blockCounts = Object.entries(annotations.blocks)
    .filter(([path, blocks]) => files[path] && blocks.length !== files[path].hunks.length)
    .map(([path, blocks]) => `${path} has ${blocks.length} block headings for ${files[path]?.hunks.length} hunks`);
  const unanchored = [
    ...annotations.comments
      .filter((comment) => !findLine(files, comment.path, comment.match))
      .map((comment) => `comment "${comment.id}" matches no line in ${comment.path}`),
    ...annotations.decisions
      .filter((decision) => decision.path !== undefined && !findLine(files, decision.path, decision.match ?? ""))
      .map((decision) => `decision "${decision.id}" matches no line in ${decision.path}`),
  ];
  // Each `explains` names the first line of a code comment in its block.
  const strayExplains = Object.entries(annotations.blocks).flatMap(([path, blocks]) =>
    blocks.flatMap((block, hunkIndex) => {
      const hunk = files[path]?.hunks[hunkIndex];
      const starts = hunk
        ? segmentHunk(hunk, path).flatMap((segment) => (segment.kind === "note" ? [segment.firstNumber] : []))
        : [];
      return (block.explains ?? [])
        .filter((line) => !starts.includes(line))
        .map((line) => `${path} block ${hunkIndex + 1} explains line ${line}, which starts no comment there`);
    }),
  );
  // Sections and spans name new lines of their own block; one that names none would draw nothing, or in the wrong place.
  const strayLines = Object.entries(annotations.blocks).flatMap(([path, blocks]) =>
    blocks.flatMap((block, hunkIndex) => {
      const numbers = new Set(
        (files[path]?.hunks[hunkIndex]?.lines ?? []).flatMap(([sign, , newNumber]) =>
          sign !== "-" && newNumber !== null ? [newNumber] : [],
        ),
      );
      const where = `${path} block ${hunkIndex + 1}`;
      // Comment lines are hidden by default, and a hint goes with its line.
      const hunk = files[path]?.hunks[hunkIndex];
      const isComment = hunk === undefined ? () => false : commentMarks(hunk, path);
      const commentNumbers = new Set(
        (hunk?.lines ?? []).flatMap(([sign, , newNumber], lineIndex) =>
          sign !== "-" && newNumber !== null && isComment(lineIndex) ? [newNumber] : [],
        ),
      );
      return [
        ...(block.sections ?? [])
          .filter((section) => !numbers.has(section.line))
          .map((section) => `${where} has a section at line ${section.line}, which is not in it`),
        ...(block.spans ?? [])
          .filter((span) => span.from > span.to || !numbers.has(span.from) || !numbers.has(span.to))
          .map((span) => `${where} has a span ${span.from}-${span.to} whose ends are not in it`),
        ...(block.hints ?? [])
          .filter((hint) => !numbers.has(hint.line))
          .map((hint) => `${where} has a hint at line ${hint.line}, which is not in it`),
        // A hint is drawn with its line, so one on a folded span's lines (its first included) would never be seen.
        ...(block.hints ?? [])
          .filter((hint) => (block.spans ?? []).some((span) => hint.line >= span.from && hint.line <= span.to))
          .map((hint) => `${where} has a hint at line ${hint.line}, inside a folded span`),
        ...(block.hints ?? [])
          .filter((hint) => commentNumbers.has(hint.line))
          .map((hint) => `${where} has a hint at line ${hint.line}, a comment line, hidden with the comments`),
      ];
    }),
  );
  // A verdict milder than its own findings reads as a contradiction at the top of the review.
  const blocking = annotations.comments.some((comment) => comment.kind === "request-changes");
  const verdict =
    blocking && annotations.verdict !== "request-changes"
      ? [`the verdict is "${annotations.verdict}" but a finding requests changes`]
      : [];
  return [...missing, ...unplaced, ...blockCounts, ...unanchored, ...strayExplains, ...strayLines, ...verdict];
}

/** Validate a diff and its annotations (both arrive as JSON) and join them into one review. */
export function loadReview(diffJson: unknown, annotationsJson: unknown): Review {
  const diff = diffSchema.parse(diffJson);
  const annotations = reviewSchema.parse(annotationsJson);
  const files = Object.fromEntries(diff.map((file) => [file.path, file]));
  const problems = checkReview(annotations, files);
  if (problems.length > 0) throw new Error(`The review doesn't fit its diff:\n- ${problems.join("\n- ")}`);
  const order = annotations.steps.flatMap((step) => step.files.map((path) => ({ path, step: step.id })));
  const anchored = [
    ...annotations.comments,
    ...annotations.decisions.flatMap((decision) =>
      decision.path !== undefined && decision.match !== undefined
        ? [{ ...decision, path: decision.path, match: decision.match }]
        : [],
    ),
  ];
  const commentAnchors = Object.fromEntries(
    anchored.flatMap((item) => {
      const location = findLine(files, item.path, item.match);
      return location ? [[item.id, location]] : [];
    }),
  );
  return { annotations, files, order, occurrences: findOccurrences(files, order, annotations.names), commentAnchors };
}

/**
 * Why a block starts folded, or null when it shows. **Never a block holding a finding or a decision**: something
 * that asks for the reader cannot be behind a click. Otherwise the review's own `fold`, which the pipeline's fold and
 * judge steps set from the repo's rules and judgement (`pipeline/steps/fold.ts`), so the app knows no rules of its own.
 * Folding is only where reading starts; any fold opens with a click.
 */
export function foldReason(review: Review, path: string, hunkIndex: number): string | null {
  return asksIn(review, path, hunkIndex).length > 0 ? null : blockFold(review, path, hunkIndex);
}

/** The lines of a block that hold a finding or a decision. */
const asksIn = (review: Review, path: string, hunkIndex: number): number[] =>
  Object.values(review.commentAnchors)
    .filter((anchor) => anchor.path === path && anchor.hunkIndex === hunkIndex)
    .map((anchor) => anchor.lineIndex);

/** Why the review folds a block, leaving aside what it holds. */
const blockFold = (review: Review, path: string, hunkIndex: number): string | null =>
  review.annotations.blocks[path]?.[hunkIndex]?.fold ?? null;

/** How many lines either side of a finding or decision show, in a block that would otherwise have folded. */
const AROUND = 4;

/** A run of a block's lines folded to one row: [from, to) by line index, what it is, and what it says. */
export interface FoldedRun {
  from: number;
  to: number;
  kind: string;
  summary: string;
}

/**
 * A span's new line numbers as line indices [from, to) in its hunk, removed lines between them included, and so are
 * the removed lines just before its first: a diff puts what a line replaced above it, so an edited import folds with
 * its old version rather than leaving the old one showing in red over a fold that hides the new (FLOW-14). Only
 * when there are no more of them than the span has lines: a longer run above is something deleted in its own right
 * (a whole function above a new import), and folding it under the span's summary would hide the deletion.
 */
function spanIndices(hunk: Hunk, span: Span): [number, number] | null {
  const inside = hunk.lines.flatMap(([, , newNumber], index) =>
    newNumber !== null && newNumber >= span.from && newNumber <= span.to ? [index] : [],
  );
  if (inside.length === 0) return null;
  const first = inside[0]!;
  const removedBefore = hunk.lines
    .slice(0, first)
    .reverse()
    .findIndex(([kind]) => kind !== "-");
  const removed = removedBefore === -1 ? first : removedBefore;
  const replaced = removed <= inside.length ? removed : 0;
  return [first - replaced, inside.at(-1)! + 1];
}

/** [from, to) without the lines in `holes`, as the runs left. */
const without = (from: number, to: number, holes: number[]): [number, number][] =>
  [...holes.filter((hole) => hole >= from && hole < to).sort((a, b) => a - b), to].reduce<{
    start: number;
    runs: [number, number][];
  }>(({ start, runs }, hole) => ({ start: hole + 1, runs: hole > start ? [...runs, [start, hole]] : runs }), {
    start: from,
    runs: [],
  }).runs;

/**
 * The runs of lines folded inside a block that shows (FLOW-4). The review's spans (imports, types, long object
 * literals, near-duplicates, each with its summary), and, in a block that would have folded but holds a finding or a
 * decision, everything more than a few lines from it: the question shows with its context, not the whole file
 * around it. Never a line that holds something, and never a single line, which saves nothing.
 */
export function foldedRuns(review: Review, path: string, hunkIndex: number): FoldedRun[] {
  const hunk = review.files[path]?.hunks[hunkIndex];
  if (hunk === undefined) return [];
  const asks = asksIn(review, path, hunkIndex);
  const spans = (review.annotations.blocks[path]?.[hunkIndex]?.spans ?? []).flatMap((span) => {
    const range = spanIndices(hunk, span);
    return range === null
      ? []
      : without(...range, asks).map(([from, to]) => ({ from, to, kind: span.kind, summary: span.summary }));
  });
  const inSpan = (index: number) => spans.some((run) => index >= run.from && index < run.to);
  const windowed = asks.length > 0 && blockFold(review, path, hunkIndex) !== null;
  const far = hunk.lines.map(
    (_, index) => windowed && !inSpan(index) && asks.every((ask) => Math.abs(ask - index) > AROUND),
  );
  const farRuns = far
    .reduce<[number, number][]>((runs, isFar, index) => {
      if (!isFar) return runs;
      const last = runs.at(-1);
      return last !== undefined && last[1] === index
        ? [...runs.slice(0, -1), [last[0], index + 1]]
        : [...runs, [index, index + 1]];
    }, [])
    .map(([from, to]) => ({ from, to, kind: "lines", summary: `${to - from} more lines` }));
  return [...spans, ...farRuns].filter((run) => run.to - run.from > 1).sort((a, b) => a.from - b.from);
}
