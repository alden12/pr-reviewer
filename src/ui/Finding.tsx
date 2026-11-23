import { useState, type ReactNode } from "react";
import type { Fix, Severity } from "../review/schema";
import { shortPath, useReview } from "./context";
import { highlightLine, languageOf } from "./highlight";

const SEVERITY_LABEL: Record<Severity, string> = {
  nit: "nit",
  question: "question",
  "request-changes": "request changes",
};

export const SeverityPill = ({ kind }: { kind: Severity | "gap" }) => (
  <span className={`pill ${kind}`}>{kind === "gap" ? "not tested" : SEVERITY_LABEL[kind]}</span>
);

const DONE_TEXT: Record<Fix["kind"], string> = { commit: "Committed to", "follow-up": "Filed in the repo's plan" };
const DEMO_TEXT: Record<Fix["kind"], string> = {
  commit: "Demo: nothing was actually pushed.",
  "follow-up": "Demo: nothing was actually filed.",
};
const PREVIEW_NOUN: Record<Fix["kind"], string> = { commit: "change", "follow-up": "draft" };

function FixPreview({ fix }: { fix: Fix }) {
  const { review } = useReview();
  if (fix.kind === "follow-up") {
    return (
      <div className="fix-preview">
        <div className="fix-meta">New item in the repo's plan</div>
        <div className="draft">
          <b>{fix.title}</b>
          <p>{fix.draft}</p>
        </div>
      </div>
    );
  }
  const language = languageOf(fix.file);
  return (
    <div className="fix-preview">
      <div className="fix-meta">
        {shortPath(fix.file)} · commit "{fix.message}" to <span className="mono">{review.annotations.pr.head}</span>
      </div>
      <div className="scroll">
        <table className="diff">
          <tbody>
            {fix.patch.map(([sign, number, text], index) => (
              <tr key={index} className={sign === "+" ? "add" : "ctx"}>
                <td className="num">{number ?? ""}</td>
                <td className="sign">{sign}</td>
                <td className="code" dangerouslySetInnerHTML={{ __html: highlightLine(text, language) }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A finding: what's wrong (the children), what to do about it, and a one-click fix with a preview
 * (CHECK-10). Applying is simulated, and says so, until the tool can write to a branch.
 */
export function Finding({
  id,
  kind,
  title,
  recommendation,
  fix,
  item,
  children,
}: {
  id: string;
  kind: Severity | "gap";
  title: string;
  recommendation: string;
  fix: Fix | undefined;
  /** A plan item it is about that isn't on Next yet (CHECK-12). */
  item?: string | undefined;
  children?: ReactNode;
}) {
  const { state } = useReview();
  const applied = state.applied.has(id);
  return (
    <div className={`finding ${kind}${applied ? " resolved" : ""}`}>
      <div className="head">
        <SeverityPill kind={kind} />
        {title}
      </div>
      {children}
      <div className="rec">
        <span className="rec-label">Recommendation</span>
        <p>{recommendation}</p>
      </div>
      {fix !== undefined && <FixRow id={id} fix={fix} />}
      {item !== undefined && <AddToNext item={item} title={title} />}
    </div>
  );
}

/** A finding's one-click fix: apply it (simulated) or preview it, and once applied, undo. */
function FixRow({ id, fix }: { id: string; fix: Fix }) {
  const { review, state, dispatch } = useReview();
  const applied = state.applied.has(id);
  const previewing = state.previews.has(id) && !applied;
  if (applied) {
    return (
      <div className="fix-row">
        <span className="applied">
          ✓ {DONE_TEXT[fix.kind]}
          {fix.kind === "commit" && <span className="mono"> {review.annotations.pr.head}</span>}
        </span>
        <span className="demo">{DEMO_TEXT[fix.kind]}</span>
        <button className="link" onClick={() => dispatch({ type: "remove", set: "applied", key: id })}>
          Undo
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="fix-row">
        <button className="primary" onClick={() => dispatch({ type: "add", set: "applied", key: id })}>
          {fix.label}
        </button>
        <button className="link" onClick={() => dispatch({ type: "toggle", set: "previews", key: id })}>
          {previewing ? "Hide" : "Preview"} {PREVIEW_NOUN[fix.kind]}
        </button>
      </div>
      {previewing && <FixPreview fix={fix} />}
    </>
  );
}

/**
 * The finding is about a plan item that isn't on Next: offer to put it there. Copies a prompt for the session to run,
 * as a decision does, until the app can write to the plan itself (ACT-2).
 */
function AddToNext({ item, title }: { item: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const [project, ref] = item.includes(":") ? item.split(":") : [undefined, item];
  const copy = () => {
    const where = project ? ` in project ${project}` : "";
    const prompt = `Add ${ref} to Next${where} (read it first, then set_next with the merged list): "${title}" came up in review.`;
    navigator.clipboard.writeText(prompt).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="fix-row">
      <span className="mono">{item}</span>
      <button onClick={copy}>{copied ? "Copied: paste to Claude" : "Add to Next"}</button>
    </div>
  );
}
