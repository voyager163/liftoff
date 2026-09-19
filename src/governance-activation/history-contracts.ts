import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import type { ActivationIdentity, PhaseId } from '../domain/governance/activation/types.js';
import {
  historicalActivationIdentities,
  isHistoricalActivationIdentity, isHistoricalV1ActivationIdentity, isHistoricalV2ActivationIdentity, isHistoricalV3ActivationIdentity, isHistoricalV4Policy7ActivationIdentity,
  type HistoricalActivationIdentity, type HistoricalV1ActivationIdentity, type HistoricalV2ActivationIdentity, type HistoricalV3ActivationIdentity, type HistoricalV4Policy7ActivationIdentity
} from '../domain/governance/policy/identity.js';
import type { ActivationSuccessorMigrationId } from './compatibility.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';
import { governanceArtifactPaths } from '../domain/project/catalog.js';
export {
  reviewedUpdateTransactionPathParts, reviewedUpdateTransactionSchemaVersion
} from '../domain/project/reviewed-update-artifacts.js';

export const activationHistoryIndexSchemaVersion = 1 as const;
export const migrationJournalSchemaVersion = 1 as const;
export const migrationRevalidationPhaseIds = ['seed-valid', 'seed-verified', 'seed-archived'] as const;
/** Restrictive creation policy; retained history remains readable after checkout permission normalization. */
export const activationHistoryTargetModes = Object.freeze({
  historyCopy: 0o600,
  historyIndex: 0o600,
  successorState: 0o600,
  migrationJournal: 0o600
} as const);
export const activationHistoryRootPathParts = ['governance', 'history'] as const;
export const migrationStateFilePathParts = ['governance', 'migration-state.json'] as const;
export const historicalManifestPathParts = ['liftoff.manifest.json'] as const;
export const historicalActivationStatePathParts = ['governance', 'activation-state.json'] as const;
export const historicalActivationIdentity = historicalActivationIdentities[0];
export const historicalMetadataPathParts = [
  ['liftoff.config.json'],
  ['.liftoff', 'governance', 'phase-graph.json'],
  ['.liftoff', 'governance', 'compatibility.json'],
  ['.liftoff', 'governance', 'context.json'],
  ['.liftoff', 'governance', 'policy.md'],
  ['.liftoff', 'governance', 'README.md'],
  ['.liftoff', 'governance', 'credential-policy.schema.json'],
  ['.github', 'prompts', 'liftoff-setup.prompt.md'],
  ['.github', 'prompts', 'liftoff-governance-assess.prompt.md'],
  ['.claude', 'commands', 'liftoff-setup.md'],
  ['.claude', 'commands', 'liftoff-governance-assess.md'],
  ['.agents', 'skills', 'liftoff-setup', 'SKILL.md'],
  ['.agents', 'skills', 'liftoff-governance-assess', 'SKILL.md'],
  governanceArtifactPaths.repair['github-copilot'],
  governanceArtifactPaths.repair.claude,
  governanceArtifactPaths.repair.codex
] as const;

export { ActivationHistoryError, historyFail } from './historical-safety.js';
import { historyFail } from './historical-safety.js';

export function historyRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) historyFail(label, 'must be a JSON object.');
  return value;
}

export function historyExact(
  value: unknown, required: readonly string[], label: string, optional: readonly string[] = []
): Record<string, unknown> {
  const item = historyRecord(value, label);
  for (const key of required) {
    if (!Object.hasOwn(item, key)) historyFail(`${label}.${key}`, 'is required.');
  }
  for (const key of Object.keys(item)) {
    if (!required.includes(key) && !optional.includes(key)) historyFail(`${label}.${key}`, 'is not supported.');
  }
  return item;
}

export function historyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) historyFail(label, 'must be a non-empty string.');
  return value;
}

export function historyBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') historyFail(label, 'must be a boolean.');
  return value;
}

export function historyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) historyFail(label, 'must be an array.');
  return value;
}

export function historyStrings(value: unknown, label: string): string[] {
  return historyArray(value, label).map((entry, index) => historyString(entry, `${label}[${index}]`));
}

export function historyEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const found = values.find((entry) => entry === value);
  if (found === undefined) historyFail(label, `has unsupported value ${JSON.stringify(value)}.`);
  return found;
}

export function historyLiteral<T extends string | number | boolean>(value: unknown, expected: T, label: string): T {
  if (value !== expected) historyFail(label, `must be ${JSON.stringify(expected)}; found ${JSON.stringify(value)}.`);
  return expected;
}

export function historyDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) historyFail(label, 'must be a complete lowercase SHA-256 digest.');
  return value;
}

export function historyTimestamp(value: unknown, label: string): string {
  const timestamp = historyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    historyFail(label, 'must be a valid ISO timestamp.');
  }
  return timestamp;
}

export function historyPathParts(value: unknown, label: string): string[] {
  assertSafeHistoricalRecord(value, 'historical path');
  const parts = historyStrings(value, label);
  if (parts.length === 0) historyFail(label, 'must contain at least one portable path part.', 'unsafe-history-path');
  for (const part of parts) {
    if (
      part === '.' || part === '..' || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(part) ||
      /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    ) historyFail(label, `contains unsafe or non-portable path part ${JSON.stringify(part)}.`, 'unsafe-history-path');
  }
  return parts;
}

export function historyRecordId(value: unknown, label: string): string {
  const id = historyString(value, label);
  historyPathParts([id], label);
  return id;
}

export function historyPathKey(parts: readonly string[]): string {
  return parts.join('/');
}

export function historyCaseKey(parts: readonly string[]): string {
  return parts.map((part) => part.normalize('NFC').toLowerCase()).join('/');
}

export function historicalIdentity(value: unknown, label: string): HistoricalActivationIdentity {
  if (!isHistoricalActivationIdentity(value)) {
    historyFail(label, 'is not an exact registered historical activation identity.', 'unsupported-historical-identity');
  }
  return { ...value };
}

export function historicalV1Identity(value: unknown, label: string): HistoricalV1ActivationIdentity {
  if (!isHistoricalV1ActivationIdentity(value)) {
    historyFail(label, 'is not the exact registered historical activation v1 identity.', 'unsupported-historical-identity');
  }
  return { ...value };
}

export function historicalV2Identity(value: unknown, label: string): HistoricalV2ActivationIdentity {
  if (!isHistoricalV2ActivationIdentity(value)) {
    historyFail(label, 'is not the exact registered historical activation v2 identity.', 'unsupported-historical-identity');
  }
  return { ...value };
}

export function historicalV3Identity(value: unknown, label: string): HistoricalV3ActivationIdentity {
  if (!isHistoricalV3ActivationIdentity(value)) {
    historyFail(label, 'is not the exact registered historical activation v3 identity.', 'unsupported-historical-identity');
  }
  return { ...value };
}

export function migrationTargetIdentity(value: unknown, label: string): ActivationIdentity {
  const item = historyExact(value, Object.keys(currentActivationIdentity), label);
  if (canonicalSha256(item) !== canonicalSha256(currentActivationIdentity)) {
    historyFail(label, 'is not the installed current activation identity.', 'unsupported-migration-target');
  }
  return { ...currentActivationIdentity };
}

export function rawHistoryDigest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function historyFileModeMatches(actual: number | undefined, expected: number): boolean {
  if (actual === undefined) return false;
  // Windows chmod preserves the writable attribute, not POSIX group/execute bits.
  return process.platform === 'win32' ? (actual & 0o200) === (expected & 0o200) : actual === expected;
}

export function parseHistoryJson(content: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return historyFail(label, 'is not valid UTF-8 JSON.', 'malformed-history-json');
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const containers: Array<{ object: boolean; expectsKey: boolean; keys: Set<string> }> = [];
    for (let position = 0; position < text.length; position++) {
      const character = text[position];
      if (character === '"') {
        const start = position++;
        while (position < text.length && text[position] !== '"') {
          if (text[position] === '\\') position++;
          position++;
        }
        const parent = containers.at(-1);
        if (parent?.object && parent.expectsKey) {
          const key: string = JSON.parse(text.slice(start, position + 1));
          if (parent.keys.has(key)) historyFail(label, 'contains duplicate JSON properties.', 'malformed-history-json');
          parent.keys.add(key);
          parent.expectsKey = false;
        }
      } else if (character === '{' || character === '[') {
        containers.push({ object: character === '{', expectsKey: character === '{', keys: new Set() });
        if (containers.length > 64) historyFail(label, 'exceeds bounded metadata nesting.', 'malformed-history-json');
      } else if (character === '}' || character === ']') {
        containers.pop();
      } else if (character === ',' && containers.at(-1)?.object) {
        containers.at(-1)!.expectsKey = true;
      }
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return historyFail(label, 'contains malformed JSON; source contents are withheld.', 'malformed-history-json');
  }
}

export const historicalFileKinds = [
  'manifest', 'state', 'metadata', 'evidence', 'plan', 'approval',
  'migration', 'supersession', 'reconciliation', 'credential-policy', 'source-metadata', 'source-tasks'
] as const;
export type HistoricalFileKind = typeof historicalFileKinds[number];

export function historicalSourceChangePathParts(change: { id: string; kind: 'openspec' | 'spec-kit' }): string[] {
  const id = historyRecordId(change.id, 'historical source change ID');
  return change.kind === 'openspec' ? ['openspec', 'changes', id] : ['specs', id];
}

export interface ActivationHistoryFile {
  kind: HistoricalFileKind;
  originalPathParts: string[];
  copyPathParts: string[];
  digest: string;
  /** Original source permissions, independent of copy permissions restored by later checkouts. */
  mode: number;
}

export interface ActivationHistoryIndex {
  schemaVersion: 1;
  snapshotId: string;
  sourceIdentity: HistoricalActivationIdentity;
  files: ActivationHistoryFile[];
}

export function activationHistoryIndexPathParts(snapshotId: string): string[] {
  return [...activationHistoryRootPathParts, historyDigest(snapshotId, 'snapshotId'), 'index.json'];
}

export function activationHistoryCopyPathParts(snapshotId: string, originalPathParts: readonly string[]): string[] {
  return [...activationHistoryRootPathParts, historyDigest(snapshotId, 'snapshotId'), 'files',
    ...historyPathParts(originalPathParts, 'history original path')];
}

export function activationHistorySnapshotId(
  sourceIdentity: HistoricalActivationIdentity,
  files: readonly Omit<ActivationHistoryFile, 'copyPathParts'>[]
): string {
  const inventory = files.map(({ kind, originalPathParts, digest, mode }) =>
    ({ kind, originalPathParts, digest, mode })).sort((a, b) =>
    historyPathKey(a.originalPathParts) < historyPathKey(b.originalPathParts) ? -1 :
      historyPathKey(a.originalPathParts) > historyPathKey(b.originalPathParts) ? 1 : 0);
  return canonicalSha256({ schemaVersion: activationHistoryIndexSchemaVersion, sourceIdentity, files: inventory });
}

export function validateActivationHistoryIndex(value: unknown): ActivationHistoryIndex {
  const label = 'activationHistoryIndex';
  assertSafeHistoricalRecord(value, label);
  const index = historyExact(value, ['schemaVersion', 'snapshotId', 'sourceIdentity', 'files'], label);
  historyLiteral(index.schemaVersion, activationHistoryIndexSchemaVersion, `${label}.schemaVersion`);
  const snapshotId = historyDigest(index.snapshotId, `${label}.snapshotId`);
  const sourceIdentity = historicalIdentity(index.sourceIdentity, `${label}.sourceIdentity`);
  const seen = new Set<string>();
  const files = historyArray(index.files, `${label}.files`).map((entry, position): ActivationHistoryFile => {
    const at = `${label}.files[${position}]`;
    const file = historyExact(entry, ['kind', 'originalPathParts', 'copyPathParts', 'digest', 'mode'], at);
    const originalPathParts = historyPathParts(file.originalPathParts, `${at}.originalPathParts`);
    const copyPathParts = historyPathParts(file.copyPathParts, `${at}.copyPathParts`);
    const key = historyCaseKey(originalPathParts);
    if (seen.has(key)) historyFail(at, 'contains duplicate or case-colliding original paths.', 'history-path-collision');
    seen.add(key);
    if (historyPathKey(copyPathParts) !== historyPathKey(activationHistoryCopyPathParts(snapshotId, originalPathParts))) {
      historyFail(`${at}.copyPathParts`, 'does not name the registered exact snapshot copy.', 'unsafe-history-path');
    }
    if (typeof file.mode !== 'number' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) {
      historyFail(`${at}.mode`, 'must be the recorded file permission mode.');
    }
    const kind = historyEnum(file.kind, historicalFileKinds, `${at}.kind`);
    const path = historyPathKey(originalPathParts);
    if (kind === 'manifest' && path !== historyPathKey(historicalManifestPathParts) ||
      kind === 'state' && path !== historyPathKey(historicalActivationStatePathParts) ||
      kind === 'metadata' && !historicalMetadataPathParts.some((parts) => historyPathKey(parts) === path) ||
      kind === 'migration' && path !== historyPathKey(migrationStateFilePathParts) ||
      kind === 'credential-policy' && path !== 'governance/credentials/preflight-policy.json' ||
      ['source-metadata', 'source-tasks'].includes(kind) &&
        (!(originalPathParts.length === 4 && originalPathParts[0] === 'openspec' && originalPathParts[1] === 'changes' && originalPathParts[2] !== 'archive' ||
          originalPathParts.length === 3 && originalPathParts[0] === 'specs') ||
          originalPathParts.at(-1) !== (kind === 'source-metadata' ? 'liftoff-governance.json' : 'tasks.md')) ||
      ['evidence', 'plan', 'approval', 'supersession', 'reconciliation'].includes(kind) &&
        (originalPathParts.length !== 3 || originalPathParts[0] !== 'governance' ||
          originalPathParts[1] !== (kind === 'evidence' || kind === 'reconciliation' ? kind : `${kind}s`) ||
          !originalPathParts[2].endsWith('.json'))) {
      historyFail(at, 'does not match its registered historical record layout.');
    }
    if (sourceIdentity.activationContractVersion === 1 && kind === 'migration') {
      historyFail(at, 'has no registered v1 source preservation contract.');
    }
    if (originalPathParts[0] === 'governance' && originalPathParts[1] === 'history') {
      historyFail(at, 'existing history must be retained by reference, not recopied as active source.');
    }
    return { kind, originalPathParts, copyPathParts, digest: historyDigest(file.digest, `${at}.digest`), mode: file.mode };
  });
  for (const kind of ['manifest', 'state']) {
    if (files.filter((file) => file.kind === kind).length !== 1) historyFail(label, `requires exactly one ${kind} source.`);
  }
  if (activationHistorySnapshotId(sourceIdentity, files) !== snapshotId) {
    historyFail(`${label}.snapshotId`, 'does not match its complete source inventory.', 'history-digest-mismatch');
  }
  return { schemaVersion: 1, snapshotId, sourceIdentity, files };
}

export const migrationRevalidationStatuses = ['pending', 'running', 'blocked', 'complete'] as const;
export type MigrationRevalidationStatus = typeof migrationRevalidationStatuses[number];

export interface MigrationPhaseProgress {
  phaseId: typeof migrationRevalidationPhaseIds[number];
  status: MigrationRevalidationStatus;
  evidenceIds: string[];
  blockers: string[];
}

export interface MigrationJournal {
  schemaVersion: 1;
  laneId: ActivationSuccessorMigrationId;
  snapshotId: string;
  historyIndexPathParts: string[];
  historyIndexDigest: string;
  sourceIdentity: HistoricalActivationIdentity;
  targetIdentity: ActivationIdentity;
  approvedPlanFingerprint: string;
  successor: { repositoryId: string; createdAt: string };
  transaction: { status: 'committed'; committedAt: string };
  revalidation: {
    status: MigrationRevalidationStatus;
    updatedAt: string;
    phases: MigrationPhaseProgress[];
    nextAction: string | null;
  };
}

export type HistoricalV2SourceMigrationJournal = Omit<MigrationJournal, 'laneId' | 'sourceIdentity' | 'targetIdentity'> & {
  laneId: 'activation-v1-to-v2';
  sourceIdentity: HistoricalV1ActivationIdentity;
  targetIdentity: HistoricalV2ActivationIdentity;
};

export type HistoricalV3SourceMigrationJournal = Omit<MigrationJournal, 'laneId' | 'sourceIdentity' | 'targetIdentity'> & {
  laneId: 'activation-v1-to-v3' | 'activation-v2-to-v3';
  sourceIdentity: HistoricalV1ActivationIdentity | HistoricalV2ActivationIdentity;
  targetIdentity: HistoricalV3ActivationIdentity;
};

export type HistoricalV4Policy7SourceMigrationJournal = Omit<MigrationJournal, 'laneId' | 'sourceIdentity' | 'targetIdentity'> & {
  laneId: 'activation-v1-to-v4' | 'activation-v2-to-v4' | 'activation-v3-to-v4';
  sourceIdentity: HistoricalV1ActivationIdentity | HistoricalV2ActivationIdentity | HistoricalV3ActivationIdentity;
  targetIdentity: HistoricalV4Policy7ActivationIdentity;
};

export type HistoricalSourceMigrationJournal = HistoricalV2SourceMigrationJournal | HistoricalV3SourceMigrationJournal | HistoricalV4Policy7SourceMigrationJournal;

function readMigrationJournalFields(value: unknown) {
  const label = 'migrationJournal';
  assertSafeHistoricalRecord(value, label);
  const journal = historyExact(value, [
    'schemaVersion', 'laneId', 'snapshotId', 'historyIndexPathParts', 'historyIndexDigest',
    'sourceIdentity', 'targetIdentity', 'approvedPlanFingerprint', 'successor', 'transaction', 'revalidation'
  ], label);
  historyLiteral(journal.schemaVersion, migrationJournalSchemaVersion, `${label}.schemaVersion`);
  const snapshotId = historyDigest(journal.snapshotId, `${label}.snapshotId`);
  const historyIndexPath = historyPathParts(journal.historyIndexPathParts, `${label}.historyIndexPathParts`);
  if (historyPathKey(historyIndexPath) !== historyPathKey(activationHistoryIndexPathParts(snapshotId))) {
    historyFail(`${label}.historyIndexPathParts`, 'does not name its exact registered index.', 'unsafe-history-path');
  }
  const successor = historyExact(journal.successor, ['repositoryId', 'createdAt'], `${label}.successor`);
  const repositoryId = historyString(successor.repositoryId, `${label}.successor.repositoryId`);
  if (!/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(repositoryId)) {
    historyFail(`${label}.successor.repositoryId`, 'must be a newly established UUID v4 local anchor.');
  }
  const createdAt = historyTimestamp(successor.createdAt, `${label}.successor.createdAt`);
  const transaction = historyExact(journal.transaction, ['status', 'committedAt'], `${label}.transaction`);
  historyLiteral(transaction.status, 'committed', `${label}.transaction.status`);
  const committedAt = historyTimestamp(transaction.committedAt, `${label}.transaction.committedAt`);
  if (Date.parse(committedAt) < Date.parse(createdAt)) historyFail(label, 'commit cannot precede successor creation.');
  const progress = historyExact(journal.revalidation, ['status', 'updatedAt', 'phases', 'nextAction'], `${label}.revalidation`);
  const status = historyEnum(progress.status, migrationRevalidationStatuses, `${label}.revalidation.status`);
  const updatedAt = historyTimestamp(progress.updatedAt, `${label}.revalidation.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(committedAt)) historyFail(label, 'revalidation cannot precede local commit.');
  const seen = new Set<PhaseId>();
  const phases = historyArray(progress.phases, `${label}.revalidation.phases`).map((entry, position): MigrationPhaseProgress => {
    const at = `${label}.revalidation.phases[${position}]`;
    const phase = historyExact(entry, ['phaseId', 'status', 'evidenceIds', 'blockers'], at);
    const phaseId = historyEnum(phase.phaseId, migrationRevalidationPhaseIds, `${at}.phaseId`);
    if (seen.has(phaseId)) historyFail(at, 'duplicates a phase result.');
    seen.add(phaseId);
    const phaseStatus = historyEnum(phase.status, migrationRevalidationStatuses, `${at}.status`);
    const evidenceIds = historyArray(phase.evidenceIds, `${at}.evidenceIds`).map((id) => historyRecordId(id, `${at}.evidenceIds`));
    const blockers = historyStrings(phase.blockers, `${at}.blockers`);
    if (new Set(evidenceIds).size !== evidenceIds.length) historyFail(at, 'contains duplicate evidence IDs.');
    if (phaseStatus === 'complete' && (evidenceIds.length === 0 || blockers.length > 0)) historyFail(at, 'complete work requires evidence and no blockers.');
    if (phaseStatus === 'blocked' && blockers.length === 0) historyFail(at, 'blocked work requires a diagnostic.');
    if (phaseStatus === 'pending' && (evidenceIds.length > 0 || blockers.length > 0)) historyFail(at, 'pending work cannot claim evidence or completed results.');
    return { phaseId, status: phaseStatus, evidenceIds, blockers };
  });
  if (phases.length !== migrationRevalidationPhaseIds.length) {
    historyFail(label, 'requires exactly seed-valid, seed-verified and seed-archived local revalidation; publication is separate governance work.');
  }
  if (status === 'complete' && phases.some((phase) => phase.status !== 'complete') ||
    status === 'pending' && phases.some((phase) => phase.status !== 'pending') ||
    status === 'blocked' && !phases.some((phase) => phase.status === 'blocked') ||
    status === 'running' && !phases.some((phase) => phase.status === 'running')) {
    historyFail(label, 'revalidation status contradicts its phase results.');
  }
  const nextAction = progress.nextAction === null ? null : historyString(progress.nextAction, `${label}.revalidation.nextAction`);
  if (status === 'complete' ? nextAction !== null : nextAction === null) historyFail(label, 'nextAction must distinguish complete and incomplete revalidation.');
  return {
    schemaVersion: migrationJournalSchemaVersion, snapshotId, historyIndexPathParts: historyIndexPath,
    historyIndexDigest: historyDigest(journal.historyIndexDigest, `${label}.historyIndexDigest`),
    approvedPlanFingerprint: historyDigest(journal.approvedPlanFingerprint, `${label}.approvedPlanFingerprint`),
    successor: { repositoryId, createdAt }, transaction: { status: 'committed' as const, committedAt },
    revalidation: { status, updatedAt, phases, nextAction }
  };
}

export function validateMigrationJournal(value: unknown): MigrationJournal {
  const fields = readMigrationJournalFields(value);
  const journal = historyRecord(value, 'migrationJournal');
  const sourceIdentity = historicalIdentity(journal.sourceIdentity, 'migrationJournal.sourceIdentity');
  const laneId = sourceIdentity.activationContractVersion === 1 ? 'activation-v1-to-v4' :
    sourceIdentity.activationContractVersion === 2 ? 'activation-v2-to-v4' :
      sourceIdentity.activationContractVersion === 3 ? 'activation-v3-to-v4' : 'activation-v4-policy7-to-policy8';
  historyLiteral(journal.laneId, laneId, 'migrationJournal.laneId');
  return {
    ...fields, laneId, sourceIdentity,
    targetIdentity: migrationTargetIdentity(journal.targetIdentity, 'migrationJournal.targetIdentity')
  };
}

/** The completed 0.11.x journal is source data, never a current migration commit. */
export function validateHistoricalV2SourceMigrationJournal(value: unknown): HistoricalV2SourceMigrationJournal {
  const fields = readMigrationJournalFields(value);
  const journal = historyRecord(value, 'historicalMigrationJournal');
  historyLiteral(journal.laneId, 'activation-v1-to-v2', 'historicalMigrationJournal.laneId');
  return {
    ...fields, laneId: 'activation-v1-to-v2',
    sourceIdentity: historicalV1Identity(journal.sourceIdentity, 'historicalMigrationJournal.sourceIdentity'),
    targetIdentity: historicalV2Identity(journal.targetIdentity, 'historicalMigrationJournal.targetIdentity')
  };
}

export function validateHistoricalV3SourceMigrationJournal(value: unknown): HistoricalV3SourceMigrationJournal {
  const fields = readMigrationJournalFields(value);
  const journal = historyRecord(value, 'historicalV3MigrationJournal');
  const sourceIdentity = isHistoricalV1ActivationIdentity(journal.sourceIdentity)
    ? historicalV1Identity(journal.sourceIdentity, 'historicalV3MigrationJournal.sourceIdentity')
    : historicalV2Identity(journal.sourceIdentity, 'historicalV3MigrationJournal.sourceIdentity');
  const laneId = sourceIdentity.activationContractVersion === 1 ? 'activation-v1-to-v3' : 'activation-v2-to-v3';
  historyLiteral(journal.laneId, laneId, 'historicalV3MigrationJournal.laneId');
  return {
    ...fields, laneId, sourceIdentity,
    targetIdentity: historicalV3Identity(journal.targetIdentity, 'historicalV3MigrationJournal.targetIdentity')
  };
}

export function validateHistoricalV4Policy7SourceMigrationJournal(value: unknown): HistoricalV4Policy7SourceMigrationJournal {
  const fields = readMigrationJournalFields(value);
  const journal = historyRecord(value, 'policy7.migrationJournal');
  const sourceIdentity = isHistoricalV1ActivationIdentity(journal.sourceIdentity)
    ? historicalV1Identity(journal.sourceIdentity, 'policy7.migrationJournal.sourceIdentity')
    : isHistoricalV2ActivationIdentity(journal.sourceIdentity)
      ? historicalV2Identity(journal.sourceIdentity, 'policy7.migrationJournal.sourceIdentity')
      : historicalV3Identity(journal.sourceIdentity, 'policy7.migrationJournal.sourceIdentity');
  const laneId = sourceIdentity.activationContractVersion === 1 ? 'activation-v1-to-v4' :
    sourceIdentity.activationContractVersion === 2 ? 'activation-v2-to-v4' : 'activation-v3-to-v4';
  historyLiteral(journal.laneId, laneId, 'policy7.migrationJournal.laneId');
  if (!isHistoricalV4Policy7ActivationIdentity(journal.targetIdentity)) {
    historyFail('policy7.migrationJournal.targetIdentity', 'requires the exact pre-amendment candidate identity.');
  }
  return { ...fields, laneId, sourceIdentity, targetIdentity: { ...journal.targetIdentity } };
}
