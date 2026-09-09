import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoot, loadManifest } from '../src/file-system.js';

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
