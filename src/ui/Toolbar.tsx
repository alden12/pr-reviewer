import { useLayoutEffect, useRef } from "react";
import { useReview } from "./context";
import { shownCounts } from "./state";

/**
 * What is left to read: the changed lines on screen in files not yet viewed (marking a file viewed folds it away),
 * against the PR's totals. It falls as the reader works through, and rises when they open a fold.
 */
function LeftToRead() {
  const { review, state } = useReview();
  const { pr } = review.annotations;
  const shown = shownCounts(review, state);
  const of = (count: number, total: number) => (count < total ? <span className="of"> (of {total})</span> : null);
  return (
    <span title="Changed lines still to read on screen, of the PR's total">
      to read <span className="plus">+{shown.added}</span>
      {of(shown.added, pr.added)} <span className="minus">−{shown.removed}</span>
      {of(shown.removed, pr.removed)}
    </span>
  );
}

/**
 * View switches and progress, pinned to the top as the reader scrolls: the defaults suit a first read, and each can
 * be turned off.
 */
export function Toolbar({ home, homeHref }: { home?: string; homeHref?: string }) {
  const { review, state, dispatch } = useReview();
  const folded = Object.values(review.annotations.blocks)
    .flat()
    .filter((block) => block.fold).length;
  const viewed = review.order.filter(({ path }) => state.viewed.has(path)).length;
  const into = review.annotations.translation?.into;
  const bar = useRef<HTMLDivElement>(null);
  // The bar wraps on a narrow screen, so its height is measured, not guessed: jumps and the file tree sit below it.
  useLayoutEffect(() => {
    const element = bar.current;
    if (element === null) return;
    const measure = () =>
      document.documentElement.style.setProperty("--toolbar-h", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="toolbar" ref={bar}>
      {home && (
        // The page with no review named: the open PRs in the dev server, the list of reviews in a build of several.
        <a className="back" href={homeHref ?? globalThis.location?.pathname ?? "./"}>
          ← {home}
        </a>
      )}
      <span>
        Files in reading order · {folded > 0 && `${folded} low-value block${folded === 1 ? "" : "s"} folded · `}
        <span className="hint">dotted names can be followed</span>
      </span>
      <span className="controls">
        <button aria-pressed={state.showWhy} onClick={() => dispatch({ type: "flip", flag: "showWhy" })}>
          Whys
        </button>
        {into && (
          <button
            aria-pressed={state.translate}
            onClick={() => dispatch({ type: "flip", flag: "translate" })}
            title={`Show the key Rust lines in ${into}`}
          >
            Rust in {into}
          </button>
        )}
        <button
          aria-pressed={state.showComments}
          onClick={() => dispatch({ type: "flip", flag: "showComments" })}
          title="The code's own comments; the headings say what is worth knowing from them"
        >
          Comments
        </button>
        <button aria-pressed={state.showAll} onClick={() => dispatch({ type: "flip", flag: "showAll" })}>
          Show all code
        </button>
        <span className="progress">
          {viewed} / {review.order.length} viewed · <LeftToRead />
        </span>
      </span>
    </div>
  );
}
