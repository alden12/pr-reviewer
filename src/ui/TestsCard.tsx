import { useReview } from "./context";
import { FileCard } from "./FileCard";
import { Finding } from "./Finding";

/**
 * The tests, folded: what the PR promises that a test covers, and each gap with a recommendation and a
 * test to commit (FLOW-5, CHECK-2). The test files themselves open on request.
 */
export function TestsCard() {
  const { review, state, dispatch } = useReview();
  const { tests, comments } = review.annotations;
  const open = state.openGroups.has("tests");
  const promised = tests.tested.length + tests.gaps.length;
  const commentCount = comments.filter((comment) => tests.files.includes(comment.path)).length;
  return (
    <section className="group-card" id="G-tests">
      <button className="group-toggle" onClick={() => dispatch({ type: "toggle", set: "openGroups", key: "tests" })}>
        <span className="g-title">{open ? "▾" : "▸"} Tests</span>
        <span className="g-sub">
          {tests.files.length === 1 ? "1 file" : `${tests.files.length} files`}, folded · {tests.tested.length} of{" "}
          {promised} promise{promised === 1 ? "" : "s"} tested
          {commentCount > 0 && ` · ${commentCount} comment${commentCount > 1 ? "s" : ""}`}
        </span>
      </button>
      <ul className="tested">
        {tests.tested.map((promise) => (
          <li key={promise}>
            <span className="yes">Tested:</span> {promise}
          </li>
        ))}
      </ul>
      <div className="gap-list">
        {tests.gaps.map((gap) => (
          <Finding
            key={gap.id}
            id={gap.id}
            kind="gap"
            title={gap.title}
            recommendation={gap.recommendation}
            fix={gap.fix}
          />
        ))}
      </div>
      {open && (
        <div className="inner">
          {tests.files.map((path) => (
            <FileCard key={path} path={path} />
          ))}
        </div>
      )}
    </section>
  );
}
