import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteProjectFile,
  loadManifest,
  resolveProjectPath,
  validateArtifactPathParts,
  writeProjectFile
} from '../src/file-system.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cleanups: string[] = [];

interface TestManifest {
  project: {
    frontend: unknown;
  };
  artifacts: Array<{
    logicalName: string;
    pathParts: string[];
    contentHash: string;
  }>;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function fixtureManifest(): Promise<TestManifest> {
  return JSON.parse(await readFile(path.join(fixturesDir, 'manifest-v2.json'), 'utf8')) as TestManifest;
}

async function manifestRoot(mutate?: (manifest: TestManifest) => void): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-'));
  cleanups.push(root);
  const manifest = await fixtureManifest();
  mutate?.(manifest);
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

describe('manifest validation', () => {
  it('loads the supported frozen manifest', async () => {
    const root = await manifestRoot();
    const manifest = await loadManifest(root);
    expect(manifest.project.projectType).toBe('genai');
    expect(manifest.artifacts.length).toBeGreaterThan(0);
  });

  it.each<Array<[string[], string]>>([
    [['..', 'outside.txt'], 'unsafe path part'],
    [['/tmp'], 'unsafe path part'],
    [['C:', 'outside.txt'], 'unsafe path part'],
    [['\\\\server\\share'], 'unsafe path part'],
    [['nested/file.txt'], 'unsafe path part'],
    [['nested\\file.txt'], 'unsafe path part'],
    [[''], 'non-empty string']
  ])('rejects unsafe path parts %j', async (pathParts, message) => {
    const root = await manifestRoot((manifest) => {
      manifest.artifacts[0].pathParts = pathParts;
    });
    await expect(loadManifest(root)).rejects.toThrow(message);
  });

  it('rejects malformed project and artifact fields with field-specific errors', async () => {
    const invalidFrontend = await manifestRoot((manifest) => {
      manifest.project.frontend = 'false';
    });
    await expect(loadManifest(invalidFrontend)).rejects.toThrow('Manifest.project.frontend must be a boolean');

    const invalidHash = await manifestRoot((manifest) => {
      manifest.artifacts[0].contentHash = 'not-a-hash';
    });
    await expect(loadManifest(invalidHash)).rejects.toThrow('contentHash must be a sha256-prefixed');
  });

  it('rejects duplicate logical names and paths', async () => {
    const duplicateName = await manifestRoot((manifest) => {
      manifest.artifacts[1].logicalName = manifest.artifacts[0].logicalName;
    });
    await expect(loadManifest(duplicateName)).rejects.toThrow('duplicate logicalName');

    const duplicatePath = await manifestRoot((manifest) => {
      manifest.artifacts[1].pathParts = manifest.artifacts[0].pathParts;
    });
    await expect(loadManifest(duplicatePath)).rejects.toThrow('duplicate artifact path');
  });
});

describe('project-confined paths', () => {
  it('accepts portable path parts and resolves them below the project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-path-'));
    cleanups.push(root);
    expect(validateArtifactPathParts(['backend', 'apis', 'main.py'])).toEqual(['backend', 'apis', 'main.py']);
    expect(await resolveProjectPath(root, ['backend', 'apis', 'main.py']))
      .toBe(path.join(root, 'backend', 'apis', 'main.py'));
  });

  it('rejects symlinks that leave the project before reads or mutations', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-symlink-'));
    cleanups.push(parent);
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'keep\n', 'utf8');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveProjectPath(root, ['linked', 'sentinel.txt'])).rejects.toThrow('escapes project root');
    await expect(writeProjectFile(root, ['linked', 'sentinel.txt'], 'replace\n')).rejects.toThrow('escapes project root');
    await expect(deleteProjectFile(root, ['linked', 'sentinel.txt'])).rejects.toThrow('escapes project root');
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  });

  it('allows a symlink whose resolved target remains inside the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-internal-symlink-'));
    cleanups.push(root);
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFile(root, ['linked', 'file.txt'], 'content\n');
    await access(path.join(root, 'real', 'file.txt'));
  });

  it('atomically replaces a project file without leaving temporary artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-atomic-write-'));
    cleanups.push(root);
    await writeProjectFile(root, ['README.md'], 'first\n');
    await writeProjectFile(root, ['README.md'], 'second\n');
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('second\n');
    expect((await readdir(root)).filter((name) => name.includes('.liftoff-'))).toEqual([]);
  });
});
