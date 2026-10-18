import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, MacMigrationJournalStore } from '../src/adapters/distribution/mac-migration-state.js';
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

async function apply(value: Fixture) {
  const preview = await runMacMigration(value.request, value.dependencies);
  expect(preview.status).toBe('ready');
  return runMacMigration({ ...value.request,
    apply: { review: preview.review!, journalRoot: path.join(value.root, 'private journal') } }, value.dependencies);
}

describe.skipIf(process.platform === 'win32')('migration independent installed-byte verification', () => {
  it('does not spoof the utility runtime or invoke an installed inventory helper', async () => {
    const value = await fixture();
    const runtime = value.dependencies.upgrade.execPath;
    const executable = value.dependencies.upgrade.runningExecutable;
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    const owner = vi.spyOn(value.dependencies.cask!, 'installed');
    expect(await apply(value)).toMatchObject({ status: 'installed', blockers: [] });
    expect(value.dependencies.upgrade.execPath).toBe(runtime);
    expect(value.dependencies.upgrade.runningExecutable).toBe(executable);
    const probes = run.mock.calls.filter(([command]) =>
      command.executable === path.join(value.source, 'runtime/node') ||
      command.executable === path.join(value.brewPrefix, 'bin/liftoff'));
    expect(probes).toHaveLength(2);
    expect(probes.every(([command]) => command.args.includes('--version'))).toBe(true);
    expect(run.mock.calls.some(([command]) => command.args.includes('liftoff-native-owner-probe'))).toBe(false);
    expect(owner).toHaveBeenCalledTimes(2);
  });

  it.each(['asset', 'extra', 'claimed-runtime'] as const)(
    'retains settled partial state and executes no target runtime when %s is unproven', async change => {
      const value = await fixture();
      const install = value.dependencies.cask!.installExact;
      value.dependencies.cask!.installExact = async (...args) => {
        const installed = await install(...args);
        if (change === 'asset') await writeFile(path.join(value.source, 'application/changed-asset'), 'unexpected asset');
        if (change === 'extra') await writeFile(path.join(value.source, 'installation/untracked-helper.mjs'), 'unexpected helper');
        return installed;
      };
      if (change === 'claimed-runtime') {
        const observe = value.dependencies.cask!.installed;
        value.dependencies.cask!.installed = async (...args) => {
          const result = await observe(...args);
          return { ...result, inventory: { ...result.inventory, runtime: value.node } };
        };
      }
      const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
      const result = await apply(value);
      expect(result).toMatchObject({ status: 'partial', effects: 'possible' });
      expect(result.verification).toBeUndefined();
      expect(run.mock.calls.some(([command]) => command.executable === path.join(value.source, 'runtime/node'))).toBe(false);
      expect(JSON.parse(await readFile(path.join(value.root, 'private journal/journal.json'), 'utf8')))
        .toMatchObject({ journal: { phase: 'cask-settled' } });
    });

  it('does not report verified installation when a successful version probe changes installed bytes', async () => {
    const value = await fixture();
    const execute = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
    value.dependencies.upgrade.runner.run = async (command, options) => {
      const result = await execute(command, options);
      if (command.executable === path.join(value.source, 'runtime/node') && command.args.includes('--version')) {
        await writeFile(path.join(value.source, 'application/changed-during-version'), 'retain changed bytes');
      }
      return result;
    };
    const result = await apply(value);
    expect(result.status).toBe('partial');
    expect(result.verification).toBeUndefined();
    expect(await readFile(path.join(value.source, 'application/changed-during-version'), 'utf8')).toBe('retain changed bytes');
    expect(JSON.parse(await readFile(path.join(value.root, 'private journal/journal.json'), 'utf8')))
      .toMatchObject({ journal: { phase: 'cask-settled' } });
  });

  it('requires fresh independent manager ownership after successful version probes', async () => {
    const value = await fixture();
    const observe = value.dependencies.cask!.installed;
    let calls = 0;
    value.dependencies.cask!.installed = async (...args) => {
      const result = await observe(...args);
      if (++calls > 1) result.ownership.installedVersion = '9.9.9';
      return result;
    };
    expect(await apply(value)).toMatchObject({ status: 'partial', blockers: ['native-unsupported_installation'] });
    expect(calls).toBe(2);
  });

  it('blocks stale original release material during historical-journal inspection without rewriting it', async () => {
    const value = await fixture();
    const applied = await apply(value);
    expect(applied.status).toBe('installed');
    const root = path.join(value.root, 'private journal');
    const store = new MacMigrationJournalStore(root);
    const journal = await store.read(applied.journal!.sha256);
    expect(journal.targetStage).toBeDefined();
    await store.lock();
    try {
      delete journal.targetStage;
      await store.save(journal);
    } finally { await store.release(); }
    const historical = await store.descriptor();
    const before = await captureMigrationTree(root);
    value.material.prerelease = true;
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    const result = await runMacMigration({ inspect: { journalRoot: root,
      journalSha256: historical.sha256 } }, value.dependencies);
    expect(result).toMatchObject({ status: 'partial', effects: 'none', blockers: ['native-native_invalid'] });
    expect(result.verification).toBeUndefined();
    expect(run.mock.calls.some(([command]) => command.executable === path.join(value.source, 'runtime/node'))).toBe(false);
    expect(await captureMigrationTree(root)).toEqual(before);
  });

  it.each(['qualification.sig', 'release.json', 'snapshot.json', 'definition.rb'] as const)(
    'blocks changed retained %s during repeat inspection without executing target code or rewriting evidence', async name => {
      const value = await fixture(), applied = await apply(value);
      expect(applied.status).toBe('installed');
      const root = path.join(value.root, 'private journal');
      await writeFile(path.join(root, 'cask-target', name), 'retain changed target bytes');
      const before = await captureMigrationTree(root);
      const run = vi.spyOn(value.dependencies.upgrade.runner, 'run'), target = vi.spyOn(value.dependencies.cask!, 'target');
      const result = await runMacMigration({ inspect: { journalRoot: root, journalSha256: applied.journal!.sha256 } },
        value.dependencies);
      expect(result).toMatchObject({ status: 'partial', effects: 'none', blockers: ['cask-target-stage-changed'] });
      expect(result.verification).toBeUndefined();
      expect(target).not.toHaveBeenCalled();
      expect(run.mock.calls.some(([command]) => command.executable === path.join(value.source, 'runtime/node'))).toBe(false);
      expect(await captureMigrationTree(root)).toEqual(before);
    });
});
