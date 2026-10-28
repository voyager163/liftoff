import { createHash } from "node:crypto";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { OWNERSHIP } from "../project/manifest.ts";
import { CREATE_OPERATIONS, type CreateOperation } from "../project/operations.ts";

z.config(en());

export const PLAN_SCHEMA = "liftoff.plan/v1";

/**
 * Effects a plan may have. Init writes files into a new directory and, for a
 * workflow with its own initializer, runs that initializer there. Migrate
 * writes files there and copies files into it from the project it migrates.
 */
export const EFFECTS = ["write-files", "run-initializer", "copy-files"] as const;

/** The commands that apply each kind of plan. */
export const CREATE_COMMANDS: Record<CreateOperation, string> = {
  init: "liftoff init",
  migrate: "liftoff migrate",
};

const sha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/));

const planSchema = z.strictObject({
  schema: z.literal(PLAN_SCHEMA),
  operation: z.enum(CREATE_OPERATIONS),
  liftoff: z.string(),
  /** Absolute directory the project will be created in. */
  target: z.string().check(z.minLength(1)),
  /** For migrate: the absolute directory of the project it copies from, which it never changes. */
  source: z.optional(z.string().check(z.minLength(1))),
  config: z.record(z.string(), z.unknown()),
  effects: z.array(z.enum(EFFECTS)),
  /** The pinned initializer init runs in the new project, when the workflow has one. */
  initializer: z.optional(
    z.strictObject({
      name: z.string(),
      version: z.string(),
      steps: z.array(z.strictObject({ command: z.string(), args: z.array(z.string()) })),
    }),
  ),
  files: z.array(
    z.strictObject({
      path: z.string(),
      ownership: z.enum(OWNERSHIP),
      sha256: z.string(),
      bytes: z.number(),
    }),
  ),
  /**
   * For migrate: each file copied from the source, by its path there, with
   * the sha256 and size it must still have when it is copied.
   */
  copies: z.optional(z.array(z.strictObject({ path: z.string(), sha256, bytes: z.number() }))),
  /** For migrate: the checklist it writes, which is the project's own. */
  checklist: z.optional(z.strictObject({ path: z.string(), sha256, bytes: z.number() })),
  /** sha256 of every other field, so a plan cannot be edited and still apply. */
  hash: sha256,
});

export type Plan = z.output<typeof planSchema>;
export type UnsignedPlan = Omit<Plan, "hash">;

export class PlanError extends Error {
  override readonly name = "PlanError";
}

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export function sealPlan(plan: UnsignedPlan): Plan {
  return { ...plan, hash: sha256Hex(canonicalJson(plan)) };
}

/**
 * Parses a plan file for `operation` and checks it was not edited after it
 * was made. A plan for another command is refused, naming that command.
 */
export function parsePlan(text: string, operation: CreateOperation = "init"): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PlanError(`the plan is not valid JSON: ${(error as Error).message}`);
  }
  const named = (raw as { operation?: unknown } | null)?.operation;
  if (typeof named === "string" && named !== operation) {
    const other = CREATE_OPERATIONS.find((create) => create === named);
    throw new PlanError(
      other === undefined
        ? `this plan changes an existing project (${named}), not one that creates a project`
        : `this plan is for ${CREATE_COMMANDS[other]}, not ${CREATE_COMMANDS[operation]}; apply it with that command`,
    );
  }
  const parsed = z.safeParse(planSchema, raw);
  if (!parsed.success) {
    throw new PlanError(
      `the plan is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const { hash, ...rest } = parsed.data;
  if (sha256Hex(canonicalJson(rest)) !== hash) {
    throw new PlanError("the plan was changed after it was made; create a new plan");
  }
  // What only a migration has, a migration must have, and nothing else may.
  const migrating = [rest.source, rest.copies, rest.checklist];
  if (migrating.some((field) => (field === undefined) !== (operation === "init"))) {
    throw new PlanError(
      operation === "init"
        ? "the plan is invalid: only a migration copies files from another project"
        : "the plan is invalid: a migration names the project it copies, each file and its checklist",
    );
  }
  return parsed.data;
}
