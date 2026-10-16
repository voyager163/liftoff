import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, copyFile, cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationHash } from '../src/adapters/distribution/mac-npm-owner.js';
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
const npm = process.env.npm_execpath;

describe.skipIf(process.platform === 'win32' || !npm || path.basename(npm) !== 'npm-cli.js')(
  'explicit actual npm against a disposable global-prefix fixture', () => {
    const cases = (['handover', 'settled-recovery'] as const).flatMap(outcome =>
      [false, true].map(sharedLauncher => ({ outcome, sharedLauncher })));
    it.for(cases)('preserves exact scope through actual npm uninstall, $outcome, shared launcher $sharedLauncher',
      { timeout: 30_000 }, async ({ outcome, sharedLauncher }, { task }) => {
        const value = await macMigrationFixture('custom', sharedLauncher); fixtures.push(value);
        const originals = { npm: await realpath(npm!), node: await realpath(process.execPath) };
        const tools = path.join(value.root, 'actual tools');
        await mkdir(path.join(tools, 'bin'), { recursive: true, mode: 0o700 });
        await cp(path.dirname(path.dirname(originals.npm)), path.join(tools, 'npm'), {
          recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false
        });
        const selected = { npm: path.join(tools, 'npm/bin/npm-cli.js'), node: path.join(tools, 'bin/node') };
        await copyFile(originals.node, selected.node);
        await chmod(selected.node, 0o755);
        await chmod(path.join(tools, 'npm'), 0o700);
        await chmod(path.dirname(selected.npm), 0o700);
        expect(macMigrationHash(await readFile(selected.npm))).toBe(macMigrationHash(await readFile(originals.npm)));
        expect(macMigrationHash(await readFile(selected.node))).toBe(macMigrationHash(await readFile(originals.node)));
        value.request.selection = { ...selected,
          prefix: value.prefix, manager: 'custom' };
        const before = await captureMigrationTree(value.oldPackage);
        const unrelated = path.join(value.prefix, 'lib/node_modules/unrelated/package.json');
        const preferences = path.join(value.root, 'caller.config.json');
        await mkdir(path.dirname(unrelated), { recursive: true });
        await writeFile(unrelated, '{ "name": "unrelated", "version": "1.0.0" }\r\n', { mode: 0o600 });
        await writeFile(preferences, '  {"telemetry":{"enabled":false},"future":true}\r\n', { mode: 0o400 });
        const preserved = await Promise.all([unrelated, preferences].map(async file => ({
          file, bytes: (await readFile(file)).toString('hex'), mode: (await lstat(file)).mode
        })));
        const actualRun = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
        const processes: { result: CommandResult; options?: RunCommandOptions }[] = [];
        vi.spyOn(value.dependencies.upgrade.runner, 'run').mockImplementation(async (command, options) => {
          const result = await actualRun(command, options); processes.push({ result, options }); return result;
        });
        if (outcome === 'settled-recovery') value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
        const evidence = { actualNpm: value.request.selection.npm, actualNode: value.request.selection.node, originalTools: originals,
          privatePrefix: value.prefix, processes, outcome, sharedLauncher, preserved,
          syntheticOldClientAndCask: true, realHostGlobalInstallationTouched: false };
        Object.assign(task.meta, { actualNpmSettlement: evidence });
        const preview = await runMacMigration(value.request, value.dependencies);
        expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'ready', blockers: [], effects: 'none' });
        const journalRoot = path.join(value.root, 'private journal');
        const applied = await runMacMigration({ ...value.request, apply: { review: preview.review!, journalRoot } }, value.dependencies);
        const removals = processes.filter(({ result }) => result.command.args.includes('uninstall'));
        expect(removals).toHaveLength(1);
        expect(removals[0].result.command).toEqual({ executable: value.request.selection.node,
          args: [value.request.selection.npm, 'uninstall', '--global', '--prefix', value.prefix,
            '--ignore-scripts', '--no-audit', '--no-fund', '@msn-control/liftoff'] });
        expect(removals[0].result).toMatchObject({ status: 0, processTreeSettled: true });
        expect(await migrationAbsent(value.oldPackage)).toBe(true);
        expect(await readFile(value.npm, 'utf8')).toContain('removed exact isolated fixture package');
        if (outcome === 'handover') {
          expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'installed', blockers: [], effects: 'cask-installed' });
        } else {
          expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'partial', blockers: ['cask-install-failed'] });
          const journal = await readFile(path.join(journalRoot, 'journal.json'));
          const restored = await runMacMigration({ recover: { journalRoot, journalSha256: macMigrationHash(journal) } }, value.dependencies);
          expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored', blockers: [], effects: 'old-restored' });
          expect((await captureMigrationTree(value.oldPackage)).content).toBe(before.content);
        }
        expect(await Promise.all(preserved.map(async ({ file }) => ({
          file, bytes: (await readFile(file)).toString('hex'), mode: (await lstat(file)).mode
        })))).toEqual(preserved);
      });
  });
