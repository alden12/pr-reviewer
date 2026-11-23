import { useLayoutEffect, useRef, useState } from "react";
import type { Occurrence } from "../review/model";
import { shortPath, useReview } from "./context";
import { lineId } from "./state";

/**
 * Every place a name appears in the PR (FLOW-9): a traced name grouped by step, anything else as its
 * definition then its uses. Clicking a place opens whatever hides it and scrolls there.
 */
export function FollowPopover() {
  const { review, state, dispatch } = useReview();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const popover = state.popover;

  // Flip above the name when there's no room below.
  useLayoutEffect(() => {
    if (!popover || !ref.current) return;
    const height = ref.current.offsetHeight;
    const fits = popover.top + height < window.innerHeight - 16;
    setTop(fits ? popover.top : Math.max(16, popover.top - height - 30));
  }, [popover]);

  if (!popover) return null;
  const info = review.annotations.names[popover.name] ?? {};
  const places = review.occurrences[popover.name] ?? [];
  const goTo = (place: Occurrence) =>
    dispatch({
      type: "reveal",
      path: place.path,
      hunkIndex: place.hunkIndex,
      target: lineId(place.path, place.hunkIndex, place.lineIndex),
      centre: true,
    });
  const placeButton = (place: Occurrence) => (
    <button key={`${place.path}:${place.hunkIndex}:${place.lineIndex}`} onClick={() => goTo(place)}>
      <span className="where">
        <b>
          {shortPath(place.path)}:{place.newNumber}
        </b>
        {place.defines && " · defined here"}
      </span>
      <span className="snip">{place.text}</span>
    </button>
  );
  const byStep = review.annotations.steps
    .map((step) => ({ step, inStep: places.filter((place) => place.step === step.id) }))
    .filter(({ inStep }) => inStep.length > 0);
  const definitions = places.filter((place) => place.defines);
  const uses = places.filter((place) => !place.defines);
  const left = Math.min(Math.max(16, popover.left), window.innerWidth - 456);
  return (
    <div
      className="pop"
      ref={ref}
      style={{ left: Math.max(16, left), top: top ?? popover.top }}
      role="dialog"
      aria-label={`Where ${popover.name} appears`}
    >
      <h3>
        <code>{popover.name}</code>
        {info.what && ` · ${info.what}`}
      </h3>
      <div className="sub">
        {places.length} place{places.length === 1 ? "" : "s"} in this PR
      </div>
      {info.trace &&
        byStep.map(({ step, inStep }) => (
          <div key={step.id}>
            <div className="step-label">{step.short ?? step.title.split(":")[0]}</div>
            {inStep.map(placeButton)}
          </div>
        ))}
      {!info.trace && (definitions.length > 0 || info.outside) && <div className="step-label">Defined</div>}
      {!info.trace && definitions.map(placeButton)}
      {!info.trace && info.outside && <div className="outside">{info.outside}</div>}
      {!info.trace && uses.length > 0 && <div className="step-label">Used in this PR</div>}
      {!info.trace && uses.map(placeButton)}
    </div>
  );
}
