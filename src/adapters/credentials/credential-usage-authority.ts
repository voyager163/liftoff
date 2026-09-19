import { lstat, realpath } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import type { ApprovalEnvelope, TransitionOperation, ExternalOperationState } from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../filesystem/update-previews.js';
import { GitHubActivationError, object, positiveId, type GitHubActivationClient } from '../github/activation-rest.js';
import { readbackWorkflowContent } from '../github/production-workflows.js';
import { readWorkflowEffect } from '../../application/repository-governance/workflow-checkpoints.js';
import { assertCredentialAuthority } from './credential-authority.js';
import { githubProviderRequestId } from './credential-checkpoints.js';
import { validateGitHubCredentialTarget, validateGitHubSecretMetadata, readGitHubSecretMetadata, type GitHubCredentialTarget, type GitHubSecretMetadata } from './github-enrollment.js';
import {
  parseCredentialUsageSelection, renderCredentialUsageWorkflow, credentialWorkflowRunBinding, credentialUsageActionId,
  type CredentialUsageChallenge, type CredentialArtifactReference, type CredentialUsageProof
} from './credential-usage-challenge.js';
import { credentialArtifactName } from './credential-usage-report.js';
import { credentialPermissionBoundary, assertCredentialProviderPolicyPermitted, type CredentialProviderPermissionBoundary } from './credential-permissions.js';
import { assertLegacyCredentialEffectAdmission } from './credential-legacy-effects.js';

export interface CredentialUsageDispatchPlan {
  kind: 'github-credential-dispatch.v1';
  target: GitHubCredentialTarget;
  challenge: Omit<CredentialUsageChallenge, 'runId'>;
  expectedSecret: GitHubSecretMetadata;
  permissionBoundary: CredentialProviderPermissionBoundary;
  workflowDigest: string;
  maximumHostedMinutes: 5;
  effects: readonly ['stored-secret-use', 'installation-token-create', 'installation-token-revoke'];
}

export function credentialUsageOperationEffects(target: GitHubCredentialTarget): NonNullable<TransitionOperation['effects']> {
  if (target.configuration.kind !== 'github-app') fail();
  return [
    `/app/installations/${target.configuration.installationId}/access_tokens`,
    '/installation/token'
  ].map((endpoint) => ({
    mutationClass: 'github-write',
    destination: { type: 'repository', identity: `${target.repository}:${endpoint}`, repository: target.repository },
    remote: true, destructive: false
  }));
}

interface CredentialUsagePreparation {
  kind: 'github-credential-dispatch-prepared.v1';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  plan: CredentialUsageDispatchPlan;
  operationDigest: string;
  operation: TransitionOperation;
  savedPlanDigest: string;
  envelope: ApprovalEnvelope;
  preparedAt: string;
}

function key(target: GitHubCredentialTarget, challengeId: string, stage: string) {
  return canonicalSha256({ kind: 'github-credential-dispatch', repositoryId: target.repositoryId, challengeId, stage });
}

function fail(): never {
  throw new GitHubActivationError('credential-run-authority', 'The stored-secret run lacks its exact private pre-effect approval and provider-issued run binding.');
}

function storedOperation(value: unknown): ExternalOperationState {
  const operation = object(value);
  const keys = ['provider', 'actionId', 'operationId', 'resourceId', 'startedAt', 'observedAt', 'status', 'planDigest'];
  if (Object.keys(operation).length !== keys.length || keys.some((name) => !Object.hasOwn(operation, name)) ||
    operation.provider !== 'github' || operation.actionId !== credentialUsageActionId ||
    typeof operation.operationId !== 'string' || !/^[1-9][0-9]*$/u.test(operation.operationId) ||
    typeof operation.resourceId !== 'string' || typeof operation.startedAt !== 'string' ||
    typeof operation.observedAt !== 'string' || !Number.isFinite(Date.parse(operation.startedAt)) ||
    !Number.isFinite(Date.parse(operation.observedAt)) || Date.parse(operation.observedAt) < Date.parse(operation.startedAt) ||
    typeof operation.planDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(operation.planDigest) ||
    !['running', 'completed', 'failed'].includes(String(operation.status))) fail();
  return {
    provider: 'github', actionId: credentialUsageActionId, operationId: operation.operationId,
    resourceId: operation.resourceId, startedAt: operation.startedAt, observedAt: operation.observedAt,
    status: operation.status as ExternalOperationState['status'], planDigest: operation.planDigest
  };
}

async function identity(projectRoot: string) {
  const stat = await lstat(projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  return { projectRoot: await realpath(projectRoot),
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) } };
}

export function credentialUsageDispatchPlan(
  target: GitHubCredentialTarget, challenge: Omit<CredentialUsageChallenge, 'runId'>, expectedSecret: GitHubSecretMetadata
): CredentialUsageDispatchPlan {
  target = validateGitHubCredentialTarget(target);
  challenge = parseCredentialUsageSelection(challenge);
  if (challenge.runAttempt !== 1 || challenge.actorId !== target.actor.id || target.configuration.kind !== 'github-app') fail();
  return {
    kind: 'github-credential-dispatch.v1', target, challenge, expectedSecret: validateGitHubSecretMetadata(expectedSecret),
    permissionBoundary: credentialPermissionBoundary(target.metadata.observedPermissions),
    workflowDigest: renderCredentialUsageWorkflow(target, challenge.challengeId).digest,
    maximumHostedMinutes: 5, effects: ['stored-secret-use', 'installation-token-create', 'installation-token-revoke']
  };
}

/** Coordinator calls immediately before its shared real dispatch; this never sends a workflow request. */
export async function prepareCredentialUsageDispatch(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, client: GitHubActivationClient,
  storage?: UpdatePreviewOptions
): Promise<CredentialUsageDispatchPlan> {
  storage ??= input.adapters.githubActivation?.storage;
  const admissionInput = storage ? { ...input, adapters: { ...input.adapters,
    githubActivation: { ...input.adapters.githubActivation, storage } } } : input;
  await assertLegacyCredentialEffectAdmission(admissionInput);
  const value = object(operation.inputs.usage);
  const plan = credentialUsageDispatchPlan(value.target as GitHubCredentialTarget, value.challenge as CredentialUsageDispatchPlan['challenge'],
    validateGitHubSecretMetadata(value.expectedSecret));
  assertCredentialProviderPolicyPermitted(plan.target.metadata.observedPermissions);
  await assertCredentialAuthority(input, operation, storage);
  if (operation.actionId !== credentialUsageActionId || operation.mutationClass !== 'github-workflow-dispatch' ||
    operation.destination.repository !== plan.target.repository || canonicalSha256(value) !== canonicalSha256(plan) ||
    canonicalSha256(operation.inputs.workflow) !== canonicalSha256(credentialWorkflowRunBinding(plan.target, plan.challenge)) ||
    canonicalSha256(operation.inputs.dispatchInputs) !== canonicalSha256({ challenge: plan.challenge.challengeId }) ||
    canonicalSha256(operation.effects ?? []) !== canonicalSha256(credentialUsageOperationEffects(plan.target))) fail();
  const now = input.clock?.() ?? input.now;
  if (Date.parse(plan.challenge.notBefore) > now.getTime() || Date.parse(plan.challenge.expiresAt) <= now.getTime()) fail();
  if (canonicalSha256(await readGitHubSecretMetadata(client, plan.target.repository)) !== canonicalSha256(plan.expectedSecret)) {
    throw new GitHubActivationError('credential-secret-drift', 'The existing App secret metadata changed after review; no usage dispatch is authorized.');
  }
  const file = await readbackWorkflowContent(client, plan.target.repository, '.github/workflows/liftoff-credential-usage.yml', plan.challenge.sourceSha);
  if (file.digest !== plan.workflowDigest) fail();
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage);
  const preparedKey = key(plan.target, plan.challenge.challengeId, 'prepared');
  if (await store.read(preparedKey)) {
    const existing = await readPreparation(input, plan.target, plan.challenge.challengeId, storage);
    if (existing.operationDigest !== canonicalSha256(operation) || canonicalSha256(existing.plan) !== canonicalSha256(plan)) {
      throw new GitHubActivationError('credential-dispatch-uncertain', 'This credential challenge has a different retained pre-effect record. It cannot be replaced or redispatched.');
    }
    // Only the shared dispatcher decides whether this is readback-only recovery of its recorded effect.
    return plan;
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
  if (!envelope) fail();
  const record: CredentialUsagePreparation = {
    kind: 'github-credential-dispatch-prepared.v1', ...await identity(input.inspection.projectRoot),
    plan, operation, operationDigest: canonicalSha256(operation), savedPlanDigest: canonicalSha256(input.plan),
    envelope, preparedAt: now.toISOString()
  };
  await store.write(preparedKey, record);
  await input.lease!.assertHeld();
  return plan;
}

async function readPreparation(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, target: GitHubCredentialTarget, challengeId: string, storage?: UpdatePreviewOptions
): Promise<CredentialUsagePreparation> {
  storage ??= input.adapters?.githubActivation?.storage;
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .read(key(target, challengeId, 'prepared'));
  if (!record || !isRecord(record.value)) fail();
  const value = record.value as unknown as CredentialUsagePreparation;
  const current = await identity(input.inspection.projectRoot);
  if (Object.keys(value).sort().join(',') !== ['kind', 'projectRoot', 'projectIdentity', 'plan', 'operation', 'operationDigest', 'savedPlanDigest', 'envelope', 'preparedAt'].sort().join(',') ||
    value.kind !== 'github-credential-dispatch-prepared.v1' || value.projectRoot !== current.projectRoot ||
    record.projectRoot !== current.projectRoot || canonicalSha256(value.projectIdentity) !== canonicalSha256(current.projectIdentity) ||
    canonicalSha256(value.plan) !== canonicalSha256(credentialUsageDispatchPlan(value.plan.target, value.plan.challenge, value.plan.expectedSecret)) ||
    canonicalSha256(value.plan.target) !== canonicalSha256(target) || value.plan.challenge.challengeId !== challengeId ||
    !/^[a-f0-9]{64}$/u.test(value.operationDigest) || !/^[a-f0-9]{64}$/u.test(value.savedPlanDigest) ||
    value.operationDigest !== canonicalSha256(value.operation) || value.operation.actionId !== credentialUsageActionId ||
    !Number.isFinite(Date.parse(value.preparedAt)) || value.envelope.phaseId !== 'credential-ready' ||
    value.envelope.gateKind !== 'credential-enrollment' ||
    !value.envelope.operationDigests?.includes(value.operationDigest) ||
    Date.parse(value.envelope.approvedAt) > Date.parse(value.preparedAt) || Date.parse(value.envelope.expiresAt) <= Date.parse(value.preparedAt)) fail();
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, value.envelope, storage);
  return value;
}

export async function readCredentialUsageSecretPrecondition(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, target: GitHubCredentialTarget,
  challengeId: string, storage?: UpdatePreviewOptions
): Promise<GitHubSecretMetadata> {
  return (await readPreparation(input, target, challengeId, storage)).plan.expectedSecret;
}

async function sharedEffect(input: PhaseAdapterExecutionInput, prepared: CredentialUsagePreparation, storage?: UpdatePreviewOptions) {
  if (storage) input = { ...input, adapters: { ...input.adapters,
    githubActivation: { ...input.adapters.githubActivation, ...{ storage } } } };
  const plan = prepared.plan;
  const workflow = credentialWorkflowRunBinding(plan.target, plan.challenge);
  const effect = await readWorkflowEffect(input, prepared.operation, {
    repositoryId: plan.target.repositoryId, ref: `${plan.challenge.ref}:${plan.challenge.workflowId}`,
    purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow, dispatchInputs: { challenge: plan.challenge.challengeId } });
  if (!effect?.observed?.providerId || effect.prepared.operationDigest !== prepared.operationDigest) fail();
  return effect;
}

/** Persist the real provider result once, after independent exact run readback; no receipt rewriting. */
export async function recordCredentialUsageDispatch(
  input: PhaseAdapterExecutionInput, plan: CredentialUsageDispatchPlan, client: GitHubActivationClient,
  result: { operation: ExternalOperationState; providerRequestId: string | null; correlationId: string }, storage?: UpdatePreviewOptions
): Promise<CredentialUsageChallenge> {
  storage ??= input.adapters.githubActivation?.storage;
  const originalOperation = storedOperation(result.operation);
  const prepared = await readPreparation(input, plan.target, plan.challenge.challengeId, storage);
  if (canonicalSha256(prepared.plan) !== canonicalSha256(plan)) fail();
  const effect = await sharedEffect(input, prepared, storage);
  if (effect.prepared.correlationId !== result.correlationId || effect.observed!.providerId !== originalOperation.operationId ||
    (effect.response?.requestId ?? null) !== result.providerRequestId || originalOperation.actionId !== credentialUsageActionId ||
    originalOperation.planDigest !== effect.prepared.planDigest || originalOperation.startedAt !== effect.prepared.preparedAt) fail();
  const dispatchEnvelope = input.inspection.approvals.find((envelope) =>
    canonicalApprovalEnvelopeHash(envelope) === effect.prepared.approvalEnvelopeHash);
  if (!dispatchEnvelope) fail();
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, dispatchEnvelope, storage);
  const runId = positiveId(Number(originalOperation.operationId));
  if (originalOperation.resourceId !== `/repos/${plan.target.repository}/actions/runs/${runId}`) fail();
  const run = await client.get(`${originalOperation.resourceId}/attempts/1`);
  if (run.id !== runId || run.run_attempt !== 1 || run.workflow_id !== plan.challenge.workflowId ||
    run.head_sha !== plan.challenge.sourceSha || run.head_branch !== plan.challenge.ref ||
    run.event !== 'workflow_dispatch' || object(run.repository).id !== plan.target.repositoryId ||
    object(run.actor).id !== plan.challenge.actorId || object(run.triggering_actor).id !== plan.challenge.actorId ||
    run.display_title !== `liftoff-${result.correlationId}` ||
    typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at)) ||
    Date.parse(run.created_at) < Date.parse(prepared.preparedAt)) fail();
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage);
  const submittedKey = key(plan.target, plan.challenge.challengeId, 'submitted');
  if (await store.read(submittedKey)) {
    await assertCredentialUsageIssued(input, plan.target, { ...plan.challenge, runId }, storage);
    return { ...plan.challenge, runId };
  }
  await store.write(submittedKey, {
      kind: 'github-credential-dispatch-submitted.v1', preparedDigest: canonicalSha256(prepared),
      sharedPreparedDigest: canonicalSha256(effect.prepared), dispatchEnvelope,
      runId, runAttempt: 1, correlationId: result.correlationId, operation: originalOperation,
      providerRequestId: result.providerRequestId === null ? null : githubProviderRequestId(result.providerRequestId)
    });
  return { ...plan.challenge, runId };
}

export async function assertCredentialUsageIssued(
  input: PhaseAdapterExecutionInput, target: GitHubCredentialTarget, challenge: CredentialUsageChallenge, storage?: UpdatePreviewOptions
): Promise<{ correlationId: string; providerRequestId: string | null; operation: ExternalOperationState; expectedSecret: GitHubSecretMetadata }> {
  storage ??= input.adapters.githubActivation?.storage;
  const prepared = await readPreparation(input, target, challenge.challengeId, storage);
  const effect = await sharedEffect(input, prepared, storage);
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .read(key(target, challenge.challengeId, 'submitted'));
  if (!record || !isRecord(record.value)) fail();
  const s = record.value;
  if (Object.keys(s).sort().join(',') !== ['kind', 'preparedDigest', 'sharedPreparedDigest', 'dispatchEnvelope', 'runId', 'runAttempt', 'providerRequestId', 'correlationId', 'operation'].sort().join(',') ||
    s.kind !== 'github-credential-dispatch-submitted.v1' || s.preparedDigest !== canonicalSha256(prepared) ||
    canonicalSha256({ ...prepared.plan.challenge, runId: s.runId }) !== canonicalSha256(challenge) ||
    s.runAttempt !== challenge.runAttempt || s.sharedPreparedDigest !== canonicalSha256(effect.prepared) ||
    effect.observed!.providerId !== String(challenge.runId) || s.correlationId !== effect.prepared.correlationId ||
    s.providerRequestId !== (effect.response?.requestId ?? null)) fail();
  const envelope = s.dispatchEnvelope as ApprovalEnvelope;
  if (canonicalApprovalEnvelopeHash(envelope) !== effect.prepared.approvalEnvelopeHash ||
    envelope.phaseId !== 'credential-ready' || !envelope.operationDigests?.includes(prepared.operationDigest) ||
    Date.parse(envelope.approvedAt) > Date.parse(effect.prepared.preparedAt) ||
    Date.parse(envelope.expiresAt) <= Date.parse(effect.prepared.preparedAt)) fail();
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, storage);
  if (typeof s.correlationId !== 'string' || !/^[a-f0-9-]{36}$/u.test(s.correlationId)) fail();
  const operation = storedOperation(s.operation);
  if (operation.actionId !== credentialUsageActionId || operation.provider !== 'github' ||
    operation.operationId !== String(challenge.runId) || operation.planDigest !== effect.prepared.planDigest ||
    operation.startedAt !== effect.prepared.preparedAt ||
    operation.resourceId !== `/repos/${target.repository}/actions/runs/${challenge.runId}`) fail();
  return { correlationId: s.correlationId, operation, expectedSecret: prepared.plan.expectedSecret,
    providerRequestId: s.providerRequestId === null ? null : githubProviderRequestId(s.providerRequestId) };
}

export async function recordCredentialUsageArtifact(
  input: PhaseAdapterExecutionInput, target: GitHubCredentialTarget, challenge: CredentialUsageChallenge,
  proof: CredentialUsageProof, storage?: UpdatePreviewOptions
): Promise<void> {
  storage ??= input.adapters.githubActivation?.storage;
  const issued = await assertCredentialUsageIssued(input, target, challenge, storage);
  if (proof.runId !== challenge.runId || proof.challengeId !== challenge.challengeId ||
    proof.artifact.name !== credentialArtifactName(challenge.challengeId, challenge.runAttempt) ||
    proof.artifact.reportDigest !== canonicalSha256(proof.report) || proof.report.correlationId !== issued.correlationId) fail();
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .write(key(target, challenge.challengeId, 'artifact'), {
      kind: 'github-credential-artifact.v1', ...await identity(input.inspection.projectRoot),
      targetDigest: canonicalSha256(target), challenge, operationDigest: canonicalSha256(issued.operation), artifact: proof.artifact
    });
}

export async function readCredentialArtifactReference(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, target: GitHubCredentialTarget,
  challenge: CredentialUsageChallenge, storage?: UpdatePreviewOptions
): Promise<CredentialArtifactReference> {
  storage ??= input.adapters?.githubActivation?.storage;
  const row = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .read(key(target, challenge.challengeId, 'artifact'));
  if (!row || !isRecord(row.value)) fail();
  const value = row.value;
  const expected = await identity(input.inspection.projectRoot);
  if (Object.keys(value).sort().join(',') !== ['kind', 'projectRoot', 'projectIdentity', 'targetDigest', 'challenge', 'operationDigest', 'artifact'].sort().join(',') ||
    value.kind !== 'github-credential-artifact.v1' || value.projectRoot !== expected.projectRoot ||
    canonicalSha256(value.projectIdentity) !== canonicalSha256(expected.projectIdentity) ||
    value.targetDigest !== canonicalSha256(target) || canonicalSha256(value.challenge) !== canonicalSha256(challenge) ||
    typeof value.operationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.operationDigest)) fail();
  const artifact = object(value.artifact);
  if (Object.keys(artifact).sort().join(',') !== 'id,name,reportDigest,zipDigest' ||
    artifact.name !== credentialArtifactName(challenge.challengeId, challenge.runAttempt) ||
    typeof artifact.zipDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.zipDigest) ||
    typeof artifact.reportDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.reportDigest)) fail();
  return { id: positiveId(artifact.id), name: artifact.name, zipDigest: artifact.zipDigest, reportDigest: artifact.reportDigest };
}
