import type { Stats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash, savedPlanAuthorityDigest } from '../../domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { planDigestFor } from '../../domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { transitionPlanPathParts } from '../../governance-activation/transition-records.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { currentProjectMutationLease } from '../filesystem/project-lock.js';
import { resolveProjectPath } from '../filesystem/project-paths.js';
import { createScopedUserLocalRecordStore } from '../filesystem/update-previews.js';
import { observedFileStamp, readObservedFile } from '../filesystem/observed-file.js';
import { GitHubActivationError, object } from '../github/activation-rest.js';
import { validateWorkflowRunBinding, type WorkflowRunBinding } from '../github/workflow-dispatch.js';
import { readWorkflowEffect } from '../../application/repository-governance/workflow-checkpoints.js';
import { githubProviderRequestId } from './credential-checkpoints.js';

/** Diagnostic selector only. This is deliberately not a registered execution alias. */
export const legacyCredentialChallengeActionId = 'github.credential.challenge';
const planDirectory = ['governance', 'plans'];
const maximumPlanEntries = 256;
const maximumPlanBytes = 256 * 1024;
const maximumInventoryBytes = 4 * 1024 * 1024;
const maximumLegacyOperations = 32;

export interface LegacyCredentialEffect {
  actionId: typeof legacyCredentialChallengeActionId;
  originalPlanDigest: string;
  originalOperationDigest: string;
  originalPlanPathParts: readonly string[];
  originalApprovalEnvelopeHash: string;
  preparedAt: string;
  outcome: 'prepared-unknown' | 'response-recorded' | 'provider-run-recorded';
  providerOperationId: string | null;
  providerRequestId: string | null;
}

function invalid(): never {
  throw new GitHubActivationError('credential-legacy-record-invalid',
    'Original credential challenge plan/checkpoint identity is missing, unsupported, changed or inconsistent. Preserve the original records and resolve their recovery boundary; no new usage-challenge is authorized.');
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sameFile(left: Stats, right: Stats): boolean {
  return observedFileStamp(left) === observedFileStamp(right) && left.birthtimeMs === right.birthtimeMs;
}

async function planNames(projectRoot: string): Promise<string[] | null> {
  const directory = await resolveProjectPath(projectRoot, planDirectory);
  let stat;
  try { stat = await lstat(directory); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const names: string[] = [];
  let count = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (++count > maximumPlanEntries) {
      throw new GitHubActivationError('credential-legacy-plan-limit',
        'The original saved-plan inventory exceeds the 256-entry credential admission bound. Preserve it and resolve the recorded legacy scope; no private-store sweep or new dispatch is permitted.');
    }
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !/^[A-Za-z0-9_.-]{1,200}\.json$/u.test(entry.name)) invalid();
    names.push(entry.name);
  }
  if (!sameFile(stat, await lstat(directory))) invalid();
  return names.sort();
}

async function readPlan(
  projectRoot: string, name: string, remainingBytes: number
): Promise<{ value: unknown; size: number; stat: Stats }> {
  const parts = [...planDirectory, name];
  const file = await resolveProjectPath(projectRoot, parts);
  const { content, metadata } = await readObservedFile(file, {
    maximumBytes: Math.min(maximumPlanBytes, remainingBytes),
    assertPathCurrent: () => resolveProjectPath(projectRoot, parts)
  });
  try {
    if (!content.length || !isUtf8(content)) invalid();
    const text = content.toString('utf8');
    if (detectCredentialLeaks([{ source: 'imported-evidence', label: 'original credential plan', text }]).status !== 'clear') invalid();
    try { return { value: JSON.parse(text), size: content.length, stat: metadata }; } catch { invalid(); }
  } finally { content.fill(0); }
}

function originalWorkflow(operation: TransitionOperation): {
  workflow: WorkflowRunBinding; dispatchInputs: Record<string, string>;
} {
  if (operation.actionId !== legacyCredentialChallengeActionId || operation.phaseId !== 'credential-ready' ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-workflow-dispatch' ||
    !operation.remote || operation.destructive) invalid();
  const raw = object(operation.inputs.workflow);
  validateWorkflowRunBinding(raw as unknown as WorkflowRunBinding);
  const workflow = raw as unknown as WorkflowRunBinding;
  if (workflow.event !== 'workflow_dispatch' || workflow.runAttempt !== 1 ||
    operation.destination.type !== 'repository' || operation.destination.repository !== workflow.repository) invalid();
  const inputs = object(operation.inputs.dispatchInputs);
  if (Object.keys(inputs).length > 24 || Object.hasOwn(inputs, 'liftoff_operation_id') ||
    Object.entries(inputs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(key) ||
      typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value))) invalid();
  return { workflow, dispatchInputs: inputs as Record<string, string> };
}

/**
 * Reads only original project saved plans and the exact private keys derived from their original
 * operations. It never searches private-store directories, manufactures an old operation, or writes a record.
 */
async function readLegacyCredentialEffects(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Promise<readonly LegacyCredentialEffect[]> {
  if (input.phase.id !== 'credential-ready') invalid();
  const projectRoot = input.inspection.projectRoot;
  const names = await planNames(projectRoot);
  const legacyState = input.inspection.state.phases['credential-ready'].operation?.actionId === legacyCredentialChallengeActionId;
  const result: LegacyCredentialEffect[] = [];
  let total = 0;
  const snapshots: Array<{ name: string; stat: Stats }> = [];
  const retained: Array<{ plan: SavedTransitionPlan; pathParts: string[] }> = [];
  for (const name of names ?? []) {
    const { value, size, stat } = await readPlan(projectRoot, name, maximumInventoryBytes - total);
    snapshots.push({ name, stat });
    if ((total += size) > maximumInventoryBytes) invalid();
    if (!isRecord(value) || !Array.isArray(value.operations)) invalid();
    const hasLegacyAction = value.operations.some((entry) => isRecord(entry) && entry.actionId === legacyCredentialChallengeActionId);
    if (!hasLegacyAction && value.phaseId !== 'credential-ready' && !name.startsWith('credential-ready-')) continue;
    const plan = validateSavedTransitionPlan(value);
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'credential-ready')!;
    if (plan.phaseId !== phase.id || plan.scope !== 'activation' || (plan.selectionScope ?? 'activation') !== 'activation' ||
      canonicalSha256(transitionPlanPathParts(plan)) !== canonicalSha256([...planDirectory, name]) ||
      plan.planDigest !== planDigestFor({
        phase, transitionDigest: plan.transitionDigest, operations: plan.operations,
        approvalPlanDigest: savedPlanAuthorityDigest(plan, phase)
      })) invalid();
    if (hasLegacyAction) retained.push({ plan, pathParts: [...planDirectory, name] });
  }
  const inspected = new Set<string>();
  for (const { plan } of retained) {
    for (const operation of plan.operations.filter((entry) => entry.actionId === legacyCredentialChallengeActionId)) {
      const operationDigest = canonicalSha256(operation);
      if (inspected.has(operationDigest)) continue;
      if (inspected.size >= maximumLegacyOperations) invalid();
      inspected.add(operationDigest);
      const payload = originalWorkflow(operation);
      // The shared reader needs an execution-shaped context, but this contains the ORIGINAL saved plan and is read-only.
      const readerInput: PhaseAdapterExecutionInput = { ...input, plan, adapters: input.adapters ?? {} };
      const checkpoint = await readWorkflowEffect(readerInput, operation, {
        repositoryId: payload.workflow.repositoryId, ref: `${payload.workflow.ref}:${payload.workflow.workflowId}`,
        purpose: 'workflow-dispatch', step: 'dispatch'
      }, payload);
      if (!checkpoint) continue;
      const prepared = checkpoint.prepared;
      const originals = retained.filter((entry) =>
        entry.plan.planDigest === prepared.planDigest && entry.plan.approval.envelopeHash === prepared.approvalEnvelopeHash &&
        entry.plan.operations.some((candidate) => canonicalSha256(candidate) === operationDigest) &&
        Date.parse(prepared.preparedAt) >= Date.parse(entry.plan.createdAt) && Date.parse(prepared.preparedAt) < Date.parse(entry.plan.expiresAt));
      if (originals.length !== 1) invalid();
      const original = originals[0]!;
      const authority = await createScopedUserLocalRecordStore(projectRoot, 'governance-approval', githubPorts(input).storage)
        .read(prepared.approvalEnvelopeHash);
      if (!authority || !isRecord(authority.value)) invalid();
      const envelope = validateApprovalEnvelope(authority.value.envelope);
      if (canonicalApprovalEnvelopeHash(envelope) !== prepared.approvalEnvelopeHash || envelope.id !== original.plan.approval.envelopeId ||
        envelope.phaseId !== 'credential-ready' || envelope.gateKind !== 'credential-enrollment' ||
        envelope.planDigest !== savedPlanAuthorityDigest(original.plan, input.phase) ||
        !envelope.operationDigests?.includes(canonicalSha256(operation)) ||
        Date.parse(envelope.approvedAt) > Date.parse(prepared.preparedAt) ||
        Date.parse(envelope.expiresAt) <= Date.parse(prepared.preparedAt)) invalid();
      await assertGovernanceApprovalIssued(projectRoot, envelope, githubPorts(input).storage);
      const recorded = checkpoint.observed ?? checkpoint.response;
      if (recorded?.providerId && (!/^[1-9][0-9]*$/u.test(recorded.providerId) ||
        !Number.isSafeInteger(Number(recorded.providerId)) ||
        recorded.resourceId !== `/repos/${payload.workflow.repository}/actions/runs/${recorded.providerId}`)) invalid();
      const requestId = checkpoint.response?.requestId === null || checkpoint.response?.requestId === undefined
        ? null : githubProviderRequestId(checkpoint.response.requestId);
      if (requestId === prepared.correlationId) invalid();
      result.push({
        actionId: legacyCredentialChallengeActionId, originalPlanDigest: original.plan.planDigest,
        originalOperationDigest: operationDigest, originalPlanPathParts: original.pathParts,
        originalApprovalEnvelopeHash: prepared.approvalEnvelopeHash, preparedAt: prepared.preparedAt,
        outcome: checkpoint.observed ? 'provider-run-recorded' : checkpoint.response ? 'response-recorded' : 'prepared-unknown',
        providerOperationId: recorded?.providerId ?? null, providerRequestId: requestId
      });
    }
  }
  if (canonicalSha256(names) !== canonicalSha256(await planNames(projectRoot))) invalid();
  for (const snapshot of snapshots) {
    if (!sameFile(snapshot.stat, await lstat(await resolveProjectPath(projectRoot, [...planDirectory, snapshot.name])))) invalid();
  }
  const knownLegacyPlans = input.inspection.contexts['credential-ready'].reviewedPlans?.filter((plan) =>
    plan.operations.some((operation) => operation.actionId === legacyCredentialChallengeActionId)) ?? [];
  if (knownLegacyPlans.some((known) => !retained.some((entry) => canonicalSha256(entry.plan) === canonicalSha256(known)))) invalid();
  if (legacyState && !result.length) invalid();
  return result;
}

export async function inspectLegacyCredentialEffects(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Promise<readonly LegacyCredentialEffect[]> {
  try { return await readLegacyCredentialEffects(input); }
  catch (error) {
    if (error instanceof GitHubActivationError && error.code.startsWith('credential-legacy-')) throw error;
    invalid();
  }
}

export async function assertLegacyCredentialEffectAdmission(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Promise<void> {
  if ('plan' in input) {
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    if (!input.lease || !held) {
      throw new GitHubActivationError('credential-legacy-lease', 'Legacy credential effect admission requires the actual cooperating project lease before new execution.');
    }
    await held.assertHeld();
    await input.lease.assertHeld();
  }
  const effects = await inspectLegacyCredentialEffects(input);
  if ('plan' in input) await input.lease!.assertHeld();
  if (effects.length) {
    throw new GitHubActivationError('credential-legacy-effect',
      `Retained ${legacyCredentialChallengeActionId} effect exists in original plan ${effects[0]!.originalPlanDigest}. ` +
      'Legacy execution is not registered. Resolve the original plan/private checkpoints through separately reviewed recovery; a new action name, nonce, target, or approval cannot establish absence of the prior POST.');
  }
}
