import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../src/application/context.js';
import { executeUpgrade } from '../src/application/upgrade/use-case.js';
import { checkConfiguredRegistryTarget, runSelfUpgrade, type SelfUpgradeRequest } from '../src/application/upgrade/self-upgrade.js';
import {
  inspectGlobalInstallation, npmGlobalRoot, reconfirmHomebrewInstallation, runExactGlobalInstall, verifyReplacement
} from '../src/adapters/distribution/npm.js';
import { defaultSelfUpgradeDependencies, type SelfUpgradeDependencies } from '../src/adapters/distribution/upgrade-host.js';
import { canonicalManualInstallCommand, exactGlobalInstallCommand, npmExecutableForPlatform } from '../src/domain/distribution/liftoff-package.js';
import {
  canonicalFailureReason, SelfUpgradeFailure, selfUpgradeExitCode, selfUpgradeRemedy, selfUpgradeResult, selfUpgradeSummary,
  type SelfUpgradeReasonCode, type SelfUpgradeResult
} from '../src/domain/distribution/liftoff-upgrade.js';
import {
  buildGlobalNpmInstallCommand, commandFailed, comparisonPath, npmCommand, pathIsContained, readOnlyEnvironment, registryKind
} from '../src/domain/distribution/liftoff-npm-installation.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { CaptureStream } from './helpers.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const result = (overrides: Partial<SelfUpgradeResult> & Pick<SelfUpgradeResult, 'status' | 'reasonCode'>): SelfUpgradeResult =>
  ({ schemaVersion: 1, mode: 'apply', currentVersion: '0.12.3', ...overrides }) as SelfUpgradeResult;

describe('schema-1 upgrade contract rules', () => {
  it('maps every status to its documented exit code and summary', () => {
    expect([
      result({ status: 'current', reasonCode: 'current' }),
      result({ status: 'update-available', reasonCode: 'update_available', targetVersion: '0.13.0', registryKind: 'canonical' }),
      result({ status: 'upgraded', reasonCode: 'upgrade_complete', targetVersion: '0.13.0', registryKind: 'canonical' }),
      result({ status: 'blocked', reasonCode: 'registry_stale' }),
      result({ status: 'failed', reasonCode: 'npm_install_failed' })
    ].map((value) => [selfUpgradeExitCode(value), selfUpgradeSummary(value)])).toEqual([
      [0, 'Liftoff 0.12.3 is already the canonical stable release.'],
      [2, 'Liftoff 0.13.0 is available for this supported global npm installation.'],
      [0, 'Liftoff 0.13.0 was installed and verified.'],
      [1, 'CLI upgrade was blocked (registry_stale).'],
      [1, 'CLI upgrade failed (npm_install_failed).']
    ]);
  });

  it('gives each reason code its exact remedy and keeps Homebrew prefixes only on command remedies', () => {
    const exact = exactGlobalInstallCommand('0.13.0');
    const manual = canonicalManualInstallCommand();
    const stale = 'Ask the managed registry owner to synchronize or approve the canonical target, then retry.';
    const canonical = 'Retry after canonical npm is reachable and exposes valid stable Liftoff metadata.';
    const registry = 'Repair the approved npm registry configuration without placing credentials in the registry URL, then retry.';
    const table: Array<[SelfUpgradeReasonCode, string | undefined, string | undefined]> = [
      ['current', undefined, undefined],
      ['update_available', undefined, undefined],
      ['upgrade_complete', undefined, undefined],
      ['registry_stale', stale, stale],
      ['npm_install_failed', `Run the exact repair command manually: ${exact}`, `Run the exact repair command manually: ${exact} --prefix /opt/homebrew`],
      ['npm_install_timeout', `Run the exact repair command manually: ${exact}`, `Run the exact repair command manually: ${exact} --prefix /opt/homebrew`],
      ['verification_failed', `Run the exact repair command manually: ${exact}`, `Run the exact repair command manually: ${exact} --prefix /opt/homebrew`],
      ['unsupported_installation', `Use a supported global npm installation: ${manual}`, `Use a supported global npm installation: ${manual} --prefix /opt/homebrew`],
      ['invalid_global_root', `Use a supported global npm installation: ${manual}`, `Use a supported global npm installation: ${manual} --prefix /opt/homebrew`],
      ['invalid_package', `Use a supported global npm installation: ${manual}`, `Use a supported global npm installation: ${manual} --prefix /opt/homebrew`],
      ['npm_unavailable', `Use a supported global npm installation: ${manual}`, `Use a supported global npm installation: ${manual} --prefix /opt/homebrew`],
      ['canonical_invalid', canonical, canonical],
      ['canonical_timeout', canonical, canonical],
      ['canonical_unavailable', canonical, canonical],
      ['registry_invalid', registry, registry],
      ['registry_unavailable', registry, registry],
      ['registry_prefix_mismatch',
        'The active npm and verified Homebrew prefix select different registries. Reconcile the approved machine-level registry policy before retrying; Liftoff did not switch registries or install.',
        'The active npm and verified Homebrew prefix select different registries. Reconcile the approved machine-level registry policy before retrying; Liftoff did not switch registries or install.'],
      ['downgrade_refused', 'Keep the newer installed CLI; Liftoff does not perform automatic downgrades.',
        'Keep the newer installed CLI; Liftoff does not perform automatic downgrades.']
    ];
    expect(new Set(table.map(([reasonCode]) => reasonCode)).size).toBe(18);
    for (const [reasonCode, plain, homebrew] of table) {
      const value = result({ status: 'failed', reasonCode, targetVersion: '0.13.0' });
      expect(selfUpgradeRemedy(value), reasonCode).toBe(plain);
      expect(selfUpgradeRemedy({ ...value, installationTarget: 'homebrew-opt' }), reasonCode).toBe(homebrew);
    }
    expect(selfUpgradeRemedy(result({ status: 'failed', reasonCode: 'npm_install_failed' }))).toBeUndefined();
    expect(selfUpgradeRemedy(result({ status: 'failed', reasonCode: 'verification_failed', installationTarget: 'homebrew-usr-local', targetVersion: '0.13.0' })))
      .toBe(`Run the exact repair command manually: ${exact} --prefix /usr/local`);
  });

  it('builds results with a stable JSON key order and no absent optional fields', () => {
    const value = selfUpgradeResult({ mode: 'check', currentVersion: '0.12.3' }, 'update-available', 'update_available', {
      registryKind: 'configured', targetVersion: '0.13.0', installationTarget: 'homebrew-opt'
    });
    expect(JSON.stringify(value)).toBe('{"schemaVersion":1,"mode":"check","status":"update-available","currentVersion":"0.12.3",' +
      '"reasonCode":"update_available","installationTarget":"homebrew-opt","targetVersion":"0.13.0","registryKind":"configured"}');
    expect(Object.keys(selfUpgradeResult({ mode: 'apply', currentVersion: '0.12.3' }, 'current', 'current')))
      .toEqual(['schemaVersion', 'mode', 'status', 'currentVersion', 'reasonCode']);
  });

  it('maps every canonical lookup failure code and rejects an unknown one', () => {
    expect((['invalid_metadata', 'timeout', 'http_failure', 'network_failure'] as const).map(canonicalFailureReason))
      .toEqual(['canonical_invalid', 'canonical_timeout', 'canonical_unavailable', 'canonical_unavailable']);
    expect(() => canonicalFailureReason('teapot' as never)).toThrow('Unhandled self-upgrade state: teapot');
  });

  it('carries the blocked or failed outcome in its typed failure', () => {
    const failure = new SelfUpgradeFailure('blocked', 'registry_stale', 'configured');
    expect(failure).toMatchObject({ name: 'SelfUpgradeFailure', message: 'registry_stale', status: 'blocked', registryKind: 'configured' });
  });
});

describe('npm-lane rules', () => {
  it.each([
    ['https://registry.npmjs.org', 'canonical'],
    ['https://registry.npmjs.org/', 'canonical'],
    ['https://mirror.example.test/npm/', 'configured']
  ] as const)('classifies %s as %s', (url, kind) => {
    expect(registryKind(url)).toBe(kind);
  });

  it.each([
    'http://registry.npmjs.org/', 'https://fixture-user@mirror.example.test/', 'https://:fixture-pass@mirror.example.test/',
    'https://mirror.example.test/?token=fixture', 'https://mirror.example.test/#fragment', 'not a registry'
  ])('refuses %s as a delivery registry without echoing it', (url) => {
    let caught: unknown;
    try { registryKind(url); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SelfUpgradeFailure);
    expect(caught).toMatchObject({ status: 'blocked', reasonCode: 'registry_invalid', message: 'registry_invalid' });
  });

  it('adds the verified prefix without duplicating --global', () => {
    expect(npmCommand('npm', ['config', 'get', 'registry'])).toEqual({ executable: 'npm', args: ['config', 'get', 'registry'] });
    expect(npmCommand('npm', ['config', 'get', 'registry'], 'homebrew-opt').args)
      .toEqual(['config', 'get', 'registry', '--global', '--prefix', '/opt/homebrew']);
    expect(npmCommand('npm', ['root', '--global'], 'homebrew-usr-local').args).toEqual(['root', '--global', '--prefix', '/usr/local']);
    expect(buildGlobalNpmInstallCommand('0.13.0', 'win32')).toEqual({
      executable: 'npm.cmd', args: ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '@msn-control/liftoff@0.13.0']
    });
  });

  it('treats any error, timeout, signal or nonzero status as a failed command', () => {
    const base: CommandResult = { command: { executable: 'npm', args: [] }, displayCommand: 'npm', status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
    expect(commandFailed(base)).toBe(false);
    for (const overrides of [{ status: 1 }, { status: null }, { timedOut: true }, { signal: 'SIGTERM' as const },
      { errorCode: 'ENOENT' }, { errorMessage: 'spawn failure' }]) {
      expect(commandFailed({ ...base, ...overrides }), JSON.stringify(overrides)).toBe(true);
    }
  });

  it('isolates only the npm cache inside the neutral directory', () => {
    const environment = { PATH: '/fixture/bin', npm_config_cache: '/fixture/ambient', NPM_CONFIG_PREFIX: '/fixture/prefix' };
    expect(readOnlyEnvironment({ environment }, path.join('/', 'neutral'))).toEqual({
      ...environment, npm_config_cache: path.join('/', 'neutral', 'npm-cache')
    });
    expect(environment.npm_config_cache).toBe('/fixture/ambient');
  });

  it('contains paths by segment with case folding only on Windows', () => {
    expect(pathIsContained('/a/b', '/a/b', 'linux')).toBe(true);
    expect(pathIsContained('/a/b', '/a/b/c', 'linux')).toBe(true);
    expect(pathIsContained('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(pathIsContained('/a/b', '/a/b/../c', 'linux')).toBe(false);
    expect(pathIsContained('/a/b', '/A/B/c', 'darwin')).toBe(false);
    expect(pathIsContained('C:\\Users\\Dev', 'c:\\users\\dev\\npm', 'win32')).toBe(true);
    expect(pathIsContained('\\\\server\\share\\npm', '\\\\SERVER\\share\\npm\\x', 'win32')).toBe(true);
    expect(pathIsContained('C:\\Users\\Dev', 'D:\\Users\\Dev', 'win32')).toBe(false);
    expect(comparisonPath('C:\\Users\\Dev', 'win32')).toBe('c:\\users\\dev');
    expect(comparisonPath('/Users/Dev', 'darwin')).toBe('/Users/Dev');
  });
});

interface Recorded { command: ExternalCommand; options?: RunCommandOptions }
function recordingRunner(respond: (command: ExternalCommand) => Partial<CommandResult>): CommandRunner & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    run: async (command, options) => {
      calls.push({ command, options });
      return { command, displayCommand: '', status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...respond(command) };
    }
  };
}

async function npmGlobalFixture(bin: unknown = 'dist/cli.js', version = '0.13.0') {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf-npm-')));
  temporary.push(directory);
  const globalRoot = path.join(directory, 'global', 'node_modules');
  const packageRoot = path.join(globalRoot, '@msn-control', 'liftoff');
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await writeFile(path.join(packageRoot, 'dist', 'cli.js'), 'console.log("fixture");\n');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@msn-control/liftoff', version, bin: { liftoff: bin } }));
  const neutralDirectory = path.join(directory, 'neutral');
  await mkdir(neutralDirectory);
  return { directory, globalRoot, packageRoot, neutralDirectory };
}

function host(runner: CommandRunner, overrides: Partial<SelfUpgradeDependencies> = {}): SelfUpgradeDependencies {
  return { ...defaultSelfUpgradeDependencies(), runner, execPath: process.execPath, environment: { PATH: '/fixture/bin' }, ...overrides };
}

describe('npm compatibility adapter on private filesystem fixtures', () => {
  it('inspects a real npm global package and never trusts a non-object manifest', async () => {
    const fixture = await npmGlobalFixture('dist/cli.js', '0.12.3');
    const runner = recordingRunner(() => ({ stdout: `${fixture.globalRoot}\n` }));
    const request = { currentVersion: '0.12.3', runningPackageRoot: fixture.packageRoot };
    expect(await inspectGlobalInstallation(request, fixture.neutralDirectory, host(runner))).toEqual({
      npmExecutable: npmExecutableForPlatform(process.platform), packageRoot: fixture.packageRoot
    });
    expect(runner.calls.map(({ command, options }) => [command.args, options?.cwd, options?.timeoutMs]))
      .toEqual([[['root', '--global'], fixture.neutralDirectory, 30_000]]);
    await writeFile(path.join(fixture.packageRoot, 'package.json'), '[]');
    await expect(inspectGlobalInstallation(request, fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ status: 'blocked', reasonCode: 'invalid_package' });
    await rm(path.join(fixture.packageRoot, 'package.json'));
    await expect(inspectGlobalInstallation(request, fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ status: 'blocked', reasonCode: 'invalid_package' });
  });

  it('refuses a CLI that is not running from the npm global package it would replace', async () => {
    const fixture = await npmGlobalFixture('dist/cli.js', '0.12.3');
    const runner = recordingRunner(() => ({ stdout: `${fixture.globalRoot}\n` }));
    await expect(inspectGlobalInstallation({ currentVersion: '0.12.3' }, fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ status: 'blocked', reasonCode: 'unsupported_installation' });
    expect(runner.calls.map(({ command }) => command.args)).toEqual([['root', '--global']]);
  });

  it.each<[string, (root: string) => Partial<CommandResult>]>([
    ['a failed root query', () => ({ status: 1 })],
    ['an empty root answer', () => ({ stdout: '\n' })],
    ['an ambiguous root answer', (root) => ({ stdout: `${root}\n${root}\n` })],
    ['a relative root answer', () => ({ stdout: 'global/node_modules\n' })],
    ['an unresolvable root answer', (root) => ({ stdout: `${path.join(root, 'missing')}\n` })]
  ])('fails post-install root verification closed on %s', async (_name, respond) => {
    const fixture = await npmGlobalFixture();
    const runner = recordingRunner(() => respond(fixture.globalRoot));
    await expect(npmGlobalRoot('npm', fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ status: 'failed', reasonCode: 'verification_failed' });
    expect(runner.calls).toHaveLength(1);
  });

  it('never trusts a non-object replacement manifest or a linked replacement package root', async ({ skip }) => {
    const manifest = await npmGlobalFixture();
    await writeFile(path.join(manifest.packageRoot, 'package.json'), '[]');
    const linked = await npmGlobalFixture();
    const target = path.join(linked.directory, 'elsewhere');
    await rm(linked.packageRoot, { recursive: true });
    await mkdir(path.join(target, 'dist'), { recursive: true });
    await writeFile(path.join(target, 'dist', 'cli.js'), 'console.log("fixture");\n');
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: '@msn-control/liftoff', version: '0.13.0', bin: { liftoff: 'dist/cli.js' } }));
    try { await symlink(target, linked.packageRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('Unrun: this Windows host cannot create directory links, so the linked-root refusal was not exercised.');
      }
      throw error;
    }
    for (const fixture of [manifest, linked]) {
      const runner = recordingRunner(() => ({ stdout: `${fixture.globalRoot}\n` }));
      await expect(verifyReplacement('0.13.0', { npmExecutable: 'npm', packageRoot: fixture.packageRoot }, fixture.neutralDirectory, host(runner)))
        .rejects.toMatchObject({ status: 'failed', reasonCode: 'verification_failed' });
      expect(runner.calls.every(({ command }) => command.executable !== process.execPath)).toBe(true);
    }
  });

  it('verifies the replacement through a telemetry-free version probe inside the neutral directory', async () => {
    const fixture = await npmGlobalFixture();
    const runner = recordingRunner((command) => command.executable === process.execPath
      ? { stdout: 'Liftoff 0.13.0\n' } : { stdout: `${fixture.globalRoot}\n` });
    const installation = { npmExecutable: 'npm', packageRoot: fixture.packageRoot };
    await expect(verifyReplacement('0.13.0', installation, fixture.neutralDirectory, host(runner))).resolves.toBeUndefined();
    const probe = runner.calls.at(-1)!;
    expect(probe.command).toEqual({ executable: process.execPath, args: [path.join(fixture.packageRoot, 'dist', 'cli.js'), '--version'] });
    expect(probe.options).toMatchObject({
      cwd: fixture.neutralDirectory, timeoutMs: 15_000,
      env: { PATH: '/fixture/bin', CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' }
    });
  });

  it.each([
    ['an absolute binary', () => path.resolve('/', 'outside', 'cli.js')],
    ['an escaping binary', () => '../outside/cli.js'],
    ['a directory binary', () => 'dist'],
    ['a missing binary declaration', () => 42]
  ])('refuses %s before running it', async (_name, bin) => {
    const fixture = await npmGlobalFixture(bin());
    const runner = recordingRunner(() => ({ stdout: `${fixture.globalRoot}\n` }));
    await expect(verifyReplacement('0.13.0', { npmExecutable: 'npm', packageRoot: fixture.packageRoot }, fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ status: 'failed', reasonCode: 'verification_failed' });
    expect(runner.calls.every(({ command }) => command.executable !== process.execPath)).toBe(true);
  });

  it('refuses a symlinked replacement binary before running it', async ({ skip }) => {
    const fixture = await npmGlobalFixture('dist/linked.js');
    try { await symlink(path.join(fixture.packageRoot, 'dist', 'cli.js'), path.join(fixture.packageRoot, 'dist', 'linked.js'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('Unrun: this Windows host cannot create file symbolic links, so the linked-binary refusal was not exercised.');
      }
      throw error;
    }
    const runner = recordingRunner(() => ({ stdout: `${fixture.globalRoot}\n` }));
    await expect(verifyReplacement('0.13.0', { npmExecutable: 'npm', packageRoot: fixture.packageRoot }, fixture.neutralDirectory, host(runner)))
      .rejects.toMatchObject({ reasonCode: 'verification_failed' });
    expect(runner.calls.every(({ command }) => command.executable !== process.execPath)).toBe(true);
  });

  it('streams the exact install into the neutral directory and keeps JSON stdout pure', async () => {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const command = buildGlobalNpmInstallCommand('0.13.0', 'linux');
    for (const json of [true, false]) {
      const runner = recordingRunner(() => ({}));
      await runExactGlobalInstall(command, '/neutral', host(runner, { environment: { PATH: '/fixture/bin' } }), { json, stdout, stderr });
      expect(runner.calls).toEqual([{ command, options: {
        cwd: '/neutral', env: { PATH: '/fixture/bin', npm_config_cache: path.join('/neutral', 'npm-cache') },
        timeoutMs: 600_000, stream: true, stdout: json ? stderr : stdout, stderr
      } }]);
    }
  });

  it('does not recheck a Homebrew prefix for an ordinary npm installation', async () => {
    const runner = recordingRunner(() => { throw new Error('no command expected'); });
    await expect(reconfirmHomebrewInstallation({ npmExecutable: 'npm', packageRoot: '/x' }, '0.12.3', '/neutral', host(runner)))
      .resolves.toBeUndefined();
    expect(runner.calls).toEqual([]);
  });
});

describe('upgrade orchestration boundaries', () => {
  const request = (): SelfUpgradeRequest => ({
    mode: 'check', currentVersion: '0.12.3', stdout: new CaptureStream(), stderr: new CaptureStream(), json: true
  });

  it('propagates a missing neutral directory without cleanup, and the use case reports the stable failure shape', async () => {
    let removed = 0;
    const overrides: Partial<SelfUpgradeDependencies> = {
      makeNeutralDirectory: async () => { throw new Error('fixture neutral directory failure'); },
      removeNeutralDirectory: async () => { removed++; },
      runner: recordingRunner(() => { throw new Error('no command expected'); })
    };
    await expect(runSelfUpgrade(request(), overrides)).rejects.toThrow('fixture neutral directory failure');
    const context = {
      cwd: '/', stdout: new CaptureStream(), stderr: new CaptureStream(), env: {},
      selfUpgrade: (value: SelfUpgradeRequest) => runSelfUpgrade(value, overrides)
    } as unknown as ExecutionContext;
    expect(await executeUpgrade({ mode: 'apply', json: true }, context)).toEqual({
      schemaVersion: 1, mode: 'apply', status: 'failed', currentVersion: expect.any(String), reasonCode: 'verification_failed'
    });
    expect(removed).toBe(0);
  });

  it('never attaches progress observers to JSON requests, even when one is supplied', async () => {
    const seen: SelfUpgradeRequest[] = [];
    const context = {
      cwd: '/', stdout: new CaptureStream(), stderr: new CaptureStream(), env: {},
      selfUpgrade: async (value: SelfUpgradeRequest) => {
        seen.push(value);
        value.onStage?.('Inspect global installation', 'detail');
        value.onInstallCommand?.({ executable: 'npm', args: ['install'] });
        return result({ status: 'current', reasonCode: 'current', mode: value.mode });
      }
    } as unknown as ExecutionContext;
    const events: unknown[] = [];
    const observer = {
      onStage: (stage: string, detail?: string) => { events.push(['stage', stage, detail]); },
      onInstallCommand: (command: ExternalCommand) => { events.push(['command', command.args]); }
    };
    await executeUpgrade({ mode: 'check', json: true }, context, observer);
    expect(Object.keys(seen[0]!).sort()).toEqual(['currentVersion', 'json', 'mode', 'stderr', 'stdout']);
    expect(events).toEqual([]);
    await executeUpgrade({ mode: 'check', json: false }, context, observer);
    expect(Object.keys(seen[1]!).sort()).toEqual(['currentVersion', 'json', 'mode', 'onInstallCommand', 'onStage', 'stderr', 'stdout']);
    expect(events).toEqual([['stage', 'Inspect global installation', 'detail'], ['command', ['install']]]);
  });

  it('reports an unexpected configured-registry failure as unavailable and still cleans up', async () => {
    let removed = 0;
    const lookup = await checkConfiguredRegistryTarget('0.13.0', {
      runner: recordingRunner(() => { throw new Error('fixture runner failure'); }),
      makeNeutralDirectory: async () => '/neutral',
      removeNeutralDirectory: async () => { removed++; }
    });
    expect(lookup).toEqual({ status: 'unavailable' });
    expect(removed).toBe(1);
  });
});
