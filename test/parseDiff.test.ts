import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff/parseDiff.ts";

const SAMPLE = [
  "diff --git a/pkg/src/one.ts b/pkg/src/one.ts",
  "index 1111111..2222222 100644",
  "--- a/pkg/src/one.ts",
  "+++ b/pkg/src/one.ts",
  "@@ -10,3 +10,4 @@ export function one() {",
  " const kept = 1;",
  "-const gone = 2;",
  "+const added = 2;",
  "+const another = 3;",
  " return kept;",
  "diff --git a/pkg/engine.wasm b/pkg/engine.wasm",
  "Binary files a/pkg/engine.wasm and b/pkg/engine.wasm differ",
  "",
].join("\n");

describe("parseDiff", () => {
  const [one, wasm] = parseDiff(SAMPLE, "pkg/");

  it("numbers each line on its side of the change", () => {
    expect(one?.hunks[0]?.lines).toEqual([
      [" ", 10, 10, "const kept = 1;"],
      ["-", 11, null, "const gone = 2;"],
      ["+", null, 11, "const added = 2;"],
      ["+", null, 12, "const another = 3;"],
      [" ", 12, 13, "return kept;"],
    ]);
  });

  it("keeps the hunk's context and counts what changed", () => {
    expect(one).toMatchObject({ path: "src/one.ts", added: 2, removed: 1 });
    expect(one?.hunks[0]?.context).toBe("export function one() {");
  });

  it("skips the file headers rather than reading them as changed lines", () => {
    expect(one?.hunks).toHaveLength(1);
  });

  it("keeps a binary file, with no hunks", () => {
    expect(wasm).toEqual({ path: "engine.wasm", added: 0, removed: 0, hunks: [] });
  });

  it("keeps the old path of a renamed file, and only of one", () => {
    const [renamed, added, deleted, same] = parseDiff(
      [
        "diff --git a/src/old name.ts b/src/new.ts",
        "similarity index 90%",
        "rename from src/old name.ts",
        "rename to src/new.ts",
        "--- a/src/old name.ts\t",
        "+++ b/src/new.ts",
        "@@ -1 +1 @@",
        "-// gone",
        "+// here",
        "diff --git a/src/fresh.ts b/src/fresh.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/fresh.ts",
        "@@ -0,0 +1 @@",
        "+a",
        "diff --git a/src/dead.ts b/src/dead.ts",
        "deleted file mode 100644",
        "--- a/src/dead.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-a",
        "diff --git a/src/same.ts b/src/same.ts",
        "--- a/src/same.ts",
        "+++ b/src/same.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    expect([renamed!.path, renamed!.oldPath]).toEqual(["src/new.ts", "src/old name.ts"]);
    expect([added!.path, deleted!.path, same!.path]).toEqual(["src/fresh.ts", "src/dead.ts", "src/same.ts"]);
    expect([added, deleted, same].map((file) => "oldPath" in file!)).toEqual([false, false, false]);
  });
});
