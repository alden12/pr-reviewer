/**
 * install-skill's write-or-refuse decision, kept out of run.ts so a test can reach it: run.ts ends with `await main()`,
 * so importing it would run the CLI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `skill` to `path` unless a file differing from it is already there and `force` is off, and says which it did.
 * Never a silent overwrite: one that differs may be a repo's own (this monorepo keeps its own, differently worded) or
 * the user's edits. An older install's differs too, if only in its command's version; telling it apart from those
 * would be a guess, so it takes `force` as well, which the caller's refusal names. An identical file is rewritten,
 * which changes nothing.
 */
export function installSkill(path: string, skill: string, force: boolean): "written" | "refused" {
  if (existsSync(path) && readFileSync(path, "utf8") !== skill && !force) return "refused";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, skill);
  return "written";
}
