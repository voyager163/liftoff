import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPreparedUpdatePreviewReceipt, createUpdatePreviewDescriptor, createUpdatePreviewReceipt,
  matchPreparedUpdatePreviewReceipt, validatePreparedUpdatePreviewReceipt, validateUpdatePreviewReceipt,
  type PreparedUpdatePublication, type UpdatePreviewDescriptor
} from '../src/application/update/preview.js';
import {
  consumePreparedUpdatePreviewReceipt, issuePreparedUpdatePreviewReceipt, issueUpdatePreviewReceipt,
  loadPreparedUpdatePreviewReceipt, loadUpdatePreviewReceipt, resolveUpdatePreviewLocation,
  readUpdateSuccessorApprovalAudit, retainUpdateSuccessorApprovalAudit, createUpdateTransactionApprovalStore,
  type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import {
  createUpdateSuccessorApprovalAudit, updateSuccessorApprovalAuditKey, validateUpdateSuccessorApprovalAudit
} from '../src/application/update/transaction-approval.js';
import { previewModernSuccessorUpdate, applyModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { prepareModernSuccessorReview } from '../src/application/update/review-plan.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { ModernManagedCoreInput } from '../src/application/project/modern-managed-core.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { historyRecord, historyPathParts, parseHistoryJson, rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import { capturedV3Records, capturedV3Successor, writeCapturedV3Successor, writeFixtureBytes } from './fixtures/activation-v3/fixture.js';
import {
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import * as reviewedTransactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { reviewedJournalLimits } from '../src/adapters/filesystem/reviewed-update-journal.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { retiredManagedCoreIdentities } from '../src/artifact-lifecycle.js';

const preparedAt = '2026-09-01T12:00:00.000Z';
const preparationId = '11111111-1111-4111-8111-111111111111';
const localRepositoryId = 'local:22222222-2222-4222-8222-222222222222';
const projectRoot = path.resolve('prepared-preview-project');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); });

function publication(): PreparedUpdatePublication {
  return {
    semanticTransitionDigest: 'a'.repeat(64), sourceBinding: 'b'.repeat(64),
    preparation: { schemaVersion: 1, preparationId, preparedAt, localRepositoryId }
  };
}
function descriptor(root = projectRoot, mode: 'normal' | 'force' = 'normal', value = publication()): UpdatePreviewDescriptor {
  return createUpdatePreviewDescriptor({
    projectRoot: root, cliVersion: '0.12.3', mode,
    source: { binding: value.sourceBinding },
    target: { semanticTransitionDigest: value.semanticTransitionDigest, preparation: value.preparation },
    operations: { candidateBinding: 'c'.repeat(64), mode }
  });
}
function receipt() {
  return createPreparedUpdatePreviewReceipt([descriptor(), descriptor(projectRoot, 'force')], publication(), {
    receiptId: preparationId, issuedAt: preparedAt
  });
}
async function storage() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'liftoff-prepared-preview-')); roots.push(parent);
  const root = path.join(parent, 'project'), home = path.join(parent, 'home');
  await fs.mkdir(root); await fs.mkdir(home);
  const options: UpdatePreviewOptions = { homedir: home, env: {}, clock: () => new Date(preparedAt) };
  return { root: await fs.realpath(root), options };
}
async function issue(root: string, options: UpdatePreviewOptions, anchor = localRepositoryId) {
  return issuePreparedUpdatePreviewReceipt(root, anchor, async preparation => {
    const current = { ...publication(), preparation };
    return { ...current, descriptors: [descriptor(root, 'normal', current), descriptor(root, 'force', current)] };
  }, options);
}

describe('versioned prepared successor preview values', () => {
  it('retains the same concrete preparation in distinct normal and force descriptors', () => {
    const saved = receipt();
    expect(saved.schemaVersion).toBe(2);
    expect(saved.receiptId).toBe(saved.publication.preparation.preparationId);
    expect(saved.issuedAt).toBe(saved.publication.preparation.preparedAt);
    expect(saved.variants[0].fingerprint).not.toBe(saved.variants[1].fingerprint);
    expect(validatePreparedUpdatePreviewReceipt(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(matchPreparedUpdatePreviewReceipt(saved, descriptor(), publication())).toEqual(descriptor());
    expect(Object.isFrozen(saved.publication.preparation)).toBe(true);
    expect(Object.isFrozen(saved.variants[0])).toBe(true);
    expect(saved).not.toHaveProperty('committedAt');
    expect(saved).not.toHaveProperty('approvedPlanFingerprint');
  });

  it('keeps schema-one receipts separate rather than manufacturing a preparation', () => {
    const legacy = createUpdatePreviewReceipt([descriptor()], { receiptId: preparationId, issuedAt: preparedAt });
    expect(validateUpdatePreviewReceipt(legacy)).toEqual(legacy);
    expect(() => validatePreparedUpdatePreviewReceipt(legacy)).toThrow(/schema 2/u);
    expect(() => validateUpdatePreviewReceipt(receipt())).toThrow(/schema 1/u);
  });

  it.each(['receiptId', 'issuedAt'] as const)('refuses a substituted %s', field => {
    const changed = { ...receipt(), [field]: field === 'receiptId'
      ? '33333333-3333-4333-8333-333333333333' : '2026-09-02T12:00:00.000Z' };
    expect(() => validatePreparedUpdatePreviewReceipt(changed)).toThrow(/once-issued/u);
  });

  it.each(['semanticTransitionDigest', 'sourceBinding', 'preparation'] as const)(
    'requires fresh review when current %s differs', field => {
      const current = structuredClone(publication());
      if (field === 'preparation') Object.assign(current.preparation, { localRepositoryId: `local:${preparationId}` });
      else Object.assign(current, { [field]: 'd'.repeat(64) });
      expect(() => matchPreparedUpdatePreviewReceipt(receipt(), descriptor(), current)).toThrow(/differs/u);
    }
  );

  it('rejects future or invalid clocks without inventing a preparation expiry', () => {
    const saved = receipt();
    expect(() => validatePreparedUpdatePreviewReceipt(saved, { now: new Date('2026-09-01T11:59:59.999Z') })).toThrow(/future/u);
    expect(() => validatePreparedUpdatePreviewReceipt(saved, { now: new Date(NaN) })).toThrow(/invalid/u);
    expect(validatePreparedUpdatePreviewReceipt(saved, { now: new Date('2036-09-01T12:00:00.000Z') })).toEqual(saved);
  });

  it.each(['receipt', 'publication', 'preparation', 'descriptor', 'array'] as const)(
    'rejects %s accessors without invoking them', field => {
      const saved = structuredClone(receipt());
      let invoked = 0;
      const [target, key] = field === 'receipt' ? [saved, 'receiptId'] :
        field === 'publication' ? [saved.publication, 'sourceBinding'] :
        field === 'preparation' ? [saved.publication.preparation, 'preparedAt'] :
        field === 'descriptor' ? [saved.variants[0], 'sourceDigest'] : [saved.variants, '0'];
      Object.defineProperty(target, key, { enumerable: true, get() { invoked++; throw new Error('Accessor ran.'); } });
      expect(() => validatePreparedUpdatePreviewReceipt(saved)).toThrow();
      expect(invoked).toBe(0);
    }
  );

  it.each(['expiresAt', 'committedAt', 'approvedPlanFingerprint'] as const)('rejects unallocated %s metadata', field => {
    expect(() => validatePreparedUpdatePreviewReceipt({ ...receipt(), [field]: preparedAt })).toThrow(/exactly/u);
  });

  it('refuses sparse, excessive, extra-key and aliased project variants', () => {
    const saved = receipt();
    const sparse: UpdatePreviewDescriptor[] = []; sparse.length = 1;
    for (const variants of [sparse, [...saved.variants, descriptor()], [{ ...descriptor(), extra: true }]]) {
      expect(() => validatePreparedUpdatePreviewReceipt({ ...saved, variants })).toThrow();
    }
    expect(() => validatePreparedUpdatePreviewReceipt(saved, { projectRoot: path.resolve('different-project') })).toThrow(/different project/u);
    expect(() => matchPreparedUpdatePreviewReceipt(
      createPreparedUpdatePreviewReceipt([descriptor()], publication(), { receiptId: preparationId, issuedAt: preparedAt }),
      descriptor(projectRoot, 'force'), publication()
    )).toThrow(/differs/u);
  });
});

function modernSelection(value: unknown): ModernManagedCoreInput {
  const manifest = parseManifest(value);
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: manifest.project, framework: manifest.framework
  });
  const workload = leaf.project.workload, profile = 'single-maintainer-gitflow';
  const resolution = composeModernManifestPlugins({
    workload: workload.kind, stack: workload.apiStack, cloud: workload.cloud,
    ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    workflow: leaf.project.specWorkflow, agents: leaf.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) }).resolution;
  return {
    selection: { ...leaf, profile },
    plugins: readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: resolution.digest, selections: resolution.plugins }, {
      stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents
    }),
    activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
  };
}
async function historicalProject(version: 1 | 2 | 3, ancestry = false) {
  const stored = await storage(), sample = capturedV3Successor(version === 1 ? 1 : 2);
  const manifest = version === 3 ? capturedV3Records().manifest : parseHistoryJson(sample.files.get('liftoff.manifest.json')!, 'manifest');
  if (ancestry) await writeCapturedV3Successor(stored.root, 2);
  else {
    const state = version === 3 ? historyRecord(sample.state, 'state') :
      historyRecord(parseHistoryJson(sample.files.get('governance/activation-state.json')!, 'state'), 'state');
    for (const key of ['bootstrapState', 'successorHistory', 'phaseOutputs', 'taskProjection', 'activationInputs']) delete state[key];
    state.activeChange = null;
    for (const value of Object.values(historyRecord(state.phases, 'phases'))) {
      const phase = historyRecord(value, 'phase');
      Object.assign(phase, { state: 'pending', evidence: [], approvals: [], blockers: [] });
      delete phase.operation; delete phase.executionPlanDigest;
    }
    await writeFixtureBytes(stored.root, ['liftoff.manifest.json'], JSON.stringify(manifest, null, '\t') + '\r\n', 0o640);
    await writeFixtureBytes(stored.root, ['governance', 'activation-state.json'], JSON.stringify(state, null, '\t') + '\r\n', 0o644);
  }
  await writeFixtureBytes(stored.root, ['package.json'], '{"scripts":{"test":"node SHOULD-NOT-RUN.js"}}\n');
  return { ...stored, selection: modernSelection(manifest) };
}
async function projectBytes(root: string) {
  const result: Record<string, { digest: string; mode: number }> = {};
  async function walk(parts: string[]) {
    for (const entry of await fs.readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name];
      if (entry.isDirectory()) await walk(next);
      else result[next.join('/')] = {
        digest: rawHistoryDigest(await fs.readFile(path.join(root, ...next))),
        mode: (await fs.lstat(path.join(root, ...next))).mode & 0o7777
      };
    }
  }
  await walk([]); return result;
}
const approvalStreams: PassThrough[] = [];
afterEach(() => { for (const stream of approvalStreams.splice(0)) stream.destroy(); });
function approvalContext(confirm?: () => Promise<boolean>) {
  const stdin = Object.assign(new PassThrough(), { isTTY: confirm !== undefined });
  const stderr = Object.assign(new PassThrough(), { isTTY: confirm !== undefined });
  approvalStreams.push(stdin, stderr);
  return { stdin, stderr, ...(confirm ? { approveUpdatePlan: confirm } : {}) };
}
async function interruptPublication(fixture: Awaited<ReturnType<typeof historicalProject>>, phase: 'prepared' | 'after-mutation' | 'committed') {
  const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
  const request = {
    projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
  };
  const child = spawnSync(process.execPath, [
    '--import', new URL('./fixtures/source-typescript-loader.mjs', import.meta.url).href,
    '--input-type=module', '-e', `
      const { applyModernSuccessorUpdate } = await import(${JSON.stringify(new URL('../src/application/update/use-case.ts', import.meta.url).href)});
      await applyModernSuccessorUpdate(${JSON.stringify(request)}, { stderr: process.stderr }, {
        env: {}, homedir: ${JSON.stringify(fixture.options.homedir)}, clock: () => new Date(${JSON.stringify(preparedAt)}),
        onCheckpoint: async checkpoint => {
          if (checkpoint.phase === ${JSON.stringify(phase)} &&
            (${JSON.stringify(phase)} !== 'after-mutation' || checkpoint.index === 0)) process.exit(73);
        }
      });
      process.exitCode = 9;
    `
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  const lock = await projectMutationLockPath(fixture.root);
  const lockBytes = await fs.readFile(lock);
  expect(JSON.parse(lockBytes.toString('utf8')).pid).toBe(child.pid);
  return {
    preview, request,
    async releaseStoppedChildLock() {
      // spawnSync reaped this exact child; production never removes a stale lock.
      expect(await fs.readFile(lock)).toEqual(lockBytes);
      await fs.unlink(lock);
    }
  };
}

describe('actual guarded prepared successor publication', () => {
  it.each([1, 2, 3] as const)('publishes the exact reviewed v%s successor while preserving original bytes and pending progress', async version => {
    const fixture = await historicalProject(version), before = await projectBytes(fixture.root);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const inspection = await inspectModernSuccessorUpdate(fixture.root, fixture.selection);
    const reconstructed = await prepareModernSuccessorReview(
      inspection, false, preview.receipt.publication.preparation, '2036-09-01T12:00:00.000Z'
    );
    expect(reconstructed.descriptor).toEqual(preview.receipt.variants[0]);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), { ...fixture.options, clock: () => new Date('2026-09-02T12:00:00.000Z') });
    expect(outcome.status).toBe('committed-incomplete');
    if (outcome.status !== 'committed-incomplete') throw new Error('Expected actual committed publication.');
    expect(outcome.cleanupFailures).toEqual([]);
    expect(outcome.audit.audit.publication.preparation).toEqual(preview.receipt.publication.preparation);
    for (const mutation of reconstructed.mutations) {
      const file = path.join(fixture.root, ...mutation.pathParts);
      if (mutation.type === 'write') expect(await fs.readFile(file)).toEqual(Buffer.from(mutation.content));
      else await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const manifest = historyRecord(JSON.parse(await fs.readFile(path.join(fixture.root, 'liftoff.manifest.json'), 'utf8')), 'manifest');
    const state = historyRecord(JSON.parse(await fs.readFile(path.join(fixture.root, 'governance', 'activation-state.json'), 'utf8')), 'state');
    const journal = historyRecord(JSON.parse(await fs.readFile(path.join(fixture.root, 'governance', 'migration-state.json'), 'utf8')), 'journal');
    expect(manifest.artifactVersion).toBe(8);
    expect(state.schemaVersion).toBe(4);
    expect(state.createdAt).toBe(preview.receipt.issuedAt);
    expect(journal.schemaVersion).toBe(2);
    expect(journal.preparation).toEqual(preview.receipt.publication.preparation);
    expect(journal.revalidation).toMatchObject({ status: 'pending' });
    expect(journal).not.toHaveProperty('approvedPlanFingerprint');
    expect(journal).not.toHaveProperty('transaction');
    const link = historyRecord(state.successorHistory, 'history link');
    const index = historyRecord(JSON.parse(await fs.readFile(path.join(fixture.root,
      ...historyPathParts(link.historyIndexPathParts, 'history path')), 'utf8')), 'history index');
    if (!Array.isArray(index.files)) throw new Error('Expected exact history files.');
    for (const item of index.files) {
      const entry = historyRecord(item, 'history file');
      const original = historyPathParts(entry.originalPathParts, 'original path').join('/');
      expect(entry.mode).toBe(before[original].mode);
      expect(rawHistoryDigest(await fs.readFile(path.join(fixture.root, ...historyPathParts(entry.copyPathParts, 'copy path')))))
        .toBe(before[original].digest);
    }
    const after = await projectBytes(fixture.root);
    expect(after['package.json']).toEqual(before['package.json']);
    await expect(previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options)).rejects.toThrow();
    expect(await projectBytes(fixture.root)).toEqual(after);
  });

  it('retains an existing source ancestry without rewriting or duplicating its original snapshot', async () => {
    const fixture = await historicalProject(3, true), before = await projectBytes(fixture.root);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), fixture.options);
    expect(outcome.status).toBe('committed-incomplete');
    const after = await projectBytes(fixture.root);
    for (const [name, bytes] of Object.entries(before).filter(([name]) => name.startsWith('governance/history/'))) {
      expect(after[name], name).toEqual(bytes);
    }
  });

  it.each(['required', 'declined', 'mismatch'] as const)('performs no project or audit writes when approval is %s', async kind => {
    const fixture = await historicalProject(3);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    const before = await projectBytes(fixture.root);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false,
      ...(kind === 'mismatch' ? { approvePlan: 'f'.repeat(64) } : {})
    }, approvalContext(kind === 'declined' ? async () => false : undefined), fixture.options);
    expect(outcome.status).toBe('approval-blocked');
    if (outcome.status !== 'approval-blocked') throw new Error('Expected blocked approval.');
    expect(outcome.approval.status).toBe(kind);
    expect(await projectBytes(fixture.root)).toEqual(before);
    expect(await readUpdateSuccessorApprovalAudit({
      projectRoot: fixture.root, semanticTransitionDigest: preview.receipt.publication.semanticTransitionDigest,
      preparationId: preview.receipt.receiptId
    }, fixture.options)).toBeNull();
  });

  it.each(['before-approval', 'after-approval'] as const)('preserves a source edit made %s and never substitutes a new candidate', async timing => {
    const fixture = await historicalProject(3);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    const file = path.join(fixture.root, 'liftoff.manifest.json');
    let expected = await projectBytes(fixture.root), prompts = 0;
    if (timing === 'before-approval') {
      await fs.appendFile(file, '\n'); expected = await projectBytes(fixture.root);
    }
    await expect(applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false
    }, approvalContext(async () => {
      prompts++;
      await fs.appendFile(file, '\n'); expected = await projectBytes(fixture.root);
      return true;
    }), fixture.options)).rejects.toThrow(/differs|changed/u);
    expect(prompts).toBe(timing === 'before-approval' ? 0 : 1);
    expect(await projectBytes(fixture.root)).toEqual(expected);
    const audit = await readUpdateSuccessorApprovalAudit({
      projectRoot: fixture.root, semanticTransitionDigest: preview.receipt.publication.semanticTransitionDigest,
      preparationId: preview.receipt.receiptId
    }, fixture.options);
    if (timing === 'before-approval') expect(audit).toBeNull();
    else expect(audit?.audit.planFingerprint).toBe(preview.receipt.variants[0].fingerprint);
  });

  it.each([
    { kind: 'update', parts: reviewedUpdateTransactionPathParts },
    { kind: 'repair', parts: reviewedRepairTransactionPathParts },
    { kind: 'local-verification', parts: localVerificationTransactionPathParts }
  ])('refuses a pending $kind journal before interpreting partial control records', async ({ parts }) => {
    const fixture = await historicalProject(3);
    await writeFixtureBytes(fixture.root, parts, 'Interrupted journal data.\n');
    await fs.writeFile(path.join(fixture.root, 'governance', 'activation-state.json'), '{partial');
    const before = await projectBytes(fixture.root);
    await expect(previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options)).rejects.toThrow(/recovery journal blocks/u);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const location = await resolveUpdatePreviewLocation(fixture.root, fixture.options);
    await expect(fs.lstat(location.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps owned force review separate from normal mode and rejects unowned destinations even with force', async () => {
    const fixture = await historicalProject(3);
    const guide = buildModernManagedCore(fixture.selection).find(file => file.logicalName === 'repository-governance-guide')!;
    await writeFixtureBytes(fixture.root, guide.pathParts, 'Locally edited owned guide.\n');
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    expect(preview.receipt.variants.map(variant => variant.mode)).toEqual(['force']);
    const before = await projectBytes(fixture.root);
    await expect(applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), fixture.options)).rejects.toThrow(/conflicts remain/u);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const source = parseManifest(JSON.parse(await fs.readFile(path.join(fixture.root, 'liftoff.manifest.json'), 'utf8')));
    await fs.writeFile(path.join(fixture.root, 'liftoff.manifest.json'), JSON.stringify({
      ...source, governance: { ...source.governance, state: 'handoff-partial' },
      managedArtifacts: source.managedArtifacts.filter(file => file.logicalName !== guide.logicalName)
    }));
    const unowned = await projectBytes(fixture.root);
    await expect(previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options)).rejects.toThrow(/unowned/u);
    await expect(applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: true, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), fixture.options)).rejects.toThrow(/conflicts remain/u);
    expect(await projectBytes(fixture.root)).toEqual(unowned);
  });

  it('publishes an owned conflict only with the separately approved force fingerprint', async () => {
    const fixture = await historicalProject(3);
    const guide = buildModernManagedCore(fixture.selection).find(file => file.logicalName === 'repository-governance-guide')!;
    await writeFixtureBytes(fixture.root, guide.pathParts, 'Explicitly reviewed owned override.\n');
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    expect(preview.receipt.variants.map(variant => variant.mode)).toEqual(['force']);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: true, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), fixture.options);
    expect(outcome.status).toBe('committed-incomplete');
    expect(await fs.readFile(path.join(fixture.root, ...guide.pathParts), 'utf8')).toBe(guide.content);
  });

  it.each(['clean', 'modified', 'absent'] as const)('captures and retires an exactly owned %s legacy alias', async state => {
    const fixture = await historicalProject(3), identity = retiredManagedCoreIdentities[0];
    const original = 'Owned historical launcher.\n', file = path.join(fixture.root, ...identity.pathParts);
    const manifestPath = path.join(fixture.root, 'liftoff.manifest.json');
    const manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
    await fs.writeFile(manifestPath, JSON.stringify({
      ...manifest, managedArtifacts: [...manifest.managedArtifacts, {
        logicalName: identity.logicalName, category: identity.category, pathParts: identity.pathParts,
        contentHash: `sha256:${rawHistoryDigest(Buffer.from(original))}`
      }]
    }));
    if (state !== 'absent') await writeFixtureBytes(fixture.root, identity.pathParts,
      state === 'modified' ? `${original}Reviewed developer edit.\n` : original);
    const before = await projectBytes(fixture.root);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const variant = preview.receipt.variants.find(entry => entry.mode === (state === 'modified' ? 'force' : 'normal'));
    expect(variant).toBeDefined();
    if (state === 'modified') expect(preview.receipt.variants.map(entry => entry.mode)).toEqual(['force']);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: state === 'modified', approvePlan: variant!.fingerprint
    }, approvalContext(), fixture.options);
    expect(outcome.status).toBe('committed-incomplete');
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).managedArtifacts)
      .not.toContainEqual(expect.objectContaining({ logicalName: identity.logicalName }));
  });

  it('rolls back attributable precommit effects while retaining only truthful approval audit', async () => {
    const fixture = await historicalProject(3), before = await projectBytes(fixture.root);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    await expect(applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), {
      ...fixture.options, onCheckpoint: async checkpoint => {
        if (checkpoint.phase === 'before-commit') throw new Error('Injected precommit publication failure.');
      }
    })).rejects.toThrow(/precommit publication failure/u);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const audit = await readUpdateSuccessorApprovalAudit({
      projectRoot: fixture.root, semanticTransitionDigest: preview.receipt.publication.semanticTransitionDigest,
      preparationId: preview.receipt.receiptId
    }, fixture.options);
    expect(audit?.audit.planFingerprint).toBe(preview.receipt.variants[0].fingerprint);
    expect(audit?.audit).not.toHaveProperty('committedAt');
    expect((await loadPreparedUpdatePreviewReceipt(fixture.root, fixture.options)).receipt).toEqual(preview.receipt);
  });

  it('preserves the committed successor when a replaced preview prevents postcommit cleanup', async () => {
    const fixture = await historicalProject(3);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    const outcome = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approvalContext(), {
      ...fixture.options, onCheckpoint: async checkpoint => {
        if (checkpoint.phase === 'committed') await fs.writeFile(preview.location.receiptPath,
          JSON.stringify({ ...preview.receipt, unrelated: 'concurrent replacement' }));
      }
    });
    expect(outcome.status).toBe('committed-cleanup-pending');
    if (outcome.status !== 'committed-cleanup-pending') throw new Error('Expected explicit committed cleanup failure.');
    expect(outcome.committed).toBe(true);
    expect(outcome.cleanupFailures.join(' ')).toMatch(/exactly/u);
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
    expect(JSON.parse(await fs.readFile(preview.location.receiptPath, 'utf8')).unrelated).toBe('concurrent replacement');
  });

  it.each(['after-mutation', 'committed'] as const)('recovers a real process interruption at %s without minting a new successor', async phase => {
    const fixture = await historicalProject(3), before = await projectBytes(fixture.root);
    const { preview, request, releaseStoppedChildLock } = await interruptPublication(fixture, phase);
    await expect(previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options)).rejects.toThrow(/recovery journal blocks/u);
    const pending = await projectBytes(fixture.root);
    await expect(applyModernSuccessorUpdate(request, approvalContext(), fixture.options))
      .rejects.toThrow(/Another cooperating Liftoff mutation/u);
    expect(await projectBytes(fixture.root)).toEqual(pending);
    await releaseStoppedChildLock();
    const recovered = await applyModernSuccessorUpdate({
      projectRoot: fixture.root, selection: fixture.selection, force: false
    }, approvalContext(), fixture.options);
    expect(recovered.status).toBe('recovered');
    if (recovered.status !== 'recovered') throw new Error('Expected attributable recovery.');
    expect(recovered.outcome.committed).toBe(phase === 'committed');
    const after = await projectBytes(fixture.root);
    if (phase === 'after-mutation') expect(after).toEqual(before);
    else {
      for (const [name, bytes] of Object.entries(after)) expect(bytes, name).toEqual(pending[name]);
      expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'governance', 'migration-state.json'), 'utf8')).preparation)
        .toEqual(preview.receipt.publication.preparation);
    }
    expect((await loadPreparedUpdatePreviewReceipt(fixture.root, fixture.options)).receipt).toEqual(preview.receipt);
    expect((await readUpdateSuccessorApprovalAudit({
      projectRoot: fixture.root, semanticTransitionDigest: preview.receipt.publication.semanticTransitionDigest,
      preparationId: preview.receipt.receiptId
    }, fixture.options))?.audit.planFingerprint).toBe(request.approvePlan);
  });

  it.each(['disappeared', 'replaced'] as const)('preserves the current journal when the inspected transaction is %s', async change => {
    const fixture = await historicalProject(3);
    const first = await interruptPublication(fixture, 'prepared');
    await first.releaseStoppedChildLock();
    const inspect = reviewedTransactions.inspectReviewedUpdateTransaction;
    let expected: Awaited<ReturnType<typeof projectBytes>> | undefined;
    vi.spyOn(reviewedTransactions, 'inspectReviewedUpdateTransaction').mockImplementationOnce(async (...args) => {
      const observed = await inspect(...args);
      expect(observed.status).toBe('interrupted');
      await fs.rename(path.join(fixture.root, ...reviewedUpdateTransactionPathParts),
        path.join(path.dirname(fixture.root), 'retained-first-journal.jsonl'));
      if (change === 'replaced') {
        const second = await interruptPublication(fixture, 'prepared');
        await second.releaseStoppedChildLock();
        expect(second.request.approvePlan).not.toBe(first.request.approvePlan);
        expect((await inspect(...args)).status).toBe('interrupted');
      }
      expected = await projectBytes(fixture.root);
      return observed;
    });
    const outcome = await applyModernSuccessorUpdate(first.request, approvalContext(), fixture.options);
    expect(outcome).toMatchObject({ status: 'recovery-incomplete', outcome: { status: 'blocked' } });
    expect(await projectBytes(fixture.root)).toEqual(expected);
  });

  it('refuses incomplete observed recovery identity without touching the journal', async () => {
    const fixture = await historicalProject(3), interrupted = await interruptPublication(fixture, 'prepared');
    await interrupted.releaseStoppedChildLock();
    const inspect = reviewedTransactions.inspectReviewedUpdateTransaction, before = await projectBytes(fixture.root);
    vi.spyOn(reviewedTransactions, 'inspectReviewedUpdateTransaction').mockImplementationOnce(async (...args) =>
      ({ ...await inspect(...args), transactionDigest: undefined }));
    await expect(applyModernSuccessorUpdate(interrupted.request, approvalContext(), fixture.options))
      .rejects.toThrow(/lacks an exact recovery identity/u);
    expect(await projectBytes(fixture.root)).toEqual(before);
  });

  it('cannot recover from a retained approval audit when the transaction seals are missing', async () => {
    const fixture = await historicalProject(3), interrupted = await interruptPublication(fixture, 'prepared');
    await interrupted.releaseStoppedChildLock();
    const store = createUpdateTransactionApprovalStore(fixture.root, fixture.options);
    const observed = await reviewedTransactions.inspectReviewedUpdateTransaction(fixture.root, { approvalStore: store });
    if (!observed.planFingerprint || !observed.transactionDigest) throw new Error('Expected sealed transaction identity.');
    await store.remove(observed.planFingerprint, observed.transactionDigest);
    const cleanupSeal = canonicalSha256({
      schemaVersion: 1, transactionDigest: observed.transactionDigest, phase: 'rollback-cleanup-only'
    });
    await store.remove(observed.planFingerprint, cleanupSeal);
    expect(await store.verify(observed.planFingerprint, observed.transactionDigest)).toBe(false);
    expect(await store.verify(observed.planFingerprint, cleanupSeal)).toBe(false);
    const before = await projectBytes(fixture.root);
    expect(await readUpdateSuccessorApprovalAudit({
      projectRoot: fixture.root, semanticTransitionDigest: interrupted.preview.receipt.publication.semanticTransitionDigest,
      preparationId: interrupted.preview.receipt.receiptId
    }, fixture.options)).not.toBeNull();
    expect(await applyModernSuccessorUpdate(interrupted.request, approvalContext(), fixture.options))
      .toMatchObject({ status: 'recovery-blocked' });
    expect(await projectBytes(fixture.root)).toEqual(before);
  });

  it('copies review inputs before asynchronous candidate preparation', async () => {
    const fixture = await historicalProject(3);
    const preview = await previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options);
    const inspection = await inspectModernSuccessorUpdate(fixture.root, fixture.selection);
    if (inspection.kind !== 'activation-successor') throw new Error('Expected the actual activation source fixture.');
    const caller = { ...inspection, source: { ...inspection.source } };
    const pending = prepareModernSuccessorReview(caller, false, preview.receipt.publication.preparation, preparedAt);
    caller.projectRoot = path.join(path.dirname(fixture.root), 'not-the-reviewed-root');
    caller.source.sourceBinding = 'f'.repeat(64);
    caller.snapshots.find(snapshot => snapshot.content)?.content?.fill(0);
    caller.snapshots.splice(0);
    const reviewed = await pending;
    expect(reviewed.descriptor).toEqual(preview.receipt.variants[0]);
    expect(reviewed.publication).toEqual(preview.receipt.publication);
  });

  it('admits source history independently but rejects an oversized complete candidate before receipt or approval', async () => {
    const fixture = await historicalProject(3), manifestPath = path.join(fixture.root, 'liftoff.manifest.json');
    const original = await fs.readFile(manifestPath);
    await fs.writeFile(manifestPath, Buffer.concat([
      Buffer.alloc(reviewedJournalLimits.fileBytes - original.length, 0x20), original
    ]));
    expect((await fs.stat(manifestPath)).size).toBe(8 * 1024 * 1024);
    const before = await projectBytes(fixture.root);
    await expect(previewModernSuccessorUpdate(fixture.root, fixture.selection, fixture.options))
      .rejects.toThrow(/transaction snapshots exceed the bounded size limit/u);
    expect(await projectBytes(fixture.root)).toEqual(before);
    const location = await resolveUpdatePreviewLocation(fixture.root, fixture.options);
    await expect(fs.lstat(location.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('retained successor approval audit, not recovery authority', () => {
  function audit(root = projectRoot) {
    return createUpdateSuccessorApprovalAudit({
      projectRoot: root, publication: publication(), planFingerprint: descriptor(root).fingerprint,
      candidateBinding: 'c'.repeat(64), approvalMethod: 'interactive', approvedAt: preparedAt
    });
  }
  function lookup(root = projectRoot) {
    return { projectRoot: root, semanticTransitionDigest: publication().semanticTransitionDigest, preparationId };
  }

  it('binds full approval separately from semantic, preparation and candidate identities', () => {
    const value = audit();
    expect(validateUpdateSuccessorApprovalAudit(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value.planFingerprint).not.toBe(value.publication.semanticTransitionDigest);
    expect(value.planFingerprint).not.toBe(value.candidateBinding);
    expect(updateSuccessorApprovalAuditKey(lookup())).toMatch(/^[a-f0-9]{64}$/u);
    expect(value).not.toHaveProperty('committedAt');
    expect(value).not.toHaveProperty('transactionDigest');
    expect(() => validateUpdateSuccessorApprovalAudit(receipt())).toThrow();
    expect(() => validatePreparedUpdatePreviewReceipt(value)).toThrow();
  });

  it.each(['committedAt', 'transactionDigest', 'expiresAt'] as const)('rejects unallocated audit %s fields', field => {
    expect(() => validateUpdateSuccessorApprovalAudit({ ...audit(), [field]: preparedAt })).toThrow(/exactly/u);
  });

  it('rejects wrong roots, invalid approval methods and construction/approval/observation time contradictions', () => {
    expect(() => validateUpdateSuccessorApprovalAudit(audit(), { projectRoot: path.resolve('different-project') })).toThrow(/different/u);
    expect(() => validateUpdateSuccessorApprovalAudit({ ...audit(), approvalMethod: 'audit-replay' })).toThrow();
    expect(() => validateUpdateSuccessorApprovalAudit({ ...audit(), approvedAt: '2026-08-01T12:00:00.000Z' })).toThrow(/future/u);
    expect(() => validateUpdateSuccessorApprovalAudit(audit(), { now: new Date('2026-08-01T12:00:00.000Z') })).toThrow(/future/u);
    expect(() => validateUpdateSuccessorApprovalAudit(audit(), { now: new Date(NaN) })).toThrow(/invalid/u);
    expect(validateUpdateSuccessorApprovalAudit(audit(), { now: new Date('2036-09-01T12:00:00.000Z') })).toEqual(audit());
  });

  it('reports absent audit as unavailable and never supplies a transaction seal', async () => {
    const { root, options } = await storage();
    expect(await readUpdateSuccessorApprovalAudit(lookup(root), options)).toBeNull();
    const retained = await retainUpdateSuccessorApprovalAudit(audit(root), options);
    expect(await readUpdateSuccessorApprovalAudit(lookup(root), options)).toEqual(retained);
    const seals = createUpdateTransactionApprovalStore(root, options);
    expect(await seals.verify(retained.audit.planFingerprint, retained.audit.candidateBinding)).toBe(false);
    const prepared = await issue(root, options);
    await consumePreparedUpdatePreviewReceipt(root, prepared.receipt, options);
    expect(await readUpdateSuccessorApprovalAudit(lookup(root), options)).toEqual(retained);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('preserves the original approval time and rejects a conflicting later candidate', async () => {
    const { root, options } = await storage(), original = audit(root);
    const first = await retainUpdateSuccessorApprovalAudit(original, options);
    const later = { ...options, clock: () => new Date('2026-09-02T12:00:00.000Z') };
    const next = { ...original, approvedAt: '2026-09-02T12:00:00.000Z', approvalMethod: 'fingerprint' as const };
    expect(await retainUpdateSuccessorApprovalAudit(next, later)).toEqual(first);
    await expect(retainUpdateSuccessorApprovalAudit({ ...next, candidateBinding: 'd'.repeat(64) }, later)).rejects.toThrow(/different successor approval/u);
    expect(await readUpdateSuccessorApprovalAudit(lookup(root), later)).toEqual(first);
  });

  it('rejects audit lookup hooks before filesystem work', async () => {
    let invoked = 0;
    const request = lookup();
    Object.defineProperty(request, 'projectRoot', { enumerable: true, get() { invoked++; throw new Error('Accessor ran.'); } });
    await expect(readUpdateSuccessorApprovalAudit(request)).rejects.toThrow(/own enumerable data/u);
    expect(invoked).toBe(0);
  });
});

describe('guarded prepared preview persistence', () => {
  it('captures the expected receipt before asynchronous cleanup and preserves a newer receipt', async () => {
    const { root, options } = await storage();
    const original = await issue(root, options), newer = await issue(root, options);
    const caller = structuredClone(original.receipt);
    const pending = consumePreparedUpdatePreviewReceipt(root, caller, options);
    Object.assign(caller, newer.receipt);
    await expect(pending).rejects.toThrow(/newer or different/u);
    expect(await loadPreparedUpdatePreviewReceipt(root, options)).toEqual(newer);
  });

  it('issues real preparation parameters once, preserves a valid local anchor and reloads exact bytes', async () => {
    const { root, options } = await storage();
    const issued = await issue(root, options), bytes = await fs.readFile(issued.location.receiptPath);
    expect(issued.receipt.publication.preparation.localRepositoryId).toBe(localRepositoryId);
    expect(issued.receipt.receiptId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    const loaded = await loadPreparedUpdatePreviewReceipt(root, { ...options, clock: () => new Date('2036-09-01T12:00:00.000Z') });
    expect(loaded).toEqual(issued);
    expect(await fs.readFile(issued.location.receiptPath)).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual([]);
    await expect(loadUpdatePreviewReceipt(root, options)).rejects.toThrow(/schema 1/u);
    await consumePreparedUpdatePreviewReceipt(root, loaded.receipt, options);
    await expect(loadPreparedUpdatePreviewReceipt(root, options)).rejects.toThrow(/No saved update preview/u);
  });

  it('generates a new local anchor only when the historical anchor is not a protected UUID', async () => {
    const { root, options } = await storage();
    const first = await issue(root, options, 'R_historical-source');
    const second = await issue(root, options, 'local:legacy-source');
    for (const saved of [first, second]) {
      expect(saved.receipt.publication.preparation.localRepositoryId).toMatch(/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    }
    expect(first.receipt.publication.preparation.localRepositoryId).not.toBe(second.receipt.publication.preparation.localRepositoryId);
    expect(first.receipt.receiptId).not.toBe(second.receipt.receiptId);
    await expect(consumePreparedUpdatePreviewReceipt(root, first.receipt, options)).rejects.toThrow(/newer or different/u);
    expect(await loadPreparedUpdatePreviewReceipt(root, options)).toEqual(second);
  });

  it('requires schema two for reconstruction but permits a freshly reviewed different preview family', async () => {
    const { root, options } = await storage();
    const legacy = await issueUpdatePreviewReceipt(root, [descriptor(root)], options);
    await expect(loadPreparedUpdatePreviewReceipt(root, options)).rejects.toThrow(/schema 2/u);
    await issue(root, options);
    const nextLegacy = await issueUpdatePreviewReceipt(root, [descriptor(root)], options);
    expect(nextLegacy.receipt.schemaVersion).toBe(1);
    expect(nextLegacy.receipt.receiptId).not.toBe(legacy.receipt.receiptId);
    expect((await loadUpdatePreviewReceipt(root, options)).receipt).toEqual(nextLegacy.receipt);
  });

  it('creates no receipt or project effect when actual candidate preparation fails', async () => {
    const { root, options } = await storage();
    await expect(issuePreparedUpdatePreviewReceipt(root, localRepositoryId, async () => {
      throw new Error('Complete candidate could not be admitted.');
    }, options)).rejects.toThrow(/could not be admitted/u);
    expect(await fs.readdir(root)).toEqual([]);
    const location = await resolveUpdatePreviewLocation(root, options);
    await expect(fs.lstat(location.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
