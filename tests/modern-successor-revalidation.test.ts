import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectModernSuccessorRevalidation, planModernSuccessorRevalidation, reinspectModernSuccessorRevalidation
} from '../src/application/update/modern-revalidation.js';
import { inspectModernOpenSpecRuntime } from '../src/application/governance/modern-local-inputs.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import type { ManifestActiveLayout, ManifestLayoutComponentId } from '../src/domain/project/contracts.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { completedSpecKitTasks } from '../src/governance-activation/spec-kit-seed.js';
import { createLocalRevalidationRecordStore, createLocalFinalizationRecordStore, createLocalExecutionRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { captureFinalizationStore } from '../src/application/governance/modern-local-finalization.js';
import { fixture, inventory, write } from './fixtures/manifest-update.js';
import { selected, writeModernHistoricalSource, writeModernSuccessor } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';

async function project(version: 1 | 2 | 3 = 3, workflow: 'openspec' | 'spec-kit' = 'openspec', completed = false) {
  const f = await fixture(), selectedWorkflow = workflow === 'spec-kit' ? workflow : undefined;
  await writeModernHistoricalSource(f.root, version, false, selectedWorkflow);
  const original = parseManifest(JSON.parse(await fs.readFile(path.join(f.root, 'liftoff.manifest.json'), 'utf8')));
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: original.project, framework: original.framework });
  const target = selected(leaf, 'single-maintainer-gitflow');
  const source = resolveModernManifestV8SourceContract({ selection: target.selection, recordedPlugins: target.plugins });
  const components = new Map<ManifestLayoutComponentId, string[]>(source.layoutDescriptor.components.map(id =>
    [id, ['Source Space', id.replace(':', ' ')]]));
  const compose = ['Configuration Space', 'compose.yml'];
  const layout: ManifestActiveLayout = { schemaVersion: 1, state: 'bound', bindings: [
    ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
    { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
  ] };
  const successor = await writeModernSuccessor(f.root, version, false, false, false, { layout, workflow: selectedWorkflow });
  const put = (parts: readonly string[], bytes: string | Buffer) => write(f.root, parts, bytes);
  const tasks = await writeModernLocalFixtureInputs(leaf, components, compose, put);
  if (!tasks) throw new Error('Expected selected initialized framework inputs.');
  if (completed) {
    const content = await fs.readFile(path.join(f.root, ...tasks), 'utf8');
    if (workflow === 'spec-kit') await put(tasks, completedSpecKitTasks(content));
    else {
      await put(tasks, content.replace('[ ]', '[x]'));
      const base = tasks.slice(0, -1);
      const workload = leaf.project.workload;
      const capability = `${workload.kind === 'genai' ? workload.pattern : workload.apiStack}-application-baseline`;
      const spec = await fs.readFile(path.join(f.root, ...base, 'specs', capability, 'spec.md'), 'utf8');
      await put(['openspec', 'specs', capability, 'spec.md'], spec.replace('## ADDED Requirements', '## Requirements'));
      const archive = path.join(f.root, 'openspec', 'changes', 'archive');
      await fs.mkdir(archive, { recursive: true });
      await fs.rename(path.join(f.root, ...base), path.join(archive, `2026-09-01-${base.at(-1)}`));
    }
  }
  return { ...f, successor, tasks, put, components };
}

describe('finite modern successor revalidation planning', () => {
  it.each(([1, 2, 3] as const).flatMap(version => (['openspec', 'spec-kit'] as const).map(workflow => ({ version, workflow }))))(
    'binds actual v$version/$workflow source without inheriting old proof or changing files', async ({ version, workflow }) => {
      const f = await project(version, workflow), before = await inventory(f.root), home = await inventory(f.home);
      const plan = await inspectModernSuccessorRevalidation(f.root);
      expect(plan.originalTransitionDigest).toBe(f.successor.prepared.journal.semanticTransitionDigest);
      expect(plan.originalPreparation).toEqual(f.successor.prepared.journal.preparation);
      expect(plan.successor).toEqual(f.successor.prepared.journal.successor);
      expect(plan.recordedProgress.status).toBe('pending');
      expect(plan.phases.map(phase => phase.phaseId)).toEqual(['local-inputs-valid', 'local-baseline-verified', 'local-complete']);
      expect(plan.phases.every(phase => phase.reuse === 'not-established')).toBe(true);
      expect(plan.completionSource).toMatchObject({ workflow, status: 'blocked' });
      expect(plan.phases[2].status).toBe('blocked');
      expect(plan.phases[2].blockers.join(' ')).toContain('separately reviewed setup transition');
      expect(plan.execution).toBe('not-authorized');
      expect(plan.publication).toBe('not-authorized');
      expect(plan.effects).toMatchObject({ workflowWrites: 'not-authorized', archiveReplay: 'not-authorized', providerAccess: 'not-authorized', statePayloadAccess: 'not-authorized' });
      expect(await reinspectModernSuccessorRevalidation(f.root, plan)).toEqual(plan);
      expect(await inventory(f.root)).toEqual(before);
      expect(await inventory(f.home)).toEqual(home);
    }
  );

  it.each(['openspec', 'spec-kit'] as const)('distinguishes already completed %s source from new execution proof', async workflow => {
    const f = await project(3, workflow, true), before = await inventory(f.root);
    const plan = await inspectModernSuccessorRevalidation(f.root);
    expect(plan.completionSource).toEqual({ workflow, status: 'already-completed-source', blockers: [] });
    expect(plan.recordedProgress.phases.every(phase => phase.status === 'pending' && phase.evidenceIds.length === 0)).toBe(true);
    expect(plan.phases.every(phase => phase.status !== 'blocked')).toBe(plan.runtime.status === 'planned');
    expect(plan.phases.every(phase => phase.reuse === 'not-established')).toBe(true);
    expect(plan.execution).toBe('not-authorized');
    expect(await inventory(f.root)).toEqual(before);
  });

  describe('separate revalidation record ownership', () => {
    it.each(['preview', 'consent', 'result', 'artifact', 'publication-consent'] as const)(
      'keeps %s bytes immutable and separate from fresh finalization and execution', async kind => {
        const f = await fixture(), store = createLocalRevalidationRecordStore(f.root, f.options), key = 'a'.repeat(64);
        const value = { kind: `liftoff-local-revalidation-${kind}`, projectRoot: f.root, formatFixtureOnly: true };
        expect(store.operationKind).toBe('local-revalidation');
        await store.write(kind, key, value);
        expect((await store.read(kind, key))?.value).toEqual(value);
        await expect(store.write(kind, key, { ...value, formatFixtureOnly: false })).rejects.toThrow(/replace/);
        expect(await createLocalFinalizationRecordStore(f.root, f.options).read(kind, key)).toBeNull();
        if (kind === 'preview') expect(await createLocalExecutionRecordStore(f.root, f.options).read(kind, key)).toBeNull();
        expect(() => Reflect.apply(captureFinalizationStore, undefined, [store, f.root])).toThrow(/attribution/);
      }
    );

    it('rejects foreign roots, wire kinds and accessor payloads before writing records', async () => {
      const f = await fixture(), other = await fixture(), store = createLocalRevalidationRecordStore(f.root, f.options), key = 'b'.repeat(64);
      const value = { kind: 'liftoff-local-revalidation-preview', projectRoot: f.root, formatFixtureOnly: true };
      await expect(store.write('preview', key, { ...value, projectRoot: other.root })).rejects.toThrow(/wire kind\/root/);
      await expect(store.write('result', key, value)).rejects.toThrow(/wire kind\/root/);
      const getter = vi.fn(() => true), accessor = Object.defineProperty({ ...value }, 'formatFixtureOnly', { enumerable: true, get: getter });
      await expect(store.write('preview', key, accessor)).rejects.toThrow(/accessor/);
      expect(getter).not.toHaveBeenCalled();
      expect(await store.read('preview', key)).toBeNull();
    });

    it('admits exactly one attributed claim without sharing finalization progress', async () => {
      const f = await fixture(), store = createLocalRevalidationRecordStore(f.root, f.options), key = 'c'.repeat(64);
      const value = { kind: 'liftoff-local-revalidation-state', projectRoot: f.root, formatFixtureOnly: true };
      const claims = await Promise.allSettled([
        store.compareExchangeState(key, null, value), store.compareExchangeState(key, null, value)
      ]);
      expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((await store.readState(key))?.value).toEqual(value);
      expect(await createLocalFinalizationRecordStore(f.root, f.options).readState(key)).toBeNull();
      await expect(store.compareExchangeState(key, null, { ...value, kind: 'liftoff-local-finalization-state' })).rejects.toThrow(/wire kind\/root/);
    });

    it('retains the same serialized 64KiB bound including base64 overhead', async () => {
      const f = await fixture(), store = createLocalRevalidationRecordStore(f.root, f.options);
      await expect(store.write('artifact', 'd'.repeat(64), {
        kind: 'liftoff-local-revalidation-artifact', projectRoot: f.root, contentBase64: Buffer.alloc(49152).toString('base64')
      })).rejects.toThrow(/exceeds64KiB/);
    });
  });

  it('reports missing framework and application inputs rather than inventing successful checks', async () => {
    const f = await project(), backend = f.components.get('backend')!;
    await fs.rm(path.join(f.root, ...backend), { recursive: true });
    await fs.unlink(path.join(f.root, ...f.tasks));
    const plan = await inspectModernSuccessorRevalidation(f.root);
    expect(plan.runtime.status).toBe('blocked');
    expect(plan.runtime.blockers.length).toBeGreaterThan(0);
    expect(plan.completionSource.status).toBe('blocked');
    expect(plan.phases.every(phase => phase.status === 'blocked' && phase.blockers.length > 0)).toBe(true);
  });

  it('never equates an incomplete blocked capture with unchanged application inputs', async () => {
    const f = await project(), backend = f.components.get('backend')!;
    await f.put([...backend, 'liftoff.manifest.json'], 'Nested project boundary; not a readable source grant.');
    const plan = await inspectModernSuccessorRevalidation(f.root);
    expect(plan.runtime.captureStatus).toBe('blocked');
    expect(plan.runtime.blockers.join(' ')).toContain('nested project or repository boundary');
    await expect(reinspectModernSuccessorRevalidation(f.root, plan)).rejects.toThrow(/blocked capture cannot establish unchanged/);
    await f.put(f.tasks, 'Changed while outside the incomplete observation.');
    await expect(reinspectModernSuccessorRevalidation(f.root, plan)).rejects.toThrow(/blocked capture cannot establish unchanged/);
  });

  it('refuses copied summary claims that disagree with actual captured records', async () => {
    const f = await project(), input = structuredClone(await inspectModernOpenSpecRuntime(f.root));
    if (input.status !== 'observed' || !input.installed.current) throw new Error('Expected actual current records.');
    Reflect.set(input.installed.current.state.phases['local-inputs-valid'], 'state', 'verified');
    await expect(planModernSuccessorRevalidation(input)).rejects.toThrow(/Supplied installed summary differs/);
  });

  it.each(['authority', 'proof', 'extra', 'fingerprint'] as const)('rejects %s edits even when a caller recalculates a fingerprint', async change => {
    const f = await project(), plan = await inspectModernSuccessorRevalidation(f.root);
    const forged = structuredClone(plan);
    if (change === 'authority') Reflect.set(forged.effects, 'providerAccess', 'authorized');
    else if (change === 'proof') Reflect.set(forged.phases[0], 'reuse', 'historical-proof');
    else if (change === 'extra') Reflect.set(forged, 'force', true);
    const { fingerprint: _old, ...body } = forged;
    forged.fingerprint = change === 'fingerprint' ? 'a'.repeat(64) : canonicalSha256(body);
    await expect(reinspectModernSuccessorRevalidation(f.root, forged)).rejects.toThrow(/changed|exactly the required fields|invalid identity or fingerprint/);
  });

  it('rejects an accessor without invoking it', async () => {
    const f = await project(), plan = await inspectModernSuccessorRevalidation(f.root), getter = vi.fn(() => plan.runtime);
    const forged = Object.defineProperty({ ...plan }, 'runtime', { enumerable: true, get: getter });
    await expect(reinspectModernSuccessorRevalidation(f.root, forged)).rejects.toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
  });

  it('requires a new review after actual source bytes or root attribution change', async () => {
    const f = await project(), other = await project(), plan = await inspectModernSuccessorRevalidation(f.root);
    await expect(reinspectModernSuccessorRevalidation(other.root, plan)).rejects.toThrow(/changed/);
    await f.put(f.tasks, '- [ ] 1.1 Changed actual local input.\n');
    const before = await inventory(f.root);
    await expect(reinspectModernSuccessorRevalidation(f.root, plan)).rejects.toThrow(/changed/);
    expect(await inventory(f.root)).toEqual(before);
  });

  it('rejects a non-successor without a fallback or execution grant', async () => {
    const f = await fixture();
    await expect(inspectModernSuccessorRevalidation(f.root)).rejects.toThrow(/successor/);
  });
});
