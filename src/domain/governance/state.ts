import { en } from "zod/locales";
import * as z from "zod/mini";
import { CHECKPOINTS } from "./checkpoints.ts";

z.config(en());

/**
 * What Liftoff recorded while activating a project's governance: each action
 * it took, and the proof, which GitHub cannot show afterwards. It is the
 * project's file. Checkpoints are always re-observed on GitHub; this only
 * says what was done, and what a resumed run must check first.
 */
export const GOVERNANCE_STATE_FILE = ".liftoff/governance.json";
export const GOVERNANCE_STATE_SCHEMA = "liftoff.governance/v1";

/** The ways a protected branch is changed without a pull request, each of which must be refused. */
export const PROOFS = ["direct-push", "force-push", "deletion"] as const;
export type ProofKind = (typeof PROOFS)[number];

const stateSchema = z.strictObject({
  schema: z.literal(GOVERNANCE_STATE_SCHEMA),
  repository: z.strictObject({ id: z.number(), fullName: z.string() }),
  actions: z.array(
    z.strictObject({
      checkpoint: z.enum(CHECKPOINTS),
      kind: z.string(),
      startedAt: z.string(),
      /** Missing while the action runs, so a resumed run knows to check it. */
      finishedAt: z.optional(z.string()),
      outcome: z.optional(z.enum(["done", "failed"])),
      detail: z.optional(z.string()),
    }),
  ),
  proof: z.optional(
    z.strictObject({ passed: z.boolean(), rulesetIds: z.array(z.number()), at: z.string() }),
  ),
  /**
   * A forbidden change verify --prove is trying, written before it is tried
   * and removed once the branch is as it was. Still here, it was interrupted,
   * and resume puts the branch back.
   */
  probe: z.optional(
    z.strictObject({
      branch: z.string(),
      proof: z.enum(PROOFS),
      /** The branch's head before the change. */
      head: z.string(),
      /** The commit the change moves the branch to; none for a deletion. */
      sha: z.optional(z.string()),
      startedAt: z.string(),
    }),
  ),
});

export type GovernanceState = z.output<typeof stateSchema>;
export type PendingProbe = NonNullable<GovernanceState["probe"]>;

export class GovernanceStateError extends Error {
  override readonly name = "GovernanceStateError";
}

export function parseGovernanceState(text: string): GovernanceState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GovernanceStateError(
      `${GOVERNANCE_STATE_FILE} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = z.safeParse(stateSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new GovernanceStateError(`${GOVERNANCE_STATE_FILE} is invalid: ${issues.join("; ")}`);
  }
  return parsed.data;
}

export const serializeGovernanceState = (state: GovernanceState): string =>
  `${JSON.stringify(state, null, 2)}\n`;
