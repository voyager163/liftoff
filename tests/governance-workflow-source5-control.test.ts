import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  createScopedUserLocalRecordStore, createWorkflowSource5ControlStore, nodeUpdatePreviewFileSystem,
  workflowSource5ControlLimits, workflowSource5ControlNamespaces, resolveUpdatePreviewLocation
} from '../src/adapters/filesystem/update-previews.js';
import type { UpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { plannedApprovalDestinations, plannedApprovalMutations, plannedApprovalResources } from '../src/domain/governance/activation/source-values.js';
import {
  assertSource5WorkflowAuthority, createSource5WorkflowContext, issueSource5WorkflowApproval,
  restoreSource5WorkflowAuthority, source5ApprovalHash, source5PreviewFingerprint, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { assertSource5WorkflowEntryOwnership, source5WorkflowOriginalPlanValue } from '../src/governance-activation/workflow-source5-authority.js';
import { source5OwnershipMaximumGeneration, source5WorkflowOwnership } from '../src/governance-activation/workflow-source5-ownership.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import { inspectModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import type { ModernPlanInput } from '../src/domain/governance/activation/modern-records.js';
import type { Source5WorkflowAuthority } from '../src/governance-activation/workflow-source5-authority.js';
import {
  source5WorkflowCheckpointOperation, source5WorkflowControlKey, source5WorkflowOperation, source5WorkflowProjectOperations
} from '../src/governance-activation/workflow-source5-operations.js';
import { source5WorkflowLogicalEntries, source5WorkflowPlanInventory } from '../src/governance-activation/workflow-source5-operations.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import type { Source5WorkflowControlBinding } from '../src/governance-activation/workflow-source5-operations.js';
import {
  claimSource5WorkflowEntryCarrier, withSource5WorkflowEntryGate
} from '../src/governance-activation/workflow-source5-context.js';
import type { Source5WorkflowEntryGate } from '../src/governance-activation/workflow-source5-context.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-workflow-source5-')));
  roots.push(root);
  const project = path.join(root, 'project'), home = path.join(root, 'private-home');
  await mkdir(project, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const options = { homedir: home, env: {} };
  return { root, project, options, store: createWorkflowSource5ControlStore(project, options) };
}

describe('closed sealed workflow source5 controls', () => {
  it.each(workflowSource5ControlNamespaces)('bounds native %s reads to the observed UTF-8 byte size', async name => {
    const { project, options, store } = await fixture(), key = canonicalSha256(`read-cap-${name}`);
    const saved = await store.save(name, key, { kind: 'isolated-control', unicode: 'A\u00e9', escaped: '"\\\n' }, null);
    const bytes = await readFile(saved.path);
    expect(bytes.length).toBeGreaterThan(bytes.toString('utf8').length);
    const reads: { maximumBytes: number; observedBytes: number }[] = [];
    const fileSystem: UpdatePreviewFileSystem = {
      ...nodeUpdatePreviewFileSystem,
      async openFile(filePath, access, mode) {
        const handle = await nodeUpdatePreviewFileSystem.openFile(filePath, access, mode);
        return { ...handle, async readText(maximumBytes) {
          reads.push({ maximumBytes, observedBytes: (await handle.stat()).size });
          return handle.readText(maximumBytes);
        } };
      }
    };
    expect(await createWorkflowSource5ControlStore(project, { ...options, fileSystem }).read(name, key)).toEqual(saved);
    expect(reads).toHaveLength(2);
    expect(reads.map(read => read.maximumBytes)).toEqual(reads.map(read => read.observedBytes));
    expect(reads.some(read => read.maximumBytes === bytes.length)).toBe(true);
  });

  it.each(['growth', 'shrink'] as const)('rejects actual native %s after opening without retaining success or rewriting bytes', async fault => {
    const { project, options, store } = await fixture(), key = canonicalSha256(`read-race-${fault}`);
    const saved = await store.save('proof', key, { kind: 'isolated-control', stage: 'intent' }, null);
    const original = await readFile(saved.path);
    const changed = fault === 'growth' ? Buffer.concat([original, Buffer.from(' ')]) : original.subarray(0, original.length - 1);
    const limits: number[] = [];
    let closes = 0;
    const fileSystem: UpdatePreviewFileSystem = {
      ...nodeUpdatePreviewFileSystem,
      async openFile(filePath, access, mode) {
        const handle = await nodeUpdatePreviewFileSystem.openFile(filePath, access, mode);
        if (access !== 'read' || filePath !== saved.path) return handle;
        return { ...handle, async readText(maximumBytes) {
          limits.push(maximumBytes);
          await writeFile(saved.path, changed, { mode: 0o600 });
          return handle.readText(maximumBytes);
        }, async close() {
          await handle.close();
          closes++;
        } };
      }
    };
    await expect(createWorkflowSource5ControlStore(project, { ...options, fileSystem }).read('proof', key))
      .rejects.toThrow(/size limit|changed while reading/u);
    expect(limits).toEqual([original.length]);
    expect(closes).toBe(1);
    expect(await readFile(saved.path)).toEqual(changed);
  });

  it('reads an actual empty native control with a zero-byte bound and rejects it rather than reporting absence', async () => {
    const { project, options, store } = await fixture(), key = canonicalSha256('empty-native-control');
    const saved = await store.save('proof', key, { kind: 'isolated-control' }, null);
    await writeFile(saved.path, '', { mode: 0o600 });
    const limits: number[] = [];
    const fileSystem: UpdatePreviewFileSystem = {
      ...nodeUpdatePreviewFileSystem,
      async openFile(filePath, access, mode) {
        const handle = await nodeUpdatePreviewFileSystem.openFile(filePath, access, mode);
        return { ...handle, async readText(maximumBytes) {
          if (filePath === saved.path) limits.push(maximumBytes);
          return handle.readText(maximumBytes);
        } };
      }
    };
    await expect(createWorkflowSource5ControlStore(project, { ...options, fileSystem }).read('proof', key))
      .rejects.toThrow(/Malformed sealed workflow control/u);
    expect(limits).toEqual([0]);
    expect(await readFile(saved.path, 'utf8')).toBe('');
  });

  it.each(workflowSource5ControlNamespaces)('rejects an oversized native %s before opening or allocating its contents', async name => {
    const { project, options, store } = await fixture(), key = canonicalSha256(`oversized-native-${name}`);
    const saved = await store.save(name, key, { kind: 'isolated-control' }, null);
    const oversized = Buffer.alloc(workflowSource5ControlLimits[name] + 1, 'x');
    await writeFile(saved.path, oversized, { mode: 0o600 });
    let opens = 0;
    const fileSystem: UpdatePreviewFileSystem = {
      ...nodeUpdatePreviewFileSystem,
      async openFile(filePath, access, mode) {
        if (filePath === saved.path && access === 'read') opens++;
        return nodeUpdatePreviewFileSystem.openFile(filePath, access, mode);
      }
    };
    await expect(createWorkflowSource5ControlStore(project, { ...options, fileSystem }).read(name, key))
      .rejects.toThrow(/size limit/u);
    expect(opens).toBe(0);
    expect((await readFile(saved.path)).equals(oversized)).toBe(true);
  });

  it.each(workflowSource5ControlNamespaces)('round-trips exact %s records through an independently reopened store', async name => {
    const { project, options, store } = await fixture(), key = canonicalSha256(name);
    const value = { kind: 'isolated-control', unicode: 'A\u00e9', escaped: '"\\\n', status: 'intent' };
    const saved = await store.save(name, key, value, null);
    const reopened = createWorkflowSource5ControlStore(project, options);
    expect(await reopened.read(name, key)).toEqual(saved);
    expect(saved.encodedBytes).toBe((await readFile(saved.path)).length);
    expect(path.relative(project, saved.path).startsWith('..')).toBe(true);
    expect(saved.revision).toBe(1);
    if (name === 'journal' || name === 'operation') {
      const next = await reopened.save(name, key, { ...value, status: 'accepted' }, saved.rawDigest);
      expect(next.previousDigest).toBe(saved.rawDigest); expect(next.revision).toBe(2);
      await expect(store.save(name, key, value, saved.rawDigest)).rejects.toThrow(/CAS/);
      expect((await store.read(name, key))?.value).toEqual(next.value);
    } else await expect(store.save(name, key, value, saved.rawDigest)).rejects.toThrow(/immutable/);
  });

  it.each(workflowSource5ControlNamespaces)('enforces actual sealed %s disk cap -1/equal/+1, including rejected completion preservation', async name => {
    const { store } = await fixture(), key = canonicalSha256(`size-${name}`);
    const limit = workflowSource5ControlLimits[name];
    const base = { kind: 'size-fixture', escaped: '"\\\n\u00e9', pieces: ['', ''] };
    const overhead = await store.measure(name, key, base);
    const pieces = (length: number) => {
      const first = Math.min(length, 8 * 1024 * 1024 - 1);
      return { ...base, pieces: ['x'.repeat(first), 'y'.repeat(length - first)] };
    };
    const below = pieces(limit - overhead - 1);
    expect(await store.measure(name, key, below)).toBe(limit - 1);
    const equal = pieces(limit - overhead);
    expect(await store.measure(name, key, equal)).toBe(limit);
    const saved = await store.save(name, key, equal, null), bytes = await readFile(saved.path);
    expect(bytes.length).toBe(limit);
    expect(canonicalJson(JSON.parse(bytes.toString('utf8')))).toBe(bytes.toString('utf8'));
    await expect(store.measure(name, key, pieces(limit - overhead + 1))).rejects.toThrow(/sealed.*size limit/);
    await expect(store.save(name, key, pieces(limit - overhead + 1), saved.rawDigest)).rejects.toThrow(/size limit/);
    expect((await readFile(saved.path)).equals(bytes)).toBe(true);
    expect((await store.read(name, key))?.rawDigest).toBe(saved.rawDigest);
  });

  it('does not enlarge old stores or permit unknown namespaces/path keys', async () => {
    const { project, options, store } = await fixture();
    await expect(createScopedUserLocalRecordStore(project, 'governance-approval', options)
      .write(canonicalSha256('old'), { value: 'x'.repeat(64 * 1024) })).rejects.toThrow(/size limit/);
    await expect(store.read('operation', '../outside')).rejects.toThrow(/SHA-256/);
    // @ts-expect-error unknown namespace is rejected at runtime as well
    await expect(store.read('generic-authority', canonicalSha256('unknown'))).rejects.toThrow(/namespace/);
  });

  it.each(['value', 'namespace', 'key', 'projectRoot', 'revision', 'seal', 'extra'] as const)(
    'rejects tampered %s without modifying any private record', async field => {
      const { store } = await fixture(), key = canonicalSha256(`tamper-${field}`);
      const saved = await store.save('operation', key, { stage: 'intent' }, null);
      const raw = JSON.parse((await readFile(saved.path)).toString('utf8'));
      raw[field] = field === 'revision' ? 2 : field === 'seal' ? 'f'.repeat(64) : 'substituted';
      await writeFile(saved.path, canonicalJson(raw), { mode: 0o600 });
      const changed = await readFile(saved.path);
      await expect(store.read('operation', key)).rejects.toThrow(/seal|scope|bytes/);
      await expect(store.save('operation', key, { stage: 'terminal' }, canonicalSha256(raw))).rejects.toThrow();
      expect(await readFile(saved.path)).toEqual(changed);
    });

  it.each(['symlink', 'hardlink'] as const)('refuses %s substitutions and preserves their targets', async kind => {
    const { store } = await fixture();
    const key = canonicalSha256(kind), saved = await store.save('journal', key, { intent: true }, null);
    const target = await store.save('journal', canonicalSha256(`target-${kind}`), { other: true }, null);
    const bytes = await readFile(target.path);
    await unlink(saved.path);
    if (kind === 'symlink') await symlink(target.path, saved.path); else await link(target.path, saved.path);
    await expect(store.read('journal', key)).rejects.toThrow(/singly linked/);
    await expect(store.save('journal', key, { replaced: true }, saved.rawDigest)).rejects.toThrow(/singly linked/);
    expect(await readFile(target.path)).toEqual(bytes);
  });

  it('refuses storage within the project and separately binds other project roots', async () => {
    const { project, options, store, root } = await fixture(), key = canonicalSha256('root');
    await store.save('approval', key, { approval: 'original' }, null);
    const other = path.join(root, 'other'); await mkdir(other, { mode: 0o700 });
    expect(await createWorkflowSource5ControlStore(other, options).read('approval', key)).toBeNull();
    await expect(createWorkflowSource5ControlStore(project, { homedir: project, env: {} })
      .save('journal', key, { stage: 'intent' }, null)).rejects.toThrow(/outside/);
  });

  it('preserves unresolved intent after an actual flush failure and never reports a successful save', async () => {
    const { project, options, store } = await fixture(), key = canonicalSha256('flush');
    const original = await store.save('operation', key, { stage: 'intent' }, null);
    const failing = createWorkflowSource5ControlStore(project, { ...options, fileSystem: {
      ...nodeUpdatePreviewFileSystem,
      async replaceFile() { throw new Error('isolated replacement failure'); }
    } });
    await expect(failing.save('operation', key, { stage: 'accepted' }, original.rawDigest)).rejects.toThrow();
    expect(await store.read('operation', key)).toEqual(original);
  });
});

async function authorityFixture(scope: { controlAnchor?: string; bindingAnchor?: string; controlProjectKey?: string } = {}) {
  const fixtureValue = await fixture(), installed = await writeModernInstalledProject(fixtureValue.project);
  await installed.write(['governance', 'activation-state.json'], canonicalJson(installed.state));
  const identity = installed.api!.identity;
  const context = createSource5WorkflowContext(projectCatalog, {
    recordedIdentity: identity, profile: 'single-maintainer-gitflow', policyVersion: identity.policyVersion,
    selection: { ...installed.input.selection, profile: 'single-maintainer-gitflow' },
    pluginResolutionDigest: identity.pluginResolutionDigest, activeLayoutDigest: identity.activeLayoutDigest
  });
  const api = context.records, id = 'dev-proof', phase = api.graph.phases.find(phase => phase.id === id)!;
  const operation = source5WorkflowOperation(id, 'github.checks.dev-proof', {
    repository: 'owner/repo', repositoryId: 123, sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
    executionRef: `liftoff-execution-${'a'.repeat(40)}`
  });
  const keyInput = { executionId: '11111111-1111-4111-8111-111111111111', phaseId: 'dev-proof' as const,
    repositoryAnchor: scope.controlAnchor ?? installed.state!.repository.id,
    projectKey: scope.controlProjectKey ?? (await resolveUpdatePreviewLocation(fixtureValue.project, fixtureValue.options)).projectKey };
  const control = {
    ...keyInput, schemaVersion: 1, kind: 'workflow-source5-control.v1', controlKey: source5WorkflowControlKey(keyInput),
    reviewKind: 'bound-source', remainingFrom: null,
    origin: { planKey: 'a'.repeat(64), proofKey: 'b'.repeat(64), publicationDigest: 'c'.repeat(64),
      commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) }
  } as const;
  const checkpoint = source5WorkflowCheckpointOperation(control);
  const operations = [operation, checkpoint, ...source5WorkflowProjectOperations(control)];
  const effects = [operation, checkpoint].flatMap(operation => [operation, ...(operation.effects ?? [])]);
  const observed = await inspectModernInstalledActivation(fixtureValue.project);
  if (observed.status !== 'observed') throw new Error('Expected independently readable installed fixture.');
  const input: ModernPlanInput = {
    phaseId: id, createdAt: '2026-09-01T12:00:00.000Z', expiresAt: '2026-09-01T13:00:00.000Z', stateHash: canonicalSha256(installed.state),
    baselineDigest: observed.binding, inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64),
    operations, noSecrets: true,
    configuration: { schemaVersion: 1, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
    approval: { gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: true,
        status: 'approval-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
    rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] }
  };
  const draft = api.createPlan(input);
  const approval = api.createApproval({ plan: draft, id: `source5-${control.controlKey}`, approvedAt: input.createdAt,
    expiresAt: input.expiresAt, approver: 'isolated-fixture-human', resources: plannedApprovalResources(effects),
    destinations: plannedApprovalDestinations(effects), permissions: plannedApprovalMutations(effects),
    costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: [] });
  const hash = source5ApprovalHash(context, approval);
  const plan = api.createPlan({ ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash: hash,
    evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash: hash } } },
  { approvals: [approval] });
  await fixtureValue.store.save('plan', control.controlKey, source5WorkflowOriginalPlanValue(fixtureValue.project, plan, approval), null);
  return { ...fixtureValue, context, plan, approval, operation, control, input,
    now: new Date('2026-09-01T12:05:00.000Z'), repositoryAnchor: scope.bindingAnchor ?? installed.state!.repository.id,
    previewFingerprint: source5PreviewFingerprint(fixtureValue.project, plan), state: installed.state!, write: installed.write };
}

describe('independently issued modern source5 workflow authority', () => {
  it('serializes each original entry across failures without blocking a different entry', async () => {
    const value = await fixture(), key = canonicalSha256('original-entry'), other = canonicalSha256('other-entry');
    await withSource5WorkflowLease(value.project, async lease => {
      const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), order: string[] = [];
      const first = withSource5WorkflowEntryGate(value.project, lease, key, async () => {
        order.push('first'); entered.resolve();
        await resume.promise;
        throw new Error('isolated first entry failure');
      });
      const rejected = expect(first).rejects.toThrow(/isolated first entry failure/);
      await entered.promise;
      const second = withSource5WorkflowEntryGate(value.project, lease, key, async () => { order.push('second'); });
      await withSource5WorkflowEntryGate(value.project, lease, other, async () => { order.push('other'); });
      expect(order).toEqual(['first', 'other']);
      resume.resolve();
      await Promise.all([rejected, second]);
      expect(order).toEqual(['first', 'other', 'second']);
    });
  });

  it('claims a carrier only once through its active original entry gate, never structural or expired gates/leases', async () => {
    const value = await fixture(), key = canonicalSha256('original-entry');
    let endedGate: Source5WorkflowEntryGate | undefined, endedLease: ProjectMutationLease | undefined;
    await expect(claimSource5WorkflowEntryCarrier({ kind: 'source5-workflow-entry-gate' })).rejects.toThrow(/active engine-held/);
    await withSource5WorkflowLease(value.project, async lease => {
      endedLease = lease;
      await expect(withSource5WorkflowEntryGate(value.project, { ...lease }, key, async () => undefined)).rejects.toThrow(/lease/);
      await expect(withSource5WorkflowEntryGate(`${value.project}/foreign`, lease, key, async () => undefined)).rejects.toThrow(/lease/);
      await expect(withSource5WorkflowEntryGate(value.project, lease, 'unknown-key', async () => undefined)).rejects.toThrow(/stable original/);
      await withSource5WorkflowEntryGate(value.project, lease, key, async gate => {
        endedGate = gate;
        await claimSource5WorkflowEntryCarrier(gate);
        await expect(claimSource5WorkflowEntryCarrier(gate)).rejects.toThrow(/duplicate effect carrier/);
      });
      await expect(claimSource5WorkflowEntryCarrier(endedGate!)).rejects.toThrow(/active engine-held/);
      await withSource5WorkflowEntryGate(value.project, lease, key, async gate => {
        await expect(claimSource5WorkflowEntryCarrier(gate)).rejects.toThrow(/duplicate effect carrier/);
      });
      await withSource5WorkflowEntryGate(value.project, lease, canonicalSha256('independent-entry'), claimSource5WorkflowEntryCarrier);
    });
    await expect(withSource5WorkflowEntryGate(value.project, endedLease!, key, async () => undefined)).rejects.toThrow(/lease/);
  });

  it('requires original private issuance and can restore it after a new process context/lease', async () => {
    const value = await authorityFixture();
    await withSource5WorkflowLease(value.project, async lease => {
      const binding = { ...value, projectRoot: value.project, lease, storage: value.options };
      await expect(restoreSource5WorkflowAuthority(binding, value.now)).rejects.toThrow(/issuance|issued|permission/);
      await issueSource5WorkflowApproval(binding, value.now);
    });
    await withSource5WorkflowLease(value.project, async lease => {
      const token = await restoreSource5WorkflowAuthority({ ...value, projectRoot: value.project, lease, storage: value.options }, value.now);
      await assertSource5WorkflowAuthority({ authority: token, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: value.now, write: true });
      const expired = new Date('2026-09-02T12:00:00.000Z');
      await expect(assertSource5WorkflowAuthority({ authority: token, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: expired, write: true })).rejects.toThrow(/unexpired/);
      await assertSource5WorkflowAuthority({ authority: token, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: expired, write: false });
    });
  });
    type AuthorityFixture = Omit<Awaited<ReturnType<typeof authorityFixture>>, 'control'> & { control: Source5WorkflowControlBinding };
    async function continuation(value: AuthorityFixture): Promise<AuthorityFixture> {
      const { control: previous } = source5WorkflowPlanInventory(value.plan);
      const executionId = randomUUID();
      const keyInput = { executionId, phaseId: previous.phaseId, repositoryAnchor: previous.repositoryAnchor, projectKey: previous.projectKey };
      const control = { ...previous, ...keyInput, controlKey: source5WorkflowControlKey(keyInput), reviewKind: 'remaining-only' as const,
        remainingFrom: { planKey: previous.controlKey, operationDigests: [canonicalSha256(value.operation)] } };
      const checkpoint = source5WorkflowCheckpointOperation(control);
      const input = { ...value.input, operations: [value.operation, checkpoint, ...source5WorkflowProjectOperations(control)] };
      const api = value.context.records, draft = api.createPlan(input);
      const effects = [value.operation, checkpoint].flatMap(operation => [operation, ...(operation.effects ?? [])]);
      const approval = api.createApproval({ plan: draft, id: `source5-${control.controlKey}`, approvedAt: input.createdAt,
        expiresAt: input.expiresAt, approver: 'isolated-fixture-human', resources: plannedApprovalResources(effects),
        destinations: plannedApprovalDestinations(effects), permissions: plannedApprovalMutations(effects),
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: [] });
      const hash = source5ApprovalHash(value.context, approval);
      const plan = api.createPlan({ ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash: hash,
        evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash: hash } } }, { approvals: [approval] });
  await value.store.save('plan', control.controlKey, source5WorkflowOriginalPlanValue(value.project, plan, approval), null);
      return { ...value, control, input, plan, approval, previewFingerprint: source5PreviewFingerprint(value.project, plan) };
    }
    const bindingFor = (value: AuthorityFixture, lease: ProjectMutationLease) =>
      ({ ...value, projectRoot: value.project, lease, storage: value.options });
    async function sealOriginal(value: AuthorityFixture) {
      const { control } = source5WorkflowPlanInventory(value.plan);
      const original = source5WorkflowOriginalPlanValue(value.project, value.plan, value.approval);
      const existing = await value.store.read('plan', control.controlKey);
      if (existing) expect(existing.value).toEqual(original); else await value.store.save('plan', control.controlKey, original, null);
    }
    async function owned(value: AuthorityFixture, lease: ProjectMutationLease) {
      await sealOriginal(value);
      return source5WorkflowOwnership(bindingFor(value, lease));
    }

    describe('stable original-entry ownership, independent of future plan keys', () => {
      it.each(['intent-first', 'transfer-first'] as const)(
        'linearizes actual ownership preparation with a first-intent writer under the same original gate: %s', async order => {
          const original = await authorityFixture(), next = await continuation(original);
          await withSource5WorkflowLease(original.project, async lease => {
            await issueSource5WorkflowApproval(bindingFor(original, lease), original.now);
            const first = await owned(original, lease);
            const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
            let reservationWrites = 0, intentWrites = 0;
            const receiptKey = first.reservationKey(1);
            const second = await source5WorkflowOwnership({ ...bindingFor(next, lease), storage: {
              ...original.options, fileSystem: { ...nodeUpdatePreviewFileSystem,
                async replaceFile(source: string, target: string) {
                  if (target.endsWith(`-${receiptKey}.json`)) {
                    reservationWrites++;
                    if (order === 'transfer-first') { entered.resolve(); await resume.promise; }
                  }
                  return nodeUpdatePreviewFileSystem.replaceFile(source, target);
                }
              }
            } });
            expect(second.entryKey).toBe(first.entryKey);
            const operationKey = canonicalSha256({ controlKey: original.control.controlKey,
              operationDigest: canonicalSha256(original.operation) });
            const intentKey = canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey, stage: 'dispatch-intent' });
            const writeIntent = () => withSource5WorkflowEntryGate(original.project, lease, first.entryKey, async () => {
              await first.assertCurrent(true);
              if (order === 'intent-first') { entered.resolve(); await resume.promise; }
              await original.store.save('proof', intentKey,
                { retained: 'isolated durable intent marker; not qualified dispatch evidence' }, null);
              intentWrites++;
            });
            if (order === 'intent-first') {
              const writer = writeIntent(); await entered.promise;
              const transfer = expect(second.prepare()).rejects.toThrow(/intent|acceptance|terminal/);
              await withSource5WorkflowEntryGate(original.project, lease, canonicalSha256('independent-entry'), async () => undefined);
              expect(reservationWrites).toBe(0);
              resume.resolve();
              await Promise.all([writer, transfer]);
              expect(intentWrites).toBe(1);
              expect(await original.store.read('proof', receiptKey)).toBeNull();
              await first.assertCurrent(false);
            } else {
              const transfer = second.prepare(); await entered.promise;
              const writer = expect(writeIntent()).rejects.toThrow(/ownership|owner/);
              await withSource5WorkflowEntryGate(original.project, lease, canonicalSha256('independent-entry'), async () => undefined);
              expect(intentWrites).toBe(0);
              resume.resolve();
              await Promise.all([transfer, writer]);
              expect(intentWrites).toBe(0);
              expect(reservationWrites).toBe(1);
              expect(await original.store.read('proof', intentKey)).toBeNull();
              await second.assertCurrent(true);
            }
          });
        });

      it('retains the same original entry across reviewed descendants and blocks every retired owner at issuance/restoration/pre-intent', async () => {
        const original = await authorityFixture(), next = await continuation(original), last = await continuation(next);
        let firstKey = '';
        await withSource5WorkflowLease(original.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(original, lease), original.now);
          await sealOriginal(original);
          const first = await owned(original, lease);
          firstKey = first.entryKey;
          const token = await restoreSource5WorkflowAuthority(bindingFor(original, lease), original.now);
          await issueSource5WorkflowApproval(bindingFor(next, lease), next.now);
          await sealOriginal(next);
          expect((await owned(next, lease)).entryKey).toBe(firstKey);
          await expect(issueSource5WorkflowApproval(bindingFor(original, lease), original.now)).rejects.toThrow();
          await expect(restoreSource5WorkflowAuthority(bindingFor(original, lease), original.now)).rejects.toThrow();
          await expect(assertSource5WorkflowEntryOwnership({ authority: token, projectRoot: original.project,
            plan: original.plan, operation: original.operation, lease, firstIntent: true })).rejects.toThrow();
          for (const operation of source5WorkflowProjectOperations(original.control)) {
            await expect(assertSource5WorkflowAuthority({ authority: token, projectRoot: original.project,
              plan: original.plan, operation, now: original.now, write: true, lease })).rejects.toThrow();
          }
          await issueSource5WorkflowApproval(bindingFor(last, lease), last.now);
        });
        await withSource5WorkflowLease(original.project, async lease => {
          const current = await owned(last, lease);
          expect(current.entryKey).toBe(firstKey);
          expect(current.originalPlanKey).toBe(original.control.controlKey);
          await current.assertCurrent(true);
          await restoreSource5WorkflowAuthority(bindingFor(last, lease), last.now);
          await expect(restoreSource5WorkflowAuthority(bindingFor(next, lease), next.now)).rejects.toThrow();
        });
      });

      it.each(['reservation-rejected', 'reservation-confirmation-lost', 'cas-rejected', 'cas-confirmation-lost', 'readback-lost', 'confirmation-rejected'] as const)(
        'restarts truthfully after %s without granting another owner or repeating a provider effect', async fault => {
          const original = await authorityFixture(), next = await continuation(original);
          let entryKey = '', receiptKey = '', confirmKey = '';
          await withSource5WorkflowLease(original.project, async lease => {
            await issueSource5WorkflowApproval(bindingFor(original, lease), original.now);
            await sealOriginal(original);
            const first = await owned(original, lease);
            entryKey = first.entryKey; receiptKey = first.reservationKey(1); confirmKey = first.confirmationKey(1);
            let readbackArmed = false;
            const fileSystem = { ...nodeUpdatePreviewFileSystem,
              async replaceFile(source: string, target: string) {
                const receipt = target.endsWith(`-${receiptKey}.json`), pointer = target.endsWith(`-${entryKey}.json`),
                  confirmation = target.endsWith(`-${confirmKey}.json`);
                if (fault === 'reservation-rejected' && receipt || fault === 'cas-rejected' && pointer ||
                  fault === 'confirmation-rejected' && confirmation) throw new Error(`isolated ${fault}`);
                await nodeUpdatePreviewFileSystem.replaceFile(source, target);
                if (fault === 'readback-lost' && pointer) readbackArmed = true;
                if (fault === 'reservation-confirmation-lost' && receipt || fault === 'cas-confirmation-lost' && pointer) {
                  throw new Error(`isolated ${fault}`);
                }
              },
              async openFile(file: string, access: 'read' | 'create-exclusive', mode: number) {
                if (readbackArmed && access === 'read' && file.endsWith(`-${entryKey}.json`)) throw new Error('isolated readback lost');
                return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
              }
            };
            await expect(issueSource5WorkflowApproval({ ...bindingFor(next, lease),
              storage: { ...original.options, fileSystem } }, next.now)).rejects.toThrow();
          });
          await withSource5WorkflowLease(original.project, async lease => {
            const first = await owned(original, lease), second = await owned(next, lease);
            const receipt = await original.store.read('proof', receiptKey);
            if (fault === 'reservation-rejected') {
              expect(receipt).toBeNull();
              await first.assertCurrent(true);
              await second.prepare();
              await second.assertCurrent(true);
            } else {
              expect(receipt).not.toBeNull();
              await expect(first.assertCurrent(false)).rejects.toThrow();
              await expect(second.assertCurrent(false)).rejects.toThrow();
              await expect(first.prepare()).rejects.toThrow();
              await expect(second.prepare()).rejects.toThrow();
              expect(await original.store.read('proof', confirmKey)).toBeNull();
              expect((await original.store.read('proof', receiptKey))?.rawDigest).toBe(receipt!.rawDigest);
            }
          });
        });

      it.each(['publication-writing', 'publication-commit-intent', 'publication-commit-observed', 'publication-committed',
        'publication-push-intent', 'publication-push-accepted', 'publication-published', 'execution-ref-intent',
        'execution-ref-accepted', 'runner-intent', 'runner-accepted', 'dispatch-intent', 'dispatch-accepted',
        'dispatch-terminal', 'component-completed', 'progress-pointer'] as const)(
        'forbids continuation after durable %s even when the progress CAS was absent', async stage => {
          const value = await authorityFixture(), next = await continuation(value);
          await withSource5WorkflowLease(value.project, async lease => {
            await issueSource5WorkflowApproval(bindingFor(value, lease), value.now); await sealOriginal(value);
            const operationKey = canonicalSha256({ controlKey: value.control.controlKey, operationDigest: canonicalSha256(value.operation) });
            const key = stage === 'progress-pointer' ? operationKey : canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey, stage });
            const saved = await value.store.save(stage === 'progress-pointer' ? 'operation' : 'proof', key,
              { retained: 'actual attempted entry fixture; never a qualified provider proof' }, null);
            await expect(issueSource5WorkflowApproval(bindingFor(next, lease), next.now)).rejects.toThrow(/intent|progress|acceptance|terminal/);
            expect((await value.store.read(stage === 'progress-pointer' ? 'operation' : 'proof', key))?.rawDigest).toBe(saved.rawDigest);
            expect(await value.store.read('proof', (await owned(value, lease)).reservationKey(1))).toBeNull();
          });
        });

      it('does not let two separately reapproved continuations or parallel reservations steal one original entry', async () => {
        const original = await authorityFixture(), first = await continuation(original), second = await continuation(original);
        await withSource5WorkflowLease(original.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(original, lease), original.now); await sealOriginal(original);
          const outcomes = await Promise.allSettled([issueSource5WorkflowApproval(bindingFor(first, lease), first.now),
            issueSource5WorkflowApproval(bindingFor(second, lease), second.now)]);
          expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
          const winner = outcomes[0]!.status === 'fulfilled' ? first : second;
          const loser = winner === first ? second : first;
          await (await owned(winner, lease)).assertCurrent(true);
          await expect((await owned(loser, lease)).prepare()).rejects.toThrow();
          await expect((await owned(original, lease)).assertCurrent(false)).rejects.toThrow();
        });
      });

      it('blocks raw snapshot drift at first intent but still permits retaining later acceptance truth', async () => {
        const value = await authorityFixture();
        await withSource5WorkflowLease(value.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(value, lease), value.now);
          const token = await restoreSource5WorkflowAuthority(bindingFor(value, lease), value.now);
          const input = { authority: token, projectRoot: value.project, plan: value.plan, operation: value.operation, lease };
          await assertSource5WorkflowEntryOwnership({ ...input, firstIntent: true });
          await value.write(['governance', 'activation-state.json'], canonicalJson(value.state) + '\n');
          await expect(assertSource5WorkflowEntryOwnership({ ...input, firstIntent: true })).rejects.toThrow(/snapshot/);
          await assertSource5WorkflowEntryOwnership({ ...input, firstIntent: false });
          await value.write(['governance', 'activation-state.json'], canonicalJson(value.state));
        });
      });

      it.each(['manifest', 'pointer', 'confirmation', 'original-plan'] as const)('does not recreate lost %s history', async kind => {
        const value = await authorityFixture(), next = await continuation(value);
        await withSource5WorkflowLease(value.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(value, lease), value.now); await sealOriginal(value);
          const owner = await owned(value, lease);
          const record = kind === 'original-plan' ? await value.store.read('plan', value.control.controlKey) :
            await value.store.read(kind === 'pointer' ? 'operation' : 'proof',
              kind === 'pointer' ? owner.entryKey : kind === 'confirmation' ? owner.confirmationKey(0) : owner.inventory.manifestKey);
          await unlink(record!.path);
          await expect(source5WorkflowOwnership(bindingFor(value, lease)).then(owner => owner.prepare())).rejects.toThrow();
          await expect(issueSource5WorkflowApproval(bindingFor(next, lease), next.now)).rejects.toThrow();
        });
      });

      it('commits every bounded ownership key and independently measures complete sealed revision/generation growth', async () => {
        const value = await authorityFixture();
        await withSource5WorkflowLease(value.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(value, lease), value.now);
          const owner = await owned(value, lease);
          const manifest = (await value.store.read('proof', owner.inventory.manifestKey))!;
          const raw = manifest.value as { objects: { namespace: 'operation' | 'proof'; key: string; maximumEncodedBytes: number; maximumRevisions: number }[];
            maximumEncodedFootprint: number; generationLimit: number };
          expect(raw.generationLimit).toBe(source5OwnershipMaximumGeneration);
          expect(raw.objects).toHaveLength(2 * source5OwnershipMaximumGeneration + 3);
          expect(new Set(raw.objects.map(object => object.key)).size).toBe(raw.objects.length);
          expect(raw.maximumEncodedFootprint).toBe(raw.objects.reduce((sum, object) =>
            sum + object.maximumEncodedBytes * object.maximumRevisions, 0));
          expect(raw.objects.find(object => object.key === owner.inventory.manifestKey)!.maximumEncodedBytes).toBe(manifest.encodedBytes);
          expect(raw.objects.find(object => object.key === owner.entryKey)!.maximumRevisions).toBe(65);
          for (const object of raw.objects) expect(object.maximumEncodedBytes).toBeLessThanOrEqual(workflowSource5ControlLimits[object.namespace]);
        });
      });

      it.each([271, 272, 273])('separately enforces %i logical entries without claiming physical storage fit', async count => {
        const value = await authorityFixture();
        const operations = Array.from({ length: count }, () => ({ ...value.operation, effects: [] }));
        if (count > 272) expect(() => source5WorkflowLogicalEntries(operations)).toThrow(/272/);
        else expect(source5WorkflowLogicalEntries(operations)).toBe(count);
        const actual = Array.from({ length: 132 }, (_, index) => source5WorkflowOperation('dev-proof', 'github.checks.dev-proof',
          { ...value.operation.inputs, fixtureIndex: index }));
        const plan = { ...value.plan, operations: [...actual, source5WorkflowCheckpointOperation(value.control),
          ...source5WorkflowProjectOperations(value.control)] };
        expect(source5WorkflowLogicalEntries(plan.operations)).toBe(271);
        expect(source5WorkflowPlanInventory(plan).effects).toHaveLength(132);
      });

      it.each([-1, 0, 1])('rejects changed concrete key inventory at fixed cardinality %+i', async delta => {
        const value = await authorityFixture();
        await withSource5WorkflowLease(value.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(value, lease), value.now);
          const owner = await owned(value, lease), record = (await value.store.read('proof', owner.inventory.manifestKey))!;
          const original = await readFile(record.path);
          const raw = structuredClone(record.value) as { objects: Record<string, unknown>[] };
          if (delta < 0) raw.objects.pop();
          else if (delta > 0) raw.objects.push({ namespace: 'proof', key: 'f'.repeat(64), maximumEncodedBytes: 1000, maximumRevisions: 1 });
          if (delta) {
            await unlink(record.path);
            await value.store.save('proof', owner.inventory.manifestKey, raw, null);
            await expect(owner.assertCurrent(false)).rejects.toThrow(/inventory|footprint/);
            await writeFile(record.path, original, { mode: 0o600 });
          }
          await owner.assertCurrent(true);
          expect(() => owner.reservationKey(0)).toThrow(/range/);
          expect(() => owner.reservationKey(65)).toThrow(/range/);
          expect(() => owner.confirmationKey(-1)).toThrow(/range/);
          expect(() => owner.confirmationKey(65)).toThrow(/range/);
          expect(owner.confirmationKey(64)).toMatch(/^[a-f0-9]{64}$/);
        });
      });

      it.each(['foreign-scope', 'extra-field', 'stale-generation'] as const)('blocks coherently sealed %s reservation without rewriting the current pointer', async variant => {
        const value = await authorityFixture(), next = await continuation(value);
        await withSource5WorkflowLease(value.project, async lease => {
          await issueSource5WorkflowApproval(bindingFor(value, lease), value.now);
          const owner = await owned(value, lease), pointer = (await value.store.read('operation', owner.entryKey))!;
          await value.store.save('proof', owner.reservationKey(1), { kind: 'coherently sealed malformed reservation fixture',
            originalEntryKey: variant === 'foreign-scope' ? 'f'.repeat(64) : owner.entryKey,
            ...(variant === 'extra-field' ? { arbitraryPermission: 'denied' } : {}),
            generation: variant === 'stale-generation' ? 0 : 1 }, null);
          await expect(owner.assertCurrent(false)).rejects.toThrow(/reservation|retires/);
          await expect(issueSource5WorkflowApproval(bindingFor(next, lease), next.now)).rejects.toThrow();
          expect((await value.store.read('operation', owner.entryKey))?.rawDigest).toBe(pointer.rawDigest);
        });
      });

      it('allows a never-attempted owner one actual bounded localhost request, then observation-only recovery', async () => {
        const value = await authorityFixture();
        let requests = 0;
        const server = createServer((incoming, response) => {
          if (incoming.method !== 'POST' || incoming.url !== '/repos/owner/repo/actions/workflows/996/dispatches') {
            response.writeHead(400); response.end(); return;
          }
          requests++;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ workflow_run_id: 901,
            run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
            html_url: 'https://github.com/owner/repo/actions/runs/901' }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Isolated HTTP fixture did not bind.');
        try {
          await withSource5WorkflowLease(value.project, async lease => {
            await issueSource5WorkflowApproval(bindingFor(value, lease), value.now);
            const token = await restoreSource5WorkflowAuthority(bindingFor(value, lease), value.now);
            const check = { authority: token, projectRoot: value.project, plan: value.plan, operation: value.operation, lease };
            await assertSource5WorkflowEntryOwnership({ ...check, firstIntent: true });
            const operationKey = canonicalSha256({ controlKey: value.control.controlKey, operationDigest: canonicalSha256(value.operation) });
            const key = canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey, stage: 'dispatch-intent' });
            await value.store.save('proof', key, { kind: 'isolated literal HTTP intent; not qualified provider evidence',
              controlKey: value.control.controlKey, planDigest: value.plan.planDigest, operationDigest: canonicalSha256(value.operation),
              workflowId: 996, dispatchedAt: value.now.toISOString() }, null);
            await assertSource5WorkflowEntryOwnership({ ...check, firstIntent: false });
            const response = await fetch(`http://127.0.0.1:${address.port}/repos/owner/repo/actions/workflows/996/dispatches`, {
              method: 'POST', signal: AbortSignal.timeout(1000), body: JSON.stringify({ ref: value.operation.inputs.executionRef })
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ workflow_run_id: 901 });
            await expect(assertSource5WorkflowEntryOwnership({ ...check, firstIntent: true })).rejects.toThrow(/intent|acceptance|terminal/);
          });
          await withSource5WorkflowLease(value.project, async lease => {
            const token = await restoreSource5WorkflowAuthority(bindingFor(value, lease), value.now);
            await assertSource5WorkflowEntryOwnership({ authority: token, projectRoot: value.project,
              plan: value.plan, operation: value.operation, lease, firstIntent: false });
            await expect((await owned(value, lease)).assertCurrent(true)).rejects.toThrow();
          });
          expect(requests).toBe(1);
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      });
    });
  it.each(['token', 'lease', 'context', 'root', 'operation', 'plan', 'preview'] as const)('rejects forged or reassigned %s', async field => {
    const value = await authorityFixture();
    await withSource5WorkflowLease(value.project, async lease => {
      const binding = { ...value, projectRoot: value.project, lease, storage: value.options };
      if (field === 'lease' || field === 'context' || field === 'preview') {
        await expect(issueSource5WorkflowApproval({ ...binding,
          ...(field === 'lease' ? { lease: { assertHeld: async () => {} } } :
            field === 'context' ? { context: { records: value.context.records } } : { previewFingerprint: '../other' }) },
        value.now)).rejects.toThrow();
        return;
      }
      await issueSource5WorkflowApproval(binding, value.now);
      const token = await restoreSource5WorkflowAuthority(binding, value.now);
      await expect(assertSource5WorkflowAuthority({
        authority: field === 'token' ? { kind: 'source5-workflow-issued-authority' } : token,
        projectRoot: field === 'root' ? value.root : value.project,
        plan: field === 'plan' ? { ...value.plan, expiresAt: '2026-09-03T00:00:00.000Z' } : value.plan,
        operation: field === 'operation' ? { ...value.operation, destination: { type: 'local', identity: 'other' } } : value.operation,
        now: value.now, write: true
      })).rejects.toThrow(/authority/);
    });
  });

  it('refuses a formerly valid token after its original lease ends', async () => {
    const value = await authorityFixture();
    let token: Source5WorkflowAuthority | undefined;
    await withSource5WorkflowLease(value.project, async lease => {
      const binding = { ...value, projectRoot: value.project, lease, storage: value.options };
      await issueSource5WorkflowApproval(binding, value.now);
      token = await restoreSource5WorkflowAuthority(binding, value.now);
    });
    await expect(assertSource5WorkflowAuthority({ authority: token!, projectRoot: value.project,
      plan: value.plan, operation: value.operation, now: value.now, write: true })).rejects.toThrow();
  });

  it.each(['control-anchor', 'control-project-key', 'coherent-foreign-anchor'] as const)(
    'rejects coherently rebuilt plan/approval/preview scope for %s', async variant => {
      const foreign = 'local:22222222-2222-4222-8222-222222222222';
      const value = await authorityFixture(variant === 'control-anchor' ? { controlAnchor: foreign } :
        variant === 'control-project-key' ? { controlProjectKey: 'f'.repeat(64) } :
          { controlAnchor: foreign, bindingAnchor: foreign });
      value.context.records.readPlan(value.plan, { approvals: [value.approval] });
      expect(source5PreviewFingerprint(value.project, value.plan)).toBe(value.previewFingerprint);
      await withSource5WorkflowLease(value.project, async lease => {
        const binding = { ...value, projectRoot: value.project, lease, storage: value.options };
        await expect(issueSource5WorkflowApproval(binding, value.now)).rejects.toThrow(/approval|scope|anchor|current5/);
        await expect(restoreSource5WorkflowAuthority(binding, value.now)).rejects.toThrow(/approval|scope|anchor|current5/);
      });
    });

  it.each(['changed-anchor', 'missing-state', 'same-anchor-state-drift'] as const)('blocks %s at both restore and assertion without rewriting original authority', async variant => {
    const value = await authorityFixture();
    await withSource5WorkflowLease(value.project, async lease => {
      const binding = { ...value, projectRoot: value.project, lease, storage: value.options };
      await issueSource5WorkflowApproval(binding, value.now);
      const token = await restoreSource5WorkflowAuthority(binding, value.now);
      const store = createWorkflowSource5ControlStore(value.project, value.options);
      const authorityBefore = await store.read('approval', canonicalSha256({
        schemaVersion: 1, kind: 'liftoff-source5-workflow-approval', projectRoot: value.project,
        repositoryAnchor: value.repositoryAnchor, identity: value.context.records.identity, phaseId: value.plan.phaseId,
        graphHash: value.plan.graphHash, previewFingerprint: value.previewFingerprint,
        envelopeHash: source5ApprovalHash(value.context, value.approval), envelope: value.approval,
        operationDigests: value.plan.operations.map(operation => canonicalSha256(operation)),
        savedPlanDigest: canonicalSha256(value.plan), planDigest: value.plan.planDigest
      }));
      expect(authorityBefore).not.toBeNull();
      if (variant === 'changed-anchor') await value.write(['governance', 'activation-state.json'],
        canonicalJson(value.context.records.createInitialState({
          repository: { ...value.state.repository, id: 'local:22222222-2222-4222-8222-222222222222' },
          applicability: value.state.applicability, createdAt: value.state.createdAt
        })));
      else if (variant === 'missing-state') await unlink(path.join(value.project, 'governance', 'activation-state.json'));
      else await value.write(['governance', 'activation-state.json'], canonicalJson(value.context.records.createInitialState({
        repository: value.state.repository, applicability: value.state.applicability, createdAt: '2026-09-01T12:01:00.000Z'
      })));
      await expect(issueSource5WorkflowApproval(binding, value.now)).rejects.toThrow(/scope|anchor/);
      await expect(restoreSource5WorkflowAuthority(binding, value.now)).rejects.toThrow(/scope|anchor/);
      await expect(assertSource5WorkflowAuthority({ authority: token, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: value.now, write: true })).rejects.toThrow(/scope|anchor/);
      await expect(assertSource5WorkflowAuthority({ authority: token, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: value.now, write: false })).rejects.toThrow(/scope|anchor/);
      expect(canonicalSha256(JSON.parse((await readFile(authorityBefore!.path)).toString('utf8')))).toBe(authorityBefore!.rawDigest);
      await value.write(['governance', 'activation-state.json'], canonicalJson(value.state));
      const resumed = await restoreSource5WorkflowAuthority(binding, value.now);
      await assertSource5WorkflowAuthority({ authority: resumed, projectRoot: value.project, plan: value.plan,
        operation: value.operation, now: value.now, write: true });
    });
  });
});
