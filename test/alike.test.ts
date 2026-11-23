import { describe, expect, it } from "vitest";
import { alikeRuns } from "../pipeline/alike.ts";
import type { Hunk } from "../src/diff/parseDiff.ts";

const added = (...texts: string[]): Hunk => ({
  context: "",
  lines: texts.map((text, index) => ["+", null, index + 1, text]),
});

describe("alikeRuns", () => {
  it("finds neighbouring chunks shaped alike, and leaves different ones", () => {
    const hunk = added(
      "const missing = files",
      "  .filter((path) => !known[path])",
      "  .map((path) => `${path} is missing`);",
      "",
      "/** A comment that differs. */",
      "const extra = paths",
      "  .filter((entry) => !seen[entry])",
      "  .map((entry) => `${entry} is extra`);",
      "",
      "export function render() {",
      '  return <div className="x">{children}</div>;',
      "}",
    );
    expect(alikeRuns(hunk, () => false)).toEqual([{ from: 1, to: 8, count: 2, first: "const missing = files" }]);
  });

  it("skips what is already folded", () => {
    const hunk = added("const a = f(1);", "const b = g(2);", "", "const c = f(3);", "const d = g(4);");
    expect(alikeRuns(hunk, (number) => number >= 4)).toEqual([]);
  });

  it("takes only near-identical chunks, and compares their code, not their comments", () => {
    const near = added(
      "const a = list.filter((x) => x.ok).map((x) => x.id);",
      "const b = list.filter((x) => x.ok).map((x) => x.id);",
      "",
      "/** A long comment that says something else entirely, in many words. */",
      "const c = rows.filter((y) => y.on).map((y) => y.key);",
      "const d = rows.filter((y) => y.on).map((y) => y.key);",
      "",
      "if (ready) {",
      "  start(now);",
      "}",
    );
    expect(alikeRuns(near, () => false).map((run) => [run.from, run.to, run.count])).toEqual([[1, 6, 2]]);
  });
});
