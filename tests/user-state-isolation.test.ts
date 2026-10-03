import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getUpdatePreviewDirectory } from '../src/adapters/filesystem/update-previews.js';
import { getTelemetryConfigPath } from '../src/telemetry/config.js';
import {
  isCredentialVariable,
  isolateUserState,
  isolatedUserStateEnvironment,
  removeRunOwnedDirectory,
  suppressedCredentialVariables,
  userStatePrefix,
  userStateRootVariable,
  type UserStateIsolationHost
} from './setup/user-state-isolation.js';

const repository = process.cwd();
const vitestCli = path.join(repository, 'node_modules', 'vitest', 'vitest.mjs');
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
// Stores canonicalize their base (macOS /var -> /private/var); the removed root
// is canonicalized through its surviving parent, the system temporary directory.
const inside = (root: string, file: string) =>
  within(root, file) || within(path.join(realpathSync(path.dirname(root)), path.basename(root)), file);

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

function syntheticHost(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, failures: { remove?: boolean; write?: boolean } = {}) {
  const calls: string[] = [];
  const host: UserStateIsolationHost = {
    env,
    platform,
    temporaryDirectory: platform === 'win32' ? 'D:\\synthetic\\temp' : '/synthetic/tmp',
    makeTemporaryDirectory: (prefix) => { calls.push(`mkdtemp ${prefix}`); return `${prefix}fixed`; },
    makeDirectory: (directory) => { calls.push(`mkdir ${directory}`); },
    writeEmptyFile: (file) => {
      calls.push(`touch ${file}`);
      if (failures.write) throw new Error('synthetic write failure');
    },
    removeDirectory: (directory) => {
      calls.push(`rm ${directory}`);
      if (failures.remove) throw new Error('synthetic cleanup failure');
    }
  };
  return { host, calls };
}

describe('run-owned test user state', () => {
  it('gives this run a fresh temporary profile without ambient gh, az or npm credentials', () => {
    const root = process.env[userStateRootVariable]!;
    expect(root).toBeTruthy();
    expect(path.basename(root).startsWith(userStatePrefix)).toBe(true);
    expect(realpathSync(path.dirname(root))).toBe(realpathSync(os.tmpdir()));
    expect(statSync(root).isDirectory()).toBe(true);
    const expected = isolatedUserStateEnvironment(root);
    for (const [name, value] of Object.entries(expected)) expect(process.env[name], name).toBe(value);
    expect(os.homedir()).toBe(expected.HOME);
    expect(Object.keys(process.env).filter(isCredentialVariable)).toEqual([]);
    expect(inside(root, getUpdatePreviewDirectory())).toBe(true);
    expect(inside(root, getTelemetryConfigPath())).toBe(true);
    for (const name of ['AZURE_CONFIG_DIR', 'GH_CONFIG_DIR', 'npm_config_cache']) {
      expect(statSync(process.env[name]!).isDirectory(), name).toBe(true);
    }
    expect(readFileSync(process.env.npm_config_userconfig!, 'utf8')).toBe('');
    expect(readFileSync(process.env.npm_config_globalconfig!, 'utf8')).toBe('');
    expect(readFileSync(process.env.GOENV!, 'utf8')).toBe('');
    for (const name of ['GOPATH', 'GOMODCACHE', 'GOCACHE']) {
      expect(inside(root, process.env[name]!), name).toBe(true);
      expect(statSync(process.env[name]!).isDirectory(), name).toBe(true);
    }
  });

  it.each(['linux', 'darwin', 'win32'] as const)('uses each client default relative to the isolated %s home', (platform) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? 'D:\\t\\lus-a' : '/t/lus-a';
    const home = paths.join(root, 'h');
    const values = isolatedUserStateEnvironment(root, platform);
    expect(values).toMatchObject({
      HOME: home, USERPROFILE: home,
      APPDATA: paths.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: paths.join(home, 'AppData', 'Local'),
      AZURE_CONFIG_DIR: paths.join(home, '.azure'), npm_config_userconfig: paths.join(home, '.npmrc'),
      npm_config_globalconfig: paths.join(home, '.npmrc-global'), NPM_CONFIG_GLOBALCONFIG: paths.join(home, '.npmrc-global'),
      [userStateRootVariable]: root
    });
    expect(values.NPM_CONFIG_USERCONFIG).toBe(values.npm_config_userconfig);
    expect(values.NPM_CONFIG_CACHE).toBe(values.npm_config_cache);
    expect(values).toMatchObject({
      AZURE_CORE_COLLECT_TELEMETRY: 'false', npm_config_update_notifier: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false'
    });
    expect(values.GOPATH).toBe(paths.join(home, 'go'));
    expect(values.GOMODCACHE).toBe(paths.join(home, 'go', 'pkg', 'mod'));
    expect(values.GOCACHE).toBe({
      win32: paths.join(home, 'AppData', 'Local', 'go-build'),
      darwin: paths.join(home, 'Library', 'Caches', 'go-build'),
      linux: paths.join(home, '.cache', 'go-build')
    }[platform]);
    expect(values.GOENV).toBe({
      win32: paths.join(home, 'AppData', 'Roaming', 'go', 'env'),
      darwin: paths.join(home, 'Library', 'Application Support', 'go', 'env'),
      linux: paths.join(home, '.config', 'go', 'env')
    }[platform]);
    if (platform === 'win32') {
      expect(values.GH_CONFIG_DIR).toBe(paths.join(home, 'AppData', 'Roaming', 'GitHub CLI'));
      expect(values.npm_config_cache).toBe(paths.join(home, 'AppData', 'Local', 'npm-cache'));
      for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
        expect(Object.hasOwn(values, name) && values[name] === undefined, name).toBe(true);
      }
    } else {
      expect(values).toMatchObject({
        GH_CONFIG_DIR: paths.join(home, '.config', 'gh'), npm_config_cache: paths.join(home, '.npm'),
        XDG_CONFIG_HOME: paths.join(home, '.config'), XDG_STATE_HOME: paths.join(home, '.local', 'state'),
        XDG_CACHE_HOME: paths.join(home, '.cache'), XDG_DATA_HOME: paths.join(home, '.local', 'share')
      });
    }
  });

  it('suppresses gh, az and npm credential inputs but keeps registry, path and host settings', () => {
    for (const name of [...suppressedCredentialVariables, 'npm_config__auth', 'NPM_CONFIG__AUTHTOKEN',
      'npm_config_//registry.example/:_authToken', 'npm_config_//registry.example/:_password',
      'gh_token', 'Github_Token', 'Azure_Client_Secret', 'npm_token', 'node_auth_token']) {
      expect(isCredentialVariable(name), name).toBe(true);
    }
    for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'npm_config_registry', 'npm_config_@scope:registry',
      'npm_config_userconfig', 'npm_config_cache', 'npm_config_user_agent', 'AZURE_CONFIG_DIR', 'GH_HOST']) {
      expect(isCredentialVariable(name), name).toBe(false);
    }
  });

  it('restores the exact previous environment and removes only the directory it created', () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/real/home', PATH: '/usr/bin', XDG_CONFIG_HOME: '/real/config', GH_TOKEN: 'synthetic-token',
      gh_token: 'synthetic-lower', Azure_Client_Secret: 'synthetic-mixed', npm_config_globalconfig: '/real/etc/npmrc',
      GOPATH: '/real/go', GOMODCACHE: '/real/go/pkg/mod', GOCACHE: '/real/cache/go-build', GOENV: '/real/config/go/env',
      'npm_config_//registry.example/:_authToken': 'synthetic-npm', [userStateRootVariable]: '/outer/lus-parent'
    };
    const before = { ...env };
    const { host, calls } = syntheticHost(env, 'linux');
    const teardown = isolateUserState(host);
    expect(env.HOME).toBe('/synthetic/tmp/lus-fixed/h');
    expect(env[userStateRootVariable]).toBe('/synthetic/tmp/lus-fixed');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.gh_token).toBeUndefined();
    expect(env.Azure_Client_Secret).toBeUndefined();
    expect(env.npm_config_globalconfig).toBe('/synthetic/tmp/lus-fixed/h/.npmrc-global');
    expect(env.GOPATH).toBe('/synthetic/tmp/lus-fixed/h/go');
    expect(env.GOMODCACHE).toBe('/synthetic/tmp/lus-fixed/h/go/pkg/mod');
    expect(env.GOCACHE).toBe('/synthetic/tmp/lus-fixed/h/.cache/go-build');
    expect(env.GOENV).toBe('/synthetic/tmp/lus-fixed/h/.config/go/env');
    expect(env['npm_config_//registry.example/:_authToken']).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(calls[0]).toBe('mkdtemp /synthetic/tmp/lus-');
    expect(calls).toContain('touch /synthetic/tmp/lus-fixed/h/.npmrc');
    expect(calls).toContain('touch /synthetic/tmp/lus-fixed/h/.npmrc-global');
    expect(calls).toContain('touch /synthetic/tmp/lus-fixed/h/.config/go/env');
    teardown();
    expect(env).toEqual(before);
    expect(calls.filter((call) => call.startsWith('rm '))).toEqual(['rm /synthetic/tmp/lus-fixed']);
  });

  it('restores the environment and fails the run when cleanup fails', () => {
    const env: NodeJS.ProcessEnv = { USERPROFILE: 'C:\\Users\\real', LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local', XDG_STATE_HOME: 'C:\\xdg' };
    const before = { ...env };
    const { host, calls } = syntheticHost(env, 'win32', { remove: true });
    const teardown = isolateUserState(host);
    expect(env.USERPROFILE).toBe('D:\\synthetic\\temp\\lus-fixed\\h');
    expect(env.XDG_STATE_HOME).toBeUndefined();
    expect(() => teardown()).toThrow('Unable to remove the isolated test user-state root D:\\synthetic\\temp\\lus-fixed: synthetic cleanup failure');
    expect(env).toEqual(before);
    expect(calls.filter((call) => call.startsWith('rm '))).toEqual(['rm D:\\synthetic\\temp\\lus-fixed']);
  });

  it('removes read-only tool caches inside the run root without following links out of it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lus-cleanup-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'liftoff outside target '));
    cleanups.push(root, outside);
    const cache = path.join(root, 'h', 'go', 'pkg', 'mod', 'golang.org', 'x', 'sync@v0.0.0');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'go.mod'), 'module golang.org/x/sync\n');
    await writeFile(path.join(outside, 'kept.txt'), 'outside\n');
    await chmod(path.join(outside, 'kept.txt'), 0o444);
    if (process.platform !== 'win32') symlinkSync(outside, path.join(root, 'h', 'link-out'));
    chmodSync(path.join(cache, 'go.mod'), 0o444);
    for (const directory of [cache, path.dirname(cache), path.dirname(path.dirname(cache))]) chmodSync(directory, 0o555);
    removeRunOwnedDirectory(root);
    expect(existsSync(root)).toBe(false);
    expect(await readFile(path.join(outside, 'kept.txt'), 'utf8')).toBe('outside\n');
    if (process.platform !== 'win32') expect(statSync(path.join(outside, 'kept.txt')).mode & 0o777).toBe(0o444);
    await chmod(path.join(outside, 'kept.txt'), 0o644);
  });

  it('leaves the environment untouched and removes its own root when setup fails', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/real/home' };
    const { host, calls } = syntheticHost(env, 'darwin', { write: true });
    expect(() => isolateUserState(host)).toThrow('synthetic write failure');
    expect(env).toEqual({ HOME: '/real/home' });
    expect(calls.filter((call) => call.startsWith('rm '))).toEqual(['rm /synthetic/tmp/lus-fixed']);
  });
});

describe('sentinel profiles stay untouched by root test runs', () => {
  const credentialNames = ['GH_TOKEN', 'AZURE_CLIENT_SECRET', 'NPM_TOKEN', 'npm_config_//registry.example/:_authToken'];

  async function fixture(config: 'isolated' | 'unisolated' | 'failing-cleanup') {
    const cache = path.join(repository, '.cache');
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(path.join(cache, 'user-state isolation '));
    cleanups.push(root);
    const sentinel = await mkdtemp(path.join(os.tmpdir(), 'liftoff sentinel profile '));
    cleanups.push(sentinel);
    const exported = {
      home: path.join(sentinel, 'home'), azure: path.join(sentinel, 'azure'), gh: path.join(sentinel, 'gh'),
      npmrc: path.join(sentinel, 'npmrc'), cache: path.join(sentinel, 'npm-cache'),
      globalconfig: path.join(sentinel, 'global-npmrc'),
      gopath: path.join(sentinel, 'gopath'), gomodcache: path.join(sentinel, 'gomodcache'),
      gocache: path.join(sentinel, 'gocache'), goenv: path.join(sentinel, 'goenv')
    };
    for (const directory of [exported.home, exported.azure, exported.gh, exported.cache, exported.gopath, exported.gomodcache, exported.gocache]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(exported.goenv, 'GOFLAGS=-sentinel-must-not-be-read\n');
    await writeFile(exported.npmrc, '# sentinel user config\n');
    await writeFile(exported.globalconfig, '# sentinel global config\n');
    const relative = (target: string) => path.relative(path.join(root, 'tests'), target).split(path.sep).join('/');
    const configImport = path.relative(root, path.join(repository, 'vitest.config.ts')).split(path.sep).join('/');
    const setupImport = path.relative(root, path.join(repository, 'tests', 'setup', 'user-state-isolation.ts')).split(path.sep).join('/');
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await mkdir(path.join(root, 'project'), { recursive: true });
    await writeFile(path.join(root, 'vitest.config.mjs'), {
      isolated: `
import rootConfig from ${JSON.stringify(configImport)};
export default { ...rootConfig, root: ${JSON.stringify(root)} };
`,
      unisolated: `
export default { root: ${JSON.stringify(root)}, test: { include: ['tests/**/*.test.ts'] } };
`,
      'failing-cleanup': `
export default { root: ${JSON.stringify(root)}, test: { include: ['tests/**/*.test.ts'], globalSetup: ['./failing-setup.ts'] } };
`
    }[config]);
    await writeFile(path.join(root, 'failing-setup.ts'), `
import { isolateUserState, nodeUserStateIsolationHost } from ${JSON.stringify(setupImport)};
export default function setup() {
  return isolateUserState({ ...nodeUserStateIsolationHost(), removeDirectory: () => { throw new Error('synthetic cleanup failure'); } });
}
`);
    await writeFile(path.join(root, 'tests', 'records.test.ts'), `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveUpdatePreviewLocation } from ${JSON.stringify(relative(path.join(repository, 'src', 'adapters', 'filesystem', 'update-previews.ts')))};
import { getTelemetryConfigPath, recordTelemetryNotice } from ${JSON.stringify(relative(path.join(repository, 'src', 'telemetry', 'config.ts')))};
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
it('writes Liftoff and client records through their default user-local locations', async () => {
  const location = await resolveUpdatePreviewLocation(path.join(process.env.FIXTURE_ROOT, 'project'));
  expect(await recordTelemetryNotice()).toBe(true);
  const cache = run('npm', ['config', 'get', 'cache']);
  const userconfig = run('npm', ['config', 'get', 'userconfig']);
  const globalconfig = run('npm', ['config', 'get', 'globalconfig']);
  const az = run('az', ['version', '--output', 'none', '--only-show-errors']);
  const go = run('go', ['env', '-json', 'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOENV', 'GOFLAGS']);
  writeFileSync(path.join(process.env.FIXTURE_ROOT, 'report.json'), JSON.stringify({
    root: process.env.LIFTOFF_TEST_USER_STATE_ROOT ?? null, home: os.homedir(),
    previews: location.directory, telemetry: getTelemetryConfigPath(),
    npmCache: cache.status === 0 ? cache.stdout.trim() : null,
    npmUserconfig: userconfig.status === 0 ? userconfig.stdout.trim() : null,
    npmGlobalconfig: globalconfig.status === 0 ? globalconfig.stdout.trim() : null,
    azRan: az.status === 0,
    goEnv: go.status === 0 ? JSON.parse(go.stdout) : null,
    overrides: { AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR },
    credentials: ${JSON.stringify(credentialNames)}.filter((name) => process.env[name] !== undefined)
  }));
});
`);
    // A top-level npm test process: no inherited Vitest worker or isolation markers.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', userStateRootVariable]) delete env[name];
    Object.assign(env, {
      HOME: exported.home, USERPROFILE: exported.home,
      APPDATA: path.join(exported.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(exported.home, 'AppData', 'Local'),
      AZURE_CONFIG_DIR: exported.azure, GH_CONFIG_DIR: exported.gh,
      npm_config_userconfig: exported.npmrc, NPM_CONFIG_USERCONFIG: exported.npmrc,
      npm_config_cache: exported.cache, NPM_CONFIG_CACHE: exported.cache,
      npm_config_globalconfig: exported.globalconfig, NPM_CONFIG_GLOBALCONFIG: exported.globalconfig,
      GOPATH: exported.gopath, GOMODCACHE: exported.gomodcache, GOCACHE: exported.gocache, GOENV: exported.goenv,
      FIXTURE_ROOT: root, CI: 'true', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
      // Keeps az from starting a detached telemetry upload that outlives the test.
      AZURE_CORE_COLLECT_TELEMETRY: 'false'
    }, Object.fromEntries(credentialNames.map((name) => [name, 'synthetic-sentinel-credential'])));
    const result = spawnSync(process.execPath, [vitestCli, 'run', '--config', 'vitest.config.mjs'], {
      cwd: root, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024
    });
    const reportPath = path.join(root, 'report.json');
    const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : undefined;
    if (report?.root) cleanups.push(report.root);
    return { result, report, sentinel, exported };
  }

  it('isolates Vitest runner state, Liftoff records, exported client overrides and credentials in a real root-config run', async () => {
    const { result, report, sentinel, exported } = await fixture('isolated');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(report.root).toEqual(expect.any(String));
    expect(inside(sentinel, report.root)).toBe(false);
    expect(report.home).toBe(path.join(report.root, 'h'));
    for (const file of [report.previews, report.telemetry, report.overrides.AZURE_CONFIG_DIR, report.overrides.GH_CONFIG_DIR]) {
      expect(inside(report.root, file), file).toBe(true);
    }
    const available = (command: string) => spawnSync(command, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 }).status === 0;
    // Real clients prove the overrides whenever they exist on this host.
    if (available('npm')) expect(report.npmCache && report.npmUserconfig && report.npmGlobalconfig).toBeTruthy();
    if (spawnSync('go', ['version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 }).status === 0) {
      expect(report.goEnv).not.toBeNull();
    }
    if (report.npmCache !== null) expect(inside(report.root, report.npmCache)).toBe(true);
    if (report.npmUserconfig !== null) expect(inside(report.root, report.npmUserconfig)).toBe(true);
    if (report.npmGlobalconfig !== null) expect(inside(report.root, report.npmGlobalconfig)).toBe(true);
    if (report.goEnv !== null) {
      for (const name of ['GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOENV']) expect(inside(report.root, report.goEnv[name]), name).toBe(true);
      expect(report.goEnv.GOFLAGS).toBe('');
    }
    expect(report.credentials).toEqual([]);
    expect(existsSync(report.root), 'the run-owned root is removed at teardown').toBe(false);
    expect(files(sentinel)).toEqual(['global-npmrc', 'goenv', 'npmrc']);
    expect(await readFile(exported.goenv, 'utf8')).toBe('GOFLAGS=-sentinel-must-not-be-read\n');
    expect(await readFile(exported.npmrc, 'utf8')).toBe('# sentinel user config\n');
    expect(await readFile(exported.globalconfig, 'utf8')).toBe('# sentinel global config\n');
  }, 120_000);

  it('reproduces the leak without the harness, proving the setup is what isolates', async () => {
    const { result, report, sentinel } = await fixture('unisolated');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(report.root).toBeNull();
    expect(report.home).toBe(path.join(sentinel, 'home'));
    expect(report.credentials).toEqual(credentialNames);
    expect(files(sentinel).some((file) => file.split('/').includes('liftoff'))).toBe(true);
  }, 120_000);

  it('isolates once per process and still removes the root when a run stops before global teardown', async () => {
    const sentinel = await mkdtemp(path.join(os.tmpdir(), 'liftoff sentinel profile '));
    cleanups.push(sentinel);
    const module = pathToFileURL(path.join(repository, 'tests', 'setup', 'user-state-isolation.ts')).href;
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    Object.assign(env, { HOME: sentinel, USERPROFILE: sentinel, XDG_DATA_HOME: path.join(sentinel, 'data'), LOCALAPPDATA: path.join(sentinel, 'local') });
    delete env[userStateRootVariable];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { isolateProcessUserState } = await import(${JSON.stringify(module)});
const first = isolateProcessUserState();
const second = isolateProcessUserState();
process.stdout.write(JSON.stringify({ same: first === second, root: first.root, home: process.env.HOME }));
`], { env, encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.same).toBe(true);
    expect(observed.home).toBe(path.join(observed.root, 'h'));
    expect(inside(sentinel, observed.root)).toBe(false);
    expect(existsSync(observed.root), 'the exit fallback removes the run-owned root').toBe(false);
    expect(files(sentinel)).toEqual([]);
  }, 60_000);

  it('fails the run when the isolated root cannot be removed', async () => {
    const { result, report } = await fixture('failing-cleanup');
    expect(report.root).toEqual(expect.any(String));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('synthetic cleanup failure');
  }, 120_000);
});
