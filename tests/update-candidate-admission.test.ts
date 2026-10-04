import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateCandidate,
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts,
  type ReviewedUpdateApprovalStore
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import {
  encodeReviewedJournalHeader, encodeReviewedJournalFrame, measureReviewedJournal
} from '../src/adapters/filesystem/reviewed-update-journal.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import { createUpdatePreviewDescriptor } from '../src/application/update/preview.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { prepareUpdateReview } from '../src/application/update/review-plan.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { issueUpdatePreviewReceipt, loadUpdatePreviewReceipt } from '../src/adapters/filesystem/update-previews.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';
import { parseArgs } from '../src/args.js';
import type { CommandContext } from '../src/application/context.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import {
  createReviewedUpdateFixture, cleanupUpdateTestRoots, fingerprintUpdateTestProject, updateTestPreviewOptions, runLegacyUpdateContract
} from './reviewed-update-helpers.js';
import { historicalV2ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { historicalPhaseIds } from '../src/governance-activation/historical-state.js';
import { validateHistoricalV2ActivationState } from '../src/governance-activation/historical-v2.js';
import type { CommandRunner } from '../src/process-runner.js';

interface IoEvent { operation: 'lstat' | 'open' | 'readdir' | 'realpath'; target: string; bigint?: boolean }
const io = vi.hoisted(() => ({
  calls: [] as IoEvent[],
  before: undefined as ((event: IoEvent) => Promise<void>) | undefined
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const before = async (event: IoEvent) => { io.calls.push(event); await io.before?.(event); };
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await before({ operation: 'lstat', target: String(args[0]), bigint: typeof args[1] === 'object' && args[1]?.bigint === true });
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      await before({ operation: 'open', target: String(args[0]) });
      return actual.open(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await before({ operation: 'readdir', target: String(args[0]) });
      return actual.readdir(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      await before({ operation: 'realpath', target: String(args[0]) });
      return actual.realpath(...args);
    }
  };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const fingerprint = 'a'.repeat(64);

function approvalStore(): ReviewedUpdateApprovalStore & { seals: Set<string> } {
  const seals = new Set<string>();
  return {
    seals,
    write: vi.fn(async (plan, digest) => { seals.add(`${plan}:${digest}`); }),
    verify: vi.fn(async (plan, digest) => seals.has(`${plan}:${digest}`)),
    remove: vi.fn(async (plan, digest) => { seals.delete(`${plan}:${digest}`); })
  };
}

async function bare() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'source'), 'original bytes\r\n', { mode: 0o640 });
  const supplied: ProjectFileSnapshot[] = [{
    pathParts: ['source'], content: await fs.readFile(path.join(root, 'source')),
    mode: (await fs.lstat(path.join(root, 'source'))).mode & 0o7777
  }];
  const mutations: ProjectFileMutation[] = [
    { type: 'write', pathParts: ['source'], content: 'replacement bytes\n' },
    { type: 'write', pathParts: ['new', 'nested', 'file'], content: Buffer.from([0, 255]), mode: 0o640 }
  ];
  return { root, parent, supplied, mutations, store: approvalStore() };
}

async function tree(root: string) {
  const result: Record<string, unknown> = {};
  async function visit(parts: string[]) {
    for (const name of (await fs.readdir(path.join(root, ...parts))).sort()) {
      const next = [...parts, name];
      const absolute = path.join(root, ...next);
      const details = await fs.lstat(absolute);
      result[next.join('/')] = details.isSymbolicLink()
        ? { link: await fs.readlink(absolute) }
        : details.isDirectory() ? { directory: true, mode: details.mode & 0o7777 }
          : { bytes: (await fs.readFile(absolute)).toString('base64'), mode: details.mode & 0o7777 };
      if (details.isDirectory()) await visit(next);
    }
  }
  await visit([]);
  return result;
}

async function ordinary() {
  const root = await createReviewedUpdateFixture({
    projectName: 'Candidate Admission', projectType: 'standard', apiStack: 'go',
    specWorkflow: 'openspec', agents: ['github-copilot'], environments: ['dev'], includeFrontend: false
  });
  const guide = path.join(root, ...governanceArtifactPaths.guide);
  const originalGuide = await fs.readFile(guide);
  await fs.unlink(guide);
  return { root, guide, originalGuide };
}

async function invoke(root: string, args: string[], overrides: Partial<CommandContext> = {}) {
  const stdout = new CaptureStream();
  const stderr = overrides.stderr ?? new CaptureStream();
  const code = await runLegacyUpdateContract(parseArgs(['update', '--json', ...args]), {
    cwd: root, stdout, stderr, updatePreview: updateTestPreviewOptions(root),
    env: { ...process.env, LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    ...overrides
  });
  const report: unknown = JSON.parse(stdout.text());
  if (!isRecord(report) || !Array.isArray(report.plans)) throw new Error(`Invalid update report: ${stdout.text()}`);
  const plans = report.plans.map((plan) => {
    if (!isRecord(plan) || typeof plan.fingerprint !== 'string' || typeof plan.eligible !== 'boolean' ||
      (plan.mode !== 'normal' && plan.mode !== 'force')) throw new Error('Invalid plan summary.');
    return { fingerprint: plan.fingerprint, mode: plan.mode, eligible: plan.eligible, blockers: plan.blockers };
  });
  return { code, report, plans, text: stdout.text() };
}

afterEach(async () => {
  io.before = undefined;
  io.calls.length = 0;
  await cleanupUpdateTestRoots();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('actual read-only candidates and shared locked apply', () => {
  it('captures complete ordinary bytes and ordered missing write/journal parents without writes or authority', async () => {
    const f = await bare();
    const before = await tree(f.parent);
    const candidate = await inspectReviewedUpdateCandidate(f.root, f.mutations, f.supplied);
    expect(await tree(f.parent)).toEqual(before);
    expect(candidate.payload.missingDirectories).toEqual([['new'], ['new', 'nested'], ['.liftoff']]);
    expect(candidate.suppliedPreconditions).toHaveLength(1);
    expect(candidate.size.suppliedPreconditionCount).toBe(1);
    expect(candidate.payload.mutations).toHaveLength(2);
    expect(candidate.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.payload).not.toHaveProperty('planFingerprint');
    expect(candidate.payload).not.toHaveProperty('nonce');
    expect(candidate.payload).not.toHaveProperty('transactionDigest');
    expect(candidate.size).toEqual(measureReviewedJournal(candidate.payload, candidate.suppliedPreconditions, process.platform));
    await expect(fs.lstat(await projectMutationLockPath(f.root))).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await applyReviewedUpdateTransaction(f.root, f.mutations, {
      planFingerprint: fingerprint, preconditions: f.supplied, approvalStore: f.store,
      expectedCandidateBinding: candidate.binding,
      onCheckpoint: async ({ phase }) => {
        if (phase !== 'prepared' && phase !== 'committed') return;
        const actual = await fs.readFile(path.join(f.root, ...reviewedUpdateTransactionPathParts));
        const first = actual.toString('utf8').split('\n')[0];
        const header: unknown = JSON.parse(first);
        if (!isRecord(header) || typeof header.nonce !== 'string') throw new Error('Expected real transaction header.');
        const encoded = encodeReviewedJournalHeader({ ...candidate.payload, planFingerprint: fingerprint, nonce: header.nonce }, process.platform);
        expect(encoded.content.length).toBe(candidate.size.headerBytes);
        const expected = phase === 'prepared' ? encoded.content : Buffer.concat([
          encoded.content,
          ...candidate.payload.mutations.map((_, index) => encodeReviewedJournalFrame({ phase: 'mutation', index })),
          encodeReviewedJournalFrame({ phase: 'committed' })
        ]);
        expect(actual.equals(expected)).toBe(true);
        if (phase === 'committed') expect(actual.length).toBe(candidate.size.completeJournalBytes);
      }
    });
    expect(result).toMatchObject({ committed: true, cleanupFailures: [], rollbackFailures: [] });
    expect(f.store.seals.size).toBe(0);
  });

  it('preserves supplied order/count and rejects duplicates before a merged map can hide them', async () => {
    const f = await bare();
    const extras = Array.from({ length: 4095 }, (_, index) => ({ pathParts: [`absent-${index}`] }));
    const candidate = await inspectReviewedUpdateCandidate(f.root, f.mutations, [...f.supplied, ...extras]);
    expect(candidate.size.suppliedPreconditionCount).toBe(4096);
    expect(candidate.suppliedPreconditions[0].pathParts).toEqual(['source']);
    expect(candidate.suppliedPreconditions.at(-1)?.pathParts).toEqual(['absent-4094']);
    io.calls.length = 0;
    await expect(inspectReviewedUpdateCandidate(f.root, f.mutations, [...f.supplied, ...f.supplied]))
      .rejects.toThrow('duplicate or case-colliding preconditions');
    await expect(inspectReviewedUpdateCandidate(f.root, f.mutations, [...f.supplied, ...extras, { pathParts: ['extra'] }]))
      .rejects.toThrow('too many preconditions');
    expect(io.calls).toEqual([]);
  }, 60_000);

  it('captures caller mutation and supplied data before the first await without invoking Buffer hooks', async () => {
    const f = await bare();
    const original = Buffer.from(f.supplied[0].content!);
    const target = Buffer.from('actual target');
    const hook = vi.fn(() => Buffer.from('not actual bytes'));
    Object.defineProperty(target, 'valueOf', { get: hook });
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['source'], content: target }];
    const capture = inspectReviewedUpdateCandidate(f.root, mutations, f.supplied);
    mutations[0].pathParts[0] = 'wrong';
    mutations.length = 0;
    target.fill(0);
    f.supplied[0].content!.fill(0);
    f.supplied[0].pathParts[0] = 'wrong';
    f.supplied.length = 0;
    const candidate = await capture;
    const mutation = candidate.payload.mutations[0];
    expect(mutation.pathParts).toEqual(['source']);
    if (mutation.original.kind !== 'file' || mutation.target.kind !== 'file') throw new Error('Expected exact file snapshots.');
    expect(Buffer.from(mutation.original.bytes, 'base64').equals(original)).toBe(true);
    expect(Buffer.from(mutation.target.bytes, 'base64').toString()).toBe('actual target');
    expect(candidate.suppliedPreconditions).toHaveLength(1);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(['source', 'target', 'mode', 'new-parent', 'journal-parent', 'parent-mode', 'root-replacement'] as const)(
    'rejects %s changing after review and before the locked candidate capture',
    async (change) => {
      const f = await bare();
      if (change === 'parent-mode') await fs.mkdir(path.join(f.root, 'new'));
      const candidate = await inspectReviewedUpdateCandidate(f.root, f.mutations, []);
      const capturedMutations = f.mutations.map((entry) => ({ ...entry, pathParts: [...entry.pathParts] }));
      if (change === 'target' && capturedMutations[0].type === 'write') capturedMutations[0].content = 'different target';
      const validation = vi.fn(async () => {
        if (change === 'source') await fs.writeFile(path.join(f.root, 'source'), 'later source');
        if (change === 'mode') await fs.chmod(path.join(f.root, 'source'), 0o444);
        if (change === 'new-parent') await fs.mkdir(path.join(f.root, 'new'));
        if (change === 'journal-parent') await fs.mkdir(path.join(f.root, '.liftoff'));
        if (change === 'parent-mode') await fs.chmod(path.join(f.root, 'new'), 0o500);
        if (change === 'root-replacement') {
          await fs.rename(f.root, `${f.root}-previous`);
          await fs.mkdir(f.root);
          await fs.copyFile(path.join(`${f.root}-previous`, 'source'), path.join(f.root, 'source'));
        }
      });
      await expect(applyReviewedUpdateTransaction(f.root, capturedMutations, {
        planFingerprint: fingerprint, approvalStore: f.store,
        expectedCandidateBinding: candidate.binding, validatePlan: validation
      })).rejects.toThrow('candidate changed after review');
      expect(validation).toHaveBeenCalledOnce();
      expect(f.store.write).not.toHaveBeenCalled();
      await expect(fs.lstat(path.join(f.root, ...reviewedUpdateTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(f.root, 'new', 'nested', 'file'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (change === 'parent-mode') await fs.chmod(path.join(f.root, 'new'), 0o700);
    }
  );

  it('detects a parent created during candidate inspection without retrying', async () => {
    const f = await bare();
    let inspections = 0;
    io.before = async (event) => {
      if (event.operation === 'lstat' && event.bigint && event.target === path.join(f.root, 'new') && ++inspections === 2) {
        await fs.mkdir(path.join(f.root, 'new'));
      }
    };
    await expect(inspectReviewedUpdateCandidate(f.root, f.mutations, f.supplied)).rejects.toThrow('parent changed after review');
    expect(inspections).toBe(2);
    expect((await fs.lstat(path.join(f.root, 'new'))).isDirectory()).toBe(true);
    expect(f.store.write).not.toHaveBeenCalled();
  });

  it.each(['original', 'readonly', 'parent', 'journal'] as const)('propagates denied %s reads without an absent fallback', async (position) => {
    const f = await bare();
    const conditions = position === 'readonly' ? f.supplied : [];
    if (position === 'journal') {
      await fs.mkdir(path.join(f.root, '.liftoff'));
      await fs.writeFile(path.join(f.root, ...reviewedUpdateTransactionPathParts), 'not read');
    }
    const denial = Object.assign(new Error('actual denied candidate read'), { code: 'EACCES' });
    io.before = async (event) => {
      if ((position === 'original' || position === 'readonly') && event.operation === 'open' && event.target === path.join(f.root, 'source') ||
        position === 'parent' && event.operation === 'lstat' && event.bigint && event.target === path.join(f.root, 'new') ||
        position === 'journal' && event.operation === 'open' && event.target === path.join(f.root, ...reviewedUpdateTransactionPathParts)) {
        throw denial;
      }
    };
    const before = await tree(f.parent);
    await expect(inspectReviewedUpdateCandidate(f.root, f.mutations, conditions)).rejects.toBe(denial);
    expect(await tree(f.parent)).toEqual(before);
  });

  it.each(['root-link', 'parent-link', 'case-parent', 'unsafe-parts'] as const)('rejects %s instead of following an alternate path', async (problem) => {
    const f = await bare();
    const outside = path.join(f.parent, 'outside');
    await fs.mkdir(outside);
    let root = f.root;
    if (problem === 'root-link') {
      root = path.join(f.parent, 'alias');
      await fs.symlink(f.root, root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (problem === 'parent-link') await fs.symlink(outside, path.join(f.root, 'new'), process.platform === 'win32' ? 'junction' : 'dir');
    if (problem === 'case-parent') await fs.mkdir(path.join(f.root, 'NEW'));
    if (problem === 'unsafe-parts') f.mutations[0].pathParts = ['..', 'outside', 'file'];
    await expect(inspectReviewedUpdateCandidate(root, f.mutations, f.supplied)).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('validates zero-op candidates without creating or sizing a fake journal', async () => {
    const f = await bare();
    const before = await tree(f.parent);
    const candidate = await inspectReviewedUpdateCandidate(f.root, [], f.supplied);
    expect(candidate.size).toMatchObject({ kind: 'no-journal', mutationCount: 0, suppliedPreconditionCount: 1, completeJournalBytes: 0 });
    expect(candidate.payload.missingDirectories).toEqual([]);
    expect(await applyReviewedUpdateTransaction(f.root, [], {
      planFingerprint: fingerprint, approvalStore: f.store, preconditions: f.supplied, expectedCandidateBinding: candidate.binding
    })).toMatchObject({ status: 'absent', committed: false });
    expect(await tree(f.parent)).toEqual(before);
    expect(f.store.write).not.toHaveBeenCalled();
  });
});

describe('fixed preseal consistency passes', () => {
  it('keeps unrelated read-only sentinel reads fixed before the first seal as the mutation count grows', async () => {
    const observations: Array<{ mutations: number; sentinelReads: number }> = [];
    for (const count of [1, 4, 16]) {
      const f = await bare();
      const sentinelPath = path.join(f.root, 'source');
      const before = await tree(f.parent);
      let sentinelReads = 0;
      io.before = async (event) => {
        if (event.operation === 'open' && event.target === sentinelPath) sentinelReads++;
      };
      f.store.write = vi.fn(async () => {
        observations.push({ mutations: count, sentinelReads });
        throw new Error('stop at first seal before persistence');
      });
      await expect(applyReviewedUpdateTransaction(f.root, Array.from({ length: count }, (_, index) => ({
        type: 'write', pathParts: [`target-${index}`], content: `target ${index}`
      })), {
        planFingerprint: fingerprint, approvalStore: f.store, preconditions: f.supplied
      })).rejects.toThrow('stop at first seal before persistence');
      expect(f.store.write).toHaveBeenCalledOnce();
      expect(f.store.seals.size).toBe(0);
      expect(await tree(f.parent)).toEqual(before);
    }
    expect(observations).toEqual([
      { mutations: 1, sentinelReads: 3 },
      { mutations: 4, sentinelReads: 3 },
      { mutations: 16, sentinelReads: 3 }
    ]);
  });

  it.each(['source', 'parent'] as const)('rejects %s changes during the final reserved-temporary inspection before the first seal', async (change) => {
    const f = await bare();
    const count = 8;
    let changed = false;
    io.before = async (event) => {
      if (changed || event.operation !== 'lstat' ||
        !path.basename(event.target).endsWith(`-${count - 1}-original.tmp`)) return;
      changed = true;
      if (change === 'source') await fs.writeFile(path.join(f.root, 'source'), 'concurrent final-inspection edit');
      else await fs.mkdir(path.join(f.root, 'new'));
    };
    await expect(applyReviewedUpdateTransaction(f.root, Array.from({ length: count }, (_, index) => ({
      type: 'write', pathParts: ['new', `target-${index}`], content: `target ${index}`
    })), {
      planFingerprint: fingerprint, approvalStore: f.store, preconditions: f.supplied
    })).rejects.toThrow(change === 'source' ? 'target changed after review: source' : 'transaction parent changed after review: new');
    expect(changed).toBe(true);
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.store.seals.size).toBe(0);
    await expect(fs.lstat(path.join(f.root, ...reviewedUpdateTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    if (change === 'source') expect(await fs.readFile(path.join(f.root, 'source'), 'utf8')).toBe('concurrent final-inspection edit');
    else expect(await fs.readdir(path.join(f.root, 'new'))).toEqual([]);
  });

  it.each(['source', 'parent'] as const)('retains the immediate pre-journal check for %s changes during approval-seal persistence', async (change) => {
    const f = await bare();
    const persist = f.store.write;
    let changed = false;
    f.store.write = vi.fn(async (plan, digest) => {
      await persist(plan, digest);
      if (changed) return;
      changed = true;
      if (change === 'source') await fs.writeFile(path.join(f.root, 'source'), 'concurrent sealed-stage edit');
      else await fs.mkdir(path.join(f.root, 'new'));
    });
    await expect(applyReviewedUpdateTransaction(f.root, [{
      type: 'write', pathParts: ['new', 'target'], content: 'reviewed target'
    }], {
      planFingerprint: fingerprint, approvalStore: f.store, preconditions: f.supplied
    })).rejects.toThrow(change === 'source' ? 'target changed after review: source' : 'transaction parent changed after review: new');
    expect(f.store.write).toHaveBeenCalledTimes(2);
    expect(f.store.seals.size).toBe(0);
    await expect(fs.lstat(path.join(f.root, ...reviewedUpdateTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(f.root, 'new', 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (change === 'source') expect(await fs.readFile(path.join(f.root, 'source'), 'utf8')).toBe('concurrent sealed-stage edit');
    else expect(await fs.readdir(path.join(f.root, 'new'))).toEqual([]);
  });
});

describe('retained schema-3 byte-complete ordinary update admission', { timeout: 120_000 }, () => {
  it('checks and applies actual ordinary render bytes with no activation state or raw receipt content', async () => {
    const f = await ordinary();
    const before = await fingerprintUpdateTestProject(f.root);
    const inspection = await inspectProjectUpdate(f.root);
    const review = await prepareUpdateReview(inspection, false);
    expect(review.candidateAdmission.status).toBe('complete');
    const checked = await invoke(f.root, ['--check']);
    expect(checked.code).toBe(2);
    expect(await fingerprintUpdateTestProject(f.root)).toEqual(before);
    expect(checked.text).not.toContain(f.originalGuide.toString('utf8'));
    const stored = await loadUpdatePreviewReceipt(f.root, updateTestPreviewOptions(f.root));
    expect(JSON.stringify(stored.receipt)).not.toContain('"bytes"');
    const selected = checked.plans.find((plan) => plan.mode === 'normal' && plan.eligible)!;
    const applied = await invoke(f.root, ['--approve-plan', selected.fingerprint]);
    expect(applied.code, applied.text).toBe(0);
    expect(applied.report).toMatchObject({ committed: true, status: 'applied' });
    expect((await fs.readFile(f.guide)).equals(f.originalGuide)).toBe(true);
    await expect(fs.lstat(path.join(f.root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an otherwise matching pre-admission ordinary receipt instead of silently reauthorizing it', async () => {
    const f = await ordinary();
    const inspection = await inspectProjectUpdate(f.root);
    const review = await prepareUpdateReview(inspection, false);
    expect(inspection.historyMigration.status).toBe('not-present');
    expect(inspection.provisioningPlans).toEqual([]);
    expect(review.needsRevalidation).toBe(false);
    const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
    // Reconstruct only the previous ordinary-preview contract; no candidate
    // binding existed in this receipt, and the new apply must not accept it.
    const previous = createUpdatePreviewDescriptor({
      projectRoot: inspection.projectRoot, cliVersion: review.descriptor.cliVersion, mode: 'normal',
      source: {
        repositoryRoot: inspection.repositoryRoot ?? null,
        files: review.preconditions.map((snapshot) => ({
          pathParts: snapshot.pathParts, kind: snapshot.content === undefined ? 'missing' : 'file',
          contentDigest: snapshot.content === undefined ? null : digest(snapshot.content), mode: snapshot.mode ?? null
        })),
        migration: null, revalidationSource: null, retainedSource: null
      },
      target: {
        manifest: JSON.stringify(review.writePlan.nextManifest),
        artifacts: inspection.render.filter((artifact) => artifact.lifecycle === 'managed-core').map((artifact) => ({
          logicalName: artifact.logicalName, pathParts: artifact.pathParts, contentDigest: digest(artifact.content)
        }))
      },
      operations: {
        mutations: review.writePlan.mutations.map((mutation) => ({
          type: mutation.type, pathParts: mutation.pathParts,
          ...(mutation.type === 'write' ? { contentDigest: digest(mutation.content), mode: mutation.mode ?? null } : {})
        })),
        migration: null, revalidation: null, provisioning: []
      }
    });
    expect(previous.fingerprint).not.toBe(review.descriptor.fingerprint);
    await issueUpdatePreviewReceipt(f.root, [previous], updateTestPreviewOptions(f.root));
    const before = await fingerprintUpdateTestProject(f.root);
    const approval = vi.fn(async () => true);
    const result = await invoke(f.root, ['--approve-plan', previous.fingerprint], {
      stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval
    });
    expect(result.code).toBe(1);
    expect(result.report.reasonCode).toBe('preview-mismatch');
    expect(approval).not.toHaveBeenCalled();
    expect(await fingerprintUpdateTestProject(f.root)).toEqual(before);
  });

  it('blocks a real >16 MiB forced variant while preserving a safe normal variant', async () => {
    const f = await ordinary();
    const manifest = await loadManifest(f.root);
    const conflicts = manifest.managedArtifacts.filter((artifact) => artifact.pathParts.join('/') !== governanceArtifactPaths.guide.join('/')).slice(0, 3);
    expect(conflicts).toHaveLength(3);
    for (const artifact of conflicts) await fs.writeFile(path.join(f.root, ...artifact.pathParts), Buffer.alloc(6 * 1024 * 1024, 'x'));
    const before = await fingerprintUpdateTestProject(f.root);
    const checked = await invoke(f.root, ['--check']);
    expect(checked.code, checked.text).toBe(2);
    expect(checked.plans.find((plan) => plan.mode === 'normal')?.eligible).toBe(true);
    const forced = checked.plans.find((plan) => plan.mode === 'force')!;
    expect(forced.eligible).toBe(false);
    expect(forced.blockers).toEqual(expect.arrayContaining([expect.stringContaining('transaction snapshots exceed')]));
    const receipt = await loadUpdatePreviewReceipt(f.root, updateTestPreviewOptions(f.root));
    expect(receipt.receipt.variants.map((variant) => variant.mode)).toEqual(['normal']);
    const approval = vi.fn(async () => true);
    const blocked = await invoke(f.root, ['--force', '--approve-plan', forced.fingerprint], {
      stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval
    });
    expect(blocked.code).toBe(1);
    expect(blocked.report.reasonCode).toBe('incompatible-update');
    expect(approval).not.toHaveBeenCalled();
    expect(await fingerprintUpdateTestProject(f.root)).toEqual(before);
    const selected = checked.plans.find((plan) => plan.mode === 'normal')!;
    const applied = await invoke(f.root, ['--approve-plan', selected.fingerprint]);
    expect(applied.code, applied.text).toBe(0);
    for (const artifact of conflicts) expect((await fs.stat(path.join(f.root, ...artifact.pathParts))).size).toBe(6 * 1024 * 1024);
  });

  it('issues no eligible receipt or approval prompt when all variants have an oversized actual source', async () => {
    const f = await ordinary();
    const manifest = await loadManifest(f.root);
    const source = manifest.managedArtifacts.find((artifact) => artifact.pathParts.join('/') !== governanceArtifactPaths.guide.join('/'))!;
    await fs.writeFile(path.join(f.root, ...source.pathParts), Buffer.alloc(8 * 1024 * 1024 + 1, 'x'));
    const before = await fingerprintUpdateTestProject(f.root);
    const checked = await invoke(f.root, ['--check']);
    expect(checked.code).toBe(1);
    await expect(loadUpdatePreviewReceipt(f.root, updateTestPreviewOptions(f.root))).rejects.toMatchObject({ code: 'preview-missing' });
    const approval = vi.fn(async () => true);
    const applied = await invoke(f.root, [], { stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval });
    expect(applied.code).toBe(1);
    expect(approval).not.toHaveBeenCalled();
    expect(await fingerprintUpdateTestProject(f.root)).toEqual(before);
  });

  it.each(['source', 'mode', 'new-parent'] as const)('rejects %s changes after a public check without a prompt or writes', async (change) => {
    const f = await ordinary();
    const checked = await invoke(f.root, ['--check']);
    const selected = checked.plans.find((plan) => plan.mode === 'normal')!;
    if (change === 'source') await fs.appendFile(path.join(f.root, 'liftoff.config.json'), '\n');
    if (change === 'mode') await fs.chmod(path.join(f.root, 'liftoff.config.json'), 0o444);
    if (change === 'new-parent') {
      // A missing selected-agent repair integration supplies a real create-only
      // core destination whose empty parent is part of the reviewed header.
      const inspection = await inspectProjectUpdate(f.root);
      const artifact = inspection.render.find((entry) => entry.lifecycle === 'managed-core' &&
        entry.pathParts.length > 2 && entry.pathParts[0] === '.github')!;
      const parent = path.join(f.root, ...artifact.pathParts.slice(0, -1));
      await fs.rename(parent, `${parent}-saved`);
      const refreshed = await invoke(f.root, ['--check']);
      selected.fingerprint = refreshed.plans.find((plan) => plan.mode === 'normal')!.fingerprint;
      await fs.mkdir(parent);
    }
    const afterEdit = await fingerprintUpdateTestProject(f.root);
    const approval = vi.fn(async () => true);
    const result = await invoke(f.root, ['--approve-plan', selected.fingerprint], {
      stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval
    });
    expect(result.code, result.text).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(approval).not.toHaveBeenCalled();
    expect(await fingerprintUpdateTestProject(f.root)).toEqual(afterEdit);
  });

  it('keeps default-No decline and cancellation free of project mutations', async () => {
    for (const cancelled of [false, true]) {
      const f = await ordinary();
      await invoke(f.root, ['--check']);
      const before = await fingerprintUpdateTestProject(f.root);
      const approval = vi.fn(async (config: { default: false }) => {
        expect(config.default).toBe(false);
        if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
        return false;
      });
      const result = await invoke(f.root, [], { stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval });
      expect(result.code).toBe(1);
      expect(approval).toHaveBeenCalledOnce();
      expect(result.report).toMatchObject({ committed: false, approval: { status: 'declined' } });
      expect(await fingerprintUpdateTestProject(f.root)).toEqual(before);
    }
  });

  it('rejects changes made during approval in the existing locked full-review callback', async () => {
    const f = await ordinary();
    await invoke(f.root, ['--check']);
    const approval = vi.fn(async () => {
      await fs.appendFile(path.join(f.root, 'liftoff.config.json'), '\n');
      return true;
    });
    const result = await invoke(f.root, [], { stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(), approveUpdatePlan: approval });
    expect(result.code).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(approval).toHaveBeenCalledOnce();
    await expect(fs.lstat(f.guide)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(f.root, ...reviewedUpdateTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a current zero-op project current without a new preview receipt', async () => {
    const f = await ordinary();
    await fs.writeFile(f.guide, f.originalGuide);
    const result = await invoke(f.root, ['--check']);
    expect(result.code, result.text).toBe(0);
    expect(result.report).toMatchObject({ status: 'current', committed: false, receipt: { status: 'not-required' } });
    await expect(loadUpdatePreviewReceipt(f.root, updateTestPreviewOptions(f.root))).rejects.toMatchObject({ code: 'preview-missing' });
  });

  it('does not mark a real historical successor plan as fully materialized ordinary work', async () => {
    const f = await bare();
    const originalManifest = readFileSync(new URL('./fixtures/contract-baseline-0.12.3/manifests/0.11.3-standard-go.json', import.meta.url));
    await fs.writeFile(path.join(f.root, 'liftoff.manifest.json'), originalManifest);
    await fs.writeFile(path.join(f.root, 'liftoff.config.json'), JSON.stringify({
      projectName: 'Contract Baseline', projectType: 'standard', apiStack: 'go', cloud: 'azure',
      region: 'eastus', specWorkflow: 'openspec', agents: ['github-copilot'], environments: ['dev'], includeFrontend: false
    }));
    const createdAt = '2026-09-01T08:00:00.000Z';
    const historicalState = validateHistoricalV2ActivationState({
      schemaVersion: 2, identity: historicalV2ActivationIdentity,
      repository: { id: 'local:00000000-0000-4000-8000-000000000002', name: 'Contract Baseline', defaultBranch: 'develop' },
      activeChange: null, applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
      phases: Object.fromEntries(historicalPhaseIds.map((id) => [id, {
        state: 'pending', updatedAt: createdAt, evidence: [], approvals: [], blockers: []
      }])), createdAt, updatedAt: createdAt
    });
    await fs.mkdir(path.join(f.root, 'governance'));
    await fs.writeFile(path.join(f.root, 'governance', 'activation-state.json'), JSON.stringify(historicalState));
    const runner: CommandRunner = {
      async run(command) {
        if (command.executable !== 'git') throw new Error('Only read-only Git inspection permitted.');
        return { command, displayCommand: command.args.join(' '), status: 0, stdout: '', stderr: '', signal: null, timedOut: false };
      }
    };
    const inspection = await inspectProjectUpdate(f.root, { runner });
    expect(inspection.historyMigration.status).toBe('eligible');
    const review = await prepareUpdateReview(inspection, false, { runner });
    expect(review.candidateAdmission).toEqual({ status: 'not-materialized' });
    expect(review.requiresApproval).toBe(true);
    expect(review.summary.eligible).toBe(true);
    expect((await fs.readFile(path.join(f.root, 'liftoff.manifest.json'))).equals(originalManifest)).toBe(true);
  });
});
import { createHash } from 'node:crypto';
