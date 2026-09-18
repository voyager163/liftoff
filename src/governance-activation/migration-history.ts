import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import {
  phaseIds, type BootstrapStateRetention, type PhaseId, type UserActivationState
} from '../domain/governance/activation/types.js';
import { validateApprovalEnvelope, validateUserActivationState } from '../domain/governance/activation/validators.js';
import { evidenceBodyDigest } from '../domain/governance/activation/evidence.js';
import { activationStateSchemaVersion, isHistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
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
import type { UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import type { HistoricalGovernanceChangeMetadata } from './historical-source-metadata.js';

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

async function inspectAncestorHistory(
  projectRoot: string, inventory: HistoricalActivationInventory, seen = new Set<string>()
): Promise<{
  references: HistoricalAncestorReference[];
  obligations: HistoricalLifecycleObligation[];
  preconditions: ProjectFileSnapshot[];
  historicalSources: HistoricalGovernanceSource[];
}> {
  const journal = inventory.sourceMigration;
  if (!journal) return { references: [], obligations: [], preconditions: [], historicalSources: [] };
  if (seen.has(journal.snapshotId) || seen.size >= 3 ||
    canonicalSha256(journal.targetIdentity) !== canonicalSha256(inventory.state.identity) ||
    journal.sourceIdentity.activationContractVersion >= journal.targetIdentity.activationContractVersion) {
    historyFail('ancestor history', 'source ancestry must follow exact acyclic released successor lanes.', 'invalid-historical-reference');
  }
  const ancestry = new Set([...seen, journal.snapshotId]);
  const loaded = await readActivationHistoryIndex(projectRoot, journal.snapshotId);
  if (journal.laneId === 'activation-v1-to-v2' &&
    loaded.index.files.some((file) => !['manifest', 'state', 'metadata', 'evidence', 'plan', 'approval'].includes(file.kind))) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'the published v1-to-v2 history contract does not contain these record roles.', 'unsupported-historical-record');
  }
  if (loaded.digest !== journal.historyIndexDigest ||
    canonicalSha256(loaded.index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
    historyFail(historyPathKey(journal.historyIndexPathParts), 'ancestor index digest or source contract contradicts the preserved migration.', 'history-digest-mismatch');
  }
  const copies = await verifyHistoryCopies(projectRoot, loaded.index);
  const source = await readHistoricalSnapshotInventory(projectRoot, loaded.index);
  const earlier = await inspectAncestorHistory(projectRoot, source, ancestry);
  const sourceIdentities = [source.state.identity, ...earlier.references.map((entry) => entry.sourceIdentity)];
  if (inventory.sourceChangeMetadata &&
    canonicalSha256(inventory.sourceChangeMetadata.activationIdentity) !== canonicalSha256(inventory.state.identity) &&
    (!sourceIdentities.some((identity) => canonicalSha256(inventory.sourceChangeMetadata!.activationIdentity) === canonicalSha256(identity)) ||
      canonicalSha256(inventory.state.activeChange) !== canonicalSha256(source.state.activeChange))) {
    historyFail('ancestor history', 'historical source metadata is not bound to the preserved ancestor pointer.', 'invalid-historical-reference');
  }
  return {
    references: [{
      snapshotId: loaded.index.snapshotId, sourceIdentity: loaded.index.sourceIdentity,
      historyIndexPathParts: [...journal.historyIndexPathParts], historyIndexDigest: loaded.digest
    }, ...earlier.references],
    obligations: [...lifecycleObligations(loaded.index, source), ...earlier.obligations],
    historicalSources: [...historicalSources(loaded.index, source), ...earlier.historicalSources],
    preconditions: [loaded.snapshot, ...copies, ...earlier.preconditions]
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
  projectRoot: string, plan: EligibleActivationHistoryMigration, mutation: { pathParts: readonly string[] }
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

async function inspectActiveProofRecords(projectRoot: string, state: UserActivationState, storage?: UpdatePreviewOptions) {
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
      await assertGovernanceApprovalIssued(projectRoot, approval, storage);
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

export async function inspectActivationMigrationHistory(
  projectRoot: string, storage?: UpdatePreviewOptions
): Promise<CommittedMigrationInspection> {
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
  const records = await inspectActiveProofRecords(projectRoot, state, storage);
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
  projectRoot: string, options: HistoricalInventoryOptions & { storage?: UpdatePreviewOptions } = {}
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
    if (journalSnapshot.content !== undefined && !(isRecord(raw) && isHistoricalActivationIdentity(raw.identity))) {
      const history = await inspectActivationMigrationHistory(projectRoot, options.storage);
      if (history.status !== 'committed') historyFail('migration-state.json', 'declared journal disappeared during inspection.');
      return { status: 'current', state: history.state, history };
    }
    if (isRecord(raw) && raw.schemaVersion === activationStateSchemaVersion && !isHistoricalActivationIdentity(raw.identity)) {
      const state = currentState(raw, historyPathKey(stateSnapshot.pathParts));
      migrationTargetIdentity(state.identity, 'activation-state.json.identity');
      const manifest = await captureHistoryFile(projectRoot, historicalManifestPathParts);
      currentManifestIdentity(parseHistoryJson(requireContent(manifest, 'active manifest is missing.'), historyPathKey(manifest.pathParts)),
        historyPathKey(manifest.pathParts));
      await inspectActiveProofRecords(projectRoot, state);
      return { status: 'current', state, history: await inspectActivationMigrationHistory(projectRoot, options.storage) };
    }
    if (!isRecord(raw) || !isHistoricalActivationIdentity(raw.identity) ||
      raw.schemaVersion !== raw.identity.activationStateSchemaVersion) {
      historyFail(historyPathKey(stateSnapshot.pathParts), 'only exact registered historical representations have a successor lane.', 'unsupported-historical-identity');
    }
    const lane = packagedActivationSuccessorMigrations().find((entry) =>
      canonicalSha256(entry.fromIdentity) === canonicalSha256(raw.identity) &&
      canonicalSha256(entry.toIdentity) === canonicalSha256(currentActivationIdentity));
    if (lane === undefined) historyFail(historyPathKey(stateSnapshot.pathParts), 'no exact packaged successor lane exists.', 'unsupported-historical-identity');
    const inventory = await readHistoricalActivationInventory(projectRoot, options);
    if (inventory.state.schemaVersion === 4) {
      const unsettled = Object.entries(inventory.state.phases)
        .filter(([, phase]) => phase.state === 'running' || phase.operation?.status === 'running')
        .map(([id]) => id);
      if (unsettled.length) {
        historyFail(historyPathKey(stateSnapshot.pathParts),
          `Pre-amendment activation has unsettled work in ${unsettled.join(', ')}. Settle the original operation under its recorded authority before a policy successor; no checkpoint or approval was retired.`,
          'unsupported-active-record');
      }
    }
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
