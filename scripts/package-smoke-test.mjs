#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  templateDependencyInventory,
  validateTemplateDependencyInventory
} from './template-dependency-security.mjs';

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

function firstPackResult(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  if (value && typeof value === 'object') {
    return Object.values(value)[0];
  }
  return undefined;
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
  const packResult = firstPackResult(packResults);
  if (!packResult?.filename) {
    throw new Error('npm pack did not return a package filename');
  }

  assertPackageContains(packResult, 'package.json');
  assertPackageContains(packResult, 'README.md');
  assertPackageContains(packResult, 'LICENSE');
  for (const documentationPath of [
    'docs/getting-started.md',
    'docs/workloads.md',
    'docs/spec-workflows-and-agents.md',
    'docs/repository-governance.md',
    'docs/existing-repositories.md',
    'docs/prerequisites.md',
    'docs/supported-stack.md',
    'docs/safety-and-consent.md',
    'docs/telemetry.md',
    'docs/cli-reference.md',
    'docs/project-structure.md',
    'docs/configuration-and-manifests.md',
    'docs/azure-deployment.md',
    'docs/troubleshooting.md',
    'docs/assets/liftoff-terminal.svg'
  ]) {
    assertPackageContains(packResult, documentationPath);
  }
  assertPackageContains(packResult, 'dist/cli.js');
  assertPackageContains(packResult, 'dist/commands.js');
  assertPackageContains(packResult, 'dist/package-identity.js');
  assertPackageContains(packResult, 'dist/self-upgrade.js');
  assertPackageContains(packResult, 'dist/stable-release.js');
  assertPackageContains(packResult, 'dist/genai-templates.js');
  assertPackageContains(packResult, 'dist/power-apps-assets.js');
  assertPackageContains(packResult, 'dist/power-apps-templates.js');
  assertPackageContains(packResult, 'dist/standard-templates.js');
  assertPackageContains(packResult, 'dist/templates.js');
  assertPackageContains(packResult, 'dist/supported-stack.js');
  assertPackageContains(packResult, 'assets/supported-stack.json');
  assertPackageContains(
    packResult,
    'assets/governance/single-maintainer-gitflow/policy.md'
  );
  assertPackageContains(packResult, 'assets/locks/node-backend/package.json');
  assertPackageContains(packResult, 'assets/locks/node-backend/package-lock.json');
  assertPackageContains(packResult, 'assets/locks/frontend/package.json');
  assertPackageContains(packResult, 'assets/locks/frontend/package-lock.json');
  assertPackageContains(packResult, 'assets/locks/go-backend/go.mod');
  assertPackageContains(packResult, 'assets/locks/go-backend/go.sum');
  assertPackageContains(packResult, 'assets/locks/python-standard/pyproject.toml');
  assertPackageContains(packResult, 'assets/locks/python-standard/uv.lock');
  assertPackageContains(packResult, 'assets/locks/python-genai/pyproject.toml');
  assertPackageContains(packResult, 'assets/locks/python-genai/uv.lock');
  assertPackageContains(packResult, 'assets/locks/python-genai/function-requirements.txt');
  assertPackageContains(packResult, 'assets/locks/opentofu-azure/versions.tf');
  assertPackageContains(packResult, 'assets/locks/opentofu-azure/.terraform.lock.hcl');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/catalog.json');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/UPSTREAM_LICENSE.txt');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/packaged/gitignore');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/package.json');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/package-lock.json');
  assertPackageContains(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/src/App.tsx');
  assertPackageExcludes(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/node_modules');
  assertPackageExcludes(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/dist');
  assertPackageExcludes(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/power.config.json');
  assertPackageExcludes(packResult, 'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/.gitignore');
  assertPackageExcludes(packResult, 'src');
  assertPackageExcludes(packResult, 'tests');
  assertPackageExcludes(packResult, 'scripts');
  assertPackageExcludes(packResult, 'security');
  assertPackageExcludes(packResult, 'services');
  assertPackageExcludes(packResult, 'infrastructure');
  assertPackageExcludes(packResult, 'node_modules');
  await validateTemplateDependencyInventory(
    packageRoot,
    templateDependencyInventory,
    packResult.files.map((file) => file.path)
  );
  if (packResult.unpackedSize > 5 * 1024 * 1024) {
    throw new Error(`Packed package unexpectedly exceeds the 5 MiB unpacked-size budget: ${packResult.unpackedSize}`);
  }

  const tarballPath = path.join(packDirectory, packResult.filename);
  const npmEnv = {
    ...process.env,
    HOME: homeDirectory,
    LIFTOFF_TELEMETRY: '0',
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
  const installedPackageRoot = path.dirname(path.dirname(liftoffEntrypoint));

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

  const initHelp = run(process.execPath, [liftoffEntrypoint, 'init', '--help'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!initHelp.stdout.includes('Usage: liftoff init [project-name]') || !initHelp.stdout.includes('--install-tools')) {
    throw new Error('Installed liftoff command help did not include init usage and consent flags');
  }

  const updateHelp = run(process.execPath, [liftoffEntrypoint, 'update', '--help'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (
    !updateHelp.stdout.includes('--check') ||
    !updateHelp.stdout.includes('--force') ||
    updateHelp.stdout.includes('--apply')
  ) {
    throw new Error('Installed liftoff update help did not expose the imperative mode matrix');
  }

  const upgradeHelp = run(process.execPath, [liftoffEntrypoint, 'upgrade', '--help'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (
    !upgradeHelp.stdout.includes('supported global npm Liftoff CLI') ||
    !upgradeHelp.stdout.includes('--check') ||
    !upgradeHelp.stdout.includes('--json') ||
    !upgradeHelp.stdout.includes('project templates use update separately')
  ) {
    throw new Error('Installed liftoff upgrade help did not expose the self-upgrade contract');
  }

  const isolatedGlobalRoot = process.platform === 'win32'
    ? path.join(installPrefix, 'node_modules')
    : path.join(installPrefix, 'lib', 'node_modules');
  const injectedCheckScript = `
    import { runSelfUpgrade } from ${JSON.stringify(
      pathToFileURL(path.join(installedPackageRoot, 'dist', 'self-upgrade.js')).href
    )};
    const calls = [];
    const result = await runSelfUpgrade({
      mode: 'check',
      currentVersion: ${JSON.stringify(packResult.version)},
      stdout: process.stdout,
      stderr: process.stderr,
      json: true,
      runningPackageRoot: ${JSON.stringify(installedPackageRoot)}
    }, {
      runner: {
        run: async (command) => {
          calls.push(command);
          if (command.args.join(' ') !== 'root --global') {
            throw new Error('Injected current-version check attempted an unexpected command.');
          }
          return {
            command,
            displayCommand: command.executable + ' ' + command.args.join(' '),
            status: 0,
            signal: null,
            stdout: ${JSON.stringify(`${isolatedGlobalRoot}\n`)},
            stderr: '',
            timedOut: false
          };
        }
      },
      lookupStableRelease: async () => ({
        name: '@msn-control/liftoff',
        version: ${JSON.stringify(packResult.version)}
      }),
      environment: { LIFTOFF_TELEMETRY: '0' }
    });
    if (result.status !== 'current' || calls.length !== 1) process.exit(1);
    process.stdout.write(JSON.stringify(result));
  `;
  const injectedCheck = run(
    process.execPath,
    ['--input-type=module', '-e', injectedCheckScript],
    { cwd: outsideDirectory, env: npmEnv }
  );
  const injectedResult = JSON.parse(injectedCheck.stdout);
  if (
    injectedResult.status !== 'current' ||
    injectedResult.currentVersion !== packResult.version
  ) {
    throw new Error('Installed self-upgrade module failed its isolated injected check');
  }

  const removedApply = runFailure(process.execPath, [liftoffEntrypoint, 'update', '--apply'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (
    !removedApply.stderr.includes('Flag --apply was removed') ||
    !removedApply.stderr.includes('liftoff update --check') ||
    removedApply.stderr.includes('No liftoff.manifest.json found')
  ) {
    throw new Error('Installed liftoff did not reject --apply before project discovery');
  }

  for (const currentInstructionPath of [
    'README.md',
    'docs/getting-started.md',
    'docs/workloads.md',
    'docs/spec-workflows-and-agents.md',
    'docs/existing-repositories.md',
    'docs/prerequisites.md',
    'docs/safety-and-consent.md',
    'docs/telemetry.md',
    'docs/project-structure.md',
    'docs/configuration-and-manifests.md',
    'docs/azure-deployment.md',
    'docs/troubleshooting.md',
    'dist/templates.js'
  ]) {
    const content = await readFile(path.join(installedPackageRoot, currentInstructionPath), 'utf8');
    if (content.includes('liftoff update --apply')) {
      throw new Error(`Packed ${currentInstructionPath} contains removed active update syntax`);
    }
  }
  const cliReference = await readFile(
    path.join(installedPackageRoot, 'docs', 'cli-reference.md'),
    'utf8'
  );
  if (
    !cliReference.includes('These are historical 0.6.x commands') ||
    [...cliReference.matchAll(/liftoff update --apply/g)].length !== 2
  ) {
    throw new Error('Packed CLI reference does not isolate removed syntax to migration history');
  }

  const beforePlan = await readdir(outsideDirectory);
  const plan = run(process.execPath, [
    liftoffEntrypoint, 'plan', '--no-genai', '--api', 'node', '--cloud', 'azure',
    '--region', 'eastus', '--spec', 'openspec', '--agents', 'copilot', '--no-frontend'
  ], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!plan.stdout.includes('Artifacts') || !plan.stdout.includes('Workstation requirements')) {
    throw new Error('Installed liftoff plan did not render artifacts and requirements');
  }
  const afterPlan = await readdir(outsideDirectory);
  if (JSON.stringify(afterPlan) !== JSON.stringify(beforePlan)) {
    throw new Error(`Installed liftoff plan changed the working directory: ${afterPlan.join(', ')}`);
  }

  const powerAppsPlan = run(process.execPath, [
    liftoffEntrypoint, 'plan', '--type', 'power-apps-code-app',
    '--spec', 'openspec', '--agents', 'copilot'
  ], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (
    !powerAppsPlan.stdout.includes('Power Apps code app') ||
    !powerAppsPlan.stdout.includes('power-apps-package') ||
    powerAppsPlan.stdout.includes('docker-compose')
  ) {
    throw new Error('Installed Liftoff did not render the packaged Power Apps workload correctly');
  }

  const obsoleteCreate = runFailure(process.execPath, [liftoffEntrypoint, 'create', 'obsolete-app'], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!obsoleteCreate.stderr.includes('replaced by `liftoff init`') || existsSync(path.join(outsideDirectory, 'obsolete-app'))) {
    throw new Error('Installed liftoff did not reject the obsolete create command with init guidance');
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
      liftoffEntrypoint, 'init', 'typo-app', '--no-genai', '--api', 'node', '--cluod', 'aws',
      '--region', 'eastus', '--spec', 'openspec', '--frontned', '--environments', 'dev', '--yes'
    ],
    { cwd: outsideDirectory, env: npmEnv }
  );
  if (!typo.stderr.includes('Unknown flag for init: --cluod') || existsSync(path.join(outsideDirectory, 'typo-app'))) {
    throw new Error('Installed liftoff did not reject a mistyped init flag before generation');
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