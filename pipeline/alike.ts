/**
 * Candidates for near-duplicate code (FLOW-11): neighbouring chunks of a hunk with the same shape. Code can't tell
 * reliably whether two chunks *do* the same thing, only that they look alike once names, strings and numbers are
 * blanked out; so it proposes, and the judge step decides which become a `repeat` span, keeping one as the example.
 *
 * A chunk is a run of new lines between blank lines; two are alike when their shapes share most of their tokens.
 */
import type { Hunk } from "../src/diff/parseDiff.ts";
import { isCommentLine } from "../src/review/comments.ts";

export interface AlikeRun {
  from: number;
  to: number;
  /** How many chunks look alike, the first of which would stay shown. */
  count: number;
  /** The first chunk's opening line, to name the run. */
  first: string;
}

/** How alike two chunks' shapes must be, as the share of tokens they have in common: near the same, not merely similar. */
const ALIKE_CHUNKS = 0.9;
/** Chunks shorter than this aren't worth folding to a summary. */
const MIN_LINES = 2;

/** A line's shape: names, strings and numbers blanked, so only its structure is compared. */
const shapeOf = (text: string): string[] =>
  text
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "S")
    .replace(/\b\d+\b/g, "0")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) =>
      /^(const|let|return|if|async|await|function|export)$/.test(word) ? word : "x",
    )
    .split(/\s+|(?=[^\w\s])|(?<=[^\w\s])/)
    .filter(Boolean);

/** The share of tokens two shapes have in common, counting repeats. */
function likeness(a: string[], b: string[]): number {
  const counts = a.reduce((tally, token) => tally.set(token, (tally.get(token) ?? 0) + 1), new Map<string, number>());
  const shared = b.reduce((sum, token) => {
    const left = counts.get(token) ?? 0;
    if (left === 0) return sum;
    counts.set(token, left - 1);
    return sum + 1;
  }, 0);
  return (2 * shared) / (a.length + b.length || 1);
}

/** A chunk between blank lines, compared with its neighbour by shape. */
interface Unit {
  from: number;
  to: number;
  first: string;
  shape: string[];
}

/** Runs of two or more neighbouring chunks near-identical in shape. */
function runsOf(units: Unit[]): AlikeRun[] {
  return units
    .reduce<Unit[][]>((runs, unit) => {
      const last = runs.at(-1);
      const previous = last?.at(-1);
      return previous !== undefined && likeness(previous.shape, unit.shape) >= ALIKE_CHUNKS
        ? [...runs.slice(0, -1), [...last!, unit]]
        : [...runs, [unit]];
    }, [])
    .filter((run) => run.length >= 2)
    .map((run) => ({ from: run[0]!.from, to: run.at(-1)!.to, count: run.length, first: run[0]!.first }));
}

/**
 * The runs of alike chunks in a hunk (between blank lines, comments aside), new line numbers, outside anything in
 * `hidden` (already folded). Chunks only, and only near-identical ones: comparing line by line was tried, and flagged
 * every run of JSX attributes and object properties on #153. Better a few candidates the judge can trust, since it
 * looks beyond them too and the proofread catches what slips.
 */
export function alikeRuns(hunk: Hunk, hidden: (number: number) => boolean): AlikeRun[] {
  const lines = hunk.lines.flatMap(([sign, , number, text]) =>
    sign !== "-" && number !== null && !hidden(number) ? [{ number, text }] : [],
  );
  const code = (line: { text: string }) => line.text.trim() !== "" && !isCommentLine(line.text);
  const chunks = lines
    .reduce<{ number: number; text: string }[][]>((found, line) => {
      const last = found.at(-1);
      if (line.text.trim() === "") return last?.length === 0 ? found : [...found, []];
      return last === undefined ? [[line]] : [...found.slice(0, -1), [...last, line]];
    }, [])
    .filter((chunk) => chunk.filter(code).length >= MIN_LINES)
    .map((chunk): Unit => {
      const codeLines = chunk.filter(code);
      // Comments are hidden by default, and differ more than code does: compare the code only.
      return {
        from: chunk[0]!.number,
        to: chunk.at(-1)!.number,
        first: codeLines[0]!.text.trim(),
        shape: codeLines.flatMap((line) => shapeOf(line.text)),
      };
    });
  return runsOf(chunks);
}
