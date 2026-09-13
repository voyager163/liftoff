import {
  activationStateContentHash, activationStateFilePathParts
} from './activation-state.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  activationStateSchemaVersion, isHistoricalActivationIdentity, type ActivationCompatibilityMap
} from '../domain/governance/policy/identity.js';
import type { ActivationIdentity, PhaseId } from '../domain/governance/activation/types.js';
import { validateUserActivationState } from '../domain/governance/activation/validators.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import type { HistoricalActivationStateMigration } from './compatibility.js';
import {
  captureHistoryFile, validateReadableHistoricalActivationState
} from './historical-state.js';
import { ActivationHistoryError, parseHistoryJson } from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';
import { activeActivationRecordsWithoutState, inspectActivationMigrationHistory } from './migration-history.js';

export const updateFailureInjectionEnv = 'LIFTOFF_UPDATE_INJECT_FAILURE' as const;

export type ActivationStateMigrationPlan =
  | {
      status: 'not-present' | 'current';
      mutations: readonly ProjectFileMutation[];
      preconditions: readonly ProjectFileSnapshot[];
      report: ActivationStateMigrationReport;
    }
  | {
      /** Retained for API compatibility; installed releases never mint an in-place identity relabel. */
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
        reasonCode: 'ad-hoc-state' | 'future-state-schema' | 'unsupported-activation-identity' |
          'malformed-state' | 'reconciliation-conflict' | 'missing-historical-record';
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
  diagnosticOnly?: boolean;
}

export interface ActivationStateMigrationMappingInput {
  /** Diagnostic legacy inputs cannot extend installed successor-lane authority. */
  compatibility?: ActivationCompatibilityMap;
  historicalStateMigrations?: readonly HistoricalActivationStateMigration[];
}

function blocked(
  reasonCode: Extract<ActivationStateMigrationPlan, { status: 'blocked' }>['report']['reasonCode'],
  issues: readonly string[], diagnosticOnly = false
): ActivationStateMigrationPlan {
  return {
    status: 'blocked', mutations: [], preconditions: [],
    report: {
      path: activationStateFilePathParts.join('/'), status: 'blocked', checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes', unversionedImport: 'requires-explicit-import-mapping',
      reasonCode, issues, ...(diagnosticOnly ? { diagnosticOnly: true } : {})
    }
  };
}

function unchanged(status: 'not-present' | 'current'): ActivationStateMigrationPlan {
  return {
    status, mutations: [], preconditions: [],
    report: {
      path: activationStateFilePathParts.join('/'), status, checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes', unversionedImport: 'requires-explicit-import-mapping', issues: []
    }
  };
}

/** Read-only diagnostic compatibility. Actual successors use the reviewed history transaction. */
export async function planHistoricalActivationStateMigration(
  projectRoot: string, _nowIso = new Date().toISOString(),
  _mappingInput: ActivationStateMigrationMappingInput = {}
): Promise<ActivationStateMigrationPlan> {
  try {
    const snapshot = await captureHistoryFile(projectRoot, activationStateFilePathParts);
    if (snapshot.content === undefined) {
      const records = await activeActivationRecordsWithoutState(projectRoot);
      return records.length
        ? blocked('missing-historical-record', [`Required activation state is absent while active execution records remain: ${records.map((parts) => parts.join('/')).join(', ')}. No state was manufactured.`])
        : unchanged('not-present');
    }
    const parsed = parseHistoryJson(snapshot.content, 'governance/activation-state.json');
    assertSafeHistoricalRecord(parsed, 'governance/activation-state.json');
    if (!isRecord(parsed) || !Object.hasOwn(parsed, 'schemaVersion') || !Object.hasOwn(parsed, 'identity')) {
      return blocked('ad-hoc-state', ['Versioned activation state with an exact identity is required. Checkboxes, filenames, or prose are not an import mapping.']);
    }
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > activationStateSchemaVersion) {
      return blocked('future-state-schema', [`Unsupported activationState.schemaVersion ${parsed.schemaVersion}; this release reads current schema ${activationStateSchemaVersion}. Preserve bytes and upgrade Liftoff.`]);
    }
    if (isHistoricalActivationIdentity(parsed.identity)) {
      validateReadableHistoricalActivationState(parsed);
      return blocked('unsupported-activation-identity', [
        `Historical activation v${parsed.identity.activationContractVersion} is diagnostic-only. Run liftoff update --check to inspect the exact history-preserving v3 successor. Historical proof and approval remain non-executable; no v2 intermediate, header relabeling, or OpenTofu-state operation is authorized.`
      ], true);
    }
    if (canonicalSha256(parsed.identity) !== canonicalSha256(currentActivationIdentity)) {
      return blocked('unsupported-activation-identity', [
        'The complete activation identity is not an installed executable tuple or declared historical source without an explicit compatibility map. Explicit project-edited compatibility/migration mappings cannot add a lane; preserve the original records.'
      ]);
    }
    try {
      validateUserActivationState(parsed);
      await inspectActivationMigrationHistory(projectRoot);
      return unchanged('current');
    } catch (error) {
      return blocked('malformed-state', [`Current activation state failed strict validation: ${error instanceof Error ? error.message : 'unknown validation failure'}`]);
    }
  } catch (error) {
    if (!(error instanceof ActivationHistoryError)) throw error;
    return blocked('malformed-state', [error.message]);
  }
}

export function activationStateMigrationFingerprint(content: string | Buffer): string {
  return activationStateContentHash(content);
}
