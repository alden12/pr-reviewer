import hljs from "highlight.js/lib/core";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { isCommentLine } from "../review/comments";

hljs.registerLanguage("go", go);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  rs: "rust",
  go: "go",
  py: "python",
  pyi: "python",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  scala: "scala",
  sc: "scala",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
};
/**
 * The highlighter's language for a file, or null to show it plain: Markdown and anything unknown. Guessing
 * TypeScript for prose lit up words like "from" and "as" as keywords.
 */
export const languageOf = (path: string): string | null => LANGUAGE_BY_EXTENSION[path.split(".").pop() ?? ""] ?? null;
const CODE = new Set(["rust", "typescript", "go", "kotlin", "swift", "scala"]);

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One line as highlighted HTML. Lines are highlighted on their own, which loses a block comment's
 * context, so comment lines are recognised first and painted as comments whole. `names`, if given,
 * wraps each followable name in a span the review's click handler picks up (FLOW-9); it only touches
 * text between tags, so the highlighter's own markup is left alone.
 */
export function highlightLine(text: string, language: string | null, names?: RegExp): string {
  if (language !== null && CODE.has(language) && isCommentLine(text))
    return `<span class="cmt">${escapeHtml(text)}</span>`;
  const html = language === null ? escapeHtml(text) : hljs.highlight(text, { language, ignoreIllegals: true }).value;
  if (!names) return html;
  return html
    .split(/(<[^>]+>)/)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part.replace(names, (name) => `<span class="follow" data-name="${name}" tabindex="0">${name}</span>`),
    )
    .join("");
}
