/**
 * install-skill's guard (DIST-3): a SKILL.md that differs is a repo's own or someone's edits, so it is replaced only
 * with --force, and the refusal leaves it as it was.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill } from "../pipeline/skill.ts";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A SKILL.md path in a fresh folder, with `existing` written there first when given. */
function skillPath(existing?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-skill-"));
  folders.push(dir);
  const path = join(dir, ".claude", "skills", "review-pr", "SKILL.md");
  if (existing !== undefined) {
    installSkill(path, existing, true);
  }
  return path;
}

describe("installSkill", () => {
  it("writes where there is no file, making its folders", () => {
    const path = skillPath();
    expect(existsSync(path)).toBe(false);
    expect(installSkill(path, "new", false)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("writes over an identical file, which changes nothing", () => {
    const path = skillPath("same");
    expect(installSkill(path, "same", false)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe("same");
  });

  it("refuses a file that differs and leaves it as it was", () => {
    const path = skillPath("the repo's own");
    expect(installSkill(path, "the package's", false)).toBe("refused");
    expect(readFileSync(path, "utf8")).toBe("the repo's own");
  });

  it("replaces a file that differs with force", () => {
    const path = skillPath("the repo's own");
    expect(installSkill(path, "the package's", true)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe("the package's");
  });

  it("refuses an empty file that differs, so existence is what is checked, not content", () => {
    const path = skillPath("");
    expect(installSkill(path, "new", false)).toBe("refused");
    expect(readFileSync(path, "utf8")).toBe("");
  });
});
