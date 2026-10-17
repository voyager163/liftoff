import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, lstat, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { bundleInventory } from '../scripts/native-bundle-contract.mjs';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, copyMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { macMigrationHash, migrationEnvironment, migrationFileIdentity } from '../src/adapters/distribution/mac-npm-owner.js';
import { runCli } from '../src/cli.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { observeProjectTelemetry } from '../src/application/telemetry/project-reporting.js';
import { getTelemetryConfigPath } from '../src/telemetry/config.js';
import { projectConsentBindings, projectTelemetryRecordPath } from '../src/domain/project/telemetry-consent.js';
import { captureTreeState } from '../src/init-filesystem.js';
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import { copyMacMigrationTools } from './fixtures/mac-migration-tools.js';

const historicalSha256 = '05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0';
const selected = process.env.LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT;
const historical = process.env.LIFTOFF_MAC_MIGRATION_HISTORICAL_TARBALL;
const npm = process.env.npm_execpath;
const fixtures: Awaited<ReturnType<typeof macMigrationFixture>>[] = [];
const resetModes: { file: string; mode: number }[] = [];
const cases = (['custom', 'homebrew-node', 'nvm', 'volta'] as const).flatMap(manager =>
  (['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'] as const).flatMap(optOut =>
    (['handover', 'settled-recovery'] as const).map(outcome => ({ manager, optOut, outcome }))));
const manifest = buildCurrentArtifacts(buildCurrentProjectPlan({
  projectName: 'Migration consent specimen', projectType: 'standard', apiStack: 'node',
  specWorkflow: 'manual', agents: [], governanceProfile: 'none', environments: ['dev']
}, { requireProjectName: true })).find(artifact => artifact.logicalName === 'manifest')!.content;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { file, mode } of resetModes.splice(0)) await chmod(file, mode);
  for (const value of fixtures.splice(0)) await value.cleanup();
});

async function snapshot(root: string) {
  const tree = await captureTreeState(root);
  const physical = await Promise.all(['', ...tree.keys()].map(async relative => {
    const file = path.join(root, relative), stat = await lstat(file);
    return { path: relative, dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      ...(stat.isSymbolicLink() ? { target: await readlink(file) } : {}) };
  }));
  return { tree, physical };
}

async function sourceTelemetry(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const status = await runCli({ argv: ['telemetry', ...argv, '--json'], cwd, env, stdout, stderr });
  return { status, report: JSON.parse(stdout.text()), stderr: stderr.text() };
}

async function prepareJourney({ manager, optOut }: typeof cases[number]) {
  const value = await macMigrationFixture(manager, false, false, selected!); fixtures.push(value);
  const nativeBytes = await readFile(path.join(selected!, 'bundle.json'));
  const native = JSON.parse(nativeBytes.toString());
  expect(macMigrationHash(await readFile(path.join(value.source, 'bundle.json')))).toBe(macMigrationHash(nativeBytes));
  expect(await bundleInventory(value.source)).toEqual(native.inventory);
  expect(native.releaseReady).toBe(false);
  const tools = await copyMacMigrationTools(value.root, npm!, path.join(selected!, 'runtime/node'), value.node);
  expect(macMigrationHash(await readFile(tools.node))).toBe(macMigrationHash(await readFile(tools.originals.node)));
  expect(macMigrationHash(await readFile(tools.npm))).toBe(macMigrationHash(await readFile(tools.originals.npm)));
  await unlink(value.npm); await symlink(tools.npm, value.npm);
  value.request.selection = { ...value.request.selection!, npm: tools.npm, node: tools.node };
  await rm(value.oldPackage, { recursive: true }); await unlink(value.oldLauncher);
  const setup = await value.dependencies.upgrade.makeNeutralDirectory();
  const environment = migrationEnvironment(value.dependencies.upgrade, setup, tools.node);
  const observations: { result: CommandResult; options?: RunCommandOptions }[] = [];
  const run = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
  vi.spyOn(value.dependencies.upgrade.runner, 'run').mockImplementation(async (command, options) => {
    const result = await run(command, options); observations.push({ result, options }); return result;
  });
  const invoke = (args: string[], cwd = setup, env: NodeJS.ProcessEnv = environment) =>
    value.dependencies.upgrade.runner.run({ executable: tools.node, args }, {
      cwd, env, inheritEnvironment: false, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
    });
  const installed = await invoke([tools.npm, 'install', '--global', '--prefix', value.prefix,
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', historical!]);
  expect(installed).toMatchObject({ status: 0, processTreeSettled: true });
  const binary = path.join(value.oldPackage, 'dist/cli.js');
  expect(await invoke([binary, '--version'])).toMatchObject({ status: 0, stdout: 'Liftoff 0.3.4\n' });
  const help = await invoke([binary, 'help']);
  expect(help).toMatchObject({ status: 0, processTreeSettled: true });
  expect(help.stdout).not.toMatch(/^\s+upgrade\s/m);
  expect(await invoke([binary, 'upgrade'])).toMatchObject({ status: 1, stderr: expect.stringContaining('Unknown command: upgrade') });
  const old = await captureMigrationTree(value.oldPackage);
  await rm(value.recovery, { recursive: true });
  await copyMigrationTree(value.oldPackage, value.recovery, old);

  const caller = path.join(value.root, 'caller preserved state');
  const home = path.join(caller, 'home'), xdg = path.join(caller, 'config');
  const project = path.join(caller, 'enrolled project'), clone = path.join(caller, 'copied project');
  const fresh = path.join(caller, 'unenrolled project'), legacy = path.join(caller, 'legacy workspace');
  const plain = path.join(caller, 'plain Git project');
  for (const directory of [home, xdg, project, fresh, legacy, plain]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const consentEnv = { HOME: home, XDG_CONFIG_HOME: xdg };
  const config = getTelemetryConfigPath({ env: consentEnv });
  await mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
  await writeFile(config, ' { "unknownRoot" : [1, "retained"], "telemetry" : { "noticeVersion": 1, "unknownPreference": true } }\r\n',
    { mode: 0o600 });
  for (const root of [project, fresh]) await writeFile(path.join(root, 'liftoff.manifest.json'), manifest, { mode: 0o600 });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected fixture transport'); });
  const previewConsent = await sourceTelemetry(['enroll', '--check'], project, consentEnv);
  expect(previewConsent.status, previewConsent.stderr).toBe(2);
  const enrolled = await sourceTelemetry(['enroll', '--approve-plan', previewConsent.report.fingerprint], project, consentEnv);
  expect(enrolled.status, enrolled.stderr).toBe(0);
  expect(enrolled.report.status).toBe('enrolled');
  await cp(project, clone, { recursive: true });
  const record = path.join(project, ...projectTelemetryRecordPath);
  const recordBytes = await readFile(record);
  const enrolledConfig = JSON.parse(await readFile(config, 'utf8'));
  expect(enrolledConfig).toMatchObject({
    unknownRoot: [1, 'retained'], telemetry: { noticeVersion: 1, unknownPreference: true }
  });
  const bindings = projectConsentBindings(enrolledConfig);
  expect(bindings).toEqual([{ projectRoot: project, projectId: enrolled.report.projectId, disclosureVersion: 1 }]);
  expect((await observeProjectTelemetry(project, undefined, consentEnv)).consent).toBe(true);
  expect((await observeProjectTelemetry(clone, undefined, consentEnv)).consent).toBe(false);
  expect((await observeProjectTelemetry(fresh, undefined, consentEnv)).record).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  const callerEnv = { ...environment, HOME: home, XDG_CONFIG_HOME: xdg,
    CI: 'false', DO_NOT_TRACK: undefined, LIFTOFF_TELEMETRY: undefined,
    [optOut]: optOut === 'DO_NOT_TRACK' ? '1' : '0' };
  value.dependencies.upgrade.environment = Object.freeze({ ...callerEnv,
    PATH: `${value.brewPrefix}/bin:${value.prefix}/bin` });
  expect(await invoke([binary, 'create', 'legacy-project', '--no-genai', '--api', 'node', '--yes'], legacy, callerEnv))
    .toMatchObject({ status: 0, processTreeSettled: true });
  const legacyProject = path.join(legacy, 'legacy-project');
  expect(await migrationAbsent(path.join(legacyProject, 'liftoff.manifest.json'))).toBe(false);
  const gitTemplate = path.join(setup, 'empty-git-template');
  await mkdir(gitTemplate);
  for (const root of [legacyProject, plain]) {
    await mkdir(path.join(root, '.liftoff/private'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, '.liftoff/private/state.json'), ' {"schemaVersion":999,"preserve":"unknown state"}\r\n', { mode: 0o600 });
    await writeFile(path.join(root, 'user-owned.ts'), 'export const doNotRewrite = true;\r\n', { mode: 0o640 });
    const gitEnv = { ...callerEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(setup, 'no-git-config'),
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Migration fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Migration fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    for (const args of [['-c', `init.templateDir=${gitTemplate}`, 'init', '--initial-branch=fixture'],
      ['add', '.'], ['-c', `core.hooksPath=${gitTemplate}`, 'commit', '--no-verify', '-m', 'preserved fixture history']]) {
      expect(await value.dependencies.upgrade.runner.run({ executable: '/usr/bin/git', args }, {
        cwd: root, env: gitEnv, inheritEnvironment: false, timeoutMs: 10_000, maxOutputBytes: 8192
      })).toMatchObject({ status: 0 });
    }
  }
  await writeFile(path.join(home, '.npmrc'), '# unrelated caller configuration\r\n', { mode: 0o400 });
  const unrelated = path.join(value.prefix, 'lib/node_modules/unrelated/package.json');
  await mkdir(path.dirname(unrelated)); await writeFile(unrelated, '{"name":"unrelated","version":"1.0.0"}\r\n', { mode: 0o600 });
  if (manager === 'homebrew-node') await writeFile(config, '{invalid retained configuration\r\n');
  if (manager === 'nvm') { await chmod(config, 0o400); resetModes.push({ file: config, mode: 0o600 }); }
  if (manager === 'volta') { await chmod(path.dirname(config), 0o500); resetModes.push({ file: path.dirname(config), mode: 0o700 }); }
  const before = await snapshot(caller);
  const unrelatedBefore = await readFile(unrelated);
  const toolsBefore = await Promise.all([tools.node, tools.npm].map(file => migrationFileIdentity(file, 256 * 1024 * 1024)));
  return { value, nativeBytes, native, tools, observations, invoke, binary, old, caller, project, clone, fresh,
    record, recordBytes, callerEnv, before, unrelated, unrelatedBefore, toolsBefore, fetch };
}

describe.skipIf(!selected || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual historical npm and compiled native migration journeys', () => {
    beforeAll(async () => {
      expect(historical, 'Select the pinned historical archive; an actual native run must not silently skip the journey.').toBeTruthy();
      expect(npm && path.basename(npm)).toBe('npm-cli.js');
      expect(macMigrationHash(await readFile(historical!))).toBe(historicalSha256);
      await verifyNativeBundle(selected!);
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
        const trap = path.join(value.root, 'compiled-client-fetch-tripwire.mjs');
        const attempts = path.join(value.root, 'unexpected-client-transport');
        await writeFile(trap, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => { appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n'); throw new Error('fixture transport forbidden'); };
const { runCli } = await import(${JSON.stringify(pathToFileURL(path.join(value.source, 'application/dist/cli.js')).href)});
process.exitCode = await runCli();
`);
        for (const root of [project, clone, fresh]) {
          const report = await value.dependencies.upgrade.runner.run({
            executable: path.join(value.source, 'runtime/node'), args: [trap, 'telemetry', 'report', '--json']
          }, { cwd: root, env: callerEnv, inheritEnvironment: false, timeoutMs: 10_000, maxOutputBytes: 8192 });
          expect(report).toMatchObject({ status: 0 });
          expect(JSON.parse(report.stdout)).toMatchObject({ status: 'disabled', attempted: false, reason: 'global-opt-out' });
        }
        expect(await migrationAbsent(attempts)).toBe(true);
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
