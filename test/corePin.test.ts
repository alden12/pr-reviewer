/**
 * The reviewer's dependency on core must name core's own version exactly, as cloud's must (its `corePin.test.ts` has
 * the story): when a bump leaves the pin behind, Yarn installs the published attraverso, which has no `src/`, and
 * `pipeline/plan.ts`'s import of core's library stops loading.
 *
 * Only in the monorepo: the public mirror (DIST-1) has no `../core`, so there is no workspace to pin to. The manifests
 * are read inside the test, since vitest still runs a skipped suite's body to collect it.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const inMonorepo = existsSync(new URL("../../core/package.json", import.meta.url));

describe.skipIf(!inMonorepo)("the reviewer's pin on core", () => {
  it("names core's version, so Yarn links the workspace rather than fetching the published package", () => {
    const core = manifest("../../core/package.json") as { version: string };
    const reviewer = manifest("../package.json") as { dependencies: Record<string, string> };
    expect(reviewer.dependencies.attraverso).toBe(core.version);
  });
});
