import { hunkIdentity } from "../diff/parseDiff";
import type { Review } from "../review/model";

/**
 * The files the reader marked viewed, kept in the browser across reloads and rebuilds of the review, as GitHub keeps
 * them. Each is stored with a fingerprint of its diff, so a file whose diff has changed since (a commit pushed after
 * the reader saw it) comes back unviewed: what they ticked was the old diff, and the new lines are unread. Keyed by
 * repo and PR number rather than the review's folder name, so a review rebuilt under another name keeps them too.
 *
 * Browser storage can be missing or refuse (a private window, blocked site data), so every access is guarded and the
 * app works without it: the ticks then last as long as the tab, as they always did.
 */
const storageKey = (review: Review) => `viewed:${review.annotations.pr.repo}#${review.annotations.pr.number}`;

/**
 * FNV-1a over the file's diff lines, each its sign and text only: cheap, stable, and only ever compared with itself.
 * Line numbers are left out (`hunkIdentity`, as the fold step's hunk hash), so a rebase that only shifts the file keeps it viewed.
 */
export function fingerprint(review: Review, path: string): string {
  // FNV-1a's 32-bit offset basis; each character is xored in, then multiplied by its prime.
  let hash = 0x811c9dc5;
  const text = (review.files[path]?.hunks ?? []).map(hunkIdentity).join("\n");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** The stored files still viewed: each one in this review whose diff matches what was ticked. */
export function loadViewed(review: Review): Set<string> {
  try {
    const stored = JSON.parse(globalThis.localStorage.getItem(storageKey(review)) ?? "{}") as Record<string, string>;
    return new Set(
      Object.keys(stored).filter((path) => path in review.files && stored[path] === fingerprint(review, path)),
    );
  } catch {
    return new Set();
  }
}

export function saveViewed(review: Review, viewed: ReadonlySet<string>): void {
  try {
    const entries = [...viewed].map((path) => [path, fingerprint(review, path)]);
    globalThis.localStorage.setItem(storageKey(review), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage refused: the ticks last as long as the tab.
  }
}
