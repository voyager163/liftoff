import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { parseMacMigration } from '../src/cli/mac-migration.js';
import { discoverMacNpmSelections, macMigrationHash } from '../src/adapters/distribution/mac-npm-owner.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.cleanup();
});

async function fixture() {
  const value = await macMigrationFixture(); fixtures.push(value); return value;
}

async function handover(value: Fixture) {
  const preview = await runMacMigration(value.request, value.dependencies);
  expect(preview).toMatchObject({ status: 'ready', effects: 'none', blockers: [] });
  const journalRoot = path.join(value.root, 'selected journal');
  const report = await runMacMigration({ ...value.request,
    apply: { review: preview.review!, journalRoot } }, value.dependencies);
  expect(report.journal).toBeDefined();
  return { report, journalRoot };
}

async function selectedJournal(root: string) {
  return { journalRoot: root, journalSha256: macMigrationHash(await readFile(path.join(root, 'journal.json'))) };
}

describe.skipIf(process.platform === 'win32')('bounded migration discovery and selected repeat inspection', () => {
  it.each(['missing-node', 'broken-npm', 'launcher-only'] as const)(
    'does not silently drop an unproven PATH owner: %s', async kind => {
      const value = await fixture();
      await symlink(value.npm, path.join(value.prefix, 'bin/npm'));
      const incomplete = path.join(value.root, 'incomplete owner/bin');
      await mkdir(incomplete, { recursive: true });
      if (kind === 'launcher-only') await writeFile(path.join(incomplete, 'liftoff'), 'unproven old executable');
      else await symlink(kind === 'broken-npm' ? path.join(value.root, 'absent npm') : value.npm, path.join(incomplete, 'npm'));
      value.dependencies.upgrade.environment.PATH = `${path.join(value.prefix, 'bin')}:${incomplete}`;
      const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
      await expect(discoverMacNpmSelections(value.dependencies.upgrade.environment))
        .rejects.toMatchObject({ code: 'unproven-path-owner' });
      const automatic = await runMacMigration({ brew: value.request.brew, recovery: value.recovery }, value.dependencies);
      expect(automatic).toMatchObject({ status: 'blocked', effects: 'none', blockers: ['unproven-path-owner'] });
      expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
      expect((await runMacMigration(value.request, value.dependencies)).status).toBe('ready');
      expect(await migrationAbsent(value.oldPackage)).toBe(false);
    });

  it('reobserves a completed cask without repeating removal, installation or journal writes', async () => {
    const value = await fixture();
    const { report: applied, journalRoot } = await handover(value);
    expect(applied.status).toBe('installed');
    const before = await captureMigrationTree(journalRoot);
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    const install = vi.spyOn(value.dependencies.cask!, 'installExact');
    const report = await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies);
    expect(report).toMatchObject({ mode: 'inspect', status: 'installed', effects: 'none', blockers: [],
      observedPhase: 'verified', verification: { owner: 'homebrew-cask', assets: 'verified', path: 'selected' } });
    expect(report.review).toBeUndefined();
    expect(report.journal).toEqual(applied.journal);
    expect(install).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
    expect(await captureMigrationTree(journalRoot)).toEqual(before);
    expect(await migrationAbsent(path.join(journalRoot, 'lock'))).toBe(true);
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
  });

  it('reports actual current PATH selection on a repeated completed observation', async () => {
    const value = await fixture();
    const { journalRoot } = await handover(value);
    const foreign = path.join(value.root, 'foreign bin');
    await mkdir(foreign);
    await writeFile(path.join(foreign, 'liftoff'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    value.dependencies.upgrade.environment.PATH = `${foreign}:${value.brewPrefix}/bin`;
    expect(await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies))
      .toMatchObject({ status: 'installed', effects: 'none', verification: { path: 'unresolved', parentShell: 'not-observable' } });
  });

  it('does not require the removed npm toolchain to inspect the independent cask', async () => {
    const value = await fixture();
    const { journalRoot } = await handover(value);
    await unlink(value.node); await unlink(value.npm);
    expect(await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies))
      .toMatchObject({ status: 'installed', effects: 'none', blockers: [], observedPhase: 'verified' });
  });

  it('rechecks a settled cask after interrupted verification without adopting or rewriting its checkpoint', async () => {
    const value = await fixture();
    const observe = value.dependencies.cask!.installed;
    value.dependencies.cask!.installed = async () => { throw new Error('isolated verification interrupted'); };
    const { report, journalRoot } = await handover(value);
    expect(report.status).toBe('partial');
    value.dependencies.cask!.installed = observe;
    const before = await captureMigrationTree(journalRoot);
    expect(await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies))
      .toMatchObject({ status: 'installed', effects: 'none', blockers: [], observedPhase: 'cask-settled' });
    expect(await captureMigrationTree(journalRoot)).toEqual(before);
  });

  it.each(['version', 'launcher', 'old-copy', 'policy'] as const)(
    'does not repeat stale installed success when %s changes', async change => {
      const value = await fixture();
      const { journalRoot } = await handover(value);
      if (change === 'version') await writeFile(path.join(value.source, 'application/dist/cli.js'), 'console.log("Liftoff 9.9.9");\n');
      if (change === 'launcher') {
        await unlink(path.join(value.brewPrefix, 'bin/liftoff'));
        await writeFile(path.join(value.brewPrefix, 'bin/liftoff'), 'new user launcher');
      }
      if (change === 'old-copy') {
        await mkdir(value.oldPackage); await writeFile(path.join(value.oldPackage, 'new-user-material'), 'preserve');
      }
      if (change === 'policy') value.dependencies.cask!.policy.homebrew.cask = 'different/tools/liftoff';
      const before = await captureMigrationTree(journalRoot);
      const install = vi.spyOn(value.dependencies.cask!, 'installExact');
      const result = await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies);
      expect(result).toMatchObject({ mode: 'inspect', effects: 'none', status: 'partial', observedPhase: 'verified' });
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.verification).toBeUndefined();
      expect(install).not.toHaveBeenCalled();
      expect(await captureMigrationTree(journalRoot)).toEqual(before);
      if (change === 'old-copy') expect(await readFile(path.join(value.oldPackage, 'new-user-material'), 'utf8')).toBe('preserve');
      if (change === 'launcher') expect(await readFile(path.join(value.brewPrefix, 'bin/liftoff'), 'utf8')).toBe('new user launcher');
    });

  it('observes restored old scope without replaying restoration or retagging the journal', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    const { journalRoot } = await handover(value);
    expect((await runMacMigration({ recover: await selectedJournal(journalRoot) }, value.dependencies)).status).toBe('restored');
    const before = await captureMigrationTree(journalRoot);
    const old = await captureMigrationTree(value.oldPackage);
    const link = await readlink(value.oldLauncher);
    const result = await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies);
    expect(result).toMatchObject({ mode: 'inspect', status: 'restored', effects: 'none', blockers: [], observedPhase: 'restored' });
    expect(await captureMigrationTree(journalRoot)).toEqual(before);
    expect(await captureMigrationTree(value.oldPackage)).toEqual(old);
    expect(await readlink(value.oldLauncher)).toBe(link);
  });

  it.each(['replacement', 'during-version'] as const)(
    'refuses changed restored entries during repeat inspection: %s', async change => {
      const value = await fixture();
      value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
      const { journalRoot } = await handover(value);
      expect((await runMacMigration({ recover: await selectedJournal(journalRoot) }, value.dependencies)).status).toBe('restored');
      const before = await captureMigrationTree(journalRoot);
      const file = path.join(value.oldPackage, 'dist/dependency.js');
      if (change === 'replacement') {
        const bytes = await readFile(file); await unlink(file); await writeFile(file, bytes);
      } else {
        const run = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
        vi.spyOn(value.dependencies.upgrade.runner, 'run').mockImplementation(async (command, options) => {
          const result = await run(command, options);
          if (command.args[0] === path.join(value.oldPackage, 'dist/cli.js')) {
            await writeFile(file, 'concurrent user edit\n');
          }
          return result;
        });
      }
      const report = await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies);
      expect(report).toMatchObject({ status: 'partial', effects: 'none', observedPhase: 'restored' });
      expect(report.blockers).toContain(change === 'replacement' ? 'restored-entry-changed' : 'restore-version-verification-failed');
      expect(await captureMigrationTree(journalRoot)).toEqual(before);
      if (change === 'during-version') expect(await readFile(file, 'utf8')).toBe('concurrent user edit\n');
    });

  it('does not commit restored success if the old version probe changes restored material', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    const { journalRoot } = await handover(value);
    const run = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
    const file = path.join(value.oldPackage, 'dist/dependency.js');
    vi.spyOn(value.dependencies.upgrade.runner, 'run').mockImplementation(async (command, options) => {
      const result = await run(command, options);
      if (command.args[0] === path.join(value.oldPackage, 'dist/cli.js')) await writeFile(file, 'concurrent user edit\n');
      return result;
    });
    expect(await runMacMigration({ recover: await selectedJournal(journalRoot) }, value.dependencies))
      .toMatchObject({ status: 'partial', blockers: ['restore-version-verification-failed'] });
    expect(JSON.parse((await readFile(path.join(journalRoot, 'journal.json'))).toString()).journal.phase).toBe('restore-intent');
    expect(await readFile(file, 'utf8')).toBe('concurrent user edit\n');
  });

  it.each(['absent-provider', 'stale-digest', 'changed-key', 'concurrent-lock'] as const)(
    'keeps selected inspection fail-closed: %s', async change => {
      const value = await fixture();
      const { journalRoot } = await handover(value);
      const selected = await selectedJournal(journalRoot);
      const preparation = vi.fn();
      value.dependencies.preparation = { preview: preparation };
      if (change === 'absent-provider') delete value.dependencies.cask;
      if (change === 'stale-digest') selected.journalSha256 = 'a'.repeat(64);
      if (change === 'changed-key') await writeFile(path.join(journalRoot, 'authority.key'), Buffer.alloc(32, 0));
      if (change === 'concurrent-lock') {
        const observe = value.dependencies.cask!.installed;
        value.dependencies.cask!.installed = async (...args) => {
          await mkdir(path.join(journalRoot, 'lock'), { mode: 0o700 });
          return observe(...args);
        };
      }
      const journal = await readFile(path.join(journalRoot, 'journal.json'));
      const result = await runMacMigration({ inspect: selected }, value.dependencies);
      expect(result.effects).toBe('none');
      expect(result.status).not.toBe('installed');
      expect(result.verification).toBeUndefined();
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(await readFile(path.join(journalRoot, 'journal.json'))).toEqual(journal);
      expect(preparation).not.toHaveBeenCalled();
      if (change === 'concurrent-lock') expect(await migrationAbsent(path.join(journalRoot, 'lock'))).toBe(false);
    });

  it('never turns uncertain settlement into current state or releases the retained lock', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: false, installed: false });
    const { journalRoot } = await handover(value);
    const before = await captureMigrationTree(journalRoot);
    const installed = vi.spyOn(value.dependencies.cask!, 'installed');
    expect(await runMacMigration({ inspect: await selectedJournal(journalRoot) }, value.dependencies))
      .toMatchObject({ mode: 'inspect', status: 'partial', effects: 'none', observedPhase: 'uncertain',
        blockers: ['operation-settlement-unproven'] });
    expect(installed).not.toHaveBeenCalled();
    expect(await captureMigrationTree(journalRoot)).toEqual(before);
    expect(await readdir(path.join(journalRoot, 'lock'))).toEqual(['owner.json']);
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
  });
});

it('selects read-only journal inspection explicitly and rejects mixed effect authority', () => {
  const journalRoot = path.resolve('private journal');
  expect(parseMacMigration(['--inspect', 'a'.repeat(64), '--journal', journalRoot]))
    .toEqual({ inspect: { journalRoot, journalSha256: 'a'.repeat(64) } });
  for (const args of [
    ['--inspect', 'a'.repeat(64)], ['--inspect', 'latest', '--journal', journalRoot],
    ['--inspect', 'a'.repeat(64), '--journal', journalRoot, '--dead-lock', 'b'.repeat(64)],
    ['--inspect', 'a'.repeat(64), '--journal', journalRoot, '--apply', 'b'.repeat(64)],
    ['--inspect', 'a'.repeat(64), '--journal', journalRoot, '--recover', 'b'.repeat(64)],
    ['--inspect', 'a'.repeat(64), '--journal', journalRoot, '--brew', '/brew']
  ]) expect(() => parseMacMigration(args)).toThrow();
});
