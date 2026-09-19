import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { validateManifestActivationForExecution, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';

export async function assertRepositoryControlAuthority(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation
): Promise<void> {
  validateManifestActivationForExecution(input.inspection.manifest);
  const plan = validateSavedTransitionPlan(input.plan);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === input.phase.id);
  const scope = input.phase.id.startsWith('repository-') ? 'repository' : 'activation';
  if (!phase || !['repository-rulesets-applied', 'repository-live-readback', 'rulesets-applied', 'live-readback'].includes(phase.id) ||
    canonicalSha256(phase) !== canonicalSha256(input.phase) ||
    input.inspection.graphHash !== canonicalPhaseGraphHash || plan.graphHash !== canonicalPhaseGraphHash ||
    (input.inspection.scope ?? 'activation') !== scope || plan.scope !== scope ||
    (plan.selectionScope ?? scope) !== scope || plan.phaseId !== phase.id || operation.phaseId !== phase.id ||
    !plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
    throw new GitHubActivationError('control-authority', 'The exact repository-control operation, current graph and explicitly selected scope must match the reviewed plan.');
  }
  try {
    assertPlanOperationsAllowed(plan, phase);
  } catch {
    throw new GitHubActivationError('control-plan-contract', 'The reviewed control operations do not satisfy the registered phase/action contract. Resolve that local integration or review a valid current plan before provider effects.');
  }
  if (!input.lease) throw new GitHubActivationError('lease-required', 'Repository-control execution requires the existing project mutation lease.');
  await input.lease.assertHeld();
  const now = input.clock?.() ?? input.now;
  if (Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime() ||
    canonicalSha256(plan.configuration ?? null) !==
      canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null)) {
    throw new GitHubActivationError('stale-control-plan', 'The reviewed repository-control plan expired or its exact configuration changed.');
  }
  if (!phase.approvalGate.required) return;
  const requested = approvalRequestForSavedPlan(plan, phase, input.inspection.state);
  const candidates = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const evaluation = evaluateApprovalForTransitionPlan(requested, candidates, { now });
  if (candidates.length !== 1 || evaluation.approvalRequired || evaluation.envelopeId !== plan.approval.envelopeId ||
    evaluation.envelopeHash !== plan.approval.envelopeHash) {
    throw new GitHubActivationError('control-approval', 'Repository-control execution requires the current exact scope-specific enforcement approval.');
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === evaluation.envelopeId);
  if (!envelope) throw new GitHubActivationError('control-approval', 'The exact enforcement approval envelope is absent.');
  try {
    await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, githubPorts(input).storage);
  } catch {
    throw new GitHubActivationError('control-approval', 'The enforcement approval has no released project-bound private issuance; imported JSON is not permission.');
  }
  await input.lease.assertHeld();
}
