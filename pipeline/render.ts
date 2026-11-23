/**
 * The review as the reader first sees it, as text (`view.md`): what the app shows with nothing opened, comments hidden
 * and every fold shut. It is what the proofread step reads, so the review is judged by what it looks like rather than
 * by its JSON. Built from the app's own model functions (`foldReason`, `foldedRuns`, `segmentHunk`), so it shows what
 * the app shows, not a second idea of it.
 */
import { segmentHunk } from "../src/review/comments.ts";
import { foldedRuns, foldReason, type Review } from "../src/review/model.ts";

const SIGN: Record<string, string> = { "+": "+", "-": "-", " ": " " };

/** One file's blocks as the reader sees them. */
function renderFile(review: Review, path: string): string[] {
  const file = review.files[path];
  if (file === undefined) return [];
  const blocks = review.annotations.blocks[path] ?? [];
  const asks = (hunkIndex: number, lineIndex: number) =>
    [...review.annotations.comments, ...review.annotations.decisions].filter((item) => {
      const anchor = review.commentAnchors[item.id];
      return anchor?.path === path && anchor.hunkIndex === hunkIndex && anchor.lineIndex === lineIndex;
    });
  const changedSince = review.annotations.pr.changedSinceReview?.[path];
  return [
    `### ${path}${changedSince ? ` (changed after the review by ${changedSince.join(", ")}, not reviewed again)` : ""}`,
    ...file.hunks.flatMap((hunk, hunkIndex) => {
      const block = blocks[hunkIndex];
      const reason = foldReason(review, path, hunkIndex);
      const count = `+${hunk.lines.filter(([sign]) => sign === "+").length}`;
      if (reason !== null) {
        return [
          ``,
          `[…${reason}] ${block?.title ?? hunk.context} (${count}, folded)`,
          ...(block?.why ? [`  why: ${block.why}`] : []),
        ];
      }
      const runs = foldedRuns(review, path, hunkIndex);
      const sections = new Map((block?.sections ?? []).map((section) => [section.line, section]));
      const hints = new Map((block?.hints ?? []).map((hint) => [hint.line, hint.text]));
      const drawnRuns = new Set<number>();
      const body = segmentHunk(hunk, path).flatMap((segment) => {
        const indices = segment.kind === "line" ? [segment.lineIndex] : segment.lineIndices;
        // As the app does: a comment introduces the code under it, so the section on the line after one goes above it.
        const headingIndices = segment.kind === "note" ? [...indices, indices.at(-1)! + 1] : indices;
        const headings = headingIndices.flatMap((index) => {
          const number = hunk.lines[index]?.[2];
          const section = number === null || number === undefined ? undefined : sections.get(number);
          if (section === undefined) return [];
          sections.delete(number!);
          return [``, `  ## ${section.title}`, ...(section.why ? [`     ${section.why}`] : [])];
        });
        const run = runs.find((each) => indices[0]! >= each.from && indices[0]! < each.to);
        if (run !== undefined) {
          if (drawnRuns.has(run.from)) return headings;
          drawnRuns.add(run.from);
          return [...headings, `  […${run.kind}] ${run.summary} (${run.to - run.from} lines)`];
        }
        // Comments are hidden by default; one the PR adds or removes leaves a faint count, as in the app. A finding anchored
        // in one still shows.
        const lines =
          segment.kind === "note"
            ? segment.sign === " "
              ? []
              : [
                  `         ${/^\s*/.exec(hunk.lines[indices[0]!]?.[3] ?? "")?.[0] ?? ""}// ${segment.sign === "+" ? "+" : "−"}${indices.length} comment line${indices.length === 1 ? "" : "s"}`,
                ]
            : indices.flatMap((index) => {
                const [sign, , newNumber, text] = hunk.lines[index]!;
                const hint = sign !== "-" && newNumber !== null ? hints.get(newNumber) : undefined;
                return [
                  ...(hint === undefined ? [] : [`         ${/^\s*/.exec(text)?.[0] ?? ""}› ${hint}`]),
                  `  ${String(newNumber ?? "").padStart(4)} ${SIGN[sign]} ${text}`,
                ];
              });
        const findings = indices.flatMap((index) =>
          asks(hunkIndex, index).map((item) => `  >>> ${"kind" in item ? item.kind : "decision"}: ${item.title}`),
        );
        return [...headings, ...lines, ...findings];
      });
      return [``, `[block] ${block?.title ?? hunk.context}`, ...(block?.why ? [`  why: ${block.why}`] : []), ...body];
    }),
    ``,
  ];
}

/** "1 decision", "2 decisions". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function renderReview(review: Review): string {
  const { pr, verdict, steps, decisions, fixed, planned, comments, tests, notForReview } = review.annotations;
  const header = [
    `# ${pr.title} (#${pr.number})`,
    ``,
    pr.gist,
    ``,
    `verdict: ${verdict}; ${count(decisions.length, "decision")}, ${count(comments.length, "comment")}, ${fixed.length} fixed, ${planned.length} planned`,
    ...decisions.map((decision) => `- decision: ${decision.title}`),
    // Folded in the app, a click away, but listed here so the proofread can tell what was done.
    // By what was done, not the finding's title, which read as a live problem in a list of things already put right.
    ...fixed.map((item) => `- fixed: ${item.detail ?? item.title}`),
    ...planned.map((item) => `- planned: ${item.title} (${item.item})`),
    ...(pr.notReReviewed && pr.notReReviewed.length > 0 ? [`not reviewed again: ${pr.notReReviewed.join(", ")}`] : []),
    ``,
  ];
  const body = steps.flatMap((step) => [
    `## ${step.title}`,
    ``,
    ...step.files.flatMap((path) => renderFile(review, path)),
  ]);
  // Like the app, no tests heading when there is nothing under it.
  const testLines = [
    ...tests.tested.map((line) => `- tested: ${line}`),
    ...tests.gaps.map((gap) => `- gap: ${gap.title}`),
  ];
  const footer = [
    ...(tests.files.length + testLines.length > 0
      ? [`## Tests (folded): ${tests.files.length === 1 ? "1 file" : `${tests.files.length} files`}`, ...testLines]
      : []),
    ...(notForReview.length > 0
      ? [``, `## Not for review`, ...notForReview.map((entry) => `- ${entry.path}: ${entry.why}`)]
      : []),
  ];
  return [...header, ...body, ...footer].join("\n") + "\n";
}
