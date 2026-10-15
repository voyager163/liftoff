import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { macMigrationHash } from '../src/adapters/distribution/mac-npm-owner.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) await value.cleanup(); });
const seeded = { LIFTOFF_MIGRATION_PARENT_ONLY_FIXTURE: 'do-not-inherit',
  HTTP_PROXY: 'http://fixture.invalid', npm_config_registry: 'https://fixture.invalid', VOLTA_HOME: '/fixture-not-selected' };

describe.skipIf(process.platform === 'win32')('actual migration child environment', () => {
  it.for(['handover', 'settled-recovery'] as const)('removes ambient parent variables during preview and %s',
    { timeout: 30_000 }, async (outcome, { task }) => {
      const value = await macMigrationFixture('custom', false, true); fixtures.push(value);
      const previous = Object.fromEntries(Object.keys(seeded).map(key => [key, process.env[key]]));
      try {
        Object.assign(process.env, seeded);
        if (outcome === 'settled-recovery') value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
        const preview = await runMacMigration(value.request, value.dependencies);
        expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'ready', blockers: [], effects: 'none' });
        Object.assign(task.meta, { initialObservedChildEnvironment:
          (await readFile(value.childEnvironmentFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) });
        const journalRoot = path.join(value.root, 'private journal');
        const applied = await runMacMigration({ ...value.request, apply: { review: preview.review!, journalRoot } }, value.dependencies);
        if (outcome === 'handover') {
          expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'installed', blockers: [] });
        } else {
          expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'partial', blockers: ['cask-install-failed'] });
          const journal = await readFile(path.join(journalRoot, 'journal.json'));
          expect(await runMacMigration({ recover: { journalRoot, journalSha256: macMigrationHash(journal) } }, value.dependencies))
            .toMatchObject({ status: 'restored', blockers: [] });
        }
        const children: NodeJS.ProcessEnv[] = (await readFile(value.childEnvironmentFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(children.length).toBeGreaterThan(10);
        for (const environment of children) {
          expect(environment).toMatchObject({ DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: '' });
          for (const key of Object.keys(seeded)) expect(environment).not.toHaveProperty(key);
          for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
            expect(environment[key]).toBeDefined();
            expect(environment[key]).not.toBe(value.root);
          }
        }
        for (const [key, expected] of Object.entries(seeded)) expect(process.env[key]).toBe(expected);
        Object.assign(task.meta, { observedChildEnvironment: { children, outcome,
          qualification: 'Child-observed seeded-variable removal and neutral settings, not arbitrary client no-transport proof.' } });
      } finally {
        for (const [key, original] of Object.entries(previous)) {
          if (original === undefined) delete process.env[key]; else process.env[key] = original;
        }
      }
    });

  it('detects a deliberately legacy-merging runner from actual child observations before uninstall', async ({ task }) => {
    const value = await macMigrationFixture('custom', false, true); fixtures.push(value);
    const name = 'LIFTOFF_MIGRATION_PARENT_ONLY_FIXTURE';
    const previous = Object.fromEntries(Object.keys(seeded).map(key => [key, process.env[key]]));
    const actualRun = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run').mockImplementation((command, options) =>
      actualRun(command, { ...options, inheritEnvironment: true }));
    try {
      Object.assign(process.env, seeded, { [name]: 'deliberately-inherited-control' });
      const preview = await runMacMigration(value.request, value.dependencies);
      expect(preview).toMatchObject({ status: 'blocked', effects: 'none',
        blockers: expect.arrayContaining(['probe-not-settled']) });
      expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
      const observed: NodeJS.ProcessEnv[] = (await readFile(value.childEnvironmentFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(observed.some(environment => environment[name] === 'deliberately-inherited-control')).toBe(true);
      Object.assign(task.meta, { deliberatelyLegacyMergingControl: observed });
    } finally {
      for (const [key, original] of Object.entries(previous)) {
        if (original === undefined) delete process.env[key]; else process.env[key] = original;
      }
    }
  });
});
