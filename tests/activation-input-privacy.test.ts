import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as projectFiles from '../src/adapters/filesystem/project-files.js';
import { protectedLocalInputBlockers, readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import { phaseInputDigest } from '../src/domain/governance/activation/inputs.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { parseManifest } from '../src/application/project/manifest.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-input-privacy-'));
  roots.push(root);
  await mkdir(path.join(root, 'backend'));
  await writeFile(path.join(root, 'backend', 'app.ts'), 'export const ready = true;\n');
  await writeFile(path.join(root, 'backend', 'opaque-material.bin'), 'private fixture, not a public input\n');
  const plan = buildProjectPlan({
    projectName: 'Input privacy', projectType: 'standard', apiStack: 'node',
    agents: ['copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const manifest = parseManifest(JSON.parse(buildArtifacts(plan).find((entry) => entry.logicalName === 'manifest')!.content));
  return { root, manifest };
}

describe('explicit protected activation input exclusions', () => {
  it('never opens an opaque retained payload even when it sits under a public source root', async () => {
    const { root, manifest } = await fixture();
    const original = projectFiles.readProjectFile;
    const reads: string[] = [];
    vi.spyOn(projectFiles, 'readProjectFile').mockImplementation(async (projectRoot, parts) => {
      reads.push(parts.join('/'));
      if (parts.join('/') === 'backend/opaque-material.bin') throw new Error('Protected content must not be read.');
      return original(projectRoot, parts);
    });
    const options = { sensitivePathExclusions: [['backend', 'opaque-material.bin']] };
    expect(protectedLocalInputBlockers(options.sensitivePathExclusions)).toEqual([
      expect.stringContaining('Local checks cannot consume it')
    ]);
    const first = await readActivationInputSnapshot(root, manifest, undefined, options);
    expect(reads).not.toContain('backend/opaque-material.bin');
    expect(first.files.map((entry) => entry.path)).toEqual(['backend/app.ts']);
    await writeFile(path.join(root, 'backend', 'opaque-material.bin'), 'a changed private fixture\n');
    const second = await readActivationInputSnapshot(root, manifest, undefined, options);
    expect(phaseInputDigest('seed-verified', second)).toBe(phaseInputDigest('seed-verified', first));
    await writeFile(path.join(root, 'backend', 'app.ts'), 'export const ready = false;\n');
    const changed = await readActivationInputSnapshot(root, manifest, undefined, options);
    expect(phaseInputDigest('seed-verified', changed)).not.toBe(phaseInputDigest('seed-verified', first));
  });

  it('rejects traversal exclusions before observing project data', async () => {
    const { root, manifest } = await fixture();
    const read = vi.spyOn(projectFiles, 'readProjectFile');
    await expect(readActivationInputSnapshot(root, manifest, undefined, {
      sensitivePathExclusions: [['..', 'outside']]
    })).rejects.toThrow(/unsafe path/);
    expect(read).not.toHaveBeenCalled();
  });
});
