import { en } from "zod/locales";
import * as z from "zod/mini";
import { CONFIG_FILE } from "../project/config.ts";
import { MANIFEST_FILE, OWNERSHIP } from "../project/manifest.ts";
import { CHANGE_OPERATIONS } from "../project/operations.ts";
import { pathKey, repositoryPathProblem } from "../project/paths.ts";
import { canonicalJson, PLAN_SCHEMA, PlanError, sha256Hex } from "./plan.ts";

z.config(en());

export { CHANGE_OPERATIONS, type ChangeOperation } from "../project/operations.ts";

/** Where a change in progress is recorded, so it can be finished or undone if it stops. */
export const CHANGE_JOURNAL_FILE = ".liftoff/change-journal.json";

const sha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"));

const fileChange = z.strictObject({
  /** Repository-relative POSIX path. */
  path: z.string(),
  /** sha256 of the file as it must be now, or null when it must not exist. */
  before: z.nullable(sha256),
  /** sha256 of the file once changed, or null when it is removed. */
  after: z.nullable(sha256),
  /** Who owns the file once changed; absent when it is removed. */
  ownership: z.optional(z.enum(OWNERSHIP)),
  /** Whether the changed file is executable; absent when it is removed. */
  executable: z.optional(z.boolean()),
});

const changePlanSchema = z.strictObject({
  schema: z.literal(PLAN_SCHEMA),
  operation: z.enum(CHANGE_OPERATIONS),
  liftoff: z.string(),
  /** Absolute directory of the project being changed. */
  target: z.string().check(z.minLength(1)),
  /** The project's configuration once changed. */
  config: z.record(z.string(), z.unknown()),
  effects: z.tuple([z.literal("modify-files")]),
  changes: z.array(fileChange),
  /** sha256 of every other field, so a plan cannot be edited and still apply. */
  hash: sha256,
});

export type ChangePlan = z.output<typeof changePlanSchema>;
export type FileChange = ChangePlan["changes"][number];
export type UnsignedChangePlan = Omit<ChangePlan, "hash">;

/**
 * Why a list of changed paths cannot be changed, or undefined when it can:
 * each path is repository-relative, outside .git and the journal, named
 * once (ignoring case, as macOS and Windows do), and really changes.
 */
export function pathsProblem(
  changes: readonly Pick<FileChange, "path" | "before" | "after">[],
): string | undefined {
  const seen = new Set<string>();
  for (const change of changes) {
    const problem = repositoryPathProblem(change.path);
    if (problem !== undefined) return problem;
    if (change.path === CHANGE_JOURNAL_FILE) {
      return `${change.path} is not a file a change may touch`;
    }
    const key = pathKey(change.path);
    if (seen.has(key)) return `${change.path} is listed twice`;
    seen.add(key);
    if (change.before === change.after) return `${change.path} does not change`;
  }
  return undefined;
}

/**
 * Why a plan's changes cannot be planned, or undefined when they can: the
 * paths are sound, and a file that is kept says who owns it and whether it
 * is executable.
 */
export function changesProblem(changes: readonly FileChange[]): string | undefined {
  const problem = pathsProblem(changes);
  if (problem !== undefined) return problem;
  for (const change of changes) {
    const kept = change.after !== null;
    if (kept !== (change.ownership !== undefined) || kept !== (change.executable !== undefined)) {
      return `${change.path} must say who owns it and whether it is executable exactly when it is kept`;
    }
  }
  return undefined;
}

/**
 * The order changes are made in: the project's files first, then its
 * configuration, then the manifest, so the manifest never describes files
 * that were not written.
 */
export function orderChanges<T extends { readonly path: string }>(changes: readonly T[]): T[] {
  const rank = (path: string) => (path === MANIFEST_FILE ? 2 : path === CONFIG_FILE ? 1 : 0);
  return [...changes].sort(
    (a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export function sealChangePlan(plan: UnsignedChangePlan): ChangePlan {
  const problem = changesProblem(plan.changes);
  if (problem !== undefined) throw new PlanError(`the plan cannot be made: ${problem}`);
  const ordered = { ...plan, changes: orderChanges(plan.changes) };
  return { ...ordered, hash: sha256Hex(canonicalJson(ordered)) };
}

/** Parses a change plan and checks it was not edited after it was made. */
export function parseChangePlan(text: string): ChangePlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PlanError(`the plan is not valid JSON: ${(error as Error).message}`);
  }
  const operation = (raw as { operation?: unknown } | null)?.operation;
  if (operation === "init") {
    throw new PlanError("this plan creates a project; apply it with liftoff init --plan");
  }
  const parsed = z.safeParse(changePlanSchema, raw);
  if (!parsed.success) {
    throw new PlanError(
      `the plan is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const { hash, ...rest } = parsed.data;
  if (sha256Hex(canonicalJson(rest)) !== hash) {
    throw new PlanError("the plan was changed after it was made; create a new plan");
  }
  const problem = changesProblem(rest.changes);
  if (problem !== undefined) throw new PlanError(`the plan is invalid: ${problem}`);
  return parsed.data;
}
