import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  nodeUpdatePreviewFileSystem, resolveUpdatePreviewLocation, workflowSource5ControlLimits
} from '../src/adapters/filesystem/update-previews.js';
import {
  assertSource5WorkflowJournal, openSource5WorkflowJournal, openSource5WorkflowFinalizationReader,
  inspectSource5WorkflowFinalization, reconcileSource5WorkflowFinalization
} from '../src/governance-activation/workflow-source5-journal.js';
import { withSource5WorkflowLease } from '../src/governance-activation/workflow-source5-context.js';
import { restoreSource5WorkflowAuthority } from '../src/governance-activation/workflow-source5-authority.js';
import { source5WorkflowOwnership } from '../src/governance-activation/workflow-source5-ownership.js';
import { issueSource5WorkflowApproval } from '../src/governance-activation/workflow-source5-authority.js';
import { source5WorkflowOriginalPlanValue } from '../src/governance-activation/workflow-source5-context.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';
import { workflowSource5FinalizationFixture } from './fixtures/workflow-source5-finalization.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import type { UpdatePreviewOptions } from '../src/adapters/filesystem/update-previews.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(remaining = false, sourceReady = false) {
  const seed = await workflowSource5JournalFixture();
  const value = sourceReady ? { ...seed, ...seed.review({ phaseId: 'workflow-source-ready' }) } : seed;
  roots.push(value.root);
  const f = await withSource5WorkflowLease(value.projectRoot, lease => workflowSource5FinalizationFixture(value, lease, remaining));
  const location = await resolveUpdatePreviewLocation(value.projectRoot, value.storage);
  const bytes = async () => Object.fromEntries(await Promise.all((await readdir(location.directory))
    .filter(name => name.endsWith('.json')).sort().map(async name => [name, await readFile(path.join(location.directory, name))] as const)));
  const open = (lease: ProjectMutationLease, storage: UpdatePreviewOptions = value.storage) =>
    openSource5WorkflowFinalizationReader({ projectRoot: value.projectRoot, context: value.context,
      plan: f.reviewed.plan, approval: f.reviewed.approval, lease, storage });
  const seal = () => withSource5WorkflowLease(value.projectRoot, async lease => {
    const journal = await openSource5WorkflowJournal({ ...f.reviewed, lease, initialize: false });
    return journal.saveFinalization({ kind: 'workflow-source5-finalization', files: f.files });
  });
  const retag = async (filePath: string, transform: (value: Record<string, unknown>) => void) => {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    const issuer = path.join(location.directory,
      `workflow-source5-approval-${location.projectKey}-${(await value.store.issuerDescription()).key}.json`);
    const secret = Buffer.from(JSON.parse(await readFile(issuer, 'utf8')).key as string, 'hex');
    delete raw.seal; transform(raw);
    await writeFile(filePath, canonicalJson({ ...raw,
      seal: createHmac('sha256', secret).update(canonicalJson(raw)).digest('hex') }));
  };
  return { value, f, location, bytes, open, seal, retag };
}

describe('distinct source5 terminal-bookkeeping reader', () => {
  it('reopens under a fresh lease after exact publication, retains expiry, and performs only one reserved index CAS', async () => {
    const { value, f, bytes, open, seal } = await fixture();
    await seal(); await f.writeFiles();
    const before = await bytes();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await expect(openSource5WorkflowJournal({ ...f.reviewed, lease, initialize: false })).rejects.toThrow(/exact current5.*scope/);
      await expect(source5WorkflowOwnership({ ...f.reviewed, lease })).rejects.toThrow(/exact current5.*scope/);
      await expect(restoreSource5WorkflowAuthority({ ...f.reviewed, lease }, new Date('2030-01-01'))).rejects.toThrow(/state digest/);
      const reader = await open(lease);
      expect(() => assertSource5WorkflowJournal(reader as never)).toThrow(/Structural/);
      expect(Object.keys(reader)).toEqual(['kind']);
      expect(await inspectSource5WorkflowFinalization(reader)).toMatchObject({ status: 'recorded-bytes-present', finalized: false });
      expect(await bytes()).toEqual(before);
      await reconcileSource5WorkflowFinalization(reader);
      const index = (await value.store.read('journal', f.reviewed.control.controlKey))!;
      expect(index.revision).toBe(2); expect(index.previousDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(index.encodedBytes).toBeLessThanOrEqual(workflowSource5ControlLimits.journal);
      expect(await inspectSource5WorkflowFinalization(reader)).toMatchObject({ finalized: true });
      const finalized = await bytes();
      await reconcileSource5WorkflowFinalization(reader);
      expect(await bytes()).toEqual(finalized);
      expect(Object.keys(finalized).filter(name => !before[name].equals(finalized[name]))).toEqual([
        path.basename(index.path)
      ]);
    });
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const before = await bytes();
      await reconcileSource5WorkflowFinalization(await open(lease));
      expect(await bytes()).toEqual(before);
    });
  });

  it.each(['original', 'partial'] as const)('inspects %s bytes without saves and refuses reconciliation', async mode => {
    const { value, f, bytes, open, seal } = await fixture();
    await seal();
    if (mode === 'partial') await f.writeFiles(f.files.slice(0, 1));
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const before = await bytes(), reader = await open(lease);
      expect(await inspectSource5WorkflowFinalization(reader)).toMatchObject({
        status: mode === 'partial' ? 'partial-original-publication' : 'original-bytes'
      });
      await expect(reconcileSource5WorkflowFinalization(reader)).rejects.toThrow(/before, partial or different/);
      expect(await bytes()).toEqual(before);
    });
  });

  it.each(Array.from({ length: 6 }, (_, index) => index))('refuses differing target %i without repairs', async selected => {
    const { value, f, bytes, open, seal } = await fixture();
    await seal(); await f.writeFiles();
    const file = f.files[selected]!;
    await value.installed.write(file.path.split('/'), `${file.content}\n`);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const before = await bytes(), reader = await open(lease);
      expect(await inspectSource5WorkflowFinalization(reader)).toMatchObject({ status: 'different-bytes' });
      await expect(reconcileSource5WorkflowFinalization(reader)).rejects.toThrow(/different bytes/);
      expect(await bytes()).toEqual(before);
      expect(await readFile(path.join(value.projectRoot, file.path), 'utf8')).toBe(`${file.content}\n`);
    });
  });

  it('refuses target-shaped metadata without sealed original completion or new ledgers', async () => {
    const { value, f, bytes, open } = await fixture();
    await f.writeFiles();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const before = await bytes();
      await expect(open(lease)).rejects.toThrow(/existing immutable/);
      expect(await bytes()).toEqual(before);
    });
  });

  it.each(['plan', 'issuer', 'approval', 'manifest', 'reservation', 'index', 'finalization',
    'owner', 'owner-manifest', 'confirmation', 'component', 'source-plan', 'source-approval',
    'source-manifest', 'source-reservation', 'source-index', 'source-owner', 'source-owner-manifest', 'source-confirmation', 'source-component',
    'runner-owner', 'runner-owner-manifest', 'runner-confirmation', 'runner-component'].flatMap(
      selected => [{ selected, fault: 'missing' }, { selected, fault: 'retagged' }]))(
    'retains all other bytes when original $selected is $fault', async ({ selected, fault }) => {
      const { value, f, location, bytes, open, seal, retag } = await fixture();
      await seal(); await f.writeFiles();
      const source = selected.startsWith('source-');
      const review = source ? value : f.reviewed;
      const runner = selected.startsWith('runner-');
      const kind = source ? selected.slice(7) : runner ? selected.slice(7) : selected;
      const operationDigest = canonicalSha256(review.plan.operations[runner ? 1 : 0]);
      const objects = Object.entries(await bytes());
      const entries = objects.map(([name, content]) => ({ name, raw: JSON.parse(content.toString()) }));
      const picked = entries.find(({ raw }) => {
        const item = raw.value;
        if (kind === 'issuer') return raw.kind === 'liftoff-workflow-source5-issuer';
        if (kind === 'plan') return item?.kind === 'workflow-source5-original-plan' && raw.key === review.control.controlKey;
        if (kind === 'approval') return item?.kind === 'liftoff-source5-workflow-approval' && item.savedPlanDigest === canonicalSha256(review.plan);
        if (kind === 'index') return item?.kind === 'workflow-source5-journal' && raw.key === review.control.controlKey;
        if (kind === 'owner') return item?.kind === 'workflow-source5-entry-owner' &&
          item.owner.controlKey === review.control.controlKey && item.operationDigest === operationDigest;
        if (kind === 'owner-manifest') return item?.kind === 'workflow-source5-owner-manifest' &&
          item.originalPlanKey === review.control.controlKey && item.operationDigest === operationDigest;
        if (kind === 'confirmation') return item?.kind === 'workflow-source5-owner-confirmed' &&
          item.owner.controlKey === review.control.controlKey && item.operationDigest === operationDigest;
        if (kind === 'component') return item?.kind === 'workflow-source5-event' &&
          item.stage === 'component-completed' && item.controlKey === review.control.controlKey && item.operationDigest === operationDigest;
        return item?.kind === `workflow-source5-${kind === 'manifest' ? 'storage-inventory' : kind}` && item.controlKey === review.control.controlKey;
      });
      expect(picked).toBeDefined();
      const target = path.join(location.directory, picked!.name);
      if (fault === 'missing') await unlink(target);
      else await retag(target, raw => { raw.revision = Number(raw.revision ?? 0) + 1; });
      const before = await bytes();
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        await expect(open(lease)).rejects.toThrow();
        expect(await bytes()).toEqual(before);
      });
    });

  it.each(['active-extra-revision', 'active-foreign-predecessor', 'finalized-foreign-predecessor', 'finalized-excess-revision'] as const)(
    'refuses coherently resealed %s index', async fault => {
      const { value, f, open, seal, retag, bytes } = await fixture();
      await seal(); await f.writeFiles();
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        if (fault.startsWith('finalized')) await reconcileSource5WorkflowFinalization(await open(lease));
        const index = (await value.store.read('journal', f.reviewed.control.controlKey))!;
        await retag(index.path, raw => {
          if (fault.endsWith('revision')) raw.revision = Number(raw.revision) + 1;
          else raw.previousDigest = 'a'.repeat(64);
        });
        const before = await bytes();
        await expect(open(lease)).rejects.toThrow(/revision|predecessor/);
        expect(await bytes()).toEqual(before);
      });
    });

  it.each(['before-save', 'after-save'] as const)('preserves truth and fresh-lease restart after %s confirmation loss', async fault => {
    const { value, f, open, seal } = await fixture();
    await seal(); await f.writeFiles();
    const index = (await value.store.read('journal', f.reviewed.control.controlKey))!;
    let hit = false;
    const fileSystem = { ...nodeUpdatePreviewFileSystem, async replaceFile(source: string, target: string) {
      if (target === index.path && fault === 'before-save') { hit = true; throw new Error('fixture before index save'); }
      await nodeUpdatePreviewFileSystem.replaceFile(source, target);
      if (target === index.path && fault === 'after-save') { hit = true; throw new Error('fixture after index save'); }
    } };
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await expect(reconcileSource5WorkflowFinalization(await open(lease, { ...value.storage, fileSystem }))).rejects.toThrow(/fixture/);
    });
    expect(hit).toBe(true);
    expect((await value.store.read('journal', f.reviewed.control.controlKey))!.revision).toBe(fault === 'before-save' ? 1 : 2);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await reconcileSource5WorkflowFinalization(await open(lease));
      expect((await value.store.read('journal', f.reviewed.control.controlKey))!.revision).toBe(2);
    });
  });

  it.each(['unchanged', 'native-lease-loss', 'original-plan-loss', 'approval-loss', 'issuer-loss',
    'manifest-loss', 'reservation-loss', 'owner-loss', 'source-plan-loss', 'source-approval-loss', 'source-owner-loss',
    ...Array.from({ length: 6 }, (_, index) => `target-${index}`)])(
    'validates the atomic boundary %s after reading staged metadata but before actual index replacement', async fault => {
      const { value, f, open, seal, bytes, location } = await fixture();
      await seal(); await f.writeFiles();
      const index = (await value.store.read('journal', f.reviewed.control.controlKey))!;
      const originalIndexBytes = await readFile(index.path), before = await bytes();
      const nativeLock = await projectMutationLockPath(value.projectRoot);
      const source = fault.startsWith('source-'), kind = source ? fault.slice(7, -5) : fault.slice(0, -5);
      const review = source ? value : f.reviewed, operationDigest = canonicalSha256(review.plan.operations[0]);
      const targetFile = fault.startsWith('target-') ? f.files[Number(fault.slice(7))]! : undefined;
      const selected = Object.entries(before).find(([, content]) => {
        const raw = JSON.parse(content.toString()), item = raw.value;
        if (kind === 'issuer') return raw.kind === 'liftoff-workflow-source5-issuer';
        if (kind === 'original-plan' || kind === 'plan') {
          return item?.kind === 'workflow-source5-original-plan' && raw.key === review.control.controlKey;
        }
        if (kind === 'approval') return item?.kind === 'liftoff-source5-workflow-approval' &&
          item.savedPlanDigest === canonicalSha256(review.plan);
        if (kind === 'owner') return item?.kind === 'workflow-source5-entry-owner' &&
          item.owner.controlKey === review.control.controlKey && item.operationDigest === operationDigest;
        return item?.kind === `workflow-source5-${kind === 'manifest' ? 'storage-inventory' : kind}` &&
          item.controlKey === review.control.controlKey;
      });
      if (fault !== 'unchanged' && fault !== 'native-lease-loss' && !targetFile) expect(selected).toBeDefined();
      let hit = false, replacements = 0, error: unknown;
      const fileSystem = {
        ...nodeUpdatePreviewFileSystem,
        async openFile(filePath: string, access: 'read' | 'create-exclusive', permissions: number) {
          const handle = await nodeUpdatePreviewFileSystem.openFile(filePath, access, permissions);
          if (access !== 'read' || hit || !path.basename(filePath).startsWith(`.${path.basename(index.path)}.`) ||
            !filePath.endsWith('.tmp')) return handle;
          return { ...handle, async readText(maximumBytes: number) {
            const content = await handle.readText(maximumBytes);
            hit = true;
            if (fault === 'native-lease-loss') await unlink(nativeLock);
            else if (targetFile) await value.installed.write(targetFile.path.split('/'), `${targetFile.content}\n`);
            else if (fault !== 'unchanged') await unlink(path.join(location.directory, selected![0]));
            return content;
          } };
        },
        async replaceFile(source: string, target: string) {
          if (target === index.path) replacements++;
          await nodeUpdatePreviewFileSystem.replaceFile(source, target);
        }
      };
      try {
        await withSource5WorkflowLease(value.projectRoot, async lease => {
          await reconcileSource5WorkflowFinalization(await open(lease, { ...value.storage, fileSystem }));
        });
      } catch (caught) { error = caught; }
      expect(hit).toBe(true);
      const retainedBytes = await readFile(index.path), retained = JSON.parse(retainedBytes.toString());
      if (fault === 'unchanged') {
        expect(error).toBeUndefined(); expect(replacements).toBe(1); expect(retained.revision).toBe(2);
        expect(retained.previousDigest).toBe(index.rawDigest);
        expect(await bytes()).toEqual({ ...before, [path.basename(index.path)]: retainedBytes });
      } else {
        expect(error).toBeInstanceOf(Error); expect(replacements).toBe(0); expect(retained.revision).toBe(1);
        expect(retainedBytes).toEqual(originalIndexBytes);
        expect(await bytes()).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) =>
          fault === 'native-lease-loss' || targetFile || name !== selected![0])));
        if (targetFile) expect(await readFile(path.join(value.projectRoot, targetFile.path), 'utf8')).toBe(`${targetFile.content}\n`);
      }
    });

  it.each(['target', 'source', 'original-plan'] as const)('reports accepted-but-inconsistent CAS after %s mutation without undo', async fault => {
    const { value, f, open, seal } = await fixture();
    await seal(); await f.writeFiles();
    const index = (await value.store.read('journal', f.reviewed.control.controlKey))!;
    const original = (await value.store.read('plan', f.reviewed.control.controlKey))!;
    const proofKey = canonicalSha256({ kind: 'workflow-source5-finalization-key.v1', controlKey: f.reviewed.control.controlKey });
    const proof = (await value.store.read('proof', proofKey))!, proofBytes = await readFile(proof.path);
    const fileSystem = { ...nodeUpdatePreviewFileSystem, async replaceFile(source: string, target: string) {
      await nodeUpdatePreviewFileSystem.replaceFile(source, target);
      if (target === index.path) {
        if (fault === 'original-plan') await unlink(original.path);
        else await value.installed.write(fault === 'source' ? ['liftoff.manifest.json'] : f.files[4]!.path.split('/'), '{}');
      }
    } };
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await expect(reconcileSource5WorkflowFinalization(await open(lease, { ...value.storage, fileSystem }))).rejects.toThrow();
    });
    expect((await value.store.read('journal', f.reviewed.control.controlKey))!.revision).toBe(2);
    expect(await readFile(proof.path)).toEqual(proofBytes);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await expect(open(lease).then(reconcileSource5WorkflowFinalization)).rejects.toThrow();
    });
  });

  it('rejects structural, foreign and released leases, field accessors and execution capabilities', async () => {
    const { value, f, open, seal, bytes } = await fixture();
    await seal(); await f.writeFiles();
    let retained: Awaited<ReturnType<typeof open>>;
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      retained = await open(lease);
      await expect(reconcileSource5WorkflowFinalization({ ...retained })).rejects.toThrow(/Structural/);
      await expect(reconcileSource5WorkflowFinalization(f.journal as never)).rejects.toThrow(/Structural/);
      await expect(open({ ...lease } as never)).rejects.toThrow(/structural/);
      const input = { projectRoot: value.projectRoot, plan: f.reviewed.plan, approval: f.reviewed.approval,
        context: value.context, storage: value.storage, lease };
      await expect(openSource5WorkflowFinalizationReader({ ...input, authority: {} } as never)).rejects.toThrow(/closed/);
      let read = false;
      await expect(openSource5WorkflowFinalizationReader({ ...input,
        get plan() { read = true; return f.reviewed.plan; } })).rejects.toThrow(/closed/);
      expect(read).toBe(false);
      await expect(openSource5WorkflowFinalizationReader({ ...input, projectRoot: value.root })).rejects.toThrow(/foreign lease/);
    });
    const before = await bytes();
    await expect(reconcileSource5WorkflowFinalization(retained!)).rejects.toThrow(/lease/);
    expect(await bytes()).toEqual(before);
  });

  it('retains immutable components when their optional mutable progress cursor disappeared', async () => {
    const { value, f, open, seal } = await fixture();
    await seal(); await f.writeFiles();
    const key = canonicalSha256({ controlKey: f.reviewed.control.controlKey, operationDigest: canonicalSha256(f.reviewed.operation) });
    await unlink((await value.store.read('operation', key))!.path);
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await reconcileSource5WorkflowFinalization(await open(lease));
      expect(await value.store.read('operation', key)).toBeNull();
    });
  });

  it('retains separately reviewed original-to-remaining ownership and every immutable predecessor digest', async () => {
    const { value, f, open, seal } = await fixture(true);
    await seal(); await f.writeFiles();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      await reconcileSource5WorkflowFinalization(await open(lease));
      expect((await value.store.read('journal', f.reviewed.control.controlKey))!.revision).toBe(2);
    });
  });

  it.each(['publication', 'staging-qualified', 'production-rehearsed'] as const)(
      'does not turn %s component metadata into finalization permission', async phase => {
        const { value, f, bytes } = await fixture(false, phase !== 'publication');
        await withSource5WorkflowLease(value.projectRoot, async lease => {
          const origin = f.reviewed.control.origin!;
          const review = phase === 'publication' ? value : value.review({ phaseId: phase, origin, effects: [{
            action: phase === 'staging-qualified' ? 'github.checks.staging' : 'github.checks.production-rehearsal',
            binding: { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
              sourceSha: origin.commitSha, treeSha: origin.treeSha, executionRef: `liftoff-execution-${origin.commitSha}` }
          }] });
          if (phase !== 'publication') {
            await value.store.save('plan', review.control.controlKey,
              source5WorkflowOriginalPlanValue(value.projectRoot, review.plan, review.approval), null);
            await issueSource5WorkflowApproval({ ...review, lease }, review.now);
          }
          await openSource5WorkflowJournal({ ...review, lease, initialize: phase !== 'publication' });
          const paths = [review.control.controlKey, ...(review.control.origin ? [review.control.origin.planKey] : [])];
          const files = paths.flatMap(key => [
            { path: `governance/plans/${key}.json`, content: canonicalJson(key === review.control.controlKey ? review.plan : value.plan), beforeHash: null },
            { path: `governance/approvals/source5-${key}.json`, content: canonicalJson(key === review.control.controlKey ? review.approval : value.approval), beforeHash: null }
          ]);
          files.push({ path: `governance/evidence/source5-${review.control.controlKey}.json`, content: canonicalJson({}), beforeHash: null });
          const { kind: _kind, plan: _plan, approval: _approval, ...common } =
            source5WorkflowOriginalPlanValue(value.projectRoot, review.plan, review.approval);
          const proofKey = canonicalSha256({ kind: 'workflow-source5-finalization-key.v1', controlKey: review.control.controlKey });
          await value.store.save('proof', proofKey, { ...common, kind: 'workflow-source5-finalization', files: [...files, {
            path: 'governance/activation-state.json', content: canonicalJson(value.installed.state),
            beforeHash: canonicalSha256(value.installed.state)
          }] }, null);
          const before = await bytes();
          await expect(openSource5WorkflowFinalizationReader({ projectRoot: value.projectRoot, context: value.context,
            plan: review.plan, approval: review.approval, lease, storage: value.storage })).rejects.toThrow(/Publication A|independent current Azure/);
          expect(await bytes()).toEqual(before);
        });
  });

  it.each(['confirmation', 'reservation', 'predecessor'] as const)(
    'refuses lost or retagged remaining-only %s history', async fault => {
      const { value, f, location, open, seal, bytes, retag } = await fixture(true);
      await seal(); await f.writeFiles();
      const entries = Object.entries(await bytes()).map(([name, content]) => ({ name, raw: JSON.parse(content.toString()) }));
      const selected = entries.find(({ raw }) => {
        const item = raw.value;
        return fault === 'predecessor' ? item?.kind === 'workflow-source5-entry-owner' &&
          item.owner.controlKey === f.reviewed.control.controlKey :
          item?.kind === `workflow-source5-owner-${fault === 'confirmation' ? 'confirmed' : 'reservation'}` &&
          (fault === 'confirmation' ? item.owner.generation === 0 &&
            item.owner.controlKey === f.reviewed.control.remainingFrom!.planKey :
            item.newOwner.controlKey === f.reviewed.control.controlKey);
      })!;
      expect(selected).toBeDefined();
      const target = path.join(location.directory, selected.name);
      if (fault === 'predecessor') await retag(target, raw => { raw.previousDigest = 'f'.repeat(64); });
      else await unlink(target);
      const before = await bytes();
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        await expect(open(lease)).rejects.toThrow();
        expect(await bytes()).toEqual(before);
      });
    });
});
