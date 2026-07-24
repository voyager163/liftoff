import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CANONICAL_NPM_REGISTRY = 'https://registry.npmjs.org';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PublishedVerifierDependencies {
  runNpm(args: string[], options: CommandOptions): CommandResult;
  runNode(args: string[], options: CommandOptions): CommandResult;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  readJson(filePath: string): Promise<unknown>;
  makeTempRoot(): Promise<string>;
  makeDirectory(directory: string): Promise<void>;
  removeTempRoot(directory: string): Promise<void>;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
}

export interface PublishedVerifierOptions {
  packageRoot: string;
  tag: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
  allowLegacyVersionCommand?: boolean;
}

export interface PublishedVerificationResult {
  name: string;
  version: string;
  tag: string;
  registry: string;
  legacyVersionCommandAllowed: boolean;
}

interface PackageIdentity {
  name: string;
  version: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;

function commandOutput(result: CommandResult): string {
  return [result.error, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
}

function assertCommand(result: CommandResult, description: string): void {
  if (result.status !== 0) {
    throw new Error(`${description} failed${commandOutput(result) ? `: ${commandOutput(result)}` : ''}`);
  }
}

function packageIdentity(value: unknown, source: string): PackageIdentity {
  if (!value || typeof value !== 'object') {
    throw new Error(`${source} must contain a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name || typeof record.version !== 'string' || !record.version) {
    throw new Error(`${source} must contain non-empty name and version fields.`);
  }
  return { name: record.name, version: record.version };
}

function installedPackagePath(prefix: string, packageName: string, platform: NodeJS.Platform): string {
  const modulesDirectory = platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
  return path.join(modulesDirectory, ...packageName.split('/'));
}

async function waitForPublishedVersion(
  identity: PackageIdentity,
  tag: string,
  packageRoot: string,
  timeoutMs: number,
  retryIntervalMs: number,
  dependencies: PublishedVerifierDependencies
): Promise<void> {
  const deadline = dependencies.now() + timeoutMs;
  let observed = 'unavailable';

  while (true) {
    const result = dependencies.runNpm(
      ['view', `${identity.name}@${tag}`, 'version', `--registry=${CANONICAL_NPM_REGISTRY}`],
      { cwd: packageRoot, env: dependencies.environment }
    );
    observed = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'unavailable';
    if (observed === identity.version) {
      return;
    }
    if (dependencies.now() >= deadline) {
      throw new Error(
        `Canonical npm dist-tag mismatch after ${timeoutMs}ms: expected ${identity.name}@${tag} ` +
        `to resolve ${identity.version}, observed ${observed}.`
      );
    }
    await dependencies.wait(Math.min(retryIntervalMs, Math.max(1, deadline - dependencies.now())));
  }
}

export async function verifyPublishedPackage(
  options: PublishedVerifierOptions,
  dependencies: PublishedVerifierDependencies = defaultDependencies()
): Promise<PublishedVerificationResult> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.tag)) {
    throw new Error(`Invalid npm dist-tag: ${options.tag}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  if (timeoutMs < 0 || retryIntervalMs <= 0) {
    throw new Error('Verifier timeout must be non-negative and retry interval must be positive.');
  }

  const packageJsonPath = path.join(options.packageRoot, 'package.json');
  const identity = packageIdentity(await dependencies.readJson(packageJsonPath), packageJsonPath);
  await waitForPublishedVersion(
    identity,
    options.tag,
    options.packageRoot,
    timeoutMs,
    retryIntervalMs,
    dependencies
  );

  const tempRoot = await dependencies.makeTempRoot();
  try {
    const installPrefix = path.join(tempRoot, 'global');
    const homeDirectory = path.join(tempRoot, 'home');
    const outsideDirectory = path.join(tempRoot, 'outside');
    const npmCache = path.join(tempRoot, 'npm-cache');
    await Promise.all([
      dependencies.makeDirectory(installPrefix),
      dependencies.makeDirectory(homeDirectory),
      dependencies.makeDirectory(outsideDirectory),
      dependencies.makeDirectory(npmCache)
    ]);
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      ...dependencies.environment,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      npm_config_cache: npmCache,
      npm_config_registry: CANONICAL_NPM_REGISTRY
    };
    const commandOptions = { cwd: outsideDirectory, env: isolatedEnvironment };
    const install = dependencies.runNpm([
      'install',
      '--global',
      '--prefix', installPrefix,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `--registry=${CANONICAL_NPM_REGISTRY}`,
      `${identity.name}@${identity.version}`
    ], commandOptions);
    assertCommand(install, `Canonical npm install of ${identity.name}@${options.tag}`);

    const installedRoot = installedPackagePath(installPrefix, identity.name, dependencies.platform);
    const installedPackageJson = path.join(installedRoot, 'package.json');
    const installedIdentity = packageIdentity(
      await dependencies.readJson(installedPackageJson),
      installedPackageJson
    );
    if (installedIdentity.name !== identity.name || installedIdentity.version !== identity.version) {
      throw new Error(
        `Installed package mismatch: expected ${identity.name}@${identity.version}, ` +
        `observed ${installedIdentity.name}@${installedIdentity.version}.`
      );
    }

    const entrypoint = path.join(installedRoot, 'dist', 'cli.js');
    const help = dependencies.runNode([entrypoint, 'help'], commandOptions);
    assertCommand(help, 'Installed command help');
    if (!help.stdout.includes('Mission Control Liftoff')) {
      throw new Error('Installed command help did not contain the Liftoff heading.');
    }

    if (!options.allowLegacyVersionCommand) {
      const version = dependencies.runNode([entrypoint, '--version'], commandOptions);
      assertCommand(version, 'Installed command --version');
      if (version.stdout.trim() !== `Liftoff ${identity.version}`) {
        throw new Error(
          `Installed command --version mismatch: expected Liftoff ${identity.version}, ` +
          `observed ${version.stdout.trim() || 'empty output'}.`
        );
      }
    }

    const plan = dependencies.runNode([
      entrypoint,
      'plan',
      '--no-genai',
      '--api', 'node',
      '--cloud', 'azure',
      '--region', 'eastus',
      '--no-frontend',
      '--environments', 'dev',
      '--spec', 'openspec'
    ], commandOptions);
    assertCommand(plan, 'Installed standard-project plan');
    if (!plan.stdout.includes('Project type: Standard application')) {
      throw new Error('Installed standard-project plan did not select a standard application.');
    }

    return {
      name: identity.name,
      version: identity.version,
      tag: options.tag,
      registry: CANONICAL_NPM_REGISTRY,
      legacyVersionCommandAllowed: options.allowLegacyVersionCommand ?? false
    };
  } finally {
    await dependencies.removeTempRoot(tempRoot);
  }
}

function runProcess(command: string, args: string[], options: CommandOptions): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message
  };
}

function defaultDependencies(): PublishedVerifierDependencies {
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm_execpath is required. Run published verification through npm.');
  }
  return {
    runNpm: (args, options) => runProcess(process.execPath, [npmCliPath, ...args], options),
    runNode: (args, options) => runProcess(process.execPath, args, options),
    now: () => Date.now(),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    readJson: async (filePath) => JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    makeTempRoot: () => mkdtemp(path.join(os.tmpdir(), 'liftoff-published-verify-')),
    makeDirectory: async (directory) => { await mkdir(directory, { recursive: true }); },
    removeTempRoot: async (directory) => { await rm(directory, { recursive: true, force: true }); },
    platform: process.platform,
    environment: process.env
  };
}