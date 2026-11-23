import { createContext, useContext, type Dispatch } from "react";
import type { Review } from "../review/model";
import type { Action, ViewState } from "./state";

export interface ReviewContextValue {
  review: Review;
  state: ViewState;
  dispatch: Dispatch<Action>;
  /** The followable names as one regex, built once. */
  names: RegExp;
}

export const ReviewContext = createContext<ReviewContextValue | null>(null);

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value) throw new Error("useReview needs a ReviewContext above it");
  return value;
}

export const shortPath = (path: string) => path.split("/").pop() ?? path;

/**
 * Each path by its shortest tail that no other path in the list shares: the file name, or as many folders before it
 * as it takes (`site/vite.config.ts` beside `roadmap/vite.config.ts`), so two files never read the same.
 */
export function distinctNames(paths: readonly string[]): Map<string, string> {
  const tail = (path: string, parts: number) => path.split("/").slice(-parts).join("/");
  const nameOf = (path: string, parts = 1): string => {
    const name = tail(path, parts);
    const shared = paths.some((other) => other !== path && tail(other, parts) === name);
    return shared && name !== path ? nameOf(path, parts + 1) : name;
  };
  return new Map(paths.map((path) => [path, nameOf(path)]));
}

/** Whether the PR has anything to say about tests: a test file, a promise one covers, or a gap. */
export const hasTests = (tests: { files: unknown[]; tested: unknown[]; gaps: unknown[] }): boolean =>
  tests.files.length + tests.tested.length + tests.gaps.length > 0;

/** The command that sends this review back for another round of review. Read from the page's URL (none in Node). */
export const reReviewCommand = (): string => {
  const search = (globalThis as { location?: { search: string } }).location?.search ?? "";
  return `npx @traverso/pr-reviewer back ${new URLSearchParams(search).get("review") ?? "<name>"} review`;
};

/**
 * A verdict in words, for the review's header and the home page alike: "comment" alone read as a badge about a comment,
 * where it means the review found nothing blocking.
 */
export const VERDICT_LABEL = {
  approve: "approved",
  comment: "comments only",
  "request-changes": "changes requested",
} as const;
