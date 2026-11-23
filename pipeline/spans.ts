/**
 * The runs of lines code can recognise as reading through a summary (FLOW-4): imports, type declarations, and long
 * object literals or destructuring, found by tree-sitter in every language `grammars.ts` has a table for. Each becomes a span with a one-line summary; the judge step adds the ones only
 * judgement finds (near-duplicates, FLOW-11) and may drop or reword these. How long each must be is the reader's
 * `Reading preferences` (KNOW-3), so nothing here is a fixed taste.
 *
 * Read on the new side of the hunk only: added and unchanged lines, by new line number.
 */
import type { Hunk } from "../src/diff/parseDiff.ts";
import type { Span } from "../src/review/schema.ts";
import { importLines } from "./imports.ts";
import { LONGEST_PARSED, type Syntax, type SyntaxNode } from "./syntax.ts";

/** How long each kind must be to fold; `false` never folds it. The reader's preferences override these. */
export interface SpanPreferences {
  imports: boolean;
  /** Lines a type declaration must reach. */
  types: number | false;
  /** Lines an object literal or destructuring must reach. */
  objects: number | false;
}
export const DEFAULT_SPAN_PREFERENCES: SpanPreferences = { imports: true, types: 2, objects: 8 };

interface NewLine {
  number: number;
  text: string;
}

/** "a, b, c and 3 more". */
export const listed = (keys: string[], shown = 4): string =>
  keys.length <= shown ? keys.join(", ") : `${keys.slice(0, shown).join(", ")} and ${keys.length - shown} more`;

/**
 * The spans code finds in one hunk of `path`. A real parser reads the code, so strings, regexes, templates
 * and JSX are what they are, not guessed from the characters around a bracket (an earlier scanner was, and broke
 * three ways in three fixes). Given the whole file at the head (`fileText`), it parses that and keeps the spans inside
 * the hunk, so a hunk that starts inside a comment or a template string reads right; without it, the hunk's own lines.
 * Outermost first, and never two spans sharing a line: a span found is not looked inside.
 */
export function findSpans(
  path: string,
  hunk: Hunk,
  preferences: SpanPreferences,
  fileText?: string,
  /** Tree-sitter's parsers (`loadSyntax`); without them, or for a language with no grammar, imports fall back to the regex. */
  syntax?: Syntax,
): Span[] {
  const hunkLines: NewLine[] = hunk.lines.flatMap(([sign, , number, text]) =>
    sign !== "-" && number !== null ? [{ number, text }] : [],
  );
  // Imports by the regex only where no parser can read the file (no grammar for it, or too long); otherwise by one.
  // The regex's guess at imports, for when the file can't be parsed: worked out only then.
  const byRegex = (): Span[] => {
    if (!preferences.imports) return [];
    const guessed = importLines(
      path,
      hunkLines.map((line) => line.text),
    );
    return importSpans(hunkLines, (_, index) => guessed[index]!);
  };
  // The whole file when it is given and not too long to parse; otherwise the hunk's own lines.
  const whole = fileText !== undefined && fileText.length <= LONGEST_PARSED;
  const lines = whole ? fileText.split("\n").map((text, index) => ({ number: index + 1, text })) : hunkLines;
  const source = lines.map((line) => line.text).join("\n");
  if (source.length > LONGEST_PARSED) return byRegex();
  const parsed = syntax?.parse(path, source) ?? null;
  if (parsed === null) return byRegex();
  const inHunk = new Set(hunkLines.map((line) => line.number));
  // A declaration that was there before and changed inside (a key added, removed or edited, beside lines that stayed)
  // is looked inside rather than folded whole, since the edit is the point of the hunk. One that is new from its first
  // line to its last can fold. Unchanged lines say "it was there"; added lines, or a new line straight after a removed
  // one, say "and it changed".
  const signs = new Map(
    hunk.lines.flatMap(([sign, , number]) => (sign !== "-" && number !== null ? [[number, sign] as const] : [])),
  );
  const afterRemoved = new Set(
    hunk.lines.flatMap(([sign, , number], index) =>
      sign !== "-" && number !== null && hunk.lines[index - 1]?.[0] === "-" ? [number] : [],
    ),
  );
  const editedInside = (span: Span) => {
    const numbers = Array.from({ length: span.to - span.from + 1 }, (_, offset) => span.from + offset);
    const removedInside = numbers.some((number) => number > span.from && afterRemoved.has(number));
    const kept = numbers.some((number) => signs.get(number) === " ");
    const added = numbers.some((number) => signs.get(number) === "+");
    return removedInside || (kept && added);
  };
  const importNumbers = new Set([...parsed.importRows].map((row) => lines[row]!.number));
  const imports = preferences.imports ? importSpans(hunkLines, (line) => importNumbers.has(line.number)) : [];
  const spanOf = (node: SyntaxNode): Span | null => {
    const found = node.described;
    if (found === null) return null;
    const minimum = preferences[found.kind === "types" ? "types" : "objects"];
    const { from, to } = node;
    if (minimum === false || to - from + 1 < minimum) return null;
    // The summary starts where the node's own line does, never with a neighbour's closer (`} = {`).
    const opening = lines[from]!.text.trim().replace(/^[}\])]+[,;]?\s*(=\s*)?/, "");
    const summary =
      found.kind === "types"
        ? `${found.name}${found.keys.length > 0 ? `: ${listed(found.keys)}` : ""}`
        : `${opening.replace(/\s*[({]+\s*$/, "")} { ${listed(found.keys)} }`.trim();
    return { from: lines[from]!.number, to: lines[to]!.number, kind: found.kind, summary };
  };
  // A span that reaches past the hunk (the object a hunk sits inside) isn't this hunk's: look inside it instead.
  const visit = (node: SyntaxNode): Span[] => {
    const span = spanOf(node);
    const fits = span !== null && inHunk.has(span.from) && inHunk.has(span.to) && !editedInside(span);
    return fits ? [span] : node.children().flatMap(visit);
  };
  const found = visit(parsed.root)
    .sort((a, b) => a.from - b.from)
    .reduce<Span[]>((kept, span) => {
      const last = kept.at(-1);
      return last !== undefined && span.from <= last.to ? kept : [...kept, span];
    }, []);
  return [...imports, ...runsOfTypes(found, lines)].sort((a, b) => a.from - b.from);
}

/** Runs of import lines, at least two long. */
function importSpans(lines: NewLine[], isImport: (line: NewLine, index: number) => boolean): Span[] {
  return lines
    .reduce<{ from: number; to: number; count: number }[]>((runs, line, index) => {
      if (!isImport(line, index)) return runs;
      const last = runs.at(-1);
      const previous = lines[index - 1];
      return last !== undefined &&
        previous !== undefined &&
        last.to === previous.number &&
        isImport(previous, index - 1)
        ? [...runs.slice(0, -1), { ...last, to: line.number, count: last.count + 1 }]
        : [...runs, { from: line.number, to: line.number, count: 1 }];
    }, [])
    .filter((run) => run.to > run.from)
    .map((run) => ({ from: run.from, to: run.to, kind: "imports", summary: `${run.count} import lines` }));
}

/**
 * Lines that can sit between two type declarations and still leave them one run: blank, a comment, an attribute
 * (Rust's `#[derive]`), a one-line type.
 */
const BETWEEN_TYPES = /^\s*($|\/\/|\/\*|\*|#\[|(export\s+|pub(\([a-z]+\))?\s+)?type\s+\w+[^{]*;\s*$)/;

/**
 * Type declarations next to each other fold as one span, `types: Context, Earlier, StepBase and 2 more`, rather than
 * one each: a reader skimming past types wants to skip them once, and a heading over the run doesn't then sit above a
 * mix of shown and folded types.
 */
function runsOfTypes(spans: Span[], lines: NewLine[]): Span[] {
  const textAt = new Map(lines.map((line) => [line.number, line.text]));
  // A declaration's name is the last word before its members, whatever its keyword (`enum class Mode: PLAY, STOP`).
  const nameOf = (span: Span) => span.summary.split(": ")[0]!.split(" ").at(-1) ?? span.summary;
  const runs = spans.reduce<{ span: Span; names: string[] }[]>((found, span) => {
    const last = found.at(-1);
    const between =
      last === undefined
        ? []
        : Array.from({ length: span.from - last.span.to - 1 }, (_, offset) => last.span.to + 1 + offset);
    const adjacent =
      last !== undefined &&
      last.span.kind === "types" &&
      span.kind === "types" &&
      between.every((number) => BETWEEN_TYPES.test(textAt.get(number) ?? ""));
    if (!adjacent) return [...found, { span, names: [nameOf(span)] }];
    // A one-line type between them folds with the run, so it is named in the summary too.
    const oneLiners = between.flatMap(
      (number) => /^\s*(?:export\s+|pub(?:\([a-z]+\))?\s+)?type\s+(\w+)/.exec(textAt.get(number) ?? "")?.[1] ?? [],
    );
    const names = [...last.names, ...oneLiners, nameOf(span)];
    return [...found.slice(0, -1), { span: { ...last.span, to: span.to }, names }];
  }, []);
  return runs.map(({ span, names }) => (names.length > 1 ? { ...span, summary: `types: ${listed(names)}` } : span));
}
