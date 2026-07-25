import { describe, expect, it } from 'vitest';
import { manifestDisplayPath } from '../src/file-system.js';
import type { ReconcileEntry } from '../src/reconcile.js';
import {
  buildUpdateImpact,
  dependencyDefinitionLogicalNames
} from '../src/update-impact.js';

function entry(
  logicalName: string,
  status: ReconcileEntry['status'],
  pathParts: string[],
  values: Partial<ReconcileEntry> = {}
): ReconcileEntry {
  return {
    logicalName,
    status,
    pathParts,
    reason: 'fixture',
    ...values
  };
}

describe('update impact', () => {
  it('classifies and sorts every update action without implying side effects', () => {
    const impact = buildUpdateImpact([
      entry('new-z', 'new', ['z', 'new.txt']),
      entry('new-a', 'new', ['a', 'new.txt']),
      entry('missing', 'missing', ['restore.txt']),
      entry('frontend-package', 'upgrade', ['frontend', 'package.json']),
      entry('move', 'moved', ['new', 'managed.txt'], {
        previousPathParts: ['old', 'managed.txt'],
        cleanMove: true
      }),
      entry('refresh', 'unchanged', ['recorded.txt'], { refreshHash: true }),
      entry('node-backend-lock', 'conflict', ['backend', 'package-lock.json']),
      entry('missing-move-source', 'conflict', ['occupied', 'destination.txt'], {
        previousPathParts: ['missing', 'source.txt']
      }),
      entry('moved-conflict', 'moved', ['new', 'local.txt'], {
        previousPathParts: ['old', 'local.txt'],
        cleanMove: false,
        sourceModified: true,
        destinationOccupied: true,
        destinationMatches: false
      }),
      entry('orphan', 'orphan', ['retired.txt'])
    ]);

    expect(impact.creates).toEqual([
      manifestDisplayPath(['a', 'new.txt']),
      manifestDisplayPath(['z', 'new.txt'])
    ]);
    expect(impact.restores).toEqual([manifestDisplayPath(['restore.txt'])]);
    expect(impact.replacements).toEqual([
      manifestDisplayPath(['frontend', 'package.json'])
    ]);
    expect(impact.moves).toEqual([
      `${manifestDisplayPath(['old', 'managed.txt'])} => ${manifestDisplayPath(['new', 'managed.txt'])}`
    ]);
    expect(impact.recordedStateRefreshes).toEqual([
      manifestDisplayPath(['recorded.txt'])
    ]);
    expect(impact.conflicts).toEqual([
      manifestDisplayPath(['backend', 'package-lock.json']),
      manifestDisplayPath(['new', 'local.txt']),
      manifestDisplayPath(['occupied', 'destination.txt']),
      manifestDisplayPath(['old', 'local.txt'])
    ]);
    expect(impact.managedPathsRemoved).toEqual([
      manifestDisplayPath(['old', 'managed.txt'])
    ]);
    expect(impact.managedPathsRemovedOnOverwrite).toEqual([
      manifestDisplayPath(['old', 'local.txt'])
    ]);
    expect(impact.orphansPreserved).toEqual([
      manifestDisplayPath(['retired.txt'])
    ]);
    expect(impact.dependencyDefinitions).toEqual([
      manifestDisplayPath(['backend', 'package-lock.json']),
      manifestDisplayPath(['frontend', 'package.json'])
    ]);
    expect(impact).toMatchObject({
      safeActionCount: 6,
      localOrUserOwnedFilesAtRisk: 4,
      manifestWillUpdate: true,
      installsDependencies: false,
      deletesOrphans: false,
      retainsBackupAfterSuccess: false,
      hasSafeActions: true,
      hasActionableChanges: true
    });
    expect(Object.isFrozen(impact)).toBe(true);
    expect(Object.isFrozen(impact.conflicts)).toBe(true);
  });

  it('tracks every generated dependency definition by logical name only', () => {
    expect(dependencyDefinitionLogicalNames).toEqual([
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
    ]);

    const tracked = dependencyDefinitionLogicalNames.map((logicalName, index) =>
      entry(logicalName, 'upgrade', ['dependencies', `${index}.txt`])
    );
    const impact = buildUpdateImpact([
      ...tracked,
      entry('user-package', 'upgrade', ['package.json'])
    ]);

    expect(impact.dependencyDefinitions).toHaveLength(
      dependencyDefinitionLogicalNames.length
    );
    expect(impact.dependencyDefinitions).not.toContain(
      manifestDisplayPath(['package.json'])
    );
  });

  it('does not offer an action for orphan-only drift', () => {
    const impact = buildUpdateImpact([
      entry('retired', 'orphan', ['legacy', 'retired.txt'])
    ]);

    expect(impact.safeActionCount).toBe(0);
    expect(impact.localOrUserOwnedFilesAtRisk).toBe(0);
    expect(impact.manifestWillUpdate).toBe(false);
    expect(impact.hasSafeActions).toBe(false);
    expect(impact.hasActionableChanges).toBe(false);
  });
});
