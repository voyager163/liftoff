import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import {
  phaseIds, type BootstrapStateRetention, type PhaseId, type UserActivationState
} from '../domain/governance/activation/types.js';
import { validateApprovalEnvelope, validateUserActivationState } from '../domain/governance/activation/validators.js';
import { evidenceBodyDigest } from '../domain/governance/activation/evidence.js';
import { activationStateSchemaVersion, isHistoricalActivationIdentity, isHistoricalV2ActivationIdentity } from '../domain/governance/policy/identity.js';
import { parseManifest } from '../application/project/manifest.js';
import { FileSystemError } from '../domain/project/errors.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import {
  packagedActivationSuccessorMigrations, type ActivationSuccessorMigrationId
} from './compatibility.js';
import {
  ActivationHistoryError, activationHistoryCopyPathParts, activationHistoryIndexPathParts,
  activationHistorySnapshotId, activationHistoryTargetModes, historicalActivationStatePathParts, historicalManifestPathParts,
  historyCaseKey, historyDigest, historyFail, historyPathKey, historyRecordId, historyTimestamp, migrationStateFilePathParts,
  migrationRevalidationPhaseIds, migrationTargetIdentity, parseHistoryJson, rawHistoryDigest, validateActivationHistoryIndex,
  validateMigrationJournal, type ActivationHistoryIndex, type MigrationJournal
} from './history-contracts.js';
import {
  captureHistoryFile, historicalActiveRecordPaths, readHistoricalActivationInventory, readHistoricalSnapshotInventory,
  resolveHistoryProjectPath, validateReadableHistoricalActivationState, validateHistoricalSourceManifest,
  type HistoricalActivationInventory, type HistoricalInventoryOptions
} from './historical-state.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './proof-records.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import type { HistoricalGovernanceChangeMetadata } from './historical-source-metadata.js';
import {
  createSourceHistoryCapture, copyHistoryBuffer, copySourceHistoryData, copySourceHistoryPath,
  copySourceInventoryOptions, copySourceHistoryObservations, sourceObservationIdentities
} from './source-history-capture.js';
import {
  createReleasedSourceHistoryIndex, validateFrozenActivationHistoryIndex, validateFrozenV3SourceIndex,
  historicalMetadataPathParts, historicalSourceChangePathParts, type FrozenV3SourceIndexV1
} from './history-contracts.js';
import {
  validateCapturedReleasedSource, validatePlannedReleasedSourceSnapshot, validateCapturedHistoricalSnapshot,
  assertCapturedHistoricalAncestor, assertCapturedV3SourceAncestor, assertCapturedV3MetadataAncestry,
  type ReleasedSourceInventory, type FrozenV3SourceInventory
} from './historical-state.js';
import { isReleasedV3ActivationIdentity, type ReleasedActivationIdentity } from '../domain/governance/policy/identity.js';
import { validateHistoricalV3ActivationState } from './historical-v3.js';
import { createModernHistoryContract, validateSuccessorPreparation, isProtectedSourceAnchor,
  type ModernMigrationJournalV2, type ModernSemanticTransitionInput, type SuccessorPreparationV1 } from './modern-history-contracts.js';
import { assertModernRecordData } from '../domain/governance/activation/source-values.js';
import { buildModernManagedCore, type ModernManagedCoreInput } from '../application/project/modern-managed-core.js';
import { createManifestV8Candidate, type ManagedManifestDecision, type ManifestV8Candidate } from '../application/project/manifest-writer.js';
import { createManifestV8Reader } from '../domain/project/manifest/v8.js';
import { resolveModernManifestV8SourceContract } from '../application/project/manifest.js';
import { projectCatalog } from '../application/project/catalog.js';
import { createManifestV8ProjectReader } from '../domain/project/manifest/v8-project.js';
import { manifestActiveLayoutDigest } from '../domain/project/manifest/layout.js';
import { createModernCompatibilityContract } from './modern-compatibility.js';
import { createModernActivationRecordContract } from '../domain/governance/activation/modern-records.js';
import type { ModernActivationSourceInput, ModernActivationState } from '../domain/governance/activation/modern-record-contracts.js';
import { historyExact, historyRecord, historyPathParts } from './history-contracts.js';
import type { ManifestSourceHistoryReference } from '../domain/project/manifest/history.js';

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
  laneId: ActivationSuccessorMigrationId;
  sourceIdentity: ActivationHistoryIndex['sourceIdentity'];
  targetIdentity: UserActivationState['identity'];
  historyIndex: ActivationHistoryIndex;
  historyIndexDigest: string;
  historyDisposition: 'create' | 'reuse';
  preconditions: HistoryPreconditionIdentity[];
  requiredRetirements: HistoricalRetirement[];
  revalidationPhaseIds: typeof migrationRevalidationPhaseIds;
  targetModes: typeof activationHistoryTargetModes;
  ancestorHistory: HistoricalAncestorReference[];
  lifecycleObligations: HistoricalLifecycleObligation[];
  successor: {
    statePathParts: string[];
    journalPathParts: string[];
    policy: 'preserve-valid-local-anchor-no-inherited-proof';
    localRepositoryId: string | null;
    projectName: string;
    activeChange: null;
    sourceActiveChange: UserActivationState['activeChange'];
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
  | {
      status: 'committed'; journal: MigrationJournal; index: ActivationHistoryIndex; state: UserActivationState;
      ancestorHistory: HistoricalAncestorReference[];
      lifecycleObligations: HistoricalLifecycleObligation[];
      historicalSources: HistoricalGovernanceSource[];
      preconditions: ProjectFileSnapshot[];
    };

export interface HistoricalAncestorReference {
  snapshotId: string;
  sourceIdentity: ActivationHistoryIndex['sourceIdentity'];
  historyIndexPathParts: string[];
  historyIndexDigest: string;
}

export interface HistoricalGovernanceSource {
  snapshotId: string;
  sourceIdentity: ActivationHistoryIndex['sourceIdentity'];
  activeChange: NonNullable<UserActivationState['activeChange']>;
  metadata: HistoricalGovernanceChangeMetadata | null;
  metadataCopyPathParts: string[] | null;
  metadataDigest: string | null;
}

function historicalSources(index: ActivationHistoryIndex, inventory: HistoricalActivationInventory): HistoricalGovernanceSource[] {
  if (!inventory.state.activeChange) return [];
  const metadata = index.files.find((file) => file.kind === 'source-metadata');
  return [{
    snapshotId: index.snapshotId,
    sourceIdentity: inventory.sourceChangeMetadata?.activationIdentity ?? index.sourceIdentity,
    activeChange: { ...inventory.state.activeChange },
    metadata: inventory.sourceChangeMetadata ?? null,
    metadataCopyPathParts: metadata ? [...metadata.copyPathParts] : null,
    metadataDigest: metadata?.digest ?? null
  }];
}

export interface HistoricalLifecycleObligation {
  snapshotId: string;
  sourceIdentity: ActivationHistoryIndex['sourceIdentity'];
  repositoryId: string;
  retention: BootstrapStateRetention;
  verification: 'required';
  authority: 'historical-protection-only';
}

function validLocalAnchor(value: string): boolean {
  return /^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

function lifecycleObligations(
  index: ActivationHistoryIndex, inventory: HistoricalActivationInventory
): HistoricalLifecycleObligation[] {
  return inventory.state.bootstrapState ? [{
    snapshotId: index.snapshotId, sourceIdentity: index.sourceIdentity,
    repositoryId: inventory.state.repository.id,
    retention: structuredClone(inventory.state.bootstrapState),
    verification: 'required', authority: 'historical-protection-only'
  }] : [];
}

/** Consumers must retain these safety blockers until separately authorized current lifecycle binding. */
export function historicalLifecyclePhaseBlockers(
  obligations: readonly HistoricalLifecycleObligation[]
): Partial<Record<PhaseId, string[]>> {
  if (!obligations.length) return {};
  const blockers = obligations.map((obligation) => obligation.retention.status === 'disposed'
    ? `History ${obligation.snapshotId} records disposed bootstrap material; identity migration cannot recreate it or its keys. Current lifecycle verification is separate.`
    : `History ${obligation.snapshotId} retains bootstrap material from ${obligation.retention.retainedAt} until ${obligation.retention.disposeAfter}; it must not be reused for ordinary plan/apply or disposed under migration approval. Verify ownership through separate lifecycle planning.`);
  return Object.fromEntries(['bootstrap-local', 'remote-import-verified', 'bootstrap-state-disposed'].map((id) => [id, [...blockers]]));
}

function requireContent(snapshot: ProjectFileSnapshot, detail: string): Buffer {
  if (snapshot.content === undefined) historyFail(historyPathKey(snapshot.pathParts), detail, 'missing-history-record');
  return snapshot.content;
}

function currentState(value: unknown, location: string): UserActivationState {
  assertSafeHistoricalRecord(value, location);
  try { return validateUserActivationState(value); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== 'Error') throw error;
    return historyFail(location, `invalid current successor: ${error.message}`, 'invalid-migration-successor');
  }
}

function currentManifestIdentity(value: unknown, location: string): void {
  assertSafeHistoricalRecord(value, location);
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

function uniqueHistoryPreconditions(preconditions: readonly ProjectFileSnapshot[]): ProjectFileSnapshot[] {
  const unique = new Map<string, ProjectFileSnapshot>();
  for (const snapshot of preconditions) {
    const key = historyCaseKey(snapshot.pathParts);
    const previous = unique.get(key);
    if (previous && (historyPathKey(previous.pathParts) !== historyPathKey(snapshot.pathParts) ||
      previous.mode !== snapshot.mode || (previous.content === undefined
        ? snapshot.content !== undefined : snapshot.content === undefined || !previous.content.equals(snapshot.content)))) {
      historyFail(historyPathKey(snapshot.pathParts), 'protected bytes, path casing or modes changed during inspection.', 'historical-source-changed');
    }
    unique.set(key, snapshot);
  }
  return [...unique.values()];
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
): Promise<{ index: ActivationHistoryIndex; content: Buffer; digest: string; snapshot: ProjectFileSnapshot }> {
  const parts = activationHistoryIndexPathParts(snapshotId);
  const snapshot = await captureHistoryFile(projectRoot, parts);
  const content = requireContent(snapshot, 'declared historical index is missing.');
  const index = validateActivationHistoryIndex(parseHistoryJson(content, historyPathKey(parts)));
  if (index.snapshotId !== snapshotId) historyFail(historyPathKey(parts), 'index declares another snapshot.', 'history-digest-mismatch');
  return { index, content, digest: rawHistoryDigest(content), snapshot };
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

async function inspectAncestorHistory(projectRoot: string, inventory: HistoricalActivationInventory) {
  const journal = inventory.sourceMigration;
  if (!journal) return { references: [], obligations: [], preconditions: [], historicalSources: [] };
  const loaded = await readActivationHistoryIndex(projectRoot, journal.snapshotId);
  if (loaded.index.files.some((file) => !['manifest', 'state', 'metadata', 'evidence', 'plan', 'approval'].includes(file.kind))) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'the published v1-to-v2 history contract does not contain these record roles.', 'unsupported-historical-record');
  }
  if (loaded.digest !== journal.historyIndexDigest ||
    canonicalSha256(loaded.index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'ancestor index digest or source contract contradicts the preserved migration.', 'history-digest-mismatch');
  }
  const copies = await verifyHistoryCopies(projectRoot, loaded.index);
  const source = await readHistoricalSnapshotInventory(projectRoot, loaded.index);
  if (source.sourceMigration) historyFail('ancestor history', 'published v1 history cannot contain another migration.', 'invalid-historical-reference');
  if (inventory.sourceChangeMetadata &&
    canonicalSha256(inventory.sourceChangeMetadata.activationIdentity) !== canonicalSha256(inventory.state.identity) &&
    (canonicalSha256(inventory.sourceChangeMetadata.activationIdentity) !== canonicalSha256(source.state.identity) ||
      canonicalSha256(inventory.state.activeChange) !== canonicalSha256(source.state.activeChange))) {
    historyFail('ancestor history', 'historical source metadata is not bound to the preserved ancestor pointer.', 'invalid-historical-reference');
  }
  return {
    references: [{
      snapshotId: loaded.index.snapshotId, sourceIdentity: loaded.index.sourceIdentity,
      historyIndexPathParts: [...journal.historyIndexPathParts], historyIndexDigest: loaded.digest
    }],
    obligations: lifecycleObligations(loaded.index, source),
    historicalSources: historicalSources(loaded.index, source),
    preconditions: [loaded.snapshot, ...copies]
  };
}

export async function activeActivationRecordsWithoutState(projectRoot: string): Promise<string[][]> {
  const records: string[][] = [];
  for (const directory of ['evidence', 'plans', 'approvals', 'reconciliation']) {
    records.push(...await historicalActiveRecordPaths(projectRoot, directory));
  }
  const supersessionPaths = await historicalActiveRecordPaths(projectRoot, 'supersessions');
  for (const parts of supersessionPaths) {
    const file = await captureHistoryFile(projectRoot, parts);
    if (!file.content) continue;
    try {
      const parsed = JSON.parse(file.content.toString('utf8'));
      if (parsed.schemaVersion !== currentActivationIdentity.supersessionSchemaVersion ||
        canonicalSha256(parsed.identity) !== canonicalSha256(currentActivationIdentity)) {
        records.push(parts);
      }
    } catch {
      records.push(parts);
    }
  }
  for (const parts of [
    [...migrationStateFilePathParts], ['governance', 'credentials', 'preflight-policy.json'], ['governance', 'activation-baseline.json']
  ]) {
    if ((await captureHistoryFile(projectRoot, parts)).content !== undefined) records.push(parts);
  }
  return records;
}

export async function verifyActivationHistoryBeforeReplacement(
  projectRoot: string,
  plan: { index: ActivationHistoryIndex | FrozenV3SourceIndexV1; indexDigest: string },
  mutation: { pathParts: readonly string[] }
): Promise<void> {
  const original = plan.index.files.find((file) =>
    historyPathKey(file.originalPathParts) === historyPathKey(mutation.pathParts));
  if (!original) return;
  const index = await captureHistoryFile(projectRoot, activationHistoryIndexPathParts(plan.index.snapshotId));
  const copy = await captureHistoryFile(projectRoot, original.copyPathParts);
  if (!index.content || rawHistoryDigest(index.content) !== plan.indexDigest ||
    !copy.content || rawHistoryDigest(copy.content) !== original.digest) {
    historyFail(historyPathKey(mutation.pathParts), 'original bytes and their completed history index must be verified before replacement or retirement.', 'history-preservation-failed');
  }
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
      await assertGovernanceApprovalIssued(projectRoot, approval);
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
  const stateSnapshot = await captureHistoryFile(projectRoot, historicalActivationStatePathParts);
  if (journal === undefined) {
    if (stateSnapshot.content) {
      const raw = parseHistoryJson(stateSnapshot.content, historyPathKey(stateSnapshot.pathParts));
      if (isRecord(raw) && Object.hasOwn(raw, 'successorHistory')) {
        currentState(raw, historyPathKey(stateSnapshot.pathParts));
        historyFail(historyPathKey(migrationStateFilePathParts), 'the current successor declares a missing migration journal.', 'missing-migration-journal');
      }
    }
    return { status: 'none' };
  }
  const state = currentState(parseHistoryJson(requireContent(stateSnapshot, 'committed successor state is missing.'),
    historyPathKey(stateSnapshot.pathParts)), historyPathKey(stateSnapshot.pathParts));
  const link = state.successorHistory;
  if (!link || link.snapshotId !== journal.snapshotId || link.historyIndexDigest !== journal.historyIndexDigest ||
    historyPathKey(link.journalPathParts) !== historyPathKey(migrationStateFilePathParts) ||
    historyPathKey(link.historyIndexPathParts) !== historyPathKey(journal.historyIndexPathParts)) {
    historyFail(historyPathKey(stateSnapshot.pathParts), 'successor history backlink is missing or contradicts the committed journal.', 'invalid-migration-successor');
  }
  const loaded = await readActivationHistoryIndex(projectRoot, journal.snapshotId);
  if (loaded.digest !== journal.historyIndexDigest ||
    canonicalSha256(loaded.index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'index digest or source identity contradicts the migration journal.', 'history-digest-mismatch');
  }
  const copies = await verifyHistoryCopies(projectRoot, loaded.index);
  const source = await readHistoricalSnapshotInventory(projectRoot, loaded.index);
  if (canonicalSha256(link.sourceActiveChange) !== canonicalSha256(source.state.activeChange)) {
    historyFail(historyPathKey(stateSnapshot.pathParts), 'sourceActiveChange contradicts the exact archived source pointer.', 'invalid-migration-successor');
  }
  if (source.state.activeChange && !source.sourceChangeMetadata) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'the successor lacks its required preserved source-change metadata and tasks.', 'missing-historical-record');
  }
  const ancestors = await inspectAncestorHistory(projectRoot, source);
  if (canonicalSha256(state.identity) !== canonicalSha256(journal.targetIdentity) ||
    state.repository.id !== journal.successor.repositoryId || state.createdAt !== journal.successor.createdAt) {
    historyFail(historyPathKey(stateSnapshot.pathParts), 'active successor identity or stable local anchor contradicts the journal.', 'invalid-migration-successor');
  }
  if (validLocalAnchor(source.state.repository.id) && source.state.repository.id !== state.repository.id) {
    historyFail(historyPathKey(stateSnapshot.pathParts), 'successor replaced a valid protected source-local anchor.', 'invalid-migration-successor');
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
  return {
    status: 'committed', journal, index: loaded.index, state,
    ancestorHistory: ancestors.references,
    lifecycleObligations: [...lifecycleObligations(loaded.index, source), ...ancestors.obligations],
    historicalSources: [...historicalSources(loaded.index, source), ...ancestors.historicalSources],
    preconditions: [
      await captureHistoryFile(projectRoot, migrationStateFilePathParts),
      loaded.snapshot,
      ...copies, ...ancestors.preconditions
    ]
  };
}

/** Project-read-only. This creates neither mutations nor approval, runtime IDs or timestamps. */
export async function planActivationHistoryMigration(
  projectRoot: string, options: HistoricalInventoryOptions = {}
): Promise<ActivationHistoryMigrationPlan> {
  try {
    const stateSnapshot = await captureHistoryFile(projectRoot, historicalActivationStatePathParts);
    const journalSnapshot = await captureHistoryFile(projectRoot, migrationStateFilePathParts);
    if (stateSnapshot.content === undefined) {
      const orphaned = await activeActivationRecordsWithoutState(projectRoot);
      if (orphaned.length > 0) {
        historyFail(historyPathKey(stateSnapshot.pathParts),
          `required activation state is missing while active records remain: ${orphaned.map(historyPathKey).join(', ')}.`,
          'missing-historical-record');
      }
      return { status: 'not-present' };
    }
    const raw = parseHistoryJson(stateSnapshot.content, historyPathKey(stateSnapshot.pathParts));
    if (journalSnapshot.content !== undefined && !(isRecord(raw) && isHistoricalV2ActivationIdentity(raw.identity))) {
      const history = await inspectActivationMigrationHistory(projectRoot);
      if (history.status !== 'committed') historyFail('migration-state.json', 'declared journal disappeared during inspection.');
      return { status: 'current', state: history.state, history };
    }
    if (isRecord(raw) && raw.schemaVersion === activationStateSchemaVersion) {
      const state = currentState(raw, historyPathKey(stateSnapshot.pathParts));
      migrationTargetIdentity(state.identity, 'activation-state.json.identity');
      const manifest = await captureHistoryFile(projectRoot, historicalManifestPathParts);
      currentManifestIdentity(parseHistoryJson(requireContent(manifest, 'active manifest is missing.'), historyPathKey(manifest.pathParts)),
        historyPathKey(manifest.pathParts));
      await inspectActiveProofRecords(projectRoot, state);
      return { status: 'current', state, history: await inspectActivationMigrationHistory(projectRoot) };
    }
    if (!isRecord(raw) || !isHistoricalActivationIdentity(raw.identity) ||
      raw.schemaVersion !== raw.identity.activationStateSchemaVersion) {
      historyFail(historyPathKey(stateSnapshot.pathParts), 'only exact versioned historical v1/v2 representations have a successor lane.', 'unsupported-historical-identity');
    }
    const lane = packagedActivationSuccessorMigrations().find((entry) =>
      canonicalSha256(entry.fromIdentity) === canonicalSha256(raw.identity) &&
      canonicalSha256(entry.toIdentity) === canonicalSha256(currentActivationIdentity));
    if (lane === undefined) historyFail(historyPathKey(stateSnapshot.pathParts), 'no exact packaged successor lane exists.', 'unsupported-historical-identity');
    const inventory = await readHistoricalActivationInventory(projectRoot, options);
    if (canonicalSha256(inventory.state.identity) !== canonicalSha256(lane.fromIdentity) ||
      !inventory.files.find((file) => file.kind === 'state')?.content.equals(stateSnapshot.content)) {
      historyFail(historyPathKey(stateSnapshot.pathParts), 'source changed during preview; obtain a fresh check.', 'historical-source-changed');
    }
    if (inventory.unreviewedRecords.length > 0) {
      return {
        status: 'blocked', reasonCode: 'unreviewed-historical-records',
        issues: inventory.unreviewedRecords.map((file) =>
          `${historyPathKey(file.pathParts)}: recognized unreferenced historical record must be explicitly included in the reviewed inventory before active proof can be separated.`),
        unreviewedPathParts: inventory.unreviewedRecords.map((file) => [...file.pathParts])
      };
    }
    const ancestors = await inspectAncestorHistory(projectRoot, inventory);
    const sourceFiles = inventory.files.map((file) => ({
      kind: file.kind, originalPathParts: [...file.pathParts], digest: file.digest, mode: file.mode
    }));
    const snapshotId = activationHistorySnapshotId(inventory.state.identity, sourceFiles);
    const index = validateActivationHistoryIndex({
      schemaVersion: 1, snapshotId, sourceIdentity: inventory.state.identity,
      files: sourceFiles.map((file) => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
    });
    let indexContent: Buffer = Buffer.from(canonicalJson(index), 'utf8');
    let indexDigest = rawHistoryDigest(indexContent);
    const indexPath = activationHistoryIndexPathParts(snapshotId);
    const indexSnapshot = await captureHistoryFile(projectRoot, indexPath);
    const preconditions = uniqueHistoryPreconditions([...inventory.preconditions, ...ancestors.preconditions, journalSnapshot, indexSnapshot]);
    let historyDisposition: 'create' | 'reuse' = 'create';
    if (indexSnapshot.content !== undefined) {
      const existing = validateActivationHistoryIndex(parseHistoryJson(indexSnapshot.content, historyPathKey(indexPath)));
      if (canonicalSha256(existing) !== canonicalSha256(index)) {
        historyFail(historyPathKey(indexPath), 'existing immutable snapshot differs; force cannot replace history.', 'historical-destination-conflict');
      }
      preconditions.push(...await verifyHistoryCopies(projectRoot, index));
      indexContent = indexSnapshot.content;
      indexDigest = rawHistoryDigest(indexContent);
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
    const requiredRetirements = index.files.filter((file) =>
      ['evidence', 'plan', 'approval', 'supersession', 'reconciliation', 'credential-policy'].includes(file.kind)).map((file) => ({
      pathParts: [...file.originalPathParts], digest: file.digest, copyPathParts: [...file.copyPathParts]
    }));
    const semanticPlan: HistoricalMigrationSemanticPlan = {
      schemaVersion: 1, kind: 'activation-history-successor', projectRoot: await realpath(projectRoot),
      laneId: lane.id, sourceIdentity: index.sourceIdentity, targetIdentity: { ...currentActivationIdentity },
      historyIndex: index, historyIndexDigest: indexDigest, historyDisposition,
      preconditions: preconditionIdentities(preconditions), requiredRetirements,
      revalidationPhaseIds: [...migrationRevalidationPhaseIds],
      targetModes: { ...activationHistoryTargetModes },
      ancestorHistory: ancestors.references,
      lifecycleObligations: [...lifecycleObligations(index, inventory), ...ancestors.obligations],
      successor: {
        statePathParts: [...historicalActivationStatePathParts], journalPathParts: [...migrationStateFilePathParts],
        policy: 'preserve-valid-local-anchor-no-inherited-proof',
        localRepositoryId: validLocalAnchor(inventory.state.repository.id) ? inventory.state.repository.id : null,
        projectName: inventory.manifest.project.name,
        activeChange: null, sourceActiveChange: inventory.state.activeChange
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
  const retirements = plan.index.files.filter((file) =>
    ['evidence', 'plan', 'approval', 'supersession', 'reconciliation', 'credential-policy'].includes(file.kind)).map((file) => ({
    pathParts: file.originalPathParts, digest: file.digest, copyPathParts: file.copyPathParts
  }));
  if (canonicalSha256(plan.semanticPlan) !== plan.planDigest ||
    canonicalSha256(preconditionIdentities(plan.preconditions)) !== canonicalSha256(plan.semanticPlan.preconditions) ||
    canonicalSha256(plan.index) !== canonicalSha256(plan.semanticPlan.historyIndex) ||
    canonicalSha256(parseHistoryJson(plan.indexContent, 'planned history index')) !== canonicalSha256(plan.index) ||
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
  const sourceState = plan.inventory.files.find((file) => file.kind === 'state');
  const sourceManifest = plan.inventory.files.find((file) => file.kind === 'manifest');
  if (!sourceState || !sourceManifest) historyFail('migration plan', 'required source records are missing.', 'historical-plan-changed');
  const originalState = validateReadableHistoricalActivationState(parseHistoryJson(sourceState.content, 'source state'));
  const originalManifest = validateHistoricalSourceManifest(parseHistoryJson(sourceManifest.content, 'source manifest'));
  const expectedAnchor = validLocalAnchor(originalState.repository.id) ? originalState.repository.id : null;
  const lane = packagedActivationSuccessorMigrations().find((entry) => entry.id === plan.semanticPlan.laneId);
  if (!lane || canonicalSha256(lane.fromIdentity) !== canonicalSha256(plan.index.sourceIdentity) ||
    canonicalSha256(lane.toIdentity) !== canonicalSha256(plan.semanticPlan.targetIdentity) ||
    canonicalSha256(originalState) !== canonicalSha256(plan.inventory.state) ||
    canonicalSha256(originalManifest) !== canonicalSha256(plan.inventory.manifest) ||
    plan.semanticPlan.successor.localRepositoryId !== expectedAnchor ||
    plan.semanticPlan.successor.projectName !== originalManifest.project.name ||
    plan.semanticPlan.successor.activeChange !== null ||
    canonicalSha256(plan.semanticPlan.successor.sourceActiveChange) !== canonicalSha256(originalState.activeChange)) {
    historyFail('migration plan', 'source mapping differs from the exact reviewed source bytes.', 'historical-plan-changed');
  }
  const phases = Object.fromEntries(phaseIds.map((id) => [id, {
    state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: []
  }]));
  const successor = validateUserActivationState({
    schemaVersion: activationStateSchemaVersion, identity: plan.semanticPlan.targetIdentity,
    repository: { id: expectedAnchor ?? `local:${randomUUID()}`, name: plan.semanticPlan.successor.projectName, defaultBranch: 'develop' },
    activeChange: plan.semanticPlan.successor.activeChange,
    successorHistory: {
      schemaVersion: 1, snapshotId: plan.index.snapshotId,
      journalPathParts: [...migrationStateFilePathParts],
      historyIndexPathParts: activationHistoryIndexPathParts(plan.index.snapshotId),
      historyIndexDigest: plan.indexDigest,
      sourceActiveChange: originalState.activeChange
    },
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

export interface ModernSourceAncestor {
  readonly indexContent: Buffer;
  readonly indexPathParts: readonly string[];
  readonly copies: readonly ProjectFileSnapshot[];
}
export interface ModernSuccessorSource {
  readonly projectRoot: string;
  readonly captures: readonly ProjectFileSnapshot[];
  readonly originalPaths: readonly (readonly string[])[];
  readonly indexContent: Buffer;
  readonly historyDisposition: 'create' | 'reuse';
  readonly ancestors: readonly ModernSourceAncestor[];
  readonly sourceBinding: string;
}
export type ModernSuccessorTarget = ModernManagedCoreInput & { readonly managed: readonly ManagedManifestDecision[] };
export interface ModernActivationSuccessorPlan {
  readonly source: ModernSuccessorSource;
  readonly target: ModernSuccessorTarget;
  readonly manifest: ManifestV8Candidate;
  readonly semanticInput: ModernSemanticTransitionInput;
  readonly semanticTransitionDigest: string;
  readonly preparationSourceBinding: string;
  readonly planBinding: string;
}
export interface ReleasedSourceLifecycleObligation {
  readonly snapshotId: string;
  readonly sourceIdentity: ReleasedActivationIdentity;
  readonly repositoryId: string;
  readonly retention: BootstrapStateRetention;
  readonly authority: 'historical-protection-only';
}
export interface PreparedModernActivationSuccessor {
  readonly semanticTransitionDigest: string;
  readonly preparation: SuccessorPreparationV1;
  readonly successor: ModernActivationState;
  readonly journal: ModernMigrationJournalV2;
  readonly manifestBytes: Buffer;
  readonly manifestDigest: string;
  readonly mutations: readonly ActivationHistoryMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
  readonly requiredRetirements: readonly HistoricalRetirement[];
  readonly lifecycleObligations: readonly ReleasedSourceLifecycleObligation[];
}
const sourceCollections = ['evidence', 'plans', 'approvals', 'supersessions', 'reconciliation'] as const;
const originalStatePath = ['governance', 'activation-state.json'];
const originalJournalPath = ['governance', 'migration-state.json'];
const originalManifestPath = ['liftoff.manifest.json'];
const modernManifestReader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });

function sourceIndex(value: unknown): ActivationHistoryIndex | FrozenV3SourceIndexV1 {
  assertModernRecordData(value, 'source index');
  const item = historyRecord(value, 'source index');
  return isReleasedV3ActivationIdentity(item.sourceIdentity) ? validateFrozenV3SourceIndex(value) : validateFrozenActivationHistoryIndex(value);
}
function releasedState(content: Buffer) {
  const raw = parseHistoryJson(content, 'source state'), item = historyRecord(raw, 'source state');
  return isReleasedV3ActivationIdentity(item.identity) ? validateHistoricalV3ActivationState(raw) : validateReadableHistoricalActivationState(raw);
}
function originalObservation(captures: readonly ProjectFileSnapshot[], parts: readonly string[]): ProjectFileSnapshot {
  const found = captures.find(file => historyPathKey(file.pathParts) === historyPathKey(parts));
  if (!found) historyFail(historyPathKey(parts), 'independent physical observation is missing.', 'missing-historical-record');
  return found;
}
function v3Inventory(inventory: ReleasedSourceInventory): inventory is FrozenV3SourceInventory {
  return inventory.state.schemaVersion === 3;
}
function sourceOnlyBinding(source: Omit<ModernSuccessorSource, 'sourceBinding'>): string {
  return canonicalSha256({
    projectRoot: source.projectRoot, captures: sourceObservationIdentities(source.captures), originalPaths: source.originalPaths,
    indexDigest: rawHistoryDigest(source.indexContent), historyDisposition: source.historyDisposition,
    ancestors: source.ancestors.map(ancestor => ({
      indexPathParts: ancestor.indexPathParts, indexDigest: rawHistoryDigest(ancestor.indexContent),
      copies: sourceObservationIdentities(ancestor.copies)
    }))
  });
}

/** Captures source data and destinations only; no target renderer, clock, UUID or effect authority. */
export async function readModernActivationSuccessorSource(
  projectRoot: string, options: HistoricalInventoryOptions = {}
): Promise<ModernSuccessorSource> {
  options = copySourceInventoryOptions(options);
  const reader = await createSourceHistoryCapture(projectRoot);
  const originalState = await reader.capture(originalStatePath), state = releasedState(originalState.content);
  const paths: string[][] = [originalStatePath, originalJournalPath, ...historicalMetadataPathParts.map(parts => [...parts]),
    ['governance', 'credentials', 'preflight-policy.json'], ['governance', 'activation-baseline.json']];
  if (state.activeChange) {
    const base = historicalSourceChangePathParts(state.activeChange);
    paths.push([...base, 'liftoff-governance.json'], [...base, 'tasks.md']);
  }
  const collections = new Map<string, string[][]>();
  for (const directory of sourceCollections) {
    const listed = await reader.recordPaths(directory);
    collections.set(directory, listed); paths.push(...listed);
  }
  for (const parts of paths.slice(1)) await reader.capture(parts, true);
  const ancestors: ModernSourceAncestor[] = [];
  let journalBytes = originalObservation(reader.observations(), originalJournalPath).content;
  let expectedState = state;
  // A nonempty manifest remains unread until after optional empty files and ancestor capture.
  while (journalBytes) {
    if (ancestors.length >= 2) historyFail('source ancestry', 'exceeds the exact three-source contract.', 'invalid-historical-reference');
    const raw = historyRecord(parseHistoryJson(journalBytes, 'source migration'), 'source migration');
    const indexParts = historyPathParts(raw.historyIndexPathParts, 'source index');
    const snapshotId = historyDigest(raw.snapshotId, 'source snapshot');
    if (indexParts.join('/') !== `governance/history/${snapshotId}/index.json`) historyFail('source index', 'is outside its exact history location.');
    if (ancestors.some(ancestor => historyPathKey(ancestor.indexPathParts) === historyPathKey(indexParts))) historyFail('source ancestry', 'contains a cycle.');
    const capture = await reader.capture(indexParts);
    if (rawHistoryDigest(capture.content) !== historyDigest(raw.historyIndexDigest, 'source index digest')) historyFail('source index', 'differs from its original journal.', 'history-digest-mismatch');
    const index = validateFrozenActivationHistoryIndex(parseHistoryJson(capture.content, 'ancestor index'));
    if (index.snapshotId !== snapshotId) historyFail('ancestor index', 'names a different snapshot.');
    const copies: ProjectFileSnapshot[] = [];
    for (const file of [...index.files.filter(file => file.kind !== 'state'), ...index.files.filter(file => file.kind === 'state')]) copies.push(await reader.capture(file.copyPathParts));
    const inventory = await validateCapturedHistoricalSnapshot(index, copies);
    if (expectedState.schemaVersion === 1) historyFail('source ancestry', 'v1 cannot contain a successor journal.');
    ancestors.push({ indexContent: Buffer.from(capture.content), indexPathParts: [...indexParts], copies });
    expectedState = inventory.state;
    journalBytes = inventory.files.find(file => file.kind === 'migration')?.content;
  }
  await reader.capture(originalManifestPath);
  const inventory = await validateCapturedReleasedSource(reader.observations(), options);
  if (inventory.unreviewedRecords.length) historyFail('source records', 'recognized unreferenced records require explicit selection.', 'unreviewed-historical-records');
  const index = createReleasedSourceHistoryIndex(inventory.state.identity, inventory.files.map(file => ({
    kind: file.kind, originalPathParts: file.pathParts, digest: file.digest, mode: file.mode
  })));
  const indexPath = activationHistoryIndexPathParts(index.snapshotId);
  // Destination absence/read observations are still actual physical preconditions.
  const stored = await reader.capture(indexPath, true);
  let indexContent = Buffer.from(canonicalJson(index)), historyDisposition: 'create' | 'reuse' = 'create';
  if (stored.content !== undefined) {
    const existing = sourceIndex(parseHistoryJson(stored.content, 'existing source index'));
    if (existing.snapshotId !== index.snapshotId || canonicalSha256(existing.sourceIdentity) !== canonicalSha256(index.sourceIdentity)) {
      historyFail('existing source index', 'cannot replace an immutable source inventory.', 'historical-destination-conflict');
    }
    indexContent = Buffer.from(stored.content); historyDisposition = 'reuse';
    for (const entry of [...index.files.filter(file => file.kind !== 'state'), ...index.files.filter(file => file.kind === 'state')]) {
      const copy = await reader.capture(entry.copyPathParts);
      if (rawHistoryDigest(copy.content) !== entry.digest) historyFail('existing source copy', 'bytes differ from the original source.', 'history-digest-mismatch');
    }
  } else {
    await reader.assertAbsentDirectory(indexPath.slice(0, -1));
    for (const entry of index.files) {
      const copy = await reader.capture(entry.copyPathParts, true);
      if (copy.content !== undefined) historyFail('source destination', 'unindexed copy already exists.', 'historical-destination-conflict');
    }
  }
  for (const artifact of inventory.manifest.managedArtifacts) await reader.capture(artifact.pathParts, true);
  for (const directory of sourceCollections) {
    if (canonicalSha256(await reader.recordPaths(directory)) !== canonicalSha256(collections.get(directory))) {
      historyFail(directory, 'source collection changed during capture.', 'historical-source-changed');
    }
  }
  await reader.assertRoot();
  const partial = {
    projectRoot: reader.root, captures: reader.observations(), originalPaths: inventory.files.map(file => [...file.pathParts]),
    indexContent, historyDisposition, ancestors
  };
  const result = { ...partial, sourceBinding: sourceOnlyBinding(partial) };
  await validateModernSuccessorSource(result);
  return result;
}

async function validateModernSuccessorSource(value: ModernSuccessorSource) {
  // Buffers are separately validated/copied; all structural fields are hook-free JSON.
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) historyFail('source plan', 'requires original data.');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !['projectRoot', 'captures', 'originalPaths', 'indexContent', 'historyDisposition', 'ancestors', 'sourceBinding'].includes(key) ||
      !property?.enumerable || !Object.hasOwn(property, 'value')) historyFail('source plan', 'contains unsupported fields or hooks.');
  }
  assertModernRecordData({ projectRoot: value.projectRoot, originalPaths: value.originalPaths, historyDisposition: value.historyDisposition,
    sourceBinding: value.sourceBinding }, 'source plan metadata');
  const captures = copySourceHistoryObservations(value.captures);
  const originalIndexContent = copyHistoryBuffer(value.indexContent, 'planned index');
  const index = sourceIndex(parseHistoryJson(originalIndexContent, 'planned index'));
  if (value.historyDisposition !== 'create' && value.historyDisposition !== 'reuse') historyFail('source disposition', 'must be create or reuse.');
  const originals = value.originalPaths.map(parts => originalObservation(captures, parts));
  const inventory = await validatePlannedReleasedSourceSnapshot(index, originals);
  const indexCapture = originalObservation(captures, activationHistoryIndexPathParts(index.snapshotId));
  if (value.historyDisposition === 'create' ? indexCapture.content !== undefined :
    indexCapture.content === undefined || !indexCapture.content.equals(value.indexContent)) historyFail('source disposition', 'contradicts actual index observation.');
  for (const entry of index.files) {
    const copy = originalObservation(captures, entry.copyPathParts);
    if (value.historyDisposition === 'create' ? copy.content !== undefined :
      copy.content === undefined || rawHistoryDigest(copy.content) !== entry.digest) historyFail('source copy disposition', 'contradicts observed destination.');
  }
  if (!Array.isArray(value.ancestors) || Object.getPrototypeOf(value.ancestors) !== Array.prototype ||
    Reflect.ownKeys(value.ancestors).length !== value.ancestors.length + 1 || value.ancestors.length > 2) historyFail('source ancestry', 'requires a closed finite chain.');
  const inventories: ReleasedSourceInventory[] = [inventory], indexes: (ActivationHistoryIndex | FrozenV3SourceIndexV1)[] = [index];
  let previous = inventory;
  const seen = new Set([index.snapshotId]), plannedCopies: ProjectFileSnapshot[] = [
    { pathParts: activationHistoryIndexPathParts(index.snapshotId), content: Buffer.from(value.indexContent), mode: 0o600 },
    ...index.files.map(entry => ({ pathParts: entry.copyPathParts, content: Buffer.from(originalObservation(originals, entry.originalPathParts).content!), mode: 0o600 }))
  ];
  for (let i = 0; i < value.ancestors.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(value.ancestors, String(i));
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) historyFail('ancestor', 'cannot contain hooks.');
    const ancestor: ModernSourceAncestor = slot.value;
    if (typeof ancestor !== 'object' || ancestor === null || Object.getPrototypeOf(ancestor) !== Object.prototype ||
      Reflect.ownKeys(ancestor).length !== 3 || ['indexContent', 'indexPathParts', 'copies'].some(key => {
        const field = Object.getOwnPropertyDescriptor(ancestor, key); return !field?.enumerable || !Object.hasOwn(field, 'value');
      })) historyFail('ancestor', 'requires exactly captured index/path/copies.');
    assertModernRecordData(ancestor.indexPathParts, 'ancestor path');
    copyHistoryBuffer(ancestor.indexContent, 'ancestor index');
    const loaded = originalObservation(captures, ancestor.indexPathParts), journal = previous.sourceMigration;
    if (!journal || !loaded.content?.equals(ancestor.indexContent) ||
      rawHistoryDigest(ancestor.indexContent) !== journal.historyIndexDigest ||
      historyPathKey(ancestor.indexPathParts) !== historyPathKey(journal.historyIndexPathParts)) historyFail('ancestor', 'original journal/index link is missing or changed.');
    const ancestorIndex = validateFrozenActivationHistoryIndex(parseHistoryJson(ancestor.indexContent, 'ancestor index'));
    if (seen.has(ancestorIndex.snapshotId)) historyFail('ancestor', 'contains a repeated source.');
    seen.add(ancestorIndex.snapshotId);
    const copies = copySourceHistoryObservations(ancestor.copies);
    for (const copy of copies) {
      const original = originalObservation(captures, copy.pathParts);
      if (original.mode !== copy.mode || !original.content?.equals(copy.content!)) historyFail('ancestor copy', 'is not an actual captured observation.');
    }
    const source = await validateCapturedHistoricalSnapshot(ancestorIndex, copies);
    if (v3Inventory(previous)) assertCapturedV3SourceAncestor(previous, ancestorIndex, source);
    else assertCapturedHistoricalAncestor(previous, ancestorIndex, source);
    inventories.push(source); indexes.push(ancestorIndex); previous = source;
    plannedCopies.push(loaded, ...copies);
  }
  if (previous.sourceMigration) historyFail('source ancestry', 'declared original predecessor is missing.');
  if (inventory.state.schemaVersion === 3) assertCapturedV3MetadataAncestry(inventories);
  copySourceHistoryObservations(plannedCopies); // Independent admission includes the genuinely generated source index.
  if (sourceOnlyBinding(value) !== value.sourceBinding) historyFail('source binding', 'source bytes or observations changed after capture.', 'historical-source-changed');
  return { inventory, index, captures, inventories, indexes };
}

function candidateContext(candidate: ManifestV8Candidate): ModernActivationSourceInput {
  const manifest = modernManifestReader.parseManifestV8(parseHistoryJson(Buffer.from(candidate.content), 'target manifest'));
  if (manifest.governance.profile !== 'single-maintainer-gitflow' || manifest.project.specWorkflow === 'manual') {
    historyFail('target manifest', 'requires same-intent external single-maintainer governance.', 'unsupported-migration-target');
  }
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  const source = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile: manifest.governance.profile }, recordedPlugins: manifest.plugins });
  return { recordedIdentity: manifest.governance.activationIdentity, profile: manifest.governance.profile,
    policyVersion: manifest.governance.policyVersion, selection: { ...leaf, profile: manifest.governance.profile },
    pluginResolutionDigest: manifest.plugins.resolutionDigest,
    activeLayoutDigest: manifestActiveLayoutDigest(manifest.activeLayout, source.layoutDescriptor) };
}
function checkedPreparedPlan(value: ModernActivationSuccessorPlan): void {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) historyFail('prepared plan', 'requires own data.');
  const keys = ['source', 'target', 'manifest', 'semanticInput', 'semanticTransitionDigest', 'preparationSourceBinding', 'planBinding'];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !property?.enumerable || !Object.hasOwn(property, 'value');
  })) historyFail('prepared plan', 'contains unknown fields or hooks.');
  assertModernRecordData({ target: value.target, manifest: value.manifest, semanticInput: value.semanticInput,
    semanticTransitionDigest: value.semanticTransitionDigest, preparationSourceBinding: value.preparationSourceBinding,
    planBinding: value.planBinding }, 'prepared plan data');
}
function copyModernSource(source: ModernSuccessorSource): ModernSuccessorSource {
  const keys = ['projectRoot', 'captures', 'originalPaths', 'indexContent', 'historyDisposition', 'ancestors', 'sourceBinding'];
  if (typeof source !== 'object' || source === null || Object.getPrototypeOf(source) !== Object.prototype ||
    Reflect.ownKeys(source).length !== keys.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(source, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    })) historyFail('source plan', 'requires exactly original own-data fields without hooks.');
  const metadata = copySourceHistoryData({
    projectRoot: source.projectRoot, originalPaths: source.originalPaths,
    historyDisposition: source.historyDisposition, sourceBinding: source.sourceBinding
  }, 'source plan metadata');
  if (!Array.isArray(metadata.originalPaths) || metadata.originalPaths.length > 1024) {
    historyFail('source originals', 'requires at most 1024 original paths.', 'history-inspection-limit');
  }
  if (!Array.isArray(source.ancestors) || Object.getPrototypeOf(source.ancestors) !== Array.prototype ||
    Reflect.ownKeys(source.ancestors).length !== source.ancestors.length + 1 || source.ancestors.length > 2) {
    historyFail('source ancestry', 'requires a dense two-predecessor collection.');
  }
  const ancestors: ModernSourceAncestor[] = [];
  for (let i = 0; i < source.ancestors.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(source.ancestors, String(i));
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) historyFail('source ancestor', 'must not contain accessors or holes.');
    const ancestor: ModernSourceAncestor = slot.value;
    if (typeof ancestor !== 'object' || ancestor === null || Object.getPrototypeOf(ancestor) !== Object.prototype ||
      Reflect.ownKeys(ancestor).length !== 3 || ['indexContent', 'indexPathParts', 'copies'].some(key => {
        const property = Object.getOwnPropertyDescriptor(ancestor, key);
        return !property?.enumerable || !Object.hasOwn(property, 'value');
      })) historyFail('source ancestor', 'requires exactly captured own-data index, path and copies.');
    ancestors.push({
      indexContent: copyHistoryBuffer(ancestor.indexContent, 'source ancestor index'),
      indexPathParts: copySourceHistoryPath(ancestor.indexPathParts, 'source ancestor path'),
      copies: copySourceHistoryObservations(ancestor.copies)
    });
  }
  return {
    ...metadata, captures: copySourceHistoryObservations(source.captures),
    originalPaths: metadata.originalPaths.map(parts => copySourceHistoryPath(parts, 'source original path')),
    indexContent: copyHistoryBuffer(source.indexContent, 'source index'), ancestors
  };
}
function copyPreparedPlan(plan: ModernActivationSuccessorPlan): ModernActivationSuccessorPlan {
  checkedPreparedPlan(plan);
  const data = copySourceHistoryData({
    target: plan.target, manifest: plan.manifest, semanticInput: plan.semanticInput,
    semanticTransitionDigest: plan.semanticTransitionDigest, preparationSourceBinding: plan.preparationSourceBinding,
    planBinding: plan.planBinding
  }, 'prepared successor plan');
  return { ...data, source: copyModernSource(plan.source) };
}
/** Render only before admission/consent; returned literal bodies must thereafter be published unchanged. */
export async function planModernActivationSuccessor(
  source: ModernSuccessorSource, target: ModernSuccessorTarget
): Promise<ModernActivationSuccessorPlan> {
  source = copyModernSource(source);
  target = copySourceHistoryData(target, 'modern target');
  const validated = await validateModernSuccessorSource(source);
  assertModernRecordData(target, 'modern target');
  historyExact(target, ['selection', 'plugins', 'activeLayout', 'managed'], 'modern target');
  const { inventory, index, captures } = validated;
  const originalManifestBytes = requireContent(originalObservation(captures, originalManifestPath), 'original manifest is missing');
  const rawSourceManifest = parseHistoryJson(originalManifestBytes, 'original manifest');
  const sourceProfile = inventory.manifest.governance.profile;
  if (sourceProfile !== 'single-maintainer-gitflow' || target.selection.profile !== sourceProfile ||
    canonicalSha256(target.selection.project) !== canonicalSha256(inventory.manifest.project) ||
    canonicalSha256(target.selection.framework) !== canonicalSha256(inventory.manifest.framework)) {
    historyFail('modern target', 'ordinary successor cannot switch source profile/workflow/project/framework intent.');
  }
  const managed = buildModernManagedCore({ selection: target.selection, plugins: target.plugins, activeLayout: target.activeLayout });
  const decisions = target.managed;
  if (!Array.isArray(decisions)) historyFail('managed decisions', 'requires an explicit finite inventory.');
  for (const artifact of managed) {
    originalObservation(captures, artifact.pathParts);
    const decision = decisions.find(entry => entry.logicalName === artifact.logicalName);
    if (!decision) historyFail(artifact.logicalName, 'complete applicable managed prerequisite is missing.', 'missing-modern-managed-prerequisite');
    if (decision.kind === 'bytes') {
      if (decision.content !== artifact.content || decision.category !== artifact.category ||
        historyPathKey(decision.pathParts) !== historyPathKey(artifact.pathParts)) historyFail(artifact.logicalName, 'target body differs from actual G1 output.');
    } else if (decision.kind === 'retain') {
      const original = inventory.manifest.managedArtifacts.find(entry => entry.logicalName === artifact.logicalName);
      if (!original || original.pathParts.join('/') !== artifact.pathParts.join('/')) historyFail(artifact.logicalName, 'has no exact retained source artifact.');
      const captured = originalObservation(captures, original.pathParts);
      if (!captured.content || !captured.content.equals(Buffer.from(artifact.content)) ||
        original.contentHash !== `sha256:${rawHistoryDigest(captured.content)}`) historyFail(artifact.logicalName, 'retained hash is not independently captured matching bytes.');
    } else historyFail(artifact.logicalName, 'an applicable modern prerequisite cannot be retired.');
  }
  const reference: ManifestSourceHistoryReference = { schemaVersion: 1, kind: 'activation-history',
    snapshotId: index.snapshotId, indexDigest: rawHistoryDigest(source.indexContent) };
  const candidate = createManifestV8Candidate({ origin: 'historical-successor', source: rawSourceManifest,
    profile: target.selection.profile, activeLayout: target.activeLayout, sourceManifestHistory: reference, managed: decisions });
  const context = candidateContext(candidate), contract = createModernHistoryContract(projectCatalog, context);
  const compatibility = createModernCompatibilityContract({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract })
    .buildModernCompatibilityMetadata(candidate.manifest);
  if (!compatibility.activation.successorLanes.some(lane => canonicalSha256(lane.sourceIdentity) === canonicalSha256(index.sourceIdentity) &&
    lane.sourceWorkflow === inventory.manifest.project.specWorkflow)) historyFail('modern successor lane', 'is not explicitly declared for the exact source/target intent.');
  if (candidate.manifest.governance.state !== 'handoff-generated' ||
    candidate.manifest.managedArtifacts.length !== managed.length) historyFail('modern successor', 'a readable partial handoff is not a complete publication candidate.');
  for (const artifact of managed) {
    const entry = candidate.manifest.managedArtifacts.find(entry => entry.logicalName === artifact.logicalName);
    if (entry?.contentHash !== `sha256:${rawHistoryDigest(Buffer.from(artifact.content))}`) historyFail(artifact.logicalName, 'manifest hash does not bind its actual target body.');
  }
  const semanticInput = contract.semanticInput(index.sourceIdentity, reference, candidate.digest);
  const fields = {
    source: copyModernSource(source), target: structuredClone(target), manifest: candidate, semanticInput,
    semanticTransitionDigest: canonicalSha256(semanticInput), preparationSourceBinding: source.sourceBinding
  };
  return { ...fields, planBinding: canonicalSha256({ sourceBinding: fields.source.sourceBinding, target: fields.target,
    manifest: fields.manifest, semanticInput, semanticTransitionDigest: fields.semanticTransitionDigest }) };
}

/** Deterministic pre-admission reconstruction. No time/random generation and no writes or publication claim. */
export async function prepareActivationHistorySuccessor(
  plan: ModernActivationSuccessorPlan, completeTargetManifestBytes: Uint8Array,
  preparationInput: SuccessorPreparationV1, observedAt: string
): Promise<PreparedModernActivationSuccessor> {
  plan = copyPreparedPlan(plan);
  const preparation = validateSuccessorPreparation(preparationInput, observedAt);
  if (!(completeTargetManifestBytes instanceof Uint8Array) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(completeTargetManifestBytes)) ||
    ['length', 'byteLength', 'byteOffset', 'buffer', 'valueOf', 'toString', 'toJSON'].some(key => Object.hasOwn(completeTargetManifestBytes, key)) ||
    Object.getOwnPropertySymbols(completeTargetManifestBytes).length) {
    historyFail('target manifest bytes', 'requires actual UTF8 bytes.');
  }
  if (completeTargetManifestBytes.byteLength > 8 * 1024 * 1024) {
    historyFail('target manifest bytes', 'exceeds the 8MiB file bound.', 'history-inspection-limit');
  }
  completeTargetManifestBytes = Buffer.from(completeTargetManifestBytes);
  const replay = await planModernActivationSuccessor(plan.source, plan.target);
  assertModernRecordData({ manifest: plan.manifest, semanticInput: plan.semanticInput, semanticTransitionDigest: plan.semanticTransitionDigest,
    preparationSourceBinding: plan.preparationSourceBinding, planBinding: plan.planBinding }, 'prepared plan');
  if (replay.planBinding !== plan.planBinding || replay.preparationSourceBinding !== plan.preparationSourceBinding ||
    canonicalSha256(replay.manifest) !== canonicalSha256(plan.manifest) ||
    canonicalSha256(replay.semanticInput) !== canonicalSha256(plan.semanticInput) ||
    replay.semanticTransitionDigest !== plan.semanticTransitionDigest ||
    !Buffer.from(completeTargetManifestBytes).equals(Buffer.from(replay.manifest.content))) {
    historyFail('prepared successor', 'source, target or literal candidate bytes differ from the reviewed construction.', 'historical-plan-changed');
  }
  const checked = await validateModernSuccessorSource(plan.source), context = candidateContext(replay.manifest);
  if (isProtectedSourceAnchor(checked.inventory.state.repository.id) && checked.inventory.state.repository.id !== preparation.localRepositoryId) {
    historyFail('successor anchor', 'must preserve the original protected local anchor.');
  }
  const recordContract = createModernActivationRecordContract(projectCatalog, context);
  const initial = recordContract.createInitialState({
    repository: { id: preparation.localRepositoryId, name: checked.inventory.manifest.project.name, defaultBranch: 'develop' },
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' }, createdAt: preparation.preparedAt
  });
  const successor = recordContract.readState({ ...initial, successorHistory: {
    schemaVersion: 1, snapshotId: checked.index.snapshotId, journalPathParts: ['governance', 'migration-state.json'],
    historyIndexPathParts: activationHistoryIndexPathParts(checked.index.snapshotId), historyIndexDigest: rawHistoryDigest(plan.source.indexContent),
    sourceActiveChange: checked.inventory.state.activeChange
  } });
  const history = createModernHistoryContract(projectCatalog, context);
  const journal = history.readJournal({
    schemaVersion: 2, semanticInput: replay.semanticInput, semanticTransitionDigest: replay.semanticTransitionDigest, preparation,
    successor: { repositoryId: successor.repository.id, createdAt: preparation.preparedAt },
    revalidation: { status: 'pending', updatedAt: preparation.preparedAt,
      phases: history.policy.revalidation.map(phaseId => ({
        phaseId, status: 'pending', evidenceIds: [], blockers: []
      })), nextAction: 'Publish the exact separately admitted candidate; local revalidation requires its own reviewed operation.' }
  }, replay.semanticInput, observedAt);
  const retirements = checked.index.files.filter(file =>
    ['evidence', 'plan', 'approval', 'supersession', 'reconciliation', 'credential-policy'].includes(file.kind)).map(file => ({
    pathParts: [...file.originalPathParts], copyPathParts: [...file.copyPathParts], digest: file.digest
  }));
  const mutations: ActivationHistoryMutation[] = [];
  if (plan.source.historyDisposition === 'create') {
    for (const entry of checked.index.files) mutations.push({ type: 'write', pathParts: [...entry.copyPathParts],
      content: Buffer.from(requireContent(originalObservation(checked.captures, entry.originalPathParts), 'source missing')), mode: 0o600 });
    mutations.push({ type: 'write', pathParts: activationHistoryIndexPathParts(checked.index.snapshotId), content: Buffer.from(plan.source.indexContent), mode: 0o600 });
  }
  mutations.push(...retirements.map(entry => ({ type: 'delete' as const, pathParts: [...entry.pathParts] })),
    { type: 'write', pathParts: [...originalStatePath], content: canonicalJson(successor), mode: 0o600 },
    { type: 'write', pathParts: [...originalJournalPath], content: canonicalJson(journal), mode: 0o600 });
  const obligations: ReleasedSourceLifecycleObligation[] = checked.inventories.flatMap((inventory, i) => inventory.state.bootstrapState ? [{
    snapshotId: checked.indexes[i].snapshotId, sourceIdentity: checked.indexes[i].sourceIdentity,
    repositoryId: inventory.state.repository.id, retention: structuredClone(inventory.state.bootstrapState), authority: 'historical-protection-only'
  }] : []);
  return {
    semanticTransitionDigest: replay.semanticTransitionDigest, preparation, successor, journal,
    manifestBytes: Buffer.from(replay.manifest.content), manifestDigest: replay.manifest.digest,
    mutations, preconditions: copySourceHistoryObservations(checked.captures), requiredRetirements: retirements, lifecycleObligations: obligations
  };
}
