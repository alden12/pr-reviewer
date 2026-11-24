import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  combinedChecks,
  joinReviews,
  mapLimited,
  nestedCheckouts,
  repoFromRemote,
  reviewFolders,
  type Pull,
} from "../pipeline/inbox.ts";
import {
  filterOptions,
  filterRows,
  initialTicks,
  newestFirst,
  otherReviews,
  pastReviews,
  reviewCommand,
  rowsOf,
  summaryOf,
  type Inbox,
  type OpenPr,
  type ReviewSummary,
} from "../src/inbox/rows.ts";

const pr = (number: number, fields: Partial<OpenPr> = {}): OpenPr => ({
  repo: "me/app",
  number,
  title: `PR ${number}`,
  author: "me",
  url: `https://github.com/me/app/pull/${number}`,
  createdAt: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
  draft: false,
  head: `head${number}`,
  checks: null,
  reviewRequested: false,
  ...fields,
});
const summary = (name: string, number: number, fields: Partial<ReviewSummary> = {}): ReviewSummary => ({
  name,
  repo: "me/app",
  number,
  title: `PR ${number}`,
  verdict: "comment",
  decisions: 0,
  ...fields,
});
const inboxOf = (open: OpenPr[], reviews: Inbox["reviews"] = []): Inbox => ({
  me: "me",
  here: "me/app",
  open,
  more: 0,
  reviews,
});
const local = (
  name: string,
  number: number,
  fields: Partial<Inbox["reviews"][number]> = {},
): Inbox["reviews"][number] => ({
  name,
  repo: "me/app",
  number,
  step: "done",
  updatedAt: "2026-11-01T00:00:00Z",
  prState: "open",
  closedAt: null,
  ...fields,
});

describe("the home page's rows", () => {
  it("lists newest first, each with where its review stands", () => {
    const inbox = inboxOf([pr(1), pr(3), pr(2), pr(4)], [local("app-4", 4, { step: "narrate" })]);
    const rows = rowsOf(inbox, [
      summary("app-2", 2, { commit: "head2" }),
      summary("app-3", 3, { commit: "older" }),
      summary("app-4", 4, { commit: "head4" }),
    ]);
    expect(rows.map((row) => [row.pr.number, row.review.kind])).toEqual([
      [4, "running"],
      [3, "outdated"],
      [2, "current"],
      [1, "none"],
    ]);
  });

  it("counts a review that records no commit as out of date, never as current", () => {
    const [row] = rowsOf(inboxOf([pr(1)]), [summary("app-1", 1)]);
    expect(row!.review.kind).toBe("outdated");
  });

  it("needs the reader for a review they were asked for, or decisions on their own PR, not someone else's", () => {
    const rows = rowsOf(inboxOf([pr(1, { reviewRequested: true, author: "ann" }), pr(2), pr(3, { author: "ann" })]), [
      summary("app-2", 2, { commit: "head2", decisions: 2 }),
      summary("app-3", 3, { commit: "head3", decisions: 1 }),
    ]);
    expect(rows.map((row) => [row.pr.number, row.needsYou])).toEqual([
      [3, false],
      [2, true],
      [1, true],
    ]);
  });

  it("filters by author and repo, and offers the reader first", () => {
    const rows = rowsOf(inboxOf([pr(1), pr(2, { author: "zed" }), pr(3, { author: "ann", repo: "me/site" })]), []);
    expect(
      filterRows(rows, { everything: true, author: "zed", repo: null, bots: false }).map((row) => row.pr.number),
    ).toEqual([2]);
    expect(
      filterRows(rows, { everything: true, author: null, repo: "me/site", bots: false }).map((row) => row.pr.number),
    ).toEqual([3]);
    expect(filterOptions(rows, "me")).toEqual({ authors: ["me", "ann", "zed"], repos: ["me/app", "me/site"], bots: 0 });
  });

  it("shows only the PRs involving the reader unless asked for everything", () => {
    const rows = rowsOf(
      inboxOf([pr(1), pr(2, { author: "zed" }), pr(3, { author: "ann", reviewRequested: true })]),
      [],
    );
    const shown = (everything: boolean) =>
      filterRows(rows, { everything, author: null, repo: null, bots: false }).map((row) => row.pr.number);
    expect(shown(false)).toEqual([3, 1]);
    expect(shown(true)).toEqual([3, 2, 1]);
  });

  it("starts with a lone repo ticked, else what was saved and is still here", () => {
    expect(initialTicks(["me/app"], null)).toEqual(["me/app"]);
    expect(initialTicks(["me/app", "me/site"], null)).toEqual([]);
    expect(initialTicks(["me/app", "me/site"], ["me/site", "me/gone"])).toEqual(["me/site"]);
  });

  it("hides bots' PRs unless asked, and says how many", () => {
    const rows = rowsOf(inboxOf([pr(1), pr(2, { author: "dependabot[bot]" })]), []);
    const shown = (bots: boolean) =>
      filterRows(rows, { everything: true, author: null, repo: null, bots }).map((row) => row.pr.number);
    expect(shown(false)).toEqual([1]);
    expect(shown(true)).toEqual([2, 1]);
    expect(filterOptions(rows, "me")).toEqual({ authors: ["me"], repos: ["me/app"], bots: 1 });
    const botRepo = rowsOf(inboxOf([pr(1), pr(2, { author: "dependabot[bot]", repo: "me/old" })]), []);
    expect(filterOptions(botRepo, "me").repos).toEqual(["me/app"]);
    expect(filterOptions(botRepo, "me", true).repos).toEqual(["me/app", "me/old"]);
  });

  it("lists past reviews of merged or closed PRs, latest first, and none of an open one", () => {
    const inbox = inboxOf(
      [],
      [
        local("old", 1, { prState: "merged", closedAt: "2026-11-01T00:00:00Z" }),
        local("new", 2, { step: null, updatedAt: null, prState: "closed", closedAt: "2026-11-09T00:00:00Z" }),
        local("open", 3),
      ],
    );
    const past = pastReviews(inbox, [summary("old", 1, { verdict: "approve" })]);
    expect(past.map((review) => [review.name, review.state, review.verdict])).toEqual([
      ["new", "closed", null],
      ["old", "merged", "approve"],
    ]);
  });

  it("copies the start command, with --clone for another repo, or the back command for an out-of-date local run", () => {
    const open = [pr(3), pr(2, { repo: "me/site" }), pr(1)];
    const [here, elsewhere, outdated] = rowsOf(inboxOf(open, [local("app-1", 1)]), [
      summary("app-1", 1, { commit: "older" }),
    ]);
    expect(reviewCommand(here!, "me/app")).toBe("npx @traverso/pr-reviewer start 3");
    expect(reviewCommand(elsewhere!, "me/app")).toBe("npx @traverso/pr-reviewer start 2 --clone <path to its clone>");
    expect(reviewCommand(outdated!, "me/app")).toBe("npx @traverso/pr-reviewer back app-1 fetch");
  });

  it("starts afresh for an out-of-date committed review, which has no run to send back", () => {
    const [committed] = rowsOf(inboxOf([pr(1)], [local("app-1", 1, { step: null, updatedAt: null })]), [
      summary("app-1", 1, { commit: "older" }),
    ]);
    expect(committed!.review).toMatchObject({ kind: "outdated", canGoBack: false });
    expect(reviewCommand(committed!, "me/app")).toBe("npx @traverso/pr-reviewer start 1");
  });

  it("takes a PR's newest run, and a review with a local run before a committed one", () => {
    const runs = [
      local("app-1-old", 1, { step: "fix", updatedAt: "2026-11-01T00:00:00Z" }),
      local("app-1-new", 1, { step: "judge", updatedAt: "2026-11-05T00:00:00Z" }),
    ];
    expect(rowsOf(inboxOf([pr(1)], runs), [])[0]!.review).toMatchObject({ kind: "running", name: "app-1-new" });
    const reviews = [
      summary("app-1-zz-committed", 1, { commit: "head1" }),
      summary("app-1-local", 1, { commit: "head1" }),
    ];
    const folders = [local("app-1-zz-committed", 1, { step: null, updatedAt: null }), local("app-1-local", 1)];
    const [row] = rowsOf(inboxOf([pr(1)], folders), reviews);
    expect(row!.review).toMatchObject({ kind: "current", name: "app-1-local" });
    const committed = [summary("app-1-a", 1, { commit: "head1" }), summary("app-1-b", 1, { commit: "head1" })];
    expect(rowsOf(inboxOf([pr(1)]), committed)[0]!.review).toMatchObject({ name: "app-1-b" });
  });

  it("reads a repo from its remote, over SSH or HTTPS", () => {
    expect(repoFromRemote("git@github.com:me/app.git\n")).toBe("me/app");
    expect(repoFromRemote("https://github.com/me/app")).toBe("me/app");
    expect(repoFromRemote("https://github.com/me/app.git/")).toBe("me/app");
    expect(repoFromRemote("https://gitlab.com/me/app.git")).toBeNull();
  });
});

describe("the repos the home page lists", () => {
  it("finds the checkout and the repos nested in it, skipping dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "nested-"));
    ["libs/engine/.git", "node_modules/dep/.git", "a/b/c/d/e/deep/.git", "docs"].forEach((path) =>
      mkdirSync(join(root, path), { recursive: true }),
    );
    expect(nestedCheckouts(root)).toEqual([root, join(root, "libs/engine")]);
  });
});

describe("the inbox's GitHub half", () => {
  it("reads a first run from its pr.json before review.json exists, and a committed review with no state", () => {
    const root = mkdtempSync(join(tmpdir(), "reviews-"));
    const write = (path: string, data: unknown) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(data));
    };
    write("first/pr.json", { repo: "me/app", number: 7 });
    write("first/state.json", { at: "review", history: [{ at: "2026-11-02T00:00:00Z" }] });
    write("committed/review.json", { pr: { repo: "me/app", number: 3 } });
    write("empty/notes.txt", "");
    const snapshots = mkdtempSync(join(tmpdir(), "committed-"));
    mkdirSync(join(snapshots, "first"));
    writeFileSync(join(snapshots, "first", "review.json"), JSON.stringify({ pr: { repo: "me/app", number: 7 } }));
    // The local run wins over its committed snapshot, whichever root comes first.
    expect(reviewFolders([snapshots, root]).filter((folder) => folder.name === "first")).toEqual([
      { name: "first", repo: "me/app", number: 7, step: "review", updatedAt: "2026-11-02T00:00:00Z" },
    ]);
    expect(reviewFolders([root, snapshots]).filter((folder) => folder.name === "first")).toHaveLength(1);
    expect(reviewFolders([root]).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "committed", repo: "me/app", number: 3, step: null, updatedAt: null },
      { name: "first", repo: "me/app", number: 7, step: "review", updatedAt: "2026-11-02T00:00:00Z" },
    ]);
  });

  it("joins each folder of a listed repo with its PR's state, leaving off one gh couldn't read", () => {
    const pull = (fields: Partial<Pull>): Pull => ({
      head: { sha: "x" },
      state: "closed",
      merged: false,
      merged_at: null,
      closed_at: "2026-11-03T00:00:00Z",
      ...fields,
    });
    const folder = (name: string, repo: string, number: number) => ({
      name,
      repo,
      number,
      step: null,
      updatedAt: null,
    });
    const folders = [folder("merged", "me/app", 1), folder("closed", "me/app", 2), folder("gone", "me/app", 3)];
    const pulls = new Map([
      ["me/app#1", pull({ merged: true, merged_at: "2026-11-04T00:00:00Z" })],
      ["me/app#2", pull({})],
      ["me/app#3", null],
      ["me/else#4", pull({ state: "open" })],
    ]);
    const joined = joinReviews([...folders, folder("other", "me/else", 4)], pulls, ["me/app"]);
    expect(joined.map((review) => [review.name, review.prState, review.closedAt])).toEqual([
      ["merged", "merged", "2026-11-04T00:00:00Z"],
      ["closed", "closed", "2026-11-03T00:00:00Z"],
    ]);
  });

  it("combines statuses and check runs: a failure fails, then pending, then success; nothing is null", () => {
    const checkRun = (status: string, conclusion: string | null = null) => ({ status, conclusion });
    expect(combinedChecks([], [])).toBeNull();
    expect(combinedChecks(["success"], [checkRun("completed", "success")])).toBe("success");
    expect(combinedChecks([], [checkRun("completed", "skipped"), checkRun("in_progress")])).toBe("pending");
    expect(combinedChecks(["pending"], [checkRun("completed", "failure")])).toBe("failure");
    expect(combinedChecks(["error"], [])).toBe("failure");
  });

  it("maps with a limit on how many run at once, keeping order", async () => {
    let running = 0;
    let most = 0;
    const results = await mapLimited([5, 1, 4, 2, 3], 2, async (each) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, each));
      running -= 1;
      return each * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });
});

describe("the lists of reviews", () => {
  it("put the newest made first, then older reviews by PR number, then any that didn't parse", () => {
    const reviews = [
      summary("old-high", 9),
      summary("made-earlier", 2, { reviewedAt: "2026-11-01T00:00:00Z" }),
      summary("made-later", 1, { reviewedAt: "2026-11-20T00:00:00Z" }),
      summary("old-low", 3),
    ];
    expect(newestFirst(["broken", "old-low", "made-earlier", "old-high", "made-later"], reviews)).toEqual([
      "made-later",
      "made-earlier",
      "old-high",
      "old-low",
      "broken",
    ]);
  });
});

describe("other reviews", () => {
  it("lists only the reviews no row or past review links", () => {
    const inbox = inboxOf(
      [pr(1)],
      [
        local("app-1", 1),
        local("app-1-older", 1, { updatedAt: "2026-10-01T00:00:00Z" }),
        local("closed", 2, { prState: "merged" }),
      ],
    );
    const reviews = [summary("app-1", 1, { commit: "head1" }), summary("app-1-older", 1), summary("closed", 2)];
    const rows = rowsOf(inbox, reviews);
    const past = pastReviews(inbox, reviews);
    expect(otherReviews(["app-1", "app-1-older", "closed", "other-repo-9"], rows, past)).toEqual([
      "app-1-older",
      "other-repo-9",
    ]);
  });
});

describe("a review's summary", () => {
  it("is read from its review.json, as the app takes it", () => {
    const annotations = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/example/review.json"), "utf8"));
    const read = summaryOf("example-1", annotations);
    expect(read?.name).toBe("example-1");
    expect(read?.number).toBe(annotations.pr.number);
    expect(read?.verdict).toBe(annotations.verdict);
    expect(summaryOf("broken-1", { not: "a review" })).toBeUndefined();
  });
});
