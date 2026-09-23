import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { recordArtifact, releaseContext, verifyArtifact } from '../scripts/release-artifact.mjs';

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', [
    '-c', 'user.name=Release fixture', '-c', 'user.email=release-fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args
  ], { cwd: root, encoding: 'utf8', shell: false, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Fixture git failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

async function fixture(version = '1.2.3') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff release fixture '));
  fixtures.push(root);
  git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@msn-control/liftoff', version }));
  git(root, 'add', 'package.json');
  git(root, 'commit', '-m', 'Create isolated release fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', commit);
  git(root, 'tag', `v${version}`);
  const env = {
    GITHUB_REPOSITORY: 'voyager163/liftoff', GITHUB_SHA: commit, GITHUB_RUN_ID: '12345',
    GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF: `refs/tags/v${version}`
  };
  return { root, env };
}

describe('qualified release artifacts', () => {
  it('packs once through npm and rejects publication verification from a manual event', async () => {
    const { root, env } = await fixture();
    const directory = path.join(root, 'packed artifact');
    const output = path.join(root, 'qualification-output.txt');
    const script = path.join(process.cwd(), 'scripts', 'release-artifact.mjs');
    const result = spawnSync(process.execPath, [script, 'pack', directory], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 30_000,
      env: { ...process.env, ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output }
    });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
    expect(record.tag).toBeNull();
    expect(await readFile(output, 'utf8')).toContain(`sha256=${record.sha256}`);
    const denied = spawnSync(process.execPath, [script, 'verify', directory], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 30_000,
      env: { ...process.env, ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA256: record.sha256 }
    });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('Only tag pushes');
  });

  it('binds the artifact to its identity, commit, workflow run and digest on paths with spaces', async () => {
    const { root, env } = await fixture();
    const context = await releaseContext(root, env);
    const directory = path.join(root, 'qualified artifact');
    await mkdir(directory);
    await writeFile(path.join(directory, context.filename), 'qualified package bytes');
    const record = await recordArtifact(directory, context);
    await expect(verifyArtifact(directory, context, record.sha256)).resolves.toEqual(record);
    expect(context.distTag).toBe('latest');
    expect(context.tag).toBe('v1.2.3');

    for (const [key, value] of [
      ['repository', 'fork/liftoff'], ['commit', 'a'.repeat(40)], ['runId', '999'],
      ['version', '9.9.9'], ['filename', '../outside.tgz'], ['name', '@other/package'],
      ['distTag', 'next'], ['schemaVersion', 2]
    ]) {
      await writeFile(path.join(directory, 'release.json'), JSON.stringify({ ...record, [key]: value }));
      await expect(verifyArtifact(directory, context, record.sha256)).rejects.toThrow('mismatch');
    }
    await writeFile(path.join(directory, 'release.json'), JSON.stringify(record));
    await expect(verifyArtifact(directory, context, undefined)).rejects.toThrow('Expected digest');
    await expect(verifyArtifact(directory, context, '0'.repeat(64))).rejects.toThrow('differs from qualification');
    await writeFile(path.join(directory, context.filename), 'changed package bytes');
    await expect(verifyArtifact(directory, context, record.sha256)).rejects.toThrow('tarball digest mismatch');
    await rm(path.join(directory, context.filename));
    await expect(verifyArtifact(directory, context, record.sha256)).rejects.toThrow('ENOENT');
  });

  it('preserves prerelease selection and allows manual verification without allowing manual publishing', async () => {
    const { root, env } = await fixture('1.2.3-rc.1');
    expect((await releaseContext(root, env)).distTag).toBe('next');
    const manual = { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/develop' };
    expect((await releaseContext(root, manual, { allowDispatch: true })).tag).toBeNull();
    await expect(releaseContext(root, manual)).rejects.toThrow('Only tag pushes');
  });

  it('rejects fork, PR, branch, wrong version, wrong checkout and missing run identities', async () => {
    const { root, env } = await fixture();
    for (const [key, value] of [
      ['GITHUB_REPOSITORY', 'fork/liftoff'], ['GITHUB_EVENT_NAME', 'pull_request'],
      ['GITHUB_REF_TYPE', 'branch'], ['GITHUB_REF', 'refs/tags/v9.9.9'],
      ['GITHUB_SHA', 'a'.repeat(40)], ['GITHUB_RUN_ID', '']
    ]) {
      await expect(releaseContext(root, { ...env, [key]: value })).rejects.toThrow();
    }
  });

  it('rejects a tag outside main history and a moved tag', async () => {
    const { root, env } = await fixture();
    git(root, 'checkout', '-b', 'unpromoted');
    await writeFile(path.join(root, 'unpromoted.txt'), 'fixture');
    git(root, 'add', 'unpromoted.txt');
    git(root, 'commit', '-m', 'Unpromoted fixture revision');
    const newer = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', '-f', 'v1.2.3');
    await expect(releaseContext(root, { ...env, GITHUB_SHA: newer })).rejects.toThrow('merge-base');
    git(root, 'checkout', env.GITHUB_SHA);
    await expect(releaseContext(root, env)).rejects.toThrow('no longer identifies');
  });

  it('rejects a consistently renamed package', async () => {
    const { root, env } = await fixture();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@other/liftoff', version: '1.2.3' }));
    await expect(releaseContext(root, env)).rejects.toThrow('canonical');
  });

  it('preserves ancestry through a checked sync-branch route when main and develop diverge', async () => {
    const { root } = await fixture();
    git(root, 'checkout', '-b', 'develop');
    await writeFile(path.join(root, 'feature.txt'), 'feature');
    git(root, 'add', 'feature.txt');
    git(root, 'commit', '-m', 'Feature fixture');
    git(root, 'checkout', 'main');
    git(root, 'merge', '--no-ff', 'develop', '-m', 'Promotion fixture');
    const main = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', 'develop');
    await writeFile(path.join(root, 'next.txt'), 'next feature');
    git(root, 'add', 'next.txt');
    git(root, 'commit', '-m', 'Next feature fixture');
    const develop = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-b', 'sync/main');
    git(root, 'merge', '--no-ff', 'main', '-m', 'Sync main fixture');
    expect(git(root, 'merge-base', '--is-ancestor', main, 'HEAD')).toBe('');
    expect(git(root, 'merge-base', '--is-ancestor', develop, 'HEAD')).toBe('');
    git(root, 'checkout', 'develop');
    git(root, 'merge', '--no-ff', 'sync/main', '-m', 'Merge reviewed sync fixture');
    git(root, 'checkout', 'main');
    git(root, 'merge', '--no-ff', 'develop', '-m', 'Next promotion fixture');
    expect(await readFile(path.join(root, 'next.txt'), 'utf8')).toBe('next feature');
  });
});
