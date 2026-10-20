import path from 'node:path';
import os from 'node:os';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSelfUpgrade } from '../src/application/upgrade/self-upgrade.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { readOnlyEnvironment } from '../src/domain/distribution/liftoff-npm-installation.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('npm upgrade supplied-environment boundary', () => {
  it.each(['check', 'apply'] as const)('preserves only the caller npm context in real %s subprocesses', async mode => {
    const fixture = upgradeWorld({ platform: process.platform === 'win32' ? 'win32' : 'linux', mode });
    const supplied: NodeJS.ProcessEnv = {
      PATH: path.dirname(process.execPath),
      HOME: '/fixture/caller-home',
      USERPROFILE: '/fixture/caller-home',
      npm_config_registry: 'https://caller-mirror.invalid/',
      npm_config_userconfig: '/fixture/caller-account.npmrc',
      npm_config_prefix: '/fixture/caller-prefix',
      npm_config_logs_dir: '/fixture/caller-logs',
      NODE_OPTIONS: '--require=caller-code-must-not-run',
      NODE_PATH: '/fixture/caller-node-path'
    };
    const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (process.platform === 'win32') {
      if (!systemRoot) throw new Error('The native Windows child fixture requires the caller SystemRoot.');
      supplied.SystemRoot = systemRoot;
    }
    const neutralDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-npm-env-')));
    directories.push(neutralDirectory);
    fixture.dependencies.makeNeutralDirectory = async () => neutralDirectory;
    fixture.dependencies.environment = supplied;
    vi.stubEnv('LIFTOFF_NPM_PARENT_ONLY_FIXTURE', 'parent-only');
    vi.stubEnv('NPM_CONFIG_GLOBALCONFIG', '/fixture/parent-account-must-not-leak.npmrc');
    const inspector = {
      executable: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({' +
        'parent:process.env.LIFTOFF_NPM_PARENT_ONLY_FIXTURE??null,' +
        'globalconfig:process.env.NPM_CONFIG_GLOBALCONFIG??null,' +
        'registry:process.env.npm_config_registry,userconfig:process.env.npm_config_userconfig,' +
        'prefix:process.env.npm_config_prefix,home:process.env.HOME,logs:process.env.npm_config_logs_dir,' +
        'telemetry:process.env.LIFTOFF_TELEMETRY,tracking:process.env.DO_NOT_TRACK,' +
        'nodeOptions:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH,' +
        'systemRoot:process.env.SystemRoot??null}))']
    };
    const runner = new NodeCommandRunner();
    const inherited = await runner.run(inspector, {
      env: { NODE_OPTIONS: '', NODE_PATH: '' }, ensureProcessTreeSettled: false,
      timeoutMs: 15_000, maxOutputBytes: 8192
    });
    expect(inherited).toMatchObject({ status: 0, timedOut: false, signal: null });
    expect(JSON.parse(inherited.stdout)).toMatchObject({
      parent: 'parent-only', globalconfig: '/fixture/parent-account-must-not-leak.npmrc'
    });
    const observed: string[] = [];
    const original = fixture.dependencies.runner;
    fixture.dependencies.runner = {
      run: async (command, options) => {
        expect(options?.inheritEnvironment).toBe(false);
        expect(options?.ensureProcessTreeSettled).toBe(true);
        expect(options?.cwd).toBe(neutralDirectory);
        // The fixture owns npm/filesystem responses; only a harmless Node child
        // receives the actual production environment and settlement options.
        const child = await runner.run(inspector, { ...options, stream: false });
        expect(child).toMatchObject({ status: 0, timedOut: false, signal: null });
        expect(child.errorCode).toBeUndefined();
        expect(child.processTreeSettled).not.toBe(false);
        expect(JSON.parse(child.stdout)).toEqual({
          parent: null, globalconfig: null,
          registry: supplied.npm_config_registry, userconfig: supplied.npm_config_userconfig,
          prefix: supplied.npm_config_prefix, home: supplied.HOME,
          logs: path.join(neutralDirectory, 'npm-cache', '_logs'),
          telemetry: '0', tracking: '1', nodeOptions: '', nodePath: '',
          systemRoot: systemRoot && process.platform === 'win32' ? systemRoot : null
        });
        observed.push(command.args[0]);
        return original.run(command, options);
      }
    };
    await expect(runSelfUpgrade(fixture.request, fixture.dependencies)).resolves.toMatchObject({
      status: mode === 'check' ? 'update-available' : 'upgraded',
      installationOwner: 'npm', verification: mode === 'check' ? 'not-run' : 'verified'
    });
    expect(observed).toContain('root');
    expect(observed).toContain('config');
    expect(observed).toContain('view');
    if (mode === 'apply') {
      expect(observed).toContain('install');
      expect(observed).toContain(fixture.world.binary);
    } else expect(observed).not.toContain('install');
    expect(supplied.NODE_OPTIONS).toBe('--require=caller-code-must-not-run');
  });
});

const npm = process.env.npm_execpath;
describe.skipIf(!npm || path.basename(npm) !== 'npm-cli.js')('actual npm debug-log isolation', () => {
  it.each(['user config', 'lowercase environment', 'uppercase environment', 'hyphenated environment'] as const)(
    'keeps a configured debug log directory private when selected by %s', async source => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-npm-logs-')));
      directories.push(root);
      const neutralDirectory = path.join(root, 'neutral');
      const logs = path.join(root, 'caller-logs');
      const cache = path.join(root, 'caller-cache');
      const account = path.join(root, 'account.npmrc');
      const globalConfig = path.join(root, 'global.npmrc');
      for (const directory of [neutralDirectory, logs, cache]) await mkdir(directory);
      await writeFile(path.join(logs, 'marker'), 'caller logs remain unchanged\n');
      await writeFile(path.join(cache, 'marker'), 'caller cache remains unchanged\n');
      await writeFile(globalConfig, '');
      const preferences = `logs-dir=${JSON.stringify(logs)}\n` +
        'registry=https://fixture-default.invalid/\n@msn-control:registry=https://fixture-scoped.invalid/\n';
      await writeFile(account, preferences, { mode: 0o400 });
      const before = await lstat(account);
      const environment: NodeJS.ProcessEnv = {
        PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root,
        npm_config_userconfig: account, npm_config_globalconfig: globalConfig,
        npm_config_cache: cache, npm_config_prefix: path.join(root, 'caller-prefix')
      };
      if (source !== 'user config') {
        const key = source === 'lowercase environment' ? 'npm_config_logs_dir'
          : source === 'uppercase environment' ? 'NPM_CONFIG_LOGS_DIR' : 'npm_config_logs-dir';
        environment[key] = logs;
      }
      const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
      if (process.platform === 'win32') {
        if (!systemRoot) throw new Error('The native Windows npm fixture requires the caller SystemRoot.');
        environment.SystemRoot = systemRoot;
      }
      const original = { ...environment };
      const result = await new NodeCommandRunner().run(
        { executable: process.execPath, args: [npm!, 'config', 'get', 'logs-dir'] },
        {
          cwd: neutralDirectory, env: readOnlyEnvironment({ environment }, neutralDirectory),
          inheritEnvironment: false, ensureProcessTreeSettled: true,
          timeoutMs: 15_000, maxOutputBytes: 8192
        }
      );
      expect(result, result.stderr).toMatchObject({ status: 0, signal: null, timedOut: false });
      expect(result.errorCode).toBeUndefined();
      expect(result.processTreeSettled).not.toBe(false);
      expect(await readdir(logs)).toEqual(['marker']);
      expect(result.stdout.trim()).toBe(path.join(neutralDirectory, 'npm-cache', '_logs'));
      const privateLogs = await readdir(path.join(neutralDirectory, 'npm-cache', '_logs'), { withFileTypes: true });
      expect(privateLogs.some(entry => entry.isFile() && entry.name.endsWith('.log'))).toBe(true);
      expect(await readdir(cache)).toEqual(['marker']);
      expect(await readFile(path.join(logs, 'marker'), 'utf8')).toBe('caller logs remain unchanged\n');
      expect(await readFile(path.join(cache, 'marker'), 'utf8')).toBe('caller cache remains unchanged\n');
      expect(await readFile(account, 'utf8')).toBe(preferences);
      const after = await lstat(account);
      expect([after.dev, after.ino, after.mode, after.size, after.mtimeMs])
        .toEqual([before.dev, before.ino, before.mode, before.size, before.mtimeMs]);
      expect(environment).toEqual(original);
    }
  );
});
