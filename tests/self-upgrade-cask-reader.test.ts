import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHomebrewCaskOwnership } from '../src/adapters/distribution/native-cask.js';
import { assertCaskOwnership } from '../src/adapters/distribution/native.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import type { NativeBundleInventory, NativeReleasePolicy } from '../src/domain/distribution/native-upgrade.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';

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
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf cask child env ')));
    const parentOnly = {
      GIT_DIR: '/parent-only-fixture', GIT_CONFIG_PARAMETERS: 'fixture-parent-config',
      GIT_ASKPASS: '/parent-only-never-executed-helper', GH_TOKEN: 'fixture-parent-only-not-a-credential',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.key', GIT_CONFIG_VALUE_0: 'fixture-value',
      HTTP_PROXY: 'http://parent-proxy.invalid', NPM_CONFIG_REGISTRY: 'https://parent-registry.invalid',
      LIFTOFF_CASK_PARENT_ONLY_FIXTURE: 'fixture-parent-only'
    };
    for (const [key, value] of Object.entries(parentOnly)) vi.stubEnv(key, value);
    const inspector = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([
      ...Object.keys(parentOnly), 'npm_config_registry', 'DO_NOT_TRACK', 'LIFTOFF_TELEMETRY', 'NODE_OPTIONS', 'NODE_PATH'
    ])}.map(key=>[key,process.env[key] ?? null]))))`;
    fixture.world.neutralDirectory = directory;
    const runner = new NodeCommandRunner();
    let children = 0;
    fixture.dependencies.runner = { run: vi.fn<CommandRunner['run']>(async (command, options) => {
      expect(options?.inheritEnvironment).toBe(false);
      const child = { executable: process.execPath, args: ['-e', inspector] };
      if (children === 0) {
        const inherited = await runner.run(child, { ...options, inheritEnvironment: undefined });
        expect(inherited.status).toBe(0);
        expect(JSON.parse(inherited.stdout)).toMatchObject(parentOnly);
      }
      const observed = await runner.run(child, options);
      expect(observed.status).toBe(0);
      expect(JSON.parse(observed.stdout)).toEqual({
        ...Object.fromEntries(Object.keys(parentOnly).map(key => [key, null])),
        npm_config_registry: 'https://fixture-mirror.test/npm', DO_NOT_TRACK: '1',
        LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: ''
      });
      children++;
      return fixture.run(command, options);
    }) };
    try {
      expect(await fixture.observe()).toMatchObject({ sourceRepository: 'fixture/homebrew-tools' });
      expect(children).toBe(3);
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
