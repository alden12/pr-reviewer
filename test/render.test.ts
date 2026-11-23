import { describe, expect, it } from "vitest";
import annotationsJson from "./fixtures/example/review.json";
import { renderReview } from "../pipeline/render.ts";
import { loadReview } from "../src/review/model.ts";
import { reviewSchema } from "../src/review/schema.ts";
import { distinctNames } from "../src/ui/context.ts";
import type { DiffFile } from "../src/diff/parseDiff.ts";

describe("renderReview", () => {
  const base = reviewSchema.parse(annotationsJson);
  const lines = (texts: string[]): DiffFile["hunks"][number]["lines"] =>
    texts.map((text, index) => ["+", null, index + 1, text]);
  const files: DiffFile[] = [
    {
      path: "src/a.ts",
      added: 6,
      removed: 0,
      hunks: [
        {
          context: "",
          lines: lines([
            'import { x } from "x";',
            'import { y } from "y";',
            "// A note.",
            "export function run() {",
            "  return x + y;",
            "}",
          ]),
        },
      ],
    },
    { path: "yarn.lock", added: 2, removed: 0, hunks: [{ context: "", lines: lines(["a", "b"]) }] },
  ];
  const review = loadReview(files, {
    ...base,
    steps: [{ id: "one", title: "The change", files: ["src/a.ts"] }],
    blocks: {
      "src/a.ts": [
        {
          title: "Run it",
          sections: [{ line: 4, title: "The entry point" }],
          hints: [{ line: 5, text: "both imports, added" }],
          spans: [{ from: 1, to: 2, kind: "imports", summary: "2 import lines" }],
        },
      ],
    },
    comments: [],
    decisions: [],
    notForReview: [{ path: "yarn.lock", why: "The lockfile." }],
    tests: { files: [], tested: [], gaps: [] },
  });
  const view = renderReview(review);

  it("draws what the app first shows: spans as one line, sections above their part, comments hidden", () => {
    expect(view).toContain("[…imports] 2 import lines (2 lines)");
    expect(view).toContain("## The entry point");
    expect(view).toContain("   4 + export function run() {");
    expect(view).not.toContain("A note.");
    // In its place, the count the app draws, so the line numbers' jump is explained: under the section the comment
    // introduces, not above its heading.
    expect(view).toContain("## The entry point\n         // +1 comment line\n     4 + export function run() {");
    expect(view.indexOf("The entry point")).toBeLessThan(view.indexOf("export function run"));
    // A hint sits just above its line, at its indent.
    expect(view).toContain("           › both imports, added\n     5 +   return x + y;");
  });

  it("lists what isn't for review rather than drawing it", () => {
    expect(view).toContain("- yarn.lock: The lockfile.");
    expect(view).not.toContain("### yarn.lock");
  });

  it("lists what was fixed, and leaves out a tests heading with nothing under it", () => {
    const fixedView = renderReview({
      ...review,
      annotations: { ...review.annotations, fixed: [{ title: "A nit", detail: "reworded", commit: "abc1234" }] },
    });
    expect(fixedView).toContain("- fixed: reworded");
    const changedView = renderReview({
      ...review,
      annotations: {
        ...review.annotations,
        pr: { ...review.annotations.pr, changedSinceReview: { "src/a.ts": ["abc1234"] } },
      },
    });
    expect(changedView).toContain("### src/a.ts (changed after the review by abc1234, not reviewed again)");
    expect(view).not.toContain("## Tests");
  });
});

describe("distinctNames", () => {
  it("names a file by its name, adding folders only while another file shares it", () => {
    const names = distinctNames(["core/site/vite.config.ts", "core/roadmap/vite.config.ts", "core/a/index.ts", "b.ts"]);
    expect([...names.values()]).toEqual(["site/vite.config.ts", "roadmap/vite.config.ts", "index.ts", "b.ts"]);
    expect(distinctNames(["x/a.ts", "a.ts"]).get("a.ts")).toBe("a.ts");
    expect(distinctNames(["x/a.ts", "a.ts"]).get("x/a.ts")).toBe("x/a.ts");
  });
});
