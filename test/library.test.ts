import { describe, expect, it } from "vitest";
import { reviewLibrary, sourceOf } from "../src/review/library.ts";

const files = {
  "../reviews/app-7/diff.json": ["committed diff"],
  "../reviews/app-7/review.json": { name: "committed" },
  "../reviews.local/app-8/diff.json": ["local diff"],
  "../reviews.local/app-8/review.json": { name: "local" },
};

describe("reviewLibrary", () => {
  it("finds committed and local reviews by name, with their two files", () => {
    const library = reviewLibrary(files);
    expect(library.names).toEqual(["app-7", "app-8"]);
    expect(library.filesOf("app-8")).toEqual({ diff: ["local diff"], annotations: { name: "local" } });
    expect(library.filesOf("app-7")).toEqual({ diff: ["committed diff"], annotations: { name: "committed" } });
    expect(library.filesOf("nothing")).toBeNull();
  });

  it("takes the local copy of a review that is also committed, whichever order the paths come in", () => {
    const both = {
      "../reviews/app-7/diff.json": ["snapshot diff"],
      "../reviews/app-7/review.json": { name: "snapshot" },
      "../reviews.local/app-7/diff.json": ["live diff"],
      "../reviews.local/app-7/review.json": { name: "live" },
    };
    const reversed = Object.fromEntries(Object.entries(both).reverse());
    expect(reviewLibrary(both).filesOf("app-7")).toEqual({ diff: ["live diff"], annotations: { name: "live" } });
    expect(reviewLibrary(reversed).filesOf("app-7")).toEqual({ diff: ["live diff"], annotations: { name: "live" } });
    expect(reviewLibrary(both).names).toEqual(["app-7"]);
  });

  it("shows the review asked for, or the only one, and otherwise the list", () => {
    expect(reviewLibrary(files).choose("app-7")).toBe("app-7");
    expect(reviewLibrary(files).choose("unknown")).toBeNull();
    expect(reviewLibrary(files).choose(null)).toBeNull();
    const one = Object.fromEntries(Object.entries(files).filter(([path]) => path.includes("app-7")));
    expect(reviewLibrary(one).choose(null)).toBe("app-7");
  });
});

describe("sourceOf", () => {
  const bundled = { "../reviews/app-7/review.json": { name: "bundled" } };

  it("reads the server's reviews when it answered, and says it is served", () => {
    const fromServer = { "../reviews.local/app-8/review.json": { name: "local" } };
    expect(sourceOf(fromServer, bundled)).toEqual({ served: true, files: fromServer });
    expect(sourceOf({}, bundled)).toEqual({ served: true, files: {} });
  });

  it("falls back to the bundle when there is no server, or its answer isn't a set of files", () => {
    [null, "<!doctype html>", 3, ["a"]].forEach((answer) =>
      expect(sourceOf(answer, bundled), String(answer)).toEqual({ served: false, files: bundled }),
    );
  });
});
