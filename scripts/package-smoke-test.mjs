#!/usr/bin/env node
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-package-smoke-'));
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('npm_execpath is required. Run this smoke test through npm.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 300_000,
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.status !== 0) {
    const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}\n${output}`);
  }

  return result;
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 300_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status === 0) {
    throw new Error(`${command} ${args.join(' ')} unexpectedly succeeded\n${result.stdout}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCliPath, ...args], options);
}

function assertPackageContains(packResult, expectedPath) {
  if (!packResult.files.some((file) => file.path === expectedPath)) {
    throw new Error(`Packed package is missing ${expectedPath}`);
  }
}

function assertPackageExcludes(packResult, excludedPrefix) {
  const found = packResult.files.find((file) => file.path === excludedPrefix || file.path.startsWith(`${excludedPrefix}/`));
  if (found) {
    throw new Error(`Packed package unexpectedly includes ${found.path}`);
  }
}

function resolveInstalledBinary(prefix) {
  return process.platform === 'win32'
    ? path.join(prefix, 'liftoff.cmd')
    : path.join(prefix, 'bin', 'liftoff');
}

function resolveInstalledEntrypoint(prefix) {
  const modulesDirectory = process.platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
  return path.join(modulesDirectory, '@msn-control', 'liftoff', 'dist', 'cli.js');
}

try {
  const packDirectory = path.join(tempRoot, 'pack');
  const installPrefix = path.join(tempRoot, 'global');
  const homeDirectory = path.join(tempRoot, 'home');
  const outsideDirectory = path.join(tempRoot, 'outside');
  const npmCache = path.join(tempRoot, 'npm-cache');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });

  const pack = runNpm(['pack', '--json', '--pack-destination', packDirectory]);
  const packResults = JSON.parse(pack.stdout);
  const packResult = packResults[0];
  if (!packResult?.filename) {
    throw new Error('npm pack did not return a package filename');
  }

  assertPackageContains(packResult, 'package.json');
  assertPackageContains(packResult, 'README.md');
  assertPackageContains(packResult, 'LICENSE');
  assertPackageContains(packResult, 'dist/cli.js');
  assertPackageContains(packResult, 'dist/commands.js');
  assertPackageContains(packResult, 'dist/genai-templates.js');
  assertPackageContains(packResult, 'dist/standard-templates.js');
  assertPackageContains(packResult, 'dist/templates.js');
  assertPackageExcludes(packResult, 'src');
  assertPackageExcludes(packResult, 'tests');
  assertPackageExcludes(packResult, 'node_modules');

  const tarballPath = path.join(packDirectory, packResult.filename);
  const npmEnv = {
    ...process.env,
    HOME: homeDirectory,
    npm_config_cache: npmCache
  };
  runNpm(['install', '--global', '--prefix', installPrefix, '--no-audit', '--no-fund', '--prefer-offline', tarballPath], {
    cwd: outsideDirectory,
    env: npmEnv
  });

  const liftoffBinary = resolveInstalledBinary(installPrefix);
  if (!existsSync(liftoffBinary)) {
    throw new Error(`Installed liftoff binary not found at ${liftoffBinary}`);
  }
  const liftoffEntrypoint = resolveInstalledEntrypoint(installPrefix);
  if (!existsSync(liftoffEntrypoint)) {
    throw new Error(`Installed liftoff entrypoint not found at ${liftoffEntrypoint}`);
  }

  const help = run(process.execPath, [liftoffEntrypoint, 'help'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!help.stdout.includes('Mission Control Liftoff')) {
    throw new Error('Installed liftoff help output did not include the expected heading');
  }

  const version = run(process.execPath, [liftoffEntrypoint, '--version'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (version.stdout.trim() !== `Liftoff ${packResult.version}`) {
    throw new Error(`Installed liftoff reported an unexpected version: ${version.stdout.trim()}`);
  }

  const createHelp = run(process.execPath, [liftoffEntrypoint, 'create', '--help'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!createHelp.stdout.includes('Usage: liftoff create [project-name]')) {
    throw new Error('Installed liftoff command help did not include create usage');
  }

  const missingValue = runFailure(process.execPath, [liftoffEntrypoint, 'plan', '--pattern'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!missingValue.stderr.includes('Missing value for --pattern.') || missingValue.stderr.includes('at parseArgs')) {
    throw new Error(`Installed liftoff emitted an invalid usage error\n${missingValue.stderr}`);
  }

  const typo = runFailure(
    process.execPath,
    [
      liftoffEntrypoint, 'create', 'typo-app', '--no-genai', '--api', 'node', '--cluod', 'aws',
      '--region', 'eastus', '--spec', 'openspec', '--frontned', '--environments', 'dev', '--yes'
    ],
    { cwd: outsideDirectory, env: npmEnv }
  );
  if (!typo.stderr.includes('Unknown flag for create: --cluod') || existsSync(path.join(outsideDirectory, 'typo-app'))) {
    throw new Error('Installed liftoff did not reject a mistyped create flag before generation');
  }

  const badSubcommand = runFailure(process.execPath, [liftoffEntrypoint, 'dev', 'destroy'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!badSubcommand.stderr.includes('Unsupported dev subcommand') || badSubcommand.stdout.includes('docker compose')) {
    throw new Error('Installed liftoff fell back from an unsupported dev subcommand');
  }

  console.log(`Package smoke test passed for ${packResult.name}@${packResult.version}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}