import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every root Vitest run gets a fresh, run-owned user profile so Liftoff previews,
// approvals, repair workspaces and telemetry configuration created by tests, and
// the gh/az/npm profiles probed by tests, never reach the developer's real ones.
// This is directory and credential-input isolation for deterministic tests only;
// it is not a sandbox or network boundary, and PATH/native host settings remain.
export const userStateRootVariable = 'LIFTOFF_TEST_USER_STATE_ROOT';
export const userStatePrefix = 'lus-';

const xdgVariables = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const npmFileVariables = [
  'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG', 'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG'
];
const directoryVariables = [
  'HOME', 'APPDATA', 'LOCALAPPDATA', 'AZURE_CONFIG_DIR', 'GH_CONFIG_DIR', 'npm_config_cache',
  'GOPATH', 'GOMODCACHE', 'GOCACHE', ...xdgVariables
];

// Ambient credential inputs read by the probed gh, az and npm clients. A test
// that needs one must inject its own fixture value; real values never reach it.
export const suppressedCredentialVariables = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_CLIENT_SEND_CERTIFICATE_CHAIN', 'AZURE_USERNAME',
  'AZURE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_DEVOPS_EXT_PAT',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN'
]);
const npmCredentialVariable = /^npm_config_(?:.*:)?_?(?:auth|authtoken|password|otp|username|email|cert|key|certfile|keyfile)$/i;

// Windows environment names are case-insensitive, so spellings such as gh_token
// are consumed there too; comparison is therefore case-insensitive everywhere.
export function isCredentialVariable(name: string): boolean {
  return suppressedCredentialVariables.includes(name.toUpperCase()) || npmCredentialVariable.test(name);
}

export function isolatedGoConfigurationDirectory(home: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const config = platform === 'win32' ? paths.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support') : paths.join(home, '.config');
  return paths.join(config, 'go');
}

// Paths are each client's platform default relative to the isolated home, so
// resolution keeps its normal meaning; only the root moves. Short names keep
// Windows profile paths no longer than a runner's real profile (MAX_PATH).
export function isolatedUserStateEnvironment(root: string, platform: NodeJS.Platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = paths.join(root, 'h');
  const appData = paths.join(home, 'AppData', 'Roaming');
  const localAppData = paths.join(home, 'AppData', 'Local');
  const values: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    AZURE_CONFIG_DIR: paths.join(home, '.azure'),
    // Otherwise az starts a detached telemetry upload that rewrites the profile
    // after teardown; npm would likewise start its registry update check.
    AZURE_CORE_COLLECT_TELEMETRY: 'false',
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GH_CONFIG_DIR: platform === 'win32' ? paths.join(appData, 'GitHub CLI') : paths.join(home, '.config', 'gh'),
    [userStateRootVariable]: root
  };
  const cache = platform === 'win32' ? paths.join(localAppData, 'npm-cache') : paths.join(home, '.npm');
  values.npm_config_cache = cache;
  values.NPM_CONFIG_CACHE = cache;
  // Empty run-owned files: neither the user nor a global npmrc is inherited.
  for (const name of npmFileVariables) {
    values[name] = /userconfig/i.test(name) ? paths.join(home, '.npmrc') : paths.join(home, '.npmrc-global');
  }
  // Go's own defaults under the isolated home; exported values cannot redirect
  // module, build-cache or go env reads and writes outside the run root.
  values.GOPATH = paths.join(home, 'go');
  values.GOMODCACHE = paths.join(home, 'go', 'pkg', 'mod');
  values.GOCACHE = platform === 'win32' ? paths.join(localAppData, 'go-build')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Caches', 'go-build') : paths.join(home, '.cache', 'go-build');
  values.GOENV = paths.join(isolatedGoConfigurationDirectory(home, platform), 'env');
  for (const name of xdgVariables) values[name] = undefined;
  if (platform !== 'win32') {
    values.XDG_CONFIG_HOME = paths.join(home, '.config');
    values.XDG_STATE_HOME = paths.join(home, '.local', 'state');
    values.XDG_CACHE_HOME = paths.join(home, '.cache');
    values.XDG_DATA_HOME = paths.join(home, '.local', 'share');
  }
  return values;
}

export interface UserStateIsolationHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  temporaryDirectory: string;
  makeTemporaryDirectory(prefix: string): string;
  makeDirectory(directory: string): void;
  writeFile(file: string, content: string): void;
  removeDirectory(directory: string): void;
}

// Tools such as Go write their module cache read-only; ownership is restored
// inside the run root only, without following links, before retrying removal.
function makeOwnerWritable(target: string): void {
  const details = lstatSync(target);
  if (details.isSymbolicLink()) return;
  chmodSync(target, details.mode | (details.isDirectory() ? 0o700 : 0o600));
  if (details.isDirectory()) for (const entry of readdirSync(target)) makeOwnerWritable(path.join(target, entry));
}

export function removeRunOwnedDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    makeOwnerWritable(directory);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}

export const nodeUserStateIsolationHost = (): UserStateIsolationHost => ({
  env: process.env,
  platform: process.platform,
  temporaryDirectory: os.tmpdir(),
  makeTemporaryDirectory: (prefix) => mkdtempSync(prefix),
  makeDirectory: (directory) => mkdirSync(directory, { recursive: true }),
  writeFile: (file, content) => writeFileSync(file, content, { flag: 'wx' }),
  removeDirectory: removeRunOwnedDirectory
});

function assign(env: NodeJS.ProcessEnv, values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

// Returns the teardown. Only the exact directory this call created is removed;
// the environment is restored first, and a cleanup failure fails the run.
export function isolateUserState(host: UserStateIsolationHost = nodeUserStateIsolationHost()): () => void {
  const paths = host.platform === 'win32' ? path.win32 : path.posix;
  const root = host.makeTemporaryDirectory(paths.join(host.temporaryDirectory, userStatePrefix));
  const values = isolatedUserStateEnvironment(root, host.platform);
  const credentialNames = Object.keys(host.env).filter(isCredentialVariable);
  const names = [...new Set([...Object.keys(values), ...credentialNames])];
  const previous = Object.fromEntries(names.map((name) => [name, host.env[name]]));
  try {
    for (const name of directoryVariables) {
      const value = values[name];
      if (value !== undefined) host.makeDirectory(value);
    }
    host.makeDirectory(paths.dirname(values.GOENV!));
    host.writeFile(values.npm_config_userconfig!, '');
    host.writeFile(values.npm_config_globalconfig!, '');
    host.writeFile(values.GOENV!, '');
    // Go's telemetry mode is a file, not an environment override. Disable it
    // before the first tool invocation can start a counter process holding locks.
    const telemetry = paths.join(isolatedGoConfigurationDirectory(values.HOME!, host.platform), 'telemetry');
    host.makeDirectory(telemetry);
    host.writeFile(paths.join(telemetry, 'mode'), 'off\n');
  } catch (error) {
    host.removeDirectory(root);
    throw error;
  }
  assign(host.env, values);
  for (const name of credentialNames) delete host.env[name];
  return () => {
    try {
      assign(host.env, previous);
    } finally {
      try {
        host.removeDirectory(root);
      } catch (error) {
        throw new Error(`Unable to remove the isolated test user-state root ${root}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}

interface ProcessUserStateIsolation {
  readonly root: string;
  done: boolean;
  teardown(): void;
}

const processIsolationKey = Symbol.for('liftoff.tests.userStateIsolation');

// Vitest writes its own runner state (the API token under the user data
// directory) while resolving the config, before any global setup runs, so the
// root config calls this in the main process as it is evaluated. Workers and the
// tools they spawn inherit the isolated environment. One isolation per process.
export function isolateProcessUserState(
  host: UserStateIsolationHost = nodeUserStateIsolationHost()
): ProcessUserStateIsolation {
  const store = globalThis as { [processIsolationKey]?: ProcessUserStateIsolation };
  const existing = store[processIsolationKey];
  if (existing && !existing.done) return existing;
  const teardown = isolateUserState(host);
  const isolation: ProcessUserStateIsolation = {
    root: host.env[userStateRootVariable]!,
    done: false,
    teardown() {
      if (isolation.done) return;
      isolation.done = true;
      teardown();
    }
  };
  store[processIsolationKey] = isolation;
  // Only reached when a run stops before global teardown (for example, a
  // configuration error); a cleanup failure still fails the process.
  process.once('exit', () => {
    if (isolation.done) return;
    try {
      isolation.teardown();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
  return isolation;
}

// Global setup owns the normal teardown; its failure fails the Vitest run.
export default function setupUserStateIsolation(): () => void {
  const isolation = isolateProcessUserState();
  return () => isolation.teardown();
}
