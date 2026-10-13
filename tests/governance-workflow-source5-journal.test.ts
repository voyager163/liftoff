import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { nodeUpdatePreviewFileSystem, workflowSource5ControlLimits } from '../src/adapters/filesystem/update-previews.js';
import { openSource5WorkflowJournal } from '../src/governance-activation/workflow-source5-journal.js';
import {
  issueSource5WorkflowApproval, restoreSource5WorkflowAuthority, source5WorkflowAuthorityValue,
  source5WorkflowOriginalPlanValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { source5WorkflowOwnership } from '../src/governance-activation/workflow-source5-ownership.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import { measureSource5WorkflowStorageInventory, source5MaximumStorageKeys } from '../src/governance-activation/workflow-source5-storage-inventory.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const value = await workflowSource5JournalFixture(); roots.push(value.root);
  await sealReview(value);
  return value;
}
async function sealReview(value: ReturnType<Awaited<ReturnType<typeof workflowSource5JournalFixture>>['review']>) {
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  return value;
}
const manifestKey = (key: string) => canonicalSha256({ kind: 'workflow-source5-storage-inventory-key.v1', controlKey: key });
const opKey = (key: string, operation: unknown) => canonicalSha256({ controlKey: key, operationDigest: canonicalSha256(operation) });
const eventKey = (key: string, operation: unknown, stage: string) =>
  canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey: opKey(key, operation), stage });
async function publishedComponent(value: Awaited<ReturnType<typeof fixture>>, lease: ProjectMutationLease) {
  const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
  const base = { bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest };
  const commitSha = 'c'.repeat(40), treeSha = 'b'.repeat(40);
  await journal.record(value.operation, 'publication-writing', { ...base, stage: 'writing' });
  await journal.record(value.operation, 'publication-commit-intent', base);
  await journal.record(value.operation, 'publication-commit-observed', { ...base, commitSha });
  await journal.record(value.operation, 'publication-committed', { ...base, stage: 'committed', commitSha });
  await journal.record(value.operation, 'publication-push-intent', { ...base, stage: 'push-intent', commitSha });
  await journal.record(value.operation, 'publication-push-accepted', { ...base, commitSha, outputDigest: canonicalSha256('fixture-only') });
  await journal.record(value.operation, 'publication-published', { ...base, stage: 'published', commitSha });
  const observed = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
    ref: value.binding.ref, parentSha: value.binding.parentSha, commitSha, treeSha,
    files: value.binding.files.map(({ path, digest }) => ({ path, digest })) };
  const proof = { kind: 'workflow-source-publication.v1', ...observed, bindingDigest: base.bindingDigest,
    observedAt: value.now.toISOString(), observationDigest: canonicalSha256(observed) };
  await journal.record(value.operation, 'component-completed', { ...base, proof });
  return { journal, proof, origin: { planKey: value.control.controlKey, proofKey: journal.proofKey(value.operation),
    publicationDigest: canonicalSha256(proof), commitSha, treeSha } };
}
function proofBinding(value: Awaited<ReturnType<typeof fixture>>) {
  return { repository: value.binding.repository, repositoryId: value.binding.repositoryId, family: 'develop',
    ref: 'develop', sourceSha: 'c'.repeat(40), treeSha: 'b'.repeat(40), executionRef: `liftoff-execution-${'c'.repeat(40)}`,
    workflowPath: value.binding.files[0]!.path, workflowDigest: value.binding.files[0]!.digest,
    contexts: [{ name: 'fixture-context', validationStep: 'Validate fixture' }], mode: 'green', tokenSuppressedTrigger: true };
}

describe('full closed source5 journal inventory and retained truth', () => {
  it.each([true, false])('requires a separately sealed original review before opening with initialize=%s', async initialize => {
    const value = await workflowSource5JournalFixture(); roots.push(value.root);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await expect(openSource5WorkflowJournal({ ...value, lease, initialize })).rejects.toThrow(/separately sealed original/);
      expect(await value.store.read('plan', value.control.controlKey)).toBeNull();
      expect(await value.store.read('journal', value.control.controlKey)).toBeNull();
      expect(await value.store.read('proof', manifestKey(value.control.controlKey))).toBeNull();
    });
  });

  it.each([true, false])('cannot revive retained authority/ownership after only its original plan is lost, initialize=%s', async initialize => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await issueSource5WorkflowApproval({ ...value, lease }, value.now);
      await expect(restoreSource5WorkflowAuthority({ ...value, lease }, value.now)).resolves.toEqual({
        kind: 'source5-workflow-issued-authority'
      });
      const owner = await source5WorkflowOwnership({ ...value, lease, operation: value.operation });
      const entries = [
        { namespace: 'approval' as const, key: canonicalSha256(source5WorkflowAuthorityValue({ ...value, lease })) },
        { namespace: 'operation' as const, key: owner.entryKey },
        { namespace: 'proof' as const, key: owner.inventory.manifestKey },
        ...owner.inventory.proofKeys.map(key => ({ namespace: 'proof' as const, key }))
      ];
      const retained = await Promise.all(entries.map(async entry => {
        const record = await value.store.read(entry.namespace, entry.key);
        return { ...entry, bytes: record ? await readFile(record.path) : null };
      }));
      expect(retained.filter(entry => entry.bytes)).toHaveLength(4);
      const original = (await value.store.read('plan', value.control.controlKey))!;
      await unlink(original.path);
      await expect(issueSource5WorkflowApproval({ ...value, lease }, value.now)).rejects.toThrow(/cannot create or recreate/);
      await expect(openSource5WorkflowJournal({ ...value, lease, initialize })).rejects.toThrow(/separately sealed original/);
      await expect(restoreSource5WorkflowAuthority({ ...value, lease }, value.now)).rejects.toThrow(/sealed exact original/);
      expect(await value.store.read('plan', value.control.controlKey)).toBeNull();
      expect(await value.store.read('journal', value.control.controlKey)).toBeNull();
      expect(await value.store.read('proof', manifestKey(value.control.controlKey))).toBeNull();
      for (const entry of retained) {
        const record = await value.store.read(entry.namespace, entry.key);
        expect(record ? await readFile(record.path) : null).toEqual(entry.bytes);
      }
    });
  });

  it('keeps legitimate separately sealed fresh review bytes unchanged across journal initialization and issuance', async () => {
    const value = await fixture();
    const original = (await value.store.read('plan', value.control.controlKey))!, bytes = await readFile(original.path);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      await issueSource5WorkflowApproval({ ...value, lease }, value.now);
      await expect(restoreSource5WorkflowAuthority({ ...value, lease }, value.now)).resolves.toEqual({
        kind: 'source5-workflow-issued-authority'
      });
      await journal.assertInventory();
      expect(await value.store.read('plan', value.control.controlKey)).toEqual(original);
      expect(await readFile(original.path)).toEqual(bytes);
    });
  });

  it.each(['review-only', 'issued'] as const)('never writes missing observation ledgers for %s or poisons later explicit initialization', async mode => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      if (mode === 'issued') await issueSource5WorkflowApproval({ ...value, lease }, value.now);
      const owner = await source5WorkflowOwnership({ ...value, lease, operation: value.operation });
      const keys = [
        { namespace: 'plan' as const, key: value.control.controlKey },
        { namespace: 'approval' as const, key: canonicalSha256(source5WorkflowAuthorityValue({ ...value, lease })) },
        { namespace: 'journal' as const, key: value.control.controlKey },
        { namespace: 'operation' as const, key: opKey(value.control.controlKey, value.operation) },
        { namespace: 'proof' as const, key: manifestKey(value.control.controlKey) },
        { namespace: 'proof' as const, key: canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: value.control.controlKey }) },
        { namespace: 'proof' as const, key: canonicalSha256({ kind: 'workflow-source5-finalization-key.v1', controlKey: value.control.controlKey }) },
        ...(await owner.measureInventory()).objects.map(object => ({
          namespace: object.namespace === 'operation' ? 'operation' as const : 'proof' as const, key: object.key
        }))
      ];
      const snapshot = async () => Promise.all(keys.map(async entry => {
        const record = await value.store.read(entry.namespace, entry.key);
        return { ...entry, bytes: record ? await readFile(record.path) : null };
      }));
      const before = await snapshot();
      expect(before.filter(entry => entry.bytes)).toHaveLength(mode === 'issued' ? 5 : 1);
      await expect(openSource5WorkflowJournal({ ...value, lease, initialize: false })).rejects.toThrow(/index is missing/);
      expect(await snapshot()).toEqual(before);
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      await journal.assertInventory();
      for (const entry of before.filter(entry => entry.bytes)) {
        const record = (await value.store.read(entry.namespace, entry.key))!;
        expect(await readFile(record.path)).toEqual(entry.bytes);
      }
      const restored = await openSource5WorkflowJournal({ ...value, lease, initialize: false });
      await restored.assertInventory();
    });
  });

  it('requires retained remaining-only original ancestry without resealing it or changing prior ownership', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease);
      const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
        sourceSha: source.origin.commitSha, treeSha: source.origin.treeSha, executionRef: `liftoff-execution-${source.origin.commitSha}` };
      const effects = [{ action: 'github.workflow-source.bind-execution-ref' as const, binding }];
      const reviewed = await sealReview(value.review({ origin: source.origin, effects }));
      const priorJournal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
      await issueSource5WorkflowApproval({ ...reviewed, lease }, reviewed.now);
      const priorOwner = await source5WorkflowOwnership({ ...reviewed, lease, operation: reviewed.operation });
      const pointer = (await value.store.read('operation', priorOwner.entryKey))!, pointerBytes = await readFile(pointer.path);
      const continuation = await sealReview(value.review({ origin: source.origin, effects, remainingFrom: {
        planKey: reviewed.control.controlKey, operationDigests: [canonicalSha256(reviewed.operation)]
      } }));
      const original = (await value.store.read('plan', reviewed.control.controlKey))!, originalBytes = await readFile(original.path);
      await unlink(original.path);
      await expect(openSource5WorkflowJournal({ ...continuation, lease, initialize: true })).rejects.toThrow(/independently sealed exact original/);
      await expect(openSource5WorkflowJournal({ ...reviewed, lease, initialize: true })).rejects.toThrow(/separately sealed original/);
      expect(await value.store.read('plan', reviewed.control.controlKey)).toBeNull();
      expect(await value.store.read('journal', continuation.control.controlKey)).toBeNull();
      expect(await value.store.read('proof', manifestKey(continuation.control.controlKey))).toBeNull();
      expect(await readFile(pointer.path)).toEqual(pointerBytes);
      await writeFile(original.path, originalBytes, { mode: 0o600 });
      await priorJournal.assertInventory();
      const next = await openSource5WorkflowJournal({ ...continuation, lease, initialize: true });
      await next.assertInventory();
      expect(await readFile(original.path)).toEqual(originalBytes);
      expect(await readFile(pointer.path)).toEqual(pointerBytes);
    });
  });

  it('reserves original/issuer/authority/index/owner/event/recovery/finalization keys before an intent and restores exact immutable truth', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const record = (await value.store.read('proof', manifestKey(value.control.controlKey)))!;
      const inventory = record.value as { objects: { namespace: 'plan' | 'approval' | 'journal' | 'operation' | 'proof';
        key: string; maximumEncodedBytes: number; maximumRevisions: number }[]; maximumEncodedFootprint: number };
      expect(inventory.objects).toHaveLength(147);
      expect(new Set(inventory.objects.map(object => `${object.namespace}:${object.key}`)).size).toBe(inventory.objects.length);
      expect(inventory.maximumEncodedFootprint).toBe(inventory.objects.reduce((sum, object) =>
        sum + object.maximumEncodedBytes * object.maximumRevisions, 0));
      for (const object of inventory.objects) expect(object.maximumEncodedBytes).toBeLessThanOrEqual(workflowSource5ControlLimits[object.namespace]);
      expect(inventory.objects.find(object => object.key === manifestKey(value.control.controlKey))!.maximumEncodedBytes).toBe(record.encodedBytes);
      const issuer = await value.store.issuerDescription();
      expect(inventory.objects).toContainEqual(issuer);
      await expect(value.store.save('approval', issuer.key, { denied: true }, null)).rejects.toThrow(/caller-selected/);
      await issueSource5WorkflowApproval({ ...value, lease }, value.now);
      await journal.record(value.operation, 'publication-writing', {
        bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest, stage: 'writing'
      });
      expect(journal.wasAttempted(value.operation)).toBe(true);
      await journal.assertInventory();
    });
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: false });
      expect(journal.wasAttempted(value.operation)).toBe(true);
      expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['publication-writing']);
    });
  });

  it.each(['before-pointer', 'after-pointer'] as const)('preserves actual immutable intent after %s save confirmation fails', async fault => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const pointerKey = opKey(value.control.controlKey, value.operation);
      const fileSystem = { ...nodeUpdatePreviewFileSystem, async replaceFile(source: string, target: string) {
        const isPointer = target.endsWith(`-${pointerKey}.json`);
        if (isPointer && fault === 'before-pointer') throw new Error('isolated cursor rejection');
        await nodeUpdatePreviewFileSystem.replaceFile(source, target);
        if (isPointer && fault === 'after-pointer') throw new Error('isolated cursor confirmation loss');
      } };
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: false, storage: { ...value.storage, fileSystem } });
      await expect(journal.record(value.operation, 'publication-writing', {
        bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest, stage: 'writing'
      })).rejects.toThrow();
      expect(journal.wasAttempted(value.operation)).toBe(true);
    });
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: false });
      expect(journal.wasAttempted(value.operation)).toBe(true);
      expect(await value.store.read('proof', eventKey(value.control.controlKey, value.operation, 'publication-writing'))).not.toBeNull();
    });
  });

  it.each(['manifest', 'index', 'reservation'] as const)('blocks lost %s at restart without recreating permission', async lost => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const key = lost === 'manifest' ? manifestKey(value.control.controlKey) :
        lost === 'index' ? value.control.controlKey : canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: value.control.controlKey });
      const record = (await value.store.read(lost === 'index' ? 'journal' : 'proof', key))!;
      await unlink(record.path);
      await expect(journal.assertInventory()).rejects.toThrow();
      await expect(openSource5WorkflowJournal({ ...value, lease, initialize: true })).rejects.toThrow();
    });
  });

  it('never recreates a wholly lost reservation/index/manifest around retained intent', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      await journal.record(value.operation, 'publication-writing', {
        bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest, stage: 'writing'
      });
      const entries = [{ namespace: 'proof' as const, key: manifestKey(value.control.controlKey) },
        { namespace: 'journal' as const, key: value.control.controlKey },
        { namespace: 'proof' as const, key: canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: value.control.controlKey }) }];
      for (const entry of entries) await unlink((await value.store.read(entry.namespace, entry.key))!.path);
      await expect(openSource5WorkflowJournal({ ...value, lease, initialize: true })).rejects.toThrow(/progress pointer/);
      expect(await value.store.read('journal', value.control.controlKey)).toBeNull();
      expect(await value.store.read('proof', eventKey(value.control.controlKey, value.operation, 'publication-writing'))).not.toBeNull();
    });
  });

  it('rejects a coherent resealed foreign key inventory and preserves every existing event', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const key = manifestKey(value.control.controlKey), record = (await value.store.read('proof', key))!, original = await readFile(record.path);
      const raw = record.value as { objects: { key: string }[] };
      raw.objects[0]!.key = 'f'.repeat(64);
      await unlink(record.path); await value.store.save('proof', key, raw, null);
      await expect(journal.record(value.operation, 'publication-writing', {
        bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest, stage: 'writing'
      })).rejects.toThrow(/manifest/);
      expect(await value.store.read('proof', eventKey(value.control.controlKey, value.operation, 'publication-writing'))).toBeNull();
      await writeFile(record.path, original, { mode: 0o600 });
      await journal.assertInventory();
    });
  });

  it.each([source5MaximumStorageKeys - 1, source5MaximumStorageKeys, source5MaximumStorageKeys + 1])(
    'separately measures fixed concrete key cardinality %i including its self object', async count => {
      const value = await fixture(), key = canonicalSha256('cardinality');
      const objects = Array.from({ length: count - 1 }, (_, index) => ({ namespace: 'proof' as const,
        key: canonicalSha256(index), maximumEncodedBytes: 1024, maximumRevisions: 1 }));
      if (count > source5MaximumStorageKeys) await expect(measureSource5WorkflowStorageInventory(value.store, key,
        { schemaVersion: 1, controlKey: value.control.controlKey }, objects)).rejects.toThrow(/bound/);
      else {
        const manifest = await measureSource5WorkflowStorageInventory(value.store, key, { schemaVersion: 1, controlKey: value.control.controlKey }, objects);
        expect(manifest.value.objects).toHaveLength(count);
        expect(await value.store.measure('proof', key, manifest.value)).toBeLessThanOrEqual(16 * 1024 * 1024);
      }
    });

  it('independently binds source B to exact immutable A plan/component/commit/tree and detects lost dependencies', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease);
      const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
        sourceSha: source.origin.commitSha, treeSha: source.origin.treeSha, executionRef: `liftoff-execution-${source.origin.commitSha}` };
      const reviewed = await sealReview(value.review({ origin: source.origin, effects: [{ action: 'github.workflow-source.bind-execution-ref', binding }] }));
      const journal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
      const full = (await value.store.read('proof', manifestKey(reviewed.control.controlKey)))!.value as {
        readDependencies: { namespace: 'plan' | 'proof' | 'operation' | 'journal'; key: string; rawDigest: string; encodedBytes: number }[] };
      expect(full.readDependencies).toHaveLength(13);
      expect(full.readDependencies.some(dependency => dependency.key === source.origin.proofKey)).toBe(true);
      await journal.assertInventory();
      const record = (await value.store.read('proof', source.origin.proofKey))!, bytes = await readFile(record.path);
      await unlink(record.path);
      await expect(journal.assertInventory()).rejects.toThrow(/publication dependency/);
      await expect(openSource5WorkflowJournal({ ...reviewed, lease, initialize: false })).rejects.toThrow(/immutable/);
      await writeFile(record.path, bytes, { mode: 0o600 });
      await journal.assertInventory();
    });
  });

  it('fits every actual publication pointer/event and blocks a coherently saved excessive cursor revision', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease);
      const inventory = (await value.store.read('proof', manifestKey(value.control.controlKey)))!.value as {
        objects: { namespace: string; key: string; maximumEncodedBytes: number; maximumRevisions: number }[] };
      const pointer = (await value.store.read('operation', opKey(value.control.controlKey, value.operation)))!;
      const bound = inventory.objects.find(bound => bound.namespace === 'operation' && bound.key === opKey(value.control.controlKey, value.operation))!;
      expect(pointer.revision).toBe(8);
      expect(pointer.revision).toBe(bound.maximumRevisions);
      expect(pointer.encodedBytes).toBeLessThanOrEqual(bound.maximumEncodedBytes);
      const events = await source.journal.events(value.operation);
      for (const event of events) {
        const key = eventKey(value.control.controlKey, value.operation, event.stage);
        const actual = (await value.store.read('proof', key))!;
        expect(actual.encodedBytes).toBeLessThanOrEqual(inventory.objects.find(bound => bound.namespace === 'proof' && bound.key === key)!.maximumEncodedBytes);
      }
      await value.store.save('operation', opKey(value.control.controlKey, value.operation), pointer.value, pointer.rawDigest);
      await expect(source.journal.events(value.operation)).rejects.toThrow(/reservation/);
      expect(await value.store.read('proof', source.origin.proofKey)).not.toBeNull();
    });
  });

  it.each(['manifest', 'index', 'reservation'] as const)('requires intact original A %s before a newly reviewed B ledger', async lost => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease);
      const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
        sourceSha: source.origin.commitSha, treeSha: source.origin.treeSha, executionRef: `liftoff-execution-${source.origin.commitSha}` };
      const reviewed = await sealReview(value.review({ origin: source.origin, effects: [{ action: 'github.workflow-source.bind-execution-ref', binding }] }));
      const key = lost === 'manifest' ? manifestKey(value.control.controlKey) : lost === 'index' ? value.control.controlKey :
        canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: value.control.controlKey });
      await unlink((await value.store.read(lost === 'index' ? 'journal' : 'proof', key))!.path);
      await expect(openSource5WorkflowJournal({ ...reviewed, lease, initialize: true })).rejects.toThrow(/complete manifest/);
      expect(await value.store.read('journal', reviewed.control.controlKey)).toBeNull();
      expect(await value.store.read('proof', source.origin.proofKey)).not.toBeNull();
    });
  });

  it('rejects a restart clock before its reviewed invocation without losing prior intent', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const base = { bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest };
      await journal.record(value.operation, 'publication-writing', { ...base, stage: 'writing' });
      const earlier = await openSource5WorkflowJournal({ ...value, lease, initialize: false, now: new Date('2026-09-01T11:59:59.000Z') });
      await expect(earlier.record(value.operation, 'publication-commit-intent', base)).rejects.toThrow(/precede/);
      expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['publication-writing']);
    });
  });

  it.each(['proofKey', 'publicationDigest', 'commitSha', 'treeSha'] as const)(
    'rejects coherently reapproved false original %s without source B permission', async field => {
      const value = await fixture();
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const source = await publishedComponent(value, lease), origin = { ...source.origin,
          [field]: 'f'.repeat(field.endsWith('Sha') ? 40 : 64) };
        const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
          sourceSha: origin.commitSha, treeSha: origin.treeSha, executionRef: `liftoff-execution-${origin.commitSha}` };
        const reviewed = await sealReview(value.review({ origin, effects: [{ action: 'github.workflow-source.bind-execution-ref', binding }] }));
        await expect(openSource5WorkflowJournal({ ...reviewed, lease, initialize: true })).rejects.toThrow(/original immutable/);
        expect(await value.store.read('journal', reviewed.control.controlKey)).toBeNull();
        expect((await source.journal.events(value.operation)).at(-1)?.data.proof).toEqual(source.proof);
      });
    });

  it('retains accepted/terminal provider identity across oversized completion rejection and restart', async () => {
    const seed = await fixture(), value = { ...seed, ...await sealReview(seed.review({ phaseId: 'workflow-source-ready' })) };
    let reviewed: ReturnType<typeof value.review>;
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease), binding = proofBinding(value);
      reviewed = await sealReview(value.review({ phaseId: 'dev-proof', origin: source.origin, effects: [{ action: 'github.checks.dev-proof', binding }] }));
      const journal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
      const base = { bindingDigest: canonicalSha256(binding), planDigest: reviewed.plan.planDigest,
        workflowId: 19, dispatchedAt: reviewed.now.toISOString() };
      await journal.record(reviewed.operation, 'dispatch-intent', { ...base, stage: 'dispatch-intent' });
      await journal.record(reviewed.operation, 'dispatch-accepted', { ...base, stage: 'accepted', runId: 73 });
      await journal.record(reviewed.operation, 'dispatch-terminal', { ...base, stage: 'terminal', runId: 73,
        terminalConclusion: 'success', terminalConclusionDigest: canonicalSha256({ conclusion: 'success' }) });
      const before = await value.store.read('proof', eventKey(reviewed.control.controlKey, reviewed.operation, 'dispatch-terminal'));
      const files = [
        { path: `governance/plans/${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.plan), beforeHash: null },
        { path: `governance/approvals/source5-${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.approval), beforeHash: null },
        { path: `governance/plans/${source.origin.planKey}.json`, content: canonicalJson(value.plan), beforeHash: null },
        { path: `governance/approvals/source5-${source.origin.planKey}.json`, content: canonicalJson(value.approval), beforeHash: null },
        { path: `governance/evidence/source5-${reviewed.control.controlKey}.json`, content: 'x'.repeat(100000), beforeHash: null },
        { path: 'governance/activation-state.json', content: canonicalJson(value.installed.state),
          beforeHash: canonicalSha256(value.installed.state) }
      ];
      await expect(journal.saveFinalization({ kind: 'workflow-source5-finalization', files })).rejects.toThrow(/reserved/);
      expect(await value.store.read('proof', eventKey(reviewed.control.controlKey, reviewed.operation, 'dispatch-terminal'))).toEqual(before);
      expect(await journal.readFinalization()).toBeNull();
    });
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const journal = await openSource5WorkflowJournal({ ...reviewed!, lease, initialize: false });
      expect(journal.wasAttempted(reviewed!.operation)).toBe(true);
      const terminal = (await journal.events(reviewed!.operation)).at(-1)!;
      expect(terminal.data.runId).toBe(73); expect(terminal.data.terminalConclusion).toBe('success');
    });
  });

  it('closes original component fields and observation time before retaining a valid format-only proof', async () => {
    const seed = await fixture(), value = { ...seed, ...await sealReview(seed.review({ phaseId: 'workflow-source-ready' })) };
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease), binding = proofBinding(value);
      const reviewed = await sealReview(value.review({ phaseId: 'dev-proof', origin: source.origin, effects: [{ action: 'github.checks.dev-proof', binding }] }));
      const journal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
      const base = { bindingDigest: canonicalSha256(binding), planDigest: reviewed.plan.planDigest,
        workflowId: 19, dispatchedAt: reviewed.now.toISOString() };
      await journal.record(reviewed.operation, 'dispatch-intent', { ...base, stage: 'dispatch-intent' });
      await journal.record(reviewed.operation, 'dispatch-accepted', { ...base, stage: 'accepted', runId: 73 });
      await journal.record(reviewed.operation, 'dispatch-terminal', { ...base, stage: 'terminal', runId: 73,
        terminalConclusion: 'success', terminalConclusionDigest: canonicalSha256({ conclusion: 'success' }) });
      const admissionBinding = { repository: binding.repository, repositoryId: binding.repositoryId,
        sourceSha: binding.sourceSha, treeSha: binding.treeSha, executionRef: binding.executionRef };
      const execution = { kind: 'immutable-workflow-execution-ref.v1', binding: admissionBinding, protectingRulesetIds: [23],
        barrierDigest: canonicalSha256('format-only-barrier'), providerAdmissionDigest: canonicalSha256('format-only-admission'),
        observationDigest: canonicalSha256('format-only-observation') };
      const contexts = [{ name: 'fixture-context', jobId: 11, checkRunId: 12, applicationId: 13,
        conclusion: 'success', validationStep: 'Validate fixture' }];
      const proof = { kind: 'workflow-context-proof.v1', binding, ...base, runId: 73, attempt: 1, conclusion: 'success',
        contexts, observedAt: reviewed.now.toISOString(), executionAdmission: execution,
        observationDigest: canonicalSha256({ runId: 73, workflowId: 19, attempt: 1, conclusion: 'success', contexts, executionAdmission: execution }) };
      const malformed = [
        { ...proof, extra: 'unapproved' }, { ...proof, observedAt: 'invalid' },
        { ...proof, observedAt: '2026-09-01T12:04:59.999Z' },
        { ...proof, contexts: [{ ...contexts[0]!, extra: 'unapproved' }] },
        { ...proof, executionAdmission: { ...execution, extra: 'unapproved' } }
      ];
      for (const candidate of malformed) {
        await expect(journal.record(reviewed.operation, 'component-completed', {
          bindingDigest: base.bindingDigest, planDigest: base.planDigest, proof: candidate })).rejects.toThrow(/closed workflow/);
        expect(await value.store.read('proof', journal.proofKey(reviewed.operation))).toBeNull();
      }
      await journal.record(reviewed.operation, 'component-completed', {
        bindingDigest: base.bindingDigest, planDigest: base.planDigest, proof });
      expect((await journal.events(reviewed.operation)).at(-1)!.data.proof).toEqual(proof);
    });
  });

  it('validates exact modern final metadata, rejects unrelated state, and retains the immutable completion through rejected saves', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publishedComponent(value, lease);
      const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
        sourceSha: source.origin.commitSha, treeSha: source.origin.treeSha, executionRef: `liftoff-execution-${source.origin.commitSha}` };
      const runner = { repository: binding.repository, repositoryId: binding.repositoryId, groupId: 17,
        groupName: 'isolated-format-fixture', networkConfigurationId: 'isolated-format-network',
        beforeWorkflows: [], afterWorkflows: [`${binding.repository}/${value.binding.files[0]!.path}@refs/tags/${binding.executionRef}`] };
      const reviewed = await sealReview(value.review({ origin: source.origin, effects: [
        { action: 'github.workflow-source.bind-execution-ref', binding }, { action: 'github.workflow-source.admit-reviewed', binding: runner }] }));
      const journal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
      const execution = { kind: 'immutable-workflow-execution-ref.v1', binding, protectingRulesetIds: [23],
        barrierDigest: canonicalSha256('format-only-barrier'), providerAdmissionDigest: canonicalSha256('format-only-admission'),
        observationDigest: canonicalSha256('format-only-observation') };
      const runnerProof = { bindingDigest: canonicalSha256(runner), observationDigest: canonicalSha256({
        repositoryId: runner.repositoryId, groupId: runner.groupId, networkConfigurationId: runner.networkConfigurationId,
        selectedWorkflows: [...runner.afterWorkflows].sort() }) };
      const operations = reviewed.plan.operations.slice(0, 2);
      await journal.record(operations[0]!, 'component-completed', { bindingDigest: canonicalSha256(binding),
        planDigest: reviewed.plan.planDigest, proof: execution });
      await journal.record(operations[1]!, 'component-completed', { bindingDigest: canonicalSha256(runner),
        planDigest: reviewed.plan.planDigest, proof: runnerProof });
      const phase = value.context.records.graph.phases.find(phase => phase.id === reviewed.plan.phaseId)!;
      const records = { plans: [value.plan, reviewed.plan], approvals: [value.approval, reviewed.approval], evidence: [] };
      const evidence = value.context.records.createEvidence({ plan: reviewed.plan, evidenceId: `source5-${reviewed.control.controlKey}`,
        repositoryId: value.repositoryAnchor, producedAt: reviewed.now.toISOString(), producer: 'record-format-only-fixture',
        result: 'verified', payload: { kind: `${reviewed.plan.phaseId}.v2`, publication: source.proof,
          executionAdmission: execution, runnerAdmission: runnerProof },
        liveReadback: phase.evidence.liveReadbackProviders.map(provider => ({
          schemaVersion: 4, identity: reviewed.plan.identity, phaseGraphHash: reviewed.plan.graphHash,
          repositoryId: value.repositoryAnchor, phaseId: reviewed.plan.phaseId, baselineSha: reviewed.plan.baselineDigest,
          inputDigest: reviewed.plan.inputDigest, transition: { phaseId: reviewed.plan.phaseId,
            baselineSha: reviewed.plan.baselineDigest, inputDigest: reviewed.plan.inputDigest, transitionDigest: reviewed.plan.transitionDigest },
          observedAt: reviewed.now.toISOString(), provider, resourceId: 'record-format-only-fixture', resourceType: 'repository',
          sourceDigest: canonicalSha256(source.proof), readbackDigest: canonicalSha256(execution), matches: true
        }))
      }, records);
      const state = value.context.records.stateAfterOutcome({ state: value.installed.state!, plan: reviewed.plan, phaseState: 'verified',
        updatedAt: reviewed.now.toISOString(), evidenceId: evidence.evidenceId }, { ...records, evidence: [evidence] });
      const files = [
        { path: `governance/plans/${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.plan), beforeHash: null },
        { path: `governance/approvals/source5-${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.approval), beforeHash: null },
        { path: `governance/plans/${source.origin.planKey}.json`, content: canonicalJson(value.plan), beforeHash: null },
        { path: `governance/approvals/source5-${source.origin.planKey}.json`, content: canonicalJson(value.approval), beforeHash: null },
        { path: `governance/evidence/source5-${reviewed.control.controlKey}.json`, content: canonicalJson(evidence), beforeHash: null },
        { path: 'governance/activation-state.json', content: canonicalJson(state), beforeHash: canonicalSha256(value.installed.state) }
      ];
      const altered = structuredClone(state); altered.phases['phase-0-complete'].blockers.push('unrelated rewrite');
      await expect(journal.saveFinalization({ kind: 'workflow-source5-finalization', files: files.map(file =>
        file.path === 'governance/activation-state.json' ? { ...file, content: canonicalJson(altered) } : file) })).rejects.toThrow(/unrelated/);
      expect(await journal.readFinalization()).toBeNull();
      const completionKey = await journal.saveFinalization({ kind: 'workflow-source5-finalization', files });
      const complete = (await journal.readFinalization())!, originalBytes = await readFile(complete.path);
      await expect(journal.saveFinalization({ kind: 'workflow-source5-finalization', files: files.map(file =>
        file.path.includes('/evidence/') ? { ...file, content: `${file.content} ` } : file) })).rejects.toThrow(/canonical/);
      expect((await readFile(complete.path)).equals(originalBytes)).toBe(true);
      await expect(journal.markFinalized(complete.path)).rejects.toThrow(/original sealed/);
      await expect(journal.markFinalized(canonicalSha256({ kind: 'workflow-source5-finalization-key.v1',
        controlKey: reviewed.control.controlKey }))).rejects.toThrow(/independently observed/);
      for (const file of files) await value.installed.write(file.path.split('/'), file.content);
      await journal.markFinalized(completionKey);
      const index = (await value.store.read('journal', reviewed.control.controlKey))!;
      expect(index.revision).toBe(2);
      expect(index.value).toMatchObject({ status: 'finalized', finalProofKey: completionKey });
      await journal.markFinalized(completionKey);
      expect(await value.store.read('journal', reviewed.control.controlKey)).toEqual(index);
      expect((await readFile(complete.path)).equals(originalBytes)).toBe(true);
    });
  });
});
