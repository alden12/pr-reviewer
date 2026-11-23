import { afterEach, describe, expect, it } from "vitest";
import type { DiffFile } from "../src/diff/parseDiff.ts";
import type { Review } from "../src/review/model.ts";
import { fingerprint, loadViewed, saveViewed } from "../src/ui/viewedStore.ts";

/** Just what the store reads: the PR it belongs to and each file's hunks. */
const reviewOf = (files: Record<string, string[]>, firstLine = 1): Review =>
  ({
    annotations: { pr: { repo: "o/r", number: 7 } },
    files: Object.fromEntries(
      Object.entries(files).map(([path, texts]): [string, DiffFile] => [
        path,
        {
          path,
          added: texts.length,
          removed: 0,
          hunks: [{ context: "", lines: texts.map((text, index) => ["+", null, firstLine + index, text]) }],
        },
      ]),
    ),
  }) as unknown as Review;

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};
const storageOf = (storage: unknown) =>
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

describe("viewed files kept in the browser", () => {
  afterEach(() => storageOf(undefined));

  it("brings back a file whose diff is unchanged, and drops one that changed or left the review", () => {
    storageOf(memoryStorage());
    saveViewed(reviewOf({ "a.ts": ["one"], "b.ts": ["two"], "c.ts": ["three"] }), new Set(["a.ts", "b.ts", "c.ts"]));
    const rebuilt = reviewOf({ "a.ts": ["one"], "b.ts": ["two, edited"] });
    expect([...loadViewed(rebuilt)]).toEqual(["a.ts"]);
  });

  it("keeps a file viewed when a rebase only shifts its lines", () => {
    expect(fingerprint(reviewOf({ "a.ts": ["one"] }, 10), "a.ts")).toBe(
      fingerprint(reviewOf({ "a.ts": ["one"] }), "a.ts"),
    );
    expect(fingerprint(reviewOf({ "a.ts": ["one"] }), "a.ts")).not.toBe(
      fingerprint(reviewOf({ "a.ts": ["two"] }), "a.ts"),
    );
  });

  it("works without storage, or with storage that refuses", () => {
    const review = reviewOf({ "a.ts": ["one"] });
    expect(loadViewed(review).size).toBe(0);
    storageOf({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => saveViewed(review, new Set(["a.ts"]))).not.toThrow();
    expect(loadViewed(review).size).toBe(0);
  });
});
