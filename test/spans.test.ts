import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SPAN_PREFERENCES,
  findSpans as findSpansWith,
  listed,
  type SpanPreferences,
} from "../pipeline/spans.ts";
import { loadSyntax, type Syntax } from "../pipeline/syntax.ts";
import type { Hunk } from "../src/diff/parseDiff.ts";

const added = (...texts: string[]): Hunk => ({
  context: "",
  lines: texts.map((text, index) => ["+", null, index + 1, text]),
});

let syntax: Syntax;
beforeAll(async () => {
  syntax = await loadSyntax();
});
/** `findSpans` with the parsers loaded, as the fold step calls it. */
const findSpans = (path: string, hunk: Hunk, preferences: SpanPreferences, fileText?: string) =>
  findSpansWith(path, hunk, preferences, fileText, syntax);

describe("findSpans", () => {
  it("summarises imports, a type with its fields, and a long object with its keys", () => {
    const hunk = added(
      'import { a } from "./a";',
      'import { b } from "./b";',
      "",
      "export interface Context {",
      "  work: Workspace;",
      "  clone: string;",
      "  number: number;",
      "  liveHead: () => string | null;",
      "  project?: string;",
      "}",
      "",
      "const settings = {",
      ...Array.from({ length: 8 }, (_, index) => `  key${index}: ${index},`),
      "};",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([
      { from: 1, to: 2, kind: "imports", summary: "2 import lines" },
      { from: 4, to: 10, kind: "types", summary: "interface Context: work, clone, number, liveHead and 1 more" },
      { from: 12, to: 21, kind: "object", summary: "const settings = { key0, key1, key2, key3 and 4 more }" },
    ]);
  });

  it("finds imports with the parser, so import.meta and import() are code, and a run spans the blank between", () => {
    const hunk = added(
      'import { a } from "./a";',
      "",
      'export { b } from "./b";',
      "if (import.meta.env.DEV) {",
      '  void import("./c");',
      "  run();",
      "}",
    );
    expect(findSpans("src/main.tsx", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([
      { from: 1, to: 3, kind: "imports", summary: "3 import lines" },
    ]);
  });

  it("doesn't fold an object edited inside: the edit is the change", () => {
    const hunk: Hunk = {
      context: "",
      lines: [
        [" ", 1, 1, "mount({"],
        [" ", 2, 2, "  a: 1,"],
        ["-", 3, null, "  watch: old,"],
        ...Array.from({ length: 8 }, (_, index): Hunk["lines"][number] => [
          "+",
          null,
          3 + index,
          `  key${index}: ${index},`,
        ]),
        [" ", 4, 11, "});"],
      ],
    };
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
  });

  it("doesn't fold a declaration that only gained lines, but folds one that is new throughout", () => {
    const keys = (from: number, count: number, sign: "+" | " ") =>
      Array.from({ length: count }, (_, index): Hunk["lines"][number] => [
        sign,
        sign === "+" ? null : from + index,
        from + index,
        `  key${from + index}: ${index},`,
      ]);
    // An existing object gaining keys, nothing removed.
    const gained: Hunk = {
      context: "",
      lines: [[" ", 1, 1, "const settings = {"], ...keys(2, 4, " "), ...keys(6, 5, "+"), [" ", 6, 11, "};"]],
    };
    expect(findSpans("src/a.ts", gained, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
    // An interface gaining a field: the field is the change.
    const field: Hunk = {
      context: "",
      lines: [
        [" ", 1, 1, "export interface Context {"],
        [" ", 2, 2, "  work: Workspace;"],
        ["+", null, 3, "  clone: string;"],
        [" ", 3, 4, "  number: number;"],
        [" ", 4, 5, "}"],
      ],
    };
    expect(findSpans("src/a.ts", field, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
    // A new object between unchanged lines still folds: none of its own lines were there before.
    const fresh: Hunk = {
      context: "",
      lines: [
        [" ", 1, 1, "run();"],
        ["+", null, 2, "const settings = {"],
        ...keys(3, 8, "+"),
        ["+", null, 11, "};"],
        [" ", 2, 12, "done();"],
      ],
    };
    expect(findSpans("src/a.ts", fresh, DEFAULT_SPAN_PREFERENCES)).toMatchObject([{ from: 2, to: 11, kind: "object" }]);
  });

  it("leaves function bodies and short objects alone, and follows the reader's lengths", () => {
    const hunk = added("function run() {", "  const x = 1;", "  return x;", "}", "const small = {", "  a: 1,", "};");
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
    const component = added(
      "export function Card({",
      ...Array.from({ length: 9 }, (_, index) => `  prop${index},`),
      "}) {",
      "  return null;",
      "}",
    );
    expect(findSpans("src/a.tsx", component, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
    const arrow = added(
      "export const Card = ({",
      ...Array.from({ length: 9 }, (_, index) => `  prop${index},`),
      "}: Props) => {",
      "  return null;",
      "};",
    );
    expect(findSpans("src/a.tsx", arrow, DEFAULT_SPAN_PREFERENCES)).toEqual([]);
    const typeHunk = added("type A = {", "  a: string;", "};");
    expect(findSpans("src/a.ts", typeHunk, DEFAULT_SPAN_PREFERENCES)).toHaveLength(1);
    expect(findSpans("src/a.ts", typeHunk, { ...DEFAULT_SPAN_PREFERENCES, types: false })).toEqual([]);
  });

  it("does not count brackets inside strings or comments", () => {
    const hunk = added(
      "const messages = {",
      '  open: "a { brace",',
      "  close: `} and ${name}`,",
      "  // a } in a comment",
      '  paren: "(",',
      "  a: 1,",
      "  b: 2,",
      "  c: 3,",
      "};",
      "const after = 1;",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([[1, 9]]);
  });

  it("keeps an object holding arrow functions an object", () => {
    const hunk = added(
      "export const steps = {",
      "  fetch: {",
      '    by: "code",',
      "    run: async ({ work }) => {",
      "      return work;",
      "    },",
      "  },",
      '  check: { by: "code" },',
      "};",
    );
    expect(
      findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to, span.kind]),
    ).toEqual([[1, 9, "object"]]);
  });

  it("folds a run of type declarations as one span, naming them", () => {
    const hunk = added(
      "interface A {",
      "  a: string;",
      "}",
      "",
      "/** The second. */",
      "export interface B {",
      "  b: string;",
      "}",
      "export type C = A | B;",
      "type D = {",
      "  d: number;",
      "};",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([
      { from: 1, to: 12, kind: "types", summary: "types: A, B, C, D" },
    ]);
  });

  it("reads strings, regexes and comments in one pass, so none hides the others", () => {
    const hunk = added(
      "const checks = {",
      '  isQuote: /^"/.test(a) && b === "{",',
      "  joined: a + /[{(]/.source,",
      '  url: "http://example.com/{id}",',
      ...Array.from({ length: 5 }, (_, index) => `  k${index}: ${index},`),
      "};",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([
      [1, 10],
    ]);
  });

  it("reads JSX closing and self-closing tags as markup, not the start of a regex", () => {
    const hunk = added(
      "const labels = {",
      "  count: <b>{count}</b>,",
      "  badge: <span>{count > 0 && <Icon x={y} />}</span>,",
      ...Array.from({ length: 7 }, (_, index) => `  k${index}: <i>{${index}}</i>,`),
      "};",
    );
    expect(findSpans("src/a.tsx", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([
      [1, 11],
    ]);
  });

  it("reads a regex that starts with > as a regex", () => {
    const hunk = added(
      "const parts = {",
      "  split: (s) => s.split(/>/),",
      ...Array.from({ length: 8 }, (_, index) => `  k${index}: ${index},`),
      "};",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([
      [1, 11],
    ]);
  });

  it("reads a self-closing tag at the start of a line, as Prettier writes long props", () => {
    const hunk = added(
      "const icons = {",
      "  a: (",
      "    <X",
      "      big",
      "    />",
      "  ),",
      ...Array.from({ length: 7 }, (_, index) => `  k${index}: ${index},`),
      "};",
    );
    expect(findSpans("src/a.tsx", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([
      [1, 14],
    ]);
  });

  it("summarises long destructuring with its names", () => {
    const hunk = added("const {", ...Array.from({ length: 7 }, (_, index) => `  name${index},`), "} = props;");
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([
      { from: 1, to: 9, kind: "object", summary: "const { name0, name1, name2, name3 and 3 more }" },
    ]);
  });

  it("never gives two spans sharing a line, and starts a summary at its own node", () => {
    const hunk = added(
      "const {",
      ...Array.from({ length: 7 }, (_, index) => `  n${index},`),
      "} = {",
      ...Array.from({ length: 7 }, (_, index) => `  n${index}: ${index},`),
      "};",
    );
    expect(
      findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to, span.summary]),
    ).toEqual([[1, 9, "const { n0, n1, n2, n3 and 3 more }"]]);
  });

  it("parses the whole file when given it, so a hunk opening inside a comment still finds its spans", () => {
    const file = [
      "/**",
      " * A note with a ` backtick.",
      " */",
      "const settings = {",
      ...Array.from({ length: 8 }, (_, index) => `  k${index}: ${index},`),
      "};",
    ];
    // The hunk starts mid-comment, at line 2.
    const hunk: Hunk = {
      context: "",
      lines: file.slice(1).map((text, index): Hunk["lines"][number] => ["+", null, index + 2, text]),
    };
    expect(
      findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES, file.join("\n")).map((span) => [span.from, span.to]),
    ).toEqual([[4, 13]]);
    // Tree-sitter recovers from the broken opening even without the file; TypeScript's compiler found nothing here.
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([
      [4, 13],
    ]);
  });

  it("looks inside an object the hunk only sits in, rather than dropping it", () => {
    const file = [
      "export const pipeline = {",
      "  review: {",
      "    run: async () => {",
      "      const settings = {",
      ...Array.from({ length: 8 }, (_, index) => `        k${index}: ${index},`),
      "      };",
      "      return settings;",
      "    },",
      "  },",
      "};",
    ];
    // The hunk is the inner object alone, lines 4 to 13.
    const hunk: Hunk = {
      context: "",
      lines: file.slice(3, 13).map((text, index): Hunk["lines"][number] => ["+", null, index + 4, text]),
    };
    expect(
      findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES, file.join("\n")).map((span) => [span.from, span.to]),
    ).toEqual([[4, 13]]);
  });

  it("does not count brackets inside a regex literal", () => {
    const hunk = added(
      "const patterns = {",
      "  open: /[{(]/,",
      ...Array.from({ length: 6 }, (_, index) => `  k${index}: ${index},`),
      "};",
    );
    expect(findSpans("src/a.ts", hunk, DEFAULT_SPAN_PREFERENCES).map((span) => [span.from, span.to])).toEqual([[1, 9]]);
  });

  it("falls back to the regex for imports without the parsers", () => {
    expect(
      findSpansWith(
        "a.rs",
        added("use a::b;", "use c::d;", "struct S {", "  a: u8,", "  b: u8,", "}"),
        DEFAULT_SPAN_PREFERENCES,
      ),
    ).toEqual([{ from: 1, to: 2, kind: "imports", summary: "2 import lines" }]);
  });
});

describe("listed", () => {
  it("names a few and counts the rest", () => {
    expect(listed(["a", "b"])).toBe("a, b");
    expect(listed(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d and 2 more");
  });
});
