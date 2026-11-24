/**
 * attraverso's pane: the viewer on a wide screen shows the home page in an iframe beside the plan (`?in=pane`), and
 * links out of it open in the whole window (main.tsx). What it takes for a review opened from there to come back to
 * the pane rather than to this app's own home page.
 */

/** Whether this page is the one in the pane. */
export const inPane = (): boolean => new URLSearchParams(window.location.search).get("in") === "pane";

/**
 * A review's link from the home page: from the pane it says so (`from=pane`), since the review opens in the whole
 * window and its URL is all it has to tell a review opened from the pane from one opened any other way.
 */
export const reviewHref = (name: string): string =>
  `?review=${encodeURIComponent(name)}${inPane() ? "&from=pane" : ""}`;

const BACK = "reviewer.back";

/**
 * The viewer page this was opened from, as its tab passes it (`?back=`): its project and its write token, which a bare
 * `/` would lose, and from the pane the tab the pane held (`pane=`), so going back reopens it. Kept for the tab's
 * session, since opening a review and coming back drops the query; only a path on this host is taken.
 */
export function cameFrom(): string | null {
  const read = (): string | null => {
    const passed = new URLSearchParams(window.location.search).get("back");
    try {
      if (passed !== null) sessionStorage.setItem(BACK, passed);
      return passed ?? sessionStorage.getItem(BACK);
    } catch {
      return passed;
    }
  };
  const back = read();
  // A path on this host: `//x` and `/\x` would both leave it.
  return back !== null && /^\/(?![/\\])/.test(back) ? back : null;
}

/**
 * Where a review's back link goes when it was opened from the pane: the viewer with the pane open, which the pane's
 * page kept (`cameFrom`; the iframe shares the window's session storage, being the same origin). Null for a review
 * opened any other way, whose link stays this app's home page.
 */
export const paneBack = (): string | null =>
  new URLSearchParams(window.location.search).get("from") === "pane" ? cameFrom() : null;
