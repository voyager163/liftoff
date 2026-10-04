import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applicationWithin } from './application-files.js';
import { applicationPackageSources } from './application-preparation-policy.js';
import type { ApplicationResolvedPreparation } from './application-preparation-types.js';

export function applicationPreparationEnvironment(
  base: NodeJS.ProcessEnv, roles: { project: string; cache: string },
  entry: Pick<ApplicationResolvedPreparation, 'provider' | 'cwdPathParts' | 'packageSource' | 'registry' | 'network'>
): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = entry.cwdPathParts.join('-');
  env.LIFTOFF_APPLICATION_NETWORK = entry.network ? 'declared-allowed' : 'not-authorized';
  if (entry.provider === 'npm-ci') {
    Object.assign(env, {
      npm_config_prefix: path.join(roles.project, ...entry.cwdPathParts),
      npm_config_cache: path.join(roles.cache, 'npm', key),
      npm_config_registry: entry.registry, npm_config_offline: entry.network ? 'false' : 'true',
      npm_config_ignore_scripts: 'true', npm_config_replace_registry_host: 'never',
      ...(applicationPackageSources[entry.packageSource].remoteProxyOptIn ? { npm_config_allow_remote: 'all' } : {})
    });
  } else if (entry.provider === 'uv-locked-sync') {
    Object.assign(env, {
      UV_PROJECT_ENVIRONMENT: path.join(roles.project, ...entry.cwdPathParts, '.venv'),
      UV_CACHE_DIR: path.join(roles.cache, 'uv', key), UV_DEFAULT_INDEX: entry.registry,
      UV_OFFLINE: entry.network ? '0' : '1', PIP_NO_INDEX: entry.network ? '0' : '1'
    });
  } else {
    Object.assign(env, {
      GOPATH: path.join(roles.cache, 'go-path', key),
      GOMODCACHE: path.join(roles.cache, 'go-mod', key),
      GOCACHE: path.join(roles.cache, 'go-build', key),
      GOPROXY: entry.network ? entry.registry : 'off', GOSUMDB: entry.network ? 'sum.golang.org' : 'off'
    });
  }
  return env;
}

export function withoutApplicationDependencyNetwork(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env, PIP_NO_INDEX: '1', UV_OFFLINE: '1', npm_config_offline: 'true',
    GOPROXY: 'off', GOSUMDB: 'off'
  };
}

export function applicationConfigurationFiles(platform: NodeJS.Platform = process.platform) {
  return [
    ...['npm-user.rc', 'npm-global.rc', 'pip.conf', 'gitconfig'].map(name => ({ pathParts: [name], content: '' })),
    {
      pathParts: [...(platform === 'darwin' ? ['Library', 'Application Support'] : []), 'go', 'telemetry', 'mode'],
      content: 'off\n'
    }
  ];
}

export function applicationSearchEnvironment(
  inherited: NodeJS.ProcessEnv, projectRoot: string, stagingRoot: string, cwd: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.keys({ ...process.env, ...inherited }).map((key) => [key, undefined]));
  const systemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT ?? inherited.systemroot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.systemroot;
  if (systemRoot) environment.SystemRoot = systemRoot;
  const windir = inherited.WINDIR ?? inherited.windir ?? process.env.WINDIR ?? process.env.windir;
  if (windir) environment.WINDIR = windir;
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    const value = inherited[name] ?? process.env[name];
    if (value) environment[name] = value;
  }
  const search = inherited.PATH ?? inherited.Path ?? process.env.PATH ?? process.env.Path ?? '';
  environment.PATH = search.slice(0, 32_768).split(path.delimiter).slice(0, 256).filter((entry) =>
    path.isAbsolute(entry) && ![projectRoot, stagingRoot, cwd].some((root) => applicationWithin(root, path.resolve(entry)))
  ).join(path.delimiter);
  if (process.platform === 'win32') {
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'path' && key !== 'PATH') {
        delete environment[key];
      }
    }
  }
  return environment;
}

export async function createApplicationEnvironment(
  inherited: NodeJS.ProcessEnv, projectRoot: string, stagingRoot: string, workspace: string
): Promise<NodeJS.ProcessEnv> {
  const environment = applicationSearchEnvironment(inherited, projectRoot, stagingRoot, workspace);
  const home = path.join(workspace, 'home'), cache = path.join(workspace, 'cache'), scratch = path.join(workspace, 'scratch');
  for (const directory of [home, cache, scratch]) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const configuration of applicationConfigurationFiles()) {
    const file = path.join(home, ...configuration.pathParts);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // GOENV=off does not disable Go counters; their mode lives under UserConfigDir.
    await writeFile(file, configuration.content, { mode: 0o600, flag: 'wx' });
  }
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: cache, XDG_DATA_HOME: home,
    TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    CI: '1', TERM: 'dumb', NO_COLOR: '1',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1',
    PIP_NO_INPUT: '1', PIP_CONFIG_FILE: path.join(home, 'pip.conf'), PIP_NO_INDEX: '1',
    UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_NO_MANAGED_PYTHON: '1', UV_NO_BUILD: '1',
    UV_CACHE_DIR: path.join(cache, 'uv'), UV_LINK_MODE: 'copy',
    GOPATH: path.join(cache, 'go-path'), GOMODCACHE: path.join(cache, 'go-mod'), GOCACHE: path.join(cache, 'go-build'),
    GOTOOLCHAIN: 'local', GOWORK: 'off', GOENV: 'off', CGO_ENABLED: '0',
    GOFLAGS: '-mod=readonly -buildvcs=false', GOVCS: '*:off', GOPROXY: 'off', GOSUMDB: 'off',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: workspace,
    npm_config_userconfig: path.join(home, 'npm-user.rc'), npm_config_globalconfig: path.join(home, 'npm-global.rc'),
    npm_config_prefix: workspace, npm_config_cache: path.join(cache, 'npm'),
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
    LIFTOFF_APPLICATION_VERIFICATION: '1', LIFTOFF_APPLICATION_NETWORK: 'not-authorized'
  });
  return environment;
}
