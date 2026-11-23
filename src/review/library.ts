/**
 * Which reviews the page reads (DIST-2): the server's answer to `api/reviews` when there is one (an object of files
 * keyed as the glob keys them), else the bundled committed ones. `served` is whether the server answered, which is
 * also whether the home page, the diffs and the reading log can be asked for.
 */
export function sourceOf(
  fromServer: unknown,
  bundled: Record<string, unknown>,
): { served: boolean; files: Record<string, unknown> } {
  const served = fromServer !== null && typeof fromServer === "object" && !Array.isArray(fromServer);
  return { served, files: served ? (fromServer as Record<string, unknown>) : bundled };
}

/**
 * The reviews the app reads, by name: each is a folder holding a `diff.json` and a `review.json`, under `reviews/`
 * (this package's committed ones) or `reviews.local/` (the key the server gives the runs' reviews, beside the plan).
 * Takes files keyed by path, the shape `import.meta.glob` gives, so it is tested without a bundler.
 */
export function reviewLibrary(files: Record<string, unknown>) {
  const reviewPaths = Object.keys(files).filter((path) => path.endsWith("/review.json"));
  const names = [...new Set(reviewPaths.map((path) => path.split("/").at(-2)!))].sort();
  /**
   * A review's two files, or null for a name with no review. A name in both folders is the local one: that is where its
   * runs write, so the committed copy is a snapshot (for reading where the repo is, a phone included) that a later run
   * leaves behind.
   */
  const filesOf = (name: string) => {
    const named = reviewPaths.filter((path) => path.split("/").at(-2) === name);
    const reviewPath = named.find((path) => path.includes("/reviews.local/")) ?? named[0];
    if (reviewPath === undefined) return null;
    const folder = reviewPath.slice(0, -"review.json".length);
    return { diff: files[`${folder}diff.json`], annotations: files[reviewPath] };
  };
  /** The review to show: the one asked for, or the only one there is; null shows the list. */
  const choose = (requested: string | null): string | null => {
    if (requested !== null) return names.includes(requested) ? requested : null;
    return names.length === 1 ? names[0]! : null;
  };
  /** A run's review, under `reviews.local/`: the reviews whose reading the server may log (KNOW-4). */
  const isLocal = (name: string) =>
    reviewPaths.some((path) => path.split("/").at(-2) === name && path.includes("/reviews.local/"));
  return { names, filesOf, choose, isLocal };
}
