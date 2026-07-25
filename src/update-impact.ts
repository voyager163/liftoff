import { manifestDisplayPath } from './file-system.js';
import type { ReconcileEntry } from './reconcile.js';

export const dependencyDefinitionLogicalNames = Object.freeze([
  'backend-pyproject',
  'function-worker-requirements',
  'node-backend-package',
  'node-backend-lock',
  'go-backend-module',
  'go-backend-checksums',
  'frontend-package',
  'frontend-lock',
  'power-apps-package',
  'power-apps-lock'
] as const);

const dependencyDefinitionLogicalNameSet = new Set<string>(
  dependencyDefinitionLogicalNames
);

export interface UpdateImpact {
  readonly creates: readonly string[];
  readonly restores: readonly string[];
  readonly replacements: readonly string[];
  readonly moves: readonly string[];
  readonly recordedStateRefreshes: readonly string[];
  readonly conflicts: readonly string[];
  readonly managedPathsRemoved: readonly string[];
  readonly managedPathsRemovedOnOverwrite: readonly string[];
  readonly orphansPreserved: readonly string[];
  readonly dependencyDefinitions: readonly string[];
  readonly safeActionCount: number;
  readonly localOrUserOwnedFilesAtRisk: number;
  readonly manifestWillUpdate: boolean;
  readonly installsDependencies: false;
  readonly deletesOrphans: false;
  readonly retainsBackupAfterSuccess: false;
  readonly hasSafeActions: boolean;
  readonly hasActionableChanges: boolean;
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayEntry(entry: ReconcileEntry): string {
  const current = manifestDisplayPath(entry.pathParts);
  return entry.previousPathParts
    ? `${manifestDisplayPath(entry.previousPathParts)} => ${current}`
    : current;
}

function freezeSorted(values: string[]): readonly string[] {
  return Object.freeze(values.sort(comparePortable));
}

function isActionable(entry: ReconcileEntry): boolean {
  return entry.status !== 'orphan' &&
    (entry.status !== 'unchanged' || entry.refreshHash === true);
}

export function buildUpdateImpact(entries: readonly ReconcileEntry[]): UpdateImpact {
  const creates: string[] = [];
  const restores: string[] = [];
  const replacements: string[] = [];
  const moves: string[] = [];
  const recordedStateRefreshes: string[] = [];
  const conflicts: string[] = [];
  const managedPathsRemoved: string[] = [];
  const managedPathsRemovedOnOverwrite: string[] = [];
  const orphansPreserved: string[] = [];
  const dependencyDefinitions: string[] = [];

  for (const entry of entries) {
    switch (entry.status) {
      case 'new':
        creates.push(manifestDisplayPath(entry.pathParts));
        break;
      case 'missing':
        restores.push(manifestDisplayPath(entry.pathParts));
        break;
      case 'upgrade':
        replacements.push(manifestDisplayPath(entry.pathParts));
        break;
      case 'moved':
        if (entry.cleanMove) {
          moves.push(displayEntry(entry));
          if (entry.previousPathParts) {
            managedPathsRemoved.push(manifestDisplayPath(entry.previousPathParts));
          }
        } else {
          if (entry.sourceModified && entry.previousPathParts) {
            conflicts.push(manifestDisplayPath(entry.previousPathParts));
          }
          if (entry.destinationOccupied && !entry.destinationMatches) {
            conflicts.push(manifestDisplayPath(entry.pathParts));
          }
          if (entry.previousPathParts) {
            managedPathsRemovedOnOverwrite.push(
              manifestDisplayPath(entry.previousPathParts)
            );
          }
        }
        break;
      case 'conflict':
        conflicts.push(manifestDisplayPath(entry.pathParts));
        break;
      case 'orphan':
        orphansPreserved.push(manifestDisplayPath(entry.pathParts));
        break;
      case 'unchanged':
        if (entry.refreshHash) {
          recordedStateRefreshes.push(manifestDisplayPath(entry.pathParts));
        }
        break;
    }

    if (
      isActionable(entry) &&
      dependencyDefinitionLogicalNameSet.has(entry.logicalName)
    ) {
      dependencyDefinitions.push(manifestDisplayPath(entry.pathParts));
    }
  }

  const frozenCreates = freezeSorted(creates);
  const frozenRestores = freezeSorted(restores);
  const frozenReplacements = freezeSorted(replacements);
  const frozenMoves = freezeSorted(moves);
  const frozenRefreshes = freezeSorted(recordedStateRefreshes);
  const frozenConflicts = freezeSorted(conflicts);
  const frozenManagedPaths = freezeSorted(managedPathsRemoved);
  const frozenManagedOverwritePaths = freezeSorted(managedPathsRemovedOnOverwrite);
  const frozenOrphans = freezeSorted(orphansPreserved);
  const frozenDependencyDefinitions = freezeSorted(dependencyDefinitions);
  const safeActionCount =
    frozenCreates.length +
    frozenRestores.length +
    frozenReplacements.length +
    frozenMoves.length +
    frozenRefreshes.length;
  const hasSafeActions = safeActionCount > 0;
  const hasActionableChanges = hasSafeActions || frozenConflicts.length > 0;

  return Object.freeze({
    creates: frozenCreates,
    restores: frozenRestores,
    replacements: frozenReplacements,
    moves: frozenMoves,
    recordedStateRefreshes: frozenRefreshes,
    conflicts: frozenConflicts,
    managedPathsRemoved: frozenManagedPaths,
    managedPathsRemovedOnOverwrite: frozenManagedOverwritePaths,
    orphansPreserved: frozenOrphans,
    dependencyDefinitions: frozenDependencyDefinitions,
    safeActionCount,
    localOrUserOwnedFilesAtRisk: frozenConflicts.length,
    manifestWillUpdate: hasActionableChanges,
    installsDependencies: false,
    deletesOrphans: false,
    retainsBackupAfterSuccess: false,
    hasSafeActions,
    hasActionableChanges
  });
}
