import { useEffect, useMemo, useReducer, useState, type KeyboardEvent, type MouseEvent } from "react";
import { namePattern, type Review } from "../review/model";
import { hasTests, ReviewContext } from "./context";
import { FileCard, GhostFile } from "./FileCard";
import { FileTree } from "./FileTree";
import { FollowPopover } from "./FollowPopover";
import { PrHeader } from "./PrHeader";
import { saveViewed, loadViewed } from "./viewedStore";
import { initialState, makeReducer, fileId, readingEvent, type Action, type ReadingEvent } from "./state";
import { TestsCard } from "./TestsCard";
import { Toolbar } from "./Toolbar";

/**
 * The file under the pinned toolbar, for the tree to light up. Worked out from where each file is on every scroll
 * (once a frame, and again when scrolling settles) rather than from an observer's crossings, which a fast scroll
 * skips past and which never fire for the file being scrolled back into.
 */
function useCurrentFile(review: Review): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const elements = review.order.flatMap(({ path }) => {
      const element = document.getElementById(fileId(path));
      return element ? [{ path, element }] : [];
    });
    const measure = () => {
      // Where a jump lands a file (the page's scroll padding, plus the file's 16px scroll margin), and a little more for
      // rounding: measured from the same padding, so the file just jumped to is the one lit up, not the one before.
      const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 92) + 16 + 8;
      const above = elements.filter(({ element }) => element.getBoundingClientRect().top <= line);
      setCurrent(above.at(-1)?.path ?? elements[0]?.path ?? null);
    };
    let frame = 0;
    let settle = 0;
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(() => ((frame = 0), measure()));
      clearTimeout(settle);
      settle = window.setTimeout(measure, 120);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [review]);
  return current;
}

export function App({
  review,
  record,
  home,
}: {
  review: Review;
  record?: (event: ReadingEvent) => void;
  /** What the back link in the toolbar goes to; absent when there is nowhere to go back to. */
  home?: string;
}) {
  const reducer = useMemo(() => makeReducer(review), [review]);
  // Files marked viewed come back on a reload (and after a rebuild, unless their diff changed), each folded away.
  const [state, plainDispatch] = useReducer(reducer, review, (loaded) => {
    const viewed = loadViewed(loaded);
    return { ...initialState, viewed, collapsed: new Set(viewed) };
  });
  useEffect(() => saveViewed(review, state.viewed), [review, state.viewed]);
  // Every fold the reader opens or folds back by hand is a hint about what they want to see (KNOW-4).
  const dispatch = useMemo(
    () =>
      (action: Action): void => {
        const event = record && readingEvent(review, action);
        if (event) record(event);
        plainDispatch(action);
      },
    [review, record],
  );
  const names = useMemo(() => namePattern(review.annotations.names), [review]);
  const current = useCurrentFile(review);

  // After a reveal has opened what hid its target, bring the target into view and flash it. Each
  // reveal makes a new scrollTo object, so this runs once per reveal, even to the same target.
  useEffect(() => {
    if (!state.scrollTo) return;
    const element = document.getElementById(state.scrollTo.id);
    element?.scrollIntoView({ block: state.scrollTo.centre ? "center" : "start" });
    element?.classList.add("flash");
    setTimeout(() => element?.classList.remove("flash"), 1400);
  }, [state.scrollTo]);

  useEffect(() => {
    const close = () => plainDispatch({ type: "closePopover" });
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Followable names are spans inside highlighted HTML, so their clicks are caught here.
  const openFollow = (element: Element) => {
    const rect = element.getBoundingClientRect();
    dispatch({
      type: "openPopover",
      name: (element as HTMLElement).dataset.name ?? "",
      left: rect.left,
      top: rect.bottom + 6,
    });
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const follow = target.closest(".follow");
    if (follow) return openFollow(follow);
    if (!target.closest(".pop")) dispatch({ type: "closePopover" });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as Element;
    if (target.matches(".follow") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openFollow(target);
    }
  };

  const { steps, notForReview } = review.annotations;
  return (
    <ReviewContext.Provider value={{ review, state, dispatch, names }}>
      <div className="page" onClick={onClick} onKeyDown={onKeyDown}>
        <PrHeader />
        <Toolbar {...(home ? { home } : {})} />
        <div className="layout">
          <FileTree current={current} />
          <div className="files">
            {steps.map((step, index) => (
              <div key={step.id} className="step">
                <div className="step-divider">
                  <span className="n">Step {index + 1}</span>
                  <span className="t">{step.title}</span>
                </div>
                {step.files.map((path) => (
                  <FileCard key={path} path={path} />
                ))}
              </div>
            ))}
            {/* Only when there is something in it: an empty "0 files" card reads as something to look at. */}
            {(hasTests(review.annotations.tests) || notForReview.length > 0) && (
              <div className="step-divider">
                <span className="n">Folded</span>
                <span className="t">Tests and files that need no review</span>
              </div>
            )}
            {hasTests(review.annotations.tests) && <TestsCard />}
            {notForReview.map(({ path, why }) => (
              <GhostFile key={path} path={path} why={why} />
            ))}
          </div>
        </div>
      </div>
      {state.popover && <FollowPopover key={`${state.popover.name}:${state.popover.left}:${state.popover.top}`} />}
    </ReviewContext.Provider>
  );
}
