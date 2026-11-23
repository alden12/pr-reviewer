import { useCopy } from "./useCopy";
import type { DiffLine, Hunk } from "../diff/parseDiff";
import { changedRanges, noteParagraphs, segmentHunk, stripMarker, type Segment } from "../review/comments";
import { reReviewCommand, useReview } from "./context";
import { Decision } from "./Decision";
import { Finding } from "./Finding";
import { escapeHtml, highlightLine, languageOf } from "./highlight";
import { foldedRuns, foldReason, type FoldedRun } from "../review/model";
import type { Hint, Section } from "../review/schema";
import { blockKey, commentId, fileId, isFolded, lineId } from "./state";

const ROW_CLASS: Record<DiffLine[0], string> = { "+": "add", "-": "del", " ": "ctx" };

const LANGUAGE_BADGE: Record<string, string> = { TypeScript: "TS", JavaScript: "JS", Python: "PY" };
const badgeFor = (language: string) => LANGUAGE_BADGE[language] ?? language.slice(0, 2).toUpperCase();

/**
 * A line in the reader's own language (FLOW-8). The reader turned translation on, so this is the line
 * to read: full strength, a border and the language's badge, with the real line greyed above it.
 */
function TranslationRow({ text, into }: { text: string; into: string }) {
  return (
    <tr className="xlate">
      <td className="num" />
      <td className="num" />
      <td className="sign">
        <span className="lang-badge" title={`The line above, in ${into}`}>
          {badgeFor(into)}
        </span>
      </td>
      <td className="code" dangerouslySetInnerHTML={{ __html: highlightLine(text, "typescript") }} />
    </tr>
  );
}

/** Prose with `code` spans set as code. */
const proseHtml = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

const lineRange = (numbers: (number | null)[]) => {
  const present = numbers.filter((number): number is number => number !== null);
  if (present.length === 0) return "";
  const [first, last] = [present[0], present.at(-1)];
  return first === last ? String(first) : `${first}–${last}`;
};

/**
 * A run of code comments read as prose, still marked as a comment. One the review picked as explaining
 * the change is drawn out. A `TS:` translation comment steps aside (`superseded`) while the review's
 * own translation of the block is showing, since that does its job.
 */
function NoteRow({
  path,
  hunk,
  hunkIndex,
  segment,
  explains,
  superseded,
}: {
  path: string;
  hunk: Hunk;
  hunkIndex: number;
  segment: Extract<Segment, { kind: "note" }>;
  explains: boolean;
  superseded: boolean;
}) {
  const lines = segment.lineIndices.map((lineIndex) => hunk.lines[lineIndex]).filter((line) => line !== undefined);
  const texts = lines.map(([, , , text]) => text);
  const firstIndex = segment.lineIndices[0] ?? 0;
  const numbers = (
    <>
      <td className="num">{lineRange(lines.map(([, oldNumber]) => oldNumber))}</td>
      <td className="num">{lineRange(lines.map(([, , newNumber]) => newNumber))}</td>
      <td className="sign">{segment.sign}</td>
    </>
  );
  const rowClass = `note-row ${ROW_CLASS[segment.sign]}`;
  if (superseded) {
    return (
      <tr className={`${rowClass} superseded`} id={lineId(path, hunkIndex, firstIndex)}>
        {numbers}
        <td className="code">
          <span className="note-mark">//</span> TypeScript note from the code, shown as the translation below
        </td>
      </tr>
    );
  }
  const body = segment.translation ? (
    <pre className="note-code">{texts.map((text) => stripMarker(text)).join("\n")}</pre>
  ) : (
    noteParagraphs(texts).map((paragraph, index) => (
      <p key={index} dangerouslySetInnerHTML={{ __html: proseHtml(paragraph) }} />
    ))
  );
  return (
    <tr className={`${rowClass}${explains ? " explains" : ""}`} id={lineId(path, hunkIndex, firstIndex)}>
      {numbers}
      <td className="code">
        <div className="note">
          <span className="note-mark">{explains ? "// Explains" : "//"}</span>
          <div className="note-body">{body}</div>
        </div>
      </td>
    </tr>
  );
}

/** A line, highlighted, with the part that changed in place marked (`changedRanges`). */
function lineHtml(text: string, language: string | null, names: RegExp, range: [number, number] | undefined): string {
  if (range === undefined) return highlightLine(text, language, names);
  const [start, end] = range;
  const part = (from: number, to: number) => (to > from ? highlightLine(text.slice(from, to), language, names) : "");
  return `${part(0, start)}<mark class="chg">${part(start, end)}</mark>${part(end, text.length)}`;
}

/** A run of lines folded inside a block (a span, or what is far from a question): its summary, which opens it. */
function GapRow({ run, onOpen }: { run: FoldedRun; onOpen: () => void }) {
  return (
    <tr className="fold gap">
      <td colSpan={4}>
        <button onClick={onOpen}>
          <span className="kind">[…{run.kind}]</span>
          <span>{run.summary}</span>
          <span className="count">{run.to - run.from} lines</span>
        </button>
      </td>
    </tr>
  );
}

/** A storytelling heading inside a block, above the part it is about (FLOW-12). */
function SectionRow({ section }: { section: Section }) {
  const { state } = useReview();
  return (
    <tr className="section">
      <td colSpan={4}>
        <div className="section-title">{section.title}</div>
        {state.showWhy && section.why && <div className="section-why">{section.why}</div>}
      </td>
    </tr>
  );
}

/** A short hint above a line, at the code's indent, so it reads like a comment the review wrote. */
function HintRow({ hint, indent }: { hint: Hint; indent: string }) {
  return (
    <tr className="hint">
      <td className="num" />
      <td className="num" />
      <td className="sign" />
      <td className="code">
        {indent}
        <span className="hint-text">{hint.text}</span>
      </td>
    </tr>
  );
}

/**
 * Where the code comments a PR adds or removes are hidden: a faint count at their indent, which shows the comments when
 * clicked. Without it the line numbers jump for no visible reason, and nothing says the author wrote more. Unchanged
 * comments go without one: they are context, and marking each made a small review mostly markers.
 */
function HiddenCommentRow({ count, sign, indent }: { count: number; sign: "+" | "-"; indent: string }) {
  const { dispatch } = useReview();
  return (
    <tr className="hidden-comment">
      <td className="num" />
      <td className="num" />
      <td className="sign" />
      <td className="code">
        {indent}
        <button onClick={() => dispatch({ type: "flip", flag: "showComments" })} title="Show the code's comments">
          {`// ${sign === "+" ? "+" : "−"}${count} comment line${count === 1 ? "" : "s"}`}
        </button>
      </td>
    </tr>
  );
}

function Lines({ path, hunk, hunkIndex }: { path: string; hunk: Hunk; hunkIndex: number }) {
  const { review, state, dispatch, names } = useReview();
  const language = languageOf(path);
  const translation = review.annotations.translation;
  const translations = state.translate ? translation?.lines[path] : undefined;
  const explains = review.annotations.blocks[path]?.[hunkIndex]?.explains ?? [];
  const changed = changedRanges(hunk);
  const hints = new Map(
    (review.annotations.blocks[path]?.[hunkIndex]?.hints ?? []).map((hint) => [hint.line, hint] as const),
  );
  const blockTranslated = hunk.lines.some(([sign, , newNumber]) => sign !== "-" && translations?.[String(newNumber)]);
  const commentsAfter = (lineIndices: number[]) =>
    review.annotations.comments.filter((comment) => {
      const anchor = review.commentAnchors[comment.id];
      return anchor?.path === path && anchor.hunkIndex === hunkIndex && lineIndices.includes(anchor.lineIndex);
    });
  const decisionsAfter = (lineIndices: number[]) =>
    review.annotations.decisions.filter((decision) => {
      const anchor = review.commentAnchors[decision.id];
      return anchor?.path === path && anchor.hunkIndex === hunkIndex && lineIndices.includes(anchor.lineIndex);
    });
  const decisionRows = (lineIndices: number[]) =>
    decisionsAfter(lineIndices).map((decision) => (
      <tr key={decision.id} className="comment-row" id={commentId(decision.id)}>
        <td colSpan={4}>
          <Decision decision={decision} />
        </td>
      </tr>
    ));
  const commentRows = (lineIndices: number[]) => [
    ...decisionRows(lineIndices),
    ...commentsAfter(lineIndices).map((comment) => (
      <tr key={comment.id} className="comment-row" id={commentId(comment.id)}>
        <td colSpan={4}>
          <Finding
            id={comment.id}
            kind={comment.kind}
            title={comment.title}
            recommendation={comment.recommendation}
            fix={comment.fix}
            item={comment.item}
          >
            <p>{comment.body}</p>
          </Finding>
        </td>
      </tr>
    )),
  ];
  const codeRows = (lineIndex: number) => {
    const line = hunk.lines[lineIndex];
    if (!line) return [];
    const [sign, oldNumber, newNumber, text] = line;
    const translated = sign !== "-" && newNumber !== null ? translations?.[String(newNumber)] : undefined;
    const hint = sign !== "-" && newNumber !== null ? hints.get(newNumber) : undefined;
    return [
      hint ? <HintRow key={`hint-${lineIndex}`} hint={hint} indent={/^\s*/.exec(text)?.[0] ?? ""} /> : null,
      <tr
        key={`line-${lineIndex}`}
        className={`${ROW_CLASS[sign]}${translated ? " translated" : ""}`}
        id={lineId(path, hunkIndex, lineIndex)}
      >
        <td className="num">{oldNumber ?? ""}</td>
        <td className="num">{newNumber ?? ""}</td>
        <td className="sign">{sign}</td>
        <td
          className="code"
          dangerouslySetInnerHTML={{ __html: lineHtml(text, language, names, changed.get(lineIndex)) }}
        />
      </tr>,
      translated && translation ? (
        <TranslationRow key={`xlate-${lineIndex}`} text={translated} into={translation.into} />
      ) : null,
      ...commentRows([lineIndex]),
    ];
  };
  const key = blockKey(path, hunkIndex);
  const runs = state.showAll
    ? []
    : foldedRuns(review, path, hunkIndex).filter((run) => !state.unfolded.has(`${key}:${run.from}`));
  const runAt = (lineIndex: number) => runs.find((run) => lineIndex >= run.from && lineIndex < run.to);
  // Each section is drawn once, above the first thing shown at or after its line: a line, a comment, or a fold.
  const sections = review.annotations.blocks[path]?.[hunkIndex]?.sections ?? [];
  const sectionIndex = new Map(
    sections.flatMap((section) => {
      const index = hunk.lines.findIndex(([sign, , newNumber]) => sign !== "-" && newNumber === section.line);
      return index === -1 ? [] : [[index, section] as const];
    }),
  );
  const drawnSections = new Set<number>();
  const sectionRows = (from: number, to: number) =>
    [...sectionIndex.entries()]
      .filter(([index]) => index >= from && index < to && !drawnSections.has(index))
      .map(([index, section]) => {
        drawnSections.add(index);
        return <SectionRow key={`section-${index}`} section={section} />;
      });
  // Each folded run is drawn once, as a row where its first hidden segment would have been.
  const drawn = new Set<number>();
  const gapFor = (run: FoldedRun) => {
    if (drawn.has(run.from)) return [];
    drawn.add(run.from);
    return [
      <GapRow
        key={`gap-${run.from}`}
        run={run}
        onOpen={() => dispatch({ type: "add", set: "unfolded", key: `${key}:${run.from}` })}
      />,
    ];
  };
  return segmentHunk(hunk, path).flatMap((segment) => {
    const first = segment.kind === "line" ? segment.lineIndex : (segment.lineIndices[0] ?? 0);
    const last = segment.kind === "line" ? segment.lineIndex : (segment.lineIndices.at(-1) ?? first);
    const run = runAt(first);
    if (run !== undefined) return [...sectionRows(run.from, run.to), ...gapFor(run)];
    // A comment introduces the code under it, so a section starting on the line after one is drawn above the comment.
    const headings = sectionRows(first, segment.kind === "note" ? last + 2 : last + 1);
    if (segment.kind === "line") return [...headings, ...codeRows(segment.lineIndex)];
    // Code comments are hidden unless asked for: the storytelling headings carry what is worth reading in them. A
    // finding anchored in one still shows.
    if (!state.showComments) {
      const indent = /^\s*/.exec(hunk.lines[first]?.[3] ?? "")?.[0] ?? "";
      const sign = segment.sign;
      const marker =
        sign === " "
          ? []
          : [
              <HiddenCommentRow
                key={`hidden-${first}`}
                count={segment.lineIndices.length}
                sign={sign}
                indent={indent}
              />,
            ];
      return [...headings, ...marker, ...commentRows(segment.lineIndices)];
    }
    return [
      ...headings,
      <NoteRow
        key={`note-${segment.lineIndices[0]}`}
        path={path}
        hunk={hunk}
        hunkIndex={hunkIndex}
        segment={segment}
        explains={segment.firstNumber !== null && explains.includes(segment.firstNumber)}
        superseded={segment.translation && blockTranslated}
      />,
      ...commentRows(segment.lineIndices),
    ];
  });
}

const countChanges = (hunk: Hunk) => {
  const added = hunk.lines.filter(([sign]) => sign === "+").length;
  const removed = hunk.lines.filter(([sign]) => sign === "-").length;
  return [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");
};

/**
 * One block (a git hunk) under its heading and why (INTENT-2). A low-value block folds to one greyed
 * line naming its kind, so the code is still visibly there (FLOW-4).
 */
function BlockRows({ path, hunk, hunkIndex }: { path: string; hunk: Hunk; hunkIndex: number }) {
  const { review, state, dispatch } = useReview();
  const block = review.annotations.blocks[path]?.[hunkIndex];
  const key = blockKey(path, hunkIndex);
  const reason = foldReason(review, path, hunkIndex);
  const folded = isFolded(review, state, path, hunkIndex);
  // The review's own fold hides the block to one line naming its kind, as before (FLOW-4).
  if (block?.fold && folded) {
    return (
      <tr className="fold">
        <td colSpan={4}>
          <button onClick={() => dispatch({ type: "add", set: "unfolded", key })}>
            <span className="kind">[…{block.fold}]</span>
            <span>{block.title}</span>
            <span className="count">{countChanges(hunk)}</span>
          </button>
        </td>
      </tr>
    );
  }
  const canRefold = reason !== null && !state.showAll && !folded;
  return (
    <>
      <tr className="block">
        <td colSpan={4}>
          <div className="block-title">
            <span>{block?.title ?? hunk.context}</span>
            {hunk.context && <span className="ctx">{hunk.context}</span>}
            {canRefold && (
              <button className="refold" onClick={() => dispatch({ type: "remove", set: "unfolded", key })}>
                fold
              </button>
            )}
          </div>
          {state.showWhy && block?.why && (
            <div className="block-why">
              <span className="why-label">Why?</span> {block.why}
            </div>
          )}
        </td>
      </tr>
      {folded ? (
        // A default fold (a long new file, a large data change) keeps its heading and why: they are what to read.
        <tr className="fold">
          <td colSpan={4}>
            <button onClick={() => dispatch({ type: "add", set: "unfolded", key })}>
              <span className="kind">[…{reason}]</span>
              <span>Show all {hunk.lines.length} lines</span>
            </button>
          </td>
        </tr>
      ) : (
        <Lines path={path} hunk={hunk} hunkIndex={hunkIndex} />
      )}
    </>
  );
}

function PathLabel({ path }: { path: string }) {
  const parts = path.split("/");
  const dir = parts.slice(0, -1).join("/");
  return (
    <span className="path">
      {dir !== "" && <span className="dir">{dir}/</span>}
      {parts.at(-1)}
    </span>
  );
}

/**
 * A file changed after the review by commits it didn't look at again (a nit's fix, a plan-only commit, one past the
 * round): said on the file itself, never shown as if an agent had read it. Clicking copies the command to review it.
 */
function ChangedSinceReview({ shas }: { shas: string[] }) {
  const [copied, copy] = useCopy();
  return (
    <button
      className="pill unreviewed"
      onClick={() => copy(reReviewCommand())}
      title={`Changed after the review by ${shas.join(", ")}, which wasn't reviewed again. Click to copy the command that reviews it.`}
    >
      {copied ? "command copied" : "changed after the review"}
    </button>
  );
}

export function FileCard({ path }: { path: string }) {
  const { review, state, dispatch } = useReview();
  const file = review.files[path];
  if (!file) return null;
  const collapsed = state.collapsed.has(path);
  return (
    <section className={`file${collapsed ? " collapsed" : ""}`} id={fileId(path)}>
      <div className="file-head">
        <button
          className="chev"
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          onClick={() => dispatch({ type: "toggle", set: "collapsed", key: path })}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <PathLabel path={path} />
        {review.annotations.pr.changedSinceReview?.[path] && (
          <ChangedSinceReview shas={review.annotations.pr.changedSinceReview[path]} />
        )}
        <span className="stat">
          <span className="a">+{file.added}</span> <span className="d">−{file.removed}</span>
        </span>
        <label>
          <input
            type="checkbox"
            checked={state.viewed.has(path)}
            onChange={(event) => dispatch({ type: "setViewed", path, viewed: event.target.checked })}
          />{" "}
          Viewed
        </label>
      </div>
      {!collapsed && (
        <div className="scroll">
          <table className="diff">
            <tbody>
              {file.hunks.map((hunk, hunkIndex) => (
                <BlockRows key={hunkIndex} path={path} hunk={hunk} hunkIndex={hunkIndex} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A file that needs no review: one greyed line saying what it is and why (FLOW-3). */
export function GhostFile({ path, why }: { path: string; why: string }) {
  return (
    <section className="file ghost collapsed">
      <div className="file-head">
        <span className="chev">·</span>
        <PathLabel path={path} />
        <span className="ghost-note">{why}</span>
      </div>
    </section>
  );
}
