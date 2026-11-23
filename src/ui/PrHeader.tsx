import { useCopy } from "./useCopy";
import type { Severity } from "../review/schema";
import { reReviewCommand, useReview, VERDICT_LABEL } from "./context";
import { Decision } from "./Decision";
import { SinceReview } from "./SinceReview";
import { SeverityPill } from "./Finding";
import { commentId } from "./state";

/** A command to run, with a button to copy it. */
function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="try">
      <span className="label">{label}</span>
      <code>{command}</code>
      <button onClick={() => copy(command)}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** The PR at a glance: what it's for, the verdict, and everything that needs the reader (INTENT-1). */
export function PrHeader() {
  const { review, dispatch } = useReview();
  const { pr, verdict, comments, tests, decisions, fixed, planned } = review.annotations;
  const unanchored = decisions.filter((decision) => review.commentAnchors[decision.id] === undefined);
  const counts = comments.reduce<Partial<Record<Severity, number>>>(
    (tally, comment) => ({ ...tally, [comment.kind]: (tally[comment.kind] ?? 0) + 1 }),
    {},
  );
  const jumpToComment = (id: string) => {
    const anchor = review.commentAnchors[id];
    if (anchor)
      dispatch({ type: "reveal", path: anchor.path, hunkIndex: anchor.hunkIndex, target: commentId(id), centre: true });
  };
  return (
    <section className="pr">
      <h1>
        {pr.title} <span>#{pr.number}</span>
      </h1>
      <div className="meta">
        <span>
          Merges <span className="branch">{pr.head}</span> into <span className="branch">{pr.base}</span>
        </span>
        <span>{pr.files} files</span>
        <span>
          <span className="plus">+{pr.added}</span> <span className="minus">−{pr.removed}</span>
        </span>
      </div>
      <SinceReview />
      <div className="gist-row">
        <span className="gist">{pr.gist}</span>
        <span className={`pill verdict ${verdict}`}>{VERDICT_LABEL[verdict]}</span>
        {decisions.length > 0 && (
          <span className="pill decision">
            {decisions.length} decision{decisions.length > 1 ? "s" : ""} for you
          </span>
        )}
        {Object.entries(counts).map(([kind, count]) => (
          <span key={kind} className={`pill ${kind}`}>
            {count} {kind}
            {count > 1 ? "s" : ""}
          </span>
        ))}
        {tests.gaps.length > 0 && <span className="pill gap">{tests.gaps.length} untested</span>}
      </div>
      <ul className="comments-list">
        {decisions.map((decision) => (
          <li key={decision.id}>
            <button onClick={() => jumpToComment(decision.id)}>
              <span className="pill decision">decision</span>
              <span className="t">{decision.title}</span>
            </button>
          </li>
        ))}
        {comments.map((comment) => (
          <li key={comment.id}>
            <button onClick={() => jumpToComment(comment.id)}>
              <SeverityPill kind={comment.kind} />
              <span className="t">{comment.title}</span>
            </button>
          </li>
        ))}
        {tests.gaps.length > 0 && (
          <li>
            <button
              onClick={() => dispatch({ type: "reveal", path: "", hunkIndex: null, target: "G-tests", centre: false })}
            >
              <SeverityPill kind="gap" />
              <span className="t">{tests.gaps.map((gap) => gap.title.replace(/^\.\.\./, "")).join(" · ")}</span>
            </button>
          </li>
        )}
      </ul>
      {unanchored.map((decision) => (
        <div key={decision.id} id={commentId(decision.id)}>
          <Decision decision={decision} />
        </div>
      ))}
      {fixed.length > 0 && (
        // Fixed rather than asked about: a finding with a clear direction is just done, and listed so it is seen.
        <details className="fixed">
          <summary>
            <span className="pill fixed">fixed</span> {fixed.length} thing{fixed.length > 1 ? "s" : ""} fixed while
            reviewing
          </summary>
          <ul>
            {fixed.map((item) => (
              <li key={item.title}>
                <b>{item.title}</b>
                {item.detail && <span className="fixed-detail"> {item.detail}</span>}
                {item.commit && <span className="mono fixed-detail"> {item.commit.slice(0, 7)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {planned.length > 0 && (
        // Already on the plan's Next list: captured and known, so only listed (CHECK-12).
        <details className="fixed">
          <summary>
            <span className="pill planned">planned</span> {planned.length} already on Next
          </summary>
          <ul>
            {planned.map((item) => (
              <li key={item.title}>
                <b>{item.title}</b> <span className="mono fixed-detail">{item.item}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {pr.notReReviewed && pr.notReReviewed.length > 0 && (
        <p className="not-rereviewed">
          {pr.notReReviewed.length === 1
            ? "1 commit after the review wasn't"
            : `${pr.notReReviewed.length} commits after the review weren't`}{" "}
          reviewed again: <span className="mono">{pr.notReReviewed.join(", ")}</span>. The run stops after one round of
          re-review, so whether to go again is yours:
        </p>
      )}
      {pr.notReReviewed && pr.notReReviewed.length > 0 && (
        <CopyCommand label="Re-review them:" command={reReviewCommand()} />
      )}
      <CopyCommand label="Try it:" command={pr.tryIt} />
    </section>
  );
}
