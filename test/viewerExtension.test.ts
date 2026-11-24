/**
 * The reviewer inside attraverso's viewer (DIST-2.2, DIST-2.3): what `@traverso/pr-reviewer/host` answers under its
 * prefix, as core's host hands it requests.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { viewerExtension } from "../pipeline/viewerExtension.ts";

const work = mkdtempSync(join(tmpdir(), "reviewer-extension-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const plan = join(work, "attraverso.yaml");
writeFileSync(plan, "projects: []\n");
const extension = viewerExtension({ plans: [plan] });
const ask = (path: string, init?: RequestInit) => extension.handle(new Request(`http://127.0.0.1${path}`, init));

describe("the reviewer as a viewer extension", () => {
  it("makes nothing in the plan's repo by starting: the reviews folder is a run's to make", () => {
    expect(existsSync(join(work, ".attraverso"))).toBe(false);
  });

  it("is a PRs tab", () => {
    expect(extension.prefix).toBe("/reviews");
    expect(extension.label).toBe("PRs");
  });

  it("answers only under its prefix, and sends the bare prefix to the folder's URL", async () => {
    expect(await ask("/api/store")).toBeUndefined();
    expect(await ask("/reviewsx")).toBeUndefined();
    const bare = await ask("/reviews?review=a-1");
    expect(bare?.status).toBe(301);
    expect(bare?.headers.get("location")).toBe("http://127.0.0.1/reviews/?review=a-1");
  });

  it("says where the viewer's plan is, so the PR list links back to it", async () => {
    expect(await (await ask("/reviews/api/host"))!.json()).toEqual({ plan: "/" });
  });

  it("runs the reviewer's routes with the prefix stripped, and refuses a write it has no route for", async () => {
    expect(typeof (await (await ask("/reviews/api/reviews"))!.json())).toBe("object");
    expect((await ask("/reviews/anything", { method: "POST", body: "x" }))?.status).toBe(405);
  });
});
