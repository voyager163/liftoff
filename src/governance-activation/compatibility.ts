import { exactGlobalInstallCommand } from '../package-identity.js';
import {
  canonicalPhaseContractDigests,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from './graph.js';
import {
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  credentialPolicySchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  supersessionSchemaVersion
} from './identity.js';
import type {
  ActivationIdentity,
  GraphReconciliationPhaseMapping,
  GraphReconciliationRecord,
  PhaseId
} from './types.js';
import { phaseIds } from './types.js';

export const governanceCompatibilitySchemaVersion = 1 as const;
export const minimumLiftoffForManifestV7 = '0.10.0' as const;
export const supportedManifestReadVersions = [2, 3, 4, 5, 6, 7] as const;

export interface ManagedCompatibilityInventoryEntry {
  logicalName: string;
  pathParts: readonly string[];
  lifecycle: 'managed-core';
  contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash';
}

export interface CompatibilityGraphMapping {
  fromGraphHash: string;
  toGraphHash: string;
  fromIdentity: ActivationIdentity;
  toIdentity: ActivationIdentity;
  phaseMappings: readonly GraphReconciliationPhaseMapping[];
  preservation: 'phase-contract-digest';
}

export interface HistoricalActivationStateMigration {
  fromIdentity: ActivationIdentity;
  toIdentity: ActivationIdentity;
  stateSchemaVersion: typeof activationStateSchemaVersion;
  graphMapping: CompatibilityGraphMapping;
  transaction: 'managed-update-write-set';
  evidence: 'preserve-bytes';
  unversionedImport: 'requires-explicit-import-mapping';
}

export interface GovernanceCompatibilityMetadata {
  schemaVersion: typeof governanceCompatibilitySchemaVersion;
  generatedBy: 'Mission Control Liftoff';
  liftoffVersion: typeof liftoffActivationPackageVersion;
  minimumLiftoffVersions: {
    manifestWriteVersion7: typeof minimumLiftoffForManifestV7;
    remedy: string;
  };
  manifest: {
    readVersions: readonly number[];
    writeVersion: typeof liftoffManifestArtifactVersion;
    hashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash';
  };
  activation: {
    currentCompatibleTuples: readonly ActivationIdentity[];
    recognizedGraphHashes: readonly string[];
    graphMappings: readonly CompatibilityGraphMapping[];
    historicalStateMigrations: readonly HistoricalActivationStateMigration[];
    unsupportedRemedy: string;
  };
  managedCore: {
    logicalNameAllowlist: readonly string[];
    pathAllowlist: readonly (readonly string[])[];
    updateInventory: readonly ManagedCompatibilityInventoryEntry[];
    validation: {
      strictJson: true;
      crossPlatformPathParts: true;
      noSetupSkillVersion: true;
      checkModeWritesBytes: 0;
    };
  };
}

const identityFields = [
  'liftoffVersion',
  'manifestArtifactVersion',
  'policyVersion',
  'activationContractVersion',
  'phaseGraphSchemaVersion',
  'phaseGraphHash',
  'activationStateSchemaVersion',
  'evidenceHeaderSchemaVersion',
  'approvalEnvelopeSchemaVersion',
  'supersessionSchemaVersion',
  'credentialPolicySchemaVersion'
] as const;

const hex64Pattern = /^[a-f0-9]{64}$/u;

function stableIdentity(identity: ActivationIdentity): ActivationIdentity {
  return {
    liftoffVersion: identity.liftoffVersion,
    manifestArtifactVersion: identity.manifestArtifactVersion,
    policyVersion: identity.policyVersion,
    activationContractVersion: identity.activationContractVersion,
    phaseGraphSchemaVersion: identity.phaseGraphSchemaVersion,
    phaseGraphHash: identity.phaseGraphHash,
    activationStateSchemaVersion: identity.activationStateSchemaVersion,
    evidenceHeaderSchemaVersion: identity.evidenceHeaderSchemaVersion,
    approvalEnvelopeSchemaVersion: identity.approvalEnvelopeSchemaVersion,
    supersessionSchemaVersion: identity.supersessionSchemaVersion,
    credentialPolicySchemaVersion: identity.credentialPolicySchemaVersion
  };
}

export function preservingPhaseContractMappings(): GraphReconciliationPhaseMapping[] {
  return phaseIds.map((phaseId) => ({
    phaseId,
    fromContractDigest: canonicalPhaseContractDigests[phaseId],
    toContractDigest: canonicalPhaseContractDigests[phaseId],
    preserveEvidence: true
  }));
}

export function graphReconciliationRecordFromMapping(
  mapping: CompatibilityGraphMapping,
  reconciledAt: string,
  producer = 'liftoff-managed-update'
): GraphReconciliationRecord {
  return {
    schemaVersion: activationStateSchemaVersion,
    fromGraphHash: mapping.fromGraphHash,
    toGraphHash: mapping.toGraphHash,
    fromIdentity: mapping.fromIdentity,
    toIdentity: mapping.toIdentity,
    phaseMappings: mapping.phaseMappings,
    reconciledAt,
    producer
  };
}

export function buildGovernanceCompatibilityMetadata(
  inventory: readonly ManagedCompatibilityInventoryEntry[],
  logicalNameAllowlist: readonly string[],
  pathAllowlist: readonly (readonly string[])[]
): GovernanceCompatibilityMetadata {
  return {
    schemaVersion: governanceCompatibilitySchemaVersion,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion: liftoffActivationPackageVersion,
    minimumLiftoffVersions: {
      manifestWriteVersion7: minimumLiftoffForManifestV7,
      remedy: `Upgrade Liftoff to ${minimumLiftoffForManifestV7} or newer with ${exactGlobalInstallCommand(`${minimumLiftoffForManifestV7}`)}.`
    },
    manifest: {
      readVersions: [...supportedManifestReadVersions],
      writeVersion: liftoffManifestArtifactVersion,
      hashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
    },
    activation: {
      currentCompatibleTuples: [stableIdentity(currentActivationIdentity)],
      recognizedGraphHashes: [canonicalPhaseGraphHash],
      graphMappings: [],
      historicalStateMigrations: [],
      unsupportedRemedy: 'Do not downgrade or rewrite governance state. Upgrade Liftoff to a version whose compatibility metadata recognizes the manifest, policy, contract, schema tuple, and phase graph hash.'
    },
    managedCore: {
      logicalNameAllowlist: [...logicalNameAllowlist],
      pathAllowlist: pathAllowlist.map((entry) => [...entry]),
      updateInventory: inventory.map((entry) => ({
        logicalName: entry.logicalName,
        pathParts: [...entry.pathParts],
        lifecycle: 'managed-core',
        contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
      })),
      validation: {
        strictJson: true,
        crossPlatformPathParts: true,
        noSetupSkillVersion: true,
        checkModeWritesBytes: 0
      }
    }
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = record(value, label);
  for (const key of keys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${label}.${key} is required.`);
    }
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not allowed.`);
    }
  }
  return item;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return field;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) {
      throw new Error(`${label}[${index}] must be an integer.`);
    }
    return entry;
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

function pathPartsArray(value: unknown, label: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => stringArray(entry, `${label}[${index}]`));
}

function activationIdentity(value: unknown, label: string): ActivationIdentity {
  const item = exact(value, [...identityFields], label);
  const phaseGraphHash = stringField(item, 'phaseGraphHash', label);
  if (!hex64Pattern.test(phaseGraphHash)) {
    throw new Error(`${label}.phaseGraphHash must be a SHA-256 hex digest.`);
  }
  return {
    liftoffVersion: stringField(item, 'liftoffVersion', label),
    manifestArtifactVersion: numberField(item, 'manifestArtifactVersion', label),
    policyVersion: stringField(item, 'policyVersion', label),
    activationContractVersion: numberField(item, 'activationContractVersion', label),
    phaseGraphSchemaVersion: numberField(item, 'phaseGraphSchemaVersion', label),
    phaseGraphHash,
    activationStateSchemaVersion: numberField(item, 'activationStateSchemaVersion', label),
    evidenceHeaderSchemaVersion: numberField(item, 'evidenceHeaderSchemaVersion', label),
    approvalEnvelopeSchemaVersion: numberField(item, 'approvalEnvelopeSchemaVersion', label),
    supersessionSchemaVersion: numberField(item, 'supersessionSchemaVersion', label),
    credentialPolicySchemaVersion: numberField(item, 'credentialPolicySchemaVersion', label)
  };
}

function numberField(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw new Error(`${label}.${key} must be an integer.`);
  }
  return field;
}

function assertIdentity(
  actual: ActivationIdentity,
  expected: ActivationIdentity,
  label: string
): void {
  for (const field of identityFields) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `${label}.${field} expected ${JSON.stringify(expected[field])}, found ${JSON.stringify(actual[field])}.`
      );
    }
  }
}

function graphMapping(value: unknown, label: string): CompatibilityGraphMapping {
  const item = exact(value, [
    'fromGraphHash',
    'toGraphHash',
    'fromIdentity',
    'toIdentity',
    'phaseMappings',
    'preservation'
  ], label);
  const fromGraphHash = stringField(item, 'fromGraphHash', label);
  const toGraphHash = stringField(item, 'toGraphHash', label);
  if (!hex64Pattern.test(fromGraphHash) || !hex64Pattern.test(toGraphHash)) {
    throw new Error(`${label} graph hashes must be SHA-256 hex digests.`);
  }
  if (item.preservation !== 'phase-contract-digest') {
    throw new Error(`${label}.preservation must be phase-contract-digest.`);
  }
  if (!Array.isArray(item.phaseMappings)) {
    throw new Error(`${label}.phaseMappings must be an array.`);
  }
  const seen = new Set<PhaseId>();
  const phaseMappings = item.phaseMappings.map((entry, index) => {
    const mapping = exact(entry, [
      'phaseId',
      'fromContractDigest',
      'toContractDigest',
      'preserveEvidence'
    ], `${label}.phaseMappings[${index}]`);
    const phaseId = stringField(mapping, 'phaseId', `${label}.phaseMappings[${index}]`);
    if (!phaseIds.includes(phaseId as PhaseId)) {
      throw new Error(`${label}.phaseMappings[${index}].phaseId contains unsupported phase ${phaseId}.`);
    }
    if (seen.has(phaseId as PhaseId)) {
      throw new Error(`${label}.phaseMappings contains duplicate phase ${phaseId}.`);
    }
    seen.add(phaseId as PhaseId);
    const fromContractDigest = stringField(mapping, 'fromContractDigest', `${label}.phaseMappings[${index}]`);
    const toContractDigest = stringField(mapping, 'toContractDigest', `${label}.phaseMappings[${index}]`);
    if (!hex64Pattern.test(fromContractDigest) || !hex64Pattern.test(toContractDigest)) {
      throw new Error(`${label}.phaseMappings[${index}] contract digests must be SHA-256 hex digests.`);
    }
    if (typeof mapping.preserveEvidence !== 'boolean') {
      throw new Error(`${label}.phaseMappings[${index}].preserveEvidence must be a boolean.`);
    }
    return {
      phaseId: phaseId as PhaseId,
      fromContractDigest,
      toContractDigest,
      preserveEvidence: mapping.preserveEvidence
    };
  });
  for (const phaseId of phaseIds) {
    if (!seen.has(phaseId)) {
      throw new Error(`${label}.phaseMappings.${phaseId} is required.`);
    }
  }
  const fromIdentity = activationIdentity(item.fromIdentity, `${label}.fromIdentity`);
  const toIdentity = activationIdentity(item.toIdentity, `${label}.toIdentity`);
  if (fromIdentity.phaseGraphHash !== fromGraphHash || toIdentity.phaseGraphHash !== toGraphHash) {
    throw new Error(`${label} identity graph hashes must match mapping hashes.`);
  }
  return {
    fromGraphHash,
    toGraphHash,
    fromIdentity,
    toIdentity,
    phaseMappings,
    preservation: 'phase-contract-digest'
  };
}

function inventoryEntry(value: unknown, label: string): ManagedCompatibilityInventoryEntry {
  const item = exact(value, [
    'logicalName',
    'pathParts',
    'lifecycle',
    'contentHashAuthority'
  ], label);
  if (item.lifecycle !== 'managed-core') {
    throw new Error(`${label}.lifecycle must be managed-core.`);
  }
  if (item.contentHashAuthority !== 'liftoff.manifest.json managedArtifacts[].contentHash') {
    throw new Error(`${label}.contentHashAuthority must refer to liftoff.manifest.json managedArtifacts[].contentHash.`);
  }
  return {
    logicalName: stringField(item, 'logicalName', label),
    pathParts: stringArray(item.pathParts, `${label}.pathParts`),
    lifecycle: 'managed-core',
    contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
  };
}

export function validateGovernanceCompatibilityMetadata(
  value: unknown,
  expected?: {
    logicalNameAllowlist?: readonly string[];
    pathAllowlist?: readonly (readonly string[])[];
    inventory?: readonly ManagedCompatibilityInventoryEntry[];
  }
): GovernanceCompatibilityMetadata {
  const item = exact(value, [
    'schemaVersion',
    'generatedBy',
    'liftoffVersion',
    'minimumLiftoffVersions',
    'manifest',
    'activation',
    'managedCore'
  ], 'compatibility');
  if (item.schemaVersion !== governanceCompatibilitySchemaVersion) {
    throw new Error(`compatibility.schemaVersion must be ${governanceCompatibilitySchemaVersion}.`);
  }
  if (item.generatedBy !== 'Mission Control Liftoff') {
    throw new Error('compatibility.generatedBy must be Mission Control Liftoff.');
  }
  if (item.liftoffVersion !== liftoffActivationPackageVersion) {
    throw new Error(`compatibility.liftoffVersion must be ${liftoffActivationPackageVersion}.`);
  }
  const minimum = exact(item.minimumLiftoffVersions, ['manifestWriteVersion7', 'remedy'], 'compatibility.minimumLiftoffVersions');
  if (minimum.manifestWriteVersion7 !== minimumLiftoffForManifestV7) {
    throw new Error(`compatibility.minimumLiftoffVersions.manifestWriteVersion7 must be ${minimumLiftoffForManifestV7}.`);
  }
  const manifest = exact(item.manifest, ['readVersions', 'writeVersion', 'hashAuthority'], 'compatibility.manifest');
  const readVersions = numberArray(manifest.readVersions, 'compatibility.manifest.readVersions');
  if (readVersions.join(',') !== supportedManifestReadVersions.join(',')) {
    throw new Error(`compatibility.manifest.readVersions must be ${supportedManifestReadVersions.join(', ')}.`);
  }
  if (manifest.writeVersion !== liftoffManifestArtifactVersion) {
    throw new Error(`compatibility.manifest.writeVersion must be ${liftoffManifestArtifactVersion}.`);
  }
  if (manifest.hashAuthority !== 'liftoff.manifest.json managedArtifacts[].contentHash') {
    throw new Error('compatibility.manifest.hashAuthority must be liftoff.manifest.json managedArtifacts[].contentHash.');
  }
  const activation = exact(item.activation, [
    'currentCompatibleTuples',
    'recognizedGraphHashes',
    'graphMappings',
    'historicalStateMigrations',
    'unsupportedRemedy'
  ], 'compatibility.activation');
  if (!Array.isArray(activation.currentCompatibleTuples)) {
    throw new Error('compatibility.activation.currentCompatibleTuples must be an array.');
  }
  const currentTuples = activation.currentCompatibleTuples.map((entry, index) =>
    activationIdentity(entry, `compatibility.activation.currentCompatibleTuples[${index}]`)
  );
  if (currentTuples.length !== 1) {
    throw new Error('compatibility.activation.currentCompatibleTuples must contain exactly the current tuple.');
  }
  assertIdentity(currentTuples[0]!, currentActivationIdentity, 'compatibility.activation.currentCompatibleTuples[0]');
  const recognizedGraphHashes = stringArray(activation.recognizedGraphHashes, 'compatibility.activation.recognizedGraphHashes');
  if (!recognizedGraphHashes.includes(canonicalPhaseGraphHash)) {
    throw new Error(`compatibility.activation.recognizedGraphHashes must include ${canonicalPhaseGraphHash}.`);
  }
  if (!Array.isArray(activation.graphMappings)) {
    throw new Error('compatibility.activation.graphMappings must be an array.');
  }
  const graphMappings = activation.graphMappings.map((entry, index) =>
    graphMapping(entry, `compatibility.activation.graphMappings[${index}]`)
  );
  if (!Array.isArray(activation.historicalStateMigrations)) {
    throw new Error('compatibility.activation.historicalStateMigrations must be an array.');
  }
  const historicalStateMigrations = activation.historicalStateMigrations.map((entry, index): HistoricalActivationStateMigration => {
    const migration = exact(entry, [
      'fromIdentity',
      'toIdentity',
      'stateSchemaVersion',
      'graphMapping',
      'transaction',
      'evidence',
      'unversionedImport'
    ], `compatibility.activation.historicalStateMigrations[${index}]`);
    if (migration.stateSchemaVersion !== activationStateSchemaVersion) {
      throw new Error(`compatibility.activation.historicalStateMigrations[${index}].stateSchemaVersion must be ${activationStateSchemaVersion}.`);
    }
    if (migration.transaction !== 'managed-update-write-set') {
      throw new Error(`compatibility.activation.historicalStateMigrations[${index}].transaction must be managed-update-write-set.`);
    }
    if (migration.evidence !== 'preserve-bytes') {
      throw new Error(`compatibility.activation.historicalStateMigrations[${index}].evidence must be preserve-bytes.`);
    }
    if (migration.unversionedImport !== 'requires-explicit-import-mapping') {
      throw new Error(`compatibility.activation.historicalStateMigrations[${index}].unversionedImport must be requires-explicit-import-mapping.`);
    }
    const mapping = graphMapping(migration.graphMapping, `compatibility.activation.historicalStateMigrations[${index}].graphMapping`);
    const fromIdentity = activationIdentity(migration.fromIdentity, `compatibility.activation.historicalStateMigrations[${index}].fromIdentity`);
    const toIdentity = activationIdentity(migration.toIdentity, `compatibility.activation.historicalStateMigrations[${index}].toIdentity`);
    assertIdentity(mapping.fromIdentity, fromIdentity, `compatibility.activation.historicalStateMigrations[${index}].graphMapping.fromIdentity`);
    assertIdentity(mapping.toIdentity, toIdentity, `compatibility.activation.historicalStateMigrations[${index}].graphMapping.toIdentity`);
    return {
      fromIdentity,
      toIdentity,
      stateSchemaVersion: activationStateSchemaVersion,
      graphMapping: mapping,
      transaction: 'managed-update-write-set',
      evidence: 'preserve-bytes',
      unversionedImport: 'requires-explicit-import-mapping'
    };
  });
  const managedCore = exact(item.managedCore, [
    'logicalNameAllowlist',
    'pathAllowlist',
    'updateInventory',
    'validation'
  ], 'compatibility.managedCore');
  const logicalNameAllowlist = stringArray(managedCore.logicalNameAllowlist, 'compatibility.managedCore.logicalNameAllowlist');
  const pathAllowlist = pathPartsArray(managedCore.pathAllowlist, 'compatibility.managedCore.pathAllowlist');
  if (expected?.logicalNameAllowlist && logicalNameAllowlist.join('\0') !== expected.logicalNameAllowlist.join('\0')) {
    throw new Error('compatibility.managedCore.logicalNameAllowlist does not match the packaged managed-core allowlist.');
  }
  if (expected?.pathAllowlist) {
    const actual = pathAllowlist.map((parts) => parts.join('/')).join('\0');
    const expectedPaths = expected.pathAllowlist.map((parts) => parts.join('/')).join('\0');
    if (actual !== expectedPaths) {
      throw new Error('compatibility.managedCore.pathAllowlist does not match the packaged managed-core path allowlist.');
    }
  }
  if (!Array.isArray(managedCore.updateInventory)) {
    throw new Error('compatibility.managedCore.updateInventory must be an array.');
  }
  const updateInventory = managedCore.updateInventory.map((entry, index) =>
    inventoryEntry(entry, `compatibility.managedCore.updateInventory[${index}]`)
  );
  if (expected?.inventory) {
    const actual = updateInventory.map((entry) => `${entry.logicalName}:${entry.pathParts.join('/')}`).join('\0');
    const expectedInventory = expected.inventory.map((entry) => `${entry.logicalName}:${entry.pathParts.join('/')}`).join('\0');
    if (actual !== expectedInventory) {
      throw new Error('compatibility.managedCore.updateInventory does not match the expected managed update inventory.');
    }
  }
  const validation = exact(managedCore.validation, [
    'strictJson',
    'crossPlatformPathParts',
    'noSetupSkillVersion',
    'checkModeWritesBytes'
  ], 'compatibility.managedCore.validation');
  if (
    validation.strictJson !== true ||
    validation.crossPlatformPathParts !== true ||
    validation.noSetupSkillVersion !== true ||
    validation.checkModeWritesBytes !== 0
  ) {
    throw new Error('compatibility.managedCore.validation must require strict JSON, path parts, no setup-skill version, and zero-byte check mode.');
  }
  return {
    schemaVersion: governanceCompatibilitySchemaVersion,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion: liftoffActivationPackageVersion,
    minimumLiftoffVersions: {
      manifestWriteVersion7: minimumLiftoffForManifestV7,
      remedy: stringField(minimum, 'remedy', 'compatibility.minimumLiftoffVersions')
    },
    manifest: {
      readVersions,
      writeVersion: liftoffManifestArtifactVersion,
      hashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
    },
    activation: {
      currentCompatibleTuples: currentTuples,
      recognizedGraphHashes,
      graphMappings,
      historicalStateMigrations,
      unsupportedRemedy: stringField(activation, 'unsupportedRemedy', 'compatibility.activation')
    },
    managedCore: {
      logicalNameAllowlist,
      pathAllowlist,
      updateInventory,
      validation: {
        strictJson: true,
        crossPlatformPathParts: true,
        noSetupSkillVersion: true,
        checkModeWritesBytes: 0
      }
    }
  };
}
