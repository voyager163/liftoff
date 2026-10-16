import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe.skipIf(process.platform === 'win32')('migration cask observation elapsed deadline', () => {
  for (const elapsedMs of [9_999, 10_000, 10_001]) {
    it.for(['preview', 'apply'] as const)(`enforces the 10000ms deadline during %s at ${elapsedMs}ms`,
    { timeout: 30_000 }, async (mode, { task }) => {
      const value = await macMigrationFixture(); fixtures.push(value);
      const preview = mode === 'apply' ? await runMacMigration(value.request, value.dependencies) : undefined;
      if (preview) expect(preview.status).toBe('ready');
      const before = await captureMigrationTree(value.oldPackage);
      const runner = vi.spyOn(value.dependencies.upgrade.runner, 'run');
      const cask = value.dependencies.cask!;
      const started = performance.now();
      let clock = started;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      if (mode === 'preview') {
        cask.admitHost = async () => { clock += elapsedMs; };
      } else {
        const channel = cask.channel;
        cask.channel = async (...args) => {
          const observed = await channel(...args);
          clock += elapsedMs;
          return observed;
        };
      }
      const journalRoot = path.join(value.root, 'must remain absent');
      const result = await runMacMigration({ ...value.request,
        ...(preview ? { apply: { review: preview.review!, journalRoot } } : {}) }, value.dependencies);
      const uninstalls = runner.mock.calls.filter(([command]) => command.args.includes('uninstall'));
      Object.assign(task.meta, { lateCaskObservation: { mode, perObservationDelayMs: elapsedMs,
        simulatedTotalElapsedMs: clock - started,
        result, uninstallCalls: uninstalls.length,
        qualification: 'Controlled monotonic clock with private process/filesystem fixtures; not wall-clock or live-cask qualification.' } });
      if (elapsedMs < 10_000) {
        expect(result, JSON.stringify(result)).toMatchObject({
          status: mode === 'preview' ? 'ready' : 'installed', blockers: []
        });
        expect(uninstalls).toHaveLength(mode === 'preview' ? 0 : 1);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'blocked', effects: 'none', blockers: ['cask-observation-timeout']
      });
      expect(uninstalls).toHaveLength(0);
      expect(await captureMigrationTree(value.oldPackage)).toEqual(before);
      expect(await migrationAbsent(value.oldLauncher)).toBe(false);
      expect(await migrationAbsent(journalRoot)).toBe(true);
    });
  }

  it('retains an unsettled journal and never restores over a late cask install result',
    { timeout: 30_000 }, async ({ task }) => {
      const value = await macMigrationFixture(); fixtures.push(value);
      const preview = await runMacMigration(value.request, value.dependencies);
      expect(preview.status).toBe('ready');
      const cask = value.dependencies.cask!;
      const install = cask.installExact;
      let clock = performance.now();
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      cask.installExact = async (...args) => {
        const result = await install(...args);
        clock += 120_000;
        return result;
      };
      const journalRoot = path.join(value.root, 'retained late journal');
      const result = await runMacMigration({ ...value.request, apply: { review: preview.review!, journalRoot } }, value.dependencies);
      Object.assign(task.meta, { lateCaskInstall: { simulatedObservationElapsedMs: 120_000, result,
        qualification: 'Controlled monotonic clock and synthetic cask settlement, not real Homebrew qualification.' } });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'partial', effects: 'possible',
        blockers: ['cask-observation-timeout', 'migration-lock-retained', 'observation-scratch-retained'] });
      const bytes = await readFile(path.join(journalRoot, 'journal.json'));
      expect(JSON.parse(bytes.toString())).toMatchObject({ journal: { phase: 'cask-intent' } });
      expect(await migrationAbsent(value.oldPackage)).toBe(true);
      const destination = path.join(value.brewPrefix, 'bin/liftoff');
      expect(await realpath(destination)).toBe(path.join(value.source, 'bin/liftoff'));
      const recovered = await runMacMigration({ recover: {
        journalRoot, journalSha256: result.journal!.sha256
      } }, value.dependencies);
      expect(recovered.status).toBe('partial');
      expect(recovered.blockers.length).toBeGreaterThan(0);
      expect(await readFile(path.join(journalRoot, 'journal.json'))).toEqual(bytes);
      expect(await migrationAbsent(value.oldPackage)).toBe(true);
      expect(await realpath(destination)).toBe(path.join(value.source, 'bin/liftoff'));
    });
});
