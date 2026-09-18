import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed, planDigestFor } from '../../domain/governance/activation/operations.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, savedPlanAuthorityDigest
} from '../../domain/governance/activation/approvals.js';
import { validateSavedTransitionPlan, validateApprovalEnvelope } from '../../domain/governance/activation/validators.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import { StateMigrationError, type StateArtifactDescriptor } from '../../domain/repair/stateful.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must, applicationPrivateProtocol,
  type ApplicationPrivateConfiguration, type ApplicationPrivateResult, type ApplicationPrivateReview,
  type ApplicationPrivateRuntime, type ApplicationPrivateSavedPlan
} from './application-private-contracts.js';
import { applicationPrivateIntent } from './application-private-inputs.js';
import { applicationPrivateJson } from './application-private-plan.js';
import type { ApplicationPrivateJournalHandle } from './application-private-checkpoints.js';
import { applicationPrivateArtifactForTarget } from './application-private-artifacts.js';

export function applicationPrivateFailureCode(error: unknown): string {
  return error instanceof ApplicationPrivateError ? error.code :
    error instanceof StateMigrationError ? error.code :
      error instanceof AzureActivationAdmissionError && error.code.startsWith('application-artifact-') ? 'artifact-set-custody' :
        error instanceof AzureArmError ? 'azure-observation-failed' : 'private-execution-incomplete';
}

export function applicationPrivateFailureMessage(error: unknown): string {
  return new ApplicationPrivateError(applicationPrivateFailureCode(error)).message;
}

export async function readApplicationPrivateArtifact(
  runtime: ApplicationPrivateRuntime, descriptor: StateArtifactDescriptor, purpose: StateArtifactDescriptor['purpose']
): Promise<Uint8Array> {
  must(descriptor.purpose === purpose && descriptor.scope === protectedStateScope(runtime.context) &&
    descriptor.ref.startsWith(`${runtime.storage.workspace.workspaceRef}/`), 'private-artifact-binding');
  const bytes = await runtime.storage.workspace.get(descriptor.ref, purpose, descriptor.scope);
  if (stateDigest(bytes) !== descriptor.digest) { bytes.fill(0); must(false, 'private-artifact-changed'); }
  return bytes;
}

export async function readApplicationPrivateSavedPlan(
  runtime: ApplicationPrivateRuntime, journal: ApplicationPrivateJournalHandle, config: ApplicationPrivateConfiguration
): Promise<ApplicationPrivateSavedPlan> {
  must(journal.value.planRef, 'original-saved-plan-missing');
  const bytes = await runtime.storage.workspace.get(journal.value.planRef, 'plan', journal.scope);
  try {
    const value = applicationPrivateJson(bytes) as unknown as ApplicationPrivateSavedPlan;
    must(value.schemaVersion === 1 && value.protocol === applicationPrivateProtocol &&
      value.transactionId === journal.value.transactionId &&
      canonicalSha256(value.context) === canonicalSha256(runtime.context) &&
      canonicalSha256(value.intent) === canonicalSha256(applicationPrivateIntent(config)) &&
      value.review.planRef === journal.value.planRef && value.review.journalRef === journal.ref &&
      canonicalSha256(value.original) === canonicalSha256(journal.value.original) &&
      canonicalSha256(value.originalSnapshot) === canonicalSha256(journal.value.originalSnapshot) &&
      (config.mode === 'prepare' || canonicalSha256(value.review) === canonicalSha256(config.reviewed)),
    'original-saved-plan-binding');
    const { digest, ...source } = value.source;
    must(canonicalSha256(source) === digest && digest === value.review.sourceDigest, 'original-source-binding');
    return value;
  } finally { bytes.fill(0); }
}

export async function verifyApplicationPrivateOriginalAuthority(
  input: PhaseAdapterExecutionInput, journal: ApplicationPrivateJournalHandle
): Promise<void> {
  const root = journal.value;
  for (const original of [root.originalGovernancePlan, root.applyGovernancePlan].filter((plan) => plan !== null)) {
    const plan = validateSavedTransitionPlan(original);
    must(plan.phaseId === root.phaseId, 'original-governance-phase');
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === plan.phaseId)!;
    assertPlanOperationsAllowed(plan, phase);
    const hash = plan.approval.envelopeHash;
    must(hash, 'original-issued-approval-missing');
    const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-approval', azurePorts(input).storage).read(hash);
    must(record && isRecord(record.value) && record.value.kind === 'liftoff-governance-approval', 'original-issued-approval-missing');
    const envelope = validateApprovalEnvelope(record.value.envelope);
    const authorityDigest = savedPlanAuthorityDigest(plan, phase);
    must(canonicalApprovalEnvelopeHash(envelope) === hash &&
      plan.planDigest === planDigestFor({ phase, transitionDigest: plan.transitionDigest,
        operations: plan.operations, approvalPlanDigest: authorityDigest }) && envelope.planDigest === authorityDigest,
    'original-issued-approval-mismatch');
    const firstEffect = root.events.find((event) => event.kind === 'backend-intent' &&
      event.details.governancePlanDigest === plan.planDigest && event.details.approvalEnvelopeHash === hash);
    const admittedAt = firstEffect ? Date.parse(firstEffect.at) :
      Math.max(Date.parse(plan.createdAt), Date.parse(envelope.approvedAt));
    const evaluation = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(plan, phase, input.inspection.state),
      [envelope], { now: new Date(admittedAt) });
    must(!evaluation.approvalRequired && evaluation.envelopeHash === hash &&
      Number.isFinite(admittedAt) && admittedAt >= Date.parse(plan.createdAt) &&
      admittedAt >= Date.parse(envelope.approvedAt) && admittedAt < Date.parse(plan.expiresAt), 'original-exact-plan-approval');
    await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, azurePorts(input).storage);
  }
  must(root.originalGovernancePlan.approval.envelopeHash === root.originalApprovalEnvelopeHash &&
    (!root.applyGovernancePlan || root.applyGovernancePlan.approval.envelopeHash === root.applyApprovalEnvelopeHash), 'original-approval-binding');
}

/** Public projection of retained custody; consumers must still reopen and verify its private originals. */
export function applicationPrivateResult(
  journal: ApplicationPrivateJournalHandle | undefined, config: ApplicationPrivateConfiguration | undefined,
  status: ApplicationPrivateResult['status'], reviewed?: ApplicationPrivateReview, error?: unknown
): ApplicationPrivateResult {
  const value = journal?.value;
  const observations = value?.observations ?? [];
  return {
    status, transactionId: value?.transactionId ?? null, journalRef: journal?.ref ?? null,
    retainedCandidateRef: value?.candidate?.ref ?? null,
    ...(reviewed ? { reviewed } : {}),
    effects: (reviewed?.changes ?? []).map((change) => {
      const observed = observations.find((entry) => entry.address === change.address);
      const receipt = [...value?.events ?? []].reverse().find((event) => event.kind === 'resource-observed' &&
        event.details.address === change.address && typeof event.details.readbackRequestId === 'string');
      return {
        address: change.address, action: change.action,
        status: observed?.verified ? 'observed' as const : value?.nativeStarted ? 'attempted-uncertain' as const : 'not-attempted' as const,
        resourceId: observed?.exists ? observed.resourceId : null,
        mutationRequestId: null, readbackRequestId: observed?.readbackRequestId ??
          (typeof receipt?.details.readbackRequestId === 'string' ? receipt.details.readbackRequestId : null)
      };
    }),
    state: value?.publication === 'verified' ? 'published-verified' :
      value?.publication === 'intent' || value?.publication === 'uncertain' || value?.publication === 'returned' ? 'publication-uncertain' :
        value?.candidate ? 'candidate-retained' : 'unchanged',
    observations: observations.map(({ values: _values, privateDigest: _digest, ...observation }) => observation),
    identities: [...observations.filter((entry) => entry.exists && entry.resourceType === 'Microsoft.ManagedIdentity/userAssignedIdentities' &&
      ['principal_id', 'client_id', 'tenant_id'].every((field) => typeof entry.values[field] === 'string'))
      .map((entry) => ({ address: entry.address, resourceId: entry.resourceId,
        principalId: String(entry.values.principal_id), clientId: String(entry.values.client_id), tenantId: String(entry.values.tenant_id) })),
    ...observations.flatMap((entry) => entry.dependencies.filter((dependency) =>
      dependency.principalId && dependency.clientId && dependency.tenantId).map((dependency) => ({
      address: `${entry.address}.identity`, resourceId: dependency.resourceId, principalId: dependency.principalId!,
      clientId: dependency.clientId!, tenantId: dependency.tenantId!
    })))],
    ...(error ? { blocker: applicationPrivateFailureMessage(error) } : {}),
    additionalReview: config?.scope === 'prerequisites-core' ? 'exact-workload-rbac' :
      config?.scope === 'foundation-dependencies' || config?.scope === 'staging-dependencies' ? 'complete-application-deployment' : null,
    atomicAcrossProviders: false, qualification: 'unqualified-source-component'
  };
}

export function completedApplicationPrivateResult(
  journal: ApplicationPrivateJournalHandle, config: ApplicationPrivateConfiguration, reviewed: ApplicationPrivateReview
): ApplicationPrivateResult {
  must(journal.value.final === 'completed', 'completed-private-execution-required');
  return applicationPrivateResult(journal, config, 'executed', reviewed);
}

export async function validateApplicationPrivateEffectIntents(
  runtime: ApplicationPrivateRuntime, journal: ApplicationPrivateJournalHandle, plan: ApplicationPrivateSavedPlan
): Promise<void> {
  const expected = plan.review.changes.filter((change) => change.action !== 'no-op');
  must(journal.value.effectIntents.length === expected.length && journal.value.applyGovernancePlan, 'original-effect-intents-missing');
  const addresses = new Set<string>();
  for (const descriptor of journal.value.effectIntents) {
    const bytes = await readApplicationPrivateArtifact(runtime, descriptor, 'journal');
    try {
      const effect = applicationPrivateJson(bytes);
      const change = expected.find((item) => item.address === effect.address);
      const target = plan.intent.targets.find((item) => item.address === effect.address);
      const artifact = plan.intent.artifactSet && target ? applicationPrivateArtifactForTarget(plan.intent, target) : null;
      must(change && !addresses.has(change.address) && effect.protocol === applicationPrivateProtocol &&
        effect.kind === 'resource-effect-intent' && effect.transactionId === journal.value.transactionId &&
        effect.planRef === plan.review.planRef && effect.savedPlanDigest === plan.savedPlan.digest &&
        effect.action === change.action && effect.targetResourceId === change.targetResourceId &&
        effect.approvalEnvelopeHash === journal.value.applyApprovalEnvelopeHash &&
        effect.governancePlanDigest === journal.value.applyGovernancePlan!.planDigest &&
        effect.operationDigest === canonicalSha256(journal.value.applyGovernancePlan!.operations.find((operation) =>
          isRecord(operation.inputs.resourceEffect) && operation.inputs.resourceEffect.address === change.address)) &&
        canonicalSha256(effect.artifactSet ?? null) === canonicalSha256(plan.intent.artifactSet ?? null) &&
        (effect.artifactRole ?? null) === (artifact && 'role' in artifact ? artifact.role : null) &&
        effect.originalObservationDigest === plan.before.find((item) => item.address === change.address)?.privateDigest,
      'original-effect-intent-mismatch');
      addresses.add(change.address);
    } finally { bytes.fill(0); }
  }
}
