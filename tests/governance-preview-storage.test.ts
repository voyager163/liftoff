import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
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
