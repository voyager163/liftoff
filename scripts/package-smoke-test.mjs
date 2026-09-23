#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const smokeArgs = process.argv.slice(2);
if (smokeArgs.length !== 0 && (smokeArgs.length !== 2 || smokeArgs[0] !== '--tarball' || smokeArgs[1].startsWith('-'))) {
  throw new Error('Usage: npm run smoke:package -- [--tarball <qualified-package.tgz>]');
}
const suppliedTarball = smokeArgs.length === 2 ? path.resolve(smokeArgs[1]) : undefined;
const suppliedDigest = suppliedTarball
  ? createHash('sha256').update(await readFile(suppliedTarball)).digest('hex')
  : undefined;
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

async function treeDigest(root) {
  const digest = createHash('sha256');
  async function visit(parts) {
    const entries = await readdir(path.join(root, ...parts), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = [...parts, entry.name];
      digest.update(child.join('/'));
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) digest.update(await readFile(path.join(root, ...child)));
      else throw new Error('Unexpected non-regular smoke fixture entry.');
    }
  }
  await visit([]);
  return digest.digest('hex');
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

  const pack = runNpm(suppliedTarball
    ? ['pack', '--dry-run', '--json', suppliedTarball]
    : ['pack', '--json', '--pack-destination', packDirectory]);
  const packResults = JSON.parse(pack.stdout);
  const packResult = firstPackResult(packResults);
  if (!packResult?.filename) {
    throw new Error('npm pack did not return a package filename');
  }

  assertPackageContains(packResult, 'package.json');
  assertPackageContains(packResult, 'README.md');
  assertPackageContains(packResult, 'DEVELOPER.md');
  assertPackageContains(packResult, 'LICENSE');
  for (const documentationPath of [
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'GOVERNANCE.md',
    'SUPPORT.md',
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
    'docs/application-repair.md',
    'docs/project-structure.md',
    'docs/configuration-and-manifests.md',
    'docs/azure-deployment.md',
    'docs/troubleshooting.md',
    'docs/assets/liftoff-terminal.svg',
    'docs/assets/liftoff-hero.svg'
  ]) {
    assertPackageContains(packResult, documentationPath);
  }
  assertPackageContains(packResult, 'dist/cli.js');
  assertPackageContains(packResult, 'dist/application/repair/use-case.js');
  assertPackageContains(packResult, 'dist/application/repair/infrastructure.js');
  assertPackageContains(packResult, 'dist/application/repair/patch-flow.js');
  assertPackageContains(packResult, 'dist/application/repair/application-inventory.js');
  assertPackageContains(packResult, 'dist/domain/repair/identity.js');
  assertPackageContains(packResult, 'dist/commands.js');
  assertPackageContains(packResult, 'dist/package-identity.js');
  assertPackageContains(packResult, 'dist/self-upgrade.js');
  assertPackageContains(packResult, 'dist/stable-release.js');
  assertPackageContains(packResult, 'dist/genai-templates.js');
  assertPackageExcludes(packResult, 'dist/power-apps-assets.js');
  assertPackageExcludes(packResult, 'dist/power-apps-templates.js');
  assertPackageExcludes(packResult, 'dist/power-apps-validation.js');
  assertPackageExcludes(packResult, 'dist/code-apps-plugin.js');
  assertPackageContains(packResult, 'dist/standard-templates.js');
  assertPackageContains(packResult, 'dist/templates.js');
  assertPackageContains(packResult, 'dist/governance-assessment/engine.js');
  assertPackageContains(packResult, 'dist/governance-assessment/live.js');
  assertPackageContains(packResult, 'dist/governance-assessment/catalog.js');
  assertPackageContains(packResult, 'dist/supported-stack.js');
  assertPackageContains(packResult, 'assets/supported-stack.json');
  assertPackageContains(packResult, 'assets/repair/windows-job-controller.ps1');
  assertPackageContains(
    packResult,
    'assets/governance/single-maintainer-gitflow/policy.md'
  );
  assertPackageContains(packResult, 'assets/governance/single-maintainer-gitflow/assessment-controls.json');
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
  assertPackageExcludes(packResult, 'assets/power-apps-code-app');
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
  if (packResult.unpackedSize > 8 * 1024 * 1024) {
    throw new Error(`Packed package unexpectedly exceeds the 8 MiB unpacked-size budget: ${packResult.unpackedSize}`);
  }

  const tarballPath = suppliedTarball ?? path.join(packDirectory, packResult.filename);
  const npmEnv = {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
    LOCALAPPDATA: path.join(homeDirectory, 'AppData', 'Local'),
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
    !updateHelp.stdout.includes('--approve-plan') ||
    updateHelp.stdout.includes('--apply')
  ) {
    throw new Error('Installed liftoff update help did not expose reviewed preview and exact-plan approval');
  }

  const repairHelp = run(process.execPath, [liftoffEntrypoint, 'repair', '--help'], {
    cwd: outsideDirectory, env: npmEnv
  });
  for (const flag of ['--check', '--live', '--subscription', '--approve-plan', '--recover', '--json',
    '--capabilities', '--inspect-layout', '--application-patch', '--verify-plan', '--allow-network', '--allow-dependency-preparation']) {
    if (!repairHelp.stdout.includes(flag)) throw new Error(`Installed repair help is missing ${flag}.`);
  }
  const noProjectRepair = runFailure(process.execPath, [liftoffEntrypoint, 'repair', '--check', '--json'], {
    cwd: outsideDirectory, env: npmEnv
  });
  const noProjectRepairReport = JSON.parse(noProjectRepair.stdout);
  if (noProjectRepair.status !== 1 || noProjectRepairReport.schemaVersion !== 2 ||
      noProjectRepairReport.committed !== false || noProjectRepairReport.status !== 'failed') {
    throw new Error('Installed repair did not preserve the missing-project boundary.');
  }
  const repairForce = runFailure(process.execPath, [liftoffEntrypoint, 'repair', '--force'], {
    cwd: outsideDirectory, env: npmEnv
  });
  if (!repairForce.stderr.includes('Unknown flag for repair')) throw new Error('Repair unexpectedly accepted force authority.');
  const repairCapabilities = JSON.parse(run(process.execPath, [liftoffEntrypoint, 'repair', '--capabilities', '--json'], {
    cwd: outsideDirectory, env: npmEnv
  }).stdout);
  if (repairCapabilities.schemaVersion !== 1 || repairCapabilities.repairContractVersion !== 1 ||
      repairCapabilities.schemas?.preview !== 2 || repairCapabilities.schemas?.journal !== 2 ||
      !repairCapabilities.recipes?.some((recipe) => recipe.id === 'application-layout-patch' && recipe.version === 1)) {
    throw new Error('Installed repair capabilities did not expose the actual versioned application lane.');
  }

  const { verifyWindowsJobControllerAsset: installedVerifyAsset } = await import(
    pathToFileURL(path.join(installedPackageRoot, 'dist', 'adapters', 'process', 'windows-job-runner.js')).href
  );
  const installedControllerAsset = await installedVerifyAsset();
  if (!existsSync(installedControllerAsset)) {
    throw new Error('Installed package did not include verified windows-job-controller.ps1 asset.');
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

  const retiredPlan = runFailure(process.execPath, [
    liftoffEntrypoint, 'plan', '--type', 'power-apps-code-app',
    '--spec', 'openspec', '--agents', 'copilot'
  ], {
    cwd: outsideDirectory,
    env: npmEnv
  });
  if (!/retired/i.test(retiredPlan.stderr)) {
    throw new Error('Installed Liftoff did not explain the retired Power Apps workload');
  }
  if (JSON.stringify(await readdir(outsideDirectory)) !== JSON.stringify(beforePlan)) {
    throw new Error('Retired workload rejection changed the working directory');
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

  const assessHelp = run(process.execPath, [liftoffEntrypoint, 'governance', 'assess', '--help'], {
    cwd: outsideDirectory, env: npmEnv
  });
  if (!assessHelp.stdout.includes('assess') || !assessHelp.stdout.includes('--live')) {
    throw new Error('Installed governance assessment help does not expose local/live scope.');
  }
  const ordinaryRepository = path.join(tempRoot, 'ordinary git repository');
  run('git', ['init', '--quiet', '--template=', '--initial-branch=develop', ordinaryRepository], {
    cwd: tempRoot,
    env: {
      ...npmEnv,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'
    }
  });
  const nestedDirectory = path.join(ordinaryRepository, 'nested directory');
  await mkdir(nestedDirectory);
  const ordinaryBefore = await treeDigest(ordinaryRepository);
  for (const args of [
    ['governance', 'assess', '--json'],
    ['governance', 'assess', '--project', ordinaryRepository, '--json']
  ]) {
    const result = runFailure(process.execPath, [liftoffEntrypoint, ...args], {
      cwd: nestedDirectory, env: npmEnv
    });
    const report = JSON.parse(result.stdout);
    if (
      result.status !== 2 || report.readOnly !== true || report.mode !== 'local' ||
      report.outcome !== 'partial' || report.schemaVersion !== 1 ||
      report.target?.profile !== 'single-maintainer-gitflow' ||
      report.projectIdentity?.manifestVersion !== null ||
      report.projectIdentity?.availability !== 'unavailable'
    ) {
      throw new Error('Installed ordinary-Git assessment invented project identity or lost its read-only target.');
    }
  }
  if (await treeDigest(ordinaryRepository) !== ordinaryBefore) {
    throw new Error('Installed ordinary-Git assessment initialized or modified its repository.');
  }
  const { buildProjectPlan: installedPlan } = await import(pathToFileURL(path.join(installedPackageRoot, 'dist', 'planner.js')).href);
  const { buildArtifacts: installedArtifacts } = await import(pathToFileURL(path.join(installedPackageRoot, 'dist', 'templates.js')).href);
  const { writeArtifacts: installedWrite } = await import(pathToFileURL(path.join(installedPackageRoot, 'dist', 'file-system.js')).href);
  const repairProject = path.join(tempRoot, 'guided repair project');
  const repairArtifacts = installedArtifacts(installedPlan({
    projectName: 'Repair Smoke', projectType: 'standard', apiStack: 'node',
    cloud: 'azure', region: 'eastus', specWorkflow: 'openspec', agents: ['copilot', 'claude', 'codex'],
    includeFrontend: false, governanceProfile: 'none', environments: ['dev']
  }, { requireProjectName: true }));
  const nativeRepairPaths = [
    ['liftoff-repair-copilot', '.github', 'prompts', 'liftoff-repair.prompt.md'],
    ['liftoff-repair-claude', '.claude', 'commands', 'liftoff-repair.md'],
    ['liftoff-repair-codex', '.agents', 'skills', 'liftoff-repair', 'SKILL.md']
  ];
  for (const [logicalName, ...parts] of nativeRepairPaths) {
    const artifact = repairArtifacts.find((entry) => entry.logicalName === logicalName);
    if (!artifact || artifact.lifecycle !== 'managed-core' || artifact.pathParts.join('/') !== parts.join('/') ||
        !artifact.content.includes('liftoff repair --capabilities --json')) {
      throw new Error(`Installed package failed to render the exact native repair integration ${logicalName}.`);
    }
  }
  await installedWrite(repairProject, repairArtifacts);
  await mkdir(path.join(repairProject, 'legacy-code'));
  await mkdir(path.join(repairProject, 'checks'));
  const customSource = 'export const calculate = value => value * 4 + 5;\n';
  const testSource = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { calculate } from '../legacy-code/custom.mjs';\ntest('retains customized behavior', () => assert.equal(calculate(7), 33));\n";
  await writeFile(path.join(repairProject, 'legacy-code', 'custom.mjs'), customSource);
  await writeFile(path.join(repairProject, 'checks', 'custom.test.mjs'), testSource);
  const beforeApplication = await treeDigest(repairProject);
  const inventory = JSON.parse(run(process.execPath, [liftoffEntrypoint, 'repair', repairProject, '--inspect-layout', '--json'], {
    cwd: outsideDirectory, env: npmEnv
  }).stdout);
  if (inventory.schemaVersion !== 2 || inventory.status !== 'inspected' || inventory.application?.complete !== true ||
      await treeDigest(repairProject) !== beforeApplication) throw new Error('Installed application inventory was incomplete or changed the project.');
  const actualInventory = inventory.application;
  const anchor = actualInventory.target.artifacts.find((entry) => entry.component === 'backend');
  const applicationStage = path.join(tempRoot, 'application staging');
  await mkdir(applicationStage);
  const pairs = [
    { source: ['legacy-code', 'custom.mjs'], target: ['backend', 'src', 'custom.mjs'], content: customSource, role: 'application', customization: 'preserved' },
    { source: ['checks', 'custom.test.mjs'], target: ['checks', 'custom.test.mjs'], content: testSource.replace('../legacy-code/custom.mjs', '../backend/src/custom.mjs'), role: 'reference', customization: 'reviewed-edit' }
  ];
  const mappings = [];
  for (const [index, pair] of pairs.entries()) {
    const observed = actualInventory.files.find((entry) => entry.pathParts.join('/') === pair.source.join('/'));
    const stagedPathParts = [`replacement-${index}.mjs`];
    await writeFile(path.join(applicationStage, ...stagedPathParts), pair.content);
    mappings.push({
      sourcePathParts: pair.source, targetPathParts: pair.target, stagedPathParts,
      expectedSourceDigest: observed.digest, expectedSourceMode: observed.mode, targetMode: observed.mode,
      role: pair.role, targetIdentity: { kind: 'custom-component', logicalName: anchor.logicalName }, customization: pair.customization,
      references: actualInventory.references.filter((entry) => entry.sourcePathParts.join('/') === pair.source.join('/')).map((entry) => {
        const moved = pairs.find((mapping) => mapping.source.join('/') === entry.targetPathParts.join('/'));
        return { referenceId: entry.id, disposition: moved ? 'updated' : 'unchanged-reviewed', afterTargetPathParts: moved?.target ?? entry.targetPathParts };
      })
    });
  }
  const patchFile = path.join(applicationStage, 'patch.json');
  await writeFile(patchFile, JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: actualInventory.projectRoot,
    inspectionDigest: actualInventory.inspectionDigest, targetLayoutDigest: actualInventory.target.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: { commands: [{ executable: 'node', args: ['--test', 'checks/custom.test.mjs'], cwdPathParts: [],
      timeoutMs: 30_000, maxOutputBytes: 16_384, network: false }] }
  }));
  const applicationPreview = runFailure(process.execPath,
    [liftoffEntrypoint, 'repair', repairProject, '--check', '--application-patch', await realpath(patchFile), '--json'],
    { cwd: outsideDirectory, env: npmEnv });
  const applicationPlan = JSON.parse(applicationPreview.stdout);
  if (applicationPreview.status !== 2 || applicationPlan.status !== 'available' || await treeDigest(repairProject) !== beforeApplication) {
    throw new Error(`Installed application preview failed or changed project bytes: ${applicationPreview.stdout}`);
  }
  const applicationVerification = JSON.parse(run(process.execPath,
    [liftoffEntrypoint, 'repair', repairProject, '--verify-plan', applicationPlan.fingerprint, '--json'],
    { cwd: outsideDirectory, env: npmEnv }).stdout);
  if (applicationVerification.status !== 'verified' || applicationVerification.committed !== false ||
      await treeDigest(repairProject) !== beforeApplication) throw new Error('Installed staged application verification violated its scope.');
  const applicationApplied = JSON.parse(run(process.execPath,
    [liftoffEntrypoint, 'repair', repairProject, '--approve-plan', applicationPlan.fingerprint, '--json'],
    { cwd: outsideDirectory, env: npmEnv }).stdout);
  if (applicationApplied.status !== 'applied' || applicationApplied.committed !== true ||
      await readFile(path.join(repairProject, 'backend', 'src', 'custom.mjs'), 'utf8') !== customSource ||
      existsSync(path.join(repairProject, 'legacy-code', 'custom.mjs'))) {
    throw new Error('Installed application transaction did not preserve and move the exact customized source.');
  }
  const assessmentProject = path.join(tempRoot, 'assessment project');
  await installedWrite(assessmentProject, installedArtifacts(installedPlan({
    projectName: 'Assessment Smoke', projectType: 'standard', apiStack: 'go',
    cloud: 'azure', region: 'eastus', specWorkflow: 'openspec', agents: ['copilot', 'claude'],
    includeFrontend: false
  }, { requireProjectName: true })));
  const assessmentBefore = await treeDigest(assessmentProject);
  for (const flags of [[], ['--live']]) {
    const assessment = runFailure(process.execPath, [liftoffEntrypoint, 'governance', 'assess', '--json', ...flags], {
      cwd: assessmentProject, env: npmEnv
    });
    const report = JSON.parse(assessment.stdout);
    if (assessment.status !== 2 || report.schemaVersion !== 1 || report.readOnly !== true ||
        report.outcome !== 'partial' || report.target?.cliVersion !== packResult.version ||
        report.mode !== (flags.length ? 'live' : 'local') || report.coverage?.unobserved < 1) {
      throw new Error(`Installed assessment returned an invalid coverage report: ${assessment.stdout}`);
    }
  }
  if (await treeDigest(assessmentProject) !== assessmentBefore) {
    throw new Error('Installed assessment changed project files.');
  }
  const governanceRoot = path.join(assessmentProject, 'governance');
  await mkdir(governanceRoot, { recursive: true });
  await writeFile(path.join(governanceRoot, 'activation-state.json'), JSON.stringify({ schemaVersion: 99 }), 'utf8');
  const unsupportedBefore = await treeDigest(assessmentProject);
  const unsupported = runFailure(process.execPath, [liftoffEntrypoint, 'governance', 'assess', '--json'], {
    cwd: assessmentProject, env: npmEnv
  });
  const unsupportedReport = JSON.parse(unsupported.stdout);
  if (unsupported.status !== 2 || unsupportedReport.projectIdentity?.stateSource !== 'unsupported' ||
      await treeDigest(assessmentProject) !== unsupportedBefore) {
    throw new Error('Installed assessment did not preserve and explain unsupported activation state.');
  }

  if (suppliedTarball && createHash('sha256').update(await readFile(suppliedTarball)).digest('hex') !== suppliedDigest) {
    throw new Error('The qualified release tarball changed during package smoke verification.');
  }
  console.log(`Package smoke test passed for ${packResult.name}@${packResult.version}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}