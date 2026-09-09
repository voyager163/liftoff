import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import type { PhaseExecutionState, UserActivationState } from '../domain/governance/activation/types.js';
import { validateApprovalEnvelope, validateUserActivationState } from '../domain/governance/activation/validators.js';
import { evidenceBodyDigest } from '../domain/governance/activation/evidence.js';
import { isHistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
import { parseManifest } from '../application/project/manifest.js';
import { FileSystemError } from '../domain/project/errors.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import {
  activationSuccessorMigrationId, packagedActivationSuccessorMigrations
} from './compatibility.js';
import {
  ActivationHistoryError, activationHistoryCopyPathParts, activationHistoryIndexPathParts,
  activationHistorySnapshotId, activationHistoryTargetModes, historicalActivationStatePathParts, historicalManifestPathParts,
  historyDigest, historyFail, historyPathKey, historyRecordId, historyTimestamp, migrationStateFilePathParts,
  migrationRevalidationPhaseIds, migrationTargetIdentity, parseHistoryJson, rawHistoryDigest, validateActivationHistoryIndex,
  validateMigrationJournal, type ActivationHistoryIndex, type MigrationJournal
} from './history-contracts.js';
import {
  assertHistoricalPhasesComplete, captureHistoryFile, historicalActiveRecordPaths, historicalPhaseIds, readHistoricalActivationInventory,
  resolveHistoryProjectPath, validateHistoricalActivationState, validateHistoricalSourceManifest,
  type HistoricalActivationInventory, type HistoricalInventoryOptions
} from './historical-state.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './proof-records.js';

export interface HistoricalRetirement {
  pathParts: string[];
  digest: string;
  copyPathParts: string[];
}

export interface HistoryPreconditionIdentity {
  pathParts: string[];
  type: 'file' | 'absent';
  digest: string | null;
  mode: number | null;
}

export interface HistoricalMigrationSemanticPlan {
  schemaVersion: 1;
  kind: 'activation-history-successor';
  projectRoot: string;
  laneId: typeof activationSuccessorMigrationId;
  sourceIdentity: ActivationHistoryIndex['sourceIdentity'];
  targetIdentity: UserActivationState['identity'];
  historyIndex: ActivationHistoryIndex;
  historyIndexDigest: string;
  historyDisposition: 'create' | 'reuse';
  preconditions: HistoryPreconditionIdentity[];
  requiredRetirements: HistoricalRetirement[];
  revalidationPhaseIds: typeof migrationRevalidationPhaseIds;
  targetModes: typeof activationHistoryTargetModes;
  successor: {
    statePathParts: string[];
    journalPathParts: string[];
    policy: 'fresh-local-anchor-no-inherited-proof';
    projectName: string;
    activeChange: UserActivationState['activeChange'];
  };
}

export interface EligibleActivationHistoryMigration {
  status: 'eligible';
  planDigest: string;
  semanticPlan: HistoricalMigrationSemanticPlan;
  inventory: HistoricalActivationInventory;
  index: ActivationHistoryIndex;
  indexContent: Buffer;
  indexDigest: string;
  historyDisposition: 'create' | 'reuse';
  preconditions: ProjectFileSnapshot[];
  requiredRetirements: HistoricalRetirement[];
}

export type ActivationHistoryMigrationPlan =
  | EligibleActivationHistoryMigration
  | { status: 'not-present' }
  | { status: 'current'; state: UserActivationState; history: CommittedMigrationInspection }
  | { status: 'blocked'; reasonCode: string; issues: string[]; unreviewedPathParts?: string[][] };

export type ActivationHistoryMutation =
  | { type: 'write'; pathParts: string[]; content: string | Buffer; mode: number }
  | { type: 'delete'; pathParts: string[] };

export interface FinalizedActivationHistoryMigration {
  successor: UserActivationState;
  journal: MigrationJournal;
  mutations: ActivationHistoryMutation[];
  preconditions: ProjectFileSnapshot[];
  requiredRetirements: HistoricalRetirement[];
}

export type CommittedMigrationInspection =
  | { status: 'none' }
  | { status: 'committed'; journal: MigrationJournal; index: ActivationHistoryIndex; state: UserActivationState };

function requireContent(snapshot: ProjectFileSnapshot, detail: string): Buffer {
  if (snapshot.content === undefined) historyFail(historyPathKey(snapshot.pathParts), detail, 'missing-history-record');
  return snapshot.content;
}

function currentState(value: unknown, location: string): UserActivationState {
  try { return validateUserActivationState(value); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== 'Error') throw error;
    return historyFail(location, `invalid current successor: ${error.message}`, 'invalid-migration-successor');
  }
}

function currentManifestIdentity(value: unknown, location: string): void {
  let manifest;
  try { manifest = parseManifest(value); }
  catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return historyFail(location, error.message, 'invalid-migration-manifest');
  }
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified' ||
    manifest.governance.activationIdentity === undefined) historyFail(location, 'active manifest has no successor identity.', 'invalid-migration-manifest');
  migrationTargetIdentity(manifest.governance.activationIdentity, `${location}.governance.activationIdentity`);
}

function preconditionIdentities(preconditions: readonly ProjectFileSnapshot[]): HistoryPreconditionIdentity[] {
  return preconditions.map((snapshot): HistoryPreconditionIdentity => ({
    pathParts: [...snapshot.pathParts],
    type: snapshot.content === undefined ? 'absent' : 'file',
    digest: snapshot.content === undefined ? null : rawHistoryDigest(snapshot.content),
    mode: snapshot.mode ?? null
  })).sort((a, b) => historyPathKey(a.pathParts) < historyPathKey(b.pathParts) ? -1 : 1);
}

async function directoryExists(projectRoot: string, parts: readonly string[]): Promise<boolean> {
  const target = await resolveHistoryProjectPath(projectRoot, parts);
  try {
    const details = await lstat(target);
    if (!details.isDirectory()) historyFail(historyPathKey(parts), 'must be a real directory.', 'unsafe-history-path');
    return true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return false;
  }
}

export async function readActivationHistoryIndex(
  projectRoot: string, snapshotId: string
): Promise<{ index: ActivationHistoryIndex; content: Buffer; digest: string }> {
  const parts = activationHistoryIndexPathParts(snapshotId);
  const snapshot = await captureHistoryFile(projectRoot, parts);
  const content = requireContent(snapshot, 'declared historical index is missing.');
  const index = validateActivationHistoryIndex(parseHistoryJson(content, historyPathKey(parts)));
  if (index.snapshotId !== snapshotId) historyFail(historyPathKey(parts), 'index declares another snapshot.', 'history-digest-mismatch');
  return { index, content, digest: rawHistoryDigest(content) };
}

export async function readMigrationJournal(projectRoot: string): Promise<MigrationJournal | undefined> {
  const snapshot = await captureHistoryFile(projectRoot, migrationStateFilePathParts);
  if (snapshot.content === undefined) return undefined;
  return validateMigrationJournal(parseHistoryJson(snapshot.content, historyPathKey(migrationStateFilePathParts)));
}

async function verifyHistoryCopies(projectRoot: string, index: ActivationHistoryIndex): Promise<ProjectFileSnapshot[]> {
  const snapshots: ProjectFileSnapshot[] = [];
  for (const file of index.files) {
    const snapshot = await captureHistoryFile(projectRoot, file.copyPathParts);
    const content = requireContent(snapshot, 'declared historical copy is missing.');
    if (rawHistoryDigest(content) !== file.digest) {
      historyFail(historyPathKey(file.copyPathParts), 'historical bytes differ from the immutable index.', 'history-digest-mismatch');
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

async function inspectActiveProofRecords(projectRoot: string, state: UserActivationState) {
  // Current proof is validated separately; no preserved record is considered here.
  for (const directory of ['evidence', 'plans', 'approvals']) {
    for (const parts of await historicalActiveRecordPaths(projectRoot, directory)) await captureHistoryFile(projectRoot, parts);
  }
  let records;
  try {
    records = await readActivationEvidence(projectRoot);
    await readReviewedTransitionPlans(projectRoot);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'Error') throw error;
    return historyFail('governance active proof', error.message, 'invalid-current-proof');
  }
  const seenEvidenceIds = new Set<string>();
  for (const record of records) {
    historyRecordId(record.evidenceId, 'current evidence ID');
    if (seenEvidenceIds.has(record.evidenceId)) historyFail('governance/evidence', `duplicate current evidence ID ${record.evidenceId}.`, 'invalid-current-proof');
    seenEvidenceIds.add(record.evidenceId);
    if (record.header.repositoryId !== state.repository.id ||
      canonicalSha256(record.header.identity) !== canonicalSha256(state.identity) ||
      record.header.bodyDigest !== evidenceBodyDigest(record.payload, record.liveReadback)) {
      historyFail(`governance/evidence/${record.evidenceId}.json`, 'current evidence body or local identity is inconsistent.', 'invalid-current-proof');
    }
  }
  for (const [phaseId, phase] of Object.entries(state.phases)) {
    if (['verified', 'inapplicable', 'retained', 'disposed'].includes(phase.state) && phase.evidence.length === 0) {
      historyFail(`activation-state.json#phases.${phaseId}`, 'current terminal state has no evidence references.', 'invalid-current-proof');
    }
    for (const reference of phase.evidence) {
      historyRecordId(reference.evidenceId, `activation-state.json#phases.${phaseId}.evidenceId`);
      if (!records.some((record) => record.evidenceId === reference.evidenceId &&
        record.header.phaseId === phaseId && record.header.result === reference.result &&
        canonicalSha256(record.header) === reference.headerDigest)) {
        historyFail(`activation-state.json#phases.${phaseId}`, 'current evidence reference is missing or inconsistent.', 'invalid-current-proof');
      }
    }
  }
  const approvals = new Map<string, string>();
  for (const parts of await historicalActiveRecordPaths(projectRoot, 'approvals')) {
    const file = await captureHistoryFile(projectRoot, parts);
    const value = parseHistoryJson(requireContent(file, 'current approval disappeared during inspection.'), historyPathKey(parts));
    try {
      const approval = validateApprovalEnvelope(value, { expectedIdentity: state.identity });
      historyRecordId(approval.id, `${historyPathKey(parts)}.id`);
      if (approvals.has(approval.id)) historyFail(historyPathKey(parts), 'duplicates a current approval ID.', 'invalid-current-proof');
      approvals.set(approval.id, approval.phaseId);
    }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'Error') throw error;
      historyFail(historyPathKey(parts), error.message, 'invalid-current-proof');
    }
  }
  for (const [phaseId, phase] of Object.entries(state.phases)) {
    if (phase.state === 'approved' && phase.approvals.length === 0) {
      historyFail(`activation-state.json#phases.${phaseId}`, 'approved current state has no approval references.', 'invalid-current-proof');
    }
    for (const id of phase.approvals) {
      historyRecordId(id, `activation-state.json#phases.${phaseId}.approvals`);
      if (approvals.get(id) !== phaseId) historyFail(`activation-state.json#phases.${phaseId}`, 'current approval reference is missing or names another phase.', 'invalid-current-proof');
    }
  }
  return records;
}

export async function inspectActivationMigrationHistory(projectRoot: string): Promise<CommittedMigrationInspection> {
  const journal = await readMigrationJournal(projectRoot);
  if (journal === undefined) return { status: 'none' };
  const loaded = await readActivationHistoryIndex(projectRoot, journal.snapshotId);
  if (loaded.digest !== journal.historyIndexDigest ||
    canonicalSha256(loaded.index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'index digest or source identity contradicts the migration journal.', 'history-digest-mismatch');
  }
  const copies = await verifyHistoryCopies(projectRoot, loaded.index);
  for (const file of loaded.index.files) {
    if (file.kind !== 'state' && file.kind !== 'manifest') continue;
    const copy = copies.find((entry) => historyPathKey(entry.pathParts) === historyPathKey(file.copyPathParts));
    if (copy === undefined) historyFail(historyPathKey(file.copyPathParts), 'required copy was not verified.');
    const parsed = parseHistoryJson(requireContent(copy, 'required copy is missing.'), historyPathKey(file.copyPathParts));
    if (file.kind === 'state') validateHistoricalActivationState(parsed);
    else validateHistoricalSourceManifest(parsed);
  }
  const stateSnapshot = await captureHistoryFile(projectRoot, historicalActivationStatePathParts);
  const state = currentState(parseHistoryJson(requireContent(stateSnapshot, 'committed successor state is missing.'),
    historyPathKey(stateSnapshot.pathParts)), historyPathKey(stateSnapshot.pathParts));
  if (canonicalSha256(state.identity) !== canonicalSha256(journal.targetIdentity) ||
    state.repository.id !== journal.successor.repositoryId || state.createdAt !== journal.successor.createdAt) {
    historyFail(historyPathKey(stateSnapshot.pathParts), 'active successor identity or stable local anchor contradicts the journal.', 'invalid-migration-successor');
  }
  const manifestSnapshot = await captureHistoryFile(projectRoot, historicalManifestPathParts);
  currentManifestIdentity(parseHistoryJson(requireContent(manifestSnapshot, 'committed active manifest is missing.'),
    historyPathKey(manifestSnapshot.pathParts)), historyPathKey(manifestSnapshot.pathParts));
  const records = await inspectActiveProofRecords(projectRoot, state);
  for (const result of journal.revalidation.phases) {
    if (result.status !== 'complete') continue;
    const phase = state.phases[result.phaseId];
    // Completed revalidation is an audit event, not the mutable phase's present readiness.
    if (result.evidenceIds.some((id) => !phase.evidence.some((ref) =>
      ref.evidenceId === id && records.some((record) => record.evidenceId === id && record.header.phaseId === result.phaseId &&
        record.header.result === 'verified' && canonicalSha256(record.header) === ref.headerDigest)))) {
      historyFail(historyPathKey(migrationStateFilePathParts), `revalidation result for ${result.phaseId} has no corresponding current state references.`, 'invalid-migration-progress');
    }
  }
  return { status: 'committed', journal, index: loaded.index, state };
}

/** Project-read-only. This creates neither mutations nor approval, runtime IDs or timestamps. */
export async function planActivationHistoryMigration(
  projectRoot: string, options: HistoricalInventoryOptions = {}
): Promise<ActivationHistoryMigrationPlan> {
  try {
    const stateSnapshot = await captureHistoryFile(projectRoot, historicalActivationStatePathParts);
    const journalSnapshot = await captureHistoryFile(projectRoot, migrationStateFilePathParts);
    if (journalSnapshot.content !== undefined) {
      const history = await inspectActivationMigrationHistory(projectRoot);
      if (history.status !== 'committed') historyFail('migration-state.json', 'declared journal disappeared during inspection.');
      return { status: 'current', state: history.state, history };
    }
    if (stateSnapshot.content === undefined) {
      const manifestSnapshot = await captureHistoryFile(projectRoot, historicalManifestPathParts);
      if (manifestSnapshot.content !== undefined) {
        const manifest = parseHistoryJson(manifestSnapshot.content, historyPathKey(manifestSnapshot.pathParts));
        if (isRecord(manifest) && isRecord(manifest.governance) && isHistoricalActivationIdentity(manifest.governance.activationIdentity)) {
          historyFail(historyPathKey(stateSnapshot.pathParts), 'the historical manifest has no required v1 activation state.', 'missing-historical-record');
        }
      }
      return { status: 'not-present' };
    }
    const raw = parseHistoryJson(stateSnapshot.content, historyPathKey(stateSnapshot.pathParts));
    if (isRecord(raw) && raw.schemaVersion === 2) {
      const state = currentState(raw, historyPathKey(stateSnapshot.pathParts));
      migrationTargetIdentity(state.identity, 'activation-state.json.identity');
      const manifest = await captureHistoryFile(projectRoot, historicalManifestPathParts);
      currentManifestIdentity(parseHistoryJson(requireContent(manifest, 'active manifest is missing.'), historyPathKey(manifest.pathParts)),
        historyPathKey(manifest.pathParts));
      await inspectActiveProofRecords(projectRoot, state);
      return { status: 'current', state, history: { status: 'none' } };
    }
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !isHistoricalActivationIdentity(raw.identity)) {
      historyFail(historyPathKey(stateSnapshot.pathParts), 'only the exact versioned historical v1 representation has a successor lane.', 'unsupported-historical-identity');
    }
    const lane = packagedActivationSuccessorMigrations().find((entry) =>
      canonicalSha256(entry.fromIdentity) === canonicalSha256(raw.identity) &&
      canonicalSha256(entry.toIdentity) === canonicalSha256(currentActivationIdentity));
    if (lane === undefined) historyFail(historyPathKey(stateSnapshot.pathParts), 'no exact packaged successor lane exists.', 'unsupported-historical-identity');
    const inventory = await readHistoricalActivationInventory(projectRoot, options);
    if (inventory.unreviewedRecords.length > 0) {
      return {
        status: 'blocked', reasonCode: 'unreviewed-historical-records',
        issues: inventory.unreviewedRecords.map((file) =>
          `${historyPathKey(file.pathParts)}: recognized unreferenced historical record must be explicitly included in the reviewed inventory before active proof can be separated.`),
        unreviewedPathParts: inventory.unreviewedRecords.map((file) => [...file.pathParts])
      };
    }
    const sourceFiles = inventory.files.map((file) => ({
      kind: file.kind, originalPathParts: [...file.pathParts], digest: file.digest, mode: file.mode
    }));
    const snapshotId = activationHistorySnapshotId(inventory.state.identity, sourceFiles);
    const index = validateActivationHistoryIndex({
      schemaVersion: 1, snapshotId, sourceIdentity: inventory.state.identity,
      files: sourceFiles.map((file) => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
    });
    const indexContent = Buffer.from(canonicalJson(index), 'utf8');
    const indexDigest = rawHistoryDigest(indexContent);
    const indexPath = activationHistoryIndexPathParts(snapshotId);
    const indexSnapshot = await captureHistoryFile(projectRoot, indexPath);
    const preconditions = [...inventory.preconditions, journalSnapshot, indexSnapshot];
    let historyDisposition: 'create' | 'reuse' = 'create';
    if (indexSnapshot.content !== undefined) {
      const existing = validateActivationHistoryIndex(parseHistoryJson(indexSnapshot.content, historyPathKey(indexPath)));
      if (!indexSnapshot.content.equals(indexContent) || canonicalSha256(existing) !== canonicalSha256(index)) {
        historyFail(historyPathKey(indexPath), 'existing immutable snapshot differs; force cannot replace history.', 'historical-destination-conflict');
      }
      preconditions.push(...await verifyHistoryCopies(projectRoot, index));
      historyDisposition = 'reuse';
    } else {
      if (await directoryExists(projectRoot, indexPath.slice(0, -1))) {
        historyFail(historyPathKey(indexPath), 'snapshot directory exists without its completed index; resolve bounded recovery before a new migration.', 'incomplete-history-snapshot');
      }
      for (const file of index.files) {
        const snapshot = await captureHistoryFile(projectRoot, file.copyPathParts);
        if (snapshot.content !== undefined) historyFail(historyPathKey(snapshot.pathParts), 'unindexed history destination already exists.', 'historical-destination-conflict');
        preconditions.push(snapshot);
      }
    }
    const requiredRetirements = index.files.filter((file) => ['evidence', 'plan', 'approval'].includes(file.kind)).map((file) => ({
      pathParts: [...file.originalPathParts], digest: file.digest, copyPathParts: [...file.copyPathParts]
    }));
    const semanticPlan: HistoricalMigrationSemanticPlan = {
      schemaVersion: 1, kind: 'activation-history-successor', projectRoot: await realpath(projectRoot),
      laneId: lane.id, sourceIdentity: index.sourceIdentity, targetIdentity: { ...currentActivationIdentity },
      historyIndex: index, historyIndexDigest: indexDigest, historyDisposition,
      preconditions: preconditionIdentities(preconditions), requiredRetirements,
      revalidationPhaseIds: [...migrationRevalidationPhaseIds],
      targetModes: { ...activationHistoryTargetModes },
      successor: {
        statePathParts: [...historicalActivationStatePathParts], journalPathParts: [...migrationStateFilePathParts],
        policy: 'fresh-local-anchor-no-inherited-proof', projectName: inventory.manifest.project.name,
        activeChange: inventory.state.activeChange
      }
    };
    return {
      status: 'eligible', planDigest: canonicalSha256(semanticPlan), semanticPlan, inventory,
      index, indexContent, indexDigest, historyDisposition, preconditions, requiredRetirements
    };
  } catch (error) {
    if (!(error instanceof ActivationHistoryError)) throw error;
    return { status: 'blocked', reasonCode: error.code, issues: [error.message] };
  }
}

/** The caller must already have exact effective-plan approval. Returns data only; never writes. */
export function finalizeActivationHistoryMigration(
  plan: EligibleActivationHistoryMigration, approvedPlanFingerprint: string, now: Date
): FinalizedActivationHistoryMigration {
  historyDigest(approvedPlanFingerprint, 'approvedPlanFingerprint');
  const timestamp = historyTimestamp(now.toISOString(), 'migration finalization timestamp');
  validateActivationHistoryIndex(plan.index);
  const retirements = plan.index.files.filter((file) => ['evidence', 'plan', 'approval'].includes(file.kind)).map((file) => ({
    pathParts: file.originalPathParts, digest: file.digest, copyPathParts: file.copyPathParts
  }));
  if (canonicalSha256(plan.semanticPlan) !== plan.planDigest ||
    canonicalSha256(preconditionIdentities(plan.preconditions)) !== canonicalSha256(plan.semanticPlan.preconditions) ||
    canonicalSha256(plan.index) !== canonicalSha256(plan.semanticPlan.historyIndex) ||
    !plan.indexContent.equals(Buffer.from(canonicalJson(plan.index), 'utf8')) ||
    rawHistoryDigest(plan.indexContent) !== plan.indexDigest || plan.indexDigest !== plan.semanticPlan.historyIndexDigest ||
    plan.historyDisposition !== plan.semanticPlan.historyDisposition ||
    canonicalSha256(plan.semanticPlan.targetModes) !== canonicalSha256(activationHistoryTargetModes) ||
    canonicalSha256(plan.semanticPlan.revalidationPhaseIds) !== canonicalSha256(migrationRevalidationPhaseIds) ||
    canonicalSha256(plan.requiredRetirements) !== canonicalSha256(plan.semanticPlan.requiredRetirements) ||
    canonicalSha256(plan.requiredRetirements) !== canonicalSha256(retirements)) {
    historyFail('migration plan', 'changed since planning; obtain a fresh preview.', 'historical-plan-changed');
  }
  for (const file of plan.index.files) {
    const source = plan.inventory.files.find((entry) => historyPathKey(entry.pathParts) === historyPathKey(file.originalPathParts));
    if (source === undefined || rawHistoryDigest(source.content) !== file.digest || source.mode !== file.mode) {
      historyFail(historyPathKey(file.originalPathParts), 'planned historical bytes changed.', 'historical-plan-changed');
    }
  }
  const phases: Partial<Record<typeof historicalPhaseIds[number], PhaseExecutionState>> = {};
  for (const id of historicalPhaseIds) phases[id] = { state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: [] };
  assertHistoricalPhasesComplete(phases);
  const successor = validateUserActivationState({
    schemaVersion: 2, identity: plan.semanticPlan.targetIdentity,
    repository: { id: `local:${randomUUID()}`, name: plan.semanticPlan.successor.projectName, defaultBranch: 'develop' },
    activeChange: plan.semanticPlan.successor.activeChange,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases, createdAt: timestamp, updatedAt: timestamp
  });
  const journal = validateMigrationJournal({
    schemaVersion: 1, laneId: plan.semanticPlan.laneId, snapshotId: plan.index.snapshotId,
    historyIndexPathParts: activationHistoryIndexPathParts(plan.index.snapshotId), historyIndexDigest: plan.indexDigest,
    sourceIdentity: plan.index.sourceIdentity, targetIdentity: successor.identity, approvedPlanFingerprint,
    successor: { repositoryId: successor.repository.id, createdAt: timestamp },
    transaction: { status: 'committed', committedAt: timestamp },
    revalidation: {
      status: 'pending', updatedAt: timestamp,
      phases: plan.semanticPlan.revalidationPhaseIds.map((phaseId) =>
        ({ phaseId, status: 'pending', evidenceIds: [], blockers: [] })),
      nextAction: 'Revalidate only the approved local operations; historical success and approvals are not current proof.'
    }
  });
  const mutations: ActivationHistoryMutation[] = [];
  if (plan.historyDisposition === 'create') {
    for (const file of plan.index.files) {
      const source = plan.inventory.files.find((entry) => historyPathKey(entry.pathParts) === historyPathKey(file.originalPathParts));
      if (source === undefined) historyFail(historyPathKey(file.originalPathParts), 'source is absent from the reviewed inventory.');
      mutations.push({
        type: 'write', pathParts: [...file.copyPathParts], content: Buffer.from(source.content),
        mode: plan.semanticPlan.targetModes.historyCopy
      });
    }
    mutations.push({
      type: 'write', pathParts: activationHistoryIndexPathParts(plan.index.snapshotId),
      content: Buffer.from(plan.indexContent), mode: plan.semanticPlan.targetModes.historyIndex
    });
  }
  for (const retirement of plan.requiredRetirements) mutations.push({ type: 'delete', pathParts: [...retirement.pathParts] });
  mutations.push(
    {
      type: 'write', pathParts: [...historicalActivationStatePathParts], content: canonicalJson(successor),
      mode: plan.semanticPlan.targetModes.successorState
    },
    {
      type: 'write', pathParts: [...migrationStateFilePathParts], content: canonicalJson(journal),
      mode: plan.semanticPlan.targetModes.migrationJournal
    }
  );
  return { successor, journal, mutations, preconditions: plan.preconditions, requiredRetirements: plan.requiredRetirements };
}
