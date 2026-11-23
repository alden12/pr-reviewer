import { useState } from "react";
import type { Decision as DecisionAnnotation } from "../review/schema";
import { useReview } from "./context";

/**
 * A question only the reader can settle, with the ways it could go. Choosing one copies a prompt for the agent that
 * wrote the PR, to paste into its session: a page cannot reach that session itself.
 */
export function Decision({ decision }: { decision: DecisionAnnotation }) {
  const { review } = useReview();
  const [copied, setCopied] = useState<string | null>(null);
  const { pr } = review.annotations;
  const choose = (label: string, detail: string) => {
    const prompt = `On #${pr.number} (${pr.head}), "${decision.title}": go with "${label}". ${detail}`;
    navigator.clipboard.writeText(prompt).then(
      () => setCopied(label),
      () => setCopied(null),
    );
  };
  return (
    <div className="decision-card">
      <div className="head">
        <span className="pill decision">decision</span>
        {decision.title}
      </div>
      <p>{decision.body}</p>
      <ol className="options">
        {decision.options.map((option) => (
          <li key={option.label} className={option.recommended ? "recommended" : undefined}>
            <div className="option-text">
              <b>{option.label}</b>
              {option.recommended && <span className="rec-badge">recommended</span>}
              <span className="option-detail">{option.detail}</span>
            </div>
            <button className={option.recommended ? "primary" : ""} onClick={() => choose(option.label, option.detail)}>
              {copied === option.label ? "Copied: paste to Claude" : "Go with this"}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
