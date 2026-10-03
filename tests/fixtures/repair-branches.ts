import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { runCommand } from '../../src/commands.js';
import { parseArgs } from '../../src/args.js';
import { buildArtifacts } from '../../src/templates.js';
import { buildProjectPlan } from '../../src/planner.js';
import { loadManifest } from '../../src/application/project/manifest.js';
import { inspectApplicationLayout } from '../../src/application/repair/application-inventory.js';
import { getUpdatePreviewDirectory, type UpdatePreviewOptions } from '../../src/adapters/filesystem/update-previews.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../../src/process-runner.js';
import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import type { UpdateApprovalPrompt } from '../../src/application/update/approval.js';
import type { ApplicationPatchDocument, ApplicationPatchMapping } from '../../src/application/repair/application-types.js';
import type { ApplicationPreparationRequest } from '../../src/application/repair/application-preparation-types.js';
import type { RepairWorkspaceStorageOptions } from '../../src/application/repair/workspaces-types.js';
import type { RepairReport } from '../../src/application/repair/report.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from '../helpers.js';
import { putApplicationFixtureFile } from './repair-application.js';

/** Attributable temporary roots: cleanup never reaches outside directories this helper created. */
export class TemporaryDirectories {
  private readonly created: string[] = [];

  async make(prefix: string): Promise<string> {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
    this.created.push(directory);
    return directory;
  }

  async cleanup(): Promise<void> {
    for (const directory of this.created.splice(0)) {
      await restoreOwnerAccess(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

async function restoreOwnerAccess(directory: string): Promise<void> {
  let details;
  try { details = await lstat(directory); } catch { return; }
  if (!details.isDirectory() || details.isSymbolicLink()) return;
  try { await chmod(directory, 0o700); } catch { /* Best effort inside an attributable temporary root. */ }
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await restoreOwnerAccess(path.join(directory, entry.name));
  }
}

/** Byte/mode/link inventory used to prove that no write escaped the approved scope. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (directory: string, prefix: readonly string[]): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const parts = [...prefix, name];
      const key = parts.join('/');
      const target = path.join(directory, name);
      const details = await lstat(target);
      const mode = (details.mode & 0o7777).toString(8);
      if (details.isSymbolicLink()) result[key] = `link:${await readlink(target)}`;
      else if (details.isDirectory()) {
        result[key] = `directory:${mode}`;
        await walk(target, parts);
      } else if (!details.isFile()) result[key] = `special:${mode}`;
      else result[key] = `file:${mode}:${createHash('sha256').update(await readFile(target)).digest('hex')}`;
    }
  };
  await walk(root, []);
  return result;
}

/** User-local repair records in the exact production storage location for a fixture home. */
export async function userRecordFiles(home: string, namespace?: string): Promise<string[]> {
  const directory = getUpdatePreviewDirectory({ homedir: home, env: {} });
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => namespace === undefined || name.startsWith(`${namespace}-`)).sort();
}

export function commandResult(command: ExternalCommand, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command, displayCommand: '', status: 0, signal: null, stdout: '', stderr: '',
    timedOut: false, processTreeSettled: true, ...overrides
  };
}

export function isToolProbe(command: ExternalCommand): boolean {
  return command.args.at(-1) === '--version' || command.args.length === 1 && command.args[0] === 'version';
}

export interface ProbeVersions { node?: string; npm?: string; python?: string; uv?: string; go?: string }

/** Deterministic metadata answers for already-resolved installed tool identities. */
export async function probeOutput(command: ExternalCommand, versions: ProbeVersions = {}): Promise<string> {
  const cli = command.args.find((argument) => path.basename(argument) === 'npm-cli.js');
  if (cli) {
    if (versions.npm) return versions.npm;
    const identity = JSON.parse(await readFile(path.join(path.dirname(path.dirname(cli)), 'package.json'), 'utf8')) as { version: string };
    return identity.version;
  }
  const name = path.basename(command.executable).replace(/\.exe$/iu, '').toLowerCase();
  if (name === 'go') return `go version go${versions.go ?? '1.27.1'} ${process.platform}/${process.arch}`;
  if (name === 'python' || name === 'python3') return `Python ${versions.python ?? '3.14.7'}`;
  if (name === 'uv') return `uv ${versions.uv ?? '0.12.7'}`;
  return versions.node ?? process.version;
}

export interface RecordedCall { command: ExternalCommand; options?: RunCommandOptions }
export type RunnerScript = (call: RecordedCall, calls: readonly RecordedCall[]) =>
  Promise<CommandResult | undefined> | CommandResult | undefined;

/**
 * Injected process boundary: records every request, answers tool metadata probes deterministically and
 * simulates project commands unless the script returns an explicit result. It is not native process proof.
 */
export class ScriptedRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly script: RunnerScript = () => undefined, private readonly versions: ProbeVersions = {}) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    const call = { command, options };
    this.calls.push(call);
    const scripted = await this.script(call, this.calls);
    if (scripted) return scripted;
    if (isToolProbe(command)) return commandResult(command, { stdout: `${await probeOutput(command, this.versions)}\n` });
    return commandResult(command);
  }

  effects(): RecordedCall[] {
    return this.calls.filter((call) => !isToolProbe(call.command));
  }
}

export const isNpmCi = (command: ExternalCommand): boolean => command.args.includes('ci');

/** Minimal successful frozen npm ci effect inside the private candidate copy. */
export async function simulateNpmCi(call: RecordedCall): Promise<CommandResult> {
  await mkdir(path.join(call.options!.cwd!, 'node_modules', 'registry-package'), { recursive: true, mode: 0o700 });
  await putApplicationFixtureFile(path.join(call.options!.cwd!, 'node_modules', 'registry-package'), ['index.js'],
    'module.exports = "prepared private dependency";\n', 0o600);
  return commandResult(call.command, { stdout: 'added 1 package\n' });
}

/** Copy-on-write copies of the running Node binary: stable native tool identities outside project and staging. */
export async function externalToolCopies(
  parent: string, names: readonly string[], folder = 'external tools'
): Promise<{ directory: string; files: Record<string, string> }> {
  const directory = path.join(parent, folder);
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of names) {
    const file = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    await copyFile(process.execPath, file, constants.COPYFILE_FICLONE);
    await chmod(file, 0o755);
    files[name] = file;
  }
  return { directory, files };
}

export const repairNow = new Date('2026-09-13T12:00:00Z');

export interface RepairCliOptions {
  home: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  storage?: Pick<RepairWorkspaceStorageOptions, 'beforeWorkspaceOperation'>;
}

function cliContext(root: string, options: RepairCliOptions) {
  return {
    cwd: path.dirname(root), runner: options.runner, env: options.env,
    updateNow: options.clock ?? (() => repairNow),
    updatePreview: { homedir: options.home, env: {}, ...options.storage } as UpdatePreviewOptions
  };
}

export async function repairJson(
  root: string, args: readonly string[], options: RepairCliOptions
): Promise<{ code: number; report: RepairReport; stderr: string }> {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['repair', root, ...args, '--json']), { ...cliContext(root, options), stdout, stderr });
  const text = stdout.text();
  try { return { code, report: JSON.parse(text) as RepairReport, stderr: stderr.text() }; }
  catch { throw new Error(`Repair JSON output was not parseable (exit ${code}): ${text}\n${stderr.text()}`); }
}

export async function repairHuman(
  root: string, args: readonly string[], options: RepairCliOptions, prompt?: UpdateApprovalPrompt, stdin?: Readable
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream(), stderr = ttyCaptureStream();
  const code = await runCommand(parseArgs(['repair', root, ...args]), {
    ...cliContext(root, options), stdin: stdin ?? scriptedTtyInput(''), stdout, stderr, approveRepairPlan: prompt
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function promptCancellation(): Error {
  return Object.assign(new Error('prompt cancelled by the user'), { name: 'ExitPromptError' });
}

export interface CommandFlowFixture {
  parent: string;
  root: string;
  stage: string;
  home: string;
  patch: string;
  source: string[];
  target: string[];
  check: string[];
  sourceBytes: string;
  oldTest: string;
  newTest: string;
  document: ApplicationPatchDocument;
}

/** An older, unrelated immutable repair record that every later operation must preserve byte-for-byte. */
export const historicalRepairPathParts = ['.liftoff', 'repair-history', 'a'.repeat(64), 'receipt.json'];
export const historicalRepairReceipt = '{"schemaVersion":1,"recipe":"azure-local-layout-v1","original":true}\r\n';

/**
 * A generated Node project whose customized module lives outside the current backend layout, plus an external
 * reviewed patch moving it and updating the check that imports it.
 */
export async function createCommandFlowFixture(
  parent: string, options: { network?: boolean; preparation?: ApplicationPreparationRequest[] } = {}
): Promise<CommandFlowFixture> {
  const root = path.join(parent, 'project'), stage = path.join(parent, 'staged patch'), home = path.join(parent, 'home');
  await Promise.all([root, stage, home].map((folder) => mkdir(folder)));
  const plan = buildProjectPlan({
    projectName: 'Reviewed application', projectType: 'standard', apiStack: 'node', agents: ['copilot'],
    governanceProfile: 'none', environments: ['dev']
  }, { requireProjectName: true });
  for (const file of buildArtifacts(plan)) await putApplicationFixtureFile(root, file.pathParts, file.content);
  const source = ['old-code', 'custom.mjs'], target = ['backend', 'src', 'custom.mjs'], check = ['checks', 'custom.test.mjs'];
  const sourceBytes = 'export const compute = (value) => value * 3 + 7;\n';
  const oldTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "import { compute } from '../old-code/custom.mjs';\ntest('preserves actual customized behavior', () => assert.equal(compute(11), 40));\n";
  const newTest = oldTest.replace('../old-code/custom.mjs', '../backend/src/custom.mjs');
  await putApplicationFixtureFile(root, source, sourceBytes);
  await putApplicationFixtureFile(root, check, oldTest);
  await putApplicationFixtureFile(root, historicalRepairPathParts, historicalRepairReceipt);
  const inspection = await inspectApplicationLayout(root, await loadManifest(root));
  if (!inspection.report.complete || !inspection.report.target) throw new Error(inspection.report.blockers.join('; '));
  const anchor = inspection.report.target.artifacts.find((entry) => entry.component === 'backend')!;
  const pairs = [
    { source, target, content: sourceBytes, role: 'application' as const, customization: 'preserved' as const },
    { source: check, target: check, content: newTest, role: 'reference' as const, customization: 'reviewed-edit' as const }
  ];
  const mappings: ApplicationPatchMapping[] = [];
  for (const [index, pair] of pairs.entries()) {
    const observed = inspection.report.files.find((entry) => entry.pathParts.join('/') === pair.source.join('/'))!;
    const stagedPathParts = [`replacement-${index}.mjs`];
    await putApplicationFixtureFile(stage, stagedPathParts, pair.content, 0o600);
    mappings.push({
      sourcePathParts: pair.source, targetPathParts: pair.target, stagedPathParts,
      expectedSourceDigest: observed.digest, expectedSourceMode: observed.mode, targetMode: observed.mode,
      role: pair.role, targetIdentity: { kind: 'custom-component', logicalName: anchor.logicalName },
      customization: pair.customization,
      references: inspection.report.references.filter((entry) => entry.sourcePathParts.join('/') === pair.source.join('/'))
        .map((entry) => {
          const moved = pairs.find((mapping) => mapping.source.join('/') === entry.targetPathParts.join('/'));
          return {
            referenceId: entry.id, disposition: moved ? 'updated' as const : 'unchanged-reviewed' as const,
            afterTargetPathParts: moved?.target ?? entry.targetPathParts
          };
        })
    });
  }
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: root,
    inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: {
      commands: [{
        executable: 'node', args: ['--test', check.join('/')], cwdPathParts: [],
        timeoutMs: 30_000, maxOutputBytes: 16_384, network: options.network ?? false
      }],
      ...(options.preparation ? { preparation: options.preparation } : {})
    }
  };
  const patch = path.join(stage, 'patch.json');
  await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { parent, root, stage, home, patch, source, target, check, sourceBytes, oldTest, newTest, document };
}

export const backendNpmCi = (network = false): ApplicationPreparationRequest => ({
  provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network, lifecycle: 'disabled'
});
