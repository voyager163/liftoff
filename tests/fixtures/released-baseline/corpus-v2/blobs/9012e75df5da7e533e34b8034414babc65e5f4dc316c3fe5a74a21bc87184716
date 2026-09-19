import type {
  SavedTransitionPlan, UserActivationState, PhaseGraphNode, TransitionOperation, EvidenceHeader,
  LiveReadbackProof, PhaseId, PhaseEvidenceRecord
} from '../domain/governance/activation/types.js';
import { phaseScope, type ExternalOperationState, type PhaseOutputBindings, type InputTransitionBinding } from '../domain/governance/activation/types.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import { detectCredentialLeaks } from './credentials.js';
import { canonicalJson, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { validateSavedTransitionPlan, validateEvidenceHeader, validateUserActivationState } from '../domain/governance/activation/validators.js';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import {
  applyProjectFileTransaction, type ProjectFileSnapshot, captureProjectFileSnapshot, type ProjectFileMutation
} from '../adapters/filesystem/project-transaction.js';
import type { GovernanceTransitionInspection, ApplyNextExecutionResult, PhaseAdapterExecutionInput } from './transition-ports.js';
import { phaseContractDigests } from '../domain/governance/activation/graph.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../domain/governance/activation/evidence.js';
import { remoteBindingDigest } from '../domain/governance/activation/inputs.js';
import { stateWithSelectedActiveChange } from './source-of-truth.js';
import { activationStateContentHash } from './activation-state.js';
import { randomUUID } from 'node:crypto';
import {
  uniqueTaskWritePreconditions, validatePreparedTaskProjection, type PreparedGovernanceTaskProjection
} from './task-writes.js';

export const governancePlanDirectoryPathParts = ['governance', 'plans'] as const;
const engineProducer = 'liftoff-governance-transition-engine';

export function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '');
}

export function transitionPlanPathParts(plan: SavedTransitionPlan): string[] {
  return validateArtifactPathParts([
    ...governancePlanDirectoryPathParts,
    `${plan.phaseId}-${safeTimestamp(plan.createdAt)}-${plan.planDigest.slice(0, 12)}.json`
  ], 'Governance transition plan path');
}

export function evidencePathParts(evidenceId: string): string[] {
  return validateArtifactPathParts(['governance', 'evidence', `${evidenceId}.json`], 'Governance evidence path');
}

export function activationStatePathParts(): string[] {
  return validateArtifactPathParts(['governance', 'activation-state.json'], 'Activation state path');
}

export function cloneState(state: UserActivationState): UserActivationState {
  return JSON.parse(JSON.stringify(state)) as UserActivationState;
}

export async function initializeExecutionAnchor(inspection: GovernanceTransitionInspection, now: Date): Promise<void> {
  const state = cloneState(inspection.state);
  state.repository.id = `local:${randomUUID()}`;
  if (inspection.contexts?.['seed-valid']?.baselineSha) {
    state.baselineAnchor = inspection.contexts['seed-valid'].baselineSha;
  }
  if (inspection.activationInputs) state.activationInputs = inspection.activationInputs;
  state.createdAt = now.toISOString();
  state.updatedAt = state.createdAt;
  const pathParts = activationStatePathParts();
  await applyProjectFileTransaction(inspection.projectRoot, [{
    type: 'write', pathParts, content: `${canonicalJson(validateUserActivationState(state))}\n`
  }], { preconditions: [{ pathParts }] });
}

export function evidenceWriteOperation(phase: PhaseGraphNode, pathParts: readonly string[]): TransitionOperation {
  return operation({
    adapter: 'local-evidence',
    actionId: 'governance.evidence.write',
    mutationClass: 'write-evidence',
    phaseId: phase.id,
    inputs: { pathParts },
    destination: transitionDestination('local', pathParts.join('/'), { pathParts }),
    remote: false,
    destructive: false
  });
}

export function stateWriteOperation(phase: PhaseGraphNode): TransitionOperation {
  return operation({
    adapter: 'local-evidence',
    actionId: 'governance.activation-state.write',
    mutationClass: 'write-activation-state',
    phaseId: phase.id,
    inputs: { pathParts: activationStatePathParts() },
    destination: transitionDestination('local', 'governance/activation-state.json', { pathParts: activationStatePathParts() }),
    remote: false,
    destructive: false
  });
}

export function assertNoSecrets(plan: SavedTransitionPlan): void {
  const scan = detectCredentialLeaks([{
    source: 'generated-artifact',
    label: 'governance transition plan',
    text: canonicalJson(plan)
  }]);
  if (scan.status === 'compromised') {
    throw new Error(`Governance transition plan contains credential-shaped content: ${scan.leaks.map((leak) => leak.pattern).join(', ')}.`);
  }
}

export async function saveTransitionPlan(projectRoot: string, plan: SavedTransitionPlan): Promise<{
  pathParts: readonly string[];
  digest: string;
}> {
  const validated = validateSavedTransitionPlan(plan);
  assertNoSecrets(validated);
  const pathParts = transitionPlanPathParts(validated);
  const existing = await readProjectFile(projectRoot, pathParts);
  if (existing !== undefined) {
    if (existing.toString('utf8') === `${canonicalJson(validated)}\n`) {
      return { pathParts, digest: canonicalSha256(validated) };
    }
    throw new Error(`Refusing to overwrite existing governance transition plan ${pathParts.join('/')}.`);
  }
  const content = `${canonicalJson(validated)}\n`;
  await applyProjectFileTransaction(projectRoot, [{ type: 'write', pathParts, content }], {
    preconditions: [{ pathParts: [...pathParts] }]
  });
  return { pathParts, digest: canonicalSha256(validated) };
}

export function evidenceHeaderFor(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  result: EvidenceHeader['result'];
  now: Date;
  payload?: unknown;
  liveReadback?: readonly LiveReadbackProof[];
  afterInputDigest?: string;
  gitBinding?: InputTransitionBinding['git'];
}): EvidenceHeader {
  const context = input.inspection.contexts[input.phase.id];
  return validateEvidenceHeader({
    schemaVersion: input.inspection.state.identity.evidenceHeaderSchemaVersion,
    repositoryId: input.inspection.state.repository.id,
    identity: input.inspection.state.identity,
    phaseGraphHash: input.inspection.state.identity.phaseGraphHash,
    phaseId: input.phase.id,
    phaseContractDigest: phaseContractDigests(input.inspection.graph)[input.phase.id],
    inputDigest: (input.plan.fileChanges?.length || input.gitBinding)
      ? (input.afterInputDigest ?? input.plan.inputDigest)
      : input.plan.inputDigest,
    baselineSha: input.plan.baselineDigest,
    transition: context.transition,
    producedAt: input.now.toISOString(),
    producer: engineProducer,
    bodyDigest: evidenceBodyDigest(input.payload, input.liveReadback),
    scope: phaseScope(input.phase.id),
    ...(input.plan.fileChanges?.length || input.gitBinding ? {
      inputBindings: {
        beforeDigest: input.plan.inputDigest,
        afterDigest: input.afterInputDigest ?? input.plan.inputDigest,
        files: input.plan.fileChanges ?? [],
        ...(input.gitBinding ? { git: input.gitBinding } : {})
      }
    } : {}),
    ...(input.inspection.state.remoteBinding && !input.phase.id.startsWith('seed-') && input.phase.id !== 'committed' ? {
      remoteBindingDigest: remoteBindingDigest(input.inspection.state.remoteBinding)
    } : {}),
    result: input.result
  });
}

function appendUnique(values: readonly string[], value: string | null): string[] {
  return value === null || values.includes(value) ? [...values] : [...values, value];
}

export function nextStateForOutcome(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  resultState: EvidenceHeader['result'] | 'approved' | 'running';
  evidenceReference?: UserActivationState['phases'][PhaseId]['evidence'][number];
  blocker?: string;
  override?: UserActivationState;
  now: Date;
  operation?: ExternalOperationState;
  outputs?: PhaseOutputBindings;
}): UserActivationState {
  const base = cloneState(input.override ?? input.inspection.state);
  if (input.inspection.sourceOfTruth.status === 'selected' && input.inspection.sourceOfTruth.recordActiveChangeOnNextMutation) {
    const selected = stateWithSelectedActiveChange(base, input.inspection.sourceOfTruth.selected);
    base.activeChange = selected.activeChange;
  }
  const phaseState = input.resultState === 'approved' ? 'approved' : input.resultState;
  base.phases[input.phase.id] = {
    state: phaseState,
    updatedAt: input.now.toISOString(),
    evidence: input.evidenceReference ? [...base.phases[input.phase.id].evidence, input.evidenceReference] : base.phases[input.phase.id].evidence,
    approvals: appendUnique(base.phases[input.phase.id].approvals, input.plan.approval.envelopeId),
    blockers: input.blocker ? [input.blocker] : [],
    executionPlanDigest: input.plan.planDigest,
    ...(input.operation ? { operation: input.operation } : {})
  };
  if (!base.baselineAnchor) base.baselineAnchor = input.plan.baselineDigest;
  if (input.plan.configuration) base.activationInputs = input.plan.configuration;
  if (input.outputs) base.phaseOutputs = { ...base.phaseOutputs, [input.phase.id]: input.outputs };
  base.updatedAt = input.now.toISOString();
  return validateUserActivationState(base);
}

export function blockedState(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  blocker: string;
  now: Date;
  operation?: ExternalOperationState;
  executionStarted?: boolean;
}): UserActivationState {
  const base = cloneState(input.inspection.state);
  base.phases[input.phase.id] = {
    state: 'blocked',
    updatedAt: input.now.toISOString(),
    evidence: base.phases[input.phase.id].evidence,
    approvals: appendUnique(base.phases[input.phase.id].approvals, input.plan.approval.envelopeId),
    blockers: [input.blocker],
    ...(input.executionStarted || base.phases[input.phase.id].executionPlanDigest
      ? { executionPlanDigest: input.plan.planDigest } : {}),
    ...(input.operation ?? base.phases[input.phase.id].operation
      ? { operation: input.operation ?? base.phases[input.phase.id].operation } : {})
  };
  base.updatedAt = input.now.toISOString();
  return validateUserActivationState(base);
}

async function assertLoadedStateHash(projectRoot: string, expectedHash: string | null): Promise<ProjectFileSnapshot> {
  const snapshot = await captureProjectFileSnapshot(projectRoot, activationStatePathParts());
  const currentHash = snapshot.content === undefined ? null : activationStateContentHash(snapshot.content);
  if (currentHash !== expectedHash) {
    throw new Error(`Activation state changed after inspection: expected ${expectedHash ?? 'absent'}, found ${currentHash ?? 'absent'}.`);
  }
  return snapshot;
}

export async function writeOutcomeTransaction(input: {
  projectRoot: string;
  plan: SavedTransitionPlan;
  nextState: UserActivationState;
  evidenceRecord?: PhaseEvidenceRecord;
  evidencePathParts?: readonly string[];
  fileMutations?: readonly ProjectFileMutation[];
  filePreconditions?: readonly ProjectFileSnapshot[];
  expectedStateHash?: string | null;
  taskProjection?: PreparedGovernanceTaskProjection;
}): Promise<{ stateHash: string; evidence: ApplyNextExecutionResult['evidence'] }> {
  if (input.evidenceRecord) {
    const scan = detectCredentialLeaks([{
      source: 'imported-evidence',
      label: input.evidencePathParts?.join('/') ?? 'governance evidence',
      text: canonicalJson(input.evidenceRecord)
    }]);
    if (scan.status === 'compromised') {
      throw new Error(`Governance evidence contains credential-shaped content: ${scan.leaks.map((leak) => leak.pattern).join(', ')}.`);
    }
  }
  const statePrecondition = await assertLoadedStateHash(
    input.projectRoot, input.expectedStateHash === undefined ? input.plan.stateHash : input.expectedStateHash
  );
  if (input.taskProjection) {
    validatePreparedTaskProjection(input.plan, input.nextState, input.taskProjection);
    if (input.fileMutations?.some((mutation) =>
      mutation.pathParts.join('/') === input.taskProjection!.record.taskPathParts.join('/'))) {
      throw new Error('Generic source writes cannot overlap the derived current-task projection.');
    }
  }
  const stateContent = `${canonicalJson(validateUserActivationState(input.nextState))}\n`;
  const stateScan = detectCredentialLeaks([{ source: 'generated-artifact', label: 'activation state', text: stateContent }]);
  if (stateScan.status === 'compromised') throw new Error('Activation state contains credential-shaped content; the private execution checkpoint was preserved.');
  const mutations: ProjectFileMutation[] = [
    ...(input.fileMutations ?? []).map((mutation) => ({
      ...mutation,
      pathParts: validateArtifactPathParts([...mutation.pathParts], 'Governance transition file mutation path')
    })),
    ...(input.taskProjection?.mutation ? [input.taskProjection.mutation] : []),
    ...(input.evidenceRecord && input.evidencePathParts ? [{
      type: 'write' as const,
      pathParts: [...input.evidencePathParts],
      content: `${canonicalJson(input.evidenceRecord)}\n`
    }] : []),
    { type: 'write', pathParts: activationStatePathParts(), content: stateContent }
  ];
  if (input.evidencePathParts) {
    const existing = await readProjectFile(input.projectRoot, [...input.evidencePathParts]);
    if (existing !== undefined) throw new Error(`Refusing to overwrite existing governance evidence ${input.evidencePathParts.join('/')}.`);
  }
  await applyProjectFileTransaction(input.projectRoot, mutations, {
    preconditions: uniqueTaskWritePreconditions([
      statePrecondition, ...(input.filePreconditions ?? []),
      ...(input.taskProjection ? [input.taskProjection.source.taskBefore, input.taskProjection.source.metadataBefore] : []),
      ...(input.evidencePathParts ? [{ pathParts: [...input.evidencePathParts] }] : [])
    ])
  });
  return {
    stateHash: activationStateContentHash(stateContent),
    evidence: input.evidenceRecord && input.evidencePathParts ? {
      evidenceId: input.evidenceRecord.evidenceId,
      pathParts: input.evidencePathParts,
      headerDigest: evidenceHeaderDigest(input.evidenceRecord.header),
      result: input.evidenceRecord.header.result
    } : null
  };
}

export function readbackProof(
  input: PhaseAdapterExecutionInput,
  provider: LiveReadbackProof['provider'],
  resourceType: string,
  resourceId: string,
  observed: unknown
): LiveReadbackProof {
  const context = input.inspection.contexts[input.phase.id];
  const digest = canonicalSha256(observed);
  return {
    schemaVersion: context.identity.evidenceHeaderSchemaVersion, repositoryId: context.repositoryId,
    identity: context.identity, phaseGraphHash: context.phaseGraphHash, phaseId: input.phase.id,
    baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
    observedAt: input.now.toISOString(), provider, resourceType, resourceId,
    sourceDigest: digest, readbackDigest: digest, matches: true
  };
}
