import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoot, loadManifest } from '../src/file-system.js';
import { resolveUpdateGuidanceContext } from '../src/application/update/guidance-context.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function nestedProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-discovery-'));
  roots.push(root);
  const outer = path.join(root, 'outer project');
  const inner = path.join(outer, 'nested project');
  await mkdir(inner, { recursive: true });
  const outerManifest = path.join(outer, 'liftoff.manifest.json');
  await writeFile(outerManifest, '{"outer":"sentinel"}\n');
  return { root, outer, inner, outerManifest };
}

describe('project discovery boundaries', () => {
  it('returns the nearest regular manifest even when its JSON is malformed', async () => {
    const fixture = await nestedProject();
    await writeFile(path.join(fixture.inner, 'liftoff.manifest.json'), '{ malformed');
    expect(await findProjectRoot(fixture.inner)).toBe(fixture.inner);
    await expect(loadManifest(fixture.inner)).rejects.toThrow(/Unable to read/);
    expect(await readFile(fixture.outerManifest, 'utf8')).toBe('{"outer":"sentinel"}\n');
  });

  it('does not walk past a directory masquerading as a manifest', async () => {
    const fixture = await nestedProject();
    await mkdir(path.join(fixture.inner, 'liftoff.manifest.json'));
    await expect(findProjectRoot(fixture.inner)).rejects.toThrow(/regular file/);
    expect(await readFile(fixture.outerManifest, 'utf8')).toBe('{"outer":"sentinel"}\n');
  });

  it('does not walk past a dangling manifest symlink or junction', async () => {
    const fixture = await nestedProject();
    const marker = path.join(fixture.inner, 'liftoff.manifest.json');
    if (process.platform === 'win32') {
      const target = path.join(fixture.root, 'junction target');
      await mkdir(target);
      await symlink(target, marker, 'junction');
      await rm(target, { recursive: true });
    } else {
      await symlink(path.join(fixture.root, 'missing manifest'), marker);
    }
    await expect(findProjectRoot(fixture.inner)).rejects.toThrow(/regular file/);
    expect(await readFile(fixture.outerManifest, 'utf8')).toBe('{"outer":"sentinel"}\n');
  });

  it.runIf(process.platform !== 'win32')('rejects an internal manifest symlink even for an explicit project root', async () => {
    const fixture = await nestedProject();
    const target = path.join(fixture.inner, 'real-manifest.json');
    await writeFile(target, '{"project":{"workload":{"kind":"standard"}}}');
    await symlink(target, path.join(fixture.inner, 'liftoff.manifest.json'));
    await expect(loadManifest(fixture.inner)).rejects.toThrow(/regular file/);
    expect(await readFile(target, 'utf8')).toBe('{"project":{"workload":{"kind":"standard"}}}');
  });

  it('retains a retired inner workload as an error rather than selecting the outer project', async () => {
    const fixture = await nestedProject();
    await writeFile(path.join(fixture.inner, 'liftoff.manifest.json'), JSON.stringify({
      project: { workload: { kind: 'power-apps-code-app' } },
      managedArtifacts: 'must not be interpreted'
    }));
    expect(await findProjectRoot(fixture.inner)).toBe(fixture.inner);
    await expect(loadManifest(fixture.inner)).rejects.toThrow(/Power Apps.*retired/);
    expect(await readFile(fixture.outerManifest, 'utf8')).toBe('{"outer":"sentinel"}\n');
  });

  it('walks outward only when the inner manifest is genuinely absent', async () => {
    const fixture = await nestedProject();
    expect(await findProjectRoot(fixture.inner)).toBe(fixture.outer);
  });
});

describe('update guidance discovery context', () => {
  it('recognizes the project root and reuses an established implicit discovery', async () => {
    const { outer } = await nestedProject();
    const canonical = await realpath(outer);

    expect(await resolveUpdateGuidanceContext(outer, outer, outer)).toEqual({
      state: 'resolved',
      requestedProjectRoot: outer,
      projectRoot: canonical,
      invocationDirectory: canonical,
      implicitProjectRoot: canonical
    });
    expect(await resolveUpdateGuidanceContext(outer, outer)).toEqual(
      await resolveUpdateGuidanceContext(outer, outer, outer)
    );
  });

  it('distinguishes a subdirectory from its discovered project root', async () => {
    const { outer, inner } = await nestedProject();
    expect(await resolveUpdateGuidanceContext(inner, outer)).toMatchObject({
      state: 'resolved',
      projectRoot: await realpath(outer),
      invocationDirectory: await realpath(inner),
      implicitProjectRoot: await realpath(outer)
    });
  });

  it('does not confuse an inner project or a similarly named sibling with the target', async () => {
    const { root, outer, inner } = await nestedProject();
    await writeFile(path.join(inner, 'liftoff.manifest.json'), '{}');
    expect(await resolveUpdateGuidanceContext(inner, outer)).toMatchObject({
      projectRoot: await realpath(outer),
      implicitProjectRoot: await realpath(inner)
    });
    const sibling = path.join(root, 'outer project-extra');
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'liftoff.manifest.json'), '{}');
    expect(await resolveUpdateGuidanceContext(sibling, outer)).toMatchObject({
      projectRoot: await realpath(outer),
      implicitProjectRoot: await realpath(sibling)
    });
  });

  it('keeps a broken inner boundary explicit instead of selecting its outer project', async () => {
    const { outer, inner } = await nestedProject();
    await mkdir(path.join(inner, 'liftoff.manifest.json'));
    expect(await resolveUpdateGuidanceContext(inner, outer)).toMatchObject({
      state: 'unresolved',
      detail: expect.stringContaining('regular file')
    });
    await expect(findProjectRoot(inner)).rejects.toThrow(/regular file/);
  });

  it('reports an unavailable invocation directory without hiding target failures', async () => {
    const { root, outer } = await nestedProject();
    const missing = path.join(root, 'missing');
    expect(await resolveUpdateGuidanceContext(missing, outer)).toMatchObject({
      state: 'unresolved',
      detail: expect.stringContaining(missing)
    });
    await expect(resolveUpdateGuidanceContext(outer, missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses canonical identities through an ancestor directory alias', async () => {
    const { root, outer } = await nestedProject();
    const project = path.join(outer, 'actual project');
    await mkdir(project);
    await writeFile(path.join(project, 'liftoff.manifest.json'), '{}');
    const alias = path.join(root, 'ancestor alias');
    await symlink(outer, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedProject = path.join(alias, 'actual project');

    expect(await resolveUpdateGuidanceContext(aliasedProject, project)).toMatchObject({
      state: 'resolved',
      projectRoot: await realpath(project),
      invocationDirectory: await realpath(project),
      implicitProjectRoot: await realpath(project)
    });
  });

  it('does not authorize implicit commands through a leaf project symlink or junction', async () => {
    const { root, outer } = await nestedProject();
    const alias = path.join(root, 'leaf project alias');
    await symlink(outer, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await findProjectRoot(alias)).toBe(alias);
    expect(await resolveUpdateGuidanceContext(alias, outer)).toMatchObject({
      state: 'unresolved',
      detail: expect.stringContaining('not a symlink or junction')
    });
  });
});
