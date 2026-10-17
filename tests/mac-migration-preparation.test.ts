import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultMacMigrationDependencies, runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { createHomebrewCaskPreparation } from '../src/adapters/distribution/native-cask-plan.js';
import type { NativeStableSource } from '../src/adapters/distribution/native-metadata.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import * as owner from '../src/adapters/distribution/mac-npm-owner.js';
import * as upgradeHost from '../src/adapters/distribution/upgrade-host.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function preparationFixture(caskPresent = false, launcherPresent = false) {
  const value = await macMigrationFixture(); fixtures.push(value);
  delete value.dependencies.cask;
  const prefix = '/opt/homebrew';
  await writeFile(value.request.brew!, `#!/bin/sh\nprintf '%s\\n' '${prefix}'\n`);
  const directory = owner.migrationDirectory;
  vi.spyOn(owner, 'migrationDirectory').mockImplementation((filename, writable) => directory(
    filename === prefix ? value.brewPrefix : filename === `${prefix}/bin` ? path.join(value.brewPrefix, 'bin') : filename,
    writable));
  const virtual = upgradeWorld({ layout: 'homebrew-opt' });
  const definition = `${prefix}/Library/Taps/fixture/homebrew-tools/Casks/liftoff.rb`;
  for (const directory of [`${prefix}/Caskroom`, path.posix.dirname(definition)]) {
    let current = directory;
    while (current !== '/') {
      virtual.world.nodes.set(current, { kind: 'directory' });
      current = path.posix.dirname(current);
    }
  }
  const caskRoot = `${prefix}/Caskroom/liftoff`;
  if (caskPresent) virtual.world.nodes.set(caskRoot, { kind: 'directory' });
  if (!launcherPresent) virtual.world.nodes.delete(`${prefix}/bin/liftoff`);
  virtual.world.nodes.set(definition, { kind: 'file' });
  const bytes = Buffer.from('# Unverified fixture Ruby bytes; never evaluate.\n');
  const readBytes = vi.fn(async (filename: string, _maximum: number) => {
    if (filename !== definition) throw Object.assign(new Error('Absent fixture definition'), { code: 'ENOENT' });
    return bytes;
  });
  const readStable = vi.fn<NativeStableSource['readStable']>(async () => value.material);
  const preparation = createHomebrewCaskPreparation({
    ...virtual.dependencies, architecture: 'arm64', readBytes
  }, value.policy, { readStable });
  value.dependencies.preparation = preparation;
  return { ...value, virtual, preparation, readBytes, readStable, prefix, caskRoot, definition };
}

describe.skipIf(process.platform === 'win32')('migration canonical preparation remains diagnostic only', () => {
  const cases = [false, true].flatMap(caskPresent => [false, true].flatMap(launcherPresent =>
    (['preview', 'apply'] as const).map(mode => ({ caskPresent, launcherPresent, mode }))));

  it.for(cases)('reports $mode cask=$caskPresent launcher=$launcherPresent without effect authority',
    { timeout: 30_000 }, async ({ caskPresent, launcherPresent, mode }, { task }) => {
      const value = await preparationFixture(caskPresent, launcherPresent);
      const before = await captureMigrationTree(value.oldPackage);
      const environment = { ...value.dependencies.upgrade.environment };
      const runner = vi.spyOn(value.dependencies.upgrade.runner, 'run');
      const preview = await runMacMigration(value.request, value.dependencies);
      const journalRoot = path.join(value.root, 'must remain absent');
      const report = mode === 'preview' ? preview : await runMacMigration({ ...value.request,
        apply: { review: preview.preparation!.identity, journalRoot } }, value.dependencies);
      expect(report).toMatchObject({
        mode, status: 'blocked', effects: 'none',
        blockers: ['native-cask-provider-unqualified', 'exact_cask_execution_unproven'],
        target: { cask: value.policy.homebrew.cask, version: '0.13.0' },
        preparation: { effects: 'none', channel: { status: 'unknown' },
          source: { state: 'observed', path: value.definition, authority: 'unverified-local-bytes' },
          preflight: { caskAbsent: !caskPresent, launcherAbsent: !launcherPresent, exactExecutionProven: false },
          execution: { status: 'blocked', reason: 'exact_cask_execution_unproven', command: null } }
      });
      expect(report).not.toHaveProperty('review');
      expect(report).not.toHaveProperty('journal');
      expect(report.preparation!.target).not.toHaveProperty('owner');
      expect(report.preparation!.target).not.toHaveProperty('bundleRoot');
      expect(value.dependencies.cask).toBeUndefined();
      expect(value.preparation).not.toHaveProperty('installExact');
      expect(value.readStable.mock.calls[0][0]).toEqual({ target: 'darwin-arm64' });
      expect(value.virtual.world.trace.filter(event => 'run' in event || 'installCommand' in event || 'neutral' in event)).toEqual([]);
      expect(runner.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
      expect(runner.mock.calls.every(([, options]) => options?.inheritEnvironment === false)).toBe(true);
      expect(await captureMigrationTree(value.oldPackage)).toEqual(before);
      expect(await migrationAbsent(value.oldLauncher)).toBe(false);
      expect(await migrationAbsent(journalRoot)).toBe(true);
      expect(value.dependencies.upgrade.environment).toEqual(environment);
      Object.assign(task.meta, { canonicalMigrationPreparation: { mode, caskPresent, launcherPresent, report,
        managerEffects: 0, uninstallCalls: 0, journalCreated: false,
        qualification: 'Real private npm-owner process/filesystem fixture, virtual canonical cask paths and synthetic signed material; no live cask, manager installation or transport qualification.' } });
    });

  it.each(['signature', 'source-read'] as const)('surfaces canonical %s refusal without a review or journal', async kind => {
    const value = await preparationFixture();
    if (kind === 'signature') value.material.signature[0] ^= 1;
    else value.readBytes.mockRejectedValue(Object.assign(new Error('Denied fixture read'), { code: 'EACCES' }));
    const report = await runMacMigration(value.request, value.dependencies);
    expect(report).toMatchObject({ status: 'blocked', effects: 'none',
      blockers: ['native-cask-provider-unqualified', `native-${kind === 'signature' ? 'native_invalid' : 'native_unavailable'}`] });
    expect(report.preparation).toBeUndefined();
    expect(report.review).toBeUndefined();
    expect(report.journal).toBeUndefined();
    expect(await migrationAbsent(value.oldPackage)).toBe(false);
  });

  it('rejects a late canonical preview rather than adopting its identity as a review', async () => {
    const value = await preparationFixture();
    let clock = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    value.dependencies.preparation = { preview: async (...args) => {
      const preview = await value.preparation.preview(...args);
      clock += 10_000;
      return preview;
    } };
    const report = await runMacMigration(value.request, value.dependencies);
    expect(report).toMatchObject({ status: 'blocked', effects: 'none',
      blockers: ['native-cask-provider-unqualified', 'cask-observation-timeout'] });
    expect(report.preparation).toBeUndefined();
    expect(report.review).toBeUndefined();
    expect(await migrationAbsent(value.oldPackage)).toBe(false);
  });

  it('rejects a canonical observation of a different Homebrew prefix', async () => {
    const value = await preparationFixture();
    value.dependencies.preparation = { preview: async (...args) => {
      const preview = await value.preparation.preview(...args);
      return { ...preview, destination: { ...preview.destination, prefix: '/usr/local' } };
    } };
    const report = await runMacMigration(value.request, value.dependencies);
    expect(report.blockers).toEqual(['native-cask-provider-unqualified', 'cask-preparation-destination-mismatch']);
    expect(report.preparation).toBeUndefined();
    expect(report.review).toBeUndefined();
    expect(await migrationAbsent(value.oldPackage)).toBe(false);
  });

  it('does not use read-only preparation to authorize recovery of a partial migration', async () => {
    const value = await macMigrationFixture(); fixtures.push(value);
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    const ready = await runMacMigration(value.request, value.dependencies);
    expect(ready.status).toBe('ready');
    const partial = await runMacMigration({ ...value.request,
      apply: { review: ready.review!, journalRoot: path.join(value.root, 'private recovery journal') } }, value.dependencies);
    expect(partial).toMatchObject({ status: 'partial', effects: 'npm-removed', blockers: ['cask-install-failed'] });
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
    const virtual = upgradeWorld({ layout: 'homebrew-opt' });
    const preparation = createHomebrewCaskPreparation({ ...virtual.dependencies, architecture: 'arm64' },
      value.policy, { readStable: async () => value.material });
    const preview = vi.spyOn(preparation, 'preview');
    const observe = vi.spyOn(preparation, 'observeDestination');
    value.dependencies.preparation = preparation;
    delete value.dependencies.cask;
    const recovered = await runMacMigration({ recover: { journalRoot: path.dirname(partial.journal!.path),
      journalSha256: partial.journal!.sha256 } }, value.dependencies);
    expect(recovered).toMatchObject({ status: 'partial', effects: 'possible',
      blockers: ['native-cask-provider-unqualified'], journal: partial.journal });
    expect(recovered.preparation).toBeUndefined();
    expect(preview).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
  });
});

it('registers only lazy canonical preparation and refuses missing approvals before destination or transport reads', async () => {
  const base = upgradeHost.defaultSelfUpgradeDependencies();
  const policy = vi.spyOn(base, 'readJson');
  vi.spyOn(upgradeHost, 'defaultSelfUpgradeDependencies').mockReturnValue(base);
  const dependencies = defaultMacMigrationDependencies();
  const destination = vi.spyOn(dependencies.upgrade, 'lstat');
  const runner = vi.spyOn(dependencies.upgrade.runner, 'run');
  const transport = vi.spyOn(globalThis, 'fetch');
  expect(dependencies.cask).toBeUndefined();
  expect(dependencies.preparation).toBeDefined();
  expect(policy).not.toHaveBeenCalled();
  await expect(dependencies.preparation!.preview('/opt/homebrew', new AbortController().signal))
    .rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  expect(destination).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('propagates a packaged-policy read failure instead of supplying a default preparation', async () => {
  const dependencies = defaultMacMigrationDependencies();
  const failure = new Error('Fixture policy read denied');
  vi.spyOn(dependencies.upgrade, 'readJson').mockRejectedValue(failure);
  await expect(dependencies.preparation!.preview('/opt/homebrew', new AbortController().signal)).rejects.toBe(failure);
  expect(dependencies.cask).toBeUndefined();
});
