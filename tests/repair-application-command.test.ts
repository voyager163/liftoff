import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/planner.js';
import { loadManifest } from '../src/application/project/manifest.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { inspectApplicationLayout } from '../src/application/repair/application-inventory.js';
import type { ApplicationPatchDocument, ApplicationPatchMapping } from '../src/application/repair/application-types.js';
import { NodeCommandRunner, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { UpdateApprovalPrompt } from '../src/application/update/approval.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';

const roots: string[] = [];
type FlowObservation = {
  started: number; phase: 'fixture' | 'inventory' | 'preview' | 'reject-unverified' | 'verification' | 'apply' | 'readback' | 'complete';
  commandStarted: boolean; commandReturned: boolean; treeSettled: boolean | null; commandTimedOut: boolean | null;
};
let flowObservation: FlowObservation | undefined;
const now = new Date('2026-09-13T12:00:00Z');
afterEach(async () => {
  vi.restoreAllMocks();
  const observation = flowObservation; flowObservation = undefined;
  const registered = roots.splice(0);
  const retain = observation !== undefined && observation.phase !== 'complete';
  if (process.platform === 'win32' && observation) console.log(JSON.stringify({
    kind: 'native-windows-repair-command-flow', phase: observation.phase,
    elapsedMs: Math.trunc(performance.now() - observation.started),
    commandStarted: observation.commandStarted, commandReturned: observation.commandReturned,
    treeSettled: observation.treeSettled, commandTimedOut: observation.commandTimedOut,
    retainedOwnedRoots: retain ? registered.length : 0, rawPathsRecorded: false, processOutputRecorded: false
  }));
  if (!retain) for (const root of registered) await rm(root, { recursive: true, force: true });
});

async function put(root: string, parts: string[], content: string) {
  const file = path.join(root, ...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(network = false) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), process.platform === 'win32' ? "lf repair's-" : "liftoff-guided repair's-")));
  roots.push(parent);
  const root = path.join(parent, 'project'), stage = path.join(parent, 'staged patch'), home = path.join(parent, 'home');
  await Promise.all([root, stage, home].map((folder) => mkdir(folder)));
  const plan = buildProjectPlan({
    projectName: 'Reviewed application', projectType: 'standard', apiStack: 'node', agents: ['copilot'],
    governanceProfile: 'none', environments: ['dev']
  }, { requireProjectName: true });
  for (const file of buildArtifacts(plan)) await put(root, file.pathParts, file.content);
  const source = ['old-code', 'custom.mjs'], target = ['backend', 'src', 'custom.mjs'];
  const check = ['checks', 'custom.test.mjs'];
  const sourceBytes = 'export const compute = (value) => value * 3 + 7;\n';
  const oldTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { compute } from '../old-code/custom.mjs';\ntest('preserves actual customized behavior', () => assert.equal(compute(11), 40));\n";
  const newTest = oldTest.replace('../old-code/custom.mjs', '../backend/src/custom.mjs');
  await put(root, source, sourceBytes);
  await put(root, check, oldTest);
  const oldHistory = ['.liftoff', 'repair-history', 'a'.repeat(64), 'receipt.json'];
  const historical = '{"schemaVersion":1,"recipe":"azure-local-layout-v1","original":true}\r\n';
  await put(root, oldHistory, historical);
  const proof = ['governance', 'activation-state.json'];
  await put(root, proof, '{"original":"not activation proof"}\n');
  const manifestBefore = await readFile(path.join(root, 'liftoff.manifest.json'));
  const inspection = await inspectApplicationLayout(root, await loadManifest(root));
  expect(inspection.report.blockers).toEqual([]);
  const anchor = inspection.report.target!.artifacts.find((entry) => entry.component === 'backend')!;
  const pairs = [
    { source, target, content: sourceBytes, role: 'application' as const, customization: 'preserved' as const },
    { source: check, target: check, content: newTest, role: 'reference' as const, customization: 'reviewed-edit' as const }
  ];
  const mappings: ApplicationPatchMapping[] = [];
  for (const [index, pair] of pairs.entries()) {
    const observed = inspection.report.files.find((entry) => entry.pathParts.join('/') === pair.source.join('/'))!;
    const stagedPathParts = [`replacement-${index}.mjs`];
    await put(stage, stagedPathParts, pair.content);
    mappings.push({
      sourcePathParts: pair.source, targetPathParts: pair.target, stagedPathParts,
      expectedSourceDigest: observed.digest, expectedSourceMode: observed.mode, targetMode: observed.mode,
      role: pair.role, targetIdentity: { kind: 'custom-component', logicalName: anchor.logicalName },
      customization: pair.customization,
      references: inspection.report.references.filter((entry) => entry.sourcePathParts.join('/') === pair.source.join('/'))
        .map((entry) => {
          const moved = pairs.find((mapping) => mapping.source.join('/') === entry.targetPathParts.join('/'));
          return {
            referenceId: entry.id, disposition: moved ? 'updated' : 'unchanged-reviewed',
            afterTargetPathParts: moved?.target ?? entry.targetPathParts
          };
        })
    });
  }
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: root,
    inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target!.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: { commands: [{ executable: 'node', args: ['--test', check.join('/')], cwdPathParts: [],
      timeoutMs: 30_000, maxOutputBytes: 16_384, network }] }
  };
  const patch = path.join(stage, 'patch.json');
  await writeFile(patch, `${JSON.stringify(document, null, 2)}\n`);
  return { root, stage, home, patch, source, target, check, sourceBytes, oldTest, newTest, document, manifestBefore, oldHistory, historical, proof };
}

class Runner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  readonly native = new NodeCommandRunner();
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.calls.push({ command, options });
    return this.native.run(command, options);
  }
}

async function json(project: Awaited<ReturnType<typeof fixture>>, args: string[], runner = new Runner()) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['repair', project.root, ...args, '--json']), {
    cwd: path.dirname(project.root), stdout, stderr, runner, updateNow: () => now,
    updatePreview: { homedir: project.home, env: process.platform === 'win32' ? { LOCALAPPDATA: project.home } : {} }
  });
  return { code, report: JSON.parse(stdout.text()), runner, stderr: stderr.text() };
}

async function interactive(
  project: Awaited<ReturnType<typeof fixture>>, prompt: UpdateApprovalPrompt, runner = new Runner(),
  stdin: Readable = scriptedTtyInput(''), clock: () => Date = () => now
) {
  const stdout = new CaptureStream(), stderr = ttyCaptureStream();
  const code = await runCommand(parseArgs(['repair', project.root, '--application-patch', project.patch]), {
    cwd: path.dirname(project.root), stdin, stdout, stderr, runner, updateNow: clock,
    updatePreview: { homedir: project.home, env: process.platform === 'win32' ? { LOCALAPPDATA: project.home } : {} }, approveRepairPlan: prompt
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), runner };
}

describe('installed application-patch command flow', () => {
  it('inventories, previews, independently verifies actual behavior and applies one exact JSON transaction', async () => {
    const observation: FlowObservation = {
      started: performance.now(), phase: 'fixture',
      commandStarted: false, commandReturned: false, treeSettled: null, commandTimedOut: null
    };
    flowObservation = observation;
    const project = await fixture(), runner = new Runner();
    const execute = runner.run.bind(runner);
    runner.run = async (command, options) => {
      observation.commandStarted = true;
      const result = await execute(command, options);
      observation.commandReturned = true;
      observation.treeSettled = result.processTreeSettled ?? null;
      observation.commandTimedOut = result.timedOut;
      return result;
    };
    observation.phase = 'inventory';
    const inventory = await json(project, ['--inspect-layout'], runner);
    expect(inventory.code).toBe(0);
    expect(inventory.report).toMatchObject({ schemaVersion: 2, status: 'inspected', committed: false, application: { complete: true } });
    observation.phase = 'preview';
    const preview = await json(project, ['--check', '--application-patch', project.patch], runner);
    expect(preview.report.blockers).toEqual([]);
    expect(preview.report.status).toBe('available');
    expect(preview.report.identity.recipe.id).toBe('application-layout-patch');
    expect(runner.calls).toEqual([]);
    const fingerprint = preview.report.fingerprint;
    observation.phase = 'reject-unverified';
    const missingVerification = await json(project, ['--approve-plan', fingerprint], runner);
    expect(missingVerification.code).toBe(2);
    expect(missingVerification.report.committed).toBe(false);
    expect(runner.calls).toEqual([]);
    observation.phase = 'verification';
    const verified = await json(project, ['--verify-plan', fingerprint], runner);
    expect(verified.report.blockers).toEqual([]);
    expect(verified.code).toBe(0);
    expect(verified.report).toMatchObject({ status: 'verified', committed: false, repairScopeComplete: false, verification: 'passed' });
    expect(runner.calls).toHaveLength(1);
    expect(path.relative(project.root, runner.calls[0].options!.cwd!).startsWith('..')).toBe(true);
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    observation.phase = 'apply';
    const applied = await json(project, ['--approve-plan', fingerprint], runner);
    expect(applied.report.blockers).toEqual([]);
    expect(applied.code).toBe(0);
    expect(applied.report).toMatchObject({ status: 'applied', committed: true, repairScopeComplete: true, verification: 'passed' });
    observation.phase = 'readback';
    expect(runner.calls).toHaveLength(1);
    expect(await readFile(path.join(project.root, ...project.target), 'utf8')).toBe(project.sourceBytes);
    expect(await readFile(path.join(project.root, ...project.check), 'utf8')).toBe(project.newTest);
    await expect(stat(path.join(project.root, ...project.source))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.manifestBefore);
    expect(await readFile(path.join(project.root, ...project.oldHistory), 'utf8')).toBe(project.historical);
    expect(await readFile(path.join(project.root, ...project.proof), 'utf8')).toBe('{"original":"not activation proof"}\n');
    const history = JSON.parse(await readFile(path.join(applied.report.historyPath, 'receipt.json'), 'utf8'));
    expect(history).toMatchObject({ schemaVersion: 2, repairContractVersion: 1, recipe: { id: 'application-layout-patch', version: 1 }, activationEvidence: 'not-issued' });
    expect(path.relative(project.root, applied.report.backupPath).startsWith('..')).toBe(true);
    observation.phase = 'complete';
  }, 30_000);

  it('runs normal human repair through separate default-No script, network and file prompts without hash entry', async () => {
    const project = await fixture(true), runner = new Runner();
    const prompts: string[] = [];
    const result = await interactive(project, async (config) => {
      expect(config.default).toBe(false);
      expect(config.message).not.toMatch(/[a-f0-9]{64}/u);
      prompts.push(config.message);
      expect(runner.calls.length).toBe(prompts.length === 3 ? 1 : 0);
      return true;
    }, runner);
    expect(result.code, result.stdout).toBe(0);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('project verification commands');
    expect(prompts[1]).toContain('network');
    expect(prompts[2]).toContain('application file changes');
    expect(await readFile(path.join(project.root, ...project.target), 'utf8')).toBe(project.sourceBytes);
  }, 30_000);

  it('collects network consent before any project verification command', async () => {
    const project = await fixture(true), runner = new Runner();
    let prompts = 0;
    const result = await interactive(project, async () => ++prompts === 1, runner);
    expect(result.code).toBe(2);
    expect(prompts).toBe(2);
    expect(runner.calls).toEqual([]);
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    const preview = await json(project, ['--check', '--application-patch', project.patch], runner);
    const denied = await json(project, ['--verify-plan', preview.report.fingerprint], runner);
    expect(denied.code).toBe(2);
    expect(runner.calls).toEqual([]);
  });

  it.each(['no', 'cancel'] as const)('reports earlier verifier effects when final file consent is %s', async (answer) => {
    const project = await fixture(), runner = new Runner();
    let prompts = 0;
    const result = await interactive(project, async () => {
      if (++prompts === 1) return true;
      if (answer === 'cancel') throw Object.assign(new Error('cancel'), { name: 'ExitPromptError' });
      return false;
    }, runner);
    expect(result.code).toBe(2);
    expect(runner.calls).toHaveLength(1);
    expect(result.stdout).toContain('earlier separately authorized verifier effects are not rolled back');
    expect(result.stdout).not.toContain('no verification command or application file transaction ran');
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    await expect(stat(path.join(project.root, ...project.target))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it.each(['script', 'network', 'file'] as const)('revalidates the same immutable plan after the %s prompt', async (phase) => {
    const project = await fixture(phase === 'network'), runner = new Runner();
    let prompts = 0;
    const selected = phase === 'script' ? 1 : 2;
    const result = await interactive(project, async () => {
      if (++prompts === selected) await put(project.root, ['concurrent.mjs'], 'export const changed = true;\n');
      return true;
    }, runner);
    expect(prompts).toBe(selected);
    expect(result.code).toBe(phase === 'file' ? 2 : 1);
    expect(runner.calls).toHaveLength(phase === 'file' ? 1 : 0);
    expect(result.stdout).toContain('no substitute plan was approved');
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    await expect(stat(path.join(project.root, ...project.target))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('does not extend expired verification after a file approval prompt', async () => {
    const project = await fixture(), runner = new Runner();
    let instant = now, prompts = 0;
    const result = await interactive(project, async () => {
      if (++prompts === 2) instant = new Date(now.getTime() + 16 * 60_000);
      return true;
    }, runner, scriptedTtyInput(''), () => instant);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('expired');
    expect(runner.calls).toHaveLength(1);
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    await expect(stat(path.join(project.root, ...project.target))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('refuses stale verification after staged bytes or protected desired-state bytes change', async () => {
    const project = await fixture(), runner = new Runner();
    const preview = await json(project, ['--check', '--application-patch', project.patch], runner);
    const verified = await json(project, ['--verify-plan', preview.report.fingerprint], runner);
    expect(verified.code).toBe(0);
    await writeFile(path.join(project.stage, 'replacement-0.mjs'), 'export const compute = () => 0;\n');
    const stale = await json(project, ['--approve-plan', preview.report.fingerprint], runner);
    expect(stale.code).not.toBe(0);
    expect(stale.report.committed).toBe(false);
    expect(runner.calls).toHaveLength(1);
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.sourceBytes);
    await writeFile(path.join(project.stage, 'replacement-0.mjs'), project.sourceBytes);
    const config = path.join(project.root, 'liftoff.config.json');
    await writeFile(config, `${await readFile(config, 'utf8')}\n`);
    const changedConfig = await json(project, ['--approve-plan', preview.report.fingerprint], runner);
    expect(changedConfig.code).toBe(1);
    expect(changedConfig.report.committed).toBe(false);
    expect(changedConfig.report.blockers.join(' ')).toContain('changed after preview');
    expect(runner.calls).toHaveLength(1);
  }, 30_000);

  it('does not consume piped yes or prompt in bare JSON mode', async () => {
    const project = await fixture(), runner = new Runner(), prompt = vi.fn(async () => true);
    const piped = await interactive(project, prompt, runner, Readable.from(['yes\nyes\n']));
    expect(piped.code).toBe(2);
    expect(prompt).not.toHaveBeenCalled();
    const preview = await json(project, ['--application-patch', project.patch], runner);
    expect(preview.code).toBe(2);
    expect(preview.report.status).toBe('available');
    expect(runner.calls).toEqual([]);
  });

  it('retains committed progress and history when a later edit invalidates final readback', async () => {
    const project = await fixture(), runner = new Runner();
    const preview = await json(project, ['--check', '--application-patch', project.patch], runner);
    expect((await json(project, ['--verify-plan', preview.report.fingerprint], runner)).code).toBe(0);
    const actualTransaction = transactions.applyReviewedUpdateTransaction;
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation(async (...args) => {
      const result = await actualTransaction(...args);
      if (result.committed) await put(project.root, project.target, 'export const laterDevelopment = true;\n');
      return result;
    });
    const result = await json(project, ['--approve-plan', preview.report.fingerprint], runner);
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({ status: 'partial', committed: true, repairScopeComplete: false, verification: 'incomplete' });
    expect(result.report.blockers.join(' ')).toContain('final byte/mode readback');
    expect(await readFile(path.join(project.root, ...project.target), 'utf8')).toContain('laterDevelopment');
    expect(await readFile(path.join(result.report.historyPath, 'manifest.json'))).toEqual(project.manifestBefore);
    await expect(stat(path.join(project.root, ...project.source))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});
