import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { historicalMigrationClient, macMigrationJourneyLane } from '../scripts/mac-migration-journey-report.mjs';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, migrationAbsent, migrationLauncher } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationHash, migrationFileIdentity } from '../src/adapters/distribution/mac-npm-owner.js';
import { isStableSemver } from '../src/stable-release.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import {
  assertCompiledMigrationOptOut, migrationJourneySnapshot, prepareMigrationJourney
} from './fixtures/mac-migration-journey.js';

const selected = process.env.LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT;
const historical = process.env.LIFTOFF_MAC_MIGRATION_HISTORICAL_TARBALL;
const npm = process.env.npm_execpath;
const fixtures: Awaited<ReturnType<typeof macMigrationFixture>>[] = [];
const resetModes: { file: string; mode: number }[] = [];
const cases = (['custom', 'homebrew-node', 'nvm', 'volta'] as const).flatMap(manager =>
  (['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'] as const).flatMap(optOut =>
    (['preview', 'apply'] as const).map(mode => ({ manager, optOut, mode }))));

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { file, mode } of resetModes.splice(0)) await chmod(file, mode);
  for (const value of fixtures.splice(0)) await value.cleanup();
});

describe.skipIf(!selected || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual historical npm and genuine native prerelease refusal', () => {
    beforeAll(async () => {
      expect(historical, 'A selected native run requires the pinned historical client.').toBeTruthy();
      expect(npm && path.basename(npm)).toBe('npm-cli.js');
      expect(macMigrationHash(await readFile(historical!))).toBe(historicalMigrationClient.sha256);
      const native = await verifyNativeBundle(selected!);
      expect(isStableSemver(native.package.version)).toBe(false);
      expect(macMigrationJourneyLane(native.package.version)).toBe('prerelease-refusal');
    });

    describe.each(cases)('$manager $optOut $mode', ({ manager, optOut, mode }) => {
      let prepared: Awaited<ReturnType<typeof prepareMigrationJourney>>;
      beforeEach(async () => {
        prepared = await prepareMigrationJourney({ manager, optOut },
          { bundle: selected!, historical: historical!, npm: npm! }, fixtures, resetModes);
      }, 30_000);

      it('refuses the genuine prerelease before npm removal', { timeout: 30_000 }, async ({ task }) => {
        const { value, native, nativeBytes, tools, observations, invoke, binary, old, caller, project, clone, fresh,
          callerEnv, before, unrelated, unrelatedBefore, toolsBefore, fetch } = prepared;
        const record = JSON.parse(value.material.record.toString());
        expect(record.version).toBe(native.package.version);
        expect(value.material.stableTag).toBe(`v${native.package.version}`);
        expect(value.material.prerelease).toBe(true);
        expect(value.channel).toMatchObject({ version: native.package.version, exactApply: false });
        expect(await invoke([path.join(value.source, 'application/dist/cli.js'), '--version']))
          .toMatchObject({ status: 0, stdout: `Liftoff ${native.package.version}\n`, processTreeSettled: true });
        const cask = value.dependencies.cask!;
        const target = vi.spyOn(cask, 'target');
        const later = [vi.spyOn(cask, 'channel'), vi.spyOn(cask, 'destination'), vi.spyOn(cask, 'preflight'),
          vi.spyOn(cask, 'absent'), vi.spyOn(cask, 'installed')];
        const dispatch = vi.spyOn(cask, 'installExact');
        const launcher = await migrationLauncher(value.oldLauncher);
        const recovery = await captureMigrationTree(value.recovery);
        const journalRoot = path.join(value.root, 'uncreated prerelease journal');
        const migrationStart = observations.length;
        const report = await runMacMigration({ ...value.request,
          ...(mode === 'apply' ? { apply: { review: '0'.repeat(64), journalRoot } } : {}) }, value.dependencies);
        expect(report, JSON.stringify(report)).toMatchObject({
          mode, status: 'blocked', effects: 'none', blockers: ['native-native_invalid'], selected: { version: '0.3.4' }
        });
        expect(report.review).toBeUndefined();
        expect(report.target).toBeUndefined();
        expect(report.journal).toBeUndefined();
        expect(target).toHaveBeenCalledOnce();
        for (const spy of [...later, dispatch]) expect(spy).not.toHaveBeenCalled();
        const calls = observations.slice(migrationStart);
        expect(calls.some(({ result }) => result.command.args.includes('uninstall'))).toBe(false);
        expect(calls.some(({ result }) => result.command.args.includes('upgrade'))).toBe(false);
        expect(await migrationAbsent(journalRoot)).toBe(true);
        expect(await captureMigrationTree(value.oldPackage)).toEqual(old);
        expect(await captureMigrationTree(value.recovery)).toEqual(recovery);
        expect(await migrationLauncher(value.oldLauncher)).toEqual(launcher);
        expect(await invoke([binary, '--version'])).toMatchObject({ status: 0, stdout: 'Liftoff 0.3.4\n' });
        await assertCompiledMigrationOptOut(value, callerEnv, [project, clone, fresh]);
        expect(fetch).not.toHaveBeenCalled();
        expect(await migrationJourneySnapshot(caller)).toEqual(before);
        expect(await readFile(unrelated)).toEqual(unrelatedBefore);
        expect(await Promise.all([tools.node, tools.npm].map(file => migrationFileIdentity(file, 256 * 1024 * 1024)))).toEqual(toolsBefore);
        Object.assign(task.meta, { migrationPrereleaseRefusal: {
          manager, optOut, mode, outcome: 'prerelease-refusal', positiveMigrationQualified: false,
          historicalVersion: historicalMigrationClient.version, historicalArchiveSha256: historicalMigrationClient.sha256,
          nativeSourceCommit: native.source.commit, nativeSourceDirty: native.source.dirty,
          nativeManifestSha256: macMigrationHash(nativeBytes), nativeInventorySha256: native.inventory.sha256,
          nativeVersion: native.package.version, releaseReady: native.releaseReady,
          syntheticReleaseAdmissionContext: true, realHostGlobalInstallationTouched: false,
          compiledClientFetchAttempts: 0, callerPreserved: true, blockers: report.blockers, effects: report.effects,
          npmUninstallCalls: 0, caskDispatchCalls: dispatch.mock.calls.length, journalCreated: false,
          oldOwnerPreserved: true, observations
        } });
      });
    });
  });
