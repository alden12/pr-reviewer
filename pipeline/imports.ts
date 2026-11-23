/**
 * Which lines are imports (FLOW-4), guessed by pattern where the parser can't be used: TypeScript `import` and `export ... from`, and Rust `use`,
 * including the lines of a multi-line one and blank lines between them. Imports rarely need a reviewer, so a run of
 * them folds to one line; the rest of a block stays as it is.
 */
// `import.meta` and `import()` are expressions, not imports. This is the fallback for a file the parser can't read;
// `spans.ts` asks the parser where it can.
const TS_START = /^\s*(import\b(?![.(])|export\s+(type\s+)?(\*|\{)[^;]*\bfrom\b|export\s+\{\s*$)/;
const TS_END = /(\bfrom\s+["'][^"']+["'];?\s*$|^\s*import\s+["'][^"']+["'];?\s*$)/;
const RUST_START = /^\s*(pub(\([a-z]+\))?\s+)?use\b/;

export function importLines(path: string, texts: string[]): boolean[] {
  const rust = path.endsWith(".rs");
  const typescript = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);
  if (!rust && !typescript) return texts.map(() => false);
  const marked = texts.reduce<{ marks: boolean[]; open: boolean }>(
    ({ marks, open }, text) => {
      if (open) {
        const closes = rust ? /;\s*$/.test(text) : TS_END.test(text) || /^\s*\}\s*from\b/.test(text);
        return { marks: [...marks, true], open: !closes };
      }
      const starts = rust ? RUST_START.test(text) : TS_START.test(text);
      if (!starts) return { marks: [...marks, false], open: false };
      const closes = rust ? /;\s*$/.test(text) : TS_END.test(text);
      return { marks: [...marks, true], open: !closes };
    },
    { marks: [], open: false },
  ).marks;
  // A blank line between two imports belongs to the run.
  return marked.map((isImport, index) => {
    if (isImport || texts[index]!.trim() !== "") return isImport;
    const before = marked.slice(0, index).lastIndexOf(true);
    const nextImport = marked.findIndex((mark, at) => at > index && mark);
    const between = texts
      .slice(index + 1, nextImport === -1 ? index + 1 : nextImport)
      .every((text) => text.trim() === "");
    return (
      before !== -1 &&
      nextImport !== -1 &&
      between &&
      marked.slice(before + 1, index).every((_, at) => texts[before + 1 + at]!.trim() === "")
    );
  });
}
