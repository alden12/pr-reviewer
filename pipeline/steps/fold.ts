/**
 * Step 4's first half: what folds, by rule (KNOW-2). Each hunk gets a fold and where it came from; `judge` then
 * checks the result both ways and revises it. Presentation only: every file was reviewed whatever happens here.
 *
 * The policy by class: generated files fold at any size (read through something else); a change to data folds past a
 * screenful (a small one, a script or a setting, is often the point); a new doc or config folds past a few lines,
 * where its title and why say more than all-green lines do; code and tests always show, being what a review is for.
 * A rule's own `fold` overrides its class.
 */
import { hunkIdentity, type DiffFile } from "../../src/diff/parseDiff.ts";
import { hashOf, type Artefact } from "../artefacts.ts";
import { classify, type FileClass, type FileRule } from "../rules.ts";
import { DEFAULT_SPAN_PREFERENCES, findSpans, type SpanPreferences } from "../spans.ts";
import type { Syntax } from "../syntax.ts";

/** How long a change to a data file can be and still be shown. */
export const DATA_LINES = 40;
/** How long a new doc or config can be and still be shown whole. */
export const NEW_FILE_LINES = 12;

type Hunk = DiffFile["hunks"][number];
const POLICY: Record<FileClass, (hunk: Hunk, isNew: boolean) => string | null> = {
  generated: () => "generated",
  data: (hunk) => (hunk.lines.length > DATA_LINES ? "data" : null),
  docs: (hunk, isNew) => (isNew && hunk.lines.length > NEW_FILE_LINES ? "new file" : null),
  config: (hunk, isNew) => (isNew && hunk.lines.length > NEW_FILE_LINES ? "new file" : null),
  test: () => null,
  code: () => null,
};

/**
 * Each file's folds, hunk by hunk, from the repo's rules then the defaults, and inside each code hunk the spans code
 * can find (imports, types, long objects), as long as the reader's preferences say.
 */
export function foldByRules(
  files: DiffFile[],
  rules: FileRule[],
  preferences: SpanPreferences = DEFAULT_SPAN_PREFERENCES,
  /** A file's text at the PR's head, so spans are found in the whole file, not the hunk alone. */
  sourceOf: (path: string) => string | undefined = () => undefined,
  /** Tree-sitter's parsers (`loadSyntax`); without them, imports are found by the regex alone. */
  syntax?: Syntax,
): Artefact<"folds"> {
  return Object.fromEntries(
    files.map((file) => {
      const { class: fileClass, rule } = classify(file.path, rules);
      // Read once per file, and only for code.
      const text = fileClass === "code" ? sourceOf(file.path) : undefined;
      const source = rule === null ? `default (${fileClass})` : `rule ${rule.match}${rule.why ? `: ${rule.why}` : ""}`;
      return [
        file.path,
        file.hunks.map((hunk) => {
          const isNew = file.removed === 0 && hunk.lines.every(([sign]) => sign === "+");
          const byPolicy = POLICY[fileClass](hunk, isNew);
          const fold = { always: byPolicy ?? fileClass, never: null, none: byPolicy }[rule?.fold ?? "none"];
          const spans = fileClass === "code" ? findSpans(file.path, hunk, preferences, text, syntax) : [];
          const at = hunk.lines.find(([, , newNumber]) => newNumber !== null)?.[2] ?? 0;
          return { fold, source, class: fileClass, hunk: hunkHash(hunk), at, ...(spans.length > 0 ? { spans } : {}) };
        }),
      ];
    }),
  );
}

/** A hunk's identity across runs, hashed (`hunkIdentity`). */
const hunkHash = (hunk: Hunk) => hashOf(hunkIdentity(hunk));

/**
 * Fresh folds with the judge's earlier calls kept wherever their hunk is unchanged (ARCH-5): going back through this
 * step after new commits must not undo a decision about code those commits didn't touch.
 */
export function keepJudged(fresh: Artefact<"folds">, earlier: Artefact<"folds">): Artefact<"folds"> {
  return Object.fromEntries(
    Object.entries(fresh).map(([path, entries]) => [
      path,
      entries.map((entry) => {
        const judged = earlier[path]?.find(
          (old) => old.source.startsWith("judge") && old.hunk !== undefined && old.hunk === entry.hunk,
        );
        if (judged === undefined) return entry;
        // A call from before hunks carried their position has nothing to move its spans by: start again from the rules.
        if (judged.spans?.length && (judged.at === undefined || entry.at === undefined)) return entry;
        // The same hunk, perhaps moved: its spans move with it.
        const shift = (entry.at ?? 0) - (judged.at ?? entry.at ?? 0);
        const spans = judged.spans?.map((span) => ({ ...span, from: span.from + shift, to: span.to + shift }));
        return { ...judged, at: entry.at, class: entry.class, ...(spans ? { spans } : {}) };
      }),
    ]),
  );
}
