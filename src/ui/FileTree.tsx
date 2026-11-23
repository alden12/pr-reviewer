import { useEffect, useState } from "react";
import { distinctNames, useReview } from "./context";
import { fileId } from "./state";

const stepLabel = (step: { title: string; short?: string }) => step.short ?? step.title.split(":")[0];

/** The files in flow order, grouped by step, with the one being read lit up. */
export function FileTree({ current }: { current: string | null }) {
  const { review, state, dispatch } = useReview();
  const { steps, tests, notForReview } = review.annotations;
  // The one file whose menu is open, if any.
  const [menu, setMenu] = useState<string | null>(null);
  // An open menu closes on Escape or a click anywhere outside it, as menus do.
  useEffect(() => {
    if (menu === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".tree .menu, .tree .kebab") == null) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menu]);
  const names = distinctNames([
    ...steps.flatMap((step) => step.files),
    ...tests.files,
    ...notForReview.map(({ path }) => path),
  ]);
  const nameOf = (path: string) => names.get(path) ?? path;
  const goTo = (path: string) =>
    dispatch({ type: "reveal", path, hunkIndex: null, target: fileId(path), centre: false });
  const fileButton = (path: string, dim = false) => {
    const file = review.files[path];
    const viewed = state.viewed.has(path);
    const classes = [dim ? "dim" : "", viewed ? "done" : ""].filter(Boolean).join(" ");
    const collapsed = state.collapsed.has(path);
    const choose = (action: () => void) => () => {
      action();
      setMenu(null);
    };
    return (
      <div key={path}>
        <div className={`row${current === path ? " here" : ""}`}>
          <button className={classes} onClick={() => goTo(path)}>
            <span className="name">{nameOf(path)}</span>
            {file && (
              <span className="stat">
                +{file.added} −{file.removed}
              </span>
            )}
          </button>
          <button
            className="kebab"
            aria-label={`More for ${nameOf(path)}`}
            aria-expanded={menu === path}
            onClick={() => setMenu(menu === path ? null : path)}
          >
            ⋮
          </button>
        </div>
        {menu === path && (
          <div className="menu" role="menu">
            <button role="menuitem" onClick={choose(() => dispatch({ type: "setViewed", path, viewed: !viewed }))}>
              {viewed ? "Mark not viewed" : "Mark viewed"}
            </button>
            <button role="menuitem" onClick={choose(() => dispatch({ type: "toggle", set: "collapsed", key: path }))}>
              {collapsed ? "Expand" : "Collapse"}
            </button>
          </div>
        )}
      </div>
    );
  };
  return (
    <nav className="tree" aria-label="Files in flow order">
      {steps.map((step, index) => (
        <div key={step.id} className="group">
          <div className="group-name">
            {index + 1} · <b>{stepLabel(step)}</b>
          </div>
          {step.files.map((path) => fileButton(path))}
        </div>
      ))}
      {(tests.files.length > 0 || notForReview.length > 0) && (
        <div className="group">
          <div className="group-name">Folded</div>
          {tests.files.map((path) => fileButton(path, true))}
          {notForReview.map(({ path }) => (
            <button key={path} className="dim" disabled>
              <span className="name">{nameOf(path)}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
