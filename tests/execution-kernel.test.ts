import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyReviewedExecution, requestReviewedFileApproval, type ReviewedExecutionOptions
} from '../src/application/execution/kernel.js';
import {
  assertInputBindingUnchanged, assertReviewedReadback, captureInputBinding,
  captureReviewedSnapshots, captureReviewedTarget
} from '../src/application/execution/plan-binding.js';
import {
  assertNoConflictingTransactions, transactionRecoveryGuidance, withCooperatingExecutionLock
} from '../src/application/execution/cross-writers.js';
import { inspectExecutionJournal, recoverExecutionJournal } from '../src/application/execution/journal-adapter.js';
import { requestPlanApproval } from '../src/application/execution/approval.js';
import { createUpdateTransactionApprovalStore, loadUpdatePreviewReceipt } from '../src/adapters/filesystem/update-previews.js';
import { currentProjectMutationLease, projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts } from '../src/domain/project/reviewed-update-artifacts.js';
import { validatePlanInputBinding, verifyImmutablePlanBinding, reviewedSnapshotDescriptors } from '../src/domain/execution/immutable-plan.js';
import { buildUnifiedOperationOutcome, validateUnifiedOperationOutcome } from '../src/domain/execution/operation-outcome.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { validateStructuredContinuation } from '../src/protocol/continuation.js';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import { liftoffVersion } from '../src/version.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandContext } from '../src/application/context.js';
import type { CommandRunner } from '../src/process-runner.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import { repairApprovalStore } from '../src/application/repair/preview.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import {
  cleanupUpdateTestRoots, createReviewedUpdateFixture, updateTestPreviewOptions
} from './reviewed-update-helpers.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import { createApplicationRepairFixture, stageApplicationRepairFixture } from './fixtures/repair-application.js';
import {
  capturedTree, materializeReleasedJournalSource, readReleasedBaselineIndex, type CapturedJournal
} from './fixtures/released-baseline/corpus.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);
const privateMode = process.platform === 'win32' ? 0o666 : 0o600;
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupUpdateTestRoots();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory() {
  const parent = path.resolve('tests', `.execution-kernel-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  roots.push(parent);
  return parent;
}

async function fixture() {
  const parent = await directory();
  const root = path.join(parent, "project's $literal & directory"), home = path.join(parent, 'private home');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(root, 'source.bin'), Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10]), { mode: 0o640 });
  const storage = { homedir: home, env: {}, repositoryRoot: root };
  const store = createUpdateTransactionApprovalStore(root, storage);
  return { parent, root, home, storage, store };
}

async function approvedOptions(f: Awaited<ReturnType<typeof fixture>>, kind: 'update' | 'repair' = 'update') {
  const preconditions = await captureReviewedSnapshots(f.root, [['source.bin'], ['output.bin']]);
  const mutations = [{ type: 'write' as const, pathParts: ['output.bin'], content: preconditions[0]!.content! }];
  const approval = await requestReviewedFileApproval({
    kind, projectRoot: f.root, fingerprint, approvePlan: fingerprint
  }, { stderr: new CaptureStream() });
  const options: ReviewedExecutionOptions = {
    transactionKind: kind, ...(kind === 'repair' ? { repairIdentity: repairExecutionIdentity(liftoffVersion, 'application-layout-patch') } : {}),
    approval, planFingerprint: fingerprint,
    approvalStore: kind === 'repair' ? repairApprovalStore(f.root, f.storage) : f.store,
    preconditions, storage: f.storage, validatePlan: async () => {},
    verifyCommitted: () => assertReviewedReadback(f.root, mutations, preconditions)
  };
  return { mutations, options };
}

describe('bounded released input binding', () => {
  it.each(['source', 'destination', 'mode', 'directory', 'configuration', 'tool'] as const)(
    'rejects changed %s observations without reading outside the declared scope', async (change) => {
      const f = await fixture();
      const configPath = path.join(f.parent, 'reviewed inputs.json');
      await writeFile(configPath, '{"public":true}\n', { mode: 0o600 });
      const options = {
        projectRoot: f.root, sourceFiles: ['source.bin'], destinationFiles: ['output.bin'],
        directoryPaths: [''], configPath, toolChainIdentity: 'exact-runtime-a'
      };
      const binding = await captureInputBinding(options);
      if (change === 'source') await writeFile(path.join(f.root, 'source.bin'), 'new source');
      if (change === 'destination') await writeFile(path.join(f.root, 'output.bin'), 'developer destination');
      if (change === 'mode') await chmod(path.join(f.root, 'source.bin'), 0o400);
      if (change === 'directory') await mkdir(path.join(f.root, 'new directory'));
      if (change === 'configuration') await writeFile(configPath, '{"public":false}\n');
      if (change === 'tool') options.toolChainIdentity = 'exact-runtime-b';
      await expect(assertInputBindingUnchanged(binding, options)).rejects.toThrow(/changed/i);
    }
  );

  it('compares optional bindings symmetrically and validates canonical expiry numerically', async () => {
    const f = await fixture(), original = await captureInputBinding({ projectRoot: f.root });
    for (const addition of [
      { destinationBytesDigest: fingerprint }, { toolChainDigest: fingerprint },
      { configPath: path.join(f.parent, 'inputs.json'), configDigest: fingerprint },
      { expiresAt: '2030-01-01T00:00:00.000Z' }
    ]) {
      const changed = { ...original, ...addition };
      expect(verifyImmutablePlanBinding(original, changed).valid).toBe(false);
      expect(verifyImmutablePlanBinding(changed, original, { nowIso: '2026-01-01T00:00:00.000Z' }).valid).toBe(false);
    }
    const expired = { ...original, expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(verifyImmutablePlanBinding(expired, expired, { nowIso: expired.expiresAt }).mismatchCategory).toBe('expired');
    for (const invalid of ['not-a-date', '2026-02-30T00:00:00.000Z', '2030-01-01T01:00:00+01:00']) {
      expect(() => validatePlanInputBinding({ ...original, expiresAt: invalid })).toThrow(/expiresAt/);
    }
    expect(() => validatePlanInputBinding({ ...original, unknown: true })).toThrow(/unrecognized/);
    expect(() => validatePlanInputBinding({ ...original, targetIdentity: `${f.root}/../other` })).toThrow(/canonical/);
    expect(() => validatePlanInputBinding({ ...original, fileModes: { 'source.bin': 0o4644 } })).toThrow(/mode/);
  });

  it('binds the external configuration path and mode, not just its equal bytes', async () => {
    const f = await fixture(), first = path.join(f.parent, 'first.json'), second = path.join(f.parent, 'second.json');
    await writeFile(first, '{}', { mode: 0o600 });
    await writeFile(second, '{}', { mode: 0o600 });
    const options = { projectRoot: f.root, configPath: first };
    const binding = await captureInputBinding(options);
    await expect(assertInputBindingUnchanged(binding, { ...options, configPath: second })).rejects.toThrow(/configuration/i);
    await chmod(first, 0o400);
    await expect(assertInputBindingUnchanged(binding, options)).rejects.toThrow(/configuration/i);
  });

  it('keeps physical Unicode target spelling and rejects replaced target identity', async () => {
    const parent = await directory(), input = path.join(parent, 'cafe\u0301');
    await mkdir(input);
    await writeFile(path.join(input, 'source.bin'), 'source');
    const binding = await captureInputBinding({ projectRoot: input, sourceFiles: ['source.bin'] });
    expect(binding.targetIdentity).toBe(await realpath(input));
    const target = await captureReviewedTarget(input);
    await rename(input, path.join(parent, 'original'));
    await mkdir(input);
    await expect(target.assertCurrent()).rejects.toThrow(/target identity changed/);
    await expect(captureInputBinding({ projectRoot: path.join(parent, 'absent', 'target') })).rejects.toThrow(/missing/);
  });

  it('rejects link traversal, hard links and oversized reads through the released reader', async () => {
    const f = await fixture();
    await link(path.join(f.root, 'source.bin'), path.join(f.root, 'hard.bin'));
    await expect(captureReviewedSnapshots(f.root, [['hard.bin']])).rejects.toThrow(/singly linked/);
    await symlink(f.home, path.join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(f.home, 'private.txt'), 'outside scope');
    await expect(captureReviewedSnapshots(f.root, [['redirect', 'private.txt']])).rejects.toThrow(/link|junction/);
    await writeFile(path.join(f.root, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
    await expect(captureReviewedSnapshots(f.root, [['large.bin']])).rejects.toThrow(/bound/);
    expect(await readFile(path.join(f.home, 'private.txt'), 'utf8')).toBe('outside scope');
  });

  it('bounds directory iteration and preserves released descriptor bytes', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, 'many'));
    await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(path.join(f.root, 'many', `file-${i}`), '')));
    await expect(captureInputBinding({ projectRoot: f.root, directoryPaths: ['many'] })).rejects.toThrow(/entry bound/);
    const snapshots = [{ pathParts: ['z'], content: Buffer.from('raw\r\n'), mode: 0o640 }, { pathParts: ['a'] }];
    expect(reviewedSnapshotDescriptors(snapshots)).toEqual([
      { pathParts: ['a'], digest: null, mode: null },
      { pathParts: ['z'], digest: createHash('sha256').update('raw\r\n').digest('hex'), mode: 0o640 }
    ]);
  });
});

describe('issued consent and the released sealed transaction', () => {
  it.each([true, { isInteractive: true, userApprovedInteractive: true }, { status: 'approved', fingerprint, method: 'interactive' }])(
    'rejects unissued or Boolean approval %j before durable effects', async (approval) => {
      const f = await fixture(), plan = await approvedOptions(f), before = await capturedTree(f.parent);
      await expect(applyReviewedExecution(f.root, plan.mutations, { ...plan.options, approval: approval as never }))
        .rejects.toThrow(/issued.*approval/);
      expect(await capturedTree(f.parent)).toEqual(before);
    }
  );

  it('uses real default-No terminal admission; piped Yes and shared consent alone cannot mint file authority', async () => {
    const f = await fixture(), prompt = vi.fn(async () => true);
    const request = { kind: 'update' as const, projectRoot: f.root, fingerprint };
    expect(await requestReviewedFileApproval(request, {
      stdin: Readable.from(['yes\n']), stderr: ttyCaptureStream(), approvePlan: prompt
    })).toMatchObject({ status: 'required' });
    expect(prompt).not.toHaveBeenCalled();
    const stdin = scriptedTtyInput(''), stderr = ttyCaptureStream();
    const result = await requestReviewedFileApproval(request, { stdin, stderr, approvePlan: prompt });
    expect(result).toMatchObject({ status: 'approved', fingerprint, method: 'interactive' });
    expect(prompt).toHaveBeenCalledWith({ message: expect.any(String), default: false }, { input: stdin, output: stderr });
    const shared = await requestPlanApproval({ fingerprint, approvePlan: fingerprint }, { stderr });
    const plan = await approvedOptions(f);
    await expect(applyReviewedExecution(f.root, plan.mutations, { ...plan.options, approval: shared })).rejects.toThrow(/issued/);
  });

  it.each(['update', 'repair'] as const)('uses original %s identity and holds the real lease through readback and cleanup', async (kind) => {
    const f = await fixture(), plan = await approvedOptions(f, kind);
    const journal = path.join(f.root, ...(kind === 'repair' ? reviewedRepairTransactionPathParts : reviewedUpdateTransactionPathParts));
    let originalJournal: Buffer | undefined;
    const readback = vi.fn(async () => {
      expect(await currentProjectMutationLease(f.root)).toBeDefined();
      originalJournal = await readFile(journal);
      const inspection = await inspectExecutionJournal(f.root, kind, { approvalStore: plan.options.approvalStore });
      expect(inspection).toMatchObject({ status: 'committed', schemaVersion: kind === 'repair' ? 2 : 1, planFingerprint: fingerprint });
      await plan.options.verifyCommitted();
    });
    const originalRemove = plan.options.approvalStore.remove.bind(plan.options.approvalStore);
    const remove = vi.spyOn(plan.options.approvalStore, 'remove').mockImplementation(async (plan, digest) => {
      expect(await currentProjectMutationLease(f.root)).toBeDefined();
      await originalRemove(plan, digest);
    });
    const outcome = await applyReviewedExecution(f.root, plan.mutations, { ...plan.options, verifyCommitted: readback });
    expect(outcome.operation).toMatchObject({ status: 'completed', verification: 'passed', cleanup: 'completed' });
    expect(outcome.operation.committedEffects).toHaveLength(1);
    expect(readback).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalled();
    expect(originalJournal).toBeDefined();
    expect(await readFile(path.join(f.root, 'output.bin'))).toEqual(plan.mutations[0]!.content);
    expect(await currentProjectMutationLease(f.root)).toBeUndefined();
    await expect(lstat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(applyReviewedExecution(f.root, plan.mutations, plan.options)).rejects.toThrow(/issued/);
  });

  it('keeps a sealed commit and original recovery authority when locked verification fails', async () => {
    const f = await fixture(), plan = await approvedOptions(f);
    const outcome = await applyReviewedExecution(f.root, plan.mutations, {
      ...plan.options, verifyCommitted: async () => { throw new Error('controlled readback failure'); }
    });
    expect(outcome.operation).toMatchObject({ status: 'partial', verification: 'failed', cleanup: 'retained' });
    const journal = path.join(f.root, ...reviewedUpdateTransactionPathParts), before = await readFile(journal);
    expect(await inspectExecutionJournal(f.root, 'update', { approvalStore: f.store })).toMatchObject({ committed: true });
    expect(await readFile(journal)).toEqual(before);
    await writeFile(path.join(f.root, 'output.bin'), 'later developer change');
    const recovery = await recoverExecutionJournal(f.root, 'update', { approvalStore: f.store });
    expect(recovery).toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    expect(await readFile(path.join(f.root, 'output.bin'), 'utf8')).toBe('later developer change');
  });

  it('rejects changed reviewed bytes under the transaction lease before private seals or writes', async () => {
    const f = await fixture(), plan = await approvedOptions(f);
    const write = vi.spyOn(f.store, 'write');
    await writeFile(path.join(f.root, 'source.bin'), 'changed after review');
    await expect(applyReviewedExecution(f.root, plan.mutations, plan.options)).rejects.toThrow(/changed/);
    expect(write).not.toHaveBeenCalled();
    await expect(lstat(path.join(f.root, 'output.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps sealed effects independent of later caller-buffer and option changes', async () => {
    const f = await fixture(), plan = await approvedOptions(f), original = Buffer.from(plan.mutations[0]!.content);
    const outcome = await applyReviewedExecution(f.root, plan.mutations, {
      ...plan.options, verifyCommitted: async () => {},
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase !== 'prepared') return;
        plan.mutations[0]!.content.fill(0);
        plan.mutations[0]!.pathParts[0] = 'unreviewed.bin';
        plan.options.planFingerprint = 'b'.repeat(64);
      }
    });
    expect(outcome).toMatchObject({ committed: true, planFingerprint: fingerprint });
    expect(outcome.operation.committedEffects[0]!.target).toBe(path.join(f.root, 'output.bin'));
    expect(await readFile(path.join(f.root, 'output.bin'))).toEqual(original);
    await expect(lstat(path.join(f.root, 'unreviewed.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records uncertainty before a mutation and never overwrites concurrent edits during rollback', async () => {
    const f = await fixture(), plan = await approvedOptions(f);
    const journal = path.join(f.root, ...reviewedUpdateTransactionPathParts);
    await expect(applyReviewedExecution(f.root, plan.mutations, {
      ...plan.options,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase !== 'after-mutation') return;
        expect((await readFile(journal, 'utf8'))).toContain('"phase":"mutation"');
        await writeFile(path.join(f.root, 'output.bin'), 'concurrent developer effect');
        throw new Error('interrupted after the durable intent');
      }
    })).rejects.toMatchObject({ rollbackFailures: [expect.stringContaining('preserved')] });
    expect(await readFile(path.join(f.root, 'output.bin'), 'utf8')).toBe('concurrent developer effect');
    const before = await readFile(journal);
    expect((await recoverExecutionJournal(f.root, 'update', { approvalStore: f.store })).status).toBe('blocked');
    expect(await readFile(journal)).toEqual(before);
    await expect(assertNoConflictingTransactions(f.root, { currentCommand: 'update', storage: f.storage })).rejects.toThrow(/transaction blocks/);
  });
});

describe('production command admission and settlement', () => {
  async function updateFixture() {
    const root = await createReviewedUpdateFixture({
      projectName: 'Kernel reviewed update', projectType: 'standard', apiStack: 'go', cloud: 'azure',
      region: 'eastus', environments: ['dev'], specWorkflow: 'openspec', includeFrontend: false
    });
    const guide = path.join(root, ...governanceArtifactPaths.guide);
    await unlink(guide);
    return { root, guide, storage: updateTestPreviewOptions(root) };
  }
  async function command(root: string, args: string[], storage: CommandContext['updatePreview'], extra: Partial<CommandContext> = {}) {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs([...args, '--json']), {
      cwd: root, stdout, stderr, updatePreview: storage, ...extra
    });
    return { code, report: JSON.parse(stdout.text()) };
  }

  it.each(['adoption', 'skills', 'installation'])('blocks real update on a pending %s transaction without guessing recovery authority', async (kind) => {
    const f = await updateFixture();
    const preview = await command(f.root, ['update', '--check'], f.storage);
    expect(preview.code).toBe(2);
    const fingerprint = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const receipt = await loadUpdatePreviewReceipt(f.root, f.storage);
    const journal = path.join(f.root, '.liftoff', `reviewed-${kind}-transaction.json`);
    await mkdir(path.dirname(journal), { recursive: true });
    await writeFile(journal, '{"unknown":true}\n');
    const result = await command(f.root, ['update', '--approve-plan', fingerprint], f.storage);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ committed: false });
    expect(result.report.message).toContain(`${kind} transaction blocks`);
    expect(await readFile(journal, 'utf8')).toBe('{"unknown":true}\n');
    expect((await loadUpdatePreviewReceipt(f.root, f.storage)).receipt).toEqual(receipt.receipt);
    await expect(lstat(f.guide)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves real update commit, exact approval and matched receipt after receipt-consumption failure', async () => {
    const f = await updateFixture();
    const preview = await command(f.root, ['update', '--check'], f.storage);
    const fingerprint = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const previews = await import('../src/adapters/filesystem/update-previews.js');
    vi.spyOn(previews, 'consumeUpdatePreviewReceipt').mockRejectedValue(new Error('receipt retirement denied'));
    const result = await command(f.root, ['update', '--approve-plan', fingerprint], f.storage);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({
      schemaVersion: 3, status: 'partial', committed: true,
      approval: { status: 'approved', fingerprint }, receipt: { status: 'matched' }
    });
    expect(result.report.written).not.toHaveLength(0);
    expect((await readFile(f.guide)).length).toBeGreaterThan(0);
  });

  async function applicationFixture() {
    const parent = await directory();
    const project = await createApplicationRepairFixture(parent);
    const staged = await stageApplicationRepairFixture(project.root, project.stage, project.manifest);
    const home = path.join(parent, 'home');
    await mkdir(home);
    return { ...project, ...staged, home, storage: { homedir: home, env: {}, repositoryRoot: project.root } };
  }

  it.each(['bytes', 'mode', 'directory', 'configuration', 'expiry'] as const)(
    'rejects changed %s in an actual reviewed application repair before any command', async (changed) => {
      const f = await applicationFixture(), instant = new Date('2026-09-15T00:00:00.000Z');
      const runner: CommandRunner = { run: vi.fn(async () => { throw new Error('No process was authorized.'); }) };
      const preview = await command(f.root, ['repair', '--check', '--application-patch', f.patchPath], f.storage, { runner, updateNow: () => instant });
      expect(preview.report.status, JSON.stringify(preview.report.blockers)).toBe('available');
      if (changed === 'bytes') await writeFile(path.join(f.root, 'legacy', 'service.mjs'), 'different business source\n');
      if (changed === 'mode') await chmod(path.join(f.root, 'legacy', 'service.mjs'), 0o400);
      if (changed === 'directory') await mkdir(path.join(f.root, 'another-component'));
      if (changed === 'configuration') await writeFile(path.join(f.root, 'liftoff.config.json'), '{"apiStack":"go"}\n');
      if (changed === 'expiry') instant.setMinutes(instant.getMinutes() + 16);
      const result = await command(f.root, ['repair', '--approve-plan', preview.report.fingerprint], f.storage, { runner, updateNow: () => instant });
      expect(result.code).not.toBe(0);
      expect(result.report.committed).toBe(false);
      expect(runner.run).not.toHaveBeenCalled();
      await expect(lstat(path.join(f.root, 'backend', 'src', 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('retains registered workspaces and blocks recovery and new writers on uncertain repair settlement', async () => {
    const f = await applicationFixture();
    // No process is launched: the adapter result simulates an unproven owned tree.
    const runner: CommandRunner = { run: vi.fn(async (command) => ({
      command, displayCommand: '', status: 0, stdout: '', stderr: '', signal: null,
      timedOut: false, processTreeSettled: false
    })) };
    const preview = await command(f.root, ['repair', '--check', '--application-patch', f.patchPath], f.storage, { runner });
    expect(preview.report.status).toBe('available');
    const verified = await command(f.root, ['repair', '--verify-plan', preview.report.fingerprint], f.storage, { runner });
    expect(verified.report).toMatchObject({ status: 'partial', committed: false, repairScopeComplete: false, verificationEffects: { attempted: true } });
    const workspaces = await inspectRepairVerificationWorkspaces(f.root, f.storage);
    expect(workspaces.status).toBe('blocked');
    expect(workspaces.workspaces[0]).toMatchObject({ owner: 'uncertain', cleanupComplete: false });
    const retained = workspaces.workspaces[0]!.directory, bytes = await capturedTree(retained);
    const recovered = await command(f.root, ['repair', '--recover'], f.storage);
    expect(recovered.report.status).toBe('blocked');
    expect(await capturedTree(retained)).toEqual(bytes);
    const update = await command(f.root, ['update', '--approve-plan', fingerprint], f.storage);
    expect(update.report.committed).toBe(false);
    expect(update.report.message).toMatch(/private verification workspaces/);
    expect(await capturedTree(retained)).toEqual(bytes);
  });

  it('composes the real baseline recipe, independent validation receipt and sealed file transaction without network calls', async () => {
    const parent = await directory(), root = path.join(parent, 'baseline project'), home = path.join(parent, 'private home');
    await mkdir(home);
    const tool = path.join(home, process.platform === 'win32' ? 'fixture-tofu.exe' : 'fixture-tofu');
    await writeFile(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]), { mode: 0o700 });
    const plan = buildProjectPlan({
      projectName: 'Kernel baseline', projectType: 'standard', apiStack: 'node', cloud: 'azure',
      environments: ['dev'], agents: ['copilot'], governanceProfile: 'none'
    }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);
    await writeArtifacts(root, artifacts);
    await mkdir(path.join(root, '.git'));
    const main = artifacts.find((artifact) => artifact.logicalName === 'opentofu-application-main')!;
    const filename = path.join(root, ...main.pathParts);
    const original = main.content.replace(/^  (?:minimum_tls_version|min_tls_version|allow_nested_items_to_be_public)\s*=\s*(?:"[^"]+"|false)\r?\n/gmu, '');
    await writeFile(filename, original);
    const storage = { homedir: home, env: {}, repositoryRoot: root };
    const env = { ...process.env, TOFU_PATH: tool };
    // Deterministic adapter responses exercise admission and local transactions, not provider qualification.
    const runner: CommandRunner = { run: vi.fn(async (command, options) => {
      expect(command.executable).toBe(tool);
      expect(options?.ensureProcessTreeSettled).toBe(true);
      expect(options?.cwd?.startsWith(root)).toBe(false);
      expect(['--version', 'init', 'validate']).toContain(command.args[0]);
      return {
        command, displayCommand: '', status: 0, signal: null, timedOut: false, processTreeSettled: true, stderr: '',
        stdout: command.args[0] === '--version' ? 'OpenTofu v1.12.6' :
          command.args[0] === 'validate' ? '{"valid":true,"error_count":0}' : ''
      };
    }) };
    const preview = await command(root, ['repair', '--recipe', 'azure-baseline-settings', '--check'], storage, { runner, env });
    expect(preview.report.status, JSON.stringify(preview.report.blockers)).toBe('available');
    const fingerprint = preview.report.fingerprint;
    const missing = await command(root, ['repair', '--approve-plan', fingerprint], storage, { runner, env });
    expect(missing.report.committed).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
    const verified = await command(root, ['repair', '--verify-plan', fingerprint, '--allow-network', '--allow-dependency-preparation'], storage, { runner, env });
    expect(verified.report.status, JSON.stringify(verified.report.blockers)).toBe('verified');
    expect(await readFile(filename, 'utf8')).toBe(original);
    const applied = await command(root, ['repair', '--approve-plan', fingerprint], storage, { runner, env });
    expect(applied.report.blockers).toEqual([]);
    expect(applied.report).toMatchObject({ schemaVersion: 2, status: 'applied', committed: true, verification: 'passed' });
    const remediated = await readFile(filename, 'utf8');
    const { parseHcl } = await import('../src/adapters/hcl/semantic.js');
    expect(await parseHcl(remediated, 'main.tf')).toEqual(await parseHcl(main.content, 'main.tf'));
    expect(remediated).toContain('min_tls_version');
    expect(remediated).toContain('allow_nested_items_to_be_public');
    expect(remediated.replace(/^  (?:minimum_tls_version|min_tls_version|allow_nested_items_to_be_public)\s*=\s*(?:"[^"]+"|false)\r?\n/gmu, '')).toBe(original);
    expect((await inspectRepairVerificationWorkspaces(root, storage)).status).toBe('absent');
  }, 30_000);
});

describe('structural blockers and unchanged released recovery', () => {
  it.each(['update', 'repair', 'adoption', 'skills'] as const)('renders parser-valid, exactly targeted %s guidance', async (kind) => {
    const f = await fixture();
    const guidance = transactionRecoveryGuidance(f.root, kind);
    expect(guidance.continuation).toBeDefined();
    const action = validateStructuredContinuation(guidance.continuation);
    expect(action).toMatchObject({ project: f.root, cwd: f.root, targetScope: 'project' });
    const parsed = parseArgs([...action.args]);
    expect(parsed.flags.project).toBe(f.root);
    expect(action.displayCommand).toBe(guidance.recoveryCommand);
    if (kind === 'skills') expect(action.args).toEqual(['skills', 'inspect', '--scope', 'project', '--project', f.root]);
  });

  it('does not invent installation or personal recovery authority from a directory', async () => {
    const f = await fixture();
    expect(transactionRecoveryGuidance(f.root, 'installation')).not.toHaveProperty('continuation');
    expect(transactionRecoveryGuidance(f.root, 'skills', 'user')).not.toHaveProperty('recoveryCommand');
  });

  it('excludes another actual writer until the shared lease has settled', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = withCooperatingExecutionLock(f.root, async () => { entered(); await gate; }, { storage: f.storage });
    await started;
    try {
      await expect(withCooperatingExecutionLock(f.root, async () => {}, { currentCommand: 'repair', storage: f.storage }))
        .rejects.toThrow(/already in progress/);
    } finally { release(); await running; }
    await expect(lstat(await projectMutationLockPath(f.root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const index = readReleasedBaselineIndex();
  const writers = index.cases.filter((entry): entry is CapturedJournal => entry.family === 'journal' && entry.checkpoint.phase === 'committed');
  it.each(writers)('recovers original $writerId bytes and external seals through real command adapters', async (writer) => {
    const parent = await directory(), sourceRoot = path.join(parent, 'released-source'), workspace = path.join(parent, 'workspace');
    await mkdir(sourceRoot);
    await mkdir(workspace);
    await materializeReleasedJournalSource(sourceRoot, index.sources.find((entry) => entry.release === writer.release)!);
    const child = spawnSync(process.execPath, [
      path.resolve('tests/fixtures/released-baseline/journal-producer.mjs'),
      JSON.stringify({ sourceRoot, workspace, caseId: writer.writerId, checkpoint: { phase: 'after-mutation', index: 2 } })
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const handover = JSON.parse(await readFile(path.join(workspace, 'handover.json'), 'utf8'));
    const journal = path.join(handover.root, ...writer.journalPath.split('/'));
    const bytes = await readFile(journal), seals = await capturedTree(handover.home);
    const owner = await readFile(handover.lock);
    expect(JSON.parse(owner.toString()).pid).toBe(child.pid);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    const approvalStore = createUpdateTransactionApprovalStore(handover.root, {
      homedir: handover.home, repositoryRoot: handover.root, env: {}, clock: () => new Date('2026-09-10T00:00:00.000Z')
    });
    const inspection = await inspectExecutionJournal(handover.root, writer.kind, { approvalStore });
    expect(inspection).toMatchObject({ status: 'interrupted', schemaVersion: writer.schemaVersion, planFingerprint: handover.fingerprint });
    expect(await readFile(journal)).toEqual(bytes);
    expect(await capturedTree(handover.home)).toEqual(seals);
    await expect(recoverExecutionJournal(handover.root, writer.kind, { approvalStore })).rejects.toThrow(/unowned lock/);
    expect(await readFile(handover.lock)).toEqual(owner);
    await unlink(handover.lock);
    expect(await recoverExecutionJournal(handover.root, writer.kind, { approvalStore })).toMatchObject({ status: 'rolled-back', committed: false, rollbackFailures: [], cleanupFailures: [] });
    expect(await capturedTree(handover.root)).toEqual(handover.before);
    expect(await capturedTree(handover.home)).toEqual([]);
  }, 30_000);

  it('returns the released blocked result for unknown identities without parsing English authority or rewriting bytes', async () => {
    const f = await fixture(), journal = path.join(f.root, ...reviewedRepairTransactionPathParts);
    await mkdir(path.dirname(journal));
    const bytes = canonicalJson({ schemaVersion: 99, unknownIdentity: true });
    await writeFile(journal, bytes, { mode: privateMode });
    expect(await inspectExecutionJournal(f.root, 'repair')).toMatchObject({ status: 'blocked', committed: false });
    expect(await recoverExecutionJournal(f.root, 'repair')).toMatchObject({ status: 'blocked', committed: false });
    expect(await readFile(journal, 'utf8')).toBe(bytes);
    await expect(recoverExecutionJournal(f.root, 'installation' as never)).rejects.toThrow(/Unsupported/);
  });
});

describe('operation facts remain distinct from complete verification', () => {
  it('never permits cleanup or success-shaped results for uncertain settlement', () => {
    const outcome = buildUnifiedOperationOutcome({
      operationId: 'owned-process', command: 'repair', status: 'completed',
      verification: 'not-run', cleanup: 'completed', uncertainSettlement: true
    });
    expect(outcome).toMatchObject({ status: 'failed', verification: 'uncertain', cleanup: 'retained' });
    expect(() => validateUnifiedOperationOutcome({ ...outcome, cleanup: 'completed' })).toThrow(/settlement/);
    expect(() => validateUnifiedOperationOutcome({ ...outcome, remainingWork: [false] })).toThrow(/remaining work/);
    expect(() => validateUnifiedOperationOutcome({ ...outcome, committedEffects: [{}] })).toThrow(/effect/);
    expect(() => validateUnifiedOperationOutcome({ ...outcome, invented: true })).toThrow(/unrecognized/);
  });
});
