import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { validateManifestActivationForExecution, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { UpdatePreviewOptions } from '../filesystem/update-previews.js';
import { currentProjectMutationLease } from '../filesystem/project-lock.js';
import { GitHubActivationError } from '../github/activation-rest.js';

/** This is admission to the released credential gate, not another approval issuer. */
export async function assertCredentialAuthority(
  input: PhaseAdapterExecutionInput,
  operation: TransitionOperation,
  storage?: UpdatePreviewOptions
): Promise<void> {
  storage ??= input.adapters.githubActivation?.storage;
  validateManifestActivationForExecution(input.inspection.manifest);
  const plan = validateSavedTransitionPlan(input.plan);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'credential-ready')!;
  if (input.phase.id !== phase.id || canonicalSha256(input.phase) !== canonicalSha256(phase) ||
    input.inspection.graphHash !== canonicalPhaseGraphHash || plan.graphHash !== canonicalPhaseGraphHash ||
    plan.phaseId !== phase.id || operation.phaseId !== phase.id || plan.scope !== 'activation' ||
    (plan.selectionScope ?? 'activation') !== 'activation' || (input.inspection.scope ?? 'activation') !== 'activation' ||
    !plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
    throw new GitHubActivationError('credential-authority', 'Credential execution requires its exact current activation phase and reviewed operation.');
  }
  assertPlanOperationsAllowed(plan, phase);
  if (!input.lease) throw new GitHubActivationError('credential-lease', 'Credential execution requires the cooperating project mutation lease.');
  const held = await currentProjectMutationLease(input.inspection.projectRoot);
  if (!held) throw new GitHubActivationError('credential-lease', 'Credential execution requires the real project-bound cooperating mutation lease, not a supplied callback.');
  await held.assertHeld();
  await input.lease.assertHeld();
  const now = input.clock?.() ?? input.now;
  if (!Number.isFinite(now.getTime()) || Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime() ||
    canonicalSha256(plan.configuration ?? null) !== canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null)) {
    throw new GitHubActivationError('credential-plan-stale', 'Credential configuration or reviewed time binding changed; review a fresh exact plan.');
  }
  const request = approvalRequestForSavedPlan(plan, phase, input.inspection.state);
  const envelope = input.inspection.approvals.find((entry) => entry.id === plan.approval.envelopeId);
  const result = evaluateApprovalForTransitionPlan(request, envelope ? [envelope] : [], { now });
  if (result.approvalRequired || !envelope || result.envelopeId !== plan.approval.envelopeId ||
    result.envelopeHash !== plan.approval.envelopeHash || envelope.gateKind !== phase.approvalGate.kind) {
    throw new GitHubActivationError('credential-approval', 'Credential execution needs its exact independent unexpired enrollment approval.');
  }
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, storage);
  await input.lease.assertHeld();
}
