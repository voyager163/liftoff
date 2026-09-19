import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { environmentValue } from '../../domain/workstation/executables.js';
import { ApplicationInspectionError, applicationWithin } from './application-files.js';

export function applicationSearchEnvironment(
  inherited: NodeJS.ProcessEnv, projectRoot: string, stagingRoot: string, cwd: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.keys({ ...process.env, ...inherited }).map((key) => [key, undefined]));
  const removeAliases = (name: string) => {
    // Windows child-environment folding can let an undefined alias hide a defined canonical key.
    if (process.platform !== 'win32' && name !== 'PATH') return;
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
    }
  };
  const selected = (name: string, ...aliases: string[]): string | undefined => {
    const names = [name, ...aliases];
    let value: string | undefined;
    try {
      value = process.platform === 'win32'
        ? environmentValue(inherited, name, 'win32') ?? environmentValue(process.env, name, 'win32')
        : names.map((name) => inherited[name]).find((entry) => entry !== undefined) ??
          names.map((name) => process.env[name]).find((entry) => entry !== undefined);
    } catch {
      throw new ApplicationInspectionError('[ambiguous-tool-environment] Conflicting Windows environment aliases cannot select an installed tool or system directory.');
    }
    removeAliases(name);
    return value;
  };
  const systemRoot = selected('SystemRoot', 'SYSTEMROOT', 'systemroot');
  if (systemRoot) environment.SystemRoot = systemRoot;
  const windir = selected('WINDIR', 'windir');
  if (windir) environment.WINDIR = windir;
  const systemDrive = selected('SystemDrive', 'SYSTEMDRIVE') ?? (systemRoot ? systemRoot.slice(0, 2) : undefined);
  if (systemDrive) environment.SystemDrive = systemDrive;
  const comspec = selected('COMSPEC', 'ComSpec');
  if (comspec) environment.COMSPEC = comspec;
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    const value = selected(name);
    if (value) environment[name] = value;
  }
  const search = selected('PATH', 'Path') ?? '';
  environment.PATH = search.slice(0, 32_768).split(path.delimiter).slice(0, 256).filter((entry) =>
    path.isAbsolute(entry) && ![projectRoot, stagingRoot, cwd].some((root) => applicationWithin(root, path.resolve(entry)))
  ).join(path.delimiter);
  if (process.platform === 'win32') {
    removeAliases('PATHEXT');
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }
  return environment;
}

export async function createApplicationEnvironment(
  inherited: NodeJS.ProcessEnv, projectRoot: string, stagingRoot: string, workspace: string
): Promise<NodeJS.ProcessEnv> {
  const environment = applicationSearchEnvironment(inherited, projectRoot, stagingRoot, workspace);
  const home = path.join(workspace, 'home'), cache = path.join(workspace, 'cache'), scratch = path.join(workspace, 'scratch');
  for (const directory of [home, cache, scratch]) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['npm-user.rc', 'npm-global.rc', 'pip.conf', 'gitconfig']) {
    await writeFile(path.join(home, name), '', { mode: 0o600, flag: 'wx' });
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
