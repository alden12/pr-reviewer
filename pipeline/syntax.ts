/**
 * One parser for every language (ARCH-9): tree-sitter, prebuilt as WASM. The runtime and most grammars are VS Code's
 * (`@vscode/tree-sitter-wasm`); `grammars.ts` says where the rest come from. A grammar names each construct as a node
 * type (`use_declaration`, `struct_item`, `line_comment`), so what a language needs is a small table of those, not a
 * hand-written recogniser: the regex this replaces for Rust's imports was one, and pattern-guessing is how the
 * bracket scanner broke three times on #153.
 *
 * The languages are `grammars.ts`, TypeScript's included (it was read by TypeScript's own compiler until this matched
 * it); a language with no entry keeps the regex in `imports.ts`.
 *
 * Loading is async (the WASM has to be instantiated) and parsing is not, so a step calls `loadSyntax` once and hands
 * the result to the sync code that reads files.
 */
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type * as TreeSitter from "@vscode/tree-sitter-wasm";
import { GRAMMARS, type Grammar } from "./grammars.ts";
import { BUILT_GRAMMARS, RUNS_BUILT } from "./paths.ts";

export type Node = TreeSitter.Node;

/** What a node is, read as a span: a type declaration with its members, or an object literal with its keys. */
export interface Described {
  kind: "types" | "object";
  name: string;
  keys: string[];
}

/** One node of a parsed file, as `spans.ts` walks it: rows are 0-based lines of the parsed text. */
export interface SyntaxNode {
  from: number;
  to: number;
  described: Described | null;
  children: () => SyntaxNode[];
}

/**
 * A parsed file: the rows import statements cover (a run of them with what sits between), the rows that are nothing
 * but comment, and the tree.
 */
export interface ParsedFile {
  importRows: Set<number>;
  commentRows: Set<number>;
  root: SyntaxNode;
}

/** Past this, a file's text is not parsed whole: one this long is generated or data. */
export const LONGEST_PARSED = 200_000;

/** The parsers a run has loaded, one per grammar. */
export interface Syntax {
  /** Whether a grammar reads this path at all. */
  covers: (path: string) => boolean;
  parse: (path: string, source: string) => ParsedFile | null;
}

let loading: Promise<Syntax> | undefined;

/** Every grammar, loaded once per process however many steps ask: the WASM runtime and each language. */
export const loadSyntax = (): Promise<Syntax> => (loading ??= load());

async function load(): Promise<Syntax> {
  const require = createRequire(import.meta.url);
  // The package's build reads the runtime and grammars it copied in (DIST-1.1), so an install needs none of the
  // packages they come from. From source they come from those packages, whether or not a build has left copies in
  // `dist/` (which could be stale), so tests always cover the source's.
  const fileOf = (wasm: string) => (RUNS_BUILT ? join(BUILT_GRAMMARS, basename(wasm)) : require.resolve(wasm));
  // A UMD bundle, so required rather than imported: an ESM import of it has no named exports.
  const runtime = RUNS_BUILT ? join(BUILT_GRAMMARS, "tree-sitter.cjs") : "@vscode/tree-sitter-wasm";
  const { Parser, Language } = require(runtime) as typeof TreeSitter;
  await Parser.init();
  const loaded = await Promise.all(
    GRAMMARS.map(async (grammar) => {
      const parser = new Parser();
      parser.setLanguage(await Language.load(fileOf(grammar.wasm)));
      return { grammar, parser };
    }),
  );
  const grammarOf = (path: string) => {
    const extension = path.split("/").pop()!.split(".").slice(1).pop();
    return loaded.find(({ grammar }) => extension !== undefined && grammar.extensions.includes(extension));
  };
  return {
    covers: (path) => grammarOf(path) !== undefined,
    parse: (path, source) => {
      const found = grammarOf(path);
      const tree = found?.parser.parse(source);
      return found && tree ? readTree(found.grammar, tree.rootNode) : null;
    },
  };
}

/** A tree-sitter tree as `spans.ts` walks it. */
function readTree(grammar: Grammar, root: Node): ParsedFile {
  const isImport = (node: Node | null): node is Node =>
    node !== null && grammar.imports.includes(node.type) && (grammar.importWhen?.(node) ?? true);
  // The next statement after a comment or two, so two imports with a comment between them stay one run.
  const nextStatement = (node: Node): Node | null => {
    const next = node.nextNamedSibling;
    return next !== null && grammar.comments.includes(next.type) ? nextStatement(next) : next;
  };
  const importRows = new Set(
    root.descendantsOfType(grammar.imports).flatMap((node) => {
      if (!isImport(node)) return [];
      const next = nextStatement(node);
      const to = isImport(next) ? next.startPosition.row - 1 : node.endPosition.row;
      return Array.from({ length: to - node.startPosition.row + 1 }, (_, offset) => node.startPosition.row + offset);
    }),
  );
  // An item's attributes start its span, so a folded struct doesn't leave its `#[derive]` behind.
  const startOf = (node: Node): number => {
    const before = node.previousNamedSibling;
    return before !== null && (grammar.leading ?? []).includes(before.type) ? startOf(before) : node.startPosition.row;
  };
  const wrap = (node: Node): SyntaxNode => {
    const described = grammar.describe?.[node.type]?.(node) ?? null;
    return {
      from: described?.kind === "types" ? startOf(node) : node.startPosition.row,
      to: node.endPosition.row,
      described,
      children: () => node.namedChildren.flatMap((child) => (child ? [wrap(child)] : [])),
    };
  };
  return { importRows, commentRows: commentRows(grammar, root), root: wrap(root) };
}

/**
 * The rows that hold only comment: every row a comment covers whose text outside the file's comments is blank (or,
 * in JSX, only the braces around one). A block comment's continuation lines count, which a per-line guess can't see,
 * since a CSS comment's middle lines carry no marker; a line with code before its comment does not.
 */
function commentRows(grammar: Grammar, root: Node): Set<number> {
  const comments = root.descendantsOfType(grammar.comments).flatMap((node) => (node ? [node] : []));
  const lines = root.text.split("\n");
  // Each row's comments, gathered once, so a row looks only at its own rather than every comment in the file.
  const onRow = comments
    .flatMap((node) =>
      Array.from(
        { length: node.endPosition.row - node.startPosition.row + 1 },
        (_, offset) => [node.startPosition.row + offset, node] as const,
      ),
    )
    .reduce((byRow, [row, node]) => byRow.set(row, [...(byRow.get(row) ?? []), node]), new Map<number, Node[]>());
  // What of a row is left once every comment on it is cut out.
  const outside = (row: number, onIt: Node[]) =>
    onIt
      .map((node) => [
        node.startPosition.row === row ? node.startPosition.column : 0,
        node.endPosition.row === row ? node.endPosition.column : lines[row]!.length,
      ])
      .sort(([a], [b]) => b! - a!)
      .reduce((text, [from, to]) => text.slice(0, from) + text.slice(to), lines[row] ?? "");
  const blank = grammar.around ?? /^\s*$/;
  return new Set([...onRow].flatMap(([row, onIt]) => (blank.test(outside(row, onIt)) ? [row] : [])));
}
