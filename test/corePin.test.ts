/**
 * The reviewer's dependency on core must take core's own version, or Yarn installs the published attraverso instead of
 * linking the workspace (cloud's `corePin.test.ts` has the story). Cloud pins it exactly; the reviewer is published,
 * so it takes a range: everything it uses is in the library since 0.9.0, and an exact pin would make every reviewer
 * release depend on whatever core happens to be, a prerelease included. The range names core's prerelease too, since
 * ranges skip prereleases they don't name; once that minor is released it can shrink to its lower bound.
 *
 * Only in the monorepo: the public mirror (DIST-1) has no `../core`, so there is no workspace to pin to. The manifests
 * are read inside the test, since vitest still runs a skipped suite's body to collect it.
 */
import { existsSync, readFileSync } from "node:fs";
import semver from "semver";
import { describe, expect, it } from "vitest";

const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const inMonorepo = existsSync(new URL("../../core/package.json", import.meta.url));

describe.skipIf(!inMonorepo)("the reviewer's pin on core", () => {
  it("takes core's version, so Yarn links the workspace rather than fetching the published package", () => {
    const core = manifest("../../core/package.json") as { version: string };
    const reviewer = manifest("../package.json") as { dependencies: Record<string, string> };
    expect(semver.satisfies(core.version, reviewer.dependencies.attraverso!)).toBe(true);
  });

  it("takes the last release too, so a reviewer release installs beside attraverso@latest", () => {
    const reviewer = manifest("../package.json") as { dependencies: Record<string, string> };
    expect(semver.satisfies("0.9.0", reviewer.dependencies.attraverso!)).toBe(true);
  });
});
