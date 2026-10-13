import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createScopedUserLocalRecordStore, createWorkflowSource5ControlStore, nodeUpdatePreviewFileSystem,
  workflowSource5ControlLimits, workflowSource5ControlNamespaces, resolveUpdatePreviewLocation
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { plannedApprovalDestinations, plannedApprovalMutations, plannedApprovalResources } from '../src/domain/governance/activation/source-values.js';
import {
  assertSource5WorkflowAuthority, createSource5WorkflowContext, issueSource5WorkflowApproval,
  restoreSource5WorkflowAuthority, source5ApprovalHash, source5PreviewFingerprint, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import type { ModernPlanInput } from '../src/domain/governance/activation/modern-records.js';
import type { Source5WorkflowAuthority } from '../src/governance-activation/workflow-source5-authority.js';
import {
  source5WorkflowCheckpointOperation, source5WorkflowControlKey, source5WorkflowOperation
} from '../src/governance-activation/workflow-source5-operations.js';

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

async function authorityFixture() {
  const fixtureValue = await fixture(), installed = await writeModernInstalledProject(fixtureValue.project);
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
    repositoryAnchor: installed.state!.repository.id, projectKey: (await resolveUpdatePreviewLocation(fixtureValue.project, fixtureValue.options)).projectKey };
  const checkpoint = source5WorkflowCheckpointOperation({
    ...keyInput, schemaVersion: 1, kind: 'workflow-source5-control.v1', controlKey: source5WorkflowControlKey(keyInput),
    reviewKind: 'bound-source', remainingFrom: null,
    origin: { planKey: 'a'.repeat(64), proofKey: 'b'.repeat(64), publicationDigest: 'c'.repeat(64),
      commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) }
  });
  const operations = [operation, checkpoint], effects = operations.flatMap(operation => [operation, ...(operation.effects ?? [])]);
  const input: ModernPlanInput = {
    phaseId: id, createdAt: '2026-09-01T12:00:00.000Z', expiresAt: '2026-09-01T13:00:00.000Z', stateHash: null,
    baselineDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64),
    operations, noSecrets: true,
    configuration: { schemaVersion: 1, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
    approval: { gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: true,
        status: 'approval-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
    rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] }
  };
  const draft = api.createPlan(input);
  const approval = api.createApproval({ plan: draft, id: 'isolated-issued-review', approvedAt: input.createdAt,
    expiresAt: input.expiresAt, approver: 'isolated-fixture-human', resources: plannedApprovalResources(effects),
    destinations: plannedApprovalDestinations(effects), permissions: plannedApprovalMutations(effects),
    costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: [] });
  const hash = source5ApprovalHash(context, approval);
  const plan = api.createPlan({ ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash: hash,
    evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash: hash } } },
  { approvals: [approval] });
  return { ...fixtureValue, context, plan, approval, operation,
    now: new Date('2026-09-01T12:05:00.000Z'), repositoryAnchor: installed.state!.repository.id,
    previewFingerprint: source5PreviewFingerprint(fixtureValue.project, plan) };
}

describe('independently issued modern source5 workflow authority', () => {
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
});
