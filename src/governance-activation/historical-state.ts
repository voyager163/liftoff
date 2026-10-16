import type * as Records from '../domain/governance/activation/record-contracts.js';
import { releasedV3Values } from '../domain/governance/activation/record-contracts.js';
import { releasedV3TaskProjectionContract } from '../domain/governance/activation/record-validation.js';
import {
  authorityOperationValues, transitionAuthorityValues, approvalBundleDigest, approvalOperationDigests, semanticPlanDigest,
  outputBindingsMatch, outputResourcesMatch, projectionOperation, assertProjectionDestination, assertTaskMarkers, projectTaskCheckboxValues,
  validatePhasePayloadValues
} from '../domain/governance/activation/source-values.js';
type V3PhaseId = Records.ReleasedV3PhaseId;
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord, sha256Hex } from '../domain/governance/activation/canonical-json.js';
import type { PhaseExecutionStateFieldsV1 } from '../domain/governance/activation/record-contracts.js';
import {
  isHistoricalV2ActivationIdentity, isReleasedV3ActivationIdentity,
  type HistoricalActivationIdentity, type ReleasedV3ActivationIdentity
} from '../domain/governance/policy/identity.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import { parseManifest } from '../application/project/manifest.js';
import { projectCatalog } from '../application/project/catalog.js';
import { createManifestReader } from '../domain/project/manifest/reader.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import {
  ActivationHistoryError, historicalIdentity, historicalV1Identity, historyArray, historyBoolean, historyCaseKey,
  historyDigest, historyEnum, historyExact, historyFail, historyLiteral, historyPathKey,
  historyPathParts, historyRecord, historyRecordId, historyString, historyStrings, historyTimestamp,
  historicalActivationIdentity, historicalActivationStatePathParts, historicalManifestPathParts, historicalMetadataPathParts,
  migrationStateFilePathParts, historicalSourceChangePathParts, parseHistoryJson, rawHistoryDigest, validateHistoricalV2SourceMigrationJournal,
  validateActivationHistoryIndex, validateFrozenActivationHistoryIndex, validateFrozenV3SourceIndex, validateHistoricalV3SourceMigrationJournal,
  type HistoricalFileKind, type ActivationHistoryIndex, type HistoricalV2SourceMigrationJournal,
  type HistoricalV3SourceMigrationJournal, type FrozenV3SourceIndexV1
} from './history-contracts.js';
import { FileSystemError } from '../domain/project/errors.js';
import { copySourceHistoryData, copySourceInventoryOptions, copySourceHistoryObservations } from './source-history-capture.js';
import { validateReleasedV3CompatibilityMetadata } from './compatibility.js';
import { releasedManagedActivationIdentities, releasedManagedMetadata, releasedV3CompatibilityContract } from './released-managed-metadata.js';
import { assertSafeHistoricalBytes, assertSafeHistoricalRecord } from './historical-safety.js';
import { historicalV1PhaseContractDigests, historicalV1ResultAllowed } from './historical-v1-phase-contracts.js';
import { validateHistoricalV1AuxiliaryRecord } from './historical-v1-auxiliary.js';
import { validateHistoricalV3GovernanceChangeMetadata, validateHistoricalGovernanceChangeMetadata, type HistoricalGovernanceChangeMetadata } from './historical-source-metadata.js';
import {
  validateHistoricalV2ActivationState, validateHistoricalV2EvidenceRecord,
  validateHistoricalV2ApprovalEnvelope, validateHistoricalV2SavedTransitionPlan,
  validateHistoricalV2Compatibility, historicalV2ApprovalEnvelopeHash,
  validateHistoricalV2AuxiliaryRecord,
  type HistoricalV2ActivationState, type HistoricalV2EvidenceRecord,
  type HistoricalV2ApprovalEnvelope, type HistoricalV2SavedTransitionPlan
} from './historical-v2.js';
import {
  validateHistoricalV3ActivationState, validateHistoricalV3EvidenceRecord, historicalV3PhaseGraph,
  validateHistoricalV3SavedTransitionPlan, validateHistoricalV3ApprovalEnvelope, validateHistoricalV3AuxiliaryRecord,
  historicalV3ApprovalEnvelopeHash, historicalV3EvidenceBodyDigest, assertHistoricalV3Reconciliation,
  type HistoricalV3ActivationState, type HistoricalV3EvidenceRecord, type HistoricalV3ApprovalEnvelope, type HistoricalV3SavedTransitionPlan
} from './historical-v3.js';

export * from './historical-common.js';
import {
  historicalPhaseIds, type HistoricalPhaseId,
  historicalPhaseStates, historicalResults, historicalGateKinds, historicalQuestionKinds,
  destinationTypes, adapterIds, historicalPhaseGates,
  type HistoricalActivationState, type HistoricalEvidenceHeader,
  type HistoricalLiveReadbackProof, type HistoricalEvidenceRecord,
  type HistoricalApprovalEnvelope, type HistoricalSavedTransitionPlan,
  phaseId, assertHistoricalPhasesComplete, readHistoricalEvidenceReference,
  validateHistoricalBootstrapState, readHistoricalEvidenceTransition,
  validateHistoricalEmbeddedPaths, uniqueSorted, nullableString,
  readHistoricalApprovalFields, operationDestination, operation, evaluation,
  rollbackPlan, readHistoricalSavedTransitionPlan
} from './historical-common.js';

export function validateHistoricalActivationState(value: unknown): HistoricalActivationState {
  const label = 'historicalActivationState';
  assertSafeHistoricalRecord(value, label);
  const state = historyExact(value, [
    'schemaVersion', 'identity', 'repository', 'activeChange', 'applicability', 'phases', 'createdAt', 'updatedAt'
  ], label, ['bootstrapState']);
  historyLiteral(state.schemaVersion, 1, `${label}.schemaVersion`);
  const identity = historicalV1Identity(state.identity, `${label}.identity`);
  const repository = historyExact(state.repository, ['id', 'name', 'defaultBranch'], `${label}.repository`);
  const applicability = historyExact(state.applicability, ['statePath', 'privateStagingDast', 'credentialRequired'], `${label}.applicability`);
  let activeChange: HistoricalActivationState['activeChange'] = null;
  if (state.activeChange !== null) {
    const change = historyExact(state.activeChange, ['id', 'kind'], `${label}.activeChange`);
    activeChange = {
      id: historyRecordId(change.id, `${label}.activeChange.id`),
      kind: historyEnum(change.kind, ['openspec', 'spec-kit'], `${label}.activeChange.kind`)
    };
  }
  const rawPhases = historyExact(state.phases, historicalPhaseIds, `${label}.phases`);
  const phases: Partial<Record<HistoricalPhaseId, PhaseExecutionStateFieldsV1<HistoricalPhaseId>>> = {};
  for (const id of historicalPhaseIds) {
    const at = `${label}.phases.${id}`;
    const phase = historyExact(rawPhases[id], ['state', 'updatedAt', 'evidence', 'approvals', 'blockers'], at);
    const evidence = historyArray(phase.evidence, `${at}.evidence`).map((entry, index) => readHistoricalEvidenceReference(entry, `${at}.evidence[${index}]`));
    if (evidence.some((entry) => entry.phaseId !== id)) historyFail(at, 'evidence reference names another phase.');
    const approvals = historyArray(phase.approvals, `${at}.approvals`).map((entry) => historyRecordId(entry, `${at}.approvals`));
    if (new Set(evidence.map((entry) => entry.evidenceId)).size !== evidence.length || new Set(approvals).size !== approvals.length) {
      historyFail(at, 'contains duplicate evidence or approval references.');
    }
    phases[id] = {
      state: historyEnum(phase.state, historicalPhaseStates, `${at}.state`),
      updatedAt: historyString(phase.updatedAt, `${at}.updatedAt`),
      evidence, approvals, blockers: historyStrings(phase.blockers, `${at}.blockers`)
    };
  }
  assertHistoricalPhasesComplete(phases);
  return {
    schemaVersion: 1, identity,
    repository: {
      id: historyString(repository.id, `${label}.repository.id`),
      name: historyString(repository.name, `${label}.repository.name`),
      defaultBranch: historyString(repository.defaultBranch, `${label}.repository.defaultBranch`)
    },
    activeChange,
    applicability: {
      statePath: historyEnum(applicability.statePath, ['existing-private', 'bootstrap-local', 'none'], `${label}.applicability.statePath`),
      privateStagingDast: historyBoolean(applicability.privateStagingDast, `${label}.applicability.privateStagingDast`),
      credentialRequired: historyBoolean(applicability.credentialRequired, `${label}.applicability.credentialRequired`)
    },
    ...(Object.hasOwn(state, 'bootstrapState') ? { bootstrapState: validateHistoricalBootstrapState(state.bootstrapState, `${label}.bootstrapState`) } : {}),
    phases, createdAt: historyString(state.createdAt, `${label}.createdAt`),
    updatedAt: historyString(state.updatedAt, `${label}.updatedAt`)
  };
}

function historicalProofIdentity(item: Record<string, unknown>, label: string) {
  const identity = historicalV1Identity(item.identity, `${label}.identity`);
  const graphHash = historyDigest(item.phaseGraphHash, `${label}.phaseGraphHash`);
  if (graphHash !== identity.phaseGraphHash) historyFail(label, 'graph hash contradicts the historical identity.');
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const baselineSha = historyDigest(item.baselineSha, `${label}.baselineSha`);
  const inputDigest = historyDigest(item.inputDigest, `${label}.inputDigest`);
  const proofTransition = readHistoricalEvidenceTransition(item.transition, `${label}.transition`);
  if (proofTransition.phaseId !== id || proofTransition.baselineSha !== baselineSha || proofTransition.inputDigest !== inputDigest) {
    historyFail(label, 'transition contradicts the proof phase, baseline or inputs.');
  }
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`),
    identity, phaseGraphHash: graphHash, phaseId: id, baselineSha, inputDigest, transition: proofTransition,
    repositoryId: historyString(item.repositoryId, `${label}.repositoryId`)
  };
}

export function validateHistoricalEvidenceHeader(value: unknown): HistoricalEvidenceHeader {
  const label = 'historicalEvidenceHeader';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'phaseContractDigest',
    'inputDigest', 'baselineSha', 'transition', 'producedAt', 'producer', 'result'
  ], label);
  const proof = historicalProofIdentity(item, label);
  const phaseContractDigest = historyDigest(item.phaseContractDigest, `${label}.phaseContractDigest`);
  if (phaseContractDigest !== historicalV1PhaseContractDigests[proof.phaseId]) {
    historyFail(label, 'phase contract digest is not the published v1 behavior.');
  }
  const result = historyEnum(item.result, historicalResults, `${label}.result`);
  if (!historicalV1ResultAllowed(proof.phaseId, result)) historyFail(label, 'terminal result is not permitted by the published v1 phase.');
  return {
    ...proof, phaseContractDigest,
    producedAt: historyTimestamp(item.producedAt, `${label}.producedAt`),
    producer: historyString(item.producer, `${label}.producer`),
    result
  };
}

export function validateHistoricalLiveReadback(value: unknown): HistoricalLiveReadbackProof {
  const label = 'historicalLiveReadback';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'baselineSha', 'inputDigest',
    'transition', 'observedAt', 'provider', 'resourceType', 'resourceId', 'sourceDigest', 'readbackDigest', 'matches'
  ], label);
  return {
    ...historicalProofIdentity(item, label),
    observedAt: historyTimestamp(item.observedAt, `${label}.observedAt`),
    provider: historyEnum(item.provider, ['github', 'azure'], `${label}.provider`),
    resourceType: historyString(item.resourceType, `${label}.resourceType`),
    resourceId: historyString(item.resourceId, `${label}.resourceId`),
    sourceDigest: historyDigest(item.sourceDigest, `${label}.sourceDigest`),
    readbackDigest: historyDigest(item.readbackDigest, `${label}.readbackDigest`),
    matches: historyBoolean(item.matches, `${label}.matches`)
  };
}

export function validateHistoricalEvidenceRecord(value: unknown, headerOnlyEvidenceId?: string): HistoricalEvidenceRecord {
  const label = 'historicalEvidenceRecord';
  assertSafeHistoricalRecord(value, label);
  const item = historyRecord(value, label);
  // Header-only JSON was an explicit v1 format in commands.ts, not an unversioned import.
  if (!Object.hasOwn(item, 'header')) {
    return {
      evidenceId: historyRecordId(headerOnlyEvidenceId, `${label}.registeredHeaderOnlyEvidenceId`),
      header: validateHistoricalEvidenceHeader(item)
    };
  }
  historyExact(item, ['evidenceId', 'header'], label, ['payload', 'liveReadback']);
  if (Object.hasOwn(item, 'payload')) validateHistoricalEmbeddedPaths(item.payload, `${label}.payload`);
  const header = validateHistoricalEvidenceHeader(item.header);
  const liveReadback = Object.hasOwn(item, 'liveReadback')
    ? historyArray(item.liveReadback, `${label}.liveReadback`).map(validateHistoricalLiveReadback) : undefined;
  if (liveReadback?.some((proof) =>
    proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
    canonicalSha256(proof.transition) !== canonicalSha256(header.transition))) {
    historyFail(label, 'live readback contradicts its enclosing evidence record.');
  }
  return {
    evidenceId: historyRecordId(item.evidenceId, `${label}.evidenceId`), header,
    ...(Object.hasOwn(item, 'payload') ? { payload: item.payload } : {}),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

export function validateHistoricalApprovalEnvelope(value: unknown): HistoricalApprovalEnvelope {
  const item = historyRecord(value, 'historicalApprovalEnvelope');
  const fields = readHistoricalApprovalFields(value);
  if (Date.parse(fields.approvedAt) >= Date.parse(fields.expiresAt)) historyFail('historicalApprovalEnvelope', 'requires approvedAt before expiresAt.');
  return {
    ...fields,
    schemaVersion: historyLiteral(item.schemaVersion, 1, 'historicalApprovalEnvelope.schemaVersion'),
    identity: historicalV1Identity(item.identity, 'historicalApprovalEnvelope.identity')
  };
}

export function historicalApprovalEnvelopeHash(envelope: HistoricalApprovalEnvelope): string {
  const { id: _id, approvedAt: _approvedAt, approver: _approver, ...scope } = validateHistoricalApprovalEnvelope(envelope);
  return canonicalSha256(scope);
}

export function validateHistoricalSavedTransitionPlan(value: unknown): HistoricalSavedTransitionPlan {
  return readHistoricalSavedTransitionPlan(value, historicalV1Identity);
}

export function historicalTransitionPlanPathParts(plan: HistoricalSavedTransitionPlan | HistoricalV2SavedTransitionPlan): string[] {
  return historyPathParts([
    'governance', 'plans', `${plan.phaseId}-${plan.createdAt.replace(/[^0-9A-Za-z]/g, '')}-${plan.planDigest.slice(0, 12)}.json`
  ], 'historical transition plan path');
}

export interface HistoricalSourceFile {
  kind: HistoricalFileKind;
  pathParts: string[];
  content: Buffer;
  digest: string;
  mode: number;
}

export type ReadableHistoricalActivationState = HistoricalActivationState | HistoricalV2ActivationState;

export interface HistoricalActivationInventory {
  manifest: LiftoffManifest;
  state: ReadableHistoricalActivationState;
  sourceMigration?: HistoricalV2SourceMigrationJournal;
  sourceChangeMetadata?: HistoricalGovernanceChangeMetadata;
  files: HistoricalSourceFile[];
  unreviewedRecords: HistoricalSourceFile[];
  preconditions: ProjectFileSnapshot[];
}


type V3SourceMetadata = HistoricalGovernanceChangeMetadata<ReleasedV3ActivationIdentity, import('../domain/governance/activation/record-contracts.js').ReleasedV3PhaseId>;

export interface FrozenV3SourceInventory {
  manifest: LiftoffManifest;
  state: HistoricalV3ActivationState;
  sourceMigration?: HistoricalV3SourceMigrationJournal;
  sourceChangeMetadata?: HistoricalGovernanceChangeMetadata | V3SourceMetadata;
  files: HistoricalSourceFile[];
  unreviewedRecords: HistoricalSourceFile[];
  preconditions: ProjectFileSnapshot[];
}

type StoredSourceInventory = Omit<HistoricalActivationInventory, 'state' | 'sourceMigration' | 'sourceChangeMetadata'> & {
  state: ReadableHistoricalActivationState | HistoricalV3ActivationState;
  sourceMigration?: HistoricalV2SourceMigrationJournal | HistoricalV3SourceMigrationJournal;
  sourceChangeMetadata?: HistoricalGovernanceChangeMetadata | V3SourceMetadata;
};

export interface HistoricalInventoryOptions {
  reviewedUnreferencedPathParts?: readonly (readonly string[])[];
}

export async function resolveHistoryProjectPath(projectRoot: string, rawParts: readonly string[]): Promise<string> {
  const parts = historyPathParts(rawParts, 'history path');
  const root = path.resolve(projectRoot);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) historyFail(root, 'project root must be a real directory.', 'unsafe-history-path');
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    let names: string[];
    try { names = await readdir(cursor); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return path.join(canonicalRoot, ...parts);
    }
    const part = parts[index];
    const matches = names.filter((name) => historyCaseKey([name]) === historyCaseKey([part]));
    if (matches.length > 1 || matches.length === 1 && matches[0] !== part) {
      historyFail(historyPathKey(parts), `case-colliding path segment ${JSON.stringify(part)}.`, 'history-path-collision');
    }
    cursor = path.join(cursor, part);
    let details;
    try { details = await lstat(cursor); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return path.join(canonicalRoot, ...parts);
    }
    if (details.isSymbolicLink() || details.isFile() && details.nlink !== 1) {
      historyFail(historyPathKey(parts), 'symbolic links, junctions and hard-linked files are not historical migration targets.', 'unsafe-history-path');
    }
    if (index < parts.length - 1 && !details.isDirectory()) {
      historyFail(historyPathKey(parts), 'a parent is not a directory.', 'unsafe-history-path');
    }
  }
  return cursor;
}

export async function captureHistoryFile(projectRoot: string, parts: readonly string[]): Promise<ProjectFileSnapshot> {
  const pathParts = historyPathParts(parts, 'history file path');
  const target = await resolveHistoryProjectPath(projectRoot, pathParts);
  let details;
  try { details = await lstat(target); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return { pathParts };
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    historyFail(historyPathKey(pathParts), 'must be a regular unlinked file.', 'unsafe-history-path');
  }
  if (details.size > 8 * 1024 * 1024) {
    historyFail(historyPathKey(pathParts), 'exceeds the bounded control-record size; no contents were read.', 'unsafe-historical-payload');
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== details.ino || opened.dev !== details.dev || opened.nlink !== 1 ||
      opened.mode !== details.mode || opened.size !== details.size || opened.mtimeMs !== details.mtimeMs) {
      historyFail(historyPathKey(pathParts), 'changed before the bounded read.', 'historical-source-changed');
    }
    await resolveHistoryProjectPath(projectRoot, pathParts);
    const content = await handle.readFile();
    const after = await lstat(await resolveHistoryProjectPath(projectRoot, pathParts));
    if (after.ino !== details.ino || after.dev !== details.dev || after.mode !== details.mode ||
      after.size !== details.size || after.mtimeMs !== details.mtimeMs || after.nlink !== 1) {
      historyFail(historyPathKey(pathParts), 'changed while being read; obtain a fresh preview.', 'historical-source-changed');
    }
    return { pathParts, content, mode: details.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

export function validateHistoricalSourceManifest(value: unknown): LiftoffManifest {
  const label = 'historicalSourceManifest';
  assertSafeHistoricalRecord(value, label);
  const raw = historyRecord(value, label);
  historyLiteral(raw.artifactVersion, 7, `${label}.artifactVersion`);
  const governance = historyRecord(raw.governance, `${label}.governance`);
  historicalIdentity(governance.activationIdentity, `${label}.governance.activationIdentity`);
  try {
    return parseManifest(raw);
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return historyFail(label, error.message, 'invalid-historical-manifest');
  }
}


const frozenV3ManifestReader = createManifestReader({
  catalog: projectCatalog,
  policyVersion: releasedV3CompatibilityContract.currentIdentity.policyVersion,
  minimumLiftoffVersion: releasedV3CompatibilityContract.minimumManifestWriter,
  governanceArtifactPaths: new Map(releasedManagedMetadata.map(entry => [entry.logicalName, entry.pathParts])),
  validateActivationIdentity(value) {
    if (!isReleasedV3ActivationIdentity(value)) {
      historyFail('frozen v3 manifest', 'requires the exact original v3 identity.', 'mixed-active-identity');
    }
    return { ...value };
  }
});

function validateFrozenV3Manifest(value: unknown): LiftoffManifest {
  assertSafeHistoricalRecord(value, 'frozen v3 manifest');
  const raw = historyRecord(value, 'frozen v3 manifest');
  historyLiteral(raw.artifactVersion, 7, 'frozen v3 manifest.artifactVersion');
  if (!isReleasedV3ActivationIdentity(historyRecord(raw.governance, 'frozen v3 manifest.governance').activationIdentity)) {
    historyFail('frozen v3 manifest', 'requires the exact original v3 identity.', 'mixed-active-identity');
  }
  try { return frozenV3ManifestReader.parseManifest(raw); }
  catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return historyFail('frozen v3 manifest', error.message, 'invalid-historical-manifest');
  }
}

function validateHistoricalCompatibility(value: unknown, label: string): void {
  const item = historyExact(value, [
    'schemaVersion', 'generatedBy', 'liftoffVersion', 'minimumLiftoffVersions', 'manifest', 'activation', 'managedCore'
  ], label);
  historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
  historyLiteral(item.generatedBy, 'Mission Control Liftoff', `${label}.generatedBy`);
  historyLiteral(item.liftoffVersion, historicalActivationIdentity.liftoffVersion, `${label}.liftoffVersion`);
  const minimum = historyExact(item.minimumLiftoffVersions, ['manifestWriteVersion7', 'remedy'], `${label}.minimumLiftoffVersions`);
  historyLiteral(minimum.manifestWriteVersion7, '0.10.0', `${label}.minimumLiftoffVersions.manifestWriteVersion7`);
  historyString(minimum.remedy, `${label}.minimumLiftoffVersions.remedy`);
  const manifest = historyExact(item.manifest, ['readVersions', 'writeVersion', 'hashAuthority'], `${label}.manifest`);
  if (canonicalJson(manifest.readVersions) !== canonicalJson([2, 3, 4, 5, 6, 7])) historyFail(label, 'has an unknown historical manifest reader declaration.');
  historyLiteral(manifest.writeVersion, 7, `${label}.manifest.writeVersion`);
  historyLiteral(manifest.hashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.manifest.hashAuthority`);
  const activation = historyExact(item.activation, [
    'currentCompatibleTuples', 'recognizedGraphHashes', 'graphMappings', 'historicalStateMigrations', 'unsupportedRemedy'
  ], `${label}.activation`);
  const tuples = historyArray(activation.currentCompatibleTuples, `${label}.activation.currentCompatibleTuples`);
  if (tuples.length !== 1) historyFail(label, 'requires the single registered historical activation tuple.');
  historicalV1Identity(tuples[0], `${label}.activation.currentCompatibleTuples[0]`);
  if (canonicalJson(activation.recognizedGraphHashes) !== canonicalJson([historicalActivationIdentity.phaseGraphHash]) ||
    canonicalJson(activation.graphMappings) !== '[]\n' || canonicalJson(activation.historicalStateMigrations) !== '[]\n') {
    historyFail(label, 'contains an unknown historical graph or migration declaration.');
  }
  historyString(activation.unsupportedRemedy, `${label}.activation.unsupportedRemedy`);
  const core = historyExact(item.managedCore, ['logicalNameAllowlist', 'pathAllowlist', 'updateInventory', 'validation'], `${label}.managedCore`);
  const logicalNames = historyStrings(core.logicalNameAllowlist, `${label}.managedCore.logicalNameAllowlist`);
  const paths = historyArray(core.pathAllowlist, `${label}.managedCore.pathAllowlist`).map((entry) =>
    historyPathParts(entry, `${label}.managedCore.pathAllowlist`));
  const entries = historyArray(core.updateInventory, `${label}.managedCore.updateInventory`).map((entry, index) => {
    const at = `${label}.managedCore.updateInventory[${index}]`;
    const file = historyExact(entry, ['logicalName', 'pathParts', 'lifecycle', 'contentHashAuthority'], at);
    historyLiteral(file.lifecycle, 'managed-core', `${at}.lifecycle`);
    historyLiteral(file.contentHashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${at}.contentHashAuthority`);
    return { logicalName: historyString(file.logicalName, `${at}.logicalName`), pathParts: historyPathParts(file.pathParts, `${at}.pathParts`) };
  });
  if (new Set(logicalNames).size !== logicalNames.length ||
    new Set(paths.map(historyCaseKey)).size !== paths.length ||
    new Set(entries.map((entry) => entry.logicalName)).size !== entries.length ||
    new Set(entries.map((entry) => historyCaseKey(entry.pathParts))).size !== entries.length ||
    entries.length !== paths.length ||
    entries.some((entry) => !logicalNames.includes(entry.logicalName) || !paths.some((parts) => historyPathKey(parts) === historyPathKey(entry.pathParts)))) {
    historyFail(label, 'managed inventory and exact allowlists disagree.');
  }
  const validation = historyExact(core.validation, ['strictJson', 'crossPlatformPathParts', 'noSetupSkillVersion', 'checkModeWritesBytes'], `${label}.managedCore.validation`);
  historyLiteral(validation.strictJson, true, `${label}.managedCore.validation.strictJson`);
  historyLiteral(validation.crossPlatformPathParts, true, `${label}.managedCore.validation.crossPlatformPathParts`);
  historyLiteral(validation.noSetupSkillVersion, true, `${label}.managedCore.validation.noSetupSkillVersion`);
  historyLiteral(validation.checkModeWritesBytes, 0, `${label}.managedCore.validation.checkModeWritesBytes`);
}

function validateHistoricalMetadata(file: HistoricalSourceFile): void {
  const label = historyPathKey(file.pathParts);
  assertSafeHistoricalBytes(file.content, label);
  if (!label.endsWith('.json')) return;
  const value = parseHistoryJson(file.content, label);
  // Managed metadata may have been maintained after v1 execution stopped.
  // It is preserved as source bytes, never used to authorize a migration lane.
  if (label === '.liftoff/governance/phase-graph.json') {
    const digest = canonicalSha256(value);
    if (!releasedManagedActivationIdentities.some((identity) => identity.phaseGraphHash === digest)) {
      historyFail(label, 'does not match a registered released v1, v2 or v3 managed graph.', 'unsupported-historical-graph');
    }
  } else if (label === '.liftoff/governance/compatibility.json') {
    if (isRecord(value) && value.schemaVersion === 1) {
      validateHistoricalCompatibility(value, label);
    } else if (isRecord(value) && (value.schemaVersion === 2 || value.schemaVersion === 3)) {
      validateHistoricalV2Compatibility(value, label);
    } else if (isRecord(value) && value.schemaVersion === 4) {
      try {
        validateReleasedV3CompatibilityMetadata(value);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'Error') throw error;
        historyFail(label, error.message, 'invalid-managed-source-metadata');
      }
    } else {
      historyFail(label, 'compatibility metadata must use an explicitly supported released schema: 1, 2, 3 or 4.', 'invalid-managed-source-metadata');
    }
  } else if (label === '.liftoff/governance/context.json') {
    const context = historyRecord(value, label);
    historyLiteral(context.schemaVersion, 1, `${label}.schemaVersion`);
    const policy = historyExact(context.policy, ['profile', 'version', 'state', 'liveEnforcement'], `${label}.policy`);
    historyLiteral(policy.profile, 'single-maintainer-gitflow', `${label}.policy.profile`);
    historyLiteral(policy.version, '6', `${label}.policy.version`);
    historyLiteral(policy.state, 'handoff-generated', `${label}.policy.state`);
    historyLiteral(policy.liveEnforcement, 'not-active', `${label}.policy.liveEnforcement`);
    const discovery = historyRecord(context.discovery, `${label}.discovery`);
    if (Object.values(discovery).some((entry) => entry !== 'undiscovered')) historyFail(label, 'context cannot assert live discovery.');
    if (historyArray(context.commands, `${label}.commands`).length === 0) historyFail(label, 'context must declare its generated commands.');
    historyRecord(context.generatedBoundaries, `${label}.generatedBoundaries`);
    validateHistoricalEmbeddedPaths(context, label);
  } else if (label === '.liftoff/governance/credential-policy.schema.json') {
    const schema = historyRecord(value, label);
    historyString(schema.$schema, `${label}.$schema`);
    const properties = historyRecord(schema.properties, `${label}.properties`);
    const identity = historyRecord(properties.identity, `${label}.properties.identity`);
    const identityProperties = historyExact(identity.properties, Object.keys(releasedManagedActivationIdentities[0]), `${label}.properties.identity.properties`);
    const declaredIdentity = Object.fromEntries(Object.entries(identityProperties).map(([key, entry]) => {
      const declaration = historyExact(entry, ['const'], `${label}.properties.identity.properties.${key}`);
      return [key, declaration.const];
    }));
    const identityDigest = canonicalSha256(declaredIdentity);
    if (!releasedManagedActivationIdentities.some((identity) => identityDigest === canonicalSha256(identity))) {
      historyFail(label, 'credential schema must declare an exact released v1, v2 or v3 activation identity.', 'invalid-managed-source-metadata');
    }
  } else {
    historyRecord(value, label);
  }
}

function sourceFile(snapshot: ProjectFileSnapshot, kind: HistoricalFileKind): HistoricalSourceFile {
  if (snapshot.content === undefined || snapshot.mode === undefined) {
    historyFail(historyPathKey(snapshot.pathParts), 'required historical source is missing.', 'missing-historical-record');
  }
  assertSafeHistoricalBytes(snapshot.content, historyPathKey(snapshot.pathParts));
  return {
    kind, pathParts: [...snapshot.pathParts], content: snapshot.content,
    digest: rawHistoryDigest(snapshot.content), mode: snapshot.mode
  };
}

export async function historicalActiveRecordPaths(projectRoot: string, directory: string): Promise<string[][]> {
  historyRecordId(directory, 'historical active collection');
  const parts = ['governance', directory];
  const target = await resolveHistoryProjectPath(projectRoot, parts);
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return [];
  }
  return entries.filter((entry) => /\.json$/iu.test(entry.name)).map((entry) => [...parts, entry.name])
    .sort((a, b) => historyPathKey(a) < historyPathKey(b) ? -1 : 1);
}

function validateAt<T>(file: HistoricalSourceFile, validator: (value: unknown) => T): T {
  try { return validator(parseHistoryJson(file.content, historyPathKey(file.pathParts))); }
  catch (error) {
    if (!(error instanceof ActivationHistoryError)) throw error;
    return historyFail(historyPathKey(file.pathParts), error.message, error.code);
  }
}

export function validateReadableHistoricalActivationState(value: unknown): ReadableHistoricalActivationState {
  const item = historyRecord(value, 'historicalActivationState');
  return isHistoricalV2ActivationIdentity(item.identity)
    ? validateHistoricalV2ActivationState(value) : validateHistoricalActivationState(value);
}

export async function readHistoricalActivationInventory(
  projectRoot: string, options: HistoricalInventoryOptions = {}
): Promise<HistoricalActivationInventory> {
  return readHistoricalInventory(
    (parts) => captureHistoryFile(projectRoot, parts),
    (directory) => historicalActiveRecordPaths(projectRoot, directory), options
  );
}

/** Read only the exact stored copies in an index; never substitute current active files. */
export async function readHistoricalSnapshotInventory(
  projectRoot: string, index: ActivationHistoryIndex
): Promise<HistoricalActivationInventory> {
  return readSnapshotInventory(index, (parts) => captureHistoryFile(projectRoot, parts));
}

/** Interpret only the exact already-captured copies; these semantic paths are not physical preconditions. */
export async function validateCapturedHistoricalSnapshot(
  index: ActivationHistoryIndex, copies: readonly ProjectFileSnapshot[]
): Promise<HistoricalActivationInventory> {
  return readCapturedSourceSnapshot(validateFrozenActivationHistoryIndex(index), copies, false);
}

export async function validateCapturedV3SourceSnapshot(
  index: FrozenV3SourceIndexV1, copies: readonly ProjectFileSnapshot[]
): Promise<FrozenV3SourceInventory> {
  return readCapturedSourceSnapshot(validateFrozenV3SourceIndex(index), copies, true);
}

export type ReleasedSourceInventory = HistoricalActivationInventory | FrozenV3SourceInventory;

/** Active originals captured independently; the caller cannot supply a parser or a live-file fallback. */
export async function validateCapturedReleasedSource(
  captures: readonly ProjectFileSnapshot[], options: HistoricalInventoryOptions = {}
): Promise<ReleasedSourceInventory> {
  options = copySourceInventoryOptions(options);
  const observed = copySourceHistoryObservations(captures);
  const state = observed.find(file => historyPathKey(file.pathParts) === 'governance/activation-state.json');
  if (!state?.content) historyFail('source state', 'is required.', 'missing-historical-record');
  const raw = historyRecord(parseHistoryJson(state.content, 'source state'), 'source state');
  const v3 = isReleasedV3ActivationIdentity(raw.identity);
  const byPath = new Map(observed.map(file => [historyPathKey(file.pathParts), file]));
  const inventory = await readHistoricalInventory(async parts => {
    const found = byPath.get(historyPathKey(parts));
    if (!found) historyFail(historyPathKey(parts), 'required independent source observation is absent.', 'missing-historical-record');
    return found;
  }, async directory => observed.filter(file => file.content !== undefined && file.pathParts.length === 3 &&
    file.pathParts[0] === 'governance' && file.pathParts[1] === directory).map(file => file.pathParts), options, true, v3);
  if (inventory.sourceMigration) {
    if (inventory.state.schemaVersion === 1) historyFail('source journal', 'v1 cannot name a predecessor.');
    assertCompletedSourceRevalidation(inventory.state, inventory.sourceMigration, inventory.files.filter(file => file.kind === 'evidence')
      .map(file => validateAt(file, value => v3 ? validateHistoricalV3EvidenceRecord(value) : validateHistoricalV2EvidenceRecord(value))));
  }
  if (v3) return {
    ...inventory, state: validateHistoricalV3ActivationState(inventory.state),
    sourceMigration: inventory.sourceMigration ? validateHistoricalV3SourceMigrationJournal(inventory.sourceMigration) : undefined
  };
  return {
    ...inventory, state: validateReadableHistoricalActivationState(inventory.state),
    sourceMigration: inventory.sourceMigration ? validateHistoricalV2SourceMigrationJournal(inventory.sourceMigration) : undefined,
    sourceChangeMetadata: inventory.sourceChangeMetadata ? validateHistoricalGovernanceChangeMetadata(inventory.sourceChangeMetadata) : undefined
  };
}

/** Planned copies do not exist yet: validate original bytes and their index roles directly. */
export async function validatePlannedReleasedSourceSnapshot(
  index: ActivationHistoryIndex | FrozenV3SourceIndexV1, originals: readonly ProjectFileSnapshot[]
): Promise<ReleasedSourceInventory> {
  index = copySourceHistoryData(index, 'planned source index');
  const validated = isReleasedV3ActivationIdentity(index.sourceIdentity) ? validateFrozenV3SourceIndex(index) : validateFrozenActivationHistoryIndex(index);
  const captured = copySourceHistoryObservations(originals);
  const byPath = new Map(captured.map(file => [historyPathKey(file.pathParts), file]));
  if (captured.length !== validated.files.length || captured.some(file => file.content === undefined)) {
    historyFail('planned source', 'requires exactly all original indexed files.', 'invalid-historical-reference');
  }
  for (const entry of validated.files) {
    const original = byPath.get(historyPathKey(entry.originalPathParts));
    if (!original?.content || original.mode !== entry.mode || rawHistoryDigest(original.content) !== entry.digest) {
      historyFail(historyPathKey(entry.originalPathParts), 'original bytes or mode contradict the planned index.', 'history-digest-mismatch');
    }
  }
  const inventory = await readSnapshotInventory(validated, async parts => {
    const entry = validated.files.find(file => historyPathKey(file.copyPathParts) === historyPathKey(parts));
    if (!entry) historyFail('planned source', 'unregistered copy requested.');
    const original = byPath.get(historyPathKey(entry.originalPathParts))!;
    return { ...original, pathParts: [...parts] };
  }, isReleasedV3ActivationIdentity(validated.sourceIdentity));
  if (inventory.sourceMigration) {
    if (inventory.state.schemaVersion === 1) historyFail('source journal', 'v1 cannot name a predecessor.');
    assertCompletedSourceRevalidation(inventory.state, inventory.sourceMigration, inventory.files.filter(file => file.kind === 'evidence')
      .map(file => validateAt(file, value => inventory.state.schemaVersion === 3 ? validateHistoricalV3EvidenceRecord(value) : validateHistoricalV2EvidenceRecord(value))));
  }
  if (isReleasedV3ActivationIdentity(validated.sourceIdentity)) return {
    ...inventory, state: validateHistoricalV3ActivationState(inventory.state),
    sourceMigration: inventory.sourceMigration ? validateHistoricalV3SourceMigrationJournal(inventory.sourceMigration) : undefined
  };
  return { ...inventory, state: validateReadableHistoricalActivationState(inventory.state),
    sourceMigration: inventory.sourceMigration ? validateHistoricalV2SourceMigrationJournal(inventory.sourceMigration) : undefined,
    sourceChangeMetadata: inventory.sourceChangeMetadata ? validateHistoricalGovernanceChangeMetadata(inventory.sourceChangeMetadata) : undefined };
}

function readCapturedSourceSnapshot(index: ActivationHistoryIndex, copies: readonly ProjectFileSnapshot[], v3: false): Promise<HistoricalActivationInventory>;
function readCapturedSourceSnapshot(index: FrozenV3SourceIndexV1, copies: readonly ProjectFileSnapshot[], v3: true): Promise<FrozenV3SourceInventory>;
async function readCapturedSourceSnapshot(
  validated: ActivationHistoryIndex | FrozenV3SourceIndexV1, copies: readonly ProjectFileSnapshot[], v3: boolean
): Promise<StoredSourceInventory> {
  const byPath = new Map<string, ProjectFileSnapshot>();
  for (const copy of copies) {
    const key = historyPathKey(historyPathParts(copy.pathParts, 'captured history path'));
    if (byPath.has(key) || !Buffer.isBuffer(copy.content) || copy.mode === undefined ||
      !validated.files.some(file => historyPathKey(file.copyPathParts) === key)) {
      historyFail(key, 'is not a unique complete indexed copy observation.', 'invalid-historical-reference');
    }
    byPath.set(key, copy);
  }
  if (byPath.size !== validated.files.length) historyFail('captured history', 'requires every indexed copy.', 'missing-historical-record');
  const inventory = await readSnapshotInventory(validated, async parts => {
    const found = byPath.get(historyPathKey(parts));
    if (!found) return historyFail(historyPathKey(parts), 'indexed copy was not captured.', 'missing-historical-record');
    return found;
  }, v3);
  if (inventory.sourceMigration) {
    if (inventory.state.schemaVersion === 1) historyFail('source migration', 'requires its exact v2 successor.', 'invalid-historical-reference');
    const evidence = inventory.files.filter(file => file.kind === 'evidence').map(file =>
      validateAt(file, value => inventory.state.schemaVersion === 3 ? validateHistoricalV3EvidenceRecord(value) : validateHistoricalV2EvidenceRecord(value)));
    assertCompletedSourceRevalidation(inventory.state, inventory.sourceMigration, evidence);
  }
  return inventory;
}

function readSnapshotInventory(index: ActivationHistoryIndex, captureCopy: (parts: readonly string[]) => Promise<ProjectFileSnapshot>): Promise<HistoricalActivationInventory>;
function readSnapshotInventory(index: ActivationHistoryIndex | FrozenV3SourceIndexV1, captureCopy: (parts: readonly string[]) => Promise<ProjectFileSnapshot>, v3: boolean): Promise<StoredSourceInventory>;
async function readSnapshotInventory(
  index: ActivationHistoryIndex | FrozenV3SourceIndexV1,
  captureCopy: (parts: readonly string[]) => Promise<ProjectFileSnapshot>, v3 = false
): Promise<StoredSourceInventory> {
  const byPath = new Map(index.files.map((file) => [historyPathKey(file.originalPathParts), file]));
  const inventory = await readHistoricalInventory(async (parts) => {
    const file = byPath.get(historyPathKey(parts));
    if (!file) return { pathParts: [...parts] };
    const copy = await captureCopy(file.copyPathParts);
    if (!copy.content || rawHistoryDigest(copy.content) !== file.digest) {
      historyFail(historyPathKey(file.copyPathParts), 'declared copy is missing or differs from its recorded raw digest.', 'history-digest-mismatch');
    }
    return { pathParts: [...parts], content: copy.content, mode: file.mode };
  }, async (directory) => index.files
    .filter((file) => file.originalPathParts.length === 3 && file.originalPathParts[0] === 'governance' &&
      file.originalPathParts[1] === directory).map((file) => [...file.originalPathParts]), {
    reviewedUnreferencedPathParts: index.files
      .filter((file) => ['evidence', 'plan', 'approval'].includes(file.kind)).map((file) => file.originalPathParts)
  }, v3, v3);
  if (canonicalSha256(inventory.state.identity) !== canonicalSha256(index.sourceIdentity) ||
    canonicalSha256(inventory.files.map((file) => historyPathKey(file.pathParts)).sort()) !==
    canonicalSha256(index.files.map((file) => historyPathKey(file.originalPathParts)).sort())) {
    historyFail('activationHistoryIndex', 'source contract or complete record inventory contradicts its snapshot.', 'invalid-historical-reference');
  }
  return inventory;
}

function assertCompletedSourceRevalidation(
  successor: HistoricalV3ActivationState | HistoricalV2ActivationState,
  journal: HistoricalV3SourceMigrationJournal | HistoricalV2SourceMigrationJournal,
  evidence: readonly (HistoricalV3EvidenceRecord | HistoricalV2EvidenceRecord)[]
): void {
  if (new Set(evidence.map(record => record.evidenceId)).size !== evidence.length) {
    historyFail('released source revalidation', 'contains duplicate evidence identities.', 'invalid-historical-reference');
  }
  for (const phase of journal.revalidation.phases.filter(phase => phase.status === 'complete')) {
    if (phase.evidenceIds.some(id => !evidence.some(record =>
      record.evidenceId === id && record.header.repositoryId === successor.repository.id &&
      record.header.phaseId === phase.phaseId && record.header.result === 'verified' &&
      successor.phases[phase.phaseId].evidence.some(reference =>
        reference.evidenceId === id && reference.headerDigest === canonicalSha256(record.header) &&
        reference.phaseId === phase.phaseId && reference.result === 'verified')))) {
      historyFail('released source revalidation', 'completed work lacks its original matching proof reference.', 'invalid-historical-reference');
    }
  }
}

function assertSourceLocalAnchor(successorId: string, sourceId: string): void {
  if (/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(sourceId) &&
    successorId !== sourceId) {
    historyFail('released successor anchor', 'replaced a protected original local anchor.', 'invalid-historical-reference');
  }
}

function assertInheritedSourceMetadata(
  successor: HistoricalV3ActivationState | HistoricalV2ActivationState,
  inheritedMetadata: HistoricalGovernanceChangeMetadata | V3SourceMetadata | undefined,
  source: ReadableHistoricalActivationState
): void {
  if (inheritedMetadata && canonicalSha256(inheritedMetadata.activationIdentity) !== canonicalSha256(successor.identity) &&
    (canonicalSha256(inheritedMetadata.activationIdentity) !== canonicalSha256(source.identity) ||
      canonicalSha256(successor.activeChange) !== canonicalSha256(source.activeChange))) {
    historyFail('released source metadata', 'inherited metadata is not bound to its exact ancestor pointer.', 'invalid-historical-reference');
  }
}

export function assertCapturedHistoricalAncestor(
  successor: HistoricalActivationInventory, index: ActivationHistoryIndex, source: HistoricalActivationInventory
): void {
  const journal = successor.sourceMigration;
  if (!journal || successor.state.schemaVersion !== 2 || source.state.schemaVersion !== 1 ||
    canonicalSha256(successor.state.identity) !== canonicalSha256(journal.targetIdentity) ||
    successor.state.repository.id !== journal.successor.repositoryId || successor.state.createdAt !== journal.successor.createdAt ||
    index.snapshotId !== journal.snapshotId || canonicalSha256(index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
    historyFail('released source ancestry', 'does not match the exact v1-to-v2 source relationship.', 'invalid-historical-reference');
  }
  if (index.files.some(file => !['manifest', 'state', 'metadata', 'evidence', 'plan', 'approval'].includes(file.kind))) {
    historyFail('released v1-to-v2 index', 'contains roles absent from that published lane.', 'unsupported-historical-record');
  }
  assertSourceLocalAnchor(successor.state.repository.id, source.state.repository.id);
  assertInheritedSourceMetadata(successor.state, successor.sourceChangeMetadata, source.state);
}

export function assertCapturedV3SourceAncestor(
  successor: FrozenV3SourceInventory, index: ActivationHistoryIndex, source: HistoricalActivationInventory
): void {
  const journal = successor.sourceMigration, link = successor.state.successorHistory;
  if (!journal || !link || index.snapshotId !== journal.snapshotId ||
    canonicalSha256(index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity) ||
    canonicalSha256(link.sourceActiveChange) !== canonicalSha256(source.state.activeChange)) {
    historyFail('released v3 ancestry', 'does not match its exact original source and backlink.', 'invalid-historical-reference');
  }
  assertSourceLocalAnchor(successor.state.repository.id, source.state.repository.id);
  const inherited = successor.sourceChangeMetadata;
  if (inherited && canonicalSha256(inherited.activationIdentity) !== canonicalSha256(successor.state.identity) &&
    (canonicalSha256(successor.state.activeChange) !== canonicalSha256(source.state.activeChange) ||
      canonicalSha256(inherited) !== canonicalSha256(source.sourceChangeMetadata))) {
    historyFail('released v3 source metadata', 'does not preserve the declared ancestor metadata and source pointer.', 'invalid-historical-reference');
  }
  if (source.state.activeChange && !source.sourceChangeMetadata) {
    historyFail('released source metadata', 'required source-change metadata and tasks are missing.', 'missing-historical-record');
  }
}

export function assertCapturedV3MetadataAncestry(inventories: readonly (FrozenV3SourceInventory | HistoricalActivationInventory)[]): void {
  for (const inventory of inventories) {
    const metadata = inventory.sourceChangeMetadata;
    if (!metadata) continue;
    const origin = inventories.find(source => canonicalSha256(source.state.identity) === canonicalSha256(metadata.activationIdentity));
    if (!origin || canonicalSha256(origin.state.activeChange) !== canonicalSha256(inventory.state.activeChange)) {
      historyFail('stored source metadata', 'has no exact declared original source context.', 'invalid-historical-reference');
    }
    assertHistoricalV3MetadataReferences(metadata, origin.files.filter(file => file.kind === 'evidence').map(file =>
      validateAt(file, value => origin.state.schemaVersion === 3 ? validateHistoricalV3EvidenceRecord(value) :
        origin.state.schemaVersion === 2 ? validateHistoricalV2EvidenceRecord(value) :
          validateHistoricalEvidenceRecord(value, file.pathParts.at(-1)!.slice(0, -5)))));
  }
}

export interface ReleasedV3SourceHistory {
  state: HistoricalV3ActivationState;
  manifest: LiftoffManifest;
  ancestors: readonly {
    journal: HistoricalV3SourceMigrationJournal | HistoricalV2SourceMigrationJournal;
    index: ActivationHistoryIndex;
    inventory: HistoricalActivationInventory;
  }[];
  preconditions: readonly ProjectFileSnapshot[];
}

/** Reads only released source-history relationships; never selects execution authority. */
export async function readReleasedV3SourceHistory(projectRoot: string): Promise<ReleasedV3SourceHistory> {
  const stateFile = sourceFile(await captureHistoryFile(projectRoot, historicalActivationStatePathParts), 'state');
  const state = validateAt(stateFile, validateHistoricalV3ActivationState);
  const manifestFile = sourceFile(await captureHistoryFile(projectRoot, historicalManifestPathParts), 'manifest');
  const manifestValue = parseHistoryJson(manifestFile.content, historyPathKey(manifestFile.pathParts));
  assertSafeHistoricalRecord(manifestValue, 'released v3 manifest');
  const rawManifest = historyRecord(manifestValue, 'released v3 manifest');
  historyLiteral(rawManifest.artifactVersion, 7, 'released v3 manifest.artifactVersion');
  const governance = historyRecord(rawManifest.governance, 'released v3 manifest.governance');
  if (!isReleasedV3ActivationIdentity(governance.activationIdentity)) {
    historyFail('released v3 manifest', 'does not match its source activation state.', 'mixed-active-identity');
  }
  let manifest: LiftoffManifest;
  try { manifest = parseManifest(manifestValue); }
  catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return historyFail('released v3 manifest', error.message, 'invalid-historical-manifest');
  }
  if (state.activeChange && state.activeChange.kind !== manifest.project.specWorkflow) {
    historyFail('released v3 state', 'active change contradicts its recorded workflow.', 'historical-spec-ownership-conflict');
  }
  const journalSnapshot = await captureHistoryFile(projectRoot, migrationStateFilePathParts);
  const preconditions: ProjectFileSnapshot[] = [stateFile, manifestFile, journalSnapshot];
  const ancestors: ReleasedV3SourceHistory['ancestors'][number][] = [];
  if (journalSnapshot.content === undefined) {
    if (state.successorHistory) historyFail('released v3 state', 'declares a missing source migration journal.', 'missing-historical-record');
    return { state, manifest, ancestors, preconditions };
  }
  let journal: HistoricalV3SourceMigrationJournal | HistoricalV2SourceMigrationJournal =
    validateHistoricalV3SourceMigrationJournal(parseHistoryJson(journalSnapshot.content, 'released v3 migration journal'));
  const link = state.successorHistory;
  if (!link || link.snapshotId !== journal.snapshotId || link.historyIndexDigest !== journal.historyIndexDigest ||
    historyPathKey(link.historyIndexPathParts) !== historyPathKey(journal.historyIndexPathParts) ||
    historyPathKey(link.journalPathParts) !== historyPathKey(migrationStateFilePathParts)) {
    historyFail('released v3 state', 'backlink contradicts its original migration journal.', 'invalid-historical-reference');
  }
  let successor: HistoricalV3ActivationState | HistoricalV2ActivationState = state;
  let successorInventory: HistoricalActivationInventory | undefined;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(journal.snapshotId) || seen.size >= 2) {
      historyFail('released v3 history', 'does not follow the finite released predecessor contracts.', 'invalid-historical-reference');
    }
    seen.add(journal.snapshotId);
    if (canonicalSha256(successor.identity) !== canonicalSha256(journal.targetIdentity) ||
      successor.repository.id !== journal.successor.repositoryId || successor.createdAt !== journal.successor.createdAt) {
      historyFail('released source journal', 'contradicts its original successor identity or anchor.', 'invalid-historical-reference');
    }
    if (journal.revalidation.phases.some(phase => phase.status === 'complete')) {
      const evidence: Array<HistoricalV3EvidenceRecord | HistoricalV2EvidenceRecord> = [];
      if (successorInventory) {
        for (const file of successorInventory.files.filter(file => file.kind === 'evidence')) {
          evidence.push(validateAt(file, validateHistoricalV2EvidenceRecord));
        }
      } else {
        for (const parts of await historicalActiveRecordPaths(projectRoot, 'evidence')) {
          const snapshot = await captureHistoryFile(projectRoot, parts);
          evidence.push(validateAt(sourceFile(snapshot, 'evidence'), validateHistoricalV3EvidenceRecord));
          preconditions.push(snapshot);
        }
      }
      assertCompletedSourceRevalidation(successor, journal, evidence);
    }
    const indexSnapshot = await captureHistoryFile(projectRoot, journal.historyIndexPathParts);
    if (!indexSnapshot.content || rawHistoryDigest(indexSnapshot.content) !== journal.historyIndexDigest) {
      historyFail('released source index', 'is missing or its raw digest differs.', 'history-digest-mismatch');
    }
    const index = validateActivationHistoryIndex(parseHistoryJson(indexSnapshot.content, 'released source index'));
    if (index.snapshotId !== journal.snapshotId || canonicalSha256(index.sourceIdentity) !== canonicalSha256(journal.sourceIdentity)) {
      historyFail('released source index', 'contradicts its original migration source.', 'invalid-historical-reference');
    }
    if (journal.laneId === 'activation-v1-to-v2' &&
      index.files.some(file => !['manifest', 'state', 'metadata', 'evidence', 'plan', 'approval'].includes(file.kind))) {
      historyFail('released v1-to-v2 index', 'contains roles absent from that published lane.', 'unsupported-historical-record');
    }
    preconditions.push(indexSnapshot);
    for (const file of index.files) {
      const copy = await captureHistoryFile(projectRoot, file.copyPathParts);
      if (!copy.content || rawHistoryDigest(copy.content) !== file.digest) {
        historyFail(historyPathKey(file.copyPathParts), 'is missing or differs from its original index.', 'history-digest-mismatch');
      }
      preconditions.push(copy);
    }
    const inventory = await readHistoricalSnapshotInventory(projectRoot, index);
    assertSourceLocalAnchor(successor.repository.id, inventory.state.repository.id);
    if (ancestors.length === 0 && canonicalSha256(link.sourceActiveChange) !== canonicalSha256(inventory.state.activeChange)) {
      historyFail('released v3 source pointer', 'contradicts the preserved original state.', 'invalid-historical-reference');
    }
    if (inventory.state.activeChange && !inventory.sourceChangeMetadata) {
      historyFail('released source metadata', 'required source-change metadata and tasks are missing.', 'missing-historical-record');
    }
    assertInheritedSourceMetadata(successor, successorInventory?.sourceChangeMetadata, inventory.state);
    ancestors.push({ journal, index, inventory });
    if (!inventory.sourceMigration) break;
    if (inventory.state.schemaVersion !== 2) {
      historyFail('released source ancestry', 'only released v2 can name the v1-to-v2 predecessor.', 'invalid-historical-reference');
    }
    successor = inventory.state;
    successorInventory = inventory;
    journal = inventory.sourceMigration;
  }
  return { state, manifest, ancestors, preconditions };
}

function readHistoricalInventory(capture: (parts: readonly string[]) => Promise<ProjectFileSnapshot>, paths: (directory: string) => Promise<string[][]>, options: HistoricalInventoryOptions, requireSourceChange?: boolean): Promise<HistoricalActivationInventory>;
function readHistoricalInventory(capture: (parts: readonly string[]) => Promise<ProjectFileSnapshot>, paths: (directory: string) => Promise<string[][]>, options: HistoricalInventoryOptions, requireSourceChange: boolean, v3: boolean): Promise<StoredSourceInventory>;
async function readHistoricalInventory(
  captureSource: (parts: readonly string[]) => Promise<ProjectFileSnapshot>,
  activeRecordPaths: (directory: string) => Promise<string[][]>,
  options: HistoricalInventoryOptions,
  requireSourceChange = true, v3 = false
): Promise<StoredSourceInventory> {
  const preconditions: ProjectFileSnapshot[] = [];
  const capture = async (parts: readonly string[]) => {
    const snapshot = await captureSource(parts);
    preconditions.push(snapshot);
    return snapshot;
  };
  const manifestFile = sourceFile(await capture(historicalManifestPathParts), 'manifest');
  const stateFile = sourceFile(await capture(historicalActivationStatePathParts), 'state');
  const manifest = validateAt(manifestFile, v3 ? validateFrozenV3Manifest : validateHistoricalSourceManifest);
  const state = validateAt(stateFile, value => v3 ? validateHistoricalV3ActivationState(value) : validateReadableHistoricalActivationState(value));
  if (!('activationIdentity' in manifest.governance) ||
    canonicalSha256(manifest.governance.activationIdentity) !== canonicalSha256(state.identity)) {
    historyFail(historyPathKey(stateFile.pathParts), 'active state and manifest declare different source contracts.', 'mixed-active-identity');
  }
  if (state.activeChange !== null && state.activeChange.kind !== manifest.project.specWorkflow) {
    historyFail(historyPathKey(stateFile.pathParts), 'active change belongs to a different spec workflow.', 'historical-spec-ownership-conflict');
  }
  const files = [manifestFile, stateFile];
  let sourceMigration: HistoricalV2SourceMigrationJournal | HistoricalV3SourceMigrationJournal | undefined;
  const migrationSnapshot = await capture(migrationStateFilePathParts);
  if (migrationSnapshot.content !== undefined) {
    if (state.schemaVersion === 1) historyFail(historyPathKey(migrationStateFilePathParts), 'v1 active state cannot have a committed v2 source migration.', 'mixed-active-identity');
    const file = sourceFile(migrationSnapshot, 'migration');
    sourceMigration = validateAt(file, value => v3 ? validateHistoricalV3SourceMigrationJournal(value) : validateHistoricalV2SourceMigrationJournal(value));
    if (sourceMigration.successor.repositoryId !== state.repository.id || sourceMigration.successor.createdAt !== state.createdAt) {
      historyFail(historyPathKey(file.pathParts), 'source migration does not identify this active v2 successor.', 'invalid-historical-reference');
    }
    files.push(file);
  }
  if (state.schemaVersion === 3) {
    const link = state.successorHistory;
    if (!!link !== !!sourceMigration || sourceMigration && (!link ||
      canonicalSha256(sourceMigration.targetIdentity) !== canonicalSha256(state.identity) ||
      link.snapshotId !== sourceMigration.snapshotId || link.historyIndexDigest !== sourceMigration.historyIndexDigest ||
      historyPathKey(link.historyIndexPathParts) !== historyPathKey(sourceMigration.historyIndexPathParts) ||
      historyPathKey(link.journalPathParts) !== 'governance/migration-state.json')) {
      historyFail('released v3 source', 'journal and state backlink are missing or inconsistent.', 'invalid-historical-reference');
    }
  }
  let sourceChangeMetadata: HistoricalGovernanceChangeMetadata | V3SourceMetadata | undefined;
  if (state.activeChange) {
    const base = historicalSourceChangePathParts(state.activeChange);
    const metadataSnapshot = await capture([...base, 'liftoff-governance.json']);
    const tasksSnapshot = await capture([...base, 'tasks.md']);
    if (requireSourceChange || metadataSnapshot.content !== undefined || tasksSnapshot.content !== undefined) {
      const metadataFile = sourceFile(metadataSnapshot, 'source-metadata');
      const tasksFile = sourceFile(tasksSnapshot, 'source-tasks');
      sourceChangeMetadata = validateAt(metadataFile, value => v3 && isRecord(value) && isReleasedV3ActivationIdentity(value.activationIdentity)
        ? validateHistoricalV3GovernanceChangeMetadata(value) : validateHistoricalGovernanceChangeMetadata(value));
      if (sourceChangeMetadata.changeId !== state.activeChange.id || sourceChangeMetadata.workflowKind !== state.activeChange.kind ||
        !(v3 && sourceMigration || [state.identity, ...(sourceMigration ? [sourceMigration.sourceIdentity] : [])].some((identity) =>
          canonicalSha256(identity) === canonicalSha256(sourceChangeMetadata!.activationIdentity)))) {
        historyFail(historyPathKey(metadataFile.pathParts), 'metadata does not match the recorded historical source change.', 'invalid-historical-reference');
      }
      files.push(metadataFile, tasksFile);
    }
  }
  for (const parts of historicalMetadataPathParts) {
    const snapshot = await capture(parts);
    if (snapshot.content === undefined) continue;
    const file = sourceFile(snapshot, 'metadata');
    validateHistoricalMetadata(file);
    files.push(file);
  }
  const evidence = new Map<string, { file: HistoricalSourceFile; record: HistoricalEvidenceRecord | HistoricalV2EvidenceRecord | HistoricalV3EvidenceRecord }>();
  const plans: Array<{ file: HistoricalSourceFile; record: HistoricalSavedTransitionPlan | HistoricalV2SavedTransitionPlan | HistoricalV3SavedTransitionPlan }> = [];
  const approvals = new Map<string, { file: HistoricalSourceFile; record: HistoricalApprovalEnvelope | HistoricalV2ApprovalEnvelope | HistoricalV3ApprovalEnvelope }>();
  for (const [directory, kind] of [['evidence', 'evidence'], ['plans', 'plan'], ['approvals', 'approval']] as const) {
    for (const parts of await activeRecordPaths(directory)) {
      const file = sourceFile(await capture(parts), kind);
      if (!parts[2].endsWith('.json')) historyFail(historyPathKey(parts), 'active record extension is not the registered lowercase .json layout.');
      if (kind === 'evidence') {
        const record = validateAt(file, (value) => state.schemaVersion === 3 ? validateHistoricalV3EvidenceRecord(value) : state.schemaVersion === 2
          ? validateHistoricalV2EvidenceRecord(value) : validateHistoricalEvidenceRecord(value, parts[2].slice(0, -5)));
        if (record.header.schemaVersion === 3) {
          const issues = validatePhasePayloadValues(validateHistoricalV3EvidenceRecord(record), {
            allowLegacyCredentialPolicyOnly: true,
            allowLegacyProtectedStateProof: true
          });
          if (issues.length) historyFail(historyPathKey(parts), issues.join(' '), 'invalid-historical-reference');
        }
        if (record.header.repositoryId !== state.repository.id) historyFail(historyPathKey(parts), 'historical evidence belongs to another repository.', 'invalid-historical-reference');
        if (evidence.has(record.evidenceId)) historyFail(historyPathKey(parts), 'duplicates an evidence identity.');
        evidence.set(record.evidenceId, { file, record });
      } else if (kind === 'plan') {
        plans.push({ file, record: validateAt(file, (value) => state.schemaVersion === 3 ? validateHistoricalV3SavedTransitionPlan(value) : state.schemaVersion === 2
          ? validateHistoricalV2SavedTransitionPlan(value) : validateHistoricalSavedTransitionPlan(value)) });
      } else {
        const record = validateAt(file, (value) => state.schemaVersion === 3 ? validateHistoricalV3ApprovalEnvelope(value) : state.schemaVersion === 2
          ? validateHistoricalV2ApprovalEnvelope(value) : validateHistoricalApprovalEnvelope(value));
        if (record.schemaVersion === 3 && record.phasePlanDigests &&
          record.planDigest !== approvalBundleDigest(record.scope ?? scope(record.phaseId), record.phasePlanDigests)) {
          historyFail(historyPathKey(parts), 'bundle authority digest contradicts its retained phase map.', 'history-digest-mismatch');
        }
        if (approvals.has(record.id)) historyFail(historyPathKey(parts), 'duplicates an approval identity.');
        approvals.set(record.id, { file, record });
      }
    }
  }
  for (const [directory, kind] of [['supersessions', 'supersession'], ['reconciliation', 'reconciliation']] as const) {
    const records = await activeRecordPaths(directory);
    for (const parts of records) {
      const file = sourceFile(await capture(parts), kind);
      try {
        validateAt(file, (value) => state.schemaVersion === 3 ? validateHistoricalV3AuxiliaryRecord(value, kind) : state.schemaVersion === 1
          ? validateHistoricalV1AuxiliaryRecord(value, kind) : validateHistoricalV2AuxiliaryRecord(value, kind));
      } catch (error) {
        if (!(error instanceof ActivationHistoryError) || error.code !== 'invalid-history-record') throw error;
        historyFail(historyPathKey(parts), error.message, 'unsupported-active-record');
      }
      if (v3 && kind === 'reconciliation') validateAt(file, assertHistoricalV3Reconciliation);
      files.push(file);
    }
  }
  for (const parts of [['governance', 'credentials', 'preflight-policy.json'], ['governance', 'activation-baseline.json']]) {
    const snapshot = await capture(parts);
    if (snapshot.content !== undefined) {
      if (parts[1] === 'activation-baseline.json') {
        historyFail(historyPathKey(parts), 'active auxiliary proof has no registered source retirement contract; it cannot be silently carried forward.', 'unsupported-active-record');
      }
      const file = sourceFile(snapshot, 'credential-policy');
      validateAt(file, (value) => state.schemaVersion === 3 ? validateHistoricalV3AuxiliaryRecord(value, 'credential-policy') : state.schemaVersion === 1
        ? validateHistoricalV1AuxiliaryRecord(value, 'credential-policy') : validateHistoricalV2AuxiliaryRecord(value, 'credential-policy'));
      files.push(file);
    }
  }
  const selected = new Set<string>();
  const select = (file: HistoricalSourceFile) => selected.add(historyPathKey(file.pathParts));
  const requireApproval = (id: string, expectedPhase: string, expectedHash?: string) => {
    const found = approvals.get(id);
    if (!found) historyFail(`governance/approvals/${id}`, 'referenced historical approval is missing.', 'missing-historical-record');
    const scopeHash = found.record.schemaVersion === 3 ? historicalV3ApprovalEnvelopeHash(found.record) : found.record.schemaVersion === 1
      ? historicalApprovalEnvelopeHash(found.record) : historicalV2ApprovalEnvelopeHash(found.record);
    if (found.record.phaseId !== expectedPhase && !(found.record.schemaVersion === 3 && found.record.coveredPhases?.some(id => id === expectedPhase)) || expectedHash !== undefined && scopeHash !== expectedHash) {
      historyFail(historyPathKey(found.file.pathParts), 'approval phase or scope hash contradicts its reference.', 'invalid-historical-reference');
    }
    select(found.file);
  };
  const selectPlan = (entry: typeof plans[number]) => {
    select(entry.file);
    if (v3) {
      const plan = validateHistoricalV3SavedTransitionPlan(entry.record);
      const approval = plan.approval.envelopeId === null ? undefined : approvals.get(plan.approval.envelopeId)?.record;
      assertHistoricalV3PlanReferences(plan, approval === undefined ? undefined : validateHistoricalV3ApprovalEnvelope(approval));
    }
    if (entry.record.approval.envelopeId !== null) {
      if (entry.record.approval.envelopeHash === null) historyFail(historyPathKey(entry.file.pathParts), 'approval reference has no hash.');
      requireApproval(entry.record.approval.envelopeId, entry.record.phaseId, entry.record.approval.envelopeHash);
    }
  };
  const selectEvidence = (entry: { file: HistoricalSourceFile; record: HistoricalEvidenceRecord | HistoricalV2EvidenceRecord | HistoricalV3EvidenceRecord }) => {
    select(entry.file);
    const { header, payload, evidenceId } = entry.record;
    const matching = plans.filter((candidate) =>
      candidate.record.phaseId === header.phaseId && candidate.record.transitionDigest === header.transition.transitionDigest &&
      candidate.record.baselineDigest === header.baselineSha && candidate.record.inputDigest ===
        (header.schemaVersion === 3 ? header.inputBindings?.beforeDigest ?? header.transition.inputDigest : header.inputDigest) &&
      (header.schemaVersion !== 3 || !header.inputBindings ||
        canonicalSha256('fileChanges' in candidate.record ? candidate.record.fileChanges ?? [] : []) === canonicalSha256(header.inputBindings.files)));
    const planDigest = isRecord(payload) && Object.hasOwn(payload, 'planDigest')
      ? historyDigest(payload.planDigest, `${evidenceId}.payload.planDigest`) : undefined;
    const savedPlanDigest = isRecord(payload) && Object.hasOwn(payload, 'savedPlanDigest')
      ? historyDigest(payload.savedPlanDigest, `${evidenceId}.payload.savedPlanDigest`) : undefined;
    const linked = matching.filter((candidate) =>
      (planDigest === undefined || candidate.record.planDigest === planDigest) &&
      (savedPlanDigest === undefined || canonicalSha256(candidate.record) === savedPlanDigest));
    if (linked.length === 0 && (planDigest !== undefined || savedPlanDigest !== undefined || header.producer === 'liftoff-governance-transition-engine')) {
      historyFail(historyPathKey(entry.file.pathParts), 'required reviewed historical transition plan is missing or inconsistent.', 'missing-historical-record');
    }
    linked.forEach(selectPlan);
  };
  for (const id of v3 ? historicalV3PhaseGraph().phases.map(phase => phase.id) : historicalPhaseIds) {
    const phase = state.phases[id as keyof typeof state.phases];
    if (['verified', 'inapplicable', 'retained', 'disposed'].includes(phase.state) && phase.evidence.length === 0 ||
      phase.state === 'approved' && phase.approvals.length === 0) {
      historyFail(`governance/activation-state.json#phases.${id}`, 'terminal historical state has no required record references.', 'missing-historical-record');
    }
    if (['verified', 'inapplicable', 'retained', 'disposed'].includes(phase.state) &&
      !phase.evidence.some((reference) => reference.result === phase.state)) {
      historyFail(`governance/activation-state.json#phases.${id}`, 'terminal historical state has no matching result reference.', 'invalid-historical-reference');
    }
    for (const ref of phase.evidence) {
      const found = evidence.get(ref.evidenceId);
      if (!found) historyFail(`governance/evidence/${ref.evidenceId}.json`, 'referenced historical evidence is missing.', 'missing-historical-record');
      const header = found.record.header;
      if (header.phaseId !== id || header.result !== ref.result || canonicalSha256(header) !== ref.headerDigest) {
        historyFail(historyPathKey(found.file.pathParts), 'header digest, phase or result contradicts its state reference.', 'invalid-historical-reference');
      }
      selectEvidence(found);
    }
    for (const approvalId of phase.approvals) requireApproval(approvalId, id);
  }
  if (state.bootstrapState !== undefined) {
    const retained = evidence.get(state.bootstrapState.remoteImportEvidenceId);
    if (!retained || retained.record.header.phaseId !== 'remote-import-verified' ||
      canonicalSha256(retained.record.header) !== state.bootstrapState.remoteImportEvidenceDigest) {
      historyFail('governance/activation-state.json#bootstrapState', 'remote import evidence reference is missing or inconsistent.', 'invalid-historical-reference');
    }
    if (sourceMigration) {
      for (const phase of sourceMigration.revalidation.phases) {
        if (phase.status !== 'complete') continue;
        for (const id of phase.evidenceIds) {
          const found = evidence.get(id);
          if (!found || found.record.header.phaseId !== phase.phaseId || found.record.header.result !== 'verified' ||
            !state.phases[phase.phaseId].evidence.some((reference) => reference.evidenceId === id &&
              reference.headerDigest === canonicalSha256(found.record.header))) {
            historyFail(historyPathKey(migrationStateFilePathParts), 'completed source revalidation has a missing or contradictory historical proof link.', 'invalid-historical-reference');
          }
        }
      }
    }
    selectEvidence(retained);
    if (state.bootstrapState.deletionEvidenceId !== undefined) {
      const deletion = evidence.get(state.bootstrapState.deletionEvidenceId);
      if (!deletion || deletion.record.header.phaseId !== 'bootstrap-state-disposed') {
        historyFail('governance/activation-state.json#bootstrapState.deletionEvidenceId', 'referenced disposal evidence is missing or names another phase.', 'missing-historical-record');
      }
      selectEvidence(deletion);
    }
  }
  if (state.schemaVersion === 3) {
    const v3Evidence = [...evidence.values()].map(entry => validateHistoricalV3EvidenceRecord(entry.record));
    assertHistoricalV3StateReferences(state, plans.map(entry => validateHistoricalV3SavedTransitionPlan(entry.record)), v3Evidence);
    if (sourceChangeMetadata && isReleasedV3ActivationIdentity(sourceChangeMetadata.activationIdentity)) {
      assertHistoricalV3MetadataReferences(sourceChangeMetadata, v3Evidence);
    }
  }
  const allRecords = [...evidence.values(), ...plans, ...approvals.values()];
  const requested = new Set<string>();
  for (const raw of options.reviewedUnreferencedPathParts ?? []) {
    const key = historyPathKey(historyPathParts(raw, 'reviewed unreferenced path'));
    if (requested.has(key)) historyFail(key, 'duplicates a reviewed inventory entry.');
    requested.add(key);
    const found = allRecords.find((entry) => historyPathKey(entry.file.pathParts) === key);
    if (!found) historyFail(key, 'is not a recognized existing historical record.', 'unregistered-history-source');
    select(found.file);
    const plan = plans.find((entry) => entry.file === found.file);
    if (plan) selectPlan(plan);
    const proof = [...evidence.values()].find((entry) => entry.file === found.file);
    if (proof) selectEvidence(proof);
  }
  const unreviewedRecords: HistoricalSourceFile[] = [];
  for (const entry of allRecords) {
    if (selected.has(historyPathKey(entry.file.pathParts))) files.push(entry.file);
    else unreviewedRecords.push(entry.file);
  }
  files.sort((a, b) => historyPathKey(a.pathParts) < historyPathKey(b.pathParts) ? -1 : 1);
  return {
    manifest, state, ...(sourceMigration ? { sourceMigration } : {}),
    ...(sourceChangeMetadata ? { sourceChangeMetadata } : {}), files, unreviewedRecords, preconditions
  };
}

function phase(id: V3PhaseId) {
  return historicalV3PhaseGraph().phases.find(node => node.id === id)!;
}

function scope(id: V3PhaseId): Records.ReleasedGovernanceScopeV3 {
  const groups = historicalV3PhaseGraph().completionGroups;
  return groups.local.includes(id) ? 'local' : groups.lifecycle.includes(id) ? 'lifecycle' : 'activation';
}

export function historicalV3PlanAuthority(plan: HistoricalV3SavedTransitionPlan) {
  const primary = transitionAuthorityValues({
    phase: phase(plan.phaseId), transitionDigest: plan.transitionDigest, operations: plan.operations,
    configuration: plan.configuration, fileChanges: plan.fileChanges, recovery: plan.recovery
  }, scope(plan.phaseId));
  const phasePlanDigests = Object.fromEntries([
    [plan.phaseId, primary],
    ...(plan.approvalBundle ?? []).map(entry => [entry.phaseId, transitionAuthorityValues({
      phase: phase(entry.phaseId), transitionDigest: entry.transitionDigest, operations: entry.operations,
      configuration: plan.configuration, fileChanges: entry.fileChanges
    }, scope(entry.phaseId))])
  ]);
  return { primary, phasePlanDigests, digest: plan.approvalBundle?.length
    ? approvalBundleDigest(scope(plan.phaseId), phasePlanDigests) : primary };
}

export function historicalV3ProjectionContract(operations: readonly Records.TransitionOperationFieldsV2<V3PhaseId>[]) {
  const operation = projectionOperation(operations);
  if (!operation) return undefined;
  const contract = releasedV3TaskProjectionContract(operation.inputs.projection, historicalV3PhaseGraph());
  assertProjectionDestination(operation, contract);
  if (contract.source === 'create') {
    const metadata = validateHistoricalV3GovernanceChangeMetadata(parseHistoryJson(Buffer.from(contract.metadataText), 'projection metadata'));
    if (metadata.changeId !== contract.changeId || metadata.workflowKind !== contract.workflowKind) {
      historyFail('historical projection', 'creation metadata names a different source.', 'invalid-historical-reference');
    }
    assertTaskMarkers(contract.template, metadata.phaseTaskMapping);
    const ids = historicalV3PhaseGraph().phases.map(node => node.id);
    const states: Partial<Record<V3PhaseId, 'pending'>> = {};
    for (const id of ids) states[id] = 'pending';
    const layout = projectTaskCheckboxValues(contract.template, metadata.phaseTaskMapping, states, ids, releasedV3Values.phaseStates);
    if (sha256Hex(layout.markdown) !== contract.layoutHash) {
      historyFail('historical projection', 'retained creation layout hash differs.', 'history-digest-mismatch');
    }
  }
  return contract;
}

export function assertHistoricalV3PlanReferences(
  plan: HistoricalV3SavedTransitionPlan, approval: HistoricalV3ApprovalEnvelope | undefined
): void {
  const authority = historicalV3PlanAuthority(plan), evaluation = plan.approval.evaluation;
  if (plan.planDigest !== semanticPlanDigest({
    phase: phase(plan.phaseId), transitionDigest: plan.transitionDigest, operations: plan.operations, approvalPlanDigest: authority.digest
  })) historyFail('historical plan', 'semantic plan digest contradicts retained operations and authority.', 'history-digest-mismatch');
  if (plan.approval.gateKind !== phase(plan.phaseId).approvalGate.kind ||
    evaluation.phaseId !== plan.phaseId || evaluation.gateKind !== plan.approval.gateKind ||
    evaluation.approvalRequired !== plan.approval.required ||
    evaluation.envelopeId !== plan.approval.envelopeId || evaluation.envelopeHash !== plan.approval.envelopeHash ||
    (plan.approval.envelopeId === null) !== (plan.approval.envelopeHash === null) ||
    plan.rollbackPlan.phaseId !== plan.phaseId) {
    historyFail('historical plan', 'approval evaluation or rollback contradicts its phase.', 'invalid-historical-reference');
  }
  for (const operations of [plan.operations, ...(plan.approvalBundle ?? []).map(entry => entry.operations)]) {
    historicalV3ProjectionContract(operations);
  }
  if (plan.approval.envelopeId === null) return;
  if (!approval) historyFail('historical plan', 'declared approval is missing.', 'missing-historical-record');
  const bundled = !!plan.approvalBundle?.length;
  const phaseAuthority = approval.phasePlanDigests?.[plan.phaseId];
  if (approval.id !== plan.approval.envelopeId || historicalV3ApprovalEnvelopeHash(approval) !== plan.approval.envelopeHash ||
    approval.gateKind !== plan.approval.gateKind || approval.baselineSha !== plan.baselineDigest ||
    (approval.scope ?? scope(approval.phaseId)) !== plan.scope ||
    approval.phaseId !== plan.phaseId && !approval.coveredPhases?.includes(plan.phaseId) ||
    approval.planDigest !== authority.digest && (bundled || phaseAuthority !== authority.primary) ||
    bundled && canonicalSha256(approval.phasePlanDigests) !== canonicalSha256(authority.phasePlanDigests)) {
    historyFail('historical plan', 'stored approval does not bind the original authority scope.', 'invalid-historical-reference');
  }
  const entries = [{ phaseId: plan.phaseId, operations: plan.operations }, ...(plan.approvalBundle ?? [])];
  if (entries.some(entry => approval.phaseId !== entry.phaseId && !approval.coveredPhases?.includes(entry.phaseId)) ||
    approval.operationDigests && entries.some(entry => approvalOperationDigests(authorityOperationValues(entry.operations))
      .some(digest => !approval.operationDigests!.includes(digest)))) {
    historyFail('historical plan', 'stored bundle omits a retained phase or operation commitment.', 'invalid-historical-reference');
  }
}

export function assertHistoricalV3StateReferences(
  state: HistoricalV3ActivationState, plans: readonly HistoricalV3SavedTransitionPlan[], evidence: readonly HistoricalV3EvidenceRecord[]
): void {
  for (const { id } of historicalV3PhaseGraph().phases) {
    const phaseState = state.phases[id];
    if (new Set(phaseState.evidence.map(ref => ref.evidenceId)).size !== phaseState.evidence.length ||
      new Set(phaseState.approvals).size !== phaseState.approvals.length) {
      historyFail(id, 'contains duplicate original record references.', 'invalid-historical-reference');
    }
    for (const digest of [phaseState.executionPlanDigest, phaseState.operation?.planDigest]) {
      if (digest !== undefined && !plans.some(plan => plan.phaseId === id && plan.planDigest === digest)) {
        historyFail(id, 'execution or dispatch plan is missing.', 'missing-historical-record');
      }
    }
    const outputs = state.phaseOutputs?.[id];
    if (!outputs) continue;
    const bound = evidence.find(record => outputBindingsMatch(record, id, phaseState.evidence, outputs) &&
      record.header.bodyDigest === historicalV3EvidenceBodyDigest(record.payload, record.liveReadback));
    if (!outputResourcesMatch(outputs, bound)) {
      historyFail(id, 'stored output bindings lack their original referenced resource receipt.', 'invalid-historical-reference');
    }
  }
  for (const plan of plans) {
    for (const operations of [plan.operations, ...(plan.approvalBundle ?? []).map(entry => entry.operations)]) {
      const contract = historicalV3ProjectionContract(operations);
      if (contract?.source === 'create') {
        assertHistoricalV3MetadataReferences(validateHistoricalV3GovernanceChangeMetadata(
          parseHistoryJson(Buffer.from(contract.metadataText), 'projection metadata')), evidence);
      }
    }
  }
  const projection = state.taskProjection;
  if (!projection) return;
  const linked = plans.filter(plan => plan.phaseId === projection.phaseId && plan.planDigest === projection.planDigest);
  const contracts = linked.map(plan => historicalV3ProjectionContract(plan.operations));
  if (!contracts.some(contract => contract && canonicalSha256(contract) === projection.contractDigest &&
    contract.metadataHash === projection.metadataHash && contract.layoutHash === projection.layoutHash &&
    contract.taskPathParts.join('/') === projection.taskPathParts.join('/'))) {
    historyFail('historical task projection', 'audit has no matching original saved projection contract.', 'missing-historical-record');
  }
}

export function assertHistoricalV3MetadataReferences(
  metadata: { activationIdentity: Records.ActivationIdentityFieldsV1; createdFrom: { evidenceIds: readonly string[] } },
  evidence: readonly { evidenceId: string; header: { phaseId: string; identity: Records.ActivationIdentityFieldsV1 } }[]
): void {
  if (metadata.createdFrom.evidenceIds.some(id => !evidence.some(record => record.evidenceId === id &&
    record.header.phaseId === 'phase-0-complete' && canonicalSha256(record.header.identity) === canonicalSha256(metadata.activationIdentity)))) {
    historyFail('historical source metadata', 'declared original phase-0 evidence is missing.', 'missing-historical-record');
  }
}
