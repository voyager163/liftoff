import { rulesetFingerprint } from "../../domain/governance/checkpoints.ts";
import { targetedBranches } from "../../domain/governance/ruleset-drift.ts";
import type { GovernanceState } from "../../domain/governance/state.ts";
import type { GitHubApiPort, ProjectFsPort } from "../ports.ts";
import { stateFor } from "./apply.ts";
import { type Assessment, assessGovernance, GovernanceError } from "./assess.ts";
import { withGovernanceLock } from "./lock.ts";
import { type ProofResult, proveBranch } from "./prove.ts";
import { writeGovernanceState } from "./state.ts";

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
  options: VerifyOptions,
): Promise<VerifyResult> {
  // Proving changes GitHub and the record, so it holds the lock throughout.
  return options.prove
    ? withGovernanceLock(ports.fs, directory, options.now, () =>
        verifyLocked(ports, directory, repository, options),
      )
    : verifyLocked(ports, directory, repository, options);
}

interface VerifyOptions {
  readonly prove: boolean;
  readonly confirm: () => Promise<boolean>;
  readonly now: () => string;
}

async function verifyLocked(
  ports: { fs: ProjectFsPort; github: GitHubApiPort },
  directory: string,
  repository: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const assessment = await assessGovernance(ports, directory, repository);
  const status = (id: string) => assessment.checkpoints.find((c) => c.id === id)?.status;
  // Nothing committed matches nothing: the handoff must have rulesets.
  const matches =
    status("handoff") === "done" && status("rulesets") === "done" && status("readback") === "done";
  if (!options.prove) return { kind: "readback", matches, assessment };
  if (!matches) {
    throw new GovernanceError(
      "the rulesets must be applied and match before they can be proved; see liftoff governance assess",
    );
  }
  // Checked before anything changes: the record must be this repository's,
  // with no earlier proof left unfinished.
  let state: GovernanceState = await stateFor(ports.fs, directory, assessment);
  if (state.probe !== undefined) {
    throw new GovernanceError(
      `an earlier proof was interrupted while trying ${state.probe.proof} on ${state.probe.branch}; run liftoff governance resume first`,
    );
  }
  const branches = [...new Set(assessment.desired.rulesets.flatMap(targetedBranches))];
  if (branches.length === 0) {
    throw new GovernanceError("the rulesets name no branch to prove");
  }
  if (!(await options.confirm())) return { kind: "declined" };

  const save = async (next: GovernanceState) => {
    state = next;
    await writeGovernanceState(ports.fs, directory, next);
  };
  const journal = {
    start: (probe: Omit<NonNullable<GovernanceState["probe"]>, "startedAt">) =>
      save({ ...state, probe: { ...probe, startedAt: options.now() } }),
    finish: () => {
      const { probe, ...rest } = state;
      return save(rest);
    },
  };
  const rulesetIds = assessment.desired.rulesets
    .map(({ name }) => assessment.observed.rulesets.find((ruleset) => ruleset.name === name)?.id)
    .filter((rulesetId): rulesetId is number => rulesetId !== undefined);
  const fingerprint = rulesetFingerprint(assessment.desired, assessment.observed);
  const record = (passed: boolean) =>
    save({ ...state, proof: { passed, rulesetIds, fingerprint, at: options.now() } });
  // Until this proof passes, no earlier one counts: one that stops part way
  // leaves a failed record, not the last pass.
  await record(false);
  const results: ProofResult[] = [];
  for (const branch of branches) {
    const proved = await proveBranch(ports.github, repository, branch, journal);
    results.push(...proved);
    // A branch that could not be put back stops the proof; resume finishes it.
    if (state.probe !== undefined) break;
  }
  const passed = state.probe === undefined && results.every((result) => result.refused);
  await record(passed);
  return {
    kind: "proved",
    passed,
    results,
    assessment: await assessGovernance(ports, directory, repository),
  };
}
