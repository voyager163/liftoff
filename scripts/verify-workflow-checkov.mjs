#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { NodeCommandRunner } from '../dist/process-runner.js';
import { executeWorkflowCheckovComponentValidator } from '../dist/workflow-context-validator.js';
import { canonicalSha256 } from '../dist/domain/governance/activation/canonical-json.js';
import { captureWorkspaceDirectoryChain, assertWorkspaceDirectorySnapshot } from '../dist/adapters/filesystem/repair-workspaces.js';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/verify-workflow-checkov.mjs; prepare the documented isolated Checkov prerequisite first.');
const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'liftoff-checkov-verification-'));
const boundary = await captureWorkspaceDirectoryChain(root);
const runner = new NodeCommandRunner(), originalRun = NodeCommandRunner.prototype.run;
const scans = [], cases = [], unsettledCommands = [];
let settled = true;
let summary;
let mutation = null, swapped = null;
let activeCase = null;
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
Object.assign(env, { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
  XDG_CACHE_HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' });
NodeCommandRunner.prototype.run = async function (command, options) {
  const result = await originalRun.call(this, command, options);
  if (result.processSpawned && !result.processTreeSettled) {
    settled = false;
    unsettledCommands.push({ executable: command.executable, args: command.args, requestedSettlement: options?.ensureProcessTreeSettled });
  }
  if (command.args.includes('--framework') && command.args.includes('terraform') && command.args.includes('--skip-download')) {
    scans.push(result);
    if (mutation) {
      assert.equal(result.status, 0); assert.equal(result.processTreeSettled, true);
      const selected = mutation; mutation = null;
      if (selected.kind === 'source-drift') await appendFile(selected.file, '\n# Real post-scan committed-input drift.\n');
      else {
        const home = options.cwd;
        assert.equal(home, options.env.HOME);
        assert(path.basename(home).startsWith('liftoff-workflow-validator-'));
        const original = await lstat(home, { bigint: true });
        const moved = path.join(root, 'original-scanner-home');
        await rename(home, moved); await mkdir(home);
        await writeFile(path.join(home, 'replacement-marker'), 'Isolated replacement; not validator cleanup authority.\n');
        swapped = { home, moved, original, boundary: await captureWorkspaceDirectoryChain(home) };
      }
    }
  }
  return result;
};
async function run(executable, args, cwd = root) {
  const result = await runner.run({ executable, args }, {
    cwd, env, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024,
    ensureProcessTreeSettled: true, stream: false
  });
  assert.equal(result.status, 0, 'A genuine verification prerequisite command failed.');
  assert.equal(result.signal, null); assert.equal(result.timedOut, false);
  assert.equal(result.processTreeSettled, true);
  return result.stdout.trim();
}
async function git(project, ...args) {
  return run('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Isolated workflow scanner fixture', '-c', 'user.email=scanner@example.invalid', ...args], project);
}
try {
  const compiled = path.join(root, 'compiled'), project = path.join(root, 'project');
  await mkdir(compiled); await mkdir(project);
  await copyFile(path.join(repository, 'package.json'), path.join(compiled, 'package.json'));
  await symlink(path.join(repository, 'node_modules'), path.join(compiled, 'node_modules'), 'dir');
  const compiler = await run(process.execPath, [path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node',
    '--rootDir', '.', '--outDir', compiled, '--declaration', 'false',
    'tests/fixtures/modern-installed-project.ts', 'tests/fixtures/modern-local-project.ts'], repository);
  assert.equal(compiler, '');
  await symlink(path.join(repository, 'assets'), path.join(compiled, 'assets'), 'dir');
  const { writeModernInstalledProject } = await import(pathToFileURL(path.join(compiled, 'tests/fixtures/modern-installed-project.js')).href);
  const { writeModernLocalFixtureInputs } = await import(pathToFileURL(path.join(compiled, 'tests/fixtures/modern-local-project.js')).href);
  const { resolveModernManifestV8SourceContract } = await import(pathToFileURL(path.join(compiled, 'src/application/project/manifest.js')).href);
  const seed = await writeModernInstalledProject(project);
  const source = resolveModernManifestV8SourceContract({ selection: seed.input.selection, recordedPlugins: seed.input.plugins });
  const components = new Map(source.layoutDescriptor.components.map(component => [component, ['source', component.replace(':', '-')]]));
  const fixture = await writeModernInstalledProject(project, 'manual', 'single-maintainer-gitflow', {
    activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
      ...[...components].map(([component, pathParts]) => ({ kind: 'component', component, pathParts })),
      { kind: 'artifact', logicalName: 'docker-compose', pathParts: ['compose.yml'] }
    ] }
  });
  await writeModernLocalFixtureInputs(fixture.input.selection, components, ['compose.yml'], fixture.write);
  const component = [...components.keys()].find(name => name.startsWith('opentofu-'));
  assert(component, 'The actual current5 fixture must select an OpenTofu component.');
  const file = [...components.get(component), 'main.tf'];
  const sourceText = (prefix, suppress = false) => `resource "azurerm_network_security_group" "fixture" {
${suppress ? '  #checkov:skip=CKV_AZURE_10:Deliberately suppressed fixture finding; must not qualify.\n' : ''}  name = "isolated-source"
  location = "eastus"
  resource_group_name = "fixture-only"
  security_rule {
    name = "ssh"
    priority = 100
    direction = "Inbound"
    access = "Allow"
    protocol = "Tcp"
    source_port_range = "*"
    destination_port_range = "22"
    source_address_prefix = "${prefix}"
    destination_address_prefix = "VirtualNetwork"
  }
}
`;
  await fixture.write(file, sourceText('10.0.0.0/24'));
  await git(project, 'init', '--quiet');
  await git(project, 'remote', 'add', 'origin', 'https://github.com/fixture-owner/fixture-repo.git');
  await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '-m', 'Real restricted-ingress source fixture');
  for (const variant of ['green', 'red', 'suppressed', 'empty', 'source-drift', 'home-swap']) {
    const body = variant === 'empty' ? 'locals {\n  no_resources = true\n}\n' :
      sourceText(variant === 'red' || variant === 'suppressed' ? '*' : '10.0.0.0/24', variant === 'suppressed');
    if (variant !== 'green') {
      await fixture.write(file, body);
      await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '--allow-empty', '-m', `Isolated scanner scenario: ${variant}`);
    }
    if (variant === 'source-drift' || variant === 'home-swap') mutation = { kind: variant, file: path.join(project, ...file) };
    const sha = await git(project, 'rev-parse', 'HEAD'), count = scans.length, start = performance.now();
    const result = await executeWorkflowCheckovComponentValidator(project, sha, component);
    const status = variant === 'green' ? 'passed' : variant === 'red' || variant === 'source-drift' ? 'failed' : 'blocked';
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.phaseProof, 'not-issued'); assert.equal(result.workloadExecution, true);
    assert.equal(result.retainedExecutionDirectory, variant === 'home-swap' ? swapped?.home : null);
    assert.equal(Object.keys(result).length, 13);
    assert.equal(scans.length, count + 1, 'Exactly one actual scanner command must execute per invocation.');
    const scan = scans.at(-1), actual = JSON.parse(scan.stdout);
    activeCase = { variant, result, actualScannerReport: actual };
    assert.equal(scan.processTreeSettled, true);
    assert.equal(result.command.stdoutDigest, canonicalSha256(scan.stdout));
    if (variant === 'empty') {
      assert.deepEqual(actual, { passed: 0, failed: 0, skipped: 0, parsing_errors: 0,
        resource_count: 0, checkov_version: '3.3.20' }, 'The actual empty scan is summary-only, not ordinary finding coverage.');
      assert.equal(result.code, 'validator-checkov');
      cases.push({ variant, sourceSha: sha, durationMs: performance.now() - start, result,
        reportShape: 'summary-only-zero-coverage', sourceBytes: body });
      activeCase = null;
      continue;
    }
    assert.equal(actual.summary.skipped, variant === 'suppressed' ? 1 : 0); assert.equal(actual.summary.parsing_errors, 0);
    assert.equal(actual.summary.resource_count, variant === 'empty' ? 0 : 1); assert.equal(actual.summary.checkov_version, '3.3.20');
    assert.equal(actual.summary.failed, variant === 'red' ? 1 : 0);
    if (variant === 'red') {
      assert.deepEqual(actual.results.failed_checks.map(check => check.check_id), ['CKV_AZURE_10']);
      assert.equal(result.code, 'validator-checkov-findings');
    } else {
      assert.equal(actual.summary.failed, 0);
      if (variant === 'source-drift') assert.equal(result.code, 'validator-source-mismatch');
      if (variant === 'empty' || variant === 'suppressed') assert.equal(result.code, 'validator-checkov');
    }
    let ownership;
    if (variant === 'home-swap') {
      assert.equal(result.code, 'validator-cleanup'); assert(swapped);
      assert.equal(await readFile(path.join(swapped.home, 'replacement-marker'), 'utf8'), 'Isolated replacement; not validator cleanup authority.\n');
      const moved = await lstat(swapped.moved, { bigint: true });
      assert.equal(moved.dev, swapped.original.dev); assert.equal(moved.ino, swapped.original.ino);
      assert.equal(await readFile(path.join(swapped.moved, 'checkov.yml'), 'utf8'), '{}\n');
      ownership = { replacementPreservedAtValidatorReturn: true, originalHomePreservedAtValidatorReturn: true };
      await assertWorkspaceDirectorySnapshot(swapped.boundary); await rm(swapped.home, { recursive: true });
      ownership.testHarnessDisposedOwnReplacementAfterObservation = true;
    }
    cases.push({ variant, sourceSha: sha, durationMs: performance.now() - start, result, summary: actual.summary,
      sourceBytes: body, ownership });
    activeCase = null;
  }
  summary = { scope: 'real local current5 component scanner only', cases,
    hostedQualification: false, nativeQualification: false, phaseProof: 'not-issued' };
} finally {
  NodeCommandRunner.prototype.run = originalRun;
  if (settled && summary) {
    await assertWorkspaceDirectorySnapshot(boundary);
    await rm(root, { recursive: true });
  } else {
    process.stderr.write(`Verification was incomplete or its original process tree was not fully observed settled; retained fixture directory: ${root}\n`);
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ verificationCompleted: false, cases, activeCase,
      allObservedProcessesSettled: settled, unsettledCommands, retainedVerificationDirectory: root })}\n`);
  }
}
process.stdout.write(`${JSON.stringify({ ...summary, allObservedProcessesSettled: settled,
  unsettledCommands, retainedVerificationDirectory: settled ? null : root })}\n`);
