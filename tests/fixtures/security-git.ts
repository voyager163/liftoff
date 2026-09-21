import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixtureGitEnvironment, fixtureGitOptions } from '../../scripts/repository-security/gitleaks.ts';
import { portableParts } from '../../scripts/repository-security/evidence.ts';

const execute = promisify(execFile);

export async function createAdmissionGitFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-admission-fixture ')));
  await chmod(root, 0o700);
  const owner = randomUUID();
  const repo = path.join(root, 'repository');
  for (const directory of ['repository', 'home', 'empty-directory', 'wrapper']) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, '.fixture-owner'), owner, { mode: 0o600 });
  await writeFile(path.join(root, 'empty'), '', { mode: 0o600 });
  const env = { ...fixtureGitEnvironment(root, path.join(root, 'wrapper')), PATH: process.env.PATH };
  const paths = new Map<string, string[]>();
  let closed = false;
  async function git(args: string[]) {
    if (closed) throw new Error('Fixture is closed.');
    const result = await execute('git', [...fixtureGitOptions(root), ...args], {
      cwd: repo, env, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8'
    });
    return result.stdout.trim();
  }
  await git(['init', '--quiet', '--initial-branch=fixture']);
  return {
    root: repo,
    async commit(files: Readonly<Record<string, string>>) {
      const next = new Map(Object.entries(files).map(([name, content]) => {
        const parts = portableParts(name.split('/'));
        if (parts.some(part => part.toLowerCase() === '.git')) throw new Error('Reserved fixture path.');
        return [parts.join('/'), { parts, content }] as const;
      }));
      if (next.size === 0 || next.size > 100) throw new Error('Invalid fixture inventory.');
      for (const [name, parts] of paths) {
        if (!next.has(name)) {
          await unlink(path.join(repo, ...parts));
          await git(['add', '--', name]);
          paths.delete(name);
        }
      }
      for (const [name, entry] of next) {
        await mkdir(path.dirname(path.join(repo, ...entry.parts)), { recursive: true });
        await writeFile(path.join(repo, ...entry.parts), entry.content, { mode: 0o600 });
        paths.set(name, entry.parts);
        await git(['add', '--', name]);
      }
      await git(['commit', '--quiet', '--no-gpg-sign', '--no-verify', '--allow-empty', '-m', 'Synthetic admission fixture']);
      return git(['rev-parse', 'HEAD']);
    },
    async executable(parts: string[]) {
      const name = portableParts(parts).join('/');
      if (!paths.has(name)) throw new Error('Unknown fixture path.');
      await git(['update-index', '--chmod=+x', '--', name]);
      await git(['commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', 'Synthetic mode fixture']);
      return git(['rev-parse', 'HEAD']);
    },
    async symlinkEntry(parts: string[]) {
      const name = portableParts(parts).join('/');
      if (!paths.has(name)) throw new Error('Unknown fixture path.');
      const object = await git(['hash-object', '--', name]);
      await git(['update-index', '--cacheinfo', '120000', object, name]);
      await git(['commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', 'Synthetic Git-link fixture']);
      return git(['rev-parse', 'HEAD']);
    },
    async cleanup() {
      if (closed) throw new Error('Fixture is closed.');
      const status = await lstat(root), marker = await lstat(path.join(root, '.fixture-owner'));
      if (!status.isDirectory() || status.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() ||
          await realpath(root) !== root || await readFile(path.join(root, '.fixture-owner'), 'utf8') !== owner) {
        throw new Error('Fixture ownership changed; cleanup refused.');
      }
      await rm(root, { recursive: true });
      closed = true;
    }
  };
}
