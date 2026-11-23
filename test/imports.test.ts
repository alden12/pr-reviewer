import { describe, expect, it } from "vitest";
import { importLines } from "../pipeline/imports.ts";

describe("importLines", () => {
  it("marks TypeScript imports, multi-line ones and the blank lines between them, and nothing after", () => {
    const lines = [
      'import { StrictMode } from "react";',
      "import {",
      "  loadReview,",
      "  type Review,",
      '} from "./review/model";',
      "",
      'import "./styles.css";',
      'export { thing } from "./thing";',
      "",
      "const files = 1;",
    ];
    expect(importLines("src/main.tsx", lines)).toEqual([true, true, true, true, true, true, true, true, false, false]);
  });

  it("doesn't take import.meta or a dynamic import() for an import", () => {
    expect(importLines("src/main.tsx", ["const dev = import.meta.env.DEV;", 'void import("./a");'])).toEqual([
      false,
      false,
    ]);
  });

  it("marks Rust use statements, multi-line ones included", () => {
    const lines = ["use std::fmt;", "use crate::{", "    a,", "    b,", "};", "fn main() {}"];
    expect(importLines("src/lib.rs", lines)).toEqual([true, true, true, true, true, false]);
  });

  it("marks nothing outside code", () => {
    expect(importLines("README.md", ["import this", "use that"])).toEqual([false, false]);
  });
});
