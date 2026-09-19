import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import {
  readHistoricalActivationInventory, readHistoricalSnapshotInventory,
  validateHistoricalApprovalEnvelope, validateHistoricalEvidenceRecord, validateHistoricalSavedTransitionPlan
} from '../src/governance-activation/historical-state.js';
import {
  validateHistoricalV2ApprovalEnvelope, validateHistoricalV2EvidenceRecord, validateHistoricalV2SavedTransitionPlan
} from '../src/governance-activation/historical-v2.js';
import {
  validateHistoricalV3ApprovalEnvelope, validateHistoricalV3EvidenceRecord, validateHistoricalV3SavedTransitionPlan
} from '../src/governance-activation/historical-v3.js';
import {
  finalizeActivationHistoryMigration, planActivationHistoryMigration, readActivationHistoryIndex
} from '../src/governance-activation/migration-history.js';
import { readActivationEvidence, readReviewedTransitionPlans } from '../src/governance-activation/proof-records.js';
import { parseHistoryJson, validateActivationHistoryIndex } from '../src/governance-activation/history-contracts.js';
import {
  capturedTree, materializeReleasedFiles, readReleasedBaselineIndex, releasedBaselineDirectory,
  releasedBaselineIndexSha256, releasedBytes, releasedCase, releasedDigest, type CapturedActivation
} from './fixtures/released-baseline/corpus.js';
import { buildHistoricalV1Fixture, buildPostMaintenanceHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';

const index = readReleasedBaselineIndex();
const activations = index.cases.filter((entry): entry is CapturedActivation =>
  entry.family === 'activation' && !['history-v1-to-v2', 'activation-v3-disallowed-terminal'].includes(entry.id));
const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function copy(id: string) {
  const entry = releasedCase(id);
  const root = path.resolve('tests', `.released-baseline-characterization-${process.pid}-${randomUUID()}`);
  roots.add(root);
  await mkdir(root, { mode: 0o700 });
  await materializeReleasedFiles(root, entry.files);
  return { entry, root };
}

const validators = {
  1: { evidence: validateHistoricalEvidenceRecord, approval: validateHistoricalApprovalEnvelope, plan: validateHistoricalSavedTransitionPlan },
  2: { evidence: validateHistoricalV2EvidenceRecord, approval: validateHistoricalV2ApprovalEnvelope, plan: validateHistoricalV2SavedTransitionPlan },
  3: { evidence: validateHistoricalV3EvidenceRecord, approval: validateHistoricalV3ApprovalEnvelope, plan: validateHistoricalV3SavedTransitionPlan }
};

describe('Task 1.4: immutable source-released characterization corpus', () => {
  it.each([undefined, 2, 3] as const)('keeps the v1 fixture producer exact for maintained schema %s', (schema) => {
    const fixture = schema === undefined ? buildHistoricalV1Fixture() : buildPostMaintenanceHistoricalV1Fixture(schema);
    const entry = releasedCase(schema === undefined ? 'activation-v1' : `activation-v1-maintained-schema${schema}`);
    expect([...fixture.files.keys()].sort()).toEqual(entry.files.map((file) => file.path).sort());
    for (const file of entry.files) expect(fixture.files.get(file.path), file.path).toEqual(releasedBytes(file));
    expect(fixture.state).toEqual(JSON.parse(releasedBytes(entry.files.find((file) =>
      file.path === 'governance/activation-state.json')!).toString('utf8')));
  });

  it('binds every original buffer and extracted source blob to the peeled release commits', async () => {
    expect(releasedDigest(await readFile(path.join(releasedBaselineDirectory, 'index.json')))).toBe(releasedBaselineIndexSha256);
    expect(index.implementationBaseline).toEqual({ release: 'v0.12.3', commit: '70d10881b46d873118d825735696f39b6d35ebe0' });
    expect(index.sources.map(({ release, commit }) => ({ release, commit }))).toEqual([
      { release: 'v0.11.2', commit: '7ae307a0269f31cc4737336b8d445ade336e2ff0' },
      { release: 'v0.12.2', commit: '06cb0b065022663e5dafb3a295e14f6a0d221ab7' },
      { release: 'v0.12.3', commit: '70d10881b46d873118d825735696f39b6d35ebe0' }
    ]);
    const referenced = new Set<string>();
    const verify = (file: { sha256: string; byteLength: number }) => {
      const bytes = releasedBytes(file);
      expect(bytes.length).toBe(file.byteLength);
      expect(releasedDigest(bytes)).toBe(file.sha256);
      referenced.add(file.sha256);
      return bytes;
    };
    for (const source of index.sources) {
      expect(source.tagObject).toMatch(/^[a-f0-9]{40}$/u);
      expect(source.tagObject).not.toBe(source.commit);
      for (const file of source.files) {
        const bytes = verify(file);
        expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(file.gitBlob);
      }
      expect(JSON.parse(releasedBytes(source.files.find((file) => file.path === 'package.json')!).toString('utf8')).version)
        .toBe(source.release.slice(1));
      expect(new Set(source.journalExecutionFiles).size).toBe(source.journalExecutionFiles.length);
      expect(source.journalExecutionFiles).toContain('src/adapters/filesystem/reviewed-update-transaction.ts');
      expect(source.journalExecutionFiles).toContain('src/adapters/filesystem/update-previews.ts');
    }
    for (const entry of index.cases) {
      expect(new Set(entry.files.map((file) => file.path)).size).toBe(entry.files.length);
      entry.files.forEach(verify);
      if (entry.family === 'journal') {
        entry.externalSeals.forEach(verify);
        verify(entry.owner);
        verify(entry.handover);
      } else entry.externalAuthority?.forEach(verify);
    }
    expect(new Set(await readdir(path.join(releasedBaselineDirectory, 'blobs')))).toEqual(referenced);
    expect(referenced.size).toBe(index.counts.blobs);
  });

  it.each(activations)('reads complete $id records as original diagnostic data, never current proof', async (entry) => {
    const { root } = await copy(entry.id);
    const before = await capturedTree(root);
    const reviewedUnreferencedPathParts = entry.id === 'activation-v3-local'
      ? [entry.files.find((file) => file.path.startsWith('governance/plans/committed-'))!.path.split('/')] : [];
    const options = { reviewedUnreferencedPathParts };
    const initial = await readHistoricalActivationInventory(root);
    expect(initial.unreviewedRecords.map((file) => file.pathParts)).toEqual(reviewedUnreferencedPathParts);
    if (reviewedUnreferencedPathParts.length) {
      expect(await planActivationHistoryMigration(root)).toMatchObject({
        status: 'blocked', reasonCode: 'unreviewed-historical-records', unreviewedPathParts: reviewedUnreferencedPathParts
      });
    }
    const inventory = reviewedUnreferencedPathParts.length
      ? await readHistoricalActivationInventory(root, options) : initial;
    const originalState = parseHistoryJson(
      releasedBytes(entry.files.find((file) => file.path === 'governance/activation-state.json')!), 'captured state'
    );
    expect(inventory.state).toEqual(originalState);
    expect(inventory.unreviewedRecords).toEqual([]);
    const version = inventory.state.schemaVersion;
    const reader = validators[version];
    for (const file of entry.files) {
      const kind = /^governance\/(evidence|approvals|plans)\/[^/]+\.json$/u.exec(file.path)?.[1];
      if (!kind) continue;
      const raw = parseHistoryJson(releasedBytes(file), file.path);
      const untouched = structuredClone(raw);
      if (kind === 'evidence') expect(reader.evidence(raw)).toEqual(raw);
      if (kind === 'approvals') {
        expect(reader.approval(raw)).toEqual(raw);
        expect(() => validateApprovalEnvelope(raw)).toThrow();
      }
      if (kind === 'plans') {
        expect(reader.plan(raw)).toEqual(raw);
        expect(() => validateSavedTransitionPlan(raw)).toThrow();
      }
      expect(raw).toEqual(untouched);
    }
    expect(() => validateUserActivationState(originalState)).toThrow();
    await expect(loadActivationState(root)).rejects.toThrow(/historical.*diagnostic-only/iu);
    if (entry.files.some((file) => /^governance\/evidence\/[^/]+\.json$/u.test(file.path))) {
      await expect(readActivationEvidence(root)).rejects.toThrow();
      await expect(readReviewedTransitionPlans(root)).rejects.toThrow();
    }
    const plan = await planActivationHistoryMigration(root, options);
    expect(plan.status, JSON.stringify(plan.status === 'blocked' ? plan.issues : [])).toBe('eligible');
    if (plan.status !== 'eligible') throw new Error('Captured release history was not admitted.');
    expect(plan.semanticPlan.laneId).toBe(`activation-v${version}-to-v4`);
    expect(plan.semanticPlan.sourceIdentity).toEqual(inventory.state.identity);
    for (const file of plan.inventory.files) {
      const captured = entry.files.find((candidate) => candidate.path === file.pathParts.join('/'))!;
      expect(file.content).toEqual(releasedBytes(captured));
      expect(file.digest).toBe(captured.sha256);
    }
    const expectedAncestors = entry.id === 'activation-v2-with-v1-history' ? [1]
      : entry.id === 'activation-v3-with-v2-v1-history' ? [2, 1] : [];
    expect(plan.semanticPlan.ancestorHistory.map((reference) => reference.sourceIdentity.activationContractVersion)).toEqual(expectedAncestors);
    for (const reference of plan.semanticPlan.ancestorHistory) {
      const loaded = await readActivationHistoryIndex(root, reference.snapshotId);
      expect(loaded.digest).toBe(reference.historyIndexDigest);
      expect(validateActivationHistoryIndex(JSON.parse(loaded.content.toString('utf8')))).toEqual(loaded.index);
      const ancestor = await readHistoricalSnapshotInventory(root, loaded.index);
      expect(ancestor.state.identity).toEqual(reference.sourceIdentity);
      for (const file of loaded.index.files) {
        const captured = entry.files.find((candidate) => candidate.path === file.copyPathParts.join('/'))!;
        expect(releasedBytes(captured)).toEqual(await readFile(path.join(root, ...file.copyPathParts)));
        expect(captured.sha256).toBe(file.digest);
      }
    }
    const finalized = finalizeActivationHistoryMigration(
      plan, canonicalSha256({ characterization: entry.id }), new Date('2026-09-10T00:00:00.000Z')
    );
    expect(finalized.successor.identity).toEqual(currentActivationIdentity);
    expect(finalized.successor.identity).toMatchObject({ manifestArtifactVersion: 8, policyVersion: '8', activationContractVersion: 4 });
    for (const phase of Object.values(finalized.successor.phases)) {
      expect(phase.evidence).toEqual([]);
      expect(phase.approvals).toEqual([]);
      expect(phase.state).toBe('pending');
    }
    for (const file of plan.index.files) {
      const mutation = finalized.mutations.find((candidate) => candidate.pathParts.join('/') === file.copyPathParts.join('/'));
      expect(mutation?.type).toBe('write');
      if (mutation?.type !== 'write') throw new Error('Missing original-byte history copy.');
      expect(Buffer.from(mutation.content)).toEqual(releasedBytes(entry.files.find((candidate) =>
        candidate.path === file.originalPathParts.join('/'))!));
    }
    expect(await capturedTree(root)).toEqual(before);
  });

  it('retains the released v1-to-v2 successor serializer without pretending it is a reconciled project', async () => {
    const entry = releasedCase('history-v1-to-v2');
    const source = releasedCase('activation-v1');
    const files = new Map(entry.files.map((file) => [file.path, file]));
    const journal = JSON.parse(releasedBytes(files.get('governance/migration-state.json')!).toString('utf8'));
    expect(journal).toMatchObject({ schemaVersion: 1, laneId: 'activation-v1-to-v2', revalidation: { status: 'pending' } });
    const historyFile = files.get(journal.historyIndexPathParts.join('/'))!;
    expect(historyFile.sha256).toBe(journal.historyIndexDigest);
    const history = validateActivationHistoryIndex(JSON.parse(releasedBytes(historyFile).toString('utf8')));
    for (const file of history.files) {
      const original = source.files.find((candidate) => candidate.path === file.originalPathParts.join('/'))!;
      expect(releasedBytes(files.get(file.copyPathParts.join('/'))!)).toEqual(releasedBytes(original));
      expect(file.digest).toBe(original.sha256);
    }
    const { root } = await copy(entry.id);
    const before = await capturedTree(root);
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    expect(await capturedTree(root)).toEqual(before);
  });
});

describe('released-history refusal without repair or retagging', () => {
  it('refuses an exact released serializer output whose terminal state contradicts its phase graph', async () => {
    const { root } = await copy('activation-v3-disallowed-terminal');
    const before = await capturedTree(root);
    await expect(readHistoricalActivationInventory(root)).rejects.toThrow(/terminal result not allowed by the released phase/u);
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    expect(await capturedTree(root)).toEqual(before);
  });

  const negatives = ['activation-v1', 'activation-v2', 'activation-v3-local'].flatMap((id) =>
    ['future-schema', 'unknown-graph', 'mixed-tuple', 'unversioned'].map((variant) => ({ id, variant })));
  it.each(negatives)('blocks $id / $variant while preserving the deliberately corrupted copy', async ({ id, variant }) => {
    const { root } = await copy(id);
    const target = path.join(root, 'governance', 'activation-state.json');
    const value = JSON.parse(await readFile(target, 'utf8'));
    if (variant === 'future-schema') value.schemaVersion = 99;
    if (variant === 'unknown-graph') value.identity.phaseGraphHash = 'f'.repeat(64);
    if (variant === 'mixed-tuple') value.identity.policyVersion = '7';
    if (variant === 'unversioned') delete value.schemaVersion;
    await writeFile(target, `${JSON.stringify(value)}\n`);
    const before = await capturedTree(root);
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    await expect(loadActivationState(root)).rejects.toThrow();
    expect(await capturedTree(root)).toEqual(before);
  });

  it.each(['activation-v1', 'activation-v2', 'activation-v3-local'])('rejects future evidence in %s rather than filling or dropping it', async (id) => {
    const { root, entry } = await copy(id);
    const record = entry.files.find((file) => /^governance\/evidence\/[^/]+\.json$/u.test(file.path))!;
    const value = JSON.parse(releasedBytes(record).toString('utf8'));
    value.header.schemaVersion = 99;
    await writeFile(path.join(root, ...record.path.split('/')), JSON.stringify(value));
    const before = await capturedTree(root);
    expect((await planActivationHistoryMigration(root)).status).toBe('blocked');
    expect(await capturedTree(root)).toEqual(before);
  });

  it.each(['activation-v2-with-v1-history', 'activation-v3-with-v2-v1-history'])('blocks a byte-altered retained ancestor in %s', async (id) => {
    const { root, entry } = await copy(id);
    const ancestor = entry.files.find((file) => /^governance\/history\/[^/]+\/files\/governance\/evidence\/.+\.json$/u.test(file.path))!;
    await writeFile(path.join(root, ...ancestor.path.split('/')), Buffer.concat([releasedBytes(ancestor), Buffer.from('\r\n')]));
    const before = await capturedTree(root);
    expect(await planActivationHistoryMigration(root)).toMatchObject({ status: 'blocked', reasonCode: 'history-digest-mismatch' });
    expect(await capturedTree(root)).toEqual(before);
  });
});
