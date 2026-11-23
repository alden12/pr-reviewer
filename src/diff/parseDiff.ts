import { z } from "zod";

/**
 * A PR's diff as data: each file's hunks, each hunk's lines with their old and new line numbers.
 * Parsed from `git diff` output (the pipeline's fetch step) and validated again when a review loads, since
 * the JSON on disk is outside the type checker's reach.
 */
export const diffLineSchema = z.tuple([
  z.enum(["+", "-", " "]),
  z.number().int().nullable(), // old line number, null for an added line
  z.number().int().nullable(), // new line number, null for a removed line
  z.string(),
]);
export const hunkSchema = z.strictObject({
  /** The function or type git found the hunk inside, from its `@@` header. */
  context: z.string(),
  lines: z.array(diffLineSchema),
  /**
   * Which lines (by index into `lines`) hold only a comment, as a parser read the whole file on each side (ARCH-9).
   * Present only where the pipeline had a grammar for the file; otherwise the app guesses by each line's prefix.
   */
  comments: z.array(z.number().int().min(0)).optional(),
});
export const diffFileSchema = z.strictObject({
  path: z.string().min(1),
  /** Where the file was at the base, for a rename only: the old side's lines are numbered in that file. */
  oldPath: z.string().min(1).optional(),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  hunks: z.array(hunkSchema),
});
export const diffSchema = z.array(diffFileSchema);

export type DiffLine = z.infer<typeof diffLineSchema>;
export type Hunk = z.infer<typeof hunkSchema>;
export type DiffFile = z.infer<typeof diffFileSchema>;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;
const SIGNS = new Set(["+", "-", " "]);

interface ParseState {
  files: DiffFile[];
  oldNumber: number;
  newNumber: number;
}

/**
 * The path on a `diff --git a/<path> b/<path>` line. When both sides are the same path (anything but a rename), the
 * line is that path twice, so its length settles where the split is even if the path holds " b/"; otherwise the last
 * " b/". A binary file has no `+++` line, so this is all it gets.
 */
function gitLinePath(line: string): string {
  const rest = line.slice("diff --git ".length);
  const half = (rest.length - 5) / 2;
  const same = Number.isInteger(half) && rest.slice(2, 2 + half) === rest.slice(5 + half);
  return same ? rest.slice(5 + half) : rest.slice(rest.lastIndexOf(" b/") + 3);
}

/** One line of `git diff` output, folded into the files parsed so far. */
const parseLine = (state: ParseState, line: string, stripPrefix: string): ParseState => {
  const file = state.files.at(-1);
  const strip = (path: string) => (path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path);
  if (line.startsWith("diff --git ")) {
    return { ...state, files: [...state.files, { path: strip(gitLinePath(line)), added: 0, removed: 0, hunks: [] }] };
  }
  // The old path, kept only when it differs (a rename): `diff --git` names the new one, so equal means not renamed. A
  // new file has `/dev/null` here, which this doesn't match.
  if (line.startsWith("--- a/") && file && file.hunks.length === 0) {
    const oldPath = strip(line.slice("--- a/".length).replace(/\t$/, ""));
    if (oldPath !== file.path) file.oldPath = oldPath;
    return state;
  }
  // The new path, unambiguously, before the first hunk: this one can't be split in the wrong place by a " b/" in
  // the path. A deleted file has `/dev/null` here and keeps the path from the `diff --git` line.
  if (line.startsWith("+++ b/") && file && file.hunks.length === 0) {
    // git ends the path with a tab when it holds a space.
    file.path = strip(line.slice("+++ b/".length).replace(/\t$/, ""));
    return state;
  }
  const header = HUNK_HEADER.exec(line);
  if (header && file) {
    file.hunks.push({ context: header[3] ?? "", lines: [] });
    return { ...state, oldNumber: Number(header[1]), newNumber: Number(header[2]) };
  }
  const hunk = file?.hunks.at(-1);
  const sign = line[0];
  if (!file || !hunk || sign === undefined || !SIGNS.has(sign)) return state;
  const text = line.slice(1);
  if (sign === "+") {
    hunk.lines.push(["+", null, state.newNumber, text]);
    file.added += 1;
    return { ...state, newNumber: state.newNumber + 1 };
  }
  if (sign === "-") {
    hunk.lines.push(["-", state.oldNumber, null, text]);
    file.removed += 1;
    return { ...state, oldNumber: state.oldNumber + 1 };
  }
  hunk.lines.push([" ", state.oldNumber, state.newNumber, text]);
  return { ...state, oldNumber: state.oldNumber + 1, newNumber: state.newNumber + 1 };
};

/**
 * What makes a hunk the same hunk across runs: each line's sign and text, not its line numbers, so one that only moved
 * (a line added above it, a rebase) is still the same. The fold step keys its decisions on it and the app its viewed
 * ticks, so they agree on what "unchanged" means.
 */
export const hunkIdentity = (hunk: Hunk): string => JSON.stringify(hunk.lines.map(([sign, , , text]) => [sign, text]));

/**
 * Parse unified diff text. `stripPrefix` drops a leading folder from every path (a monorepo package's,
 * say). Binary files appear with no hunks; the `---`/`+++` and `index` header lines are skipped because
 * no hunk is open yet when they arrive.
 */
export function parseDiff(text: string, stripPrefix = ""): DiffFile[] {
  const lines = text.split("\n").filter((line) => !line.startsWith("\\ No newline"));
  return lines.reduce((state, line) => parseLine(state, line, stripPrefix), {
    files: [],
    oldNumber: 0,
    newNumber: 0,
  } as ParseState).files;
}
