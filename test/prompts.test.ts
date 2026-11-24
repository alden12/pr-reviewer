/**
 * The prompts' examples are the shape an agent copies, so they must fit the schema the run then checks the file
 * against: an example that drifts teaches every run the wrong file (at work, narrate's had none, and the agent read
 * `narrativeSchema` in the bundle to find it).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { narrativeSchema } from "../pipeline/artefacts.ts";
import { PROMPTS } from "../pipeline/paths.ts";

const example = (prompt: string): unknown => {
  const text = readFileSync(join(PROMPTS, prompt), "utf8");
  const block = /```json\n([^]*?)\n```/.exec(text)?.[1];
  if (block === undefined) throw new Error(`${prompt} has no json example`);
  return JSON.parse(block);
};

describe("the prompts' examples", () => {
  it("narrate's fits narrative.json's schema", () => {
    expect(narrativeSchema.safeParse(example("narrate.md")).error).toBeUndefined();
  });
});
