import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { macMigrationPackageArguments, packageMacMigration } from '../scripts/mac-migration-package.mjs';
import { bundleInventory } from '../scripts/native-bundle-contract.mjs';
import { NodeCommandRunner } from '../src/process-runner.js';
import { migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('independent migration development packaging', () => {
  it('requires exact local inputs and never an installation or publishing command', () => {
    const bundle = path.resolve('private native'); const output = path.resolve('private utility');
    expect(macMigrationPackageArguments(['--bundle', bundle, '--output', output])).toEqual({ bundle, output });
    for (const args of [[], ['--bundle', '/b'], ['--bundle', '/b', '--bundle', '/c'],
      ['--bundle', 'relative', '--output', '/out'], ['--install', '/b', '--output', '/out']]) {
      expect(() => macMigrationPackageArguments(args)).toThrow();
    }
  });
  it('refuses unverified bundle input before output creation', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf migration package '))); roots.push(root);
    await expect(packageMacMigration({ bundle: root, output: path.join(root, 'utility') })).rejects.toThrow();
  });
});

const selected = process.env.LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT;
describe.skipIf(!selected || process.platform !== 'darwin' || process.arch !== 'arm64')('actual independent development package', () => {
  it('preserves the full licensed/runtime/asset inventory and runs direct/linked help without external Node/npm', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf standalone installed spaces '))); roots.push(root);
    const result = await packageMacMigration({ bundle: selected!, output: path.join(root, 'standalone utility') });
    expect(result.releaseReady).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(result.output, 'migration.json'), 'utf8'));
    expect(manifest).toMatchObject({ schemaVersion: 1, releaseReady: false, publicMigrationQualified: false });
    expect(await bundleInventory(path.join(result.output, 'core'))).toEqual(await bundleInventory(selected!));
    const launcher = path.join(result.output, 'bin/liftoff-migrate-npm');
    const linked = path.join(root, 'linked utility'); await symlink(launcher, linked);
    const runner = new NodeCommandRunner();
    for (const executable of [launcher, linked]) {
      const invocation = await runner.run({ executable, args: ['--help'] }, {
        cwd: root, env: { PATH: '', HOME: root, NODE_OPTIONS: '--require=/foreign/override' }, timeoutMs: 30_000
      });
      expect(invocation.status).toBe(0);
      expect(invocation.stdout).toContain('SOURCE ONLY'); expect(invocation.stdout).toContain('Public apply remains blocked');
    }
    await chmod(path.join(result.output, 'core/runtime/node'), 0o644);
    expect((await runner.run({ executable: launcher, args: ['--help'] }, { cwd: root, env: { PATH: '' } })).status).not.toBe(0);
  });
  it('refuses existing/checkout outputs rather than overwriting them', async () => {
    await expect(packageMacMigration({ bundle: selected!, output: selected! })).rejects.toThrow();
    await expect(packageMacMigration({ bundle: selected!, output: path.resolve('migration-output') })).rejects.toThrow();
  });
  it('the real standalone entrypoint refuses unqualified apply on an isolated old npm fixture', async () => {
    const value = await macMigrationFixture();
    try {
      const packaged = await packageMacMigration({ bundle: selected!, output: path.join(value.root, 'standalone utility') });
      const result = await new NodeCommandRunner().run({
        executable: path.join(packaged.output, 'bin/liftoff-migrate-npm'),
        args: ['--npm', value.npm, '--node', value.node,
          '--prefix', value.prefix, '--manager', 'custom', '--brew', value.request.brew!,
          '--recovery', value.recovery, '--apply', 'a'.repeat(64), '--journal', path.join(value.root, 'never-created')]
      }, { cwd: value.root, env: { PATH: '', HOME: value.root }, timeoutMs: 30_000, ensureProcessTreeSettled: true });
      expect(result.status).toBe(1);
      expect(result.stdout, result.stderr).not.toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', effects: 'none',
        blockers: expect.arrayContaining(['native-cask-provider-unqualified']) });
      expect(await migrationAbsent(value.oldPackage)).toBe(false);
      expect(await migrationAbsent(path.join(value.root, 'never-created'))).toBe(true);
    } finally { await value.cleanup(); }
  });
});
