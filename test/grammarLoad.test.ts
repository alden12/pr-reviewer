/**
 * Every grammar loads and parses in a process that keeps running (ARCH-9). A third-party Swift build crashed Node 24 a
 * moment after loading (V8 out of memory compiling it in the background), which a test worker can exit before seeing,
 * so this runs a child that loads them all, parses one file per language and waits.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SYNTAX = fileURLToPath(new URL("../pipeline/syntax.ts", import.meta.url));
/**
 * vite-node's command, found by Node's own resolution rather than a path into `node_modules`: hoisted to the monorepo's
 * root here, it sits in this package's own folder in the public mirror, where this package is the repo.
 */
const VITE_NODE = (() => {
  const manifest = createRequire(import.meta.url).resolve("vite-node/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: Record<string, string> };
  return join(dirname(manifest), bin["vite-node"]!);
})();

it("loads every grammar, parses each language and is still running five seconds later", () => {
  const dir = mkdtempSync(join(tmpdir(), "grammar-load-"));
  try {
    const script = join(dir, "load.ts");
    writeFileSync(
      script,
      `import { loadSyntax } from ${JSON.stringify(SYNTAX)};
import { GRAMMARS } from ${JSON.stringify(SYNTAX.replace(/syntax\.ts$/, "grammars.ts"))};
const syntax = await loadSyntax();
const parsed = GRAMMARS.map((grammar) => syntax.parse("a." + grammar.extensions[0], "// a\\nstruct Clip { let start: Int }\\n") !== null);
await new Promise((resolve) => setTimeout(resolve, 5000));
console.log(JSON.stringify(parsed));
`,
    );
    const run = spawnSync(process.execPath, [VITE_NODE, script], { encoding: "utf8", timeout: 20_000 });
    expect(run.status, run.stderr.slice(0, 500)).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual(Array(10).fill(true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
