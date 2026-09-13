import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import type {
  ApprovalEnvelope, ApprovalEvaluation, BootstrapStateRetention, EvidenceHeader,
  EvidenceReference, LiveReadbackProof, PhaseExecutionState, SavedTransitionPlan,
  TransitionOperation, TransitionOperationDestination, TransitionRollbackPlan
} from '../domain/governance/activation/types.js';
import {
  historicalActivationIdentities, isHistoricalV2ActivationIdentity,
  type HistoricalActivationIdentity
} from '../domain/governance/policy/identity.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import { parseManifest } from '../application/project/manifest.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import {
  ActivationHistoryError, historicalIdentity, historicalV1Identity, historyArray, historyBoolean, historyCaseKey,
  historyDigest, historyEnum, historyExact, historyFail, historyLiteral, historyPathKey,
  historyPathParts, historyRecord, historyRecordId, historyString, historyStrings, historyTimestamp,
  historicalActivationIdentity, historicalActivationStatePathParts, historicalManifestPathParts, historicalMetadataPathParts,
  migrationStateFilePathParts, historicalSourceChangePathParts, parseHistoryJson, rawHistoryDigest, validateHistoricalV2SourceMigrationJournal,
  type HistoricalFileKind, type ActivationHistoryIndex, type HistoricalV2SourceMigrationJournal
} from './history-contracts.js';
import { FileSystemError } from '../domain/project/errors.js';
import { validateGovernanceCompatibilityMetadata } from './compatibility.js';
import { assertSafeHistoricalBytes, assertSafeHistoricalRecord } from './historical-safety.js';
import { historicalV1PhaseContractDigests, historicalV1ResultAllowed } from './historical-v1-phase-contracts.js';
import { validateHistoricalV1AuxiliaryRecord } from './historical-v1-auxiliary.js';
import { validateHistoricalGovernanceChangeMetadata, type HistoricalGovernanceChangeMetadata } from './historical-source-metadata.js';
import {
  validateHistoricalV2ActivationState, validateHistoricalV2EvidenceRecord,
  validateHistoricalV2ApprovalEnvelope, validateHistoricalV2SavedTransitionPlan,
  validateHistoricalV2Compatibility, historicalV2ApprovalEnvelopeHash,
  validateHistoricalV2AuxiliaryRecord,
  type HistoricalV2ActivationState, type HistoricalV2EvidenceRecord,
  type HistoricalV2ApprovalEnvelope, type HistoricalV2SavedTransitionPlan
} from './historical-v2.js';

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
  const phases: Partial<Record<HistoricalPhaseId, PhaseExecutionState>> = {};
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

export function historicalTransitionPlanPathParts(plan: HistoricalSavedTransitionPlan): string[] {
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
    if (!historicalActivationIdentities.some((identity) => identity.phaseGraphHash === digest) &&
      digest !== currentActivationIdentity.phaseGraphHash) {
      historyFail(label, 'is neither the registered historical nor the installed current managed graph.', 'unsupported-historical-graph');
    }
  } else if (label === '.liftoff/governance/compatibility.json') {
    if (isRecord(value) && value.schemaVersion === 1) {
      validateHistoricalCompatibility(value, label);
    } else if (isRecord(value) && (value.schemaVersion === 2 || value.schemaVersion === 3)) {
      validateHistoricalV2Compatibility(value, label);
    } else {
      try {
        const metadata = validateGovernanceCompatibilityMetadata(value);
        for (const parts of metadata.managedCore.pathAllowlist) historyPathParts(parts, `${label}.managedCore.pathAllowlist`);
        for (const entry of metadata.managedCore.updateInventory) historyPathParts(entry.pathParts, `${label}.managedCore.updateInventory.pathParts`);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'Error') throw error;
        historyFail(label, error.message, 'invalid-managed-source-metadata');
      }
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
    const identityProperties = historyExact(identity.properties, Object.keys(historicalActivationIdentity), `${label}.properties.identity.properties`);
    const declaredIdentity = Object.fromEntries(Object.entries(identityProperties).map(([key, entry]) => {
      const declaration = historyExact(entry, ['const'], `${label}.properties.identity.properties.${key}`);
      return [key, declaration.const];
    }));
    const identityDigest = canonicalSha256(declaredIdentity);
    if (!historicalActivationIdentities.some((identity) => identityDigest === canonicalSha256(identity)) &&
      identityDigest !== canonicalSha256(currentActivationIdentity)) {
      historyFail(label, 'credential schema must declare the exact historical or installed current activation identity.', 'invalid-managed-source-metadata');
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
  const byPath = new Map(index.files.map((file) => [historyPathKey(file.originalPathParts), file]));
  const inventory = await readHistoricalInventory(async (parts) => {
    const file = byPath.get(historyPathKey(parts));
    if (!file) return { pathParts: [...parts] };
    const copy = await captureHistoryFile(projectRoot, file.copyPathParts);
    if (!copy.content || rawHistoryDigest(copy.content) !== file.digest) {
      historyFail(historyPathKey(file.copyPathParts), 'declared copy is missing or differs from its recorded raw digest.', 'history-digest-mismatch');
    }
    return { pathParts: [...parts], content: copy.content, mode: file.mode };
  }, async (directory) => index.files
    .filter((file) => file.originalPathParts.length === 3 && file.originalPathParts[0] === 'governance' &&
      file.originalPathParts[1] === directory).map((file) => [...file.originalPathParts]), {
    reviewedUnreferencedPathParts: index.files
      .filter((file) => ['evidence', 'plan', 'approval'].includes(file.kind)).map((file) => file.originalPathParts)
  }, false);
  if (canonicalSha256(inventory.state.identity) !== canonicalSha256(index.sourceIdentity) ||
    canonicalSha256(inventory.files.map((file) => historyPathKey(file.pathParts)).sort()) !==
    canonicalSha256(index.files.map((file) => historyPathKey(file.originalPathParts)).sort())) {
    historyFail('activationHistoryIndex', 'source contract or complete record inventory contradicts its snapshot.', 'invalid-historical-reference');
  }
  return inventory;
}

async function readHistoricalInventory(
  captureSource: (parts: readonly string[]) => Promise<ProjectFileSnapshot>,
  activeRecordPaths: (directory: string) => Promise<string[][]>,
  options: HistoricalInventoryOptions,
  requireSourceChange = true
): Promise<HistoricalActivationInventory> {
  const preconditions: ProjectFileSnapshot[] = [];
  const capture = async (parts: readonly string[]) => {
    const snapshot = await captureSource(parts);
    preconditions.push(snapshot);
    return snapshot;
  };
  const manifestFile = sourceFile(await capture(historicalManifestPathParts), 'manifest');
  const stateFile = sourceFile(await capture(historicalActivationStatePathParts), 'state');
  const manifest = validateAt(manifestFile, validateHistoricalSourceManifest);
  const state = validateAt(stateFile, validateReadableHistoricalActivationState);
  if (!('activationIdentity' in manifest.governance) ||
    canonicalSha256(manifest.governance.activationIdentity) !== canonicalSha256(state.identity)) {
    historyFail(historyPathKey(stateFile.pathParts), 'active state and manifest declare different source contracts.', 'mixed-active-identity');
  }
  if (state.activeChange !== null && state.activeChange.kind !== manifest.project.specWorkflow) {
    historyFail(historyPathKey(stateFile.pathParts), 'active change belongs to a different spec workflow.', 'historical-spec-ownership-conflict');
  }
  const files = [manifestFile, stateFile];
  let sourceMigration: HistoricalV2SourceMigrationJournal | undefined;
  const migrationSnapshot = await capture(migrationStateFilePathParts);
  if (migrationSnapshot.content !== undefined) {
    if (state.schemaVersion !== 2) historyFail(historyPathKey(migrationStateFilePathParts), 'v1 active state cannot have a committed v2 source migration.', 'mixed-active-identity');
    const file = sourceFile(migrationSnapshot, 'migration');
    sourceMigration = validateAt(file, validateHistoricalV2SourceMigrationJournal);
    if (sourceMigration.successor.repositoryId !== state.repository.id || sourceMigration.successor.createdAt !== state.createdAt) {
      historyFail(historyPathKey(file.pathParts), 'source migration does not identify this active v2 successor.', 'invalid-historical-reference');
    }
    files.push(file);
  }
  let sourceChangeMetadata: HistoricalGovernanceChangeMetadata | undefined;
  if (state.activeChange) {
    const base = historicalSourceChangePathParts(state.activeChange);
    const metadataSnapshot = await capture([...base, 'liftoff-governance.json']);
    const tasksSnapshot = await capture([...base, 'tasks.md']);
    if (requireSourceChange || metadataSnapshot.content !== undefined || tasksSnapshot.content !== undefined) {
      const metadataFile = sourceFile(metadataSnapshot, 'source-metadata');
      const tasksFile = sourceFile(tasksSnapshot, 'source-tasks');
      sourceChangeMetadata = validateAt(metadataFile, validateHistoricalGovernanceChangeMetadata);
      if (sourceChangeMetadata.changeId !== state.activeChange.id || sourceChangeMetadata.workflowKind !== state.activeChange.kind ||
        ![state.identity, ...(sourceMigration ? [sourceMigration.sourceIdentity] : [])].some((identity) =>
          canonicalSha256(identity) === canonicalSha256(sourceChangeMetadata!.activationIdentity))) {
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
  const evidence = new Map<string, { file: HistoricalSourceFile; record: HistoricalEvidenceRecord | HistoricalV2EvidenceRecord }>();
  const plans: Array<{ file: HistoricalSourceFile; record: HistoricalSavedTransitionPlan | HistoricalV2SavedTransitionPlan }> = [];
  const approvals = new Map<string, { file: HistoricalSourceFile; record: HistoricalApprovalEnvelope | HistoricalV2ApprovalEnvelope }>();
  for (const [directory, kind] of [['evidence', 'evidence'], ['plans', 'plan'], ['approvals', 'approval']] as const) {
    for (const parts of await activeRecordPaths(directory)) {
      const file = sourceFile(await capture(parts), kind);
      if (!parts[2].endsWith('.json')) historyFail(historyPathKey(parts), 'active record extension is not the registered lowercase .json layout.');
      if (kind === 'evidence') {
        const record = validateAt(file, (value) => state.schemaVersion === 2
          ? validateHistoricalV2EvidenceRecord(value) : validateHistoricalEvidenceRecord(value, parts[2].slice(0, -5)));
        if (record.header.repositoryId !== state.repository.id) historyFail(historyPathKey(parts), 'historical evidence belongs to another repository.', 'invalid-historical-reference');
        if (evidence.has(record.evidenceId)) historyFail(historyPathKey(parts), 'duplicates an evidence identity.');
        evidence.set(record.evidenceId, { file, record });
      } else if (kind === 'plan') {
        plans.push({ file, record: validateAt(file, (value) => state.schemaVersion === 2
          ? validateHistoricalV2SavedTransitionPlan(value) : validateHistoricalSavedTransitionPlan(value)) });
      } else {
        const record = validateAt(file, (value) => state.schemaVersion === 2
          ? validateHistoricalV2ApprovalEnvelope(value) : validateHistoricalApprovalEnvelope(value));
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
        validateAt(file, (value) => state.schemaVersion === 1
          ? validateHistoricalV1AuxiliaryRecord(value, kind) : validateHistoricalV2AuxiliaryRecord(value, kind));
      } catch (error) {
        if (!(error instanceof ActivationHistoryError) || error.code !== 'invalid-history-record') throw error;
        historyFail(historyPathKey(parts), error.message, 'unsupported-active-record');
      }
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
      validateAt(file, (value) => state.schemaVersion === 1
        ? validateHistoricalV1AuxiliaryRecord(value, 'credential-policy') : validateHistoricalV2AuxiliaryRecord(value, 'credential-policy'));
      files.push(file);
    }
  }
  const selected = new Set<string>();
  const select = (file: HistoricalSourceFile) => selected.add(historyPathKey(file.pathParts));
  const requireApproval = (id: string, expectedPhase: string, expectedHash?: string) => {
    const found = approvals.get(id);
    if (!found) historyFail(`governance/approvals/${id}`, 'referenced historical approval is missing.', 'missing-historical-record');
    const scopeHash = found.record.schemaVersion === 1
      ? historicalApprovalEnvelopeHash(found.record) : historicalV2ApprovalEnvelopeHash(found.record);
    if (found.record.phaseId !== expectedPhase || expectedHash !== undefined && scopeHash !== expectedHash) {
      historyFail(historyPathKey(found.file.pathParts), 'approval phase or scope hash contradicts its reference.', 'invalid-historical-reference');
    }
    select(found.file);
  };
  const selectPlan = (entry: typeof plans[number]) => {
    select(entry.file);
    if (entry.record.approval.envelopeId !== null) {
      if (entry.record.approval.envelopeHash === null) historyFail(historyPathKey(entry.file.pathParts), 'approval reference has no hash.');
      requireApproval(entry.record.approval.envelopeId, entry.record.phaseId, entry.record.approval.envelopeHash);
    }
  };
  const selectEvidence = (entry: { file: HistoricalSourceFile; record: HistoricalEvidenceRecord | HistoricalV2EvidenceRecord }) => {
    select(entry.file);
    const { header, payload, evidenceId } = entry.record;
    const matching = plans.filter((candidate) =>
      candidate.record.phaseId === header.phaseId && candidate.record.transitionDigest === header.transition.transitionDigest &&
      candidate.record.baselineDigest === header.baselineSha && candidate.record.inputDigest === header.inputDigest);
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
  for (const id of historicalPhaseIds) {
    const phase = state.phases[id];
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
