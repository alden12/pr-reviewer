import { useEffect, useMemo, useState } from "react";
import {
  filterOptions,
  filterRows,
  otherReviews,
  inboxSchema,
  pastReviews,
  reviewCommand,
  rowsOf,
  type Filters,
  type Inbox,
  type ReviewSummary,
  type Row,
} from "../inbox/rows";
import { VERDICT_LABEL } from "./context";
import { ReviewLinks } from "./Picker";
import { useCopy } from "./useCopy";

/** A date as the list reads it: "today", "3 days ago", then the date itself past a fortnight. */
const ago = (iso: string, now = Date.now()) => {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 14 ? `${days} days ago` : new Date(iso).toLocaleDateString();
};

const CHECKS: Record<NonNullable<Row["pr"]["checks"]>, { label: string; tone: string }> = {
  success: { label: "checks passed", tone: "ok" },
  pending: { label: "checks running", tone: "run" },
  failure: { label: "checks failed", tone: "bad" },
  error: { label: "checks errored", tone: "bad" },
  unknown: { label: "checks unknown", tone: "none" },
};

/** Why the list is empty: nothing open, only bots' (hidden), or the filters. */
const emptyNotice = (total: number, bots: number, filters: Filters) => {
  if (total === 0) return "No open pull requests.";
  if (total === bots && !filters.bots && filters.author === null) return "Only bots' pull requests are open.";
  return "None match these filters.";
};

/** The review's pill: where it stands, and what it came to. */
function ReviewPill({ review }: { review: Row["review"] }) {
  if (review.kind === "none") return <span className="pill none">not reviewed</span>;
  if (review.kind === "running") return <span className="pill run">reviewing: {review.step}</span>;
  return review.kind === "current" ? (
    <span className="pill ok">reviewed: {VERDICT_LABEL[review.verdict]}</span>
  ) : (
    <span
      className="pill warn"
      title={`The PR has commits the review doesn't cover. Its verdict then: ${VERDICT_LABEL[review.verdict]}.`}
    >
      review out of date
    </span>
  );
}

/** Start a review, or send an out-of-date one back for the new head: copies the command until the app can run it. */
function ReviewButton({ row, here }: { row: Row; here: string | null }) {
  const [copied, copy] = useCopy();
  const label = row.review.kind === "outdated" ? "Review again" : "Review";
  const command = reviewCommand(row, here);
  return (
    <button className="action" onClick={() => copy(command)} title={`Copies: ${command}`}>
      {copied ? "Command copied" : label}
    </button>
  );
}

function PrRow({ row, me, here }: { row: Row; me: string; here: string | null }) {
  const { pr, review } = row;
  const decisions = "decisions" in review ? review.decisions : 0;
  return (
    <li className={`pr-row${row.needsYou ? " needs-you" : ""}`}>
      <div className="pr-meta">
        <span className="pr-ref">
          {pr.repo} #{pr.number}
        </span>
        <span className={`author${pr.author === me ? " me" : ""}`}>
          <span className="avatar" aria-hidden="true">
            {pr.author.slice(0, 1).toUpperCase()}
          </span>
          {pr.author === me ? "you" : pr.author}
        </span>
        <span className="when">opened {ago(pr.createdAt)}</span>
      </div>
      <a className="pr-title" href={pr.url}>
        {pr.draft && <span className="draft">Draft</span>}
        {pr.title}
      </a>
      <div className="pr-pills">
        {pr.checks && <span className={`pill ${CHECKS[pr.checks].tone}`}>{CHECKS[pr.checks].label}</span>}
        <ReviewPill review={review} />
        {pr.reviewRequested && <span className="pill warn">your review requested</span>}
        {row.mine && decisions > 0 && (
          <span className="pill warn">
            {decisions} {decisions === 1 ? "decision" : "decisions"} for you
          </span>
        )}
      </div>
      <div className="pr-actions">
        {review.kind !== "none" && (
          <a className="action primary" href={`?review=${encodeURIComponent(review.name)}`}>
            Open review
          </a>
        )}
        {(review.kind === "none" || review.kind === "outdated") && <ReviewButton row={row} here={here} />}
      </div>
    </li>
  );
}

/** One filter: "All", then each value, as chips. */
function FilterChips({
  label,
  values,
  chosen,
  name,
  onChoose,
}: {
  label: string;
  values: string[];
  chosen: string | null;
  name: (value: string) => string;
  onChoose: (value: string | null) => void;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      <span className="chips-label">{label}</span>
      {[null, ...values].map((value) => (
        <button key={value ?? "all"} aria-pressed={chosen === value} onClick={() => onChoose(value)}>
          {value === null ? "All" : name(value)}
        </button>
      ))}
    </div>
  );
}

/**
 * Reviews no list above links, so every review stays one click away: a review of another repo, of a PR GitHub couldn't
 * read, or an older run. Before GitHub has answered (or when it can't), that is all of them.
 */
function OtherReviews({ names, all }: { names: string[]; all: boolean }) {
  if (names.length === 0) return null;
  return (
    <details className="past">
      <summary>
        {all ? "Reviews here" : "Other reviews"} · {names.length}
      </summary>
      <ReviewLinks names={names} />
    </details>
  );
}

function PastReviews({ inbox, reviews }: { inbox: Inbox; reviews: ReviewSummary[] }) {
  const past = pastReviews(inbox, reviews);
  if (past.length === 0) return null;
  // Two reviews of one PR (an older run beside the latest) would read as the same row, so those name themselves.
  const perPr = past.reduce(
    (counts, review) =>
      counts.set(`${review.repo}#${review.number}`, (counts.get(`${review.repo}#${review.number}`) ?? 0) + 1),
    new Map<string, number>(),
  );
  return (
    <details className="past">
      <summary>Past reviews · {past.length}</summary>
      <ul>
        {past.map((review) => (
          <li key={review.name}>
            <a href={`?review=${encodeURIComponent(review.name)}`}>
              <span className="pr-ref">
                {review.repo} #{review.number}
              </span>{" "}
              {review.title}
              {(perPr.get(`${review.repo}#${review.number}`) ?? 0) > 1 && (
                <span className="past-name"> ({review.name})</span>
              )}
            </a>
            <span className="past-state">
              {review.state}
              {review.closedAt && ` ${ago(review.closedAt)}`}
              {review.verdict && `, ${VERDICT_LABEL[review.verdict]}`}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const BACK = "reviewer.back";

/**
 * The viewer page this was opened from, as its tab passes it (`?back=`): its project and its write token, which a bare
 * `/` would lose. Kept for the tab's session, since opening a review and coming back drops the query; only a path on
 * this host is taken.
 */
function cameFrom(): string | null {
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
 * The reviewer's home page (INBOX-1): every open PR in this repo and the repos nested in it, newest first, with its review's state and
 * the one thing to do next; then the reviews kept here whose PR has merged or closed. The data comes from the
 * reviewer's server, which asks GitHub (`api/inbox`, `pipeline/host.ts`); the reviews come from it too (`api/reviews`).
 */
export function Home({ reviews, names }: { reviews: ReviewSummary[]; names: string[] }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ author: null, repo: null, bots: false });
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let current = true;
    fetch("api/inbox")
      .then(async (response) => {
        const body = await response.text();
        if (!response.ok) throw new Error(body || `the server answered ${response.status}`);
        return inboxSchema.parse(JSON.parse(body));
      })
      .then(
        (data) => current && setInbox(data),
        (error: unknown) => current && setFailure(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      current = false;
    };
  }, [loads]);

  const rows = useMemo(() => (inbox ? rowsOf(inbox, reviews) : []), [inbox, reviews]);
  const shown = filterRows(rows, filters);
  const options = inbox ? filterOptions(rows, inbox.me, filters.bots) : { authors: [], repos: [], bots: 0 };
  const needsYou = rows.filter((row) => row.needsYou).length;
  // Inside attraverso's viewer the host says where its plan is (`api/host`); served on its own, there is none.
  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    fetch("api/host")
      .then((response): Promise<{ plan?: unknown }> | { plan?: unknown } => (response.ok ? response.json() : {}))
      .then(
        (host) => setPlan(typeof host.plan === "string" ? (cameFrom() ?? host.plan) : null),
        () => setPlan(null),
      );
  }, []);

  return (
    <main className="home">
      <header className="home-head">
        {plan !== null && (
          <a className="back" href={plan}>
            ← Plan
          </a>
        )}
        <h1>Pull requests</h1>
        {inbox && <span className="home-count">{needsYou > 0 ? `${needsYou} need you` : "nothing needs you"}</span>}
        <button
          className="refresh"
          onClick={() => {
            setFailure(null);
            setLoads((count) => count + 1);
          }}
        >
          Refresh
        </button>
      </header>
      {failure && (
        <p className="home-failure">
          Couldn't ask GitHub: {failure}.{" "}
          {/(auth|log ?in|401|ENOENT|not found: gh)/i.test(failure) ? (
            <>
              Is <code>gh</code> installed and signed in?
            </>
          ) : (
            "Refresh to try again."
          )}
        </p>
      )}
      {!inbox && !failure && <p className="home-loading">Asking GitHub…</p>}
      {inbox && (
        <>
          <div className="filters">
            <FilterChips
              label="Author"
              values={options.authors}
              chosen={filters.author}
              name={(author) => (author === inbox.me ? "me" : author)}
              onChoose={(author) => setFilters({ ...filters, author })}
            />
            {options.repos.length > 1 && (
              <FilterChips
                label="Repo"
                values={options.repos}
                chosen={filters.repo}
                name={(repo) => repo.split("/")[1] ?? repo}
                onChoose={(repo) => setFilters({ ...filters, repo })}
              />
            )}
            {options.bots > 0 && filters.author === null && (
              <div className="chips">
                <span className="chips-label">Bots</span>
                <button aria-pressed={filters.bots} onClick={() => setFilters({ ...filters, bots: !filters.bots })}>
                  {filters.bots ? `Showing ${options.bots} from bots` : `${options.bots} from bots hidden`}
                </button>
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="home-empty">{emptyNotice(rows.length, options.bots, filters)}</p>
          ) : (
            <ul className="pr-list">
              {shown.map((row) => (
                <PrRow key={`${row.pr.repo}#${row.pr.number}`} row={row} me={inbox.me} here={inbox.here} />
              ))}
            </ul>
          )}
          {inbox.more > 0 && (
            <p className="home-note">
              {inbox.more} older open {inbox.more === 1 ? "PR isn't" : "PRs aren't"} listed: GitHub's search returns the
              newest 100.
            </p>
          )}
          <p className="home-note">
            Review and Review again copy the command that starts the pipeline, until the app can start a Claude session
            itself.
          </p>
          <PastReviews inbox={inbox} reviews={reviews} />
        </>
      )}
      <OtherReviews names={inbox ? otherReviews(names, rows, pastReviews(inbox, reviews)) : names} all={!inbox} />
    </main>
  );
}
