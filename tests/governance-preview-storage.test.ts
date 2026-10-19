import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { parseArgs } from '../src/cli/args/parser.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-governance-preview-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const home = path.join(root, 'private-home');
  await mkdir(project, { mode: 0o700 });
  await mkdir(path.join(project, '.git'), { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const options = { homedir: home, env: {} };
  return { root, project, options, store: createScopedUserLocalRecordStore(project, 'governance-preview', options) };
}

describe('project-bound governance preview storage', () => {
  it('stores private metadata outside the repository and separates preview from authority', async () => {
    const { project, options, store } = await fixture();
    const value = { schemaVersion: 1, kind: 'preview', operations: [] };
    const key = canonicalSha256(value);
    const saved = await store.write(key, value);
    expect(path.relative(project, saved.path).startsWith('..')).toBe(true);
    expect((await store.read(key))?.value).toEqual(value);
    expect(await createScopedUserLocalRecordStore(project, 'governance-approval', options).read(key)).toBeNull();
    if (process.platform !== 'win32') {
      expect((await lstat(saved.path)).mode & 0o077).toBe(0);
    }
    await expect(store.write(key, { different: true })).rejects.toThrow(/Refusing to replace/);
    expect((await store.read(key))?.value).toEqual(value);
  });

  it('does not let a fingerprint select another project or an arbitrary path', async () => {
    const { root, store, options } = await fixture();
    const key = canonicalSha256('same-fingerprint');
    await store.write(key, { project: 'first' });
    const other = path.join(root, 'other');
    await mkdir(other, { mode: 0o700 });
    expect(await createScopedUserLocalRecordStore(other, 'governance-preview', options).read(key)).toBeNull();
    await expect(store.read('../outside.json')).rejects.toThrow(/SHA-256/);
    await expect(store.write(key, { huge: 'x'.repeat(65 * 1024) })).rejects.toThrow();
  });

  it('rejects substituted symlinks without changing the target', async () => {
    const { store } = await fixture();
    const key = canonicalSha256('symlink');
    const saved = await store.write(key, { original: true });
    const target = await store.write(canonicalSha256('target'), { unrelated: true });
    const bytes = await readFile(target.path);
    await unlink(saved.path);
    await symlink(target.path, saved.path);
    await expect(store.read(key)).rejects.toThrow(/singly linked regular file/);
    await expect(store.write(key, { replacement: true })).rejects.toThrow(/singly linked regular file/);
    expect(await readFile(target.path)).toEqual(bytes);
  });

  it('rereads actual private directories and record bytes without changing them', async () => {
    const { project, options, store } = await fixture();
    const key = canonicalSha256('native-directory-readback'), value = { original: true };
    const saved = await store.write(key, value), bytes = await readFile(saved.path);
    const calls: string[] = [];
    const reader = createScopedUserLocalRecordStore(project, 'governance-preview', {
      ...options, fileSystem: { ...nodeUpdatePreviewFileSystem, lstat: async target => {
        calls.push(target);
        return lstat(target);
      } }
    });
    expect((await reader.read(key))?.value).toEqual(value);
    expect(calls.filter(target => target === path.dirname(saved.path)).length).toBeGreaterThan(1);
    expect(await readFile(saved.path)).toEqual(bytes);
  });

  it('refuses actual ancestor replacement during readback and preserves the original private record', async () => {
    const { root, project, options, store } = await fixture();
    const key = canonicalSha256('native-directory-replacement');
    const saved = await store.write(key, { original: true }), bytes = await readFile(saved.path);
    const home = await realpath(options.homedir), retained = path.join(root, 'retained-private-home');
    const originalInode = (await lstat(home)).ino;
    let armed = false, replaced = false, opened = false;
    const reader = createScopedUserLocalRecordStore(project, 'governance-preview', {
      ...options, fileSystem: { ...nodeUpdatePreviewFileSystem,
        realpath: async target => {
          const resolved = await realpath(target);
          if (target === path.dirname(saved.path)) armed = true;
          return resolved;
        },
        lstat: async target => {
          if (armed && target === home && !replaced) {
            replaced = true;
            await rename(home, retained);
            await mkdir(home, { mode: 0o700 });
            expect((await lstat(home)).ino).not.toBe(originalInode);
          }
          return lstat(target);
        },
        openFile: async (...args) => { opened = true; return nodeUpdatePreviewFileSystem.openFile(...args); }
      }
    });
    await expect(reader.read(key)).rejects.toThrow(/directory changed during the operation/u);
    expect(replaced).toBe(true);
    expect(opened).toBe(false);
    expect(await readFile(path.join(retained, path.relative(home, saved.path)))).toEqual(bytes);
  });

  it.skipIf(process.platform === 'win32')('refuses actual private permission drift during directory readback', async () => {
    const { project, options, store } = await fixture();
    const key = canonicalSha256('native-directory-permissions');
    const saved = await store.write(key, { original: true }), bytes = await readFile(saved.path);
    const privateRoot = path.dirname(path.dirname(saved.path));
    let armed = false, changed = false;
    const reader = createScopedUserLocalRecordStore(project, 'governance-preview', {
      ...options, fileSystem: { ...nodeUpdatePreviewFileSystem,
        realpath: async target => {
          const resolved = await realpath(target);
          if (target === path.dirname(saved.path)) armed = true;
          return resolved;
        },
        lstat: async target => {
          if (armed && target === privateRoot && !changed) {
            changed = true;
            await chmod(target, 0o755);
          }
          return lstat(target);
        }
      }
    });
    await expect(reader.read(key)).rejects.toThrow(/permissions changed during the operation/u);
    expect(changed).toBe(true);
    expect(await readFile(saved.path)).toEqual(bytes);
  });
});

describe('strict v3 governance command grammar', () => {
  const fingerprint = 'a'.repeat(64);
  it.each(['local', 'activation', 'lifecycle'])('accepts a separately selected %s scope', (scope) => {
    expect(parseArgs(['governance', 'plan', '--scope', scope, '--json']).flags.scope).toBe(scope);
  });
  it('requires an exact preview for approval, enrollment, and recovery', () => {
    for (const command of ['approve', 'credential-enroll', 'recover']) {
      expect(() => parseArgs(['governance', command])).toThrow(/requires --plan/);
      expect(parseArgs(['governance', command, '--plan', fingerprint]).flags.plan).toBe(fingerprint);
    }
    expect(parseArgs(['governance', 'credential-enroll', '--plan', fingerprint, '--protected-stdin']).flags['protected-stdin']).toBe(true);
    expect(parseArgs(['governance', 'plan', '--recover-phase', 'provider-ready']).flags['recover-phase']).toBe('provider-ready');
  });
  it.each([
    ['governance', 'status', '--execute'],
    ['governance', 'approve', '--plan', fingerprint, '--execute'],
    ['governance', 'verify', '--protected-stdin'],
    ['governance', 'plan', '--scope', 'all'],
    ['governance', 'recover', '--plan', 'short'],
    ['governance', 'assess', '--scope', 'activation'],
    ['governance', 'plan', '--recover-phase', 'unrecognized'],
    ['governance', 'plan', 'one', '--project', 'two']
  ])('rejects invalid invocation %j before effects', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
});
