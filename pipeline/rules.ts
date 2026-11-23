/**
 * Which files are what, and which fold (KNOW-2): the facts step 4 of the pipeline starts from. **Repo knowledge lives
 * in the reviewed repo's own attraverso plan**, in a context section named `Review rules` (see `plan.ts`); this file
 * holds only the defaults any repo gets underneath, so nothing here names one repo's files.
 *
 * A rule is a glob and a class, optionally with its own fold. The first rule to match a path wins, the repo's before
 * the defaults, so a repo can reclassify anything the defaults get wrong for it.
 */
import { z } from "zod";

/** What a file is, which is what decides how it is read. */
export const fileClassSchema = z.enum(["generated", "data", "docs", "config", "test", "code"]);
export type FileClass = z.infer<typeof fileClassSchema>;

export const fileRuleSchema = z.strictObject({
  /** A glob over repo-relative paths: `*` within a folder, `**` across folders, `?` one character. */
  match: z.string().min(1),
  class: fileClassSchema,
  /** Overrides the class's own policy: always fold, never fold. */
  fold: z.enum(["always", "never"]).optional(),
  /** Why, shown as the fold's reason and read by the reviewing agent. */
  why: z.string().optional(),
});
export type FileRule = z.infer<typeof fileRuleSchema>;

/** The `rules:` list a repo's `Review rules` section carries in a fenced yaml block. */
export const repoRulesSchema = z.strictObject({ rules: z.array(fileRuleSchema) });

/** For a repo that has no rules yet: lockfiles, snapshots and build output are read through something else. */
export const DEFAULT_RULES: FileRule[] = [
  ...["**/yarn.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/Cargo.lock", "**/*.snap", "**/dist/**"].map(
    (match): FileRule => ({ match, class: "generated" }),
  ),
  ...["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/e2e/**"].map((match): FileRule => ({
    match,
    class: "test",
  })),
  ...["**/*.md", "**/docs/**"].map((match): FileRule => ({ match, class: "docs" })),
  ...["**/*.json", "**/*.yaml", "**/*.yml", "**/*.csv", "**/*.tsv"].map((match): FileRule => ({
    match,
    class: "data",
  })),
];

/** A glob as an anchored regex. `**\/` may match no folders at all, so `**\/yarn.lock` matches a root `yarn.lock`. */
export function globToRegExp(glob: string): RegExp {
  const pattern = [...glob.matchAll(/\*\*\/|\*\*|\*|\?|[^*?]+/g)]
    .map(([token]) => {
      const tokens: Record<string, string> = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };
      return tokens[token] ?? token.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${pattern}$`);
}

export interface Classified {
  class: FileClass;
  /** The rule that decided it, or null when no rule matched and the path's own extension did. */
  rule: FileRule | null;
}

/**
 * Files that are code in any repo, so show by default. Its own list rather than the app's `commentsAreProse`, which is
 * about whose comment syntax it can read, not what is code; styles and markup count, being read like code.
 */
export const CODE =
  /\.(ts|mts|cts|tsx|js|jsx|mjs|cjs|rs|py|pyi|go|rb|java|kt|kts|swift|scala|sc|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|sql|css|scss|less|html|vue|svelte)$/;

/** A path's class: the first matching rule's, else code for a code file and config for anything else. */
export function classify(path: string, rules: FileRule[]): Classified {
  const rule = rules.find((candidate) => globToRegExp(candidate.match).test(path));
  if (rule !== undefined) return { class: rule.class, rule };
  return { class: CODE.test(path) ? "code" : "config", rule: null };
}
