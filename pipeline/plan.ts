/**
 * The run's attraverso plan, the one in the folder the run was started in, read through core's library (the
 * dependency runs one way: the reviewer imports core). Code steps only read it; the agent steps write to it, through
 * the attraverso MCP tools, so a learned rule gets an event row and a source like any other edit (KNOW-2).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { isPlanFile, openPlan, PLAN_FILE } from "attraverso/library";
import { PACKAGE } from "./paths.ts";
import { repoRulesSchema, type FileRule } from "./rules.ts";
import { DEFAULT_SPAN_PREFERENCES, type SpanPreferences } from "./spans.ts";

/** The heading of the section holding a repo's review rules. */
export const RULES_HEADING = "Review rules";

/**
 * The fenced ```yaml block in a section, parsed against `schema`: the part of a section code reads, beside the prose
 * an agent reads. Undefined when there is none; throws naming the section when it doesn't fit, rather than guessing.
 */
function fencedYaml<T>(section: string, schema: z.ZodType<T>, heading: string): T | undefined {
  const block = /```ya?ml\n([\s\S]*?)```/.exec(section)?.[1];
  if (block === undefined) return undefined;
  const parsed = schema.safeParse(parse(block));
  if (!parsed.success) throw new Error(`the "${heading}" section's yaml doesn't fit: ${parsed.error.message}`);
  return parsed.data;
}

/** A repo's rules, from its `Review rules` section. A section with no yaml block has no rules for code. */
export const rulesIn = (section: string): FileRule[] =>
  fencedYaml(section, repoRulesSchema, RULES_HEADING)?.rules ?? [];

export interface RepoRules {
  rules: FileRule[];
  /** Where they came from, for the fold step's line: the plan file and project, or why there are none. */
  from: string;
}

/** The plan file in `folder`, as core's discovery orders them: `attraverso.yaml` before a legacy plan beside it. */
export const planIn = (folder: string): string | undefined => {
  const names = (() => {
    try {
      return readdirSync(folder);
    } catch {
      return [];
    }
  })();
  const name = names
    .filter(isPlanFile)
    .sort((a, b) => Number(b === PLAN_FILE) - Number(a === PLAN_FILE) || a.localeCompare(b))[0];
  return name === undefined ? undefined : join(folder, name);
};

/**
 * The rules, from the run's plan (`path`, the plan in the folder the run was started in): its first project, or
 * `project`. No section means no rules, and the fold goes by the defaults alone.
 */
export async function repoRules(path: string, project?: string): Promise<RepoRules> {
  const name = basename(path);
  const plan = await openPlan({ yaml: readFileSync(path, "utf8") });
  try {
    const keys = (await plan.listProjects()).map((info) => info.key);
    const key = project ?? keys[0];
    if (key === undefined) return { rules: [], from: `${name} has no projects` };
    if (!keys.includes(key)) throw new Error(`${name} has no project "${key}" (it has ${keys.join(", ")})`);
    const section = await (await plan.project(key)).getSection(RULES_HEADING);
    if (section === null) return { rules: [], from: `${name} (${key}) has no "${RULES_HEADING}" section` };
    return { rules: rulesIn(section), from: `${name} (${key})` };
  } finally {
    await plan.close();
  }
}

/**
 * Where the reader's own preferences live: the reviewer's plan, project `pr-reviewer`, while Alden is its only
 * reader. A second reader moves this to a plan of their own (KNOW-3).
 */
export const READER = { planFile: join(PACKAGE, "attraverso.yaml"), project: "pr-reviewer" };

/** The heading of the section holding the reader's own preferences (KNOW-3). */
export const PREFERENCES_HEADING = "Reading preferences";

const spanPreferencesSchema = z.strictObject({
  spans: z
    .strictObject({
      imports: z.boolean().optional(),
      types: z.union([z.number().int().min(2), z.literal(false)]).optional(),
      objects: z.union([z.number().int().min(2), z.literal(false)]).optional(),
    })
    .optional(),
});

/**
 * The reader's span preferences over the defaults, from the `Reading preferences` section of the plan at `planFile`
 * (the reviewer's own plan, until there is a second reader: KNOW-3), project `project`.
 */
export async function readingPreferences(planFile: string, project: string): Promise<SpanPreferences> {
  if (!existsSync(planFile)) return DEFAULT_SPAN_PREFERENCES;
  const plan = await openPlan({ yaml: readFileSync(planFile, "utf8") });
  try {
    const section = await (await plan.project(project)).getSection(PREFERENCES_HEADING);
    const preferences = section === null ? undefined : fencedYaml(section, spanPreferencesSchema, PREFERENCES_HEADING);
    return { ...DEFAULT_SPAN_PREFERENCES, ...preferences?.spans };
  } finally {
    await plan.close();
  }
}

/**
 * The plan files a run reads: its plan, then the others committed in the same repo (this one holds three, each its own
 * project with its own Next list, all served by its MCP config). Never the reviewed checkout's: at work the run's plan
 * sits above the company's repos and is the one the agent's tools serve, whatever a repo under it holds.
 */
export function runPlans(path: string): string[] {
  const folder = dirname(path);
  const listed = (() => {
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: folder,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return execFileSync("git", ["ls-files"], { cwd: top, encoding: "utf8" })
        .split("\n")
        .filter((file) => isPlanFile(basename(file)))
        .map((file) => join(top, file));
    } catch {
      return [];
    }
  })();
  return [path, ...listed.filter((file) => file !== path)];
}

/**
 * The Next lists of the projects `keys` (CHECK-12), from the run's plans (`runPlans`). Opens plans one at a time and
 * stops once every key is found, so a review whose findings name no items boots nothing; where two plans share a key,
 * the run's own plan wins.
 */
export async function nextLists(path: string, keys: string[]): Promise<Record<string, string[]>> {
  const wanted = new Set(keys);
  if (wanted.size === 0) return {};
  const files = runPlans(path);
  return files.reduce<Promise<Record<string, string[]>>>(async (previous, path) => {
    const found = await previous;
    const missing = [...wanted].filter((key) => found[key] === undefined);
    if (missing.length === 0) return found;
    const plan = await openPlan({ yaml: readFileSync(path, "utf8") });
    try {
      const here = (await plan.listProjects()).map((info) => info.key).filter((key) => missing.includes(key));
      const lists = await Promise.all(
        here.map(async (key) => [key, await (await plan.project(key)).getNext()] as const),
      );
      return { ...found, ...Object.fromEntries(lists) };
    } finally {
      await plan.close();
    }
  }, Promise.resolve({}));
}
