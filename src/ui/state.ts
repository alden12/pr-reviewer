import { segmentHunk } from "../review/comments";
import type { ReadingEvent } from "../review/reading";
export type { ReadingEvent } from "../review/reading";
import { foldedRuns, foldReason, type Review } from "../review/model";

/** Ids shared by the rows the reducer scrolls to and the components that render them. */
export const lineId = (path: string, hunkIndex: number, lineIndex: number) =>
  `L-${path.replace(/[^a-z0-9]/gi, "_")}-${hunkIndex}-${lineIndex}`;
export const fileId = (path: string) => `F-${path.replace(/[^a-z0-9]/gi, "_")}`;
export const commentId = (id: string) => `C-${id}`;
export const blockKey = (path: string, hunkIndex: number) => `${path}#${hunkIndex}`;

/** The sets the view keeps, each of keys (a path, a block key, a finding id or a group name). */
type SetName = "unfolded" | "viewed" | "collapsed" | "openGroups" | "previews" | "applied";
type Flag = "showAll" | "showWhy" | "translate" | "showComments";

export interface ViewState extends Record<SetName, ReadonlySet<string>>, Record<Flag, boolean> {
  popover: { name: string; left: number; top: number } | null;
  /** An element to bring into view after the next render, and whether to centre it. */
  scrollTo: { id: string; centre: boolean } | null;
}

export type Action =
  | { type: "toggle"; set: SetName; key: string }
  | { type: "add"; set: SetName; key: string }
  | { type: "remove"; set: SetName; key: string }
  | { type: "flip"; flag: Flag }
  | { type: "setViewed"; path: string; viewed: boolean }
  | { type: "openPopover"; name: string; left: number; top: number }
  | { type: "closePopover" }
  /** Open whatever hides `path` (its file, the tests group, its block's fold) and scroll to `target`. */
  | { type: "reveal"; path: string; hunkIndex: number | null; target: string; centre: boolean };

export const initialState: ViewState = {
  unfolded: new Set(),
  viewed: new Set(),
  collapsed: new Set(),
  openGroups: new Set(),
  previews: new Set(),
  applied: new Set(),
  showAll: false,
  showWhy: true,
  translate: true,
  showComments: false,
  popover: null,
  scrollTo: null,
};

const withKey = (set: ReadonlySet<string>, key: string) => new Set([...set, key]);
const withoutKey = (set: ReadonlySet<string>, key: string) => new Set([...set].filter((each) => each !== key));

type Handlers = { [Type in Action["type"]]: (state: ViewState, action: Extract<Action, { type: Type }>) => ViewState };

export const makeReducer = (review: Review) => {
  const handlers: Handlers = {
    toggle: (state, { set, key }) => ({
      ...state,
      [set]: state[set].has(key) ? withoutKey(state[set], key) : withKey(state[set], key),
    }),
    add: (state, { set, key }) => ({ ...state, [set]: withKey(state[set], key) }),
    remove: (state, { set, key }) => ({ ...state, [set]: withoutKey(state[set], key) }),
    flip: (state, { flag }) => ({ ...state, [flag]: !state[flag] }),
    // Marking a file viewed folds it away, as on GitHub; unmarking opens it again.
    setViewed: (state, { path, viewed }) => ({
      ...state,
      viewed: viewed ? withKey(state.viewed, path) : withoutKey(state.viewed, path),
      collapsed: viewed ? withKey(state.collapsed, path) : withoutKey(state.collapsed, path),
    }),
    openPopover: (state, { name, left, top }) => ({ ...state, popover: { name, left, top } }),
    closePopover: (state) => (state.popover ? { ...state, popover: null } : state),
    reveal: (state, { path, hunkIndex, target, centre }) => {
      const folded = hunkIndex !== null && foldReason(review, path, hunkIndex) !== null;
      const inTests = review.annotations.tests.files.includes(path);
      return {
        ...state,
        popover: null,
        collapsed: withoutKey(state.collapsed, path),
        openGroups: inTests ? withKey(state.openGroups, "tests") : state.openGroups,
        unfolded: folded ? withKey(state.unfolded, blockKey(path, hunkIndex)) : state.unfolded,
        scrollTo: { id: target, centre },
      };
    },
  };
  return (state: ViewState, action: Action): ViewState =>
    (handlers[action.type] as (state: ViewState, action: Action) => ViewState)(state, action);
};

export const isFolded = (review: Review, state: ViewState, path: string, hunkIndex: number) =>
  foldReason(review, path, hunkIndex) !== null && !state.showAll && !state.unfolded.has(blockKey(path, hunkIndex));

/**
 * How many added and removed lines are on screen now, against the PR's totals (+435 of 9356): what the folds spared
 * the reader, and how much is left once they open some. A line counts unless something hides it: its file is
 * collapsed, not for review, or in the tests group while that is shut; its block is folded; it is in a folded run; or
 * it is a code comment while comments are hidden.
 */
export function shownCounts(review: Review, state: ViewState): { added: number; removed: number } {
  const { steps, tests } = review.annotations;
  const testsOpen = state.openGroups.has("tests");
  const visible = [...steps.flatMap((step) => step.files), ...(testsOpen ? tests.files : [])].filter(
    (path) => !state.collapsed.has(path),
  );
  const lines = visible.flatMap((path) =>
    (review.files[path]?.hunks ?? []).flatMap((hunk, hunkIndex) => {
      if (isFolded(review, state, path, hunkIndex)) return [];
      const key = blockKey(path, hunkIndex);
      const runs = state.showAll
        ? []
        : foldedRuns(review, path, hunkIndex).filter((run) => !state.unfolded.has(`${key}:${run.from}`));
      const comments = state.showComments
        ? []
        : segmentHunk(hunk, path).flatMap((segment) => (segment.kind === "note" ? segment.lineIndices : []));
      return hunk.lines.filter(
        (_, lineIndex) =>
          !comments.includes(lineIndex) && !runs.some((run) => lineIndex >= run.from && lineIndex < run.to),
      );
    }),
  );
  return {
    added: lines.filter(([sign]) => sign === "+").length,
    removed: lines.filter(([sign]) => sign === "-").length,
  };
}

/**
 * The reading event an action is, or null when it isn't one. Only opening or folding back by hand counts: a reveal
 * (following a link to a finding) opens folds too, but says nothing about what the reader wanted to see.
 */
export function readingEvent(review: Review, action: Action): ReadingEvent | null {
  if ((action.type !== "add" && action.type !== "remove") || action.set !== "unfolded") return null;
  const match = /^(.*)#(\d+)(?::(\d+))?$/.exec(action.key);
  if (match === null) return null;
  const [, path = "", hunk = "0", from] = match;
  const hunkIndex = Number(hunk);
  const run =
    from === undefined ? undefined : foldedRuns(review, path, hunkIndex).find((each) => each.from === Number(from));
  const kind = run?.kind ?? foldReason(review, path, hunkIndex);
  if (kind === null || kind === undefined) return null;
  return {
    at: new Date().toISOString(),
    action: action.type === "add" ? "open" : "fold",
    path,
    hunkIndex,
    kind,
    ...(run ? { summary: run.summary } : {}),
  };
}
