import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHomebrewCaskOwnership } from '../src/adapters/distribution/native-cask.js';
import { assertCaskOwnership, createNativeUpgradePort } from '../src/adapters/distribution/native.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import type { NativeBundleInventory, NativeInstallation, NativeReleasePolicy } from '../src/domain/distribution/native-upgrade.js';
import { environmentValue } from '../src/domain/workstation/executables.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';
import { signedMaterial } from './fixtures/native-stable-material.js';
import { nativeCaskDefinition } from '../distribution/native/native-cask-definition.mjs';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => { vi.unstubAllEnvs(); });

function caskWorld(prefix = '/opt/homebrew') {
  const fixture = upgradeWorld({ platform: 'darwin' });
  const caskRoot = `${prefix}/Caskroom/liftoff`;
  const bundleRoot = `${caskRoot}/0.12.3`;
  const tapRoot = `${prefix}/Library/Taps/fixture/homebrew-tools`;
  const receiptPath = `${caskRoot}/.metadata/INSTALL_RECEIPT.json`;
  const definitionPath = `${tapRoot}/Casks/l/liftoff.rb`;
  const configPath = `${tapRoot}/.git/config`;
  const files = new Map([
    [receiptPath, encode({ arch: 'arm64', source: { tap: 'fixture/tools', version: '0.12.3',
      path: definitionPath, tap_git_head: 'a'.repeat(40) } })],
    [definitionPath, Buffer.from('# Inert fixture definition. Must never be evaluated.\n')],
    [configPath, Buffer.from('[remote "origin"]\nurl = https://github.com/fixture/homebrew-tools.git\n')]
  ]);
  for (const filename of files.keys()) {
    fixture.world.nodes.set(filename, { kind: 'file' });
    let directory = path.posix.dirname(filename);
    while (directory !== '/') {
      fixture.world.nodes.set(directory, { kind: 'directory' });
      directory = path.posix.dirname(directory);
    }
  }
  fixture.world.nodes.set(bundleRoot, { kind: 'directory' });
  const policy: NativeReleasePolicy = {
    schemaVersion: 1, repository: 'voyager163/liftoff', approvedSigningKeySha256: null,
    homebrew: { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/homebrew-tools', developerTeamId: null },
    winget: { packageIdentifier: null, publisher: null, certificateSha256: null, installerAppId: null },
    linux: { archiveSigningKeySha256: null }
  };
  const installation: NativeBundleInventory = {
    version: '0.12.3', target: 'darwin-arm64', bundleRoot, packageRoot: `${bundleRoot}/application`,
    launcher: `${bundleRoot}/bin/liftoff`, runtime: `${bundleRoot}/runtime/node`,
    manifestSha256: 'b'.repeat(64), inventorySha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), identity: 'fixture-bundle'
  };
  const behavior = {
    remote: 'https://github.com/fixture/homebrew-tools.git',
    head: 'e'.repeat(40),
    result: {} as Partial<CommandResult>,
    onRead: (_filename: string) => {},
    onGit: () => {}
  };
  const run = vi.fn<CommandRunner['run']>(async command => {
    behavior.onGit();
    expect(command.executable).toBe('git');
    expect(command.args.slice(0, 5)).toEqual(['--no-optional-locks', '--git-dir', `${tapRoot}/.git`, '--work-tree', tapRoot]);
    return { command, displayCommand: 'read-only fixture Git port', status: 0, signal: null, timedOut: false,
      stdout: command.args.includes('config') ? behavior.remote : behavior.head, stderr: '', ...behavior.result };
  });
  const readBytes = vi.fn(async (filename: string, _maximum: number) => {
    behavior.onRead(filename);
    const bytes = files.get(filename);
    if (!bytes) throw Object.assign(new Error('Missing synthetic receipt material'), { code: 'ENOENT' });
    return Buffer.from(bytes);
  });
  const dependencies = {
    ...fixture.dependencies, readBytes, runner: { run }, environment: {
      ...fixture.dependencies.environment, GIT_DIR: '/foreign/repository', git_config_parameters: 'fixture override',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://foreign.test/tap',
      npm_config_registry: 'https://fixture-mirror.test/npm'
    }
  };
  const controller = new AbortController();
  const observe = () => readHomebrewCaskOwnership(dependencies, installation, policy, fixture.world.neutralDirectory, controller.signal);
  const receipt = () => JSON.parse(files.get(receiptPath)!.toString()) as { arch: string; source: Record<string, unknown> };
  return { ...fixture, dependencies, installation, policy, caskRoot, tapRoot, receiptPath, definitionPath, configPath,
    files, behavior, run, readBytes, controller, observe, receipt };
}

describe('production Homebrew cask reader on explicit filesystem/process ports', () => {
  it.each(['/opt/homebrew', '/usr/local'])('binds %s Caskroom receipt, staged launcher and approved repository without invoking Homebrew or evaluating Ruby', async prefix => {
    const fixture = caskWorld(prefix);
    const observed = await fixture.observe();
    expect(observed).toEqual({
      fullToken: 'fixture/tools/liftoff', sourceRepository: 'fixture/homebrew-tools', installedVersion: '0.12.3',
      bundleRoot: fixture.installation.bundleRoot, launcher: fixture.installation.launcher,
      receiptSha256: digest(fixture.files.get(fixture.receiptPath)!),
      definitionSha256: digest(fixture.files.get(fixture.definitionPath)!), tapCommit: 'e'.repeat(40)
    });
    expect(() => assertCaskOwnership(observed, fixture.installation, fixture.policy)).not.toThrow();
    expect(fixture.run).toHaveBeenCalledTimes(3);
    for (const [, options] of fixture.run.mock.calls) {
      expect(options).toMatchObject({
        cwd: fixture.world.neutralDirectory, timeoutMs: 30_000, maxOutputBytes: 8192,
        signal: fixture.controller.signal, ensureProcessTreeSettled: true, inheritEnvironment: false,
        env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
          DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: '',
          npm_config_registry: 'https://fixture-mirror.test/npm' }
      });
      expect(Object.keys(options!.env!).filter(key => /^git_/i.test(key)).sort())
        .toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS']);
    }
    expect(fixture.run.mock.calls[0][0].args.slice(5))
      .toEqual(['config', '--no-includes', '--local', '--get-all', 'remote.origin.url']);
  });

  it('proves filtered Git options in real harmless children, with a default-merge contrast and no Git or Homebrew execution', async () => {
    const fixture = caskWorld();
    const hostEnvironment: NodeJS.ProcessEnv = {};
    if (process.platform === 'win32') {
      const systemRoot = environmentValue(process.env, 'SystemRoot', 'win32');
      if (!systemRoot) throw new Error('The native Windows Node fixture requires SystemRoot.');
      hostEnvironment.SystemRoot = systemRoot;
    }
    Object.assign(fixture.dependencies.environment, hostEnvironment);
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf cask child env ')));
    const parentOnly = {
      GIT_DIR: '/parent-only-fixture', GIT_CONFIG_PARAMETERS: 'fixture-parent-config',
      GIT_ASKPASS: '/parent-only-never-executed-helper', GH_TOKEN: 'fixture-parent-only-not-a-credential',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.key', GIT_CONFIG_VALUE_0: 'fixture-value',
      HTTP_PROXY: 'http://parent-proxy.invalid', NPM_CONFIG_USERCONFIG: '/parent-only-never-read/npmrc',
      LIFTOFF_CASK_PARENT_ONLY_FIXTURE: 'fixture-parent-only'
    };
    for (const [key, value] of Object.entries(parentOnly)) vi.stubEnv(key, value);
    const inspector = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([
      ...Object.keys(parentOnly), ...Object.keys(hostEnvironment),
      'npm_config_registry', 'DO_NOT_TRACK', 'LIFTOFF_TELEMETRY', 'NODE_OPTIONS', 'NODE_PATH'
    ])}.map(key=>[key,process.env[key] ?? null]))))`;
    fixture.world.neutralDirectory = directory;
    const runner = new NodeCommandRunner();
    let children = 0;
    const results: { kind: 'inherited' | 'isolated'; result: CommandResult }[] = [];
    const run = vi.fn<CommandRunner['run']>(async (command, options) => {
      const child = { executable: process.execPath, args: ['-e', inspector] };
      if (children === 0) {
        const inherited = await runner.run(child, { ...options, inheritEnvironment: undefined, ensureProcessTreeSettled: false });
        results.push({ kind: 'inherited', result: inherited });
      }
      const observed = await runner.run(child, options);
      results.push({ kind: 'isolated', result: observed });
      children++;
      return fixture.run(command, options);
    });
    fixture.dependencies.runner = { run };
    try {
      expect(await fixture.observe()).toMatchObject({ sourceRepository: 'fixture/homebrew-tools' });
      expect(children).toBe(3);
      for (const [, options] of run.mock.calls) expect(options?.inheritEnvironment).toBe(false);
      expect(results.map(({ kind }) => kind)).toEqual(['inherited', 'isolated', 'isolated', 'isolated']);
      for (const { kind, result } of results) {
        expect(result.status, JSON.stringify({
          kind, errorCode: result.errorCode, errorMessage: result.errorMessage, stdout: result.stdout,
          stderr: result.stderr, timedOut: result.timedOut, signal: result.signal,
          processSpawned: result.processSpawned, processTreeSettled: result.processTreeSettled
        })).toBe(0);
        if (kind === 'inherited') expect(JSON.parse(result.stdout)).toMatchObject(parentOnly);
        else expect(JSON.parse(result.stdout)).toEqual({
          ...hostEnvironment,
          ...Object.fromEntries(Object.keys(parentOnly).map(key => [key, null])),
          npm_config_registry: 'https://fixture-mirror.test/npm', DO_NOT_TRACK: '1',
          LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: ''
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'https://github.com/fixture/homebrew-tools', 'https://github.com/fixture/homebrew-tools.git',
    'git@github.com:fixture/homebrew-tools', 'git@github.com:fixture/homebrew-tools.git',
    'ssh://git@github.com/fixture/homebrew-tools', 'ssh://git@github.com/fixture/homebrew-tools.git'
  ])('accepts only the explicitly approved repository in ordinary remote form %s', async remote => {
    const fixture = caskWorld();
    fixture.behavior.remote = remote;
    expect(await fixture.observe()).toMatchObject({ sourceRepository: fixture.policy.homebrew.sourceRepository });
  });

  it.each([
    'https://github.com/foreign/homebrew-tools.git', 'https://foreign.test/fixture/homebrew-tools.git',
    'https://user:password@github.com/fixture/homebrew-tools.git', '/local/foreign/tap',
    'https://github.com/fixture/homebrew-tools.git\nhttps://github.com/foreign/tap.git'
  ])('refuses foreign, credential-bearing or ambiguous tap remote %s', async remote => {
    const fixture = caskWorld();
    fixture.behavior.remote = remote;
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
  });

  it.each([
    { label: 'tap', fields: { tap: 'foreign/tools' } },
    { label: 'version', fields: { version: '0.13.0' } },
    { label: 'missing version', fields: { version: null } },
    { label: 'tap commit', fields: { tap_git_head: 'not-a-commit' } },
    { label: 'foreign source', fields: { path: '/foreign/Casks/liftoff.rb' } },
    { label: 'another token', fields: { path: '/opt/homebrew/Library/Taps/fixture/homebrew-tools/Casks/foreign.rb' } },
    { label: 'noncanonical source', fields: { path: '/opt/homebrew/Library/Taps/fixture/homebrew-tools/Casks/../Casks/liftoff.rb' } }
  ])('refuses receipt $label contradictions before running Git', async ({ fields }) => {
    const fixture = caskWorld();
    const receipt = fixture.receipt();
    Object.assign(receipt.source, fields);
    fixture.files.set(fixture.receiptPath, encode(receipt));
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'definition', 'config', 'directory'] as const)('refuses symlinked %s material rather than following manager attribution outside the prefix', async kind => {
    const fixture = caskWorld();
    const filename = kind === 'receipt' ? fixture.receiptPath : kind === 'definition' ? fixture.definitionPath :
      kind === 'config' ? fixture.configPath : fixture.caskRoot;
    fixture.world.nodes.set(filename, { kind: 'symlink', target: '/foreign/material' });
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'definition', 'config', 'head'] as const)('refuses changed %s during one ownership observation', async kind => {
    const fixture = caskWorld();
    const filename = kind === 'receipt' ? fixture.receiptPath : kind === 'definition' ? fixture.definitionPath : fixture.configPath;
    let reads = 0;
    if (kind === 'head') {
      fixture.behavior.onGit = () => { if (fixture.run.mock.calls.length === 3) fixture.behavior.head = 'f'.repeat(40); };
    } else {
      fixture.behavior.onRead = file => {
        if (file === filename && ++reads === 2) {
          const before = fixture.files.get(file)!;
          fixture.files.set(file, Buffer.concat([before.subarray(0, -1), Buffer.from(' ')]));
        }
      };
    }
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'owner_changed' });
  });

  it.each([
    { timedOut: true, expected: 'native_timeout' },
    { processTreeSettled: false, expected: 'native_unavailable' },
    { outputLimitExceeded: true, expected: 'native_unavailable' },
    { status: 1, expected: 'native_unavailable' }
  ])('refuses unsuccessful or unsettled bounded Git observation $expected', async ({ expected, ...result }) => {
    const fixture = caskWorld();
    fixture.behavior.result = result;
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: expected });
  });

  it('requires the selected native policy, exact Caskroom layout and actual ARM64 receipt, never a Homebrew npm prefix', async () => {
    const unqualified = caskWorld();
    unqualified.policy.homebrew.cask = null;
    await expect(unqualified.observe()).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(unqualified.readBytes).not.toHaveBeenCalled();
    const npm = caskWorld();
    npm.installation.bundleRoot = '/opt/homebrew/lib/node_modules/@msn-control/liftoff';
    await expect(npm.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(npm.readBytes).not.toHaveBeenCalled();
    const wrongArch = caskWorld();
    wrongArch.files.set(wrongArch.receiptPath, encode({ ...wrongArch.receipt(), arch: 'x86_64' }));
    await expect(wrongArch.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(wrongArch.run).not.toHaveBeenCalled();
  });

  it.each(['missing', 'malformed', 'oversized'] as const)('refuses %s receipt without fabricating cask ownership', async kind => {
    const fixture = caskWorld();
    if (kind === 'missing') fixture.files.delete(fixture.receiptPath);
    if (kind === 'malformed') fixture.files.set(fixture.receiptPath, Buffer.from('{'));
    if (kind === 'oversized') fixture.files.set(fixture.receiptPath, Buffer.alloc(256 * 1024 + 1));
    await expect(fixture.observe()).rejects.toMatchObject({
      reasonCode: kind === 'malformed' ? 'native_invalid' : 'unsupported_installation'
    });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each([
    { version: '../0.12.3' }, { version: '0.12.3-rc.1' }, { version: 'latest' },
    { target: 'darwin-x64' }, { packageRoot: '/foreign/application' }, { launcher: '/foreign/bin/liftoff' }
  ])('refuses invalid, escaping or mismatched bundle facts before reading receipts: %j', async fields => {
    const fixture = caskWorld();
    Object.assign(fixture.installation, fields);
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(fixture.readBytes).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('does not read or run a provider after cancellation', async () => {
    const fixture = caskWorld();
    fixture.controller.abort();
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(fixture.readBytes).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('passes the selected deadline and cancellation through local Git and never converts I/O or process errors into ownership', async () => {
    const fixture = caskWorld();
    fixture.dependencies.probeTimeoutMs = 2_000;
    await fixture.observe();
    expect(fixture.run.mock.calls.every(([, options]) => options?.timeoutMs === 2_000)).toBe(true);
    fixture.run.mockRejectedValue(new Error('fixture process failure with private detail'));
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'native_unavailable', message: 'native_unavailable' });
    fixture.readBytes.mockRejectedValue(Object.assign(new Error('fixture denied'), { code: 'EACCES' }));
    await expect(fixture.observe()).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
  });
});

describe('default authenticated selected-cask channel comparison', () => {
  function channelWorld() {
    const fixture = caskWorld();
    const signed = signedMaterial('darwin-arm64');
    Object.assign(fixture.policy, signed.policy);
    fixture.dependencies.readJson = async () => fixture.policy;
    fixture.files.set(fixture.definitionPath, Buffer.from(nativeCaskDefinition(signed.record, signed.qualification, signed.policy).content));
    const readStable = vi.fn(async () => signed.material);
    const installation: NativeInstallation = { ...fixture.installation, owner: 'homebrew-cask',
      managerId: fixture.policy.homebrew.cask!, managerSource: fixture.policy.homebrew.sourceRepository! };
    const port = createNativeUpgradePort(fixture.dependencies, { stable: { readStable } });
    return { ...fixture, signed, readStable, installation, port };
  }

  it('reobserves signed release material and the exact canonical selected definition, never exact execution', async () => {
    const fixture = channelWorld();
    const candidate = await fixture.port.stable(fixture.installation, fixture.world.neutralDirectory);
    expect(await fixture.port.channel(fixture.installation, candidate, fixture.world.neutralDirectory)).toMatchObject({
      status: 'available', version: candidate.version, artifactSha256: candidate.archiveSha256, exactApply: false,
      identity: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(fixture.readStable).toHaveBeenCalledTimes(2);
    expect(fixture.run).toHaveBeenCalledTimes(3);
    expect(fixture.run.mock.calls.every(([command]) => command.executable === 'git')).toBe(true);
    await expect(fixture.port.apply(fixture.installation, candidate, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'manual_handoff' });
    expect(fixture.run).toHaveBeenCalledTimes(3);
  });

  it.each(['different bytes', 'absent bytes', 'foreign repository', 'changed receipt', 'changed head'] as const)(
    'keeps %s unknown, never fabricated availability, lag or absence', async kind => {
      const fixture = channelWorld();
      const candidate = await fixture.port.stable(fixture.installation, fixture.world.neutralDirectory);
      if (kind === 'different bytes') fixture.files.set(fixture.definitionPath, Buffer.from('# unrelated or lagging local Ruby\n'));
      if (kind === 'absent bytes') fixture.files.delete(fixture.definitionPath);
      if (kind === 'foreign repository') fixture.behavior.remote = 'https://github.com/foreign/tap.git';
      if (kind === 'changed receipt') {
        const receipt = fixture.receipt();
        receipt.source.version = '0.13.0';
        fixture.files.set(fixture.receiptPath, encode(receipt));
      }
      if (kind === 'changed head') fixture.behavior.onGit = () => {
        if (fixture.run.mock.calls.length === 3) fixture.behavior.head = 'f'.repeat(40);
      };
      await expect(fixture.port.channel(fixture.installation, candidate, fixture.world.neutralDirectory))
        .rejects.toMatchObject({ reasonCode: 'channel_changed' });
    }
  );

  it('preserves an explicit disabled channel and refuses incomplete provider assertions', async () => {
    const fixture = channelWorld();
    const disabled = createNativeUpgradePort(fixture.dependencies, { stable: { readStable: fixture.readStable }, channel: undefined });
    const candidate = await disabled.stable(fixture.installation, fixture.world.neutralDirectory);
    await expect(disabled.channel(fixture.installation, candidate, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'channel_unavailable' });
    const incomplete = createNativeUpgradePort(fixture.dependencies, { stable: { readStable: fixture.readStable },
      cask: async () => ({
        fullToken: fixture.policy.homebrew.cask!, sourceRepository: fixture.policy.homebrew.sourceRepository!,
        bundleRoot: fixture.installation.bundleRoot, launcher: fixture.installation.launcher,
        installedVersion: fixture.installation.version
      }) });
    const admitted = await incomplete.stable(fixture.installation, fixture.world.neutralDirectory);
    await expect(incomplete.channel(fixture.installation, admitted, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'channel_unavailable' });
  });

  it('does not reuse prior material as fresh channel availability when the publisher observation fails', async () => {
    const fixture = channelWorld();
    const candidate = await fixture.port.stable(fixture.installation, fixture.world.neutralDirectory);
    fixture.readStable.mockRejectedValue(new Error('fixture-only offline observation'));
    await expect(fixture.port.channel(fixture.installation, candidate, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'channel_unavailable' });
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
