import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { latestRecordWithPayload } from '../../domain/governance/activation/evidence.js';
import { validateManifestActivationForExecution, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { phaseInScope, phaseScope, type TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { repositoryConfiguration } from '../../governance-activation/github-config.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { readRepositoryControlReceipt } from './repository-control-receipts.js';

async function assertControlReceiptReadback(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, now: Date
): Promise<void> {
  const repository = input.phase.id === 'repository-live-readback';
  const scope = repository ? 'repository' : 'activation';
  const digest = operation.inputs.controlReceiptDigest;
  const record = latestRecordWithPayload(input.inspection, repository ? 'repository-rulesets-applied' : 'rulesets-applied');
  if (!['live-readback', 'repository-live-readback'].includes(input.phase.id) || operation.actionId !== 'github.ruleset.readback' ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-read' || !operation.remote ||
    operation.destructive || operation.effects?.length ||
    input.plan.operations.filter((entry) => entry.adapter === 'github').length !== 1 ||
    typeof digest !== 'string' || !record || record.header.scope !== scope ||
    record.header.result !== 'verified' || !isRecord(record.payload) || record.payload.controlReceiptDigest !== digest) {
    throw new GitHubActivationError('control-read-authority',
      'An ungated live-readback phase permits only its exact current same-scope enforcement receipt-bound read, never publication or dispatch.');
  }
  const receipt = await readRepositoryControlReceipt(input, digest);
  const reads = receipt.executionPlan.operations.filter((entry) => entry.actionId === 'github.ruleset.readback');
  const original = reads[0];
  const expectedInputs = {
    repository: receipt.controlPlan.baseline.binding.repository, rulesetSourceDigest: receipt.controlPlan.sourceDigest,
    controlReceiptDigest: digest,
    ...(receipt.controlPlan.source.qualificationReferences ? { qualificationReferences: receipt.controlPlan.source.qualificationReferences } : {}),
    ...(original?.inputs.failedWorkflowArtifacts !== undefined ? { failedWorkflowArtifacts: original.inputs.failedWorkflowArtifacts } : {}),
    ...(original?.inputs.originalFixturePlans !== undefined ? { originalFixturePlans: original.inputs.originalFixturePlans } : {})
  };
  if (receipt.scope !== scope || reads.length !== 1 ||
    canonicalSha256(operation.inputs) !== canonicalSha256(expectedInputs) ||
    Date.parse(receipt.approval.expiresAt) <= now.getTime() ||
    !input.inspection.approvals.some((entry) => canonicalApprovalEnvelopeHash(entry) === canonicalApprovalEnvelopeHash(receipt.approval))) {
    throw new GitHubActivationError('control-read-authority',
      'Live readback cannot expand the original privately issued enforcement read inventory or reuse expired enforcement authority.');
  }
  await input.lease!.assertHeld();
}

export async function assertGitHubPhaseAuthority(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation
): Promise<void> {
  validateManifestActivationForExecution(input.inspection.manifest);
  const plan = validateSavedTransitionPlan(input.plan);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === input.phase.id);
  const scope = input.inspection.scope ?? 'activation';
  if (!phase || canonicalSha256(phase) !== canonicalSha256(input.phase) ||
    input.inspection.graphHash !== canonicalPhaseGraphHash || plan.graphHash !== canonicalPhaseGraphHash ||
    plan.phaseId !== phase.id || operation.phaseId !== phase.id || plan.scope !== phaseScope(phase.id) ||
    (plan.selectionScope ?? plan.scope) !== scope || !phaseInScope(phase.id, scope) ||
    !plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation)) ||
    operation.destination.repository !== repositoryConfiguration(input.inspection).name) {
    throw new GitHubActivationError('phase-authority', 'The GitHub effect is not bound to this exact current phase, repository, selection and reviewed plan.');
  }
  assertPlanOperationsAllowed(plan, phase);
  const active = input.inspection.state.phases[phase.id];
  if (active.executionPlanDigest && active.executionPlanDigest !== plan.planDigest &&
    ['running', 'blocked', 'failed'].includes(active.state)) {
    const original = input.inspection.contexts[phase.id].reviewedPlans?.find((entry) =>
      entry.planDigest === active.executionPlanDigest && entry.phaseId === phase.id);
    if (!input.recovery || !plan.recovery || !original ||
      !original.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
      throw new GitHubActivationError('recorded-recovery-required', 'An unresolved workflow phase must recover the recorded exact operation; a new target or input cannot evade its private checkpoint.');
    }
  }
  if (!input.lease) throw new GitHubActivationError('lease-required', 'GitHub execution requires the existing project mutation lease.');
  await input.lease.assertHeld();
  const now = input.clock?.() ?? input.now;
  if (Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime() ||
    canonicalSha256(plan.configuration ?? null) !==
      canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null)) {
    throw new GitHubActivationError('stale-authority', 'The exact GitHub plan has expired or its current configuration changed.');
  }
  if (!phase.approvalGate.required) {
    if (phase.id === 'live-readback' || phase.id === 'repository-live-readback') return assertControlReceiptReadback(input, operation, now);
    throw new GitHubActivationError('graph-contract', 'This phase has no mutation approval gate. Another phase approval cannot authorize GitHub publication or dispatch.');
  }
  const requested = approvalRequestForSavedPlan(plan, phase, input.inspection.state);
  const candidates = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const approval = evaluateApprovalForTransitionPlan(requested, candidates, { now });
  if (candidates.length !== 1 || approval.approvalRequired || approval.envelopeId !== plan.approval.envelopeId ||
    approval.envelopeHash !== plan.approval.envelopeHash) {
    throw new GitHubActivationError('approval-required', 'GitHub execution requires its exact unexpired phase-specific governance approval.');
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === approval.envelopeId);
  if (!envelope) throw new GitHubActivationError('approval-required', 'The exact approved GitHub envelope is missing.');
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, githubPorts(input).storage);
  await input.lease.assertHeld();
}
