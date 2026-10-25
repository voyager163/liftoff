import { createHash } from "node:crypto";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { OWNERSHIP } from "../project/manifest.ts";

z.config(en());

export const PLAN_SCHEMA = "liftoff.plan/v1";

/** Effects a plan may have. Init only writes files into a new directory. */
export const EFFECTS = ["write-files"] as const;

const planSchema = z.strictObject({
  schema: z.literal(PLAN_SCHEMA),
  operation: z.literal("init"),
  liftoff: z.string(),
  /** Absolute directory the project will be created in. */
  target: z.string().check(z.minLength(1)),
  config: z.record(z.string(), z.unknown()),
  effects: z.array(z.enum(EFFECTS)),
  files: z.array(
    z.strictObject({
      path: z.string(),
      ownership: z.enum(OWNERSHIP),
      sha256: z.string(),
      bytes: z.number(),
    }),
  ),
  /** sha256 of every other field, so a plan cannot be edited and still apply. */
  hash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
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

/** Parses a plan file and checks it was not edited after it was made. */
export function parsePlan(text: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PlanError(`the plan is not valid JSON: ${(error as Error).message}`);
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
  return parsed.data;
}
