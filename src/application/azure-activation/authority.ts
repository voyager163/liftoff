import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { validateSavedTransitionPlan, validateManifestActivationForExecution } from '../../domain/governance/activation/validators.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';

export class AzureActivationAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AzureActivationAdmissionError';
  }
}

export async function assertAzurePhaseAuthority(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation
): Promise<void> {
  validateManifestActivationForExecution(input.inspection.manifest);
  const plan = validateSavedTransitionPlan(input.plan);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === input.phase.id);
  if (!phase || canonicalSha256(phase) !== canonicalSha256(input.phase) ||
    input.inspection.graphHash !== canonicalPhaseGraphHash || plan.graphHash !== canonicalPhaseGraphHash ||
    plan.scope !== 'activation' || (plan.selectionScope ?? 'activation') !== 'activation' ||
    (input.inspection.scope ?? 'activation') !== 'activation' ||
    plan.phaseId !== phase.id || operation.phaseId !== phase.id ||
    !plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
    throw new AzureActivationAdmissionError('plan-mismatch', 'The Azure operation is not in the exact current reviewed activation phase and scope.');
  }
  assertPlanOperationsAllowed(plan, phase);
  if (!input.lease) throw new AzureActivationAdmissionError('lease-required', 'Azure execution requires the existing cooperating project mutation lease.');
  await input.lease.assertHeld();
  const now = input.clock?.() ?? input.now;
  if (Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new AzureActivationAdmissionError('plan-expired', 'The exact Azure phase plan is not current; review a fresh plan before provider access.');
  }
  if (canonicalSha256(plan.configuration ?? null) !==
    canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null)) {
    throw new AzureActivationAdmissionError('configuration-changed', 'Azure configuration differs from the exact reviewed plan.');
  }
  if (!phase.approvalGate.required) return;
  const requested = approvalRequestForSavedPlan(plan, phase, input.inspection.state);
  const candidates = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const approval = evaluateApprovalForTransitionPlan(requested, candidates, { now });
  if (candidates.length !== 1 || approval.approvalRequired || approval.envelopeId !== plan.approval.envelopeId ||
    approval.envelopeHash !== plan.approval.envelopeHash) {
    throw new AzureActivationAdmissionError('approval-required', 'Azure execution requires its exact unexpired phase-specific governance approval.');
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === approval.envelopeId);
  if (!envelope) throw new AzureActivationAdmissionError('approval-required', 'The reviewed Azure approval envelope is missing.');
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, azurePorts(input).storage);
  await input.lease.assertHeld();
}
