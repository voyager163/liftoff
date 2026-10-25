import { targetedBranches } from "../../domain/governance/ruleset-drift.ts";
import { GOVERNANCE_STATE_SCHEMA } from "../../domain/governance/state.ts";
import type { GitHubApiPort, ProjectFsPort } from "../ports.ts";
import { type Assessment, assessGovernance, GovernanceError } from "./assess.ts";
import { type ProofResult, proveBranch } from "./prove.ts";
import { readGovernanceState, writeGovernanceState } from "./state.ts";

export type VerifyResult =
  | { readonly kind: "readback"; readonly matches: boolean; readonly assessment: Assessment }
  | { readonly kind: "declined" }
  | {
      readonly kind: "proved";
      readonly passed: boolean;
      readonly results: readonly ProofResult[];
      readonly assessment: Assessment;
    };

/**
 * Reads back what GitHub enforces and compares it with the committed
 * rulesets. With prove, and once the person agrees, also tries each change
 * the rules forbid on every protected branch, and records the outcome.
 */
export async function verifyGovernance(
  ports: { fs: ProjectFsPort; github: GitHubApiPort },
  directory: string,
  repository: string,
  options: {
    readonly prove: boolean;
    readonly confirm: () => Promise<boolean>;
    readonly now: () => string;
  },
): Promise<VerifyResult> {
  const assessment = await assessGovernance(ports, directory, repository);
  const status = (id: string) => assessment.checkpoints.find((c) => c.id === id)?.status;
  const matches = status("rulesets") === "done" && status("readback") === "done";
  if (!options.prove) return { kind: "readback", matches, assessment };
  if (!matches) {
    throw new GovernanceError(
      "the rulesets must be applied and match before they can be proved; see liftoff governance assess",
    );
  }
  if (!(await options.confirm())) return { kind: "declined" };

  const results: ProofResult[] = [];
  for (const branch of new Set(assessment.desired.rulesets.flatMap(targetedBranches))) {
    results.push(...(await proveBranch(ports.github, repository, branch)));
  }
  const passed = results.every((result) => result.refused);
  const { id, fullName } = assessment.observed.repository;
  const state = (await readGovernanceState(ports.fs, directory)) ?? {
    schema: GOVERNANCE_STATE_SCHEMA,
    repository: { id, fullName },
    actions: [],
  };
  if (state.repository.id !== id) {
    throw new GovernanceError(
      `.liftoff/governance.json is for ${state.repository.fullName}, not ${fullName}`,
    );
  }
  const rulesetIds = assessment.desired.rulesets
    .map(({ name }) => assessment.observed.rulesets.find((ruleset) => ruleset.name === name)?.id)
    .filter((rulesetId): rulesetId is number => rulesetId !== undefined);
  await writeGovernanceState(ports.fs, directory, {
    ...state,
    proof: { passed, rulesetIds, at: options.now() },
  });
  return {
    kind: "proved",
    passed,
    results,
    assessment: await assessGovernance(ports, directory, repository),
  };
}
