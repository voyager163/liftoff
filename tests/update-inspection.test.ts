import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureProject } from '../src/commands.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { planUpdateWrites } from '../src/application/update/write-plan.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await createFixtureProject({
    projectName: 'Reviewed Update',
    projectType: 'standard',
    apiStack: 'go',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanup.push(path.dirname(root));
  return root;
}

async function fingerprint(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    result[path.relative(root, absolute)] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return result;
}

describe('pure reviewed update inspection', () => {
  it('finds no work without changing any project file', async () => {
    const root = await fixture();
    const before = await fingerprint(root);
    const inspection = await inspectProjectUpdate(root);

    expect(inspection.hasDrift).toBe(false);
    expect(planUpdateWrites(inspection, false).hasWrites).toBe(false);
    expect(await fingerprint(root)).toEqual(before);
  });

  it('separates safe writes from an explicitly forced owned conflict', async () => {
    const root = await fixture();
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const original = await readFile(policyPath, 'utf8');
    await writeFile(policyPath, '# Independently edited policy\n');
    await rm(path.join(root, ...governanceArtifactPaths.guide));
    const before = await fingerprint(root);
    const inspection = await inspectProjectUpdate(root);
    const normal = planUpdateWrites(inspection, false);
    const forced = planUpdateWrites(inspection, true);

    expect(normal.skipped.map((entry) => entry.pathParts)).toContainEqual([...governanceArtifactPaths.policy]);
    expect(normal.mutations.some((entry) => entry.pathParts.join('/') === governanceArtifactPaths.policy.join('/'))).toBe(false);
    expect(forced.mutations).toContainEqual({
      type: 'write', pathParts: [...governanceArtifactPaths.policy], content: original
    });
    expect(forced.nextManifest.projectArtifacts).toEqual(inspection.manifest.projectArtifacts);
    expect(await fingerprint(root)).toEqual(before);
  });

  it('captures absent destinations and configuration as review preconditions', async () => {
    const root = await fixture();
    await rm(path.join(root, ...governanceArtifactPaths.guide));
    const inspection = await inspectProjectUpdate(root);

    expect(inspection.snapshots).toContainEqual({ pathParts: [...governanceArtifactPaths.guide] });
    expect(inspection.snapshots.find((entry) => entry.pathParts.join('/') === 'liftoff.config.json')?.content)
      .toBeInstanceOf(Buffer);
    expect(inspection.snapshots.find((entry) => entry.pathParts.join('/') === 'liftoff.manifest.json')?.content)
      .toBeInstanceOf(Buffer);
  });

  it('does not classify or restore production files', async () => {
    const root = await fixture();
    const inspection = await inspectProjectUpdate(root);
    const projectArtifact = inspection.manifest.projectArtifacts.find((artifact) => artifact.category !== 'documentation')!;
    await rm(path.join(root, ...projectArtifact.pathParts));
    const changed = await inspectProjectUpdate(root);

    expect(changed.entries.some((entry) => entry.logicalName === projectArtifact.logicalName)).toBe(false);
    expect(planUpdateWrites(changed, true).mutations.some((entry) =>
      entry.pathParts.join('\0') === projectArtifact.pathParts.join('\0')
    )).toBe(false);
  });
});
