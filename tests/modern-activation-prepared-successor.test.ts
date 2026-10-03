import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capturedV3Records, capturedV3Successor, writeFixtureBytes } from './fixtures/activation-v3/fixture.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { historyRecord, parseHistoryJson, rawHistoryDigest, validateMigrationJournal } from '../src/governance-activation/history-contracts.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { buildModernManagedCore, type ModernManagedCoreInput } from '../src/application/project/modern-managed-core.js';
import { createManifestV8Candidate, type ManagedManifestDecision } from '../src/application/project/manifest-writer.js';
import { createModernCompatibilityContract } from '../src/governance-activation/modern-compatibility.js';
import { createModernHistoryContract, validateSuccessorPreparation } from '../src/governance-activation/modern-history-contracts.js';
import { createModernActivationRecordContract, type ModernPlanInput, type ModernRelatedRecords } from '../src/domain/governance/activation/modern-records.js';
import type { ModernEvidenceRecord, ModernSavedTransitionPlan } from '../src/domain/governance/activation/modern-record-contracts.js';
import { inspectReviewedUpdateCandidate } from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { reviewedJournalLimits } from '../src/adapters/filesystem/reviewed-update-journal.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { historicalV2EvidenceBodyDigest, historicalV2PhaseContractDigest, validateHistoricalV2EvidenceRecord } from '../src/governance-activation/historical-v2.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import {
  readModernActivationSuccessorSource, planModernActivationSuccessor, prepareActivationHistorySuccessor,
  type ModernSuccessorTarget, type ModernSuccessorSource
} from '../src/governance-activation/migration-history.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true }); });
const preparedAt = '2026-09-01T12:00:00.000Z', observedAt = '2026-09-02T12:00:00.000Z';
async function fixture(version: 1 | 2 | 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c2b-source-')); roots.push(root);
  const sample = capturedV3Successor(version === 1 ? 1 : 2);
  const manifest = version === 3 ? capturedV3Records().manifest : parseHistoryJson(sample.files.get('liftoff.manifest.json')!, 'manifest');
  const state = version === 3 ? historyRecord(sample.state, 'state') :
    historyRecord(parseHistoryJson(sample.files.get('governance/activation-state.json')!, 'state'), 'state');
  for (const key of ['bootstrapState', 'successorHistory', 'phaseOutputs', 'taskProjection', 'activationInputs']) delete state[key];
  state.activeChange = null;
  for (const value of Object.values(historyRecord(state.phases, 'phases'))) {
    const phase = historyRecord(value, 'phase'); Object.assign(phase, { state: 'pending', evidence: [], approvals: [], blockers: [] });
    delete phase.operation; delete phase.executionPlanDigest;
  }
  await writeFixtureBytes(root, ['liftoff.manifest.json'], JSON.stringify(manifest, null, '\t') + '\r\n', 0o640);
  await writeFixtureBytes(root, ['governance', 'activation-state.json'], JSON.stringify(state, null, '\t') + '\r\n', 0o644);
  return { root, manifest, state };
}
function targetFor(source: ModernSuccessorSource): ModernSuccessorTarget {
  const original = source.captures.find(file => file.pathParts.join('/') === 'liftoff.manifest.json')!;
  const manifest = parseManifest(parseHistoryJson(original.content!, 'manifest'));
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  const profile = 'single-maintainer-gitflow', workload = leaf.project.workload;
  const resolution = composeModernManifestPlugins({ workload: workload.kind, stack: workload.apiStack, cloud: workload.cloud,
    ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}), workflow: leaf.project.specWorkflow, agents: leaf.project.agents,
    frontend: workload.frontend ? 'included' : 'omitted', governanceProfile: profile, environments: workload.environments },
  { safeProjectName: toSafeProjectName(leaf.project.name) }).resolution;
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: resolution.digest, selections: resolution.plugins },
    { stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents });
  const base: ModernManagedCoreInput = { selection: { ...leaf, profile }, plugins,
    activeLayout: { schemaVersion: 1 as const, state: 'unresolved' as const, bindings: [] as const } };
  const artifacts = buildModernManagedCore(base);
  const managed: ManagedManifestDecision[] = artifacts.map(artifact => ({
    kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts, content: artifact.content
  }));
  for (const entry of manifest.managedArtifacts) if (!artifacts.some(artifact => artifact.logicalName === entry.logicalName)) {
    managed.push({ kind: 'retire-alias', logicalName: entry.logicalName });
  }
  return { ...base, managed };
}
function preparation(source: ModernSuccessorSource) {
  const state = historyRecord(parseHistoryJson(source.captures.find(file => file.pathParts.join('/') === 'governance/activation-state.json')!.content!, 'state'), 'state');
  const anchor = String(historyRecord(state.repository, 'repository').id);
  return { schemaVersion: 1 as const, preparationId: '11111111-1111-4111-8111-111111111111', preparedAt,
    localRepositoryId: anchor.startsWith('local:') ? anchor : 'local:22222222-2222-4222-8222-222222222222' };
}
async function hashes(root: string) {
  const result: Record<string, { digest: string; mode: number }> = {};
  async function walk(parts: string[]) {
    for (const item of await fs.readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, item.name];
      if (item.isDirectory()) await walk(next);
      else if (item.isFile()) result[next.join('/')] = { digest: rawHistoryDigest(await fs.readFile(path.join(root, ...next))),
        mode: (await fs.lstat(path.join(root, ...next))).mode & 0o7777 };
    }
  }
  await walk([]); return result;
}

describe('actual pre-admission G1/W1 historical successor candidates', () => {
  it.each(['sourceBinding', 'originalPaths', 'capturedBytes', 'capturedPath', 'targetDecision', 'targetSelection'] as const)(
    'isolates caller %s synchronously before planner validation yields', async field => {
      const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = structuredClone(targetFor(source));
      const expected = await planModernActivationSuccessor(source, target);
      const pending = planModernActivationSuccessor(source, target);
      let invoked = 0;
      if (field === 'sourceBinding') {
        const binding = source.sourceBinding;
        Object.defineProperty(source, 'sourceBinding', { enumerable: true, get() { invoked++; return binding; } });
      }
      if (field === 'originalPaths') {
        const first = source.originalPaths[0][0];
        Object.defineProperty(source.originalPaths[0], '0', { enumerable: true, get() { invoked++; return first; } });
      }
      if (field === 'capturedBytes') source.captures.find(file => file.content)!.content!.fill(0);
      if (field === 'capturedPath') {
        const captured = source.captures[0], parts = [...captured.pathParts];
        Object.defineProperty(captured, 'pathParts', { enumerable: true, get() { invoked++; return parts; } });
      }
      if (field === 'targetDecision') {
        const content = target.managed.find(entry => entry.kind === 'bytes')!;
        const original = content.kind === 'bytes' ? content.content : '';
        Object.defineProperty(content, 'content', { enumerable: true, get() { invoked++; return original; } });
      }
      if (field === 'targetSelection') {
        const name = target.selection.project.name;
        Object.defineProperty(target.selection.project, 'name', { enumerable: true, get() { invoked++; return name; } });
      }
      const outcome = await pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      expect(invoked).toBe(0);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toEqual(expected);
    }
  );

  it.each(['manifest', 'nestedManifest', 'sourceBinding', 'sourceBytes', 'targetBytes', 'preparation'] as const)(
    'isolates caller %s before preparation replay yields', async field => {
      const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root);
      const original = await planModernActivationSuccessor(source, targetFor(source));
      const plan = { ...original, manifest: structuredClone(original.manifest) };
      const supplied = preparation(source), bytes = Buffer.from(plan.manifest.content);
      const expected = await prepareActivationHistorySuccessor(plan, bytes, supplied, observedAt);
      const pending = prepareActivationHistorySuccessor(plan, bytes, supplied, observedAt);
      let invoked = 0;
      if (field === 'manifest') {
        const manifest = plan.manifest;
        Object.defineProperty(plan, 'manifest', { enumerable: true, get() { invoked++; return manifest; } });
      }
      if (field === 'nestedManifest') {
        const content = plan.manifest.content;
        Object.defineProperty(plan.manifest, 'content', { enumerable: true, get() { invoked++; return content; } });
      }
      if (field === 'sourceBinding') {
        const binding = plan.source.sourceBinding;
        Object.defineProperty(plan.source, 'sourceBinding', { enumerable: true, get() { invoked++; return binding; } });
      }
      if (field === 'sourceBytes') plan.source.indexContent.fill(0);
      if (field === 'targetBytes') bytes.fill(0);
      if (field === 'preparation') {
        const time = supplied.preparedAt;
        Object.defineProperty(supplied, 'preparedAt', { enumerable: true, get() { invoked++; return time; } });
      }
      const outcome = await pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      expect(invoked).toBe(0);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toEqual(expected);
    }
  );

  it.each(['ancestor-index', 'ancestor-copy', 'ancestor-slot', 'ancestor-path'] as const)(
    'owns complete original %s data before ancestor validation yields', async mutation => {
      const { root, state } = await fixture(3), original = capturedV3Successor(2);
      historyRecord(state, 'state').successorHistory = original.state.successorHistory;
      await writeFixtureBytes(root, ['governance', 'activation-state.json'], JSON.stringify(state));
      await writeFixtureBytes(root, ['governance', 'migration-state.json'], JSON.stringify(original.journal));
      await writeFixtureBytes(root, original.journal.historyIndexPathParts, original.indexContent);
      for (const entry of original.index.files) {
        await writeFixtureBytes(root, entry.copyPathParts, original.files.get(entry.originalPathParts.join('/'))!);
      }
      const source = await readModernActivationSuccessorSource(root), target = targetFor(source);
      const expected = await planModernActivationSuccessor(source, target);
      const pending = planModernActivationSuccessor(source, target);
      let invoked = 0;
      const ancestor = source.ancestors[0];
      if (mutation === 'ancestor-index') ancestor.indexContent.fill(0);
      if (mutation === 'ancestor-copy') ancestor.copies[0].content!.fill(0);
      if (mutation === 'ancestor-slot') Object.defineProperty(source.ancestors, '0', { enumerable: true, get() { invoked++; return ancestor; } });
      if (mutation === 'ancestor-path') {
        const parts = ancestor.copies[0].pathParts;
        Object.defineProperty(ancestor.copies[0], 'pathParts', { enumerable: true, get() { invoked++; return parts; } });
      }
      const result = await pending;
      expect(result).toEqual(expected);
      expect(invoked).toBe(0);
    }
  );

  it.each([1, 2, 3] as const)('prepares exact v%s originals and real target bytes without writes/time/randomness', async version => {
    const { root } = await fixture(version), before = await hashes(root);
    const source = await readModernActivationSuccessorSource(root), target = targetFor(source);
    const plan = await planModernActivationSuccessor(source, target), issued = preparation(source);
    const first = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), issued, observedAt);
    const second = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), issued, observedAt);
    expect(first).toEqual(second);
    expect(first.manifestBytes.toString()).toBe(plan.manifest.content);
    expect(rawHistoryDigest(first.manifestBytes)).toBe(plan.manifest.digest);
    expect(first.manifestBytes.toString()).not.toBe(canonicalJson(plan.manifest.manifest));
    expect(first.successor.createdAt).toBe(preparedAt);
    expect(first.successor.activeChange).toBeNull();
    expect(Object.values(first.successor.phases).every(phase => phase.state === 'pending' && !phase.evidence.length && !phase.approvals.length)).toBe(true);
    expect(first.successor).not.toHaveProperty('remoteBinding');
    expect(first.journal).not.toHaveProperty('transaction');
    expect(first.journal).not.toHaveProperty('approvedPlanFingerprint');
    expect(first.journal.semanticTransitionDigest).toBe(canonicalSha256(first.journal.semanticInput));
    expect(first.journal.revalidation.phases.map(phase => phase.phaseId)).toEqual(['local-inputs-valid', 'local-baseline-verified', 'local-complete']);
    expect(first.journal.revalidation.status).toBe('pending');
    expect(() => validateMigrationJournal(first.journal)).toThrow();
    const compat = createModernCompatibilityContract({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
    expect(canonicalJson(compat.buildModernCompatibilityMetadata(plan.manifest.manifest))).toBe(
      canonicalJson(compat.buildModernCompatibilityMetadataForSource({ selection: target.selection, plugins: target.plugins, activeLayout: target.activeLayout })));
    expect(await hashes(root)).toEqual(before);
    expect(first.mutations.filter(mutation => mutation.type === 'write' && mutation.pathParts.includes('files')).length).toBe(source.originalPaths.length);
  });

  it.each(['missing', 'changed-bytes', 'retain-absent', 'manifest-bytes', 'plan-binding', 'source-buffer', 'source-mode', 'hook', 'anchor', 'future'] as const)(
    'rejects altered or incomplete %s with no project effects', async failure => {
      const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
      if (failure === 'missing' || failure === 'changed-bytes' || failure === 'retain-absent') {
        const altered = structuredClone(target);
        if (failure === 'missing') Reflect.set(altered, 'managed', altered.managed.slice(1));
        if (failure === 'changed-bytes') Reflect.set(altered.managed[0], 'content', 'valid-looking but not actual G1');
        if (failure === 'retain-absent') Reflect.set(altered, 'managed', altered.managed.map((entry, i) => i ? entry : { kind: 'retain', logicalName: entry.logicalName }));
        await expect(planModernActivationSuccessor(source, altered)).rejects.toThrow();
        return;
      }
      const plan = await planModernActivationSuccessor(source, target), issued = preparation(source);
      let bytes = Buffer.from(plan.manifest.content);
      let hookInvoked = false;
      if (failure === 'manifest-bytes') bytes = Buffer.concat([bytes, Buffer.from(' ')]);
      if (failure === 'plan-binding') Reflect.set(plan, 'planBinding', 'f'.repeat(64));
      if (failure === 'source-buffer') plan.source.captures.find(file => file.content)!.content![0] = 120;
      if (failure === 'source-mode') Reflect.set(plan.source.captures.find(file => file.content)!, 'mode', 0o777);
      if (failure === 'hook') Object.defineProperty(plan.target, 'managed', { enumerable: true, get() { hookInvoked = true; throw new Error('hook invoked'); } });
      if (failure === 'anchor') issued.localRepositoryId = 'local:33333333-3333-4333-8333-333333333333';
      if (failure === 'future') issued.preparedAt = '2027-01-01T00:00:00.000Z';
      await expect(prepareActivationHistorySuccessor(plan, bytes, issued, observedAt)).rejects.toThrow();
      expect(hookInvoked).toBe(false);
    }
  );

  it('requires actual complete managed bodies even though W1 can represent a partial handoff', async () => {
    const fixtureSource = await fixture(3), raw = historyRecord(fixtureSource.manifest, 'manifest');
    const artifacts = raw.managedArtifacts;
    if (!Array.isArray(artifacts)) throw new Error('Expected original manifest artifact inventory.');
    raw.managedArtifacts = artifacts.filter(entry => historyRecord(entry, 'artifact').logicalName !== 'repository-governance-guide');
    historyRecord(raw.governance, 'governance').state = 'handoff-partial';
    await writeFixtureBytes(fixtureSource.root, ['liftoff.manifest.json'], JSON.stringify(raw));
    const source = await readModernActivationSuccessorSource(fixtureSource.root), target = targetFor(source);
    const incomplete = target.managed.filter(entry => entry.logicalName !== 'repository-governance-guide');
    const snapshot = historyRecord(parseHistoryJson(source.indexContent, 'index'), 'index');
    const partial = createManifestV8Candidate({ origin: 'historical-successor', source: raw,
      profile: 'single-maintainer-gitflow', activeLayout: target.activeLayout, managed: incomplete,
      sourceManifestHistory: { schemaVersion: 1, kind: 'activation-history', snapshotId: snapshot.snapshotId, indexDigest: rawHistoryDigest(source.indexContent) } });
    expect(partial.manifest.governance.state).toBe('handoff-partial');
    await expect(planModernActivationSuccessor(source, { ...target, managed: incomplete })).rejects.toThrow(/prerequisite/);
  });

  it('preserves actual Spec Kit/custom layout intent and rejects implicit workflow or profile conversion', async () => {
    const { root, manifest } = await fixture(3), raw = historyRecord(manifest, 'manifest');
    const project = historyRecord(raw.project, 'project'), framework = historyRecord(raw.framework, 'framework');
    project.specWorkflow = 'spec-kit';
    if (!Array.isArray(project.agents) || !project.agents.length) throw new Error('Expected original selected agent.');
    project.defaultAgent = project.agents[0];
    framework.adapter = 'spec-kit';
    await writeFixtureBytes(root, ['liftoff.manifest.json'], JSON.stringify(raw));
    const source = await readModernActivationSuccessorSource(root), originalTarget = targetFor(source);
    const layout = { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['Original Services', 'API'] }] };
    const alteredContext = { selection: originalTarget.selection, plugins: originalTarget.plugins, activeLayout: layout };
    const actualCore = buildModernManagedCore(alteredContext);
    const target: ModernSuccessorTarget = { ...originalTarget,
      activeLayout: { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['Original Services', 'API'] }] },
      managed: actualCore.map(artifact => ({ kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts, content: artifact.content })) };
    const plan = await planModernActivationSuccessor(source, target);
    expect(plan.manifest.manifest.project.specWorkflow).toBe('spec-kit');
    expect(plan.manifest.manifest.activeLayout).toEqual(layout);
    const changed = structuredClone(target); Reflect.set(changed.selection, 'profile', 'team-gitflow');
    await expect(planModernActivationSuccessor(source, changed)).rejects.toThrow(/cannot switch/);
    const manual = structuredClone(target); Reflect.set(manual.selection.project, 'specWorkflow', 'manual');
    await expect(planModernActivationSuccessor(source, manual)).rejects.toThrow(/cannot switch/);
  });

  it('uses a supplied genuine new local anchor only when the original v1 anchor is not protected', async () => {
    const { root, state } = await fixture(1);
    historyRecord(historyRecord(state, 'state').repository, 'repository').id = 'original-remote-repository';
    await writeFixtureBytes(root, ['governance', 'activation-state.json'], JSON.stringify(state));
    const source = await readModernActivationSuccessorSource(root), plan = await planModernActivationSuccessor(source, targetFor(source));
    const issued = preparation(source);
    const prepared = await prepareActivationHistorySuccessor(plan, new Uint8Array(Buffer.from(plan.manifest.content)), issued, observedAt);
    expect(prepared.successor.repository.id).toBe(issued.localRepositoryId);
    expect(prepared.successor.repository.id).not.toBe('original-remote-repository');
    expect(prepared.successor).not.toHaveProperty('remoteBinding');
    expect(() => validateSuccessorPreparation({ ...issued, localRepositoryId: 'local:not-a-uuid' }, observedAt)).toThrow();
  });

  it.each(['retained', 'disposed'] as const)('preserves original %s obligations and retires only exact captured active proof', async retention => {
    const { root, state } = await fixture(2), originalState = historyRecord(state, 'state');
    const sample = capturedV3Successor(2);
    const file = sample.index.files.find(entry => entry.kind === 'evidence')!;
    const originalProof = validateHistoricalV2EvidenceRecord(parseHistoryJson(sample.files.get(file.originalPathParts.join('/'))!, 'proof'));
    const phases = retention === 'disposed' ? ['remote-import-verified', 'bootstrap-state-disposed'] as const : ['remote-import-verified'] as const;
    let importHeaderDigest = '';
    for (const id of phases) {
      const payload = { kind: `${id}.v1` }, result = id === 'remote-import-verified' ? 'verified' : 'disposed';
      const header = { ...originalProof.header, phaseId: id, phaseContractDigest: historicalV2PhaseContractDigest(id),
        transition: { ...originalProof.header.transition, phaseId: id }, result,
        producer: 'synthetic-original-lifecycle', bodyDigest: historicalV2EvidenceBodyDigest(payload) };
      const proof = validateHistoricalV2EvidenceRecord({ evidenceId: `original-${id}`, header, payload });
      const digest = canonicalSha256(proof.header);
      if (id === 'remote-import-verified') importHeaderDigest = digest;
      Object.assign(historyRecord(historyRecord(originalState.phases, 'phases')[id], 'phase'), {
        state: result, evidence: [{ phaseId: id, evidenceId: proof.evidenceId, headerDigest: digest, result }]
      });
      await writeFixtureBytes(root, ['governance', 'evidence', `${proof.evidenceId}.json`], canonicalJson(proof));
    }
    historyRecord(originalState.applicability, 'applicability').statePath = 'bootstrap-local';
    originalState.bootstrapState = { status: retention, remoteImportEvidenceId: 'original-remote-import-verified',
      remoteImportEvidenceDigest: importHeaderDigest, retainedAt: '2026-08-01T00:00:00.000Z',
      disposeAfter: '2026-08-31T00:00:00.000Z', encryptedStatePathParts: [['protected', 'state.enc']], encryptionKeyPathParts: [['protected', 'key']],
      ...(retention === 'disposed' ? { disposedAt: '2026-09-01T00:00:00.000Z', deletionEvidenceId: 'original-bootstrap-state-disposed' } : {}) };
    await writeFixtureBytes(root, ['governance', 'activation-state.json'], canonicalJson(originalState));
    const source = await readModernActivationSuccessorSource(root), before = await hashes(root);
    const plan = await planModernActivationSuccessor(source, targetFor(source));
    const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation(source), observedAt);
    expect(prepared.lifecycleObligations).toHaveLength(1);
    const original = historyRecord(parseHistoryJson(source.captures.find(file => file.pathParts.join('/') === 'governance/activation-state.json')!.content!, 'state'), 'state');
    expect(prepared.lifecycleObligations[0].retention).toEqual(original.bootstrapState);
    expect(prepared.lifecycleObligations[0].authority).toBe('historical-protection-only');
    expect(prepared.successor).not.toHaveProperty('bootstrapState');
    expect(prepared.requiredRetirements.length).toBeGreaterThan(0);
    for (const retirement of prepared.requiredRetirements) {
      const captured = source.captures.find(file => file.pathParts.join('/') === retirement.pathParts.join('/'))!;
      const copy = prepared.mutations.find(mutation => mutation.type === 'write' && mutation.pathParts.join('/') === retirement.copyPathParts.join('/'));
      if (!copy || copy.type !== 'write') throw new Error('Original must be preserved before exact retirement.');
      expect(Buffer.from(copy.content)).toEqual(captured.content);
      expect(rawHistoryDigest(captured.content!)).toBe(retirement.digest);
    }
    expect(source.captures.some(file => file.pathParts.some(part => part.endsWith('.enc') || part === 'key'))).toBe(false);
    expect(await hashes(root)).toEqual(before);
  });

  it('accepts retained managed content only when actual captured bytes match both the original hash and G1 output', async () => {
    const { root, manifest } = await fixture(3);
    const first = await readModernActivationSuccessorSource(root), firstTarget = targetFor(first);
    const guide = firstTarget.managed.find(entry => entry.kind === 'bytes' && entry.logicalName === 'repository-governance-guide');
    if (!guide || guide.kind !== 'bytes') throw new Error('Expected actual G1 guide.');
    await writeFixtureBytes(root, guide.pathParts, guide.content);
    const raw = historyRecord(manifest, 'manifest');
    if (!Array.isArray(raw.managedArtifacts)) throw new Error('Expected original inventory.');
    const declaration = raw.managedArtifacts.map(entry => historyRecord(entry, 'artifact')).find(entry => entry.logicalName === guide.logicalName)!;
    declaration.contentHash = `sha256:${rawHistoryDigest(Buffer.from(guide.content))}`;
    await writeFixtureBytes(root, ['liftoff.manifest.json'], JSON.stringify(raw));
    const source = await readModernActivationSuccessorSource(root), target = targetFor(source);
    const retained = { ...target, managed: target.managed.map(entry => entry.logicalName === guide.logicalName
      ? { kind: 'retain' as const, logicalName: entry.logicalName } : entry) };
    expect((await planModernActivationSuccessor(source, retained)).manifest.manifest.managedArtifacts
      .find(entry => entry.logicalName === guide.logicalName)!.contentHash).toBe(declaration.contentHash);
    await fs.appendFile(path.join(root, ...guide.pathParts), 'tampered');
    const changed = await readModernActivationSuccessorSource(root);
    await expect(planModernActivationSuccessor(changed, retained)).rejects.toThrow(/retained hash/);
  });

  it('distinguishes semantic T from concrete supplied preparation and retains original manifest history', async () => {
    const { root } = await fixture(2), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
    const plan = await planModernActivationSuccessor(source, target), original = preparation(source);
    const first = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), original, observedAt);
    const second = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content),
      { ...original, preparationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', preparedAt: '2026-09-01T13:00:00.000Z' }, observedAt);
    expect(second.semanticTransitionDigest).toBe(first.semanticTransitionDigest);
    expect(canonicalSha256(second.successor)).not.toBe(canonicalSha256(first.successor));
    expect(canonicalSha256(second.journal)).not.toBe(canonicalSha256(first.journal));
    expect(second.manifestBytes).toEqual(first.manifestBytes);
    const maintained = createManifestV8Candidate({ origin: 'maintenance', source: plan.manifest.manifest,
      managed: plan.manifest.manifest.managedArtifacts.map(entry => ({ kind: 'retain', logicalName: entry.logicalName })) });
    expect(maintained.manifest.sourceManifestHistory).toEqual(plan.manifest.manifest.sourceManifestHistory);
    expect(() => validateSuccessorPreparation({ ...original, approvedPlanFingerprint: 'a'.repeat(64) }, observedAt)).toThrow();
    first.manifestBytes.fill(0);
    const again = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), original, observedAt);
    expect(again.manifestBytes.toString()).toBe(plan.manifest.content);
  });

  describe('actual S1/S2 all-effects admission is separate from source preservation', () => {
    function allEffects(prepared: Awaited<ReturnType<typeof prepareActivationHistorySuccessor>>, target: ModernSuccessorTarget): ProjectFileMutation[] {
      const managed = target.managed.flatMap((entry): ProjectFileMutation[] =>
        entry.kind === 'bytes' ? [{ type: 'write', pathParts: [...entry.pathParts], content: entry.content }] : []);
      return [...managed, ...prepared.mutations.map(mutation => ({ ...mutation, pathParts: [...mutation.pathParts] })),
        { type: 'write', pathParts: ['liftoff.manifest.json'], content: prepared.manifestBytes }];
    }
    it('admits every actual managed/history/state/journal/manifest body and binds changed preparation independently of semantic T', async () => {
      const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
      const plan = await planModernActivationSuccessor(source, target), supplied = preparation(source);
      const first = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), supplied, observedAt);
      const second = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content),
        { ...supplied, preparationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, observedAt);
      const before = await hashes(root), mutations = allEffects(first, target);
      const candidate = await inspectReviewedUpdateCandidate(source.projectRoot, mutations, first.preconditions);
      const changed = await inspectReviewedUpdateCandidate(source.projectRoot, allEffects(second, target), second.preconditions);
      expect(candidate.payload.mutations).toHaveLength(mutations.length);
      expect(candidate.size.kind).toBe('journal');
      expect(candidate.binding).not.toBe(changed.binding);
      expect(first.semanticTransitionDigest).toBe(second.semanticTransitionDigest);
      expect(candidate.payload.mutations.find(entry => entry.pathParts.join('/') === 'governance/migration-state.json')!.target.kind).toBe('file');
      expect(candidate).not.toHaveProperty('approved');
      expect(await hashes(root)).toEqual(before);
    });
    it.each([0, 1])('tests exact16MiB transaction snapshots using actual successor bytes, excess=%s', async excess => {
      const { root } = await fixture(3);
      await writeFixtureBytes(root, ['.liftoff', 'governance', 'policy.md'], Buffer.alloc(4 * 1024 * 1024, 120));
      await writeFixtureBytes(root, ['liftoff.config.json'], '{}');
      const source = await readModernActivationSuccessorSource(root), target = targetFor(source), plan = await planModernActivationSuccessor(source, target);
      const first = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation(source), observedAt);
      const inspected = await inspectReviewedUpdateCandidate(source.projectRoot, allEffects(first, target), first.preconditions);
      const padding = reviewedJournalLimits.snapshotBytes - inspected.size.snapshotBytes + excess;
      expect(padding).toBeGreaterThan(0);
      expect(padding + 2).toBeLessThanOrEqual(reviewedJournalLimits.fileBytes);
      await writeFixtureBytes(root, ['liftoff.config.json'], '{}' + ' '.repeat(padding));
      const actual = await readModernActivationSuccessorSource(root), nextTarget = targetFor(actual), nextPlan = await planModernActivationSuccessor(actual, nextTarget);
      const next = await prepareActivationHistorySuccessor(nextPlan, Buffer.from(nextPlan.manifest.content), preparation(actual), observedAt);
      expect(actual.captures.reduce((sum, file) => sum + (file.content?.length ?? 0), 0)).toBeLessThan(32 * 1024 * 1024);
      const result = inspectReviewedUpdateCandidate(actual.projectRoot, allEffects(next, nextTarget), next.preconditions);
      if (excess) await expect(result).rejects.toThrow(/snapshots exceed/);
      else expect((await result).size.snapshotBytes).toBe(reviewedJournalLimits.snapshotBytes);
    }, 120_000);

    it('rejects a changed physical original before all-effects admission without using embedded history as write authority', async () => {
      const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
      const plan = await planModernActivationSuccessor(source, target);
      const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation(source), observedAt);
      await fs.appendFile(path.join(root, 'governance', 'activation-state.json'), ' ');
      await expect(inspectReviewedUpdateCandidate(source.projectRoot, allEffects(prepared, target), prepared.preconditions)).rejects.toThrow(/precondition|changed|differs/);
    });
  });

  it.each(['semantic', 'extra-approval', 'commit', 'prepared-time', 'progress'] as const)('rejects journal2 %s contradictions', async kind => {
    const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
    const plan = await planModernActivationSuccessor(source, target);
    const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation(source), observedAt);
    const manifest = plan.manifest.manifest;
    if (manifest.governance.profile === 'none') throw new Error('Expected enabled source.');
    const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
    const resolved = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile: manifest.governance.profile }, recordedPlugins: manifest.plugins });
    const contract = createModernHistoryContract(projectCatalog, { profile: manifest.governance.profile,
      policyVersion: manifest.governance.policyVersion, recordedIdentity: manifest.governance.activationIdentity,
      selection: { ...leaf, profile: manifest.governance.profile }, pluginResolutionDigest: manifest.plugins.resolutionDigest,
      activeLayoutDigest: manifestActiveLayoutDigest(manifest.activeLayout, resolved.layoutDescriptor) });
    const bad = structuredClone(prepared.journal);
    if (kind === 'semantic') Reflect.set(bad.semanticInput, 'targetManifestDigest', 'f'.repeat(64));
    if (kind === 'extra-approval') Reflect.set(bad, 'approvedPlanFingerprint', 'a'.repeat(64));
    if (kind === 'commit') Reflect.set(bad, 'transaction', { status: 'committed', committedAt: preparedAt });
    if (kind === 'prepared-time') Reflect.set(bad.successor, 'createdAt', observedAt);
    if (kind === 'progress') {
      Reflect.set(bad.revalidation, 'status', 'complete'); Reflect.set(bad.revalidation, 'nextAction', null);
      for (const entry of bad.revalidation.phases) { Reflect.set(entry, 'status', 'complete'); Reflect.set(entry, 'evidenceIds', ['absent']); }
    }
    expect(() => contract.readJournal(bad, plan.semanticInput, observedAt)).toThrow();
  });

  it.each(['blocked', 'running'] as const)('rejects missing evidence IDs in %s journal progress', async status => {
    const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root);
    const plan = await planModernActivationSuccessor(source, targetFor(source));
    const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation(source), observedAt);
    const manifest = plan.manifest.manifest;
    if (manifest.governance.profile === 'none') throw new Error('Expected enabled source.');
    const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
    const resolved = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile: manifest.governance.profile }, recordedPlugins: manifest.plugins });
    const context = { profile: manifest.governance.profile,
      policyVersion: manifest.governance.policyVersion, recordedIdentity: manifest.governance.activationIdentity,
      selection: { ...leaf, profile: manifest.governance.profile }, pluginResolutionDigest: manifest.plugins.resolutionDigest,
      activeLayoutDigest: manifestActiveLayoutDigest(manifest.activeLayout, resolved.layoutDescriptor) };
    const history = createModernHistoryContract(projectCatalog, context), records = createModernActivationRecordContract(projectCatalog, context);
    const progress = { state: prepared.successor, records: {} };
    const empty = { ...prepared.journal, revalidation: { ...prepared.journal.revalidation, status,
      phases: prepared.journal.revalidation.phases.map((phase, i) => i ? phase : { ...phase, status, blockers: ['observed incomplete work'] }) } };
    expect(() => history.readJournal(empty, plan.semanticInput, observedAt, progress)).not.toThrow();
    const missing = { ...empty, revalidation: { ...empty.revalidation,
      phases: empty.revalidation.phases.map((phase, i) => i ? phase : { ...phase, evidenceIds: ['nonexistent-proof'] }) } };
    expect(() => history.readJournal(missing, plan.semanticInput, observedAt, progress)).toThrow(/proof|evidence|reference/);
    const phaseId = 'local-inputs-valid';
    const localPlan = records.createPlan({
      phaseId, createdAt: preparedAt, expiresAt: observedAt, stateHash: null,
      baselineDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64),
      operations: [], noSecrets: true,
      rollbackPlan: { phaseId, strategy: 'none', target: null, operations: [], retained: [], cleanupWarnings: [] },
      approval: { gateKind: 'none', required: false, envelopeId: null, envelopeHash: null,
        evaluation: { phaseId, gateKind: 'none', questionKind: null, approvalRequired: false, status: 'not-required',
          envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } }
    });
    const failure = records.createEvidence({ plan: localPlan, evidenceId: 'actual-original-failure',
      repositoryId: prepared.successor.repository.id, producedAt: preparedAt, producer: 'synthetic-check-outcome',
      result: 'failed', payload: { diagnostic: 'original unsuccessful local operation' } });
    const related = { plans: [localPlan], evidence: [failure] };
    const state = records.stateAfterOutcome({ state: prepared.successor, plan: localPlan, phaseState: 'failed',
      evidenceId: failure.evidenceId, updatedAt: preparedAt }, related);
    const named = { ...empty, revalidation: { ...empty.revalidation, phases: empty.revalidation.phases.map((phase, i) =>
      i ? phase : { ...phase, evidenceIds: [failure.evidenceId] }) } };
    expect(history.readJournal(named, plan.semanticInput, observedAt, { state, records: related }).revalidation.status).toBe(status);
    expect(() => history.readJournal(named, plan.semanticInput, observedAt,
      { state: prepared.successor, records: related })).toThrow(/state\/header/);
    const wrongPhase = { ...named, revalidation: { ...named.revalidation, phases: named.revalidation.phases.map((phase, i) =>
      i === 0 ? { ...phase, evidenceIds: [] } : i === 1 ? { ...phase, status, evidenceIds: [failure.evidenceId], blockers: ['observed'] } : phase) } };
    expect(() => history.readJournal(wrongPhase, plan.semanticInput, observedAt, { state, records: related })).toThrow(/same-phase/);
    const falseComplete = { ...named, revalidation: { ...named.revalidation, phases: named.revalidation.phases.map((phase, i) =>
      i === 0 ? { ...phase, status: 'complete', blockers: [] } : i === 1 ? { ...phase, status, blockers: ['observed'] } : phase) } };
    expect(() => history.readJournal(falseComplete, plan.semanticInput, observedAt, { state, records: related })).toThrow(/same-phase/);
  });

  it('validates actual supplied completed local records without treating current phase freshness as journal progress', async () => {
    const { root } = await fixture(3), source = await readModernActivationSuccessorSource(root), target = targetFor(source);
    const plan = await planModernActivationSuccessor(source, target), issued = preparation(source);
    const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), issued, observedAt);
    const manifest = plan.manifest.manifest;
    if (manifest.governance.profile === 'none') throw new Error('Expected enabled source.');
    const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
    const resolved = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile: manifest.governance.profile }, recordedPlugins: manifest.plugins });
    const context = { profile: manifest.governance.profile, policyVersion: manifest.governance.policyVersion,
      recordedIdentity: manifest.governance.activationIdentity, selection: { ...leaf, profile: manifest.governance.profile },
      pluginResolutionDigest: manifest.plugins.resolutionDigest, activeLayoutDigest: manifestActiveLayoutDigest(manifest.activeLayout, resolved.layoutDescriptor) };
    const history = createModernHistoryContract(projectCatalog, context), records = createModernActivationRecordContract(projectCatalog, context);
    const plans: ModernSavedTransitionPlan[] = [], proofs: ModernEvidenceRecord[] = [];
    let state = prepared.successor;
    for (const id of ['local-inputs-valid', 'local-baseline-verified', 'local-complete'] as const) {
      const phase = records.graph.phases.find(phase => phase.id === id)!;
      const input: ModernPlanInput = { phaseId: id, createdAt: preparedAt, expiresAt: observedAt, stateHash: null,
        baselineDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), transitionDigest: canonicalSha256({ phase: id }),
        operations: [], noSecrets: true, rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
        approval: { required: false, gateKind: 'none', envelopeId: null, envelopeHash: null, evaluation: {
          phaseId: id, gateKind: 'none', questionKind: null, approvalRequired: false, status: 'not-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: []
        } } };
      const local = records.createPlan(input);
      const baseline = proofs.find(proof => proof.header.phaseId === 'local-baseline-verified');
      const payload = id === 'local-baseline-verified' ? { kind: `${id}.v1`, checks: [{ id: 'actual-fixture', status: 'passed' }] } :
        id === 'local-complete' ? { kind: `${id}.v1`, schemaVersion: 1, workflow: context.selection.project.specWorkflow,
          frameworkValidation: 'verified', frameworkFinalization: context.selection.project.specWorkflow === 'openspec' ? 'synced-archived' : 'finalized',
          baselineEvidenceId: baseline!.evidenceId, baselineHeaderDigest: canonicalSha256(baseline!.header) } : { kind: `${id}.v1` };
      const proof = records.createEvidence({ plan: local, evidenceId: `local-proof-${id}`, repositoryId: state.repository.id,
        producedAt: preparedAt, producer: 'synthetic-completed-check', result: 'verified', payload }, { plans, evidence: proofs });
      plans.push(local); proofs.push(proof);
      state = records.stateAfterOutcome({ state, plan: local, phaseState: 'verified', evidenceId: proof.evidenceId, updatedAt: preparedAt }, { plans, evidence: proofs });
    }
    const completed = { ...prepared.journal, revalidation: { status: 'complete', updatedAt: preparedAt, nextAction: null,
      phases: prepared.journal.revalidation.phases.map(phase => ({ ...phase, status: 'complete', evidenceIds: [`local-proof-${phase.phaseId}`] })) } };
    const refs: ModernRelatedRecords = { plans, evidence: proofs };
    expect(history.readJournal(completed, plan.semanticInput, observedAt, { state, records: refs }).revalidation.status).toBe('complete');
    const blocked = structuredClone(state);
    blocked.phases['local-complete'].state = 'blocked';
    expect(history.readJournal(completed, plan.semanticInput, observedAt, { state: blocked, records: refs }).revalidation.status).toBe('complete');
    expect(() => history.readJournal(completed, plan.semanticInput, observedAt, { state, records: { plans, evidence: proofs.slice(0, -1) } })).toThrow();
  });
});
