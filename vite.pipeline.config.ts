/**
 * The pipeline's build for the package (DIST-1.2): `run.ts` and `serve.ts` bundled for plain Node into `dist/pipeline/`,
 * so an install runs them with no vite-node, and the tree-sitter runtime and every grammar the pipeline loads copied
 * into `dist/grammars/` with their licences (DIST-1.1), so an install needs none of the packages they come from.
 * Run after the app's build (`yarn build`), which empties `dist/`.
 *
 * Its dependencies stay imports, installed beside it: core's library, yaml and zod.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { GRAMMARS } from "./pipeline/grammars.ts";

const here = import.meta.dirname;
const out = join(here, "dist", "grammars");

/** Each grammar's licence, beside the package it came from (Swift's is beside its build here). */
const LICENCES: Record<string, string> = {
  "@vscode/tree-sitter-wasm": "LICENSE",
  "@tree-sitter-grammars/tree-sitter-kotlin": "LICENSE",
  "tree-sitter-scala": "LICENSE",
};

const grammars = (): Plugin => ({
  name: "copy-grammars",
  closeBundle() {
    const require = createRequire(join(here, "pipeline", "syntax.ts"));
    mkdirSync(out, { recursive: true });
    const runtime = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"));
    // As .cjs: it is a CommonJS bundle that finds tree-sitter.wasm beside itself through __filename, and this package
    // is a module, where a .js would load as ESM with no __filename.
    copyFileSync(join(runtime, "tree-sitter.js"), join(out, "tree-sitter.cjs"));
    copyFileSync(join(runtime, "tree-sitter.wasm"), join(out, "tree-sitter.wasm"));
    GRAMMARS.forEach((grammar) => copyFileSync(require.resolve(grammar.wasm), join(out, basename(grammar.wasm))));
    Object.entries(LICENCES).forEach(([name, file]) =>
      copyFileSync(
        join(dirname(require.resolve(`${name}/package.json`)), file),
        join(out, `${name.replace("/", "__")}.LICENSE`),
      ),
    );
    copyFileSync(
      join(here, "pipeline", "grammars", "tree-sitter-swift.LICENSE"),
      join(out, "tree-sitter-swift.LICENSE"),
    );
  },
});

export default defineConfig({
  plugins: [grammars()],
  build: {
    ssr: true,
    outDir: "dist/pipeline",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: {
      // Kept as imports even here, where core is a linked workspace the bundler would otherwise read from source.
      external: [/^attraverso(\/|$)/, "yaml", "zod", /^node:/],
      input: {
        run: join(here, "pipeline", "run.ts"),
        serve: join(here, "pipeline", "serve.ts"),
        // What attraverso's viewer host imports, as `@traverso/pr-reviewer/host` (DIST-2.2).
        host: join(here, "pipeline", "viewerExtension.ts"),
      },
      output: { format: "es", entryFileNames: "[name].js" },
    },
  },
});
