import { useEffect, useState } from "react";
import { sinceSchema, type Since } from "../inbox/rows";
import { useReview } from "./context";

/**
 * The commits this review doesn't cover, at the top of its header: each one's short hash and subject, linked to it on
 * GitHub, so the reader can judge whether it is worth another round (FLOW-17 will show their changes in place). The
 * server asks GitHub (`api/since`, `pipeline/host.ts`); a built file opened on its own has no one to ask, and a review
 * that never recorded its head has nothing to compare, so both show nothing rather than a guess.
 */
export function SinceReview() {
  const { review } = useReview();
  const { repo, number, commit } = review.annotations.pr;
  const [since, setSince] = useState<Since | null>(null);
  useEffect(() => {
    if (commit === undefined) return;
    let current = true;
    const query = new URLSearchParams({ repo, number: String(number), from: commit });
    fetch(`api/since?${query}`)
      .then(async (response) => (response.ok ? sinceSchema.parse(await response.json()) : null))
      .then(
        (data) => current && setSince(data),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [repo, number, commit]);
  if (!since || since.commits.length === 0) return null;
  const count = since.commits.length;
  return (
    <div className="since-review">
      <strong>
        {count} {count === 1 ? "commit" : "commits"} since this review, not reviewed:
      </strong>
      <ul>
        {since.commits.map((each) => (
          <li key={each.sha}>
            <a href={each.url}>
              <code>{each.sha.slice(0, 7)}</code>
            </a>{" "}
            {each.subject}
          </li>
        ))}
      </ul>
    </div>
  );
}
