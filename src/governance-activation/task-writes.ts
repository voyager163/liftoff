import { canonicalSha256, sha256Hex } from '../domain/governance/activation/canonical-json.js';
import {
  phaseIds, type GovernanceTaskProjectionContract, type GovernanceTaskProjectionRecord,
  type PhaseEvidenceRecord, type PhaseGraphNode, type SavedTransitionPlan,
  type TransitionOperation, type UserActivationState
} from '../domain/governance/activation/types.js';
import {
  validateApprovalEnvelope, validateGovernanceTaskProjectionContract, validateGovernanceTaskProjectionRecord
} from '../domain/governance/activation/validators.js';
import { calculatePhaseReadiness } from '../domain/governance/activation/readiness.js';
import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { governanceTaskProjectionAction, taskProjectionContract } from '../domain/governance/activation/operations.js';
import {
  type ProjectFileMutation, type ProjectFileSnapshot
} from '../adapters/filesystem/project-transaction.js';
import type { GovernanceTransitionInspection } from './transition-ports.js';
import {
  buildApprovedPhase0FactsFromState, renderGovernanceChangeWritePlan, validateGovernanceChangeMetadata,
  type GovernanceChangeMetadata, type GovernanceChangeWritePlan
} from './source-of-truth.js';
import { governanceTaskLayoutHash, projectGovernanceChangeTasks } from './task-projection.js';
import {
  activationEvidenceContexts, activationInputPathIsObserved, isSensitiveActivationPath,
  protectedLocalInputBlockers, type ActivationInputSnapshot
} from './inputs.js';
import { discoverGeneratedSeed, inspectArchivedSeedIntegrity, seedInfrastructureBaselineBlocker } from './seed-lifecycle.js';
import { captureHistoryFile, historicalActiveRecordPaths } from './historical-state.js';
import { parseHistoryJson } from './history-contracts.js';
import { historicalLifecyclePhaseBlockers } from './migration-history.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './proof-records.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';

export interface CapturedGovernanceTaskSource {
  contract: GovernanceTaskProjectionContract;
  metadata: GovernanceChangeMetadata;
  metadataBefore: ProjectFileSnapshot;
  taskBefore: ProjectFileSnapshot;
  text: string;
}

export interface PreparedGovernanceTaskProjection {
  source: CapturedGovernanceTaskSource;
  record: GovernanceTaskProjectionRecord;
  mutation?: ProjectFileMutation;
}

function taskPaths(metadata: Pick<GovernanceChangeMetadata, 'changeId' | 'workflowKind'>) {
  const base = metadata.workflowKind === 'openspec' ? ['openspec', 'changes', metadata.changeId] : ['specs', metadata.changeId];
  return { taskPathParts: [...base, 'tasks.md'], metadataPathParts: [...base, 'liftoff-governance.json'] };
}

function text(snapshot: ProjectFileSnapshot): string {
  if (!snapshot.content || snapshot.content.length > 262_144) throw new Error('Current governance tasks/metadata require bounded existing UTF-8 source.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(snapshot.content);
}

function assertPublicTaskPaths(inspection: GovernanceTransitionInspection, paths: readonly (readonly string[])[]): void {
  for (const parts of paths) {
    if (isSensitiveActivationPath(parts, inspection.sensitivePathExclusions ?? [])) {
      throw new Error('Protected retained material cannot be consumed or replaced by governance task projection.');
    }
    if (activationInputPathIsObserved(parts)) {
      throw new Error('Task projection cannot target an application, seed, or execution-input file.');
    }
  }
}

export function governanceSourceFilesWithoutTasks(plan: GovernanceChangeWritePlan): GovernanceChangeWritePlan['files'] {
  const { taskPathParts } = taskPaths(plan.metadata);
  return plan.files.filter((file) => file.pathParts.join('/') !== taskPathParts.join('/'));
}

/** Checkbox bits are declared derived values; all other source bytes and metadata are approval-bound. */
export async function planGovernanceTaskProjection(
  inspection: GovernanceTransitionInspection, phase: PhaseGraphNode
): Promise<TransitionOperation | undefined> {
  let contract: GovernanceTaskProjectionContract;
  if (phase.id === 'activation-approved' && inspection.sourceOfTruth.status === 'none') {
    const facts = buildApprovedPhase0FactsFromState(
      inspection.manifest, inspection.state, inspection.evidence, inspection.contexts['phase-0-complete']
    );
    if (!facts) throw new Error('Current Phase 0 proof is required before planning initial governance task projection.');
    const creation = renderGovernanceChangeWritePlan(facts);
    const paths = taskPaths(creation.metadata);
    assertPublicTaskPaths(inspection, [paths.taskPathParts, paths.metadataPathParts]);
    const template = creation.files.find((file) => file.pathParts.join('/') === paths.taskPathParts.join('/'))?.content;
    const metadataText = creation.files.find((file) => file.pathParts.join('/') === paths.metadataPathParts.join('/'))?.content;
    if (!template || !metadataText) throw new Error('The current creation inventory omitted its exact task or metadata artifact.');
    contract = validateGovernanceTaskProjectionContract({
      schemaVersion: 1, derivation: 'validated-current-readiness', source: 'create',
      changeId: creation.changeId, workflowKind: creation.workflowKind, ...paths,
      metadataHash: sha256Hex(metadataText), layoutHash: governanceTaskLayoutHash(template, creation.metadata),
      template, metadataText
    });
  } else {
    if (inspection.sourceOfTruth.status !== 'selected' || !inspection.sourceOfTruth.selected.metadata) return undefined;
    const selected = inspection.sourceOfTruth.selected;
    const metadata = validateGovernanceChangeMetadata(selected.metadata);
    if (inspection.sourceOfTruth.reconciliation.status !== 'not-required' ||
      metadata.phaseGraphHash !== inspection.graphHash ||
      canonicalSha256(metadata.activationIdentity) !== canonicalSha256(inspection.state.identity) ||
      metadata.changeId === inspection.state.successorHistory?.sourceActiveChange?.id &&
        metadata.workflowKind === inspection.state.successorHistory.sourceActiveChange.kind) {
      throw new Error('Only the selected current governance source can receive task projection.');
    }
    const paths = taskPaths(metadata);
    if (selected.pathParts.join('/') !== paths.taskPathParts.slice(0, -1).join('/')) throw new Error('The selected source path differs from its metadata.');
    assertPublicTaskPaths(inspection, [paths.taskPathParts, paths.metadataPathParts]);
    const metadataFile = await captureHistoryFile(inspection.projectRoot, paths.metadataPathParts);
    const tasks = await captureHistoryFile(inspection.projectRoot, paths.taskPathParts);
    const parsed = validateGovernanceChangeMetadata(parseHistoryJson(metadataFile.content ?? Buffer.alloc(0), 'current governance metadata'));
    if (canonicalSha256(parsed) !== canonicalSha256(metadata)) throw new Error('Current source metadata changed during task planning.');
    contract = validateGovernanceTaskProjectionContract({
      schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing',
      changeId: metadata.changeId, workflowKind: metadata.workflowKind, ...paths,
      metadataHash: sha256Hex(text(metadataFile)), layoutHash: governanceTaskLayoutHash(text(tasks), metadata)
    });
  }
  return {
    adapter: 'local-evidence', actionId: governanceTaskProjectionAction, mutationClass: 'project-governance-tasks',
    phaseId: phase.id, inputs: { projection: contract },
    destination: { type: 'local', identity: contract.taskPathParts.join('/'), pathParts: contract.taskPathParts },
    remote: false, destructive: false
  };
}

export function withoutDerivedTaskWrites(
  mutations: readonly ProjectFileMutation[], projection?: TransitionOperation
): readonly ProjectFileMutation[] {
  const contract = projection && taskProjectionContract([projection]);
  if (!contract) return mutations;
  return mutations.filter((mutation) => {
    if (mutation.pathParts.join('/') !== contract.taskPathParts.join('/')) return true;
    if (contract.source !== 'create' || mutation.type !== 'write' || mutation.content.toString() !== contract.template) {
      throw new Error('An adapter cannot replace current task text under a checkbox-projection contract.');
    }
    return false;
  });
}

export async function captureGovernanceTaskSource(
  inspection: GovernanceTransitionInspection, plan: SavedTransitionPlan
): Promise<CapturedGovernanceTaskSource | undefined> {
  const contract = taskProjectionContract(plan.operations);
  if (!contract) return undefined;
  assertPublicTaskPaths(inspection, [contract.taskPathParts, contract.metadataPathParts]);
  const taskBefore = await captureHistoryFile(inspection.projectRoot, contract.taskPathParts);
  const metadataBefore = await captureHistoryFile(inspection.projectRoot, contract.metadataPathParts);
  if (contract.source === 'create' && (taskBefore.content !== undefined || metadataBefore.content !== undefined)) {
    throw new Error('Current source creation cannot overwrite existing task or metadata files.');
  }
  const metadataText = contract.source === 'create' ? contract.metadataText : text(metadataBefore);
  const taskText = contract.source === 'create' ? contract.template : text(taskBefore);
  const metadata = validateGovernanceChangeMetadata(parseHistoryJson(Buffer.from(metadataText), 'current task projection metadata'));
  if (metadata.changeId !== contract.changeId || metadata.workflowKind !== contract.workflowKind ||
    canonicalSha256(metadata.activationIdentity) !== canonicalSha256(plan.identity) ||
    sha256Hex(metadataText) !== contract.metadataHash || governanceTaskLayoutHash(taskText, metadata) !== contract.layoutHash) {
    throw new Error('Current task source changed outside the approved checkbox-only derivation.');
  }
  return { contract, metadata, metadataBefore, taskBefore, text: taskText };
}

async function issuedApprovals(inspection: GovernanceTransitionInspection) {
  const approvals = [];
  for (const parts of await historicalActiveRecordPaths(inspection.projectRoot, 'approvals')) {
    const file = await captureHistoryFile(inspection.projectRoot, parts);
    if (!file.content) throw new Error('A current approval disappeared during post-outcome inspection.');
    const approval = validateApprovalEnvelope(parseHistoryJson(file.content, parts.join('/')), { expectedIdentity: inspection.state.identity });
    await assertGovernanceApprovalIssued(inspection.projectRoot, approval);
    approvals.push(approval);
  }
  return approvals;
}

export async function calculatePostOutcomeTaskReadiness(input: {
  inspection: GovernanceTransitionInspection; plan: SavedTransitionPlan; nextState: UserActivationState;
  snapshot: ActivationInputSnapshot; evidenceRecord?: PhaseEvidenceRecord; now: Date;
}) {
  const { inspection, plan, nextState, snapshot, now } = input;
  const evidence = await readActivationEvidence(inspection.projectRoot);
  if (input.evidenceRecord) {
    if (evidence.some((record) => record.evidenceId === input.evidenceRecord!.evidenceId)) throw new Error('The prospective current evidence identity is already occupied.');
    evidence.push(input.evidenceRecord);
  }
  const plans = await readReviewedTransitionPlans(inspection.projectRoot);
  if (!plans.some((entry) => canonicalSha256(entry) === canonicalSha256(plan))) throw new Error('The saved reviewed plan changed before task projection.');
  const contexts = activationEvidenceContexts(inspection.graph, nextState, snapshot, now);
  for (const id of phaseIds) contexts[id].reviewedPlans = plans;
  const archived = await inspectArchivedSeedIntegrity(inspection.projectRoot, inspection.manifest);
  const seed = await discoverGeneratedSeed(inspection.projectRoot, inspection.manifest);
  const infrastructure = seedInfrastructureBaselineBlocker(inspection.manifest);
  const local = [...(infrastructure ? [infrastructure] : []), ...protectedLocalInputBlockers(snapshot.sensitivePathExclusions ?? [])];
  const historical = historicalLifecyclePhaseBlockers(inspection.historicalLifecycleObligations ?? []);
  return calculatePhaseReadiness({
    graph: inspection.graph, state: nextState, evidence, approvals: await issuedApprovals(inspection),
    transitionContexts: contexts, scope: inspection.scope, recoverPhase: inspection.recoverPhase,
    retryArchivedSeedBaseline: nextState.phases['seed-verified'].state === 'blocked' && archived.status === 'valid' && seed.state === 'archived',
    historicalLifecycleBlockers: historical['bootstrap-state-disposed'],
    phaseBlockers: {
      ...Object.fromEntries(Object.entries(phaseCapabilities).filter(([, capability]) => capability.blocker)
        .map(([id, capability]) => [id, [capability.blocker!]])),
      ...(archived.status === 'invalid' ? { 'seed-archived': archived.issues } : {}),
      ...(seed.state === 'blocked' ? { 'seed-valid': seed.issues } : {}),
      ...(local.length ? { 'seed-verified': local } : {}), ...historical
    }, now
  });
}

export async function prepareGovernanceTaskProjection(input: {
  source: CapturedGovernanceTaskSource; inspection: GovernanceTransitionInspection; plan: SavedTransitionPlan;
  nextState: UserActivationState; snapshot: ActivationInputSnapshot; evidenceRecord?: PhaseEvidenceRecord; now: Date;
}): Promise<PreparedGovernanceTaskProjection> {
  const readiness = await calculatePostOutcomeTaskReadiness(input);
  const succeeded = new Set(['verified', 'approved', 'inapplicable', 'retained', 'disposed']);
  if (succeeded.has(input.nextState.phases[input.plan.phaseId].state) &&
    !succeeded.has(readiness.phases[input.plan.phaseId].state)) {
    throw new Error(`The completed ${input.plan.phaseId} outcome has no current post-operation readiness: ${readiness.phases[input.plan.phaseId].blockers.join(' ')}`);
  }
  const states = Object.fromEntries(phaseIds.map((id) => [id, readiness.phases[id].state]));
  const projected = projectGovernanceChangeTasks(input.source.text, input.source.metadata, readiness.phases);
  if (governanceTaskLayoutHash(projected.markdown, input.source.metadata) !== input.source.contract.layoutHash) {
    throw new Error('Task projection changed text outside the exact mapped checkbox characters.');
  }
  const record = validateGovernanceTaskProjectionRecord({
    schemaVersion: 1, purpose: 'projection-audit-only', phaseId: input.plan.phaseId, planDigest: input.plan.planDigest,
    contractDigest: canonicalSha256(input.source.contract), taskPathParts: input.source.contract.taskPathParts,
    metadataHash: input.source.contract.metadataHash, layoutHash: input.source.contract.layoutHash,
    status: 'complete', observedAt: input.now.toISOString(),
    beforeHash: input.source.taskBefore.content ? sha256Hex(text(input.source.taskBefore)) : null,
    afterHash: sha256Hex(projected.markdown), states, blockers: []
  });
  return {
    source: input.source, record,
    ...(input.source.taskBefore.content?.equals(Buffer.from(projected.markdown)) ? {} : {
      mutation: { type: 'write' as const, pathParts: [...input.source.contract.taskPathParts], content: projected.markdown }
    })
  };
}

export function blockedGovernanceTaskProjection(plan: SavedTransitionPlan, now: Date, blocker: string): GovernanceTaskProjectionRecord | undefined {
  const contract = taskProjectionContract(plan.operations);
  if (!contract) return undefined;
  return validateGovernanceTaskProjectionRecord({
    schemaVersion: 1, purpose: 'projection-audit-only', phaseId: plan.phaseId, planDigest: plan.planDigest,
    contractDigest: canonicalSha256(contract), taskPathParts: contract.taskPathParts,
    metadataHash: contract.metadataHash, layoutHash: contract.layoutHash, status: 'blocked', observedAt: now.toISOString(),
    beforeHash: null, afterHash: null, states: null, blockers: [blocker]
  });
}

export function validatePreparedTaskProjection(
  plan: SavedTransitionPlan, nextState: UserActivationState, prepared: PreparedGovernanceTaskProjection
): void {
  const contract = taskProjectionContract(plan.operations);
  const record = validateGovernanceTaskProjectionRecord(prepared.record);
  if (!contract || canonicalSha256(contract) !== canonicalSha256(prepared.source.contract) ||
    record.contractDigest !== canonicalSha256(contract) || record.planDigest !== plan.planDigest ||
    record.phaseId !== plan.phaseId || Date.parse(record.observedAt) < Date.parse(plan.createdAt) ||
    canonicalSha256(nextState.taskProjection) !== canonicalSha256(record) || record.states === null ||
    record.metadataHash !== contract.metadataHash || record.layoutHash !== contract.layoutHash ||
    record.taskPathParts.join('/') !== contract.taskPathParts.join('/') ||
    prepared.source.taskBefore.pathParts.join('/') !== contract.taskPathParts.join('/') ||
    prepared.source.metadataBefore.pathParts.join('/') !== contract.metadataPathParts.join('/')) {
    throw new Error('Derived task output is not bound to this exact approved phase contract.');
  }
  const metadataText = contract.source === 'create' ? contract.metadataText : text(prepared.source.metadataBefore);
  const original = contract.source === 'create' ? contract.template : text(prepared.source.taskBefore);
  if (sha256Hex(metadataText) !== contract.metadataHash || original !== prepared.source.text ||
    canonicalSha256(validateGovernanceChangeMetadata(parseHistoryJson(Buffer.from(metadataText), 'task projection metadata'))) !== canonicalSha256(prepared.source.metadata) ||
    record.beforeHash !== (prepared.source.taskBefore.content ? sha256Hex(text(prepared.source.taskBefore)) : null)) {
    throw new Error('Task projection lost its exact captured source/metadata preconditions.');
  }
  const content = projectGovernanceChangeTasks(prepared.source.text, prepared.source.metadata, record.states).markdown;
  if (sha256Hex(content) !== record.afterHash || governanceTaskLayoutHash(content, prepared.source.metadata) !== contract.layoutHash ||
    (prepared.mutation ? prepared.mutation.type !== 'write' || prepared.mutation.pathParts.join('/') !== contract.taskPathParts.join('/') ||
      prepared.mutation.content.toString() !== content : !prepared.source.taskBefore.content?.equals(Buffer.from(content)))) {
    throw new Error('Derived task output is not the exact checkbox projection of validated readiness.');
  }
}

export function uniqueTaskWritePreconditions(snapshots: readonly ProjectFileSnapshot[]): ProjectFileSnapshot[] {
  const unique = new Map<string, ProjectFileSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.pathParts.join('/');
    const prior = unique.get(key);
    if (prior && (prior.mode !== snapshot.mode || (prior.content === undefined
      ? snapshot.content !== undefined : !snapshot.content?.equals(prior.content)))) {
      throw new Error(`Task/source preconditions conflict at ${key}.`);
    }
    unique.set(key, snapshot);
  }
  return [...unique.values()];
}
