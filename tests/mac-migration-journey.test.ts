import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationHash, migrationFileIdentity } from '../src/adapters/distribution/mac-npm-owner.js';
import { projectTelemetryRecordPath } from '../src/domain/project/telemetry-consent.js';
import { isStableSemver } from '../src/stable-release.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import {
  assertCompiledMigrationOptOut, migrationJourneySnapshot as snapshot, prepareMigrationJourney
} from './fixtures/mac-migration-journey.js';

const historicalSha256 = '05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0';
const selected = process.env.LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT;
const historical = process.env.LIFTOFF_MAC_MIGRATION_HISTORICAL_TARBALL;
const npm = process.env.npm_execpath;
const fixtures: Awaited<ReturnType<typeof macMigrationFixture>>[] = [];
const resetModes: { file: string; mode: number }[] = [];
const cases = (['custom', 'homebrew-node', 'nvm', 'volta'] as const).flatMap(manager =>
  (['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'] as const).flatMap(optOut =>
    (['handover', 'settled-recovery'] as const).map(outcome => ({ manager, optOut, outcome }))));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { file, mode } of resetModes.splice(0)) await chmod(file, mode);
  for (const value of fixtures.splice(0)) await value.cleanup();
});

async function prepareJourney({ manager, optOut }: typeof cases[number]) {
  return prepareMigrationJourney({ manager, optOut }, { bundle: selected!, historical: historical!, npm: npm! },
    fixtures, resetModes);
}

describe.skipIf(!selected || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual historical npm and compiled native migration journeys', () => {
    beforeAll(async () => {
      expect(historical, 'Select the pinned historical archive; an actual native run must not silently skip the journey.').toBeTruthy();
      expect(npm && path.basename(npm)).toBe('npm-cli.js');
      expect(macMigrationHash(await readFile(historical!))).toBe(historicalSha256);
      const native = await verifyNativeBundle(selected!);
      expect(isStableSemver(native.package.version), 'Stable-positive journeys require an actual stable-version bundle.').toBe(true);
    });

    describe.each(cases)('$manager $optOut $outcome', ({ manager, optOut, outcome }) => {
      let prepared: Awaited<ReturnType<typeof prepareJourney>>;
      beforeEach(async () => { prepared = await prepareJourney({ manager, optOut, outcome }); }, 30_000);

      it('preserves enrolled and unenrolled projects', { timeout: 30_000 }, async ({ task }) => {
        const { value, nativeBytes, native, tools, observations, invoke, binary, old, caller, project, clone, fresh,
          record, recordBytes, callerEnv, before, unrelated, unrelatedBefore, toolsBefore, fetch } = prepared;
        const migrationStart = observations.length;
        const preview = await runMacMigration(value.request, value.dependencies);
        expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'ready', effects: 'none', blockers: [] });
        expect(preview.selected?.version).toBe('0.3.4');
        expect(await snapshot(caller)).toEqual(before);
        if (outcome === 'settled-recovery') value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
        const journalRoot = path.join(value.root, 'selected journey journal');
        const applied = await runMacMigration({ ...value.request, apply: { review: preview.review!, journalRoot } }, value.dependencies);
        if (outcome === 'handover') {
          expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'installed', effects: 'cask-installed', blockers: [],
            verification: { owner: 'homebrew-cask', version: native.package.version, assets: 'verified' } });
          const inspected = await runMacMigration({ inspect: { journalRoot, journalSha256: applied.journal!.sha256 } }, value.dependencies);
          expect(inspected).toMatchObject({ status: 'installed', effects: 'none', blockers: [] });
        } else {
          expect(applied).toMatchObject({ status: 'partial', blockers: ['cask-install-failed'] });
          const restored = await runMacMigration({ recover: { journalRoot, journalSha256: applied.journal!.sha256 } }, value.dependencies);
          expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored', effects: 'old-restored', blockers: [] });
          expect((await captureMigrationTree(value.oldPackage)).content).toBe(old.content);
          expect(await invoke([binary, '--version'])).toMatchObject({ status: 0, stdout: 'Liftoff 0.3.4\n' });
        }
        const calls = observations.slice(migrationStart);
        expect(calls.filter(({ result }) => result.command.args.includes('uninstall'))).toHaveLength(1);
        expect(calls.some(({ result }) => result.command.args.includes('upgrade'))).toBe(false);
        for (const { options } of calls) {
          expect(options?.inheritEnvironment).toBe(false);
          expect(options?.env).toMatchObject({ DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', CI: 'true' });
        }
        await assertCompiledMigrationOptOut(value, callerEnv, [project, clone, fresh]);
        expect(fetch).not.toHaveBeenCalled();
        expect(await snapshot(caller)).toEqual(before);
        expect(await readFile(record)).toEqual(recordBytes);
        expect(await migrationAbsent(path.join(fresh, ...projectTelemetryRecordPath))).toBe(true);
        expect(await readFile(unrelated)).toEqual(unrelatedBefore);
        expect(await Promise.all([tools.node, tools.npm].map(file => migrationFileIdentity(file, 256 * 1024 * 1024)))).toEqual(toolsBefore);
        Object.assign(task.meta, { migrationClientJourney: {
          manager, optOut, outcome, historicalVersion: '0.3.4', historicalArchiveSha256: historicalSha256,
          nativeSourceCommit: native.source.commit, nativeSourceDirty: native.source.dirty,
          nativeManifestSha256: macMigrationHash(nativeBytes), nativeInventorySha256: native.inventory.sha256,
          nativeVersion: native.package.version, releaseReady: native.releaseReady,
          syntheticCaskAdmissionAndSettlement: true, realHostGlobalInstallationTouched: false,
          compiledClientFetchAttempts: 0, callerPreserved: true, observations
        } });
      });
    });
  });
