import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPAN_PREFERENCES, findSpans } from "../pipeline/spans.ts";
import { markComments } from "../pipeline/steps/fetch.ts";
import { GRAMMARS } from "../pipeline/grammars.ts";
import { CODE } from "../pipeline/rules.ts";
import { LONGEST_PARSED, loadSyntax, type Syntax } from "../pipeline/syntax.ts";
import type { DiffFile, Hunk } from "../src/diff/parseDiff.ts";
import { languageOf } from "../src/ui/highlight.ts";

const added = (...texts: string[]): Hunk => ({
  context: "",
  lines: texts.map((text, index) => ["+", null, index + 1, text]),
});

let syntax: Syntax;
beforeAll(async () => {
  syntax = await loadSyntax();
});

const spans = (path: string, hunk: Hunk) =>
  findSpans(path, hunk, DEFAULT_SPAN_PREFERENCES, undefined, syntax).map((span) => [span.from, span.to, span.summary]);

describe("Rust, by tree-sitter", () => {
  it("folds a run of imports, a multi-line one and a comment between them included", () => {
    const hunk = added(
      "use std::fs;",
      "// the engine",
      "use crate::engine::{",
      "    Clip,",
      "    Track,",
      "};",
      "",
      "fn main() {}",
    );
    expect(spans("src/lib.rs", hunk)).toEqual([[1, 6, "6 import lines"]]);
  });

  it("summarises structs and enums with their fields and variants, their attributes folded with them", () => {
    const hunk = added(
      "#[derive(Debug, Clone)]",
      "pub struct Clip {",
      "    start: u32,",
      "    length: u32,",
      "}",
      "",
      "enum Mode {",
      "    Play,",
      "    Record,",
      "}",
    );
    expect(spans("src/clip.rs", hunk)).toEqual([[1, 10, "types: Clip, Mode"]]);
  });

  it("summarises a long struct literal by its fields, but never a parameter's pattern", () => {
    const hunk = added(
      "fn make(Settings { rate, .. }: Settings) -> Clip {",
      "    Clip {",
      ...Array.from({ length: 7 }, (_, index) => `        field${index}: ${index},`),
      "        ..Clip::default()",
      "    }",
      "}",
    );
    expect(spans("src/make.rs", hunk)).toEqual([[2, 11, "Clip { field0, field1, field2, field3 and 4 more }"]]);
  });

  it("reads a string holding braces as a string", () => {
    const hunk = added('const OPEN: &str = "{";', "struct Point {", "    x: f32,", "    y: f32,", "}");
    expect(spans("src/point.rs", hunk)).toEqual([[2, 5, "struct Point: x, y"]]);
  });

  it("falls back to the regex without the parsers", () => {
    const hunk = added("use std::fs;", "use std::io;");
    expect(findSpans("src/lib.rs", hunk, DEFAULT_SPAN_PREFERENCES)).toEqual([
      { from: 1, to: 2, kind: "imports", summary: "2 import lines" },
    ]);
  });
});

const rows = (path: string, ...texts: string[]) => [...(syntax.parse(path, texts.join("\n"))?.commentRows ?? [])];

describe("comment rows", () => {
  it("count a block comment's every line, and never a code line with a comment at its end", () => {
    expect(rows("src/a.ts", "/**", " * Why.", " */", "const a = 1; // tail", "// own line")).toEqual([0, 1, 2, 4]);
  });

  it("see a CSS comment's unmarked middle, and JSX's braced comments", () => {
    expect(rows("src/a.css", "/* the header", "   stays on top */", "* { margin: 0; }")).toEqual([0, 1]);
    expect(rows("src/a.tsx", "const view = (", "  <div>", "    {/* the toolbar */}", "  </div>", ");")).toEqual([2]);
  });

  it("read a string that looks like a comment as a string", () => {
    expect(rows("src/a.rs", 'let url = "http://example.com";', "// a real one")).toEqual([1]);
  });
});

describe("markComments", () => {
  it("marks each side's lines by that side's text, and leaves a file with no grammar alone", () => {
    const files = [
      {
        path: "src/a.ts",
        added: 1,
        removed: 1,
        hunks: [
          {
            context: "",
            lines: [
              ["-", 2, null, "   old words */"],
              ["+", null, 2, "// new words"],
              [" ", 3, 3, "const a = 1;"],
            ] as Hunk["lines"],
          },
        ],
      },
      {
        path: "notes.md",
        added: 1,
        removed: 0,
        hunks: [{ context: "", lines: [["+", null, 1, "// hi"]] as Hunk["lines"] }],
      },
    ];
    const text = { old: "/* first,\n   old words */\nconst a = 1;", new: "x;\n// new words\nconst a = 1;" };
    const marked = markComments(files, syntax, (path, side) => (path === "src/a.ts" ? text[side] : "// hi"));
    expect(marked[0]!.hunks[0]!.comments).toEqual([0, 1]);
    expect(marked[1]!.hunks[0]!.comments).toBeUndefined();
  });

  /** A file of one hunk, a comment reworded on line 1. */
  const reworded = (path: string, oldPath?: string): DiffFile => ({
    path,
    ...(oldPath ? { oldPath } : {}),
    added: 1,
    removed: 1,
    hunks: [
      {
        context: "",
        lines: [
          ["-", 1, null, "// was"],
          ["+", null, 1, "// now"],
        ],
      },
    ],
  });

  it("reads a renamed file's old side at its old path", () => {
    const texts: Record<string, string> = { "old:src/old.ts": "// was\n", "new:src/new.ts": "// now\n" };
    const [marked] = markComments(
      [reworded("src/new.ts", "src/old.ts")],
      syntax,
      (path, side) => texts[`${side}:${path}`],
    );
    expect(marked!.hunks[0]!.comments).toEqual([0, 1]);
  });

  it("parses a renamed file's old side by its old grammar", () => {
    // `#` is a comment to Python but not to TypeScript, so a .py renamed to .ts shows which grammar read the base.
    const file: DiffFile = {
      path: "src/new.ts",
      oldPath: "src/old.py",
      added: 1,
      removed: 1,
      hunks: [
        {
          context: "",
          lines: [
            ["-", 1, null, "# was"],
            ["+", null, 1, "// now"],
          ],
        },
      ],
    };
    const texts: Record<string, string> = { "old:src/old.py": "# was\n", "new:src/new.ts": "// now\n" };
    const [marked] = markComments([file], syntax, (path, side) => texts[`${side}:${path}`]);
    expect(marked!.hunks[0]!.comments).toEqual([0, 1]);
  });

  it("leaves a file unmarked, for the guess, when a side it needs can't be read or is too long", () => {
    const missingOld = markComments([reworded("src/a.ts")], syntax, (_, side) =>
      side === "new" ? "// now\n" : undefined,
    );
    const missingNew = markComments([reworded("src/a.ts")], syntax, (_, side) =>
      side === "old" ? "// was\n" : undefined,
    );
    const huge = `// now\n${"x;\n".repeat(LONGEST_PARSED / 3 + 1)}`;
    const tooLong = markComments([reworded("src/a.ts")], syntax, (_, side) => (side === "new" ? huge : "// was\n"));
    [missingOld, missingNew, tooLong].forEach(([file]) => expect(file!.hunks[0]!.comments).toBeUndefined());
  });

  it("needs no old side for an added file, nor a new side for a deleted one", () => {
    const addedFile: DiffFile = {
      path: "src/a.ts",
      added: 1,
      removed: 0,
      hunks: [{ context: "", lines: [["+", null, 1, "// new"]] }],
    };
    const deletedFile: DiffFile = {
      path: "src/a.ts",
      added: 0,
      removed: 1,
      hunks: [{ context: "", lines: [["-", 1, null, "// old"]] }],
    };
    expect(
      markComments([addedFile], syntax, (_, side) => (side === "new" ? "// new\n" : undefined))[0]!.hunks[0]!.comments,
    ).toEqual([0]);
    expect(
      markComments([deletedFile], syntax, (_, side) => (side === "old" ? "// old\n" : undefined))[0]!.hunks[0]!
        .comments,
    ).toEqual([0]);
  });
});

describe("the other languages", () => {
  it("Go: imports, a struct by its fields, an interface by its methods, a keyed literal", () => {
    const hunk = added(
      "import (",
      '    "fmt"',
      '    "os"',
      ")",
      "",
      "type Clip struct {",
      "    Start    int",
      "    Len, End int",
      "}",
      "",
      "type Player interface {",
      "    Play() error",
      "}",
    );
    expect(spans("engine/clip.go", hunk)).toEqual([
      [1, 4, "4 import lines"],
      [6, 13, "types: Clip, Player"],
    ]);
    const single = added("type Clip struct {", "    Start    int", "    Len, End int", "}");
    expect(spans("engine/clip.go", single)).toEqual([[1, 4, "struct Clip: Start, Len, End"]]);
  });

  it("Python: a decorated class from its decorator, a long dict by its keys, # comments", () => {
    const hunk = added(
      "import os",
      "from engine import (Clip,",
      "    Track)",
      "",
      "# The settings a clip starts with.",
      "@dataclass",
      "class Clip:",
      "    start: int",
      "    def play(self): pass",
      "",
      "DEFAULTS = {",
      ...Array.from({ length: 7 }, (_, index) => `    "key${index}": ${index},`),
      "}",
    );
    expect(spans("engine/clip.py", hunk)).toEqual([
      [1, 3, "3 import lines"],
      [6, 9, "class Clip: start, play"],
      [11, 19, "DEFAULTS = { key0, key1, key2, key3 and 3 more }"],
    ]);
    expect(rows("engine/clip.py", "x = 1  # tail", "# own line", 's = "# not a comment"')).toEqual([1]);
  });

  it("Kotlin: a data class by its constructor and body, an enum by its entries", () => {
    const hunk = added(
      "import engine.Clip",
      "import engine.Track",
      "",
      "data class Settings(val rate: Int, val depth: Int) {",
      "    fun scaled() = rate * 2",
      "}",
      "",
      "enum class Mode {",
      "    PLAY, STOP",
      "}",
    );
    expect(spans("app/Settings.kt", hunk)).toEqual([
      [1, 2, "2 import lines"],
      [4, 10, "types: Settings, Mode"],
    ]);
    const single = added("enum class Mode {", "    PLAY, STOP", "}");
    expect(spans("app/Mode.kt", single)).toEqual([[1, 3, "enum class Mode: PLAY, STOP"]]);
  });

  it("Swift: a struct and an enum by their members, the keyword kept", () => {
    const struct = added(
      "struct Clip: Codable {",
      "    let start: Int",
      "    var length: Int",
      "    func play() {}",
      "}",
    );
    expect(spans("App/Clip.swift", struct)).toEqual([[1, 5, "struct Clip: start, length, play"]]);
    const enumeration = added("enum Mode {", "    case play, stop", "    case record(Int)", "}");
    expect(spans("App/Mode.swift", enumeration)).toEqual([[1, 4, "enum Mode: play, stop, record"]]);
  });

  it("Scala: a case class by its fields, a trait by its members, a Scala 3 enum", () => {
    const hunk = added(
      "import engine.Clip",
      "import engine.{Track, Mixer}",
      "",
      "trait Player {",
      "  def play(): Unit",
      "  val rate: Int",
      "}",
    );
    expect(spans("src/Player.scala", hunk)).toEqual([
      [1, 2, "2 import lines"],
      [4, 7, "trait Player: play, rate"],
    ]);
    const enumeration = added("enum Mode {", "  case Play, Stop", "}");
    expect(spans("src/Mode.scala", enumeration)).toEqual([[1, 3, "enum Mode: Play, Stop"]]);
  });
});

describe("comments in the other languages", () => {
  it.each(["engine/a.go", "app/A.kt", "App/A.swift", "src/A.scala"])(
    "%s: own-line and block comments, not strings",
    (path) => {
      expect(rows(path, "// own line", "/* a block", "   comment */", 'val url = "http://example.com"', "")).toEqual([
        0, 1, 2,
      ]);
    },
  );
});

describe("comment rows at scale", () => {
  it("reads a file of many comments in about linear time", () => {
    const text = Array.from({ length: 20_000 }, (_, index) =>
      index % 2 === 0 ? `// note ${index}` : `x${index}();`,
    ).join("\n");
    const started = performance.now();
    const found = syntax.parse("big.js", text)!.commentRows;
    expect(found.size).toBe(10_000);
    // Quadratic took 15s here; grouped by row, it is well under a second.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("keeps two comments on one row, and code between them, apart", () => {
    expect(rows("a.ts", "/* a */ /* b */", "/* a */ x; /* b */", "  /* a */ // b")).toEqual([0, 2]);
  });
});

describe("every extension a grammar reads", () => {
  const EXTENSIONS = GRAMMARS.flatMap((grammar) => grammar.extensions);

  it("is read by its grammar, by the last extension of the name", () => {
    EXTENSIONS.forEach((extension) => expect(syntax.covers(`src/a.${extension}`)).toBe(true));
    expect(syntax.covers("src/types.d.ts")).toBe(true);
    expect(syntax.covers("src/a.ts.md")).toBe(false);
    expect(syntax.covers("Makefile")).toBe(false);
    expect(syntax.covers("src.ts/README")).toBe(false);
  });

  it("is code to the rules, and highlighted, CSS aside", () => {
    EXTENSIONS.forEach((extension) => expect(CODE.test(`a.${extension}`)).toBe(true));
    EXTENSIONS.filter((extension) => extension !== "css").forEach((extension) =>
      expect(languageOf(`a.${extension}`)).not.toBeNull(),
    );
  });
});
