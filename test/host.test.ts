/**
 * The reviewer's server side (DIST-2): `host.ts`'s handlers, through `server.ts` on a real `node:http` server, so the
 * adapter and the page fallback are what is tested, as the dev server and the `serve` command run them. The inbox and
 * the commits-since banner ask GitHub, so only their refusals are tested here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewerHost } from "../pipeline/host.ts";
import { createReviewerServer } from "../pipeline/server.ts";

let dir: string;
let base: string;
let close: () => void;

const write = (path: string, data: unknown) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), typeof data === "string" ? data : JSON.stringify(data));
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reviewer-host-"));
  write("reviews/a-1/review.json", { which: "committed a" });
  write("reviews/a-1/diff.json", [{ which: "committed a's diff" }]);
  write("reviews/b-2/review.json", { which: "committed b" });
  write("reviews/b-2/diff.json", [{ which: "committed b's diff" }]);
  // A local run of a-1 beside its committed snapshot, which it supersedes.
  write("reviews.local/a-1/review.json", { which: "local a" });
  write("reviews.local/a-1/diff.json", [{ which: "local a's diff" }]);
  // A folder with no review.json (a run still at its first agent step) isn't a review yet.
  write("reviews.local/c-3/state.json", {});
  write("page.html", "<!doctype html><title>the app</title>");
  const server = createReviewerServer(
    { committed: join(dir, "reviews"), local: join(dir, "reviews.local"), clone: dir },
    join(dir, "page.html"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const reading = (name: string, body: string, type = "application/json") =>
  fetch(`${base}/api/reading/${name}`, { method: "POST", headers: { "content-type": type }, body });
const event = JSON.stringify({
  at: "2026-11-23T00:00:00.000Z",
  action: "open",
  path: "src/a.ts",
  hunkIndex: 0,
  kind: "types",
});

describe("the reviewer's server", () => {
  it("lists every review.json, keyed as the bundled glob keys them, and no folder without one", async () => {
    const listed = (await (await fetch(`${base}/api/reviews`)).json()) as Record<string, unknown>;
    expect(listed).toEqual({
      "../reviews/a-1/review.json": { which: "committed a" },
      "../reviews/b-2/review.json": { which: "committed b" },
      "../reviews.local/a-1/review.json": { which: "local a" },
    });
  });

  it("answers one review's diff, the local copy before the committed one", async () => {
    expect(await (await fetch(`${base}/api/diff/a-1`)).json()).toEqual([{ which: "local a's diff" }]);
    expect(await (await fetch(`${base}/api/diff/b-2`)).json()).toEqual([{ which: "committed b's diff" }]);
    expect((await fetch(`${base}/api/diff/nope-9`)).status).toBe(404);
    expect((await fetch(`${base}/api/diff/..%2F..%2Fetc`)).status).toBe(404);
  });

  it("logs reading only for a local review, as JSON, of the right shape", async () => {
    const log = join(dir, "reviews.local/a-1/reading.jsonl");
    const valid = event;
    expect((await reading("a-1", valid)).status).toBe(204);
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([JSON.parse(valid)]);
    expect((await reading("a-1", valid, "text/plain")).status).toBe(404);
    expect((await reading("b-2", valid)).status).toBe(404);
    expect((await reading("a-1", '{"not":"an event"}')).status).toBe(400);
    expect(existsSync(join(dir, "reviews/b-2/reading.jsonl"))).toBe(false);
  });

  it("refuses a commits-since query that isn't one, before asking GitHub", async () => {
    expect((await fetch(`${base}/api/since?repo=a/b&number=1&from=not-a-sha`)).status).toBe(400);
    for (const repo of ["../x", "a/..", "a/b/c", "a.b/c", "a"]) {
      expect((await fetch(`${base}/api/since?repo=${repo}&number=1&from=abc1234`)).status, repo).toBe(400);
    }
  });

  it("answers the page for every other path, and nothing for a route it hasn't got", async () => {
    expect(await (await fetch(`${base}/?review=a-1`)).text()).toContain("the app");
    expect(await (await fetch(`${base}/src/api/thing.ts`)).text()).toContain("the app");
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/reviews`, { method: "POST" })).status).toBe(405);
  });
});

describe("reviewerHost alone", () => {
  it("passes on what isn't under /api/, so a host serves it", async () => {
    const host = reviewerHost({ committed: dir, local: dir, clone: dir });
    expect(await host(new Request("http://x/index.html"))).toBeUndefined();
    expect(await host(new Request("http://x/src/api/thing.ts"))).toBeUndefined();
  });
});
