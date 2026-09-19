import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { applyBaselineSettingChanges, azureBaselineProviderContract, inspectAzureBaselineSettings } from '../src/application/repair/baseline-settings.js';
import { baselineTemporaryEnvironment, baselineValidationPolicy } from '../src/application/repair/baseline-validation.js';
import { parseHcl, object, singleBlock } from '../src/adapters/hcl/semantic.js';
import { createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { NodeCommandRunner, type CommandRunner, type CommandResult, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { windowsWorkingDirectoryFits } from '../src/domain/execution/windows-working-directory.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import { putApplicationFixtureFile as put } from './fixtures/repair-application.js';

const mainParts = ['infrastructure', 'opentofu', 'azure', 'modules', 'application', 'main.tf'];
const envParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
const controls = ['CKV_AZURE_148', 'CKV_AZURE_44', 'CKV_AZURE_190', 'CKV2_AZURE_47', 'CKV_AZURE_205'];
const allowedVerification = ['--allow-dependency-preparation', '--allow-network'];
interface BaselineFixture {
  directory: string; root: string; home: string; generatedMain: string;
  runner: NativeRunner; env: NodeJS.ProcessEnv;
  storage: { homedir: string; repositoryRoot: string; env: NodeJS.ProcessEnv };
  pending: number;
  cli(args: string[]): Promise<{ code: number; report: any; stderr: string }>;
  inspect(): ReturnType<typeof inspectAzureBaselineSettings>;
}
const fixtures: BaselineFixture[] = [];
const diagnostic = (result: { report: { message?: string; blockers?: string[] } }) =>
  JSON.stringify({ message: result.report.message, blockers: result.report.blockers });

class NativeRunner implements CommandRunner {
  readonly native = new NodeCommandRunner();
  readonly calls: Array<{ command: ExternalCommand; options?: RunCommandOptions; result: CommandResult }> = [];
  pending = 0;
  uncertain = false;
  afterRun?: (command: ExternalCommand, options: RunCommandOptions | undefined, result: CommandResult) => Promise<void>;
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.pending++;
    try {
      const result = await this.native.run(command, options);
      this.calls.push({ command, options, result });
      if (process.env.LIFTOFF_WINDOWS_TOOLCHAIN_REPORT === '1' &&
          (result.status !== 0 || options?.ensureProcessTreeSettled && result.processTreeSettled !== true)) {
        console.info(JSON.stringify({
          kind: 'baseline-source-command-outcome',
          operation: ['--version', 'init', 'validate'].includes(command.args[0]) ? command.args[0] : 'other',
          status: result.status, timedOut: result.timedOut,
          errorCode: result.errorCode && /^[A-Z0-9_]{1,64}$/u.test(result.errorCode) ? result.errorCode : null,
          processTreeSettled: result.processTreeSettled ?? null, processSpawned: result.processSpawned ?? null,
          cwdCodeUnits: options?.cwd?.length ?? null
        }));
      }
      if (options?.ensureProcessTreeSettled && result.processTreeSettled !== true) this.uncertain = true;
      await this.afterRun?.(command, options, result);
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally { this.pending--; }
  }
}

function withoutDefaults(content: string): string {
  return content.replace(/^  (?:minimum_tls_version|min_tls_version|allow_nested_items_to_be_public)\s*=\s*(?:"[^"]+"|false)\r?\n/gmu, '');
}

async function fixture(main?: string): Promise<BaselineFixture> {
  const directory = process.platform === 'win32'
    ? await mkdtemp(path.join(process.cwd(), '.b'))
    : path.resolve('tests', `.baseline correctness ${randomUUID()}`);
  const root = path.join(directory, 'project'), home = process.platform === 'win32' ? directory : path.join(directory, 'private-home');
  await Promise.all([root, home].map((value) => mkdir(value, { recursive: true, mode: 0o700 })));
  const plan = buildProjectPlan({
    projectName: 'baseline-correctness', projectType: 'standard', apiStack: 'node', cloud: 'azure',
    environments: ['dev'], agents: ['github-copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(plan);
  const generatedMain = artifacts.find((entry) => entry.logicalName === 'opentofu-application-main')!.content;
  const runner = new NativeRunner(), env = { ...process.env };
  const storage = { homedir: home, repositoryRoot: root, env: process.platform === 'win32' ? { LOCALAPPDATA: home } : {} };
  const current: BaselineFixture = {
    directory, root, home, generatedMain, runner, env, storage, pending: 0,
    async cli(args: string[]) {
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      current.pending++;
      try {
        const { runCommand } = await import('../src/commands.js');
        const code = await runCommand(parseArgs(['repair', root, ...args, '--json']), {
          cwd: directory, stdout, stderr, runner, env, updatePreview: storage
        });
        return { code, report: JSON.parse(stdout.text()), stderr: stderr.text() };
      } finally { current.pending--; }
    },
    async inspect() { return inspectAzureBaselineSettings(root, await loadManifest(root)); }
  };
  fixtures.push(current);
  await writeArtifacts(root, artifacts);
  if (main !== undefined) await put(root, mainParts, main);
  return current;
}

async function withUnreadableInput(
  current: BaselineFixture, file: string, inspect: () => Promise<void>
) {
  if (process.platform !== 'win32') {
    const mode = (await lstat(file)).mode & 0o7777;
    await chmod(file, 0);
    try { await inspect(); } finally { await chmod(file, mode); }
    return;
  }
  // Windows chmod does not deny reads; an owned exclusive handle supplies a real denial without ACL changes.
  const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const release = path.join(current.directory, `release-read-lock-${randomUUID()}`);
  const pathDigest = createHash('sha256').update(file, 'utf8').digest('hex');
  const script = '$ErrorActionPreference="Stop"; $f=[IO.File]::Open($env:LIFTOFF_SOURCE_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); ' +
    'try { $h=[Security.Cryptography.SHA256]::Create(); ' +
    'try { $d=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($f.Name))).Replace("-","").ToLowerInvariant() } finally { $h.Dispose() }; ' +
    '[Console]::Out.WriteLine("SOURCE_FIXTURE_LOCK_READY|"+$PID+"|"+$d); [Console]::Out.Flush(); ' +
    'while (-not [IO.File]::Exists($env:LIFTOFF_SOURCE_LOCK_RELEASE)) { [GC]::KeepAlive($f); [Threading.Thread]::Sleep(20) } ' +
    '} finally { $f.Dispose() }';
  const child = childProcess.spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: current.directory, env: { ...process.env, LIFTOFF_SOURCE_LOCK_FILE: file, LIFTOFF_SOURCE_LOCK_RELEASE: release },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  current.pending++;
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => { current.pending--; resolve(code); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source fixture exclusive-read lock did not become ready.')), 15_000);
      let text = '';
      const stop = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', () => stop(new Error('Source fixture lock process could not start.')));
      child.once('close', () => stop(new Error('Source fixture lock process exited before readiness.')));
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.length > 128) stop(new Error('Source fixture lock readiness exceeded its bound.'));
        else if (text.includes('\n')) {
          const [tag, pid, digest] = text.trim().split('|');
          if (tag !== 'SOURCE_FIXTURE_LOCK_READY' || Number(pid) !== child.pid || digest !== pathDigest) {
            stop(new Error('Source fixture lock readiness did not bind its actual process and selected file.'));
          } else stop();
        }
      });
    });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await expect(lstat(release)).rejects.toMatchObject({ code: 'ENOENT' });
    let denial: string | null = null;
    try { (await readFile(file)).fill(0); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      denial = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'UNCLASSIFIED';
    }
    if (process.env.LIFTOFF_WINDOWS_TOOLCHAIN_REPORT === '1') console.info(JSON.stringify({
      kind: 'baseline-source-read-lock', processBound: true, openedFileNameBound: true,
      aliveBeforeRead: true, aliveAfterRead: child.exitCode === null && child.signalCode === null,
      releaseAbsentBeforeRead: true, denialCode: denial
    }));
    expect(denial).toMatch(/^(?:EACCES|EPERM|EBUSY)$/u);
    expect(child.exitCode).toBeNull();
    await inspect();
  } finally {
    let released = false;
    try { await writeFile(release, 'release\n', { flag: 'wx', mode: 0o600 }); released = true; }
    catch { child.kill(); }
    const wait = (milliseconds: number) => new Promise<undefined>((resolve) => setTimeout(resolve, milliseconds));
    let outcome = await Promise.race([closed, wait(2000)]);
    if (outcome === undefined) {
      child.kill();
      outcome = await Promise.race([closed, wait(2000)]);
    }
    if (outcome === undefined) throw new Error('Retain the fixture: its exact lock process did not settle.');
    if (!released || outcome !== 0) throw new Error('Source fixture lock process did not complete its owned release protocol.');
    await unlink(release);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const current of fixtures.splice(0)) {
    const workspaces = await inspectRepairVerificationWorkspaces(current.root, current.storage);
    if (current.pending || current.runner.pending || current.runner.uncertain || workspaces.issues.length ||
        workspaces.workspaces.some((entry) => !entry.cleanupComplete)) {
      throw new Error(`Retaining potentially active baseline fixture: ${current.directory}`);
    }
    await rm(current.directory, { recursive: true, force: true });
  }
});

const legacy = `resource "azurerm_redis_cache" "main" {
  name = "custom-redis"
  capacity = 0
  family = "C"
  sku_name = "Basic"
}

resource "azurerm_storage_account" "main" {
  name = "customstorage"
  account_tier = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_servicebus_namespace" "main" {
  name = "custom-bus"
  sku = "Standard"
}
`;

function weak(content = legacy) {
  return content.replace('  capacity = 0', '  minimum_tls_version = "1.0" # preserve this comment\n  capacity = 0')
    .replace('  account_tier = "Standard"', '  min_tls_version = "TLS1_0"\n  allow_nested_items_to_be_public = true\n  account_tier = "Standard"')
    .replace('  sku = "Standard"', '  minimum_tls_version = "1.1"\n  sku = "Standard"');
}

async function assertExactDelta(before: string, after: string) {
  const expected = await parseHcl(before, 'before'), actual = await parseHcl(after, 'after');
  const resources = object(expected.resource, 'resources');
  for (const [type, attributes] of Object.entries(azureBaselineProviderContract.settings)) {
    if (!resources[type]) continue;
    for (const blocks of Object.values(object(resources[type], type))) {
      const body = singleBlock(blocks, type);
      for (const [key, rule] of Object.entries(attributes)) body[key] = rule.target;
    }
  }
  expect(actual).toEqual(expected);
}

describe('Azure baseline source-range correctness (8.4)', () => {
  it('uses fresh source-fixture storage that fits Windows without shortening registered workspace identities', () => {
    const checkout = 'D:\\a\\liftoff\\liftoff';
    const workspace = ['liftoff', 'update-previews', 'repair-workspaces', 'a'.repeat(64), 'b'.repeat(64), 'project', ...envParts];
    const old = path.win32.join(checkout, 'tests', `.baseline correctness ${'c'.repeat(36)}`, 'private-home', 'AppData', 'Local', ...workspace);
    const current = path.win32.join(checkout, '.bABC123', ...workspace);
    expect(windowsWorkingDirectoryFits(old)).toBe(false);
    expect(windowsWorkingDirectoryFits(current)).toBe(true);
    expect(current).toContain('a'.repeat(64));
    expect(current).toContain('b'.repeat(64));
  });

  it('adds only the four declared settings without reformatting any existing line', async () => {
    const current = await fixture(legacy);
    const candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    expect(candidate.changes).toHaveLength(4);
    expect(candidate.mutations).toHaveLength(1);
    const after = candidate.mutations[0]!.type === 'write' ? candidate.mutations[0]!.content.toString() : '';
    await assertExactDelta(legacy, after);
    expect(withoutDefaults(after)).toBe(legacy);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(legacy);
  });

  it('edits only literal value ranges and preserves comments, spacing and unrelated custom source', async () => {
    const before = weak().replace('  account_replication_type = "LRS"', '  account_replication_type  =  "GRS" // enterprise customization');
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    expect(candidate.changes.every((entry) => entry.action === 'update')).toBe(true);
    const after = candidate.files.find((entry) => entry.pathParts.join('/') === mainParts.join('/'))!.content;
    expect(after).toBe(before.replace('"1.0"', '"1.2"').replace('"1.1"', '"1.2"').replace('"TLS1_0"', '"TLS1_2"')
      .replace('allow_nested_items_to_be_public = true', 'allow_nested_items_to_be_public = false'));
    await assertExactDelta(before, after);
  });

  it.each([
    '# resource "azurerm_storage_account" "main" { min_tls_version = "TLS1_0" }\n',
    '// resource "azurerm_storage_account" "main" { allow_nested_items_to_be_public = true }\n',
    '/* resource "azurerm_storage_account" "main" {\n min_tls_version = "TLS1_0"\n} */\n',
    'locals {\n  example = <<EOT\nresource "azurerm_storage_account" "main" {\n  min_tls_version = "TLS1_0"\n  allow_nested_items_to_be_public = true\n}\nEOT\n}\n',
    'locals {\n  example = <<-EOT\n    resource "azurerm_storage_account" "main" {\n      min_tls_version = "TLS1_0"\n    }\n  EOT\n}\n'
  ])('ignores fake resource and attribute text in comments or heredocs: %s', async (preamble) => {
    const before = preamble + weak();
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    const after = candidate.files.find((entry) => entry.pathParts.join('/') === mainParts.join('/'))!.content;
    expect(after.startsWith(preamble)).toBe(true);
    await assertExactDelta(before, after);
  });

  it.each([false, true])('does not edit nested tags with the same key (top-level present: %s)', async (present) => {
    const tags = '  tags = {\n    min_tls_version = "TLS1_0"\n    allow_nested_items_to_be_public = "true"\n  }\n';
    const before = (present ? weak() : legacy).replace('  name = "customstorage"\n', `  name = "customstorage"\n${tags}`);
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    const after = candidate.files.find((entry) => entry.pathParts.join('/') === mainParts.join('/'))!.content;
    expect(after).toContain(tags);
    expect(candidate.changes.find((entry) => entry.attribute === 'min_tls_version')!.action).toBe(present ? 'update' : 'add');
    await assertExactDelta(before, after);
  });

  it('preserves heredoc data, nested template strings and CRLF source inside the real resource', async () => {
    const tags = `  tags = {
    documentation = <<-EOT
      min_tls_version = "TLS1_0"
      resource "azurerm_storage_account" "main" { fake = true }
    EOT
    label = "\${format("customer-%s", var.environment)}"
  }
`;
    const before = weak().replace('  name = "customstorage"\n', `  name = "customstorage"\n${tags}`).replaceAll('\n', '\r\n');
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    const after = candidate.files.find((entry) => entry.pathParts.join('/') === mainParts.join('/'))!.content;
    expect(after).toContain(tags.replaceAll('\n', '\r\n'));
    await assertExactDelta(before, after);
  });

  it('preserves an already compliant customized document byte for byte', async () => {
    const current = await fixture();
    const customized = current.generatedMain + '\n# exact customer formatting remains\n';
    await put(current.root, mainParts, customized);
    const candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    expect(candidate.changes).toEqual([]);
    expect(candidate.mutations).toEqual([]);
    expect(candidate.files.find((entry) => entry.pathParts.join('/') === mainParts.join('/'))!.content).toBe(customized);
  });

  it.each(['"1.3garbage"', '"1.2garbage"', '"1.3"', '"1.20"', '"garbage"', 'null', 'var.redis_tls', '"${var.redis_tls}"', '("1.0")'])
  ('blocks malformed, unknown or dynamic TLS instead of guessing compliance: %s', async (value) => {
    const before = legacy.replace('  capacity = 0', `  minimum_tls_version = ${value}\n  capacity = 0`);
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers.join(' ')).toMatch(/dynamic|malformed|unsupported/);
    expect(candidate.mutations).toEqual([]);
    expect(candidate.files).toEqual([]);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
  });

  it.each(['"true"', '"false"', '123', 'local.allow_public', 'null'])('blocks nonliteral or malformed private-blob settings: %s', async (value) => {
    const current = await fixture(legacy.replace('  account_tier = "Standard"', `  allow_nested_items_to_be_public = ${value}\n  account_tier = "Standard"`));
    const candidate = await current.inspect();
    expect(candidate.blockers.join(' ')).toContain('allow_nested_items_to_be_public');
    expect(candidate.mutations).toEqual([]);
  });

  it.each([['"1.1"', '"1.3garbage"'], ['"TLS1_0"', '"TLS1_3"']])('never downgrades unregistered stronger-looking values in Service Bus or storage', async (original, replacement) => {
    const before = weak().replace(original, replacement);
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers.join(' ')).toContain('unsupported value under AzureRM 5.3.0');
    expect(candidate.mutations).toEqual([]);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
  });

  it.each([
    weak().replace('  capacity = 0', '  minimum_tls_version = "1.1"\n  capacity = 0'),
    legacy + '\nresource "azurerm_redis_cache" "main" {\n  minimum_tls_version = "1.0"\n}\n',
    '# resource "azurerm_redis_cache" "main" { minimum_tls_version = "1.0" }\n',
    'resource "azurerm_redis_cache" "main" {',
    legacy.replace('  capacity = 0', '  dynamic "minimum_tls_version" {\n    for_each = []\n    content {}\n  }\n  capacity = 0')
  ])('blocks duplicate, missing or unsupported resource/setting definitions', async (before) => {
    const current = await fixture(before), candidate = await current.inspect();
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
  });

  it('rejects missing blocks, mismatched old values and undeclared edits in a requested change set', async () => {
    const change = { resourceType: 'azurerm_redis_cache', resourceName: 'main', attribute: 'minimum_tls_version', action: 'update' as const, currentValue: '1.1', targetValue: '1.2' };
    await expect(applyBaselineSettingChanges(weak(), [change])).rejects.toThrow(/changed setting/);
    await expect(applyBaselineSettingChanges(weak(), [{ ...change, resourceName: 'missing' }])).rejects.toThrow(/missing or duplicate/);
    await expect(applyBaselineSettingChanges(weak(), [{ ...change, attribute: 'sku_name' }])).rejects.toThrow(/unsupported/);
    await expect(applyBaselineSettingChanges(weak(), [{ ...change, currentValue: '1.0' }, { ...change, currentValue: '1.0' }])).rejects.toThrow(/duplicate/);
  });

  it.each(['missing', 'unreadable'])('fails explicitly for %s required inputs, without fabricated empty validation files', async (condition) => {
    const current = await fixture(legacy);
    const file = path.join(current.root, ...envParts, 'versions.tf');
    const inspect = async () => {
      const candidate = await current.inspect();
      expect(candidate.blockers.length).toBeGreaterThan(0);
      expect(candidate.files).toEqual([]);
      expect(candidate.mutations).toEqual([]);
    };
    if (condition === 'missing') { await unlink(file); await inspect(); }
    else await withUnreadableInput(current, file, inspect);
  });

  it('rejects changed provider locks and remote module sources before any execution', async () => {
    const current = await fixture(legacy);
    const lockPath = [...envParts, '.terraform.lock.hcl'];
    const original = await readFile(path.join(current.root, ...lockPath), 'utf8');
    await put(current.root, lockPath, original.replace('5.3.0', '5.4.0'));
    expect((await current.inspect()).blockers.join(' ')).toMatch(/provider lock/);
    await put(current.root, lockPath, original);
    await put(current.root, [...envParts, 'main.tf'], 'module "application" {\n  source = "https://untrusted.invalid/module.zip"\n}\n');
    expect((await current.inspect()).blockers.join(' ')).toMatch(/module sources/);
  });

  it.each(['component', 'cloud', 'adopted', 'missing-provenance'])('requires the exact generated Azure scope: %s', async (kind) => {
    const current = await fixture(legacy), manifest = await loadManifest(current.root);
    if (kind === 'component') Object.assign(manifest.project, { workload: { kind: 'components' } });
    else if (kind === 'cloud') Object.assign(manifest.project.workload, { cloud: 'aws' });
    else {
      const artifact = manifest.projectArtifacts.find((entry) => entry.logicalName === 'opentofu-application-main')!;
      if (kind === 'adopted') Object.assign(artifact, { adoption: { recordId: '1'.repeat(64) } });
      else Object.assign(artifact, { generationHash: undefined, generatedBy: undefined });
    }
    const candidate = await inspectAzureBaselineSettings(current.root, manifest);
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
  });
});

describe('Azure baseline consent, freshness and released transactions (8.5)', () => {
  it('does not execute any process during --check or infer validation from file approval', async () => {
    const current = await fixture(legacy);
    const sync = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('Forbidden inspection process'); });
    const asyncSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Forbidden inspection process'); });
    syncBuiltinESMExports();
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    expect(preview.report.status).toBe('available');
    expect(preview.report.eligibility).toBeUndefined();
    expect(preview.report.validationPolicy.formatting).toBe('none-preserve-reviewed-source-bytes');
    expect(sync).not.toHaveBeenCalled();
    expect(asyncSpawn).not.toHaveBeenCalled();
    const fingerprint = preview.report.fingerprint;
    const premature = await current.cli(['--approve-plan', fingerprint]);
    expect(premature.code).toBe(2);
    expect(premature.report.committed).toBe(false);
    expect(premature.report.message).toContain('File approval does not authorize validation');
    for (const flags of [[], ['--allow-network'], ['--allow-dependency-preparation']]) {
      const denied = await current.cli(['--verify-plan', fingerprint, ...flags]);
      expect(denied.code).toBe(2);
      expect(denied.report.verificationEffects.attempted).toBe(false);
    }
    expect(current.runner.calls).toEqual([]);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(legacy);
  });

  it.each(['file', 'file-mode', 'directory-entry', 'directory-mode', 'directory-identity', 'manifest', 'config', 'tool'])
  ('rejects %s changes after preview before executing validation or committing', async (kind) => {
    const current = await fixture(legacy);
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    expect(preview.report.status, JSON.stringify(preview.report)).toBe('available');
    const mainPath = path.join(current.root, ...mainParts);
    if (kind === 'file') await writeFile(mainPath, legacy + '\n# newer source\n');
    else if (kind === 'file-mode') {
      const before = (await lstat(mainPath)).mode;
      await chmod(mainPath, process.platform === 'win32' ? 0o444 : 0o600);
      expect((await lstat(mainPath)).mode).not.toBe(before);
    }
    else if (kind === 'directory-entry') await put(current.root, [...mainParts.slice(0, -1), 'customer-note.txt'], 'new file\n');
    else if (kind === 'directory-mode') {
      const directory = path.dirname(mainPath), before = (await lstat(directory)).mode;
      await chmod(directory, process.platform === 'win32' ? 0o444 : 0o700);
      expect((await lstat(directory)).mode).not.toBe(before);
    }
    else if (kind === 'directory-identity') {
      const directory = path.dirname(mainPath), original = path.join(current.directory, 'preserved-original-module');
      const mode = (await lstat(directory)).mode & 0o7777;
      await rename(directory, original);
      await mkdir(directory, { mode });
      for (const name of await readdir(original)) await copyFile(path.join(original, name), path.join(directory, name));
    }
    else if (kind === 'tool') current.env.TOFU_PATH = process.execPath;
    else {
      const file = path.join(current.root, kind === 'manifest' ? 'liftoff.manifest.json' : 'liftoff.config.json');
      await writeFile(file, await readFile(file, 'utf8') + '\n');
    }
    const result = await current.cli(['--verify-plan', preview.report.fingerprint, ...allowedVerification]);
    expect(result.code).not.toBe(0);
    expect(result.report.blockers.join(' ')).toContain('changed after preview');
    expect(result.report.committed).toBe(false);
    expect(current.runner.calls).toEqual([]);
  });

  it('runs real private backend-disabled checks, then separately commits exact bytes, backup and schema-2 history', async () => {
    const current = await fixture();
    const before = withoutDefaults(current.generatedMain);
    await put(current.root, mainParts, before);
    await put(current.root, [...envParts, 'terraform.tfstate'], 'fixture state must never be copied or changed\n');
    const originalManifest = await readFile(path.join(current.root, 'liftoff.manifest.json'));
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    expect(preview.report.status, JSON.stringify(preview.report)).toBe('available');
    const candidate = await current.inspect();
    expect(candidate.snapshots.some((entry) => entry.pathParts.at(-1) === 'terraform.tfstate')).toBe(false);
    const validation = await current.cli(['--verify-plan', preview.report.fingerprint, ...allowedVerification]);
    expect(validation.code, diagnostic(validation)).toBe(0);
    expect(validation.report).toMatchObject({ schemaVersion: 2, status: 'verified', committed: false, verification: 'passed' });
    expect(current.runner.calls.map((call) => call.command.args[0])).toEqual(['--version', 'init', 'validate']);
    for (const call of current.runner.calls) {
      expect(call.command.executable).toBe(preview.report.validationPolicy.tool.file.path);
      expect(call.result.processTreeSettled).toBe(true);
      expect(call.options!.cwd).not.toContain(path.join(current.root, 'infrastructure'));
      expect(call.options!.env!.ARM_CLIENT_SECRET).toBeUndefined();
      expect(path.resolve(call.options!.cwd!, call.options!.env!.TMPDIR!))
        .toBe(path.join(path.dirname(call.options!.env!.HOME!), 'scratch'));
    }
    const init = current.runner.calls.find((call) => call.command.args[0] === 'init')!;
    expect(init.command.args).toContain('-backend=false');
    expect(init.command.args).toContain('-lockfile=readonly');
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
    const commandCount = current.runner.calls.length;
    const application = await current.cli(['--approve-plan', preview.report.fingerprint]);
    expect(application.code, diagnostic(application)).toBe(0);
    expect(application.report.status).toBe('applied');
    expect(current.runner.calls).toHaveLength(commandCount);
    const expected = candidate.files.find((file) => file.pathParts.join('/') === mainParts.join('/'))!.content;
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(expected);
    expect(await readFile(path.join(current.root, 'liftoff.manifest.json'))).toEqual(originalManifest);
    expect(await readFile(path.join(current.root, ...envParts, 'terraform.tfstate'), 'utf8')).toBe('fixture state must never be copied or changed\n');
    const history = JSON.parse(await readFile(path.join(application.report.historyPath, 'receipt.json'), 'utf8'));
    expect(history).toMatchObject({
      schemaVersion: 2, repairContractVersion: 1, recipe: { id: 'azure-baseline-settings', version: 1 },
      verification: { result: 'declared-staged-checks-passed' }, activationEvidence: 'not-issued',
      backup: { namespace: 'repair-backup' }
    });
    expect(application.report.backupPath).toBeTruthy();
    expect((await current.cli(['--recipe', 'azure-baseline-settings', '--check'])).report.status).toBe('current');
  }, 180_000);

  it('keeps validation and its effects separate when the later interactive file approval is declined', async () => {
    const current = await fixture(), before = withoutDefaults(current.generatedMain);
    await put(current.root, mainParts, before);
    const stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const questions: Array<{ message: string; default: boolean }> = [];
    const { runCommand } = await import('../src/commands.js');
    current.pending++;
    let code: number;
    try {
      code = await runCommand(parseArgs(['repair', current.root, '--recipe', 'azure-baseline-settings']), {
        cwd: current.directory, stdout, stderr, stdin: scriptedTtyInput(''),
        runner: current.runner, env: current.env, updatePreview: current.storage,
        approveRepairPlan: async (question) => {
          questions.push(question);
          return questions.length < 4;
        }
      });
    } finally { current.pending--; }
    expect(code!).toBe(2);
    expect(questions).toHaveLength(4);
    expect(questions.every((question) => question.default === false)).toBe(true);
    expect(questions[3]!.message).toContain('Apply only the reviewed');
    expect(current.runner.calls.map((call) => call.command.args[0])).toEqual(['--version', 'init', 'validate']);
    expect(stdout.text() + stderr.text()).toContain('Earlier separately authorized private validation ran');
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
  }, 180_000);

  it('rejects any change to reviewed private input bytes made by a validation process', async () => {
    const current = await fixture(), before = withoutDefaults(current.generatedMain);
    await put(current.root, mainParts, before);
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    current.runner.afterRun = async (command, options, result) => {
      if (command.args[0] === 'validate' && result.status === 0) {
        const workspace = path.dirname(options!.env!.HOME!);
        await put(path.join(workspace, 'project'), mainParts, '# unexpected private tool edit\n');
      }
    };
    const verification = await current.cli(['--verify-plan', preview.report.fingerprint, ...allowedVerification]);
    expect(verification.code).toBe(2);
    expect(verification.report.blockers.join(' ')).toContain('Reviewed infrastructure inputs changed');
    expect((await current.cli(['--approve-plan', preview.report.fingerprint])).report.committed).toBe(false);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
  }, 180_000);

  it('keeps infrastructure excluded from application-layout-patch', async () => {
    const current = await fixture(), manifest = await loadManifest(current.root);
    const { inspectApplicationLayout, inspectApplicationPatch } = await import('../src/application/repair/application-patch.js');
    const inventory = await inspectApplicationLayout(current.root, manifest);
    const stage = path.join(current.directory, 'application-patch');
    await mkdir(stage);
    await put(stage, ['main.tf'], current.generatedMain);
    const sourceMode = (await lstat(path.join(current.root, ...mainParts))).mode & 0o7777;
    const sourceDigest = createHash('sha256').update(await readFile(path.join(current.root, ...mainParts))).digest('hex');
    const patch = {
      schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: current.root,
      inspectionDigest: inventory.report.inspectionDigest, targetLayoutDigest: inventory.report.target!.digest,
      dynamicReferencesReviewed: true, unresolvedMappings: [],
      mappings: [{
        sourcePathParts: mainParts, targetPathParts: mainParts, stagedPathParts: ['main.tf'],
        expectedSourceDigest: sourceDigest, expectedSourceMode: sourceMode, targetMode: sourceMode,
        role: 'application', targetIdentity: { kind: 'generated-artifact', logicalName: 'node-backend-app' },
        customization: 'reviewed-edit', references: []
      }],
      verification: { commands: [{
        executable: 'node', args: ['--test', 'backend/test/health.test.ts'], cwdPathParts: [],
        timeoutMs: 1000, maxOutputBytes: 4096, network: false
      }] }
    };
    await put(stage, ['patch.json'], JSON.stringify(patch));
    const candidate = await inspectApplicationPatch(current.root, manifest, path.join(stage, 'patch.json'));
    expect(candidate.blockers.join(' ')).toContain('infrastructure files are excluded from application patches');
    expect(candidate.mutations).toEqual([]);
  });

  it('blocks commit after real OpenTofu rejects unrelated invalid custom configuration', async () => {
    const current = await fixture();
    const before = withoutDefaults(current.generatedMain).replace('  capacity            = 0', '  capacity            = 0\n  invalid_customer_argument = true');
    expect(before).toContain('invalid_customer_argument');
    await put(current.root, mainParts, before);
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    const validation = await current.cli(['--verify-plan', preview.report.fingerprint, ...allowedVerification]);
    expect(validation.code, diagnostic(validation)).toBe(2);
    expect(validation.report.verification).toBe('incomplete');
    expect(current.runner.calls.some((call) => call.result.status !== 0)).toBe(true);
    expect(current.runner.calls.some((call) => call.command.args[0] === 'validate')).toBe(true);
    const application = await current.cli(['--approve-plan', preview.report.fingerprint]);
    expect(application.code).toBe(2);
    expect(application.report.committed).toBe(false);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(before);
  }, 180_000);

  it('uses the released journal and preserves newer edits when interrupted repair recovery is refused', async () => {
    const current = await fixture();
    await put(current.root, mainParts, withoutDefaults(current.generatedMain));
    const preview = await current.cli(['--recipe', 'azure-baseline-settings', '--check']);
    const verified = await current.cli(['--verify-plan', preview.report.fingerprint, ...allowedVerification]);
    expect(verified.code, diagnostic(verified)).toBe(0);
    const execute = transactions.applyReviewedUpdateTransaction;
    const newer = '# newer customer edit after an interrupted write\n';
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation((root, mutations, options) => execute(root, mutations, {
      ...options,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'after-mutation' && checkpoint.index === mutations.length - 1) {
          await put(root, mainParts, newer);
          throw new Error('Controlled interruption after a newer customer edit');
        }
      }
    }));
    const applied = await current.cli(['--approve-plan', preview.report.fingerprint]);
    expect(applied.code).not.toBe(0);
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(newer);
    const recovery = await current.cli(['--recover']);
    expect(recovery.code).not.toBe(0);
    expect(recovery.report.status).toBe('blocked');
    expect(await readFile(path.join(current.root, ...mainParts), 'utf8')).toBe(newer);
  }, 180_000);
});

describe('Actual generated/remediated Azure qualification (15.6)', () => {
  it.each(['generated', 'remediated'])('passes ALL FIVE Checkov controls and backend-disabled OpenTofu on %s output', async (kind) => {
    const current = await fixture();
    if (kind === 'remediated') await put(current.root, mainParts, withoutDefaults(current.generatedMain));
    const candidate = await current.inspect();
    expect(candidate.blockers).toEqual([]);
    const directory = path.join(current.directory, 'qualification');
    await mkdir(directory);
    const env = await createApplicationEnvironment(current.env, current.root, current.home, directory);
    for (const file of candidate.files) await put(directory, ['project', ...file.pathParts], file.content);
    const executable = current.env.CHECKOV_PATH ?? 'checkov';
    const version = await current.runner.run({ executable, args: ['--version'] }, {
      cwd: directory, env: { ...current.env, TMPDIR: path.join(directory, 'scratch') },
      timeoutMs: 15_000, maxOutputBytes: 8192, ensureProcessTreeSettled: true
    });
    expect(version.status, `Missing prerequisite: Checkov is required.\n${version.errorMessage ?? version.stderr}`).toBe(0);
    const checkov = await current.runner.run({
      executable, args: ['-d', path.join(directory, 'project', 'infrastructure', 'opentofu', 'azure'),
        '--framework', 'terraform', '--check', controls.join(','), '--skip-download', '--download-external-modules', 'false',
        '--output', 'json', '--compact']
    }, { cwd: directory, env, timeoutMs: 60_000, maxOutputBytes: 262_144, ensureProcessTreeSettled: true });
    expect(checkov.status, `${checkov.errorMessage ?? ''}\n${checkov.stderr}\n${checkov.stdout}`).toBe(0);
    const checkovReport = JSON.parse(checkov.stdout), results = checkovReport.results;
    expect(checkovReport.summary.parsing_errors).toBe(0);
    expect(results.failed_checks).toEqual([]);
    expect(results.skipped_checks).toEqual([]);
    expect(new Set(results.passed_checks.map((entry: { check_id: string }) => entry.check_id)),
      'Qualification requires every requested control to execute; missing graph controls are a tool prerequisite failure, not a pass.')
      .toEqual(new Set(controls));
    const policy = await baselineValidationPolicy(current.root, current.env);
    const configuration = path.join(directory, 'home', 'tofu.rc');
    await writeFile(configuration, '');
    for (const args of policy.commands) {
      const cwd = path.join(directory, 'project', ...envParts);
      const outcome = await current.runner.run({ executable: policy.tool.file.path, args: [...args] }, {
        cwd,
        env: baselineTemporaryEnvironment({ ...env, TF_CLI_CONFIG_FILE: configuration, TF_DATA_DIR: path.join(directory, 'cache', 'tofu'), TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' },
          cwd, path.join(directory, 'scratch')),
        timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, ensureProcessTreeSettled: true
      });
      expect(outcome.status, `${outcome.stderr}\n${outcome.stdout}`).toBe(0);
      if (args[0] === 'validate') expect(JSON.parse(outcome.stdout)).toMatchObject({ valid: true, error_count: 0 });
    }
  }, 180_000);
});
