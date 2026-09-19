import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evidenceBodyDigest, evidenceContextForPhase, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { remoteBindingDigest } from '../src/domain/governance/activation/inputs.js';
import { savedPlanAuthorityDigest } from '../src/domain/governance/activation/approvals.js';
import { planDigestFor } from '../src/domain/governance/activation/operations.js';
import type { PhaseEvidenceRecord, SavedTransitionPlan, UserActivationState } from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { parseManifest } from '../src/application/project/manifest.js';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { historicalPhaseIds } from '../src/governance-activation/historical-state.js';
import {
  activationHistoryIndexPathParts, activationHistorySnapshotId, activationHistoryCopyPathParts,
  historicalSourceChangePathParts, validateActivationHistoryIndex
} from '../src/governance-activation/history-contracts.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { planHistoricalActivationStateMigration } from '../src/governance-activation/migration.js';
import { validateHistoricalGovernanceChangeMetadata } from '../src/governance-activation/historical-source-metadata.js';
import { assertSafeHistoricalBytes } from '../src/governance-activation/historical-safety.js';
import {
  buildApprovedPhase0FactsFromState, inspectGovernanceSourceOfTruth, reconcileActiveGovernanceChange,
  renderGovernanceChangeWritePlan, stateWithSelectedActiveChange, writeGovernanceChangeArtifacts
} from '../src/governance-activation/source-of-truth.js';
import { projectGovernanceChangeTasks } from '../src/governance-activation/task-projection.js';
import { calculateGraphReconciliation } from '../src/governance-activation/reconciliation.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';
import { successorFixtureManifest, fixtureSubscription } from './governance-activation-fixtures.js';

const roots = new Set<string>();
const now = new Date('2026-09-12T00:00:00.000Z');
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
async function put(root: string, parts: readonly string[], value: unknown) {
  const destination = path.join(root, ...parts);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, typeof value === 'string' ? value : canonicalJson(value));
}

async function migrated(family: 1 | 2 = 2, workflow: 'openspec' | 'spec-kit' = 'openspec', withPointer = true) {
  const root = path.resolve('tests', `.activation-successor-source-${process.pid}-${randomUUID()}`);
  roots.add(root);
  const source = family === 1 ? await writeHistoricalV1Fixture(root) : await writeHistoricalV2Fixture(root);
  const pointer = withPointer ? { id: 'historical-governance', kind: workflow } : null;
  const manifest = {
    ...source.manifest,
    project: { ...source.manifest.project, specWorkflow: workflow, ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) },
    framework: { ...source.manifest.framework, adapter: workflow }
  };
  const oldState = { ...source.state, activeChange: pointer };
  await put(root, ['liftoff.manifest.json'], manifest);
  await put(root, ['liftoff.config.json'], {
    ...JSON.parse(source.files.get('liftoff.config.json')!.toString('utf8')), specWorkflow: workflow,
    ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {})
  });
  await put(root, ['governance', 'activation-state.json'], oldState);
  const historicalMetadata = validateHistoricalGovernanceChangeMetadata({
    schemaVersion: 1, marker: 'liftoff-governance-source-of-truth', changeId: pointer?.id ?? 'not-active', workflowKind: workflow,
    activationIdentity: source.state.identity, phaseGraphHash: source.state.identity.phaseGraphHash,
    baselineSha: 'a'.repeat(64),
    phaseTaskMapping: historicalPhaseIds.map((phaseId, index) => ({
      phaseId, taskId: `${index + 1}.1`, marker: `<!-- liftoff-phase: ${phaseId} -->`, policy: 'evidence-projection-v1'
    })),
    currentPolicy: { phaseAuthority: 'managed-phase-graph', taskCompletion: 'authoritative-evidence-projection', approvalPolicy: 'approval-envelope-required-for-gated-phases' },
    createdFrom: { kind: 'approved-phase-0-facts', approvedFactDigest: 'b'.repeat(64), evidenceIds: [] },
    acknowledgedAt: '2026-09-01T00:00:00.000Z', owner: 'historical-maintainer'
  });
  const oldTasks = historicalMetadata.phaseTaskMapping.map((mapping) =>
    `- [x] ${mapping.taskId} Historical task ${mapping.marker}\r\n`).join('');
  const oldMetadataBytes = Buffer.from(`${JSON.stringify(historicalMetadata, null, '\t')}\r\n`);
  if (pointer) {
    const base = historicalSourceChangePathParts(pointer);
    await mkdir(path.join(root, ...base), { recursive: true });
    await writeFile(path.join(root, ...base, 'liftoff-governance.json'), oldMetadataBytes);
    await put(root, [...base, 'tasks.md'], oldTasks);
  }
  const plan = await planActivationHistoryMigration(root);
  if (plan.status !== 'eligible') throw new Error(JSON.stringify(plan));
  const result = finalizeActivationHistoryMigration(plan, canonicalSha256({ approved: plan.planDigest }), now);
  for (const mutation of result.mutations) {
    if (mutation.type === 'delete') await unlink(path.join(root, ...mutation.pathParts));
    else {
      await mkdir(path.dirname(path.join(root, ...mutation.pathParts)), { recursive: true });
      await writeFile(path.join(root, ...mutation.pathParts), mutation.content, { mode: mutation.mode });
    }
  }
  const currentManifest = await successorFixtureManifest(root);
  await put(root, ['liftoff.manifest.json'], currentManifest);
  await put(root, ['.liftoff', 'governance', 'phase-graph.json'], canonicalPhaseGraph);
  return { root, plan, result, source, pointer, historicalMetadata, oldMetadataBytes, oldTasks, manifest: currentManifest };
}

function phase0(state: UserActivationState) {
  state.remoteBinding = {
    id: 'R_NEW', name: 'example-org/flight-log', defaultBranch: 'develop',
    pushUrl: 'https://github.com/example-org/flight-log.git', verifiedAt: now.toISOString()
  };
  const context = evidenceContextForPhase('phase-0-complete', {
    repositoryId: state.repository.id, baselineSha: 'a'.repeat(64), inputDigest: 'c'.repeat(64),
    remoteBindingDigest: remoteBindingDigest(state.remoteBinding), now: new Date(now.getTime() + 60_000)
  });
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'phase-0-complete')!;
  const plan: SavedTransitionPlan = {
    schemaVersion: 2, scope: 'activation', phaseId: phase.id, identity: currentActivationIdentity,
    graphHash: currentActivationIdentity.phaseGraphHash, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    stateHash: canonicalSha256(state), baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest, planDigest: '0'.repeat(64), mutationClasses: phase.allowedMutations,
    operations: [{
      adapter: 'github', actionId: 'github.phase0.discover', mutationClass: 'github-read', phaseId: phase.id,
      inputs: {}, destination: { type: 'repository', identity: 'example-org/flight-log', repository: 'example-org/flight-log' },
      remote: true, destructive: false
    }, {
      adapter: 'azure-opentofu', actionId: 'azure.phase0.discover', mutationClass: 'azure-read', phaseId: phase.id,
      inputs: {}, destination: { type: 'subscription', identity: fixtureSubscription, subscriptionId: fixtureSubscription },
      remote: true, destructive: false
    }],
    approval: {
      gateKind: 'none', required: false, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: phase.id, gateKind: 'none', questionKind: null, approvalRequired: false, status: 'not-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] }
    },
    rollbackPlan: { phaseId: phase.id, strategy: 'none', target: null, operations: [], retained: [], cleanupWarnings: [] }, noSecrets: true
  };
  plan.planDigest = planDigestFor({ phase, operations: plan.operations, transitionDigest: plan.transitionDigest, approvalPlanDigest: savedPlanAuthorityDigest(plan, phase) });
  const payload = {
    kind: 'phase-0-discovery.v1', planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
    facts: [{ id: 'repository.id', value: 'R_NEW' }, { id: 'repository.nameWithOwner', value: 'example-org/flight-log' }, { id: 'repository.defaultBranch', value: 'develop' },
      { id: 'azure.accountReadable', value: true }, { id: 'azure.accountState', value: 'Enabled' },
      { id: 'azure.subscriptionId', value: fixtureSubscription }, { id: 'azure.tenantId', value: fixtureSubscription }]
  };
  const liveReadback = [{
    schemaVersion: 4, repositoryId: state.repository.id, identity: currentActivationIdentity,
    phaseGraphHash: currentActivationIdentity.phaseGraphHash, phaseId: phase.id,
    baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
    observedAt: now.toISOString(), provider: 'github' as const, resourceType: 'repository', resourceId: 'example-org/flight-log',
    sourceDigest: canonicalSha256(payload.facts), readbackDigest: canonicalSha256(payload.facts), matches: true
  }];
  liveReadback.push({
    ...liveReadback[0], provider: 'azure' as never, resourceType: 'subscription',
    resourceId: `/subscriptions/${fixtureSubscription}`
  });
  const record: PhaseEvidenceRecord = {
    evidenceId: 'fresh-phase0', payload, liveReadback,
    header: {
      schemaVersion: 4, scope: 'activation', repositoryId: state.repository.id, identity: currentActivationIdentity,
      phaseGraphHash: currentActivationIdentity.phaseGraphHash, phaseId: phase.id,
      phaseContractDigest: context.phaseContractDigest, baselineSha: context.baselineSha, inputDigest: context.inputDigest,
      transition: context.transition, producedAt: now.toISOString(), producer: 'fixture-observer', result: 'verified',
      bodyDigest: evidenceBodyDigest(payload, liveReadback), remoteBindingDigest: context.remoteBindingDigest
    }
  };
  state.phases[phase.id] = {
    state: 'verified', updatedAt: now.toISOString(), approvals: [], blockers: [],
    evidence: [{ phaseId: phase.id, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
  };
  context.evidenceReferences = state.phases[phase.id].evidence;
  context.reviewedPlans = [plan];
  const freshness = validateEvidenceFreshness(record, context);
  expect(freshness, JSON.stringify(freshness)).toMatchObject({ valid: true });
  return { record, plan, context };
}

describe('immutable successor backlinks', () => {
  it('rejects state payloads embedded in otherwise textual historical tasks', () => {
    const tasks = '# Historical tasks\n```json\n{"version":4,"terraform_version":"1.9.0","serial":1,"lineage":"fixture","resources":[]}\n```\n';
    expect(() => assertSafeHistoricalBytes(Buffer.from(tasks), 'historical tasks')).toThrow(/prohibited sensitive content/);
  });
  it.each([1, 2] as const)('emits a verified source-v%s backlink without inheriting the active pointer', async (family) => {
    const f = await migrated(family);
    expect(f.result.successor.activeChange).toBeNull();
    expect(f.result.successor.successorHistory).toEqual({
      schemaVersion: 1, snapshotId: f.plan.index.snapshotId, journalPathParts: ['governance', 'migration-state.json'],
      historyIndexPathParts: activationHistoryIndexPathParts(f.plan.index.snapshotId),
      historyIndexDigest: f.plan.indexDigest, sourceActiveChange: f.pointer
    });
    expect((await inspectActivationMigrationHistory(f.root)).status).toBe('committed');
    const metadataCopy = f.plan.index.files.find((file) => file.kind === 'source-metadata')!;
    const tasksCopy = f.plan.index.files.find((file) => file.kind === 'source-tasks')!;
    expect(await readFile(path.join(f.root, ...metadataCopy.copyPathParts))).toEqual(f.oldMetadataBytes);
    expect(await readFile(path.join(f.root, ...tasksCopy.copyPathParts), 'utf8')).toBe(f.oldTasks);
  });

  it.each(['journal', 'index', 'metadata-copy'] as const)('never falls back to not-migrated when %s is missing', async (missing) => {
    const f = await migrated();
    const parts = missing === 'journal' ? ['governance', 'migration-state.json'] : missing === 'index'
      ? activationHistoryIndexPathParts(f.plan.index.snapshotId) : f.plan.index.files.find((file) => file.kind === 'source-metadata')!.copyPathParts;
    await unlink(path.join(f.root, ...parts));
    const before = await readFile(path.join(f.root, 'governance', 'activation-state.json'));
    await expect(inspectActivationMigrationHistory(f.root)).rejects.toThrow();
    await expect(loadActivationState(f.root)).rejects.toThrow();
    expect(await planActivationHistoryMigration(f.root)).toMatchObject({ status: 'blocked' });
    expect(await planHistoricalActivationStateMigration(f.root)).toMatchObject({ status: 'blocked' });
    expect(await readFile(path.join(f.root, 'governance', 'activation-state.json'))).toEqual(before);
  });

  it.each(['removed-link', 'changed-pointer', 'changed-digest'] as const)('rejects %s against independently read history', async (fault) => {
    const f = await migrated();
    const state = structuredClone(f.result.successor);
    if (fault === 'removed-link') delete state.successorHistory;
    else if (fault === 'changed-pointer') state.successorHistory!.sourceActiveChange = { id: 'invented-source', kind: 'openspec' };
    else state.successorHistory!.historyIndexDigest = 'f'.repeat(64);
    await put(f.root, ['governance', 'activation-state.json'], state);
    await expect(inspectActivationMigrationHistory(f.root)).rejects.toThrow(/backlink|sourceActiveChange/);
    expect(await planActivationHistoryMigration(f.root)).toMatchObject({ status: 'blocked', reasonCode: 'invalid-migration-successor' });
  });
});

describe('historical source separation and current creation', () => {
  it.each(['openspec', 'spec-kit'] as const)('keeps %s history separate, then offers a distinct current source after fresh Phase 0', async (workflow) => {
    const f = await migrated(2, workflow);
    const state = structuredClone(f.result.successor);
    let inspected = await inspectGovernanceSourceOfTruth({ projectRoot: f.root, manifest: f.manifest, state, evidence: [] });
    expect(inspected).toMatchObject({ status: 'none', candidates: [], createPlan: { status: 'blocked' }, historicalCandidates: [{ changeId: f.pointer!.id, status: 'historical' }] });
    const observed = phase0(state);
    await put(f.root, ['governance', 'activation-state.json'], validateUserActivationState(state));
    await put(f.root, ['governance', 'plans', 'fresh-phase0.json'], observed.plan);
    await put(f.root, ['governance', 'evidence', 'fresh-phase0.json'], observed.record);
    const input = { projectRoot: f.root, manifest: f.manifest, state, evidence: [observed.record], contexts: { 'phase-0-complete': observed.context } };
    inspected = await inspectGovernanceSourceOfTruth(input);
    expect(inspected).toMatchObject({ status: 'none', createPlan: { status: 'ready' } });
    const facts = buildApprovedPhase0FactsFromState(f.manifest, state, input.evidence, observed.context)!;
    const creation = renderGovernanceChangeWritePlan(facts);
    expect(creation.changeId).not.toBe(f.pointer!.id);
    if (inspected.status !== 'none') throw new Error('Expected current creation preview.');
    expect(creation.changeId).toBe(inspected.createPlan.changeId);
    expect(creation.metadata.activationIdentity).toEqual(currentActivationIdentity);
    expect(creation.metadata.phaseTaskMapping).toHaveLength(35);
    expect(creation.files.find((file) => file.pathParts.at(-1) === 'tasks.md')!.content).not.toContain('[x]');
    const projection = projectGovernanceChangeTasks(
      creation.files.find((file) => file.pathParts.at(-1) === 'tasks.md')!.content, creation.metadata,
      Object.fromEntries(canonicalPhaseGraph.phases.map((phase) => [phase.id, {
        state: phase.id === 'seed-valid' ? 'verified' as const : 'pending' as const
      }]))
    );
    expect(projection.changes).toHaveLength(1);
    const stale = { ...observed.context, inputDigest: 'd'.repeat(64) };
    expect(buildApprovedPhase0FactsFromState(f.manifest, state, input.evidence, stale)).toBeUndefined();
    await writeGovernanceChangeArtifacts(f.root, creation);
    const selected = await inspectGovernanceSourceOfTruth(input);
    expect(selected.status).toBe('selected');
    if (selected.status !== 'selected') throw new Error('Expected a current source.');
    expect(selected.selected.changeId).toBe(creation.changeId);
    const next = stateWithSelectedActiveChange(state, selected.selected);
    expect(next.successorHistory).toEqual(state.successorHistory);
    const original = historicalSourceChangePathParts(f.pointer!);
    expect(await readFile(path.join(f.root, ...original, 'liftoff-governance.json'))).toEqual(f.oldMetadataBytes);
    expect(await readFile(path.join(f.root, ...original, 'tasks.md'), 'utf8')).toBe(f.oldTasks);
    expect(() => projectGovernanceChangeTasks(f.oldTasks, f.historicalMetadata, {})).toThrow();
  });

  it('does not revive an old pointer or block current creation when the original source was archived', async () => {
    const f = await migrated();
    const original = historicalSourceChangePathParts(f.pointer!);
    const archive = path.join(f.root, 'openspec', 'changes', 'archive', `20260912-${f.pointer!.id}`);
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(path.join(f.root, ...original), archive);
    const state = { ...f.result.successor, activeChange: f.pointer };
    const result = await inspectGovernanceSourceOfTruth({ projectRoot: f.root, manifest: f.manifest, state, evidence: [] });
    expect(result).toMatchObject({ status: 'none', candidates: [], historicalCandidates: [{ status: 'historical' }] });
  });

  it('handles a v2 source whose retained active metadata still belongs to its verified v1 ancestor', async () => {
    const original = await migrated(1);
    const inventory = original.plan.index.files.filter((file) => !['source-metadata', 'source-tasks'].includes(file.kind));
    const snapshotId = activationHistorySnapshotId(original.plan.index.sourceIdentity, inventory);
    const index = validateActivationHistoryIndex({
      ...original.plan.index, snapshotId,
      files: inventory.map((file) => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
    });
    const root = path.resolve('tests', `.activation-successor-source-chain-${process.pid}-${randomUUID()}`);
    roots.add(root);
    const source = await writeHistoricalV2Fixture(root, { ancestor: {
      index, indexContent: Buffer.from(canonicalJson(index)),
      files: new Map(original.plan.inventory.files.map((file) => [file.pathParts.join('/'), file.content]))
    } });
    await put(root, ['governance', 'activation-state.json'], { ...source.state, activeChange: original.pointer });
    const base = historicalSourceChangePathParts(original.pointer!);
    await put(root, [...base, 'liftoff-governance.json'], original.oldMetadataBytes.toString('utf8'));
    await put(root, [...base, 'tasks.md'], original.oldTasks);
    const plan = await planActivationHistoryMigration(root);
    if (plan.status !== 'eligible') throw new Error(JSON.stringify(plan));
    const finalized = finalizeActivationHistoryMigration(plan, canonicalSha256({ approved: plan.planDigest }), now);
    for (const mutation of finalized.mutations) {
      if (mutation.type === 'delete') await unlink(path.join(root, ...mutation.pathParts));
      else {
        await mkdir(path.dirname(path.join(root, ...mutation.pathParts)), { recursive: true });
        await writeFile(path.join(root, ...mutation.pathParts), mutation.content, { mode: mutation.mode });
      }
    }
    const manifest = await successorFixtureManifest(root);
    await put(root, ['liftoff.manifest.json'], manifest);
    const view = await inspectGovernanceSourceOfTruth({ projectRoot: root, manifest, state: finalized.successor, evidence: [] });
    expect(view).toMatchObject({ status: 'none', candidates: [], historicalCandidates: [{ status: 'historical', changeId: original.pointer!.id }] });
    expect(await readFile(path.join(root, ...base, 'liftoff-governance.json'))).toEqual(original.oldMetadataBytes);
  });

  it('rejects current-header retagging at the preserved historical path', async () => {
    const f = await migrated();
    const current = renderGovernanceChangeWritePlan({
      projectName: 'Flight Log', repositoryId: f.result.successor.repository.id, repositoryName: 'example-org/flight-log',
      defaultBranch: 'develop', workflowKind: 'openspec', baselineSha: 'a'.repeat(64), evidenceIds: ['fresh'],
      approvedFacts: [], approvedAt: now.toISOString(), approver: 'current-review'
    });
    await put(f.root, [...historicalSourceChangePathParts(f.pointer!), 'liftoff-governance.json'], { ...current.metadata, changeId: f.pointer!.id });
    expect(await inspectGovernanceSourceOfTruth({ projectRoot: f.root, manifest: f.manifest, state: f.result.successor, evidence: [] }))
      .toMatchObject({ status: 'incompatible' });
    expect(() => stateWithSelectedActiveChange(f.result.successor, {
      status: 'compatible', changeId: f.pointer!.id, workflowKind: 'openspec', pathParts: historicalSourceChangePathParts(f.pointer!),
      metadata: { ...current.metadata, changeId: f.pointer!.id }, issues: []
    })).toThrow(/historical/);
  });

  it('does not preserve historical phase proof through injected graph reconciliation', async () => {
    const f = await migrated();
    expect(reconcileActiveGovernanceChange({ metadata: f.historicalMetadata, evidence: [] }))
      .toMatchObject({ status: 'blocked', preservedPhaseIds: [] });
    expect(() => calculateGraphReconciliation({
      schemaVersion: 3, fromIdentity: f.source.state.identity, toIdentity: currentActivationIdentity,
      fromGraphHash: f.source.state.identity.phaseGraphHash, toGraphHash: currentActivationIdentity.phaseGraphHash,
      phaseMappings: canonicalPhaseGraph.phases.map((phase) => ({
        phaseId: phase.id, fromContractDigest: 'a'.repeat(64), toContractDigest: 'a'.repeat(64), preserveEvidence: true
      })), reconciledAt: now.toISOString(), producer: 'invalid-translator'
    }, { recognizedGraphHashes: new Set([f.source.state.identity.phaseGraphHash, currentActivationIdentity.phaseGraphHash]) })).toThrow();
  });
});
