import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evidenceBodyDigest, validateEvidenceFreshness, type EvidenceFreshnessContext } from '../src/domain/governance/activation/evidence.js';
import { calculatePhaseReadiness } from '../src/domain/governance/activation/readiness.js';
import type { ApprovalEnvelope, PhaseEvidenceRecord, PhaseId } from '../src/domain/governance/activation/types.js';
import { buildActivationCompatibilityMap, resolveActivationCompatibility } from '../src/domain/governance/policy/identity.js';
import { validateApprovalEnvelope, validateEvidenceHeader, validateSavedTransitionPlan, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import {
  activationHistoryCopyPathParts, activationHistoryIndexPathParts, activationHistorySnapshotId,
  activationHistoryTargetModes, historicalActivationIdentity, historyFileModeMatches, historyPathParts,
  migrationRevalidationPhaseIds, migrationStateFilePathParts, rawHistoryDigest,
  reviewedUpdateTransactionPathParts, reviewedUpdateTransactionSchemaVersion,
  validateActivationHistoryIndex, validateMigrationJournal
} from '../src/governance-activation/history-contracts.js';
import {
  readHistoricalActivationInventory, validateHistoricalActivationState, validateHistoricalApprovalEnvelope,
  validateHistoricalEvidenceRecord, validateHistoricalSavedTransitionPlan, historicalApprovalEnvelopeHash,
  type HistoricalInventoryOptions
} from '../src/governance-activation/historical-state.js';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration,
  readActivationHistoryIndex, readMigrationJournal, type ActivationHistoryMutation,
  type EligibleActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { buildHistoricalV1Fixture, historicalFixtureArchiveParts, writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { historicalFixtureGraph } from './fixtures/activation-v1/graph.js';
import { fixtureContext, fixtureHeader, fixturePayload, fixturePlan } from './governance-activation-fixtures.js';

const roots = new Set<string>();
const approvedFingerprint = canonicalSha256({ reviewedEffectiveUpdatePlan: 'core-and-history' });
const now = new Date('2026-09-09T00:00:00.000Z');

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixtureRoot(options: Parameters<typeof writeHistoricalV1Fixture>[1] = {}) {
  const root = path.resolve('tests', `.activation-history-${process.pid}-${randomUUID()}`);
  roots.add(root);
  await mkdir(root, { recursive: true });
  const fixture = await writeHistoricalV1Fixture(root, options);
  return { root, fixture };
}

async function readBytes(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const visit = async (parts: string[]) => {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name];
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) result.set(next.join('/'), await readFile(path.join(root, ...next)));
    }
  };
  await visit([]);
  return result;
}

async function eligible(root: string, options?: HistoricalInventoryOptions): Promise<EligibleActivationHistoryMigration> {
  const plan = await planActivationHistoryMigration(root, options);
  if (plan.status !== 'eligible') throw new Error(`Expected eligible history: ${JSON.stringify(plan)}`);
  return plan;
}

async function writeJson(root: string, name: string, value: unknown) {
  await writeFile(path.join(root, ...name.split('/')), JSON.stringify(value));
}

async function installMutations(root: string, mutations: readonly ActivationHistoryMutation[]) {
  for (const mutation of mutations) {
    const target = path.join(root, ...mutation.pathParts);
    if (mutation.type === 'delete') await unlink(target);
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, mutation.content, { mode: mutation.mode });
      await chmod(target, mutation.mode);
    }
  }
}

async function committedFixture() {
  const { root, fixture } = await fixtureRoot();
  const plan = await eligible(root);
  const finalized = finalizeActivationHistoryMigration(plan, approvedFingerprint, now);
  await installMutations(root, finalized.mutations);
  await writeJson(root, 'liftoff.manifest.json', {
    ...fixture.manifest, liftoffVersion: '0.11.1',
    governance: { ...fixture.manifest.governance, activationIdentity: currentActivationIdentity }
  });
  return { root, fixture, plan, finalized };
}

async function completedRevalidationFixture() {
  const migrated = await committedFixture();
  const state = structuredClone(migrated.finalized.successor);
  const journal = structuredClone(migrated.finalized.journal);
  const producedAt = new Date(now.getTime() + 1_000).toISOString();
  const inspectedAt = new Date(now.getTime() + 60_000);
  const contexts: Partial<Record<PhaseId, EvidenceFreshnessContext>> = {};
  const records: PhaseEvidenceRecord[] = [];
  const inputDigest = rawHistoryDigest(await readFile(path.join(migrated.root, 'backend', 'src', 'index.ts')));
  const baselineSha = rawHistoryDigest(await readFile(path.join(migrated.root, 'liftoff.manifest.json')));
  for (const phaseId of migrationRevalidationPhaseIds) {
    const context = fixtureContext(phaseId, { repositoryId: state.repository.id, inputDigest, baselineSha, now: inspectedAt });
    const payload = fixturePayload(phaseId);
    if (phaseId === 'seed-archived') {
      context.workflowSpecDigest = rawHistoryDigest(await readFile(path.join(
        migrated.root, 'openspec', 'specs', 'node-fastify-application-baseline', 'spec.md'
      )));
      payload.synchronizedSpecDigest = context.workflowSpecDigest;
    }
    const plan = fixturePlan(context, state, producedAt, payload, migrated.root);
    payload.planDigest = plan.planDigest;
    payload.savedPlanDigest = canonicalSha256(plan);
    const header = fixtureHeader(phaseId, {
      repositoryId: state.repository.id, inputDigest, baselineSha, transition: context.transition,
      producedAt, bodyDigest: evidenceBodyDigest(payload)
    });
    const record: PhaseEvidenceRecord = { evidenceId: `fresh-${phaseId}`, header, payload };
    state.phases[phaseId] = {
      state: 'verified', updatedAt: producedAt, approvals: [], blockers: [],
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(header), result: 'verified' }]
    };
    context.evidenceReferences = state.phases[phaseId].evidence;
    context.reviewedPlans = [plan];
    expect(validateEvidenceFreshness(record, context)).toMatchObject({ valid: true });
    await writeJson(migrated.root, `governance/plans/${record.evidenceId}.json`, plan);
    await writeJson(migrated.root, `governance/evidence/${record.evidenceId}.json`, record);
    contexts[phaseId] = context;
    records.push(record);
  }
  state.updatedAt = producedAt;
  journal.revalidation = {
    status: 'complete', updatedAt: producedAt, nextAction: null,
    phases: migrationRevalidationPhaseIds.map((phaseId) => ({
      phaseId, status: 'complete', evidenceIds: [`fresh-${phaseId}`], blockers: []
    }))
  };
  await writeJson(migrated.root, 'governance/activation-state.json', validateUserActivationState(state));
  await writeJson(migrated.root, migrationStateFilePathParts.join('/'), validateMigrationJournal(journal));
  return { ...migrated, state, journal, records, contexts, inspectedAt };
}

describe('frozen historical v1 formats', () => {
  it('uses the actual pre-v2 graph and full records, not schema-retagged current fixtures', () => {
    const fixture = buildHistoricalV1Fixture();
    expect(canonicalSha256(historicalFixtureGraph)).toBe(historicalActivationIdentity.phaseGraphHash);
    expect(canonicalSha256(historicalFixtureGraph)).not.toBe(canonicalSha256(canonicalPhaseGraph));
    expect(validateHistoricalActivationState(fixture.state)).toEqual(fixture.state);
    for (const record of fixture.records) {
      expect(validateHistoricalEvidenceRecord(record)).toEqual(record);
      expect(record.header).not.toHaveProperty('bodyDigest');
      expect(() => validateEvidenceHeader(record.header)).toThrow();
    }
    fixture.plans.forEach((plan) => {
      expect(validateHistoricalSavedTransitionPlan(plan)).toEqual(plan);
      expect(() => validateSavedTransitionPlan(plan)).toThrow();
    });
    fixture.approvals.forEach((approval) => expect(validateHistoricalApprovalEnvelope(approval)).toEqual(approval));
    expect(fixture.plans.at(-1)?.approval.envelopeHash).toBe(historicalApprovalEnvelopeHash(fixture.approvals[0]));
    expect(() => validateUserActivationState(fixture.state)).toThrow();
    expect(resolveActivationCompatibility(historicalActivationIdentity, buildActivationCompatibilityMap([historicalActivationIdentity])))
      .toMatchObject({ compatible: false });
    expect(fixture.files.get('governance/activation-state.json')?.includes(Buffer.from('\r\n'))).toBe(true);
    expect(fixture.files.has(`${historicalFixtureArchiveParts.join('/')}/tasks.md`)).toBe(true);
    expect(fixture.manifest.managedArtifacts).toHaveLength(8);
  });

  it('recognizes the explicitly supported v1 header-only format without filling unversioned records', () => {
    const header = buildHistoricalV1Fixture().records[0].header;
    expect(validateHistoricalEvidenceRecord(header, 'historical-header')).toEqual({ evidenceId: 'historical-header', header });
    expect(() => validateHistoricalEvidenceRecord(header)).toThrow(/registeredHeaderOnlyEvidenceId/);
    const { schemaVersion: _schema, ...unversioned } = header;
    expect(() => validateHistoricalEvidenceRecord(unversioned, 'historical-header')).toThrow(/schemaVersion/);
  });

  it.each([
    ['unknown', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => ({ ...state, extra: true })],
    ['unversioned', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => {
      const { schemaVersion: _schema, ...rest } = state; return rest;
    }],
    ['future', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => ({ ...state, schemaVersion: 7 })],
    ['mixed', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => ({ ...state, identity: { ...state.identity, approvalEnvelopeSchemaVersion: 2 } })],
    ['unknown graph', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => ({ ...state, identity: { ...state.identity, phaseGraphHash: 'f'.repeat(64) } })],
    ['v2-shaped', (state: ReturnType<typeof buildHistoricalV1Fixture>['state']) => ({ ...state, applicability: { ...state.applicability, credentialRequired: 'unknown' } })]
  ])('blocks %s active state without changing bytes', async (_name, change) => {
    const { root, fixture } = await fixtureRoot();
    await writeJson(root, 'governance/activation-state.json', change(fixture.state));
    const before = await readBytes(root);
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    expect(await readBytes(root)).toEqual(before);
  });

  it('rejects malformed UTF-8, malformed JSON, invalid refs and missing required records', async () => {
    const { root, fixture } = await fixtureRoot();
    const source = path.join(root, 'governance', 'activation-state.json');
    for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0xfe]), Buffer.from('null')]) {
      await writeFile(source, bytes);
      expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
      expect(await readFile(source)).toEqual(bytes);
    }
    const changed = structuredClone(fixture.state);
    changed.phases['seed-valid'].evidence[0].evidenceId = '../outside';
    await writeJson(root, 'governance/activation-state.json', changed);
    const unsafe = await planActivationHistoryMigration(root);
    expect(unsafe).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-history-path' });
    await writeFile(source, fixture.files.get('governance/activation-state.json')!);
    await unlink(path.join(root, 'governance', 'evidence', `${fixture.records[0].evidenceId}.json`));
    const missing = await planActivationHistoryMigration(root);
    expect(missing).toMatchObject({ status: 'blocked', reasonCode: 'missing-historical-record' });
    if (missing.status === 'blocked') expect(missing.issues.join(' ')).toContain(fixture.records[0].evidenceId);
    await unlink(source);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'missing-historical-record' });
  });

  it('rejects v2-shaped evidence, bad historical plan refs and incomplete historical approvals', async () => {
    const { root, fixture } = await fixtureRoot();
    const evidencePath = `governance/evidence/${fixture.records[0].evidenceId}.json`;
    await writeJson(root, evidencePath, { ...fixture.records[0], header: { ...fixture.records[0].header, bodyDigest: 'e'.repeat(64) } });
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked' });
    await writeFile(path.join(root, ...evidencePath.split('/')), fixture.files.get(evidencePath)!);
    const planFile = [...fixture.files.keys()].find((name) => name.startsWith('governance/plans/committed-'))!;
    await writeJson(root, planFile, { ...fixture.plans[3], approval: { ...fixture.plans[3].approval, envelopeId: 'missing-review' } });
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked' });
    await writeFile(path.join(root, ...planFile.split('/')), fixture.files.get(planFile)!);
    const approval = fixture.approvals[0];
    const { costCeiling: _cost, ...missingCost } = approval;
    await writeJson(root, `governance/approvals/${approval.id}.json`, missingCost);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked' });
  });
});

describe('exact, read-only history planning', () => {
  it('binds exact byte/mode/path inventory deterministically, including original activation metadata', async () => {
    const { root } = await fixtureRoot();
    const before = await readBytes(root);
    const first = await eligible(root);
    const second = await eligible(root);
    expect((await readHistoricalActivationInventory(root)).state.identity).toEqual(historicalActivationIdentity);
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.indexContent).toEqual(first.indexContent);
    expect(first).not.toHaveProperty('mutations');
    expect(first.semanticPlan).not.toHaveProperty('approvedPlanFingerprint');
    expect(first.index.files.some((file) => file.kind === 'manifest')).toBe(true);
    expect(first.index.files.some((file) => file.originalPathParts.join('/') === '.liftoff/governance/phase-graph.json')).toBe(true);
    expect(first.index.files.some((file) => file.originalPathParts[0] === 'openspec')).toBe(false);
    for (const file of first.index.files) expect(file.mode).toBe((await stat(path.join(root, ...file.originalPathParts))).mode & 0o7777);
    expect(first.requiredRetirements.every((file) => first.index.files.some((entry) =>
      entry.originalPathParts.join('/') === file.pathParts.join('/') && entry.copyPathParts.join('/') === file.copyPathParts.join('/')))).toBe(true);
    expect(await readBytes(root)).toEqual(before);
  });

  it('leaves unowned neighbors out of the inventory and requires explicit unreferenced selection', async () => {
    const { root, fixture } = await fixtureRoot();
    const extra = { ...fixture.records[0], evidenceId: 'prior-recognized-attempt' };
    const parts = ['governance', 'evidence', 'prior-recognized-attempt.json'];
    await writeJson(root, parts.join('/'), extra);
    const blocked = await planActivationHistoryMigration(root);
    expect(blocked).toMatchObject({ status: 'blocked', reasonCode: 'unreviewed-historical-records', unreviewedPathParts: [parts] });
    const plan = await eligible(root, { reviewedUnreferencedPathParts: [parts] });
    expect(plan.index.files.some((file) => file.originalPathParts.join('/') === parts.join('/'))).toBe(true);
    expect(plan.index.files.some((file) => file.originalPathParts.join('/').endsWith('notes.txt'))).toBe(false);
    expect(plan.index.files.some((file) => file.originalPathParts.join('/').endsWith('production-settings.json'))).toBe(false);
    await writeJson(root, 'governance/evidence/unknown.json', { reviewed: true });
    const unknown = await planActivationHistoryMigration(root, { reviewedUnreferencedPathParts: [parts, ['governance', 'evidence', 'unknown.json']] });
    expect(unknown.status).toBe('blocked');
    expect(await readFile(path.join(root, 'governance', 'production-settings.json'))).toEqual(fixture.files.get('governance/production-settings.json'));
  });

  it('resolves validated envelope IDs to exact source paths rather than inferring ownership from filenames', async () => {
    const { root, fixture } = await fixtureRoot();
    const oldPath = ['governance', 'evidence', `${fixture.records[0].evidenceId}.json`];
    const importedPath = ['governance', 'evidence', 'reviewed-import.json'];
    await rename(path.join(root, ...oldPath), path.join(root, ...importedPath));
    const plan = await eligible(root);
    expect(plan.requiredRetirements.some((entry) => entry.pathParts.join('/') === importedPath.join('/'))).toBe(true);
    expect(plan.requiredRetirements.some((entry) => entry.pathParts.join('/') === oldPath.join('/'))).toBe(false);
  });

  it('requires record dependencies even for explicitly selected unreferenced records', async () => {
    const { root, fixture } = await fixtureRoot();
    const record = structuredClone(fixture.records[0]);
    record.evidenceId = 'unreferenced-missing-plan';
    record.header.inputDigest = 'a'.repeat(64);
    record.header.transition.inputDigest = record.header.inputDigest;
    const parts = ['governance', 'evidence', `${record.evidenceId}.json`];
    await writeJson(root, parts.join('/'), record);
    expect(await planActivationHistoryMigration(root, { reviewedUnreferencedPathParts: [parts] }))
      .toMatchObject({ status: 'blocked', reasonCode: 'missing-historical-record' });
    expect(await readFile(path.join(root, ...parts), 'utf8')).toBe(JSON.stringify(record));
  });

  it('never inherits directory ownership for auxiliary active proof', async () => {
    const { root } = await fixtureRoot();
    await mkdir(path.join(root, 'governance', 'reconciliation'));
    await writeJson(root, 'governance/reconciliation/unregistered.json', { schemaVersion: 1 });
    const before = await readBytes(root);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'unsupported-active-record' });
    expect(await readBytes(root)).toEqual(before);
  });

  it('does not accept unknown managed graphs or project-edited compatibility declarations as lane authority', async () => {
    const { root } = await fixtureRoot();
    await writeJson(root, '.liftoff/governance/phase-graph.json', { ...canonicalPhaseGraph, schemaVersion: 9 });
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'unsupported-historical-graph' });
    await writeJson(root, '.liftoff/governance/phase-graph.json', canonicalPhaseGraph);
    expect((await eligible(root)).inventory.state.identity).toEqual(historicalActivationIdentity);
    await writeJson(root, '.liftoff/governance/compatibility.json', { schemaVersion: 3, activation: { successorMigrations: [] } });
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
  });

  it.each([2, 3] as const)('preserves maintained schema-%s core bytes with a 0.11.1 manifest and exact immutable v1 records', async (schemaVersion) => {
    const { root, fixture } = await fixtureRoot({ maintainedCoreCompatibilitySchema: schemaVersion });
    expect(fixture.manifest.liftoffVersion).toBe('0.11.1');
    expect(fixture.manifest.managedArtifacts).toHaveLength(10);
    expect(fixture.manifest.governance.activationIdentity).toEqual(historicalActivationIdentity);
    expect(fixture.state.identity).toEqual(historicalActivationIdentity);
    const before = await readBytes(root);
    const planned = await eligible(root);
    expect(planned.index.sourceIdentity).toEqual(historicalActivationIdentity);
    expect(planned.semanticPlan.targetIdentity).toEqual(currentActivationIdentity);
    expect((await eligible(root)).planDigest).toBe(planned.planDigest);
    expect(planned.index.files.filter((entry) => entry.kind === 'metadata' && entry.originalPathParts[0] !== 'liftoff.config.json'))
      .toHaveLength(10);
    const finalized = finalizeActivationHistoryMigration(planned, approvedFingerprint, now);
    expect(finalized.successor.identity).toEqual(currentActivationIdentity);
    expect(finalized.successor.remoteBinding).toBeUndefined();
    for (const original of planned.inventory.files) {
      const copy = finalized.mutations.find((entry) => entry.type === 'write' &&
        entry.pathParts.join('/') === activationHistoryCopyPathParts(planned.index.snapshotId, original.pathParts).join('/'));
      if (copy === undefined || copy.type !== 'write') throw new Error(`Missing exact copy for ${original.pathParts.join('/')}.`);
      expect(Buffer.isBuffer(copy.content)).toBe(true);
      expect(copy.content).toEqual(before.get(original.pathParts.join('/')));
    }
    expect(await readBytes(root)).toEqual(before);
    await installMutations(root, finalized.mutations);
    await writeJson(root, 'liftoff.manifest.json', {
      ...fixture.manifest, governance: { ...fixture.manifest.governance, activationIdentity: currentActivationIdentity }
    });
    expect(await inspectActivationMigrationHistory(root)).toMatchObject({ status: 'committed' });
    for (const entry of planned.index.files) {
      expect(await readFile(path.join(root, ...entry.copyPathParts))).toEqual(before.get(entry.originalPathParts.join('/')));
    }
  });

  it('continues rejecting mixed immutable identity after safe core maintenance', async () => {
    const { root, fixture } = await fixtureRoot({ maintainedCoreCompatibilitySchema: 3 });
    const record = fixture.records[0];
    await writeJson(root, `governance/evidence/${record.evidenceId}.json`, {
      ...record, header: { ...record.header, identity: currentActivationIdentity }
    });
    expect(await planActivationHistoryMigration(root))
      .toMatchObject({ status: 'blocked', reasonCode: 'unsupported-historical-identity' });
    await writeJson(root, `governance/evidence/${record.evidenceId}.json`, record);
    await writeJson(root, 'governance/activation-state.json', {
      ...fixture.state, identity: { ...fixture.state.identity, evidenceHeaderSchemaVersion: 2 }
    });
    expect(await planActivationHistoryMigration(root))
      .toMatchObject({ status: 'blocked', reasonCode: 'unsupported-historical-identity' });
  });

  it('invalidates planning when original bytes or permissions change', async () => {
    const { root } = await fixtureRoot();
    const first = await eligible(root);
    const source = path.join(root, 'governance', 'activation-state.json');
    await writeFile(source, `${(await readFile(source, 'utf8')).trim()}\n`);
    const second = await eligible(root);
    expect(second.index.snapshotId).not.toBe(first.index.snapshotId);
    expect(second.planDigest).not.toBe(first.planDigest);
    if (process.platform !== 'win32') {
      await chmod(source, 0o640);
      const third = await eligible(root);
      expect(third.index.snapshotId).not.toBe(second.index.snapshotId);
      expect(third.index.files.find((file) => file.kind === 'state')?.mode).toBe(0o640);
    }
  });

  it('gives byte-identical historical projects the same portable snapshot ID but different project-bound plans', async () => {
    const left = await fixtureRoot();
    const right = await fixtureRoot();
    const a = await eligible(left.root);
    const b = await eligible(right.root);
    expect(a.index.snapshotId).toBe(b.index.snapshotId);
    expect(a.indexContent).toEqual(b.indexContent);
    expect(a.planDigest).not.toBe(b.planDigest);
  });
});

describe('approved finalization and immutable snapshot reuse', () => {
  it('finalizes a strict fresh successor only after explicit fingerprint/time input, without writing', async () => {
    const { root, fixture } = await fixtureRoot();
    const plan = await eligible(root);
    const before = await readBytes(root);
    expect(() => finalizeActivationHistoryMigration(plan, 'yes', now)).toThrow(/approvedPlanFingerprint/);
    const result = finalizeActivationHistoryMigration(plan, approvedFingerprint, now);
    const later = finalizeActivationHistoryMigration(plan, 'f'.repeat(64), new Date('2026-09-10T00:00:00.000Z'));
    expect(result.successor.repository.id).not.toBe(later.successor.repository.id);
    expect(result.successor.repository.id).not.toBe(fixture.state.repository.id);
    expect(validateUserActivationState(result.successor)).toEqual(result.successor);
    expect(validateMigrationJournal(result.journal)).toEqual(result.journal);
    expect(result.successor.remoteBinding).toBeUndefined();
    expect(result.successor.bootstrapState).toBeUndefined();
    expect(result.successor.applicability).toEqual({ statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' });
    expect(Object.values(result.successor.phases).every((phase) => phase.state === 'pending' && phase.evidence.length === 0 && phase.approvals.length === 0)).toBe(true);
    expect(result.journal.revalidation.status).toBe('pending');
    expect(result.journal.revalidation.phases.map((phase) => phase.phaseId)).toEqual(migrationRevalidationPhaseIds);
    expect(plan.semanticPlan.revalidationPhaseIds).toEqual(['seed-valid', 'seed-verified', 'seed-archived']);
    expect(plan.semanticPlan.targetModes).toEqual(activationHistoryTargetModes);
    expect(result.successor.phases.committed.state).toBe('pending');
    expect(result.journal.approvedPlanFingerprint).toBe(approvedFingerprint);
    expect(result.journal.successor.repositoryId).toBe(result.successor.repository.id);
    const firstRetirement = result.mutations.findIndex((mutation) => mutation.type === 'delete');
    const indexWrite = result.mutations.findIndex((mutation) => mutation.pathParts.join('/') === activationHistoryIndexPathParts(plan.index.snapshotId).join('/'));
    expect(firstRetirement).toBeGreaterThan(indexWrite);
    expect(result.mutations.filter((mutation) => mutation.type === 'write' && mutation.pathParts[1] === 'history')
      .every((mutation) => mutation.type === 'write' && Buffer.isBuffer(mutation.content))).toBe(true);
    expect(await readBytes(root)).toEqual(before);
    expect((await eligible(root)).planDigest).toBe(plan.planDigest);
  });

  it('preserves every reviewed original byte after fixture commit and never fabricates v2 receipts', async () => {
    const { root, fixture, plan, finalized } = await committedFixture();
    for (const file of plan.index.files) {
      const copy = await readFile(path.join(root, ...file.copyPathParts));
      expect(copy).toEqual(fixture.files.get(file.originalPathParts.join('/')));
      expect(rawHistoryDigest(copy)).toBe(file.digest);
      expect((await stat(path.join(root, ...file.copyPathParts))).mode & 0o7777).toBe(file.mode);
    }
    expect((await readdir(path.join(root, 'governance', 'evidence')))).toEqual(['notes.txt']);
    expect((await inspectActivationMigrationHistory(root)).status).toBe('committed');
    expect(await readMigrationJournal(root)).toEqual(finalized.journal);
    const current = await planActivationHistoryMigration(root);
    expect(current).toMatchObject({ status: 'current', history: { status: 'committed' } });
    const manifest: unknown = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ artifactVersion: 7, projectArtifacts: fixture.manifest.projectArtifacts });
    expect(await readFile(path.join(root, 'governance', 'production-settings.json'))).toEqual(fixture.files.get('governance/production-settings.json'));
    for (const [name, content] of fixture.files) if (name.startsWith('openspec/')) expect(await readFile(path.join(root, ...name.split('/')))).toEqual(content);
  });

  it('reuses only an identical completed snapshot and never rewrites it', async () => {
    const { root } = await fixtureRoot();
    const first = await eligible(root);
    const finalized = finalizeActivationHistoryMigration(first, approvedFingerprint, now);
    await installMutations(root, finalized.mutations.filter((mutation) => mutation.pathParts[1] === 'history'));
    const before = await readBytes(root);
    const reused = await eligible(root);
    expect(reused.historyDisposition).toBe('reuse');
    expect(reused.index.snapshotId).toBe(first.index.snapshotId);
    expect((await eligible(root)).planDigest).toBe(reused.planDigest);
    expect(finalizeActivationHistoryMigration(reused, approvedFingerprint, now).mutations.some((mutation) => mutation.pathParts[1] === 'history')).toBe(false);
    expect(await readBytes(root)).toEqual(before);
    await writeFile(path.join(root, ...reused.index.files[0].copyPathParts), 'different historical bytes');
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'history-digest-mismatch' });
  });

  it('creates private copies while preserving original bytes and source modes in the immutable index', async () => {
    const { root } = await fixtureRoot();
    const sourceParts = ['governance', 'activation-state.json'];
    const sourcePath = path.join(root, ...sourceParts);
    await chmod(sourcePath, 0o644);
    const originalMode = (await stat(sourcePath)).mode & 0o7777;
    const originalBytes = await readFile(sourcePath);
    const plan = await eligible(root);
    const entry = plan.index.files.find((file) => file.kind === 'state')!;
    expect(entry.mode).toBe(originalMode);
    const finalized = finalizeActivationHistoryMigration(plan, approvedFingerprint, now);
    expect(finalized.mutations.every((mutation) => mutation.type !== 'write' || mutation.mode === 0o600)).toBe(true);
    await installMutations(root, finalized.mutations.filter((mutation) => mutation.pathParts[1] === 'history'));
    expect(await readFile(sourcePath)).toEqual(originalBytes);
    expect((await stat(sourcePath)).mode & 0o7777).toBe(originalMode);
    expect(await readFile(path.join(root, ...entry.copyPathParts))).toEqual(originalBytes);
    expect(historyFileModeMatches((await stat(path.join(root, ...entry.copyPathParts))).mode & 0o7777, 0o600)).toBe(true);
    expect((await eligible(root)).historyDisposition).toBe('reuse');
    if (process.platform !== 'win32') {
      await chmod(path.join(root, ...entry.copyPathParts), 0o644);
      expect((await eligible(root)).historyDisposition).toBe('reuse');
    }
  });

  it('reuses byte-identical history after checkout permission normalization without rewriting it', async () => {
    const { root } = await fixtureRoot();
    const initial = await eligible(root);
    const writes = finalizeActivationHistoryMigration(initial, approvedFingerprint, now).mutations
      .filter((mutation) => mutation.pathParts[1] === 'history');
    await installMutations(root, writes);
    const privatePlan = await eligible(root);
    for (const file of initial.index.files) await chmod(path.join(root, ...file.copyPathParts), 0o644);
    await chmod(path.join(root, ...activationHistoryIndexPathParts(initial.index.snapshotId)), 0o644);
    const before = await readBytes(root);
    const restored = await eligible(root);
    expect(restored.historyDisposition).toBe('reuse');
    expect(restored.index).toEqual(initial.index);
    expect(restored.indexContent).toEqual(initial.indexContent);
    if (process.platform !== 'win32') {
      expect(restored.planDigest).not.toBe(privatePlan.planDigest);
      expect(restored.preconditions.find((snapshot) =>
        snapshot.pathParts.join('/') === activationHistoryIndexPathParts(initial.index.snapshotId).join('/'))?.mode).toBe(0o644);
    }
    const finalized = finalizeActivationHistoryMigration(restored, approvedFingerprint, now);
    expect(finalized.mutations.some((mutation) => mutation.pathParts[1] === 'history')).toBe(false);
    expect(finalized.mutations.every((mutation) => mutation.type !== 'write' || mutation.mode === 0o600)).toBe(true);
    expect(await readBytes(root)).toEqual(before);
  });

  it('binds private target mode policy into review and refuses a widened runtime policy', async () => {
    const { root } = await fixtureRoot();
    const plan = await eligible(root);
    const originalDigest = plan.planDigest;
    Object.assign(plan.semanticPlan.targetModes, { historyCopy: 0o644 });
    expect(canonicalSha256(plan.semanticPlan)).not.toBe(originalDigest);
    expect(() => finalizeActivationHistoryMigration(plan, approvedFingerprint, now)).toThrow(/changed since planning/);
    plan.planDigest = canonicalSha256(plan.semanticPlan);
    expect(() => finalizeActivationHistoryMigration(plan, approvedFingerprint, now)).toThrow(/changed since planning/);
  });

  it('blocks incomplete or differing history destinations, with no force escape hatch', async () => {
    const { root } = await fixtureRoot();
    const plan = await eligible(root);
    const indexPath = activationHistoryIndexPathParts(plan.index.snapshotId);
    await mkdir(path.join(root, ...indexPath.slice(0, -1)), { recursive: true });
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'incomplete-history-snapshot' });
    await writeFile(path.join(root, ...indexPath), 'unversioned content');
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    expect(await readFile(path.join(root, ...indexPath), 'utf8')).toBe('unversioned content');
  });

  it('refuses to finalize modified planned bytes or a modified semantic plan', async () => {
    const { root } = await fixtureRoot();
    const plan = await eligible(root);
    plan.inventory.files[0].content[0] ^= 1;
    expect(() => finalizeActivationHistoryMigration(plan, approvedFingerprint, now)).toThrow(/changed/);
    const second = await eligible(root);
    second.semanticPlan.successor.projectName = 'another project';
    expect(() => finalizeActivationHistoryMigration(second, approvedFingerprint, now)).toThrow(/changed since planning/);
  });
});

describe('portable paths and strict committed history links', () => {
  it('registers recovery separately from immutable history and committed migration progress', () => {
    expect(reviewedUpdateTransactionSchemaVersion).toBe(1);
    expect(reviewedUpdateTransactionPathParts).toEqual(['.liftoff', 'reviewed-update-transaction.json']);
    expect(migrationStateFilePathParts).toEqual(['governance', 'migration-state.json']);
    expect(historyPathParts(reviewedUpdateTransactionPathParts, 'reviewed recovery journal')).toEqual(reviewedUpdateTransactionPathParts);
    expect(reviewedUpdateTransactionPathParts.join('/')).not.toBe(migrationStateFilePathParts.join('/'));
  });

  it.each([['..'], ['C:'], ['\\\\server'], ['dir/file'], ['dir\\file'], ['alternate:stream'], ['CON'], ['name.'], ['name ']])(
    'rejects unsafe portable path %j', (parts) => {
      expect(() => historyPathParts(parts, 'test path')).toThrow();
      expect(() => activationHistoryCopyPathParts('a'.repeat(64), parts)).toThrow();
    }
  );

  it('blocks source links, internal directory links and hard links without following them', async () => {
    const { root, fixture } = await fixtureRoot();
    const source = path.join(root, 'governance', 'activation-state.json');
    const linked = path.join(root, 'governance', 'state-preserved.json');
    await rename(source, linked);
    await symlink('state-preserved.json', source);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-history-path' });
    await unlink(source);
    await rename(linked, source);
    await link(source, linked);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-history-path' });
    await unlink(linked);
    expect(await readFile(source)).toEqual(fixture.files.get('governance/activation-state.json'));
    await mkdir(path.join(root, 'private-history'));
    await symlink(path.join(root, 'private-history'), path.join(root, 'governance', 'history'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-history-path' });
  });

  it('blocks native case aliases and portable index case collisions', async () => {
    const { root } = await fixtureRoot();
    await mkdir(path.join(root, 'governance', 'History'));
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'history-path-collision' });
    await rm(path.join(root, 'governance', 'History'), { recursive: true });
    const { index } = await eligible(root);
    const file = index.files.find((file) => file.kind === 'evidence')!;
    const colliding = { ...file, originalPathParts: [...file.originalPathParts.slice(0, -1), file.originalPathParts.at(-1)!.toUpperCase()] };
    expect(() => validateActivationHistoryIndex({ ...index, files: [...index.files, colliding] })).toThrow(/case-colliding/);
    expect(() => validateActivationHistoryIndex({ ...index, schemaVersion: 2 })).toThrow(/schemaVersion/);
    const unregistered = { ...index.files[0], kind: 'metadata', originalPathParts: ['backend', 'private.json'] };
    expect(() => validateActivationHistoryIndex({ ...index, files: [...index.files, unregistered] })).toThrow();
  });

  it('detects missing, corrupt and escaping links rather than falling back to v1 proof', async () => {
    const { root, plan, finalized, fixture } = await committedFixture();
    const indexPath = path.join(root, ...activationHistoryIndexPathParts(plan.index.snapshotId));
    const bytes = await readFile(indexPath);
    await unlink(indexPath);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/declared historical index is missing/);
    await writeFile(indexPath, bytes, { mode: 0o600 });
    await writeJson(root, migrationStateFilePathParts.join('/'), { ...finalized.journal, historyIndexPathParts: ['..', 'outside.json'] });
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/unsafe/);
    await writeJson(root, migrationStateFilePathParts.join('/'), finalized.journal);
    await writeFile(path.join(root, 'governance', 'activation-state.json'), fixture.files.get('governance/activation-state.json')!);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/invalid current successor/);
    await writeJson(root, 'governance/activation-state.json', { ...finalized.successor, repository: { ...finalized.successor.repository, id: 'local:wrong-anchor' } });
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/anchor/);
    await writeJson(root, 'governance/activation-state.json', finalized.successor);
    await writeFile(path.join(root, ...plan.index.files[0].copyPathParts), 'tampered snapshot');
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/historical bytes/);
  });

  it('reports missing copy, tampered index digest and symlinked copies precisely', async () => {
    const { root, plan, finalized } = await committedFixture();
    const copy = plan.index.files[0];
    const nativeCopy = path.join(root, ...copy.copyPathParts);
    const bytes = await readFile(nativeCopy);
    await unlink(nativeCopy);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/declared historical copy is missing/);
    await writeFile(nativeCopy, bytes, { mode: copy.mode });
    await writeJson(root, migrationStateFilePathParts.join('/'), { ...finalized.journal, historyIndexDigest: 'a'.repeat(64) });
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/index digest/);
    await writeJson(root, migrationStateFilePathParts.join('/'), finalized.journal);
    await unlink(nativeCopy);
    await symlink(path.join(root, 'backend', 'src', 'index.ts'), nativeCopy);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/symbolic links/);
  });

  it('never lets preserved historical success hide malformed or leftover active proof', async () => {
    const { root, fixture } = await committedFixture();
    await writeJson(root, 'governance/evidence/not-current.json', fixture.records[0]);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/Historical activation v1 evidence/);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'invalid-current-proof' });
    await writeFile(path.join(root, 'governance', 'evidence', 'not-current.json'), '{invalid');
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/invalid JSON/);
  });

  it('validates linked identity rather than pinning legitimately mutable successor bytes', async () => {
    const { root, finalized } = await committedFixture();
    const progressed = structuredClone(finalized.successor);
    progressed.updatedAt = '2026-09-10T00:00:00.000Z';
    progressed.phases['seed-valid'].state = 'blocked';
    progressed.phases['seed-valid'].blockers = ['Local check requires review.'];
    await writeJson(root, 'governance/activation-state.json', progressed);
    expect(await inspectActivationMigrationHistory(root)).toMatchObject({ status: 'committed', state: progressed });
    expect(() => validateMigrationJournal({ ...finalized.journal, schemaVersion: 2 })).toThrow();
    expect(() => validateMigrationJournal({ ...finalized.journal, revalidation: {
      ...finalized.journal.revalidation, status: 'complete', nextAction: null
    } })).toThrow(/contradicts/);
    expect(() => validateMigrationJournal({ ...finalized.journal, successor: { ...finalized.journal.successor, repositoryId: 'R_HISTORICAL_FLIGHT_LOG' } })).toThrow(/local anchor/);
    expect(() => validateMigrationJournal({ ...finalized.journal, sourceIdentity: currentActivationIdentity })).toThrow(/historical activation/);
  });

  it.each(['blocked', 'failed'] as const)('keeps completed revalidation auditable when current local execution becomes %s', async (phaseState) => {
    const completed = await completedRevalidationFixture();
    const { root, records, contexts, inspectedAt } = completed;
    const ready = calculatePhaseReadiness({ state: completed.state, approvals: [], evidence: records, transitionContexts: contexts, now: inspectedAt });
    for (const phaseId of migrationRevalidationPhaseIds) expect(ready.phases[phaseId].state).toBe('verified');
    expect(await inspectActivationMigrationHistory(root)).toMatchObject({
      status: 'committed', journal: { revalidation: { status: 'complete' } }
    });
    const state = structuredClone(completed.state);
    const originalReferences = structuredClone(state.phases['seed-valid'].evidence);
    state.phases['seed-valid'].state = phaseState;
    state.phases['seed-valid'].blockers = ['Current local source changed and needs a new reviewed check.'];
    state.phases['seed-valid'].updatedAt = inspectedAt.toISOString();
    state.updatedAt = inspectedAt.toISOString();
    await writeJson(root, 'governance/activation-state.json', state);
    await writeFile(path.join(root, 'backend', 'src', 'index.ts'), '// New user-owned application revision.\n');
    const before = await readBytes(root);
    const inspected = await inspectActivationMigrationHistory(root);
    expect(inspected).toMatchObject({
      status: 'committed', journal: completed.journal, state: { phases: { 'seed-valid': { state: phaseState, evidence: originalReferences } } }
    });
    expect(await planActivationHistoryMigration(root)).toMatchObject({
      status: 'current', history: { status: 'committed', journal: { revalidation: { status: 'complete' } } }
    });
    const previous = contexts['seed-valid'];
    if (previous === undefined) throw new Error('Missing current fixture context.');
    const changedContext = fixtureContext('seed-valid', {
      repositoryId: state.repository.id, baselineSha: previous.baselineSha,
      inputDigest: rawHistoryDigest(await readFile(path.join(root, 'backend', 'src', 'index.ts'))), now: inspectedAt
    });
    changedContext.reviewedPlans = previous.reviewedPlans;
    changedContext.evidenceReferences = originalReferences;
    expect(validateEvidenceFreshness(records[0], changedContext)).toMatchObject({ valid: false });
    const current = calculatePhaseReadiness({
      state, approvals: [], evidence: records, transitionContexts: { ...contexts, 'seed-valid': changedContext }, now: inspectedAt
    });
    expect(current.phases['seed-valid'].state).not.toBe('verified');
    expect(current.phases['seed-verified'].state).toBe('blocked');
    expect(await readBytes(root)).toEqual(before);
    await unlink(path.join(root, 'governance', 'evidence', 'fresh-seed-valid.json'));
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/current evidence reference is missing/);
  });

  it('reads a relocated checkout with normalized copy/index permissions and retains byte-integrity checks', async () => {
    const { root, plan, finalized } = await committedFixture();
    const checkout = path.resolve('tests', `.activation-history-checkout-${process.pid}-${randomUUID()}`);
    roots.add(checkout);
    const originals = await readBytes(root);
    for (const [name, content] of originals) {
      const destination = path.join(checkout, ...name.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: 0o644 });
      await chmod(destination, 0o644);
    }
    const before = await readBytes(checkout);
    expect(await readActivationHistoryIndex(checkout, plan.index.snapshotId)).toMatchObject({
      index: plan.index, content: plan.indexContent, digest: plan.indexDigest
    });
    expect(await inspectActivationMigrationHistory(checkout)).toMatchObject({
      status: 'committed', index: plan.index, journal: finalized.journal, state: finalized.successor
    });
    expect(await planActivationHistoryMigration(checkout)).toMatchObject({ status: 'current', history: { status: 'committed' } });
    expect(await readBytes(checkout)).toEqual(before);
    expect(await readBytes(root)).toEqual(originals);
    const copied = plan.index.files[0];
    await writeFile(path.join(checkout, ...copied.copyPathParts), 'Changed historical bytes after checkout.');
    await expect(inspectActivationMigrationHistory(checkout)).rejects.toThrow(/historical bytes differ/);
    await writeFile(path.join(checkout, ...copied.copyPathParts), originals.get(copied.copyPathParts.join('/'))!);
    const indexPath = path.join(checkout, ...activationHistoryIndexPathParts(plan.index.snapshotId));
    await unlink(indexPath);
    await symlink(path.join(root, ...activationHistoryIndexPathParts(plan.index.snapshotId)), indexPath);
    await expect(inspectActivationMigrationHistory(checkout)).rejects.toThrow(/symbolic links/);
  });

  it('rejects missing current references even when their entire active proof collection is absent', async () => {
    const { root, finalized } = await committedFixture();
    const state = structuredClone(finalized.successor);
    state.phases['seed-valid'].evidence = [{
      phaseId: 'seed-valid', evidenceId: 'missing-current-record', headerDigest: 'a'.repeat(64), result: 'verified'
    }];
    await writeJson(root, 'governance/activation-state.json', state);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/current evidence reference is missing/);
    state.phases['seed-valid'].evidence = [];
    state.phases['seed-valid'].state = 'verified';
    await writeJson(root, 'governance/activation-state.json', state);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/current terminal state has no evidence references/);
    state.phases['seed-valid'].state = 'pending';
    state.phases['activation-approved'].state = 'approved';
    await writeJson(root, 'governance/activation-state.json', state);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/approved current state has no approval references/);
    state.phases['activation-approved'].state = 'pending';
    state.phases.committed.approvals = ['missing-current-approval'];
    await writeJson(root, 'governance/activation-state.json', state);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/current approval reference is missing/);
  });

  it('validates all state approval references only after the complete approval map has loaded', async () => {
    const { root, finalized } = await committedFixture();
    const state = structuredClone(finalized.successor);
    for (const [phaseId, name] of [['committed', 'a-first'], ['pushed', 'z-later']] as const) {
      const approval: ApprovalEnvelope = {
        schemaVersion: 2, id: name, phaseId, gateKind: 'repository-publish', identity: currentActivationIdentity,
        baselineSha: canonicalSha256({ currentFixture: root }),
        planDigest: canonicalSha256({ phaseId, scope: 'empty fixture review scope' }),
        resources: [], destinations: [], permissions: [], costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [], destructiveScope: [], approvedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), approver: 'current-fixture-maintainer'
      };
      await writeJson(root, `governance/approvals/${name}.json`, validateApprovalEnvelope(approval));
      state.phases[phaseId].approvals = [name];
    }
    await writeJson(root, 'governance/activation-state.json', state);
    const before = await readBytes(root);
    expect(await inspectActivationMigrationHistory(root)).toMatchObject({ status: 'committed', state });
    expect(await readBytes(root)).toEqual(before);
    await unlink(path.join(root, 'governance', 'approvals', 'z-later.json'));
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/phases.pushed.*current approval reference is missing/);
  });

  it('accepts explicit pending, running, blocked and complete journal formats without granting proof authority', async () => {
    const { root, finalized } = await committedFixture();
    const pending = finalized.journal;
    expect(validateMigrationJournal(pending).revalidation.status).toBe('pending');
    const running = structuredClone(pending);
    running.revalidation.status = 'running';
    running.revalidation.phases[0].status = 'running';
    expect(validateMigrationJournal(running)).toEqual(running);
    const blocked = structuredClone(pending);
    blocked.revalidation.status = 'blocked';
    blocked.revalidation.phases[0].status = 'blocked';
    blocked.revalidation.phases[0].blockers = ['Approved local check failed; repair and preview again.'];
    expect(validateMigrationJournal(blocked)).toEqual(blocked);
    const complete = structuredClone(pending);
    complete.revalidation.status = 'complete';
    complete.revalidation.nextAction = null;
    for (const phase of complete.revalidation.phases) {
      phase.status = 'complete';
      phase.evidenceIds = [`fresh-${phase.phaseId}`];
    }
    expect(validateMigrationJournal(complete)).toEqual(complete);
    expect(complete.revalidation.phases.map((phase) => phase.phaseId)).toEqual(['seed-valid', 'seed-verified', 'seed-archived']);
    expect(finalized.successor.phases.committed.state).toBe('pending');
    expect(() => validateMigrationJournal({
      ...pending, revalidation: {
        ...pending.revalidation,
        phases: [...pending.revalidation.phases, { phaseId: 'committed', status: 'pending', evidenceIds: [], blockers: [] }]
      }
    })).toThrow(/unsupported value/);
    expect(() => validateMigrationJournal({
      ...pending, revalidation: { ...pending.revalidation, phases: pending.revalidation.phases.slice(0, 2) }
    })).toThrow(/requires exactly/);
    await writeJson(root, migrationStateFilePathParts.join('/'), complete);
    await expect(inspectActivationMigrationHistory(root)).rejects.toThrow(/no corresponding current state references/);
    expect(() => validateMigrationJournal({ ...pending, inheritedApproval: true })).toThrow(/not supported/);
  });

  it('recognizes an ordinary current-v2 project without making a snapshot or journal', async () => {
    const { root, fixture } = await fixtureRoot();
    const planned = await eligible(root);
    const finalized = finalizeActivationHistoryMigration(planned, approvedFingerprint, now);
    await installMutations(root, finalized.mutations.filter((mutation) => mutation.type === 'delete'));
    await writeJson(root, 'governance/activation-state.json', finalized.successor);
    await writeJson(root, 'liftoff.manifest.json', { ...fixture.manifest, governance: { ...fixture.manifest.governance, activationIdentity: currentActivationIdentity } });
    const before = await readBytes(root);
    expect(await inspectActivationMigrationHistory(root)).toEqual({ status: 'none' });
    expect(await readMigrationJournal(root)).toBeUndefined();
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'current', history: { status: 'none' } });
    expect(await readBytes(root)).toEqual(before);
  });

  it('blocks an apparent v2 state if its active collection still contains v1 records', async () => {
    const { root, fixture } = await fixtureRoot();
    const finalized = finalizeActivationHistoryMigration(await eligible(root), approvedFingerprint, now);
    await writeJson(root, 'governance/activation-state.json', finalized.successor);
    await writeJson(root, 'liftoff.manifest.json', { ...fixture.manifest, governance: { ...fixture.manifest.governance, activationIdentity: currentActivationIdentity } });
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'invalid-current-proof' });
    expect(await readMigrationJournal(root)).toBeUndefined();
  });

  it('recomputes index identity from raw-byte inventory and refuses an unrelated snapshot', async () => {
    const { root, plan } = await committedFixture();
    expect(activationHistorySnapshotId(plan.index.sourceIdentity, plan.index.files)).toBe(plan.index.snapshotId);
    expect((await readActivationHistoryIndex(root, plan.index.snapshotId)).digest).toBe(plan.indexDigest);
    await expect(readActivationHistoryIndex(root, 'a'.repeat(64))).rejects.toThrow(/missing/);
  });
});
