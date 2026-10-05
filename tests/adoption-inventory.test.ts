import { chmod, link, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectAdoptionLayout } from '../src/application/adoption/inventory.js';
import { applicationDigest } from '../src/application/repair/application-files.js';
import { applicationBounds } from '../src/application/repair/application-types.js';
import { currentApplicationTargets, currentBoundApplicationTargets } from '../src/application/repair/application-inventory.js';
import type { ManifestProjectArtifact } from '../src/domain/project/contracts.js';
import * as manifestWriter from '../src/application/project/manifest-writer.js';
import { adoptionFixture } from './fixtures/adoption.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

const roots: string[] = [];
async function directory() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lf adopt ')));
  roots.push(root);
  return root;
}
async function put(root: string, parts: readonly string[], bytes: string | Buffer, mode = 0o640) {
  const filename = path.join(root, ...parts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes, { mode });
}
async function fixture(stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify') {
  const root = await directory();
  const value = adoptionFixture(stack);
  const backend = value.request.adoptionObservations.find(entry => entry.logicalName !== 'root-readme');
  if (!backend) throw new Error('Missing selected backend fixture.');
  await put(root, backend.pathParts, 'PRIVATE_CUSTOM_APPLICATION\r\n');
  await put(root, ['README.md'], `PRIVATE_DOCUMENTATION\nSee "${backend.pathParts.join('/')}".\n`);
  return { root, ...value, backend };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('manifest-free adoption observation', () => {
  it.each(['python-fastapi', 'node-fastify', 'go-huma'] as const)(
    'captures exact compatible-binding comparison inputs for %s without claiming compatibility', async stack => {
      const { root, source, backend } = await fixture(stack);
      const construct = vi.spyOn(manifestWriter, 'createManifestV8Candidate');
      const before = await stat(path.join(root, ...backend.pathParts));
      const inspection = await inspectAdoptionLayout(root, source);
      expect(construct).not.toHaveBeenCalled();
      expect(inspection.report).toMatchObject({
        schemaVersion: 1, kind: 'liftoff-adoption-inventory', readOnly: true, projectRoot: root,
        manifest: 'observed-absent', compatibility: 'not-verified', deployment: 'planning-only',
        unobservedBindings: [], unmappedFiles: []
      });
      expect(inspection.report.target).toEqual(currentBoundApplicationTargets(source).target);
      expect(inspection.report.files.find(file => file.currentTargetLogicalName === backend.logicalName))
        .toMatchObject({ pathParts: backend.pathParts, digest: applicationDigest('PRIVATE_CUSTOM_APPLICATION\r\n'),
          bytes: Buffer.byteLength('PRIVATE_CUSTOM_APPLICATION\r\n'), mode: before.mode & 0o7777, provenance: null });
      expect(inspection.report.adoptionObservations).toContainEqual({
        logicalName: backend.logicalName, pathParts: backend.pathParts,
        observedHash: `sha256:${applicationDigest('PRIVATE_CUSTOM_APPLICATION\r\n')}`
      });
      expect(inspection.report.references).toContainEqual(expect.objectContaining({
        sourcePathParts: ['README.md'], targetPathParts: backend.pathParts, targetKind: 'file'
      }));
      expect(inspection.report.inspectionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(inspection)).not.toContain('PRIVATE_');
      expect(JSON.stringify(inspection)).not.toContain('"type":"Buffer"');
      expect(inspection.snapshots.some(snapshot => snapshot.content?.includes(Buffer.from('PRIVATE_CUSTOM_APPLICATION')))).toBe(true);
      expect(await readFile(path.join(root, ...backend.pathParts))).toEqual(Buffer.from('PRIVATE_CUSTOM_APPLICATION\r\n'));
      expect((await stat(path.join(root, ...backend.pathParts))).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
      expect((await inspectAdoptionLayout(root, source)).report).toEqual(inspection.report);
    });

  it('produces honest candidate observations from captured bytes rather than generation hashes', async () => {
    const { root, source, request } = await fixture();
    const inspection = await inspectAdoptionLayout(root, source);
    const candidate = manifestWriter.createManifestV8Candidate({
      ...request, adoptionObservations: inspection.report.adoptionObservations
    });
    expect(candidate.manifest.projectArtifacts).toEqual([]);
    expect(candidate.manifest.adoptionObservations).toEqual(inspection.report.adoptionObservations);
    expect(candidate.manifest).not.toHaveProperty('sourceManifestHistory');
    expect(candidate.manifest).not.toHaveProperty('activationTargetHistory');
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it('reports actual source/test/container/CI/documentation references and unmapped files without inventing moves', async () => {
    const { root, source, backend } = await fixture();
    await put(root, ['custom', 'helper.ts'], 'export const privateRule = 37;\n');
    await put(root, ['tests', 'existing.test.ts'], 'import {privateRule} from "../custom/helper.js";\n');
    await put(root, ['Dockerfile'], `COPY "${backend.pathParts.join('/')}" /app\n`);
    await put(root, ['compose.yml'], 'services:\n  api:\n    build:\n      context: "Existing Services/API With Spaces"\n');
    await put(root, ['.github', 'workflows', 'custom.yml'], 'steps:\n  - run: echo "custom/helper.ts"\n');
    const inspection = await inspectAdoptionLayout(root, source);
    expect(inspection.report.unmappedFiles).toContainEqual({ pathParts: ['custom', 'helper.ts'] });
    expect(inspection.report.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePathParts: ['tests', 'existing.test.ts'], targetPathParts: ['custom', 'helper.ts'] }),
      expect.objectContaining({ sourcePathParts: ['Dockerfile'], targetPathParts: backend.pathParts }),
      expect.objectContaining({ sourcePathParts: ['compose.yml'], targetPathParts: ['Existing Services', 'API With Spaces'] }),
      expect.objectContaining({ sourcePathParts: ['.github', 'workflows', 'custom.yml'], targetPathParts: ['custom', 'helper.ts'] })
    ]));
    expect(inspection.report.referenceCoverage).toBe('bounded-literals-only');
    expect(inspection.report.compatibility).toBe('not-verified');
    expect(inspection.report).not.toHaveProperty('moves');
    expect(inspection.report).not.toHaveProperty('approval');
    expect(JSON.stringify(inspection.report)).not.toContain('privateRule');
  });

  it('does not read secret/state/control/dependency/history content or execute declared scripts', async () => {
    const { root, source } = await fixture();
    const excluded = [
      ['.git', 'HEAD'], ['infrastructure', 'main.tf'], ['node_modules', 'dependency.js'],
      ['.env'], ['terraform.tfstate'], ['private.key'], ['runtime.config.json'],
      ['openspec', 'changes', 'private.md'], ['.claude', 'private.md']
    ];
    for (const parts of excluded) await put(root, parts, 'PRIVATE_PROTECTED_CONTENT');
    await put(root, ['package.json'], '{"scripts":{"test":"node PRIVATE_PROJECT_SCRIPT"}}\n');
    vi.mocked(open).mockClear();
    vi.mocked(opendir).mockClear();
    const inspection = await inspectAdoptionLayout(root, source);
    const reads = vi.mocked(open).mock.calls.map(([filename]) => String(filename));
    const enumerations = vi.mocked(opendir).mock.calls.map(([filename]) => String(filename));
    for (const parts of excluded) {
      expect(reads).not.toContain(path.join(root, ...parts));
      expect(inspection.snapshots.some(snapshot => snapshot.pathParts.join('/') === parts.join('/'))).toBe(false);
    }
    for (const name of ['.git', 'infrastructure', 'node_modules', 'openspec', '.claude']) {
      expect(enumerations.some(filename => filename === path.join(root, name) || filename.startsWith(`${path.join(root, name)}${path.sep}`))).toBe(false);
    }
    expect(inspection.report.deployment).toBe('planning-only');
    expect(JSON.stringify(inspection)).not.toContain('PRIVATE_');
    expect(await readFile(path.join(root, '.git', 'HEAD'), 'utf8')).toBe('PRIVATE_PROTECTED_CONTENT');
  });

  it.each(['liftoff.manifest.json', 'LIFTOFF.MANIFEST.JSON', '.liftoff', '.liftoff-init.lock'])(
    'refuses existing %s without reading/reinitializing the boundary or selecting an outer project', async name => {
      const { root, source } = await fixture();
      if (name === '.liftoff') await put(root, [name, 'unknown-transaction.json'], 'PRIVATE_CONTROL');
      else await put(root, [name], 'PRIVATE_CONTROL');
      vi.mocked(open).mockClear();
      await expect(inspectAdoptionLayout(root, source)).rejects.toThrow('control/transaction boundaries');
      expect(vi.mocked(open).mock.calls).toHaveLength(0);
      expect(await readdir(root)).toContain(name);
    });

  it('keeps missing/excluded bindings unobserved rather than manufacturing observations or undeployed proof', async () => {
    const { root, source, backend } = await fixture();
    const moved = {
      ...source, activeLayout: {
        ...source.activeLayout, bindings: source.activeLayout.bindings.map(binding =>
          binding.kind === 'artifact' && binding.logicalName === backend.logicalName
            ? { ...binding, pathParts: [...binding.pathParts.slice(0, -1), 'missing.ts'] } : binding)
      }
    };
    const inspection = await inspectAdoptionLayout(root, moved);
    expect(inspection.report.unobservedBindings).toContainEqual({
      logicalName: backend.logicalName, pathParts: [...backend.pathParts.slice(0, -1), 'missing.ts']
    });
    expect(inspection.report.adoptionObservations.some(entry => entry.logicalName === backend.logicalName)).toBe(false);
    expect(inspection.report.unmappedFiles).toContainEqual({ pathParts: backend.pathParts });
    expect(inspection.report.deployment).toBe('planning-only');
  });

  it('refuses symlink/junction roots, unsafe application links and hardlinked payloads', async () => {
    const { root, source } = await fixture();
    const outside = await directory();
    await put(outside, ['private.txt'], 'PRIVATE_OUTSIDE_CONTENT');
    const alias = path.join(outside, 'root-alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectAdoptionLayout(alias, source)).rejects.toThrow(/links|junctions/);
    await link(path.join(outside, 'private.txt'), path.join(root, 'hardlinked.txt'));
    await expect(inspectAdoptionLayout(root, source)).rejects.toThrow('only singly linked regular files');
    expect(await readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('PRIVATE_OUTSIDE_CONTENT');
  });

  it('fails closed on oversized source scope without a partial success-shaped report', async () => {
    const { root, source } = await fixture();
    await put(root, ['oversized.txt'], Buffer.alloc(applicationBounds.fileBytes + 1, 65));
    await expect(inspectAdoptionLayout(root, source)).rejects.toThrow(/bound/);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.skipIf(process.platform === 'win32')('binds actual source permission changes without altering the files', async () => {
    const { root, source, backend } = await fixture();
    const before = await inspectAdoptionLayout(root, source);
    await chmod(path.join(root, ...backend.pathParts), 0o600);
    const after = await inspectAdoptionLayout(root, source);
    expect(after.report.inspectionDigest).not.toBe(before.report.inspectionDigest);
    expect(after.report.files.find(file => file.currentTargetLogicalName === backend.logicalName)?.mode).toBe(0o600);
    expect(await readFile(path.join(root, ...backend.pathParts), 'utf8')).toBe('PRIVATE_CUSTOM_APPLICATION\r\n');
  });

  it('does not infer a team/public repair executor or unbound application targets', async () => {
    const root = await directory();
    await expect(inspectAdoptionLayout(root, adoptionFixture('node-fastify', 'team-gitflow').source))
      .rejects.toThrow('team-profile repair is not available');
    const value = adoptionFixture();
    await expect(inspectAdoptionLayout(root, {
      ...value.source, activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
    })).rejects.toThrow('explicit active bindings');
  });

  it('preserves repair exclusion of repurposed historical infrastructure paths without inventing it for adoption', () => {
    const value = adoptionFixture();
    const manifest = manifestWriter.createManifestV8Candidate(value.request).manifest;
    const original: ManifestProjectArtifact = {
      logicalName: 'historical-infrastructure-file', category: 'infrastructure', pathParts: ['README.md'],
      generatedBy: '0.12.3', generationHash: `sha256:${applicationDigest('original infrastructure specimen')}`,
      provisioningGroup: 'base'
    };
    const existing = currentApplicationTargets({ ...manifest, projectArtifacts: [original] });
    expect(existing.protectedPaths.has('readme.md')).toBe(true);
    expect(existing.target.artifacts.some(artifact => artifact.logicalName === 'root-readme')).toBe(false);
    const unmanaged = currentBoundApplicationTargets(value.source);
    expect(unmanaged.target.artifacts.some(artifact => artifact.logicalName === 'root-readme')).toBe(true);
  });
});
