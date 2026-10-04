import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationConfigurationFiles, applicationPreparationEnvironment, createApplicationEnvironment, withoutApplicationDependencyNetwork } from '../src/application/repair/application-environment.js';
import { applicationPackageSources } from '../src/application/repair/application-preparation-policy.js';
import { CapturedApplicationProtection } from '../src/application/repair/application-protection.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { TemporaryDirectories } from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(() => directories.cleanup());

async function fixture() {
  const root = await directories.make('liftoff application environment ');
  const env = await createApplicationEnvironment(process.env, path.join(root, 'project'), path.join(root, 'stage'), root);
  const mode = path.join(env.HOME!, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : []),
    'go', 'telemetry', 'mode');
  const protection = new CapturedApplicationProtection({ files: [], directories: [], outputRoles: [], toolchain: [] }, root);
  return { root, env, mode, protection };
}

describe('private application tool configuration', () => {
  it.each([
    ['npm-ci', 'npmjs'], ['npm-ci', 'microsoft-npm'],
    ['uv-locked-sync', 'pypi'], ['uv-locked-sync', 'microsoft-pypi'],
    ['go-mod-download', 'go-proxy']
  ] as const)('keeps %s / %s preparation confined to its selected private component and declared network', (provider, packageSource) => {
    const roles = { project: path.resolve('owned', 'project'), cache: path.resolve('owned', 'cache') };
    const base = Object.freeze({ HOME: path.resolve('owned', 'home'), GOTOOLCHAIN: 'local', UV_NO_BUILD: '1' });
    for (const network of [false, true]) {
      const entry = { provider, packageSource, registry: applicationPackageSources[packageSource].registry,
        cwdPathParts: ['Source Space', 'backend'], network };
      const env = applicationPreparationEnvironment(base, roles, entry);
      expect(env.LIFTOFF_APPLICATION_NETWORK).toBe(network ? 'declared-allowed' : 'not-authorized');
      expect(env.HOME).toBe(base.HOME);
      expect(env.GOTOOLCHAIN).toBe('local');
      expect(env.UV_NO_BUILD).toBe('1');
      if (provider === 'npm-ci') {
        expect(env).toMatchObject({
          npm_config_prefix: path.join(roles.project, ...entry.cwdPathParts),
          npm_config_cache: path.join(roles.cache, 'npm', 'Source Space-backend'),
          npm_config_registry: entry.registry, npm_config_offline: network ? 'false' : 'true',
          npm_config_ignore_scripts: 'true', npm_config_replace_registry_host: 'never'
        });
        expect(env.npm_config_allow_remote).toBe(packageSource === 'microsoft-npm' ? 'all' : undefined);
      } else if (provider === 'uv-locked-sync') {
        expect(env).toMatchObject({
          UV_PROJECT_ENVIRONMENT: path.join(roles.project, ...entry.cwdPathParts, '.venv'),
          UV_CACHE_DIR: path.join(roles.cache, 'uv', 'Source Space-backend'), UV_DEFAULT_INDEX: entry.registry,
          UV_OFFLINE: network ? '0' : '1', PIP_NO_INDEX: network ? '0' : '1'
        });
      } else {
        expect(env).toMatchObject({
          GOPATH: path.join(roles.cache, 'go-path', 'Source Space-backend'),
          GOMODCACHE: path.join(roles.cache, 'go-mod', 'Source Space-backend'),
          GOCACHE: path.join(roles.cache, 'go-build', 'Source Space-backend'),
          GOPROXY: network ? entry.registry : 'off', GOSUMDB: network ? 'sum.golang.org' : 'off'
        });
      }
      const before = { ...env };
      expect(withoutApplicationDependencyNetwork(env)).toEqual({
        ...env, PIP_NO_INDEX: '1', UV_OFFLINE: '1', npm_config_offline: 'true', GOPROXY: 'off', GOSUMDB: 'off'
      });
      expect(env).toEqual(before);
    }
    expect(base).toEqual({ HOME: path.resolve('owned', 'home'), GOTOOLCHAIN: 'local', UV_NO_BUILD: '1' });
  });

  it('disables Go counters in the actual private configuration before any tool starts', async () => {
    const { env, mode, protection } = await fixture();
    expect(await readFile(mode, 'utf8')).toBe('off\n');
    expect(env.GOTELEMETRY).toBeUndefined();
    expect(env.GOENV).toBe('off');
    await protection.captureControls();
    await protection.assertCurrent();
  });

  it.each([
    ['darwin', ['Library', 'Application Support', 'go', 'telemetry', 'mode']],
    ['linux', ['go', 'telemetry', 'mode']],
    ['win32', ['go', 'telemetry', 'mode']]
  ] as const)('uses the %s private HOME/APPDATA/XDG configuration, not GOENV', (platform, expected) => {
    const files = applicationConfigurationFiles(platform);
    expect(files).toHaveLength(5);
    expect(files.slice(0, 4)).toEqual(['npm-user.rc', 'npm-global.rc', 'pip.conf', 'gitconfig']
      .map(name => ({ pathParts: [name], content: '' })));
    expect(files[4]).toEqual({ pathParts: expected, content: 'off\n' });
  });

  it('confirms native Go observes off and leaves no counter files in its private profile', async ({ skip }) => {
    const { root, env, mode, protection } = await fixture();
    expect(await readFile(mode, 'utf8')).toBe('off\n');
    await protection.captureControls();
    const result = await new NodeCommandRunner().run({ executable: 'go', args: ['env', 'GOTELEMETRY'] },
      { cwd: root, env, timeoutMs: 10_000, maxOutputBytes: 1024 });
    if (result.errorCode === 'ENOENT') skip('Unrun: Go is not installed on this host.');
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('off');
    expect(await readdir(path.dirname(mode))).toEqual(['mode']);
    await protection.assertCurrent();
  });

  it.each(['local\n', 'on\n', ''])('rejects a changed Go telemetry mode %j after control capture', async content => {
    const { mode, protection } = await fixture();
    await protection.captureControls();
    await writeFile(mode, content);
    await expect(protection.assertCurrent()).rejects.toThrow('[changed-private-configuration]');
  });

  it('refuses to treat an already enabled mode as the trusted initial configuration', async () => {
    const { mode, protection } = await fixture();
    await writeFile(mode, 'on\n');
    await expect(protection.captureControls()).rejects.toThrow('[candidate-control]');
  });

  it('requires the telemetry control to exist before admitting a candidate', async () => {
    const { mode, protection } = await fixture();
    await unlink(mode);
    await expect(protection.captureControls()).rejects.toThrow('[candidate-control]');
  });
});
