import {
  activationStateContentHash,
  activationStateFilePathParts,
  loadActivationState
} from './activation-state.js';
import { canonicalJson } from './canonical-json.js';
import {
  graphReconciliationRecordFromMapping,
  type HistoricalActivationStateMigration
} from './compatibility.js';
import {
  activationCompatibility,
  currentActivationIdentity
} from './graph.js';
import {
  activationStateSchemaVersion,
  type ActivationCompatibilityMap,
  resolveActivationCompatibility
} from './identity.js';
import type {
  ActivationIdentity,
  GraphReconciliationRecord,
  PhaseId,
  UserActivationState
} from './types.js';
import { phaseIds } from './types.js';
import {
  validateGraphReconciliationRecord,
  validateUserActivationState
} from './validators.js';
import {
  captureProjectFileSnapshot,
  readProjectFile,
  type ProjectFileMutation,
  type ProjectFileSnapshot
} from '../file-system.js';

export const updateFailureInjectionEnv = 'LIFTOFF_UPDATE_INJECT_FAILURE' as const;

export type ActivationStateMigrationPlan =
  | {
      status: 'not-present' | 'current';
      mutations: readonly ProjectFileMutation[];
      preconditions: readonly ProjectFileSnapshot[];
      report: ActivationStateMigrationReport;
    }
  | {
      status: 'migrate';
      mutations: readonly ProjectFileMutation[];
      preconditions: readonly ProjectFileSnapshot[];
      report: ActivationStateMigrationReport & {
        fromIdentity: ActivationIdentity;
        toIdentity: ActivationIdentity;
        reconciliationPath: string;
        preservedPhaseIds: readonly PhaseId[];
        invalidPhaseIds: readonly PhaseId[];
      };
    }
  | {
      status: 'blocked';
      mutations: readonly ProjectFileMutation[];
      preconditions: readonly ProjectFileSnapshot[];
      report: ActivationStateMigrationReport & {
        reasonCode: 'ad-hoc-state' | 'future-state-schema' | 'unsupported-activation-identity' | 'malformed-state' | 'reconciliation-conflict';
        issues: readonly string[];
      };
    };

export interface ActivationStateMigrationReport {
  path: string;
  status: 'not-present' | 'current' | 'migrate' | 'blocked';
  checkModeWritesBytes: 0;
  evidencePolicy: 'preserve-bytes';
  unversionedImport: 'requires-explicit-import-mapping';
  issues: readonly string[];
}

export interface ActivationStateMigrationMappingInput {
  compatibility?: ActivationCompatibilityMap;
  historicalStateMigrations?: readonly HistoricalActivationStateMigration[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameIdentity(left: ActivationIdentity, right: ActivationIdentity): boolean {
  return identityFields.every((field) => left[field] === right[field]);
}

function looseIdentity(value: unknown): ActivationIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const field of identityFields) {
    if (!Object.hasOwn(value, field)) {
      return undefined;
    }
  }
  const identity = value as Record<(typeof identityFields)[number], unknown>;
  if (
    typeof identity.liftoffVersion !== 'string' ||
    typeof identity.manifestArtifactVersion !== 'number' ||
    typeof identity.policyVersion !== 'string' ||
    typeof identity.activationContractVersion !== 'number' ||
    typeof identity.phaseGraphSchemaVersion !== 'number' ||
    typeof identity.phaseGraphHash !== 'string' ||
    typeof identity.activationStateSchemaVersion !== 'number' ||
    typeof identity.evidenceHeaderSchemaVersion !== 'number' ||
    typeof identity.approvalEnvelopeSchemaVersion !== 'number' ||
    typeof identity.supersessionSchemaVersion !== 'number' ||
    typeof identity.credentialPolicySchemaVersion !== 'number'
  ) {
    return undefined;
  }
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

function blocked(
  reasonCode: Extract<ActivationStateMigrationPlan, { status: 'blocked' }>['report']['reasonCode'],
  issues: readonly string[]
): ActivationStateMigrationPlan {
  return {
    status: 'blocked',
    mutations: [],
    preconditions: [],
    report: {
      path: activationStateFilePathParts.join('/'),
      status: 'blocked',
      checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes',
      unversionedImport: 'requires-explicit-import-mapping',
      reasonCode,
      issues
    }
  };
}

function unchanged(status: 'not-present' | 'current'): ActivationStateMigrationPlan {
  return {
    status,
    mutations: [],
    preconditions: [],
    report: {
      path: activationStateFilePathParts.join('/'),
      status,
      checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes',
      unversionedImport: 'requires-explicit-import-mapping',
      issues: []
    }
  };
}

function phaseImpact(record: GraphReconciliationRecord): {
  preservedPhaseIds: readonly PhaseId[];
  invalidPhaseIds: readonly PhaseId[];
} {
  const preserved = record.phaseMappings
    .filter((mapping) => mapping.preserveEvidence && mapping.fromContractDigest === mapping.toContractDigest)
    .map((mapping) => mapping.phaseId);
  const invalid = phaseIds.filter((phaseId) => !preserved.includes(phaseId));
  return { preservedPhaseIds: preserved, invalidPhaseIds: invalid };
}

function matchingHistoricalStateMigration(
  identity: ActivationIdentity,
  migrations: readonly HistoricalActivationStateMigration[]
): HistoricalActivationStateMigration | undefined {
  return migrations.find((migration) =>
    sameIdentity(migration.fromIdentity, identity) &&
    sameIdentity(migration.toIdentity, currentActivationIdentity)
  );
}

export async function planHistoricalActivationStateMigration(
  projectRoot: string,
  nowIso = new Date().toISOString(),
  mappingInput: ActivationStateMigrationMappingInput = {}
): Promise<ActivationStateMigrationPlan> {
  const bytes = await readProjectFile(projectRoot, [...activationStateFilePathParts]);
  if (bytes === undefined) {
    return unchanged('not-present');
  }
  const content = bytes.toString('utf8');
  const snapshot = await captureProjectFileSnapshot(projectRoot, [...activationStateFilePathParts]);
  try {
    await loadActivationState(projectRoot);
    return unchanged('current');
  } catch {
    // Re-parse below to distinguish supported historical state from ad hoc files.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return blocked('malformed-state', [
      `Unable to parse governance/activation-state.json: ${errorMessage(error)}. Restore a valid versioned state or provide an explicit import mapping.`
    ]);
  }
  if (!isRecord(parsed)) {
    return blocked('ad-hoc-state', [
      'governance/activation-state.json is not a JSON object; checkboxes, filenames, and prose are not evidence. Provide an explicit import mapping.'
    ]);
  }
  if (!Object.hasOwn(parsed, 'schemaVersion') || !Object.hasOwn(parsed, 'identity')) {
    return blocked('ad-hoc-state', [
      'governance/activation-state.json lacks explicit schemaVersion or identity. Unversioned/ad hoc state requires an explicit import mapping; checkboxes, filenames, and prose are not evidence.'
    ]);
  }
  if (parsed.schemaVersion !== activationStateSchemaVersion) {
    if (
      typeof parsed.schemaVersion === 'number' &&
      parsed.schemaVersion > activationStateSchemaVersion
    ) {
      return blocked('future-state-schema', [
        `Unsupported activationState.schemaVersion: found ${JSON.stringify(parsed.schemaVersion)}; supported values are ${activationStateSchemaVersion}. Upgrade Liftoff before writing.`
      ]);
    }
    return blocked('unsupported-activation-identity', [
      `Unsupported activationState.schemaVersion: found ${JSON.stringify(parsed.schemaVersion)}; supported values are ${activationStateSchemaVersion}. Explicit migration metadata is required.`
    ]);
  }
  const identity = looseIdentity(parsed.identity);
  if (!identity) {
    return blocked('ad-hoc-state', [
      'activationState.identity is absent or malformed. Explicit import mapping is required; task checkboxes, filenames, and prose cannot be imported as evidence.'
    ]);
  }
  if (sameIdentity(identity, currentActivationIdentity)) {
    return blocked('malformed-state', [
      'Activation state uses the current identity but failed strict validation; preserve the bytes and repair the malformed state before writing.'
    ]);
  }
  const migration = matchingHistoricalStateMigration(
    identity,
    mappingInput.historicalStateMigrations ?? []
  );
  if (!migration) {
    const compatibility = resolveActivationCompatibility(
      identity,
      mappingInput.compatibility ?? activationCompatibility
    );
    const issue = compatibility.compatible
      ? `Activation state identity is compatible but has no explicit historical migration mapping: found ${identity.phaseGraphHash}.`
      : compatibility.reason;
    return blocked('unsupported-activation-identity', [
      `${issue} Production Liftoff 0.10.0 declares no historical activation-state mappings; provide an explicit compatibility/migration mapping or upgrade to a Liftoff release that declares one.`
    ]);
  }
  if (
    migration.stateSchemaVersion !== activationStateSchemaVersion ||
    migration.transaction !== 'managed-update-write-set' ||
    migration.evidence !== 'preserve-bytes' ||
    migration.unversionedImport !== 'requires-explicit-import-mapping' ||
    migration.graphMapping.fromGraphHash !== migration.fromIdentity.phaseGraphHash ||
    migration.graphMapping.toGraphHash !== migration.toIdentity.phaseGraphHash ||
    !sameIdentity(migration.graphMapping.fromIdentity, migration.fromIdentity) ||
    !sameIdentity(migration.graphMapping.toIdentity, migration.toIdentity)
  ) {
    return blocked('unsupported-activation-identity', [
      'Explicit historical activation-state migration mapping is internally inconsistent. Provide schema-valid compatibility metadata before writing.'
    ]);
  }

  const migratedCandidate = {
    ...parsed,
    identity: migration.toIdentity
  };
  let migrated: UserActivationState;
  try {
    migrated = validateUserActivationState(migratedCandidate);
  } catch (error) {
    return blocked('malformed-state', [
      `Supported historical activation state failed strict migration validation: ${errorMessage(error)}.`
    ]);
  }
  const mapping = migration.graphMapping;
  const reconciliationCandidate = graphReconciliationRecordFromMapping(mapping, nowIso);
  let reconciliation: GraphReconciliationRecord;
  try {
    reconciliation = validateGraphReconciliationRecord(
      reconciliationCandidate,
      new Set([mapping.fromGraphHash, mapping.toGraphHash])
    );
  } catch (error) {
    return blocked('unsupported-activation-identity', [
      `Explicit historical activation-state migration mapping is invalid: ${errorMessage(error)}.`
    ]);
  }
  const reconciliationPathParts = [
    'governance',
    'reconciliation',
    `${mapping.fromGraphHash.slice(0, 12)}-to-${mapping.toGraphHash.slice(0, 12)}.json`
  ];
  const reconciliationContent = `${canonicalJson(reconciliation)}\n`;
  const existingReconciliation = await readProjectFile(projectRoot, reconciliationPathParts);
  if (
    existingReconciliation !== undefined &&
    existingReconciliation.toString('utf8') !== reconciliationContent
  ) {
    return blocked('reconciliation-conflict', [
      `${reconciliationPathParts.join('/')} already exists with different bytes; preserve it and reconcile manually.`
    ]);
  }
  const migratedContent = `${canonicalJson(migrated)}\n`;
  const mutations: ProjectFileMutation[] = [
    {
      type: 'write',
      pathParts: [...activationStateFilePathParts],
      content: migratedContent
    },
    ...(existingReconciliation === undefined
      ? [{
          type: 'write' as const,
          pathParts: reconciliationPathParts,
          content: reconciliationContent
        }]
      : [])
  ];
  const impact = phaseImpact(reconciliation);
  return {
    status: 'migrate',
    mutations,
    preconditions: [
      snapshot,
      ...(existingReconciliation === undefined
        ? [{ pathParts: reconciliationPathParts } satisfies ProjectFileSnapshot]
        : [{ pathParts: reconciliationPathParts, content: existingReconciliation } satisfies ProjectFileSnapshot])
    ],
    report: {
      path: activationStateFilePathParts.join('/'),
      status: 'migrate',
      checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes',
      unversionedImport: 'requires-explicit-import-mapping',
      issues: [],
      fromIdentity: migration.fromIdentity,
      toIdentity: migration.toIdentity,
      reconciliationPath: reconciliationPathParts.join('/'),
      preservedPhaseIds: impact.preservedPhaseIds,
      invalidPhaseIds: impact.invalidPhaseIds
    }
  };
}

export function activationStateMigrationFingerprint(content: string | Buffer): string {
  return activationStateContentHash(content);
}
