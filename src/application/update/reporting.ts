import {
  spawnSync
} from 'node:child_process';
import {
  existsSync
} from 'node:fs';
import path from 'node:path';
import {
  manifestDisplayPath
} from '../../domain/project/paths.js';
import {
  readProjectFile
} from '../../adapters/filesystem/project-files.js';
import type {
  ReconcileEntry
} from '../../reconcile.js';
import {
  loadActivationState as loadCurrentActivationState
} from '../../governance-activation/activation-state.js';
import {
  updateFailureInjectionEnv,
  type ActivationStateMigrationPlan
} from '../../governance-activation/migration.js';
import {
  currentActivationIdentity
} from '../../governance-activation/graph.js';
import {
  governanceChangeMetadataFileName,
  reconcileActiveGovernanceChange,
  validateGovernanceChangeMetadata,
  type GovernanceActiveReconciliationResult
} from '../../governance-activation/source-of-truth.js';
import type {
  LiftoffManifest
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';

interface UpdateSummary {
  new: number;
  missing: number;
  upgrade: number;
  conflict: number;
  moved: number;
  orphan: number;
  retired: number;
  retiredRemoved: number;
  retiredAbsent: number;
  retiredConflict: number;
  refresh: number;
  unchanged: number;
}

export function summarizeEntries(entries: ReconcileEntry[]): UpdateSummary {
  const summary: UpdateSummary = {
    new: 0,
    missing: 0,
    upgrade: 0,
    conflict: 0,
    moved: 0,
    orphan: 0,
    retired: 0,
    retiredRemoved: 0,
    retiredAbsent: 0,
    retiredConflict: 0,
    refresh: 0,
    unchanged: 0
  };
  for (const entry of entries) {
    if (entry.status === 'unchanged') {
      if (entry.refreshHash) {
        summary.refresh += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }
    if (entry.status === 'retired-conflict') {
      summary.retiredConflict += 1;
      continue;
    }
    if (entry.status === 'retired') {
      summary.retired += 1;
      if (entry.destinationOccupied === false) {
        summary.retiredAbsent += 1;
      } else {
        summary.retiredRemoved += 1;
      }
      continue;
    }
    if (entry.status === 'moved' && !entry.cleanMove) {
      summary.conflict += 1;
      continue;
    }
    summary[entry.status] += 1;
  }
  return summary;
}

export function entryMarker(entry: ReconcileEntry): string {
  switch (entry.status) {
    case 'new':
    case 'missing':
      return '+';
    case 'upgrade':
      return '~';
    case 'conflict':
      return '!';
    case 'moved':
      return entry.cleanMove ? '>' : '!';
    case 'orphan':
    case 'retired':
      return '-';
    case 'retired-conflict':
      return '!';
    default:
      return '~';
  }
}

export function entryDisplay(entry: ReconcileEntry): string {
  if (entry.status === 'moved' && entry.previousPathParts) {
    return `${manifestDisplayPath(entry.previousPathParts)} => ${manifestDisplayPath(entry.pathParts)}`;
  }
  return manifestDisplayPath(entry.pathParts);
}

export function isDirtyGitWorktree(projectRoot: string): boolean {
  if (!existsSync(path.join(projectRoot, '.git'))) {
    return false;
  }
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}


interface ManifestChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ManagedUpdateReconciliationReport {
  status: 'not-required' | 'reconciliation-required' | 'blocked';
  changedIdentityFields: readonly ManifestChange[];
  phaseImpact: {
    preservedPhaseIds: readonly string[];
    invalidPhaseIds: readonly string[];
  };
  issues: readonly string[];
  remedy?: string;
}

function identityFieldChanges(
  from: Partial<Record<keyof typeof currentActivationIdentity, unknown>>,
  to = currentActivationIdentity
): ManifestChange[] {
  return (Object.keys(to) as (keyof typeof currentActivationIdentity)[])
    .filter((field) => from[field] !== undefined && from[field] !== to[field])
    .map((field) => ({
      field: `activationIdentity.${field}`,
      from: from[field],
      to: to[field]
    }));
}

export function manifestChanges(
  manifest: LiftoffManifest,
  plannedManifest: LiftoffManifest
): ManifestChange[] {
  const changes: ManifestChange[] = [];
  if (manifest.artifactVersion !== plannedManifest.artifactVersion) {
    changes.push({
      field: 'artifactVersion',
      from: manifest.artifactVersion,
      to: plannedManifest.artifactVersion
    });
  }
  if (manifest.liftoffVersion !== plannedManifest.liftoffVersion) {
    changes.push({
      field: 'liftoffVersion',
      from: manifest.liftoffVersion,
      to: plannedManifest.liftoffVersion
    });
  }
  if (
    manifest.governance.profile !== 'none' &&
    manifest.governance.profile !== 'unspecified' &&
    plannedManifest.governance.profile !== 'none' &&
    plannedManifest.governance.profile !== 'unspecified'
  ) {
    if (manifest.governance.policyVersion !== plannedManifest.governance.policyVersion) {
      changes.push({
        field: 'governance.policyVersion',
        from: manifest.governance.policyVersion,
        to: plannedManifest.governance.policyVersion
      });
    }
    const fromIdentity = manifest.governance.activationIdentity;
    const toIdentity = plannedManifest.governance.activationIdentity;
    if (toIdentity) {
      if (!fromIdentity) {
        changes.push({
          field: 'governance.activationIdentity',
          from: null,
          to: toIdentity
        });
      } else {
        changes.push(...identityFieldChanges(fromIdentity, toIdentity));
      }
    }
  }
  return changes;
}

export function stateMigrationReconciliation(
  stateMigration: ActivationStateMigrationPlan
): ManagedUpdateReconciliationReport {
  if (stateMigration.status === 'blocked') {
    if (stateMigration.report.diagnosticOnly === true) {
      return {
        status: 'reconciliation-required',
        changedIdentityFields: [],
        phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
        issues: stateMigration.report.issues,
        remedy: 'Managed-core maintenance may continue, but historical activation v1 state and evidence remain diagnostic-only and byte-preserved. No activation migration or execution is authorized.'
      };
    }
    return {
      status: 'blocked',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: stateMigration.report.issues,
      remedy: 'Preserve governance/activation-state.json byte-for-byte and provide an explicit versioned import mapping; checkboxes, filenames, and prose cannot become evidence.'
    };
  }
  if (stateMigration.status === 'migrate') {
    return {
      status: 'reconciliation-required',
      changedIdentityFields: identityFieldChanges(stateMigration.report.fromIdentity, stateMigration.report.toIdentity),
      phaseImpact: {
        preservedPhaseIds: stateMigration.report.preservedPhaseIds,
        invalidPhaseIds: stateMigration.report.invalidPhaseIds
      },
      issues: [
        `Historical activation state will be migrated with the managed update transaction; evidence bytes are preserved and ${stateMigration.report.reconciliationPath} records the explicit graph mapping.`
      ],
      remedy: 'Run governance status/verify after update and acknowledge the reconciliation record before executing affected phases.'
    };
  }
  return {
    status: 'not-required',
    changedIdentityFields: [],
    phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
    issues: []
  };
}

function activeChangePathParts(stateKind: 'openspec' | 'spec-kit', changeId: string): string[] {
  return stateKind === 'openspec'
    ? ['openspec', 'changes', changeId]
    : ['specs', changeId];
}

export async function activeChangeReconciliationReport(
  projectRoot: string
): Promise<ManagedUpdateReconciliationReport> {
  let loaded;
  try {
    loaded = await loadCurrentActivationState(projectRoot);
  } catch {
    return {
      status: 'not-required',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: []
    };
  }
  const activeChange = loaded?.state.activeChange;
  if (!activeChange) {
    return {
      status: 'not-required',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: []
    };
  }
  const metadataPathParts = [
    ...activeChangePathParts(activeChange.kind, activeChange.id),
    governanceChangeMetadataFileName
  ];
  const bytes = await readProjectFile(projectRoot, metadataPathParts);
  if (bytes === undefined) {
    return {
      status: 'blocked',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: [
        `${metadataPathParts.join('/')} is missing for active change ${activeChange.id}; no update mode can infer it from tasks or prose.`
      ],
      remedy: 'Restore schema-valid governance metadata or record an explicit supersession before continuing setup.'
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    return {
      status: 'blocked',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: [`Unable to parse ${metadataPathParts.join('/')}: ${error instanceof Error ? error.message : String(error)}`],
      remedy: 'Restore schema-valid governance metadata; no update mode can infer active governance from checkboxes, filenames, or prose.'
    };
  }
  let reconciliation: GovernanceActiveReconciliationResult;
  try {
    const metadata = validateGovernanceChangeMetadata(parsed);
    reconciliation = reconcileActiveGovernanceChange({ metadata, evidence: [] });
  } catch (error) {
    return {
      status: 'blocked',
      changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: [`Invalid ${metadataPathParts.join('/')}: ${error instanceof Error ? error.message : String(error)}`],
      remedy: 'Restore schema-valid governance metadata; no update mode can infer active governance from checkboxes, filenames, or prose.'
    };
  }
  if (reconciliation.status === 'not-required') {
    return {
      status: 'not-required',
      changedIdentityFields: [],
      phaseImpact: {
        preservedPhaseIds: reconciliation.preservedPhaseIds,
        invalidPhaseIds: reconciliation.invalidPhaseIds
      },
      issues: []
    };
  }
  if (reconciliation.status === 'blocked') {
    return {
      status: 'blocked',
      changedIdentityFields: [],
      phaseImpact: {
        preservedPhaseIds: reconciliation.preservedPhaseIds,
        invalidPhaseIds: reconciliation.invalidPhaseIds
      },
      issues: reconciliation.issues,
      remedy: 'Upgrade Liftoff or add an explicit compatibility mapping before executing affected governance phases.'
    };
  }
  return {
    status: 'reconciliation-required',
    changedIdentityFields: identityFieldChanges(reconciliation.fromIdentity, reconciliation.toIdentity),
    phaseImpact: {
      preservedPhaseIds: reconciliation.preservedPhaseIds,
      invalidPhaseIds: reconciliation.invalidPhaseIds
    },
    issues: reconciliation.issues,
    remedy: 'Managed definitions and manifest may be updated, but governance status/verify will block affected execution until the active change acknowledges the installed identity.'
  };
}

export function combineReconciliationReports(
  reports: readonly ManagedUpdateReconciliationReport[]
): ManagedUpdateReconciliationReport {
  if (reports.some((report) => report.status === 'blocked')) {
    return {
      status: 'blocked',
      changedIdentityFields: reports.flatMap((report) => report.changedIdentityFields),
      phaseImpact: {
        preservedPhaseIds: [],
        invalidPhaseIds: [...new Set(reports.flatMap((report) => report.phaseImpact.invalidPhaseIds))]
      },
      issues: reports.flatMap((report) => report.issues),
      remedy: reports.find((report) => report.remedy)?.remedy
    };
  }
  if (reports.some((report) => report.status === 'reconciliation-required')) {
    return {
      status: 'reconciliation-required',
      changedIdentityFields: reports.flatMap((report) => report.changedIdentityFields),
      phaseImpact: {
        preservedPhaseIds: [...new Set(reports.flatMap((report) => report.phaseImpact.preservedPhaseIds))],
        invalidPhaseIds: [...new Set(reports.flatMap((report) => report.phaseImpact.invalidPhaseIds))]
      },
      issues: reports.flatMap((report) => report.issues),
      remedy: reports.find((report) => report.remedy)?.remedy
    };
  }
  return {
    status: 'not-required',
    changedIdentityFields: [],
    phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
    issues: []
  };
}

export function maybeInjectUpdateFailure(
  env: NodeJS.ProcessEnv | undefined,
  stage: string
): void {
  const requested = env?.[updateFailureInjectionEnv] ?? process.env[updateFailureInjectionEnv];
  if (requested === stage) {
    throw new Error(`Injected managed-update failure at ${stage}.`);
  }
}
