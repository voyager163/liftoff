import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { releasedV3RecordValidators } from '../src/domain/governance/activation/record-validation.js';
import {
  historicalActivationIdentities, isHistoricalActivationIdentity, isReleasedV3ActivationIdentity,
  releasedV3ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import { validateActivationIdentity, validateApprovalEnvelope } from '../src/domain/governance/activation/validators.js';
import {
  historicalV3PhaseGraph, historicalV3PhaseContractDigest, historicalV3EvidenceBodyDigest,
  validateHistoricalV3ActivationState, validateHistoricalV3EvidenceHeader, validateHistoricalV3EvidenceRecord,
  validateHistoricalV3LiveReadback, validateHistoricalV3ApprovalEnvelope, validateHistoricalV3SavedTransitionPlan,
  validateHistoricalV3CredentialPolicy, validateHistoricalV3AuxiliaryRecord
} from '../src/governance-activation/historical-v3.js';
import {
  activationHistoryCopyPathParts, activationHistoryIndexPathParts, activationHistorySnapshotId,
  historyArray, historyRecord, rawHistoryDigest, validateActivationHistoryIndex, validateHistoricalV3SourceMigrationJournal
} from '../src/governance-activation/history-contracts.js';
import { readHistoricalActivationInventory, readReleasedV3SourceHistory } from '../src/governance-activation/historical-state.js';
import { validateHistoricalGovernanceChangeMetadata, validateHistoricalV3GovernanceChangeMetadata } from '../src/governance-activation/historical-source-metadata.js';
import {
  capturedV3Records, capturedV3Successor, releasedV3GraphSha256,
  writeCapturedV3Successor, writeFixtureBytes
} from './fixtures/activation-v3/fixture.js';
import { writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-history-'));
  roots.push(directory);
  return directory;
}
function raw(key: string) { return historyRecord(capturedV3Records()[key], key); }
function first(key: string) { return historyRecord(historyArray(capturedV3Records()[key], key)[0], key); }

describe('frozen released-v3 structural contracts', () => {
  it('keeps the exact captured graph, identity and current eligibility unchanged', async () => {
    const fixture = capturedV3Records();
    const bytes = await readFile('assets/governance/single-maintainer-gitflow/activation-v3-graph.json');
    expect(rawHistoryDigest(bytes)).toBe(fixture.graphRawSha256);
    expect(canonicalSha256(historicalV3PhaseGraph())).toBe(releasedV3GraphSha256);
    expect(historicalV3PhaseGraph()).toEqual(canonicalPhaseGraph);
    expect(releasedV3ActivationIdentity).toEqual(currentActivationIdentity);
    expect(validateActivationIdentity(fixture.identity)).toEqual(currentActivationIdentity);
    expect(isHistoricalActivationIdentity(fixture.identity)).toBe(false);
    expect(historicalActivationIdentities).toHaveLength(2);
    const changed = historicalV3PhaseGraph();
    changed.phases = [];
    expect(() => releasedV3RecordValidators(changed)).toThrow(/exact packaged graph/);
    expect(historicalV3PhaseGraph().phases).toHaveLength(29);
  });

  it('preserves all 29 phases and optional state, plan, credential and source metadata fields', () => {
    const fixture = capturedV3Records();
    expect(validateHistoricalV3ActivationState(fixture.state)).toEqual(fixture.state);
    expect(Object.keys(validateHistoricalV3ActivationState(fixture.state).phases)).toHaveLength(29);
    expect(validateHistoricalV3SavedTransitionPlan(first('plans'))).toEqual(first('plans'));
    expect(validateHistoricalV3CredentialPolicy(fixture.credential)).toEqual(fixture.credential);
    expect(validateHistoricalV3GovernanceChangeMetadata(fixture.metadata)).toEqual(fixture.metadata);
    expect(() => validateHistoricalGovernanceChangeMetadata(fixture.metadata)).toThrow();
    expect(() => validateHistoricalV3AuxiliaryRecord(fixture.supersession, 'supersession')).not.toThrow();
    expect(() => validateHistoricalV3AuxiliaryRecord(fixture.reconciliation, 'reconciliation')).not.toThrow();
    expect(() => validateHistoricalV3AuxiliaryRecord(fixture.credential, 'credential-policy')).not.toThrow();
  });

  it('does not turn expired readable approval into executable consent', () => {
    const approval = first('approvals');
    expect(validateHistoricalV3ApprovalEnvelope(approval)).toEqual(approval);
    expect(() => validateApprovalEnvelope(approval, { requireUnexpired: true, now: new Date('2026-09-27T00:00:00.000Z') })).toThrow(/expiresAt must be in the future/);
  });

  it.each(Object.keys(releasedV3ActivationIdentity))('rejects mixed or future identity field %s', (field) => {
    const state = raw('state');
    const identity = historyRecord(state.identity, 'identity');
    const original = identity[field];
    identity[field] = typeof original === 'number' ? original + 1 : `${original}-future`;
    expect(isReleasedV3ActivationIdentity(identity)).toBe(false);
    expect(() => validateHistoricalV3ActivationState(state)).toThrow();
  });

  it('rejects extra fields, missing phases, invented phases and invalid retention times', () => {
    expect(() => validateHistoricalV3ActivationState({ ...raw('state'), invented: true })).toThrow();
    const missing = raw('state');
    delete historyRecord(missing.phases, 'phases')['application-artifact-ready'];
    expect(() => validateHistoricalV3ActivationState(missing)).toThrow(/application-artifact-ready/);
    const extra = raw('state');
    historyRecord(extra.phases, 'phases')['manual-local-complete'] = first('plans');
    expect(() => validateHistoricalV3ActivationState(extra)).toThrow(/canonical phase/);
    const retention = raw('state');
    historyRecord(retention.bootstrapState, 'retention').disposeAfter = '2026-09-01T00:00:00.000Z';
    expect(() => validateHistoricalV3ActivationState(retention)).toThrow(/30 days/);
    const phases = raw('metadata');
    historyArray(phases.phaseTaskMapping, 'mappings').pop();
    expect(() => validateHistoricalV3GovernanceChangeMetadata(phases)).toThrow(/every published/);
  });

  it('validates body-bound proof against frozen phase semantics without current retagging', () => {
    const proof = first('evidence');
    const header = historyRecord(proof.header, 'header');
    expect(validateHistoricalV3EvidenceRecord(proof)).toEqual(proof);
    expect(validateHistoricalV3EvidenceHeader(header).phaseContractDigest).toBe(historicalV3PhaseContractDigest('seed-valid'));
    expect(() => validateHistoricalV3EvidenceRecord(header)).toThrow();
    expect(() => validateHistoricalV3EvidenceRecord({ ...proof, payload: { altered: true } })).toThrow(/body digest/);
    expect(() => validateHistoricalV3EvidenceHeader({ ...header, phaseContractDigest: '0'.repeat(64) })).toThrow(/phase digest/);
    expect(() => validateHistoricalV3EvidenceHeader({ ...header, result: 'inapplicable' })).toThrow(/terminal result/);
    expect(() => validateHistoricalV3EvidenceRecord({ ...proof, secret: 'do-not-copy' })).toThrow();
  });

  it('rejects the captured structurally valid but cross-record-inconsistent readback', () => {
    // Original capture is immutable: current structural validators did not check
    // this relationship. Keep it as a rejection fixture, never bless its bytes.
    const proof = historyRecord(historyArray(capturedV3Records().evidence, 'evidence')[1], 'evidence');
    const readback = historyRecord(historyArray(proof.liveReadback, 'readback')[0], 'readback');
    expect(validateHistoricalV3LiveReadback(readback)).toEqual(readback);
    expect(() => validateHistoricalV3EvidenceRecord(proof)).toThrow(/original reviewed transition/);
    const header = historyRecord(proof.header, 'header');
    const transition = historyRecord(header.transition, 'transition');
    readback.inputDigest = transition.inputDigest;
    readback.transition = transition;
    header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload, [validateHistoricalV3LiveReadback(readback)]);
    expect(validateHistoricalV3EvidenceRecord(proof)).toEqual(proof);
  });
});

describe('read-only released-v3 ancestor relationships', () => {
  it.each([1, 2] as const)('retains exact v%s originals, index bytes and recorded modes', async (family) => {
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, family);
    const before = await Promise.all(captured.index.files.map(file => readFile(path.join(directory, ...file.copyPathParts))));
    const read = await readReleasedV3SourceHistory(directory);
    expect(read.ancestors).toHaveLength(1);
    expect(read.ancestors[0].index).toEqual(captured.index);
    expect(read.ancestors[0].inventory.files.map(file => file.mode)).toEqual(captured.index.files.map(file => file.mode));
    expect(await Promise.all(captured.index.files.map(file => readFile(path.join(directory, ...file.copyPathParts))))).toEqual(before);
    expect(await readFile(path.join(directory, ...captured.journal.historyIndexPathParts))).toEqual(captured.indexContent);
    expect(read.state.activeChange).toBeNull();
  });

  it('distinguishes no-history from a missing declared journal', async () => {
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, 2);
    await unlink(path.join(directory, 'governance', 'migration-state.json'));
    await expect(readReleasedV3SourceHistory(directory)).rejects.toThrow(/missing source migration journal/);
    const { successorHistory: _history, ...state } = captured.state;
    await writeFixtureBytes(directory, ['governance', 'activation-state.json'], JSON.stringify(state));
    expect((await readReleasedV3SourceHistory(directory)).ancestors).toEqual([]);
  });

  it.each(['copy', 'index', 'backlink', 'tuple', 'anchor'] as const)('rejects corrupted %s without repairing source data', async (kind) => {
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, 1);
    if (kind === 'copy') await writeFixtureBytes(directory, captured.index.files[0].copyPathParts, 'altered original');
    if (kind === 'index') await writeFixtureBytes(directory, captured.journal.historyIndexPathParts, JSON.stringify(captured.index));
    if (kind === 'backlink') captured.state.successorHistory!.historyIndexDigest = '0'.repeat(64);
    if (kind === 'tuple') historyRecord(captured.state.identity, 'identity').activationContractVersion = 4;
    if (kind === 'anchor') captured.state.repository.id = 'local:00000000-0000-4000-8000-000000000009';
    await writeFixtureBytes(directory, ['governance', 'activation-state.json'], JSON.stringify(captured.state));
    const before = await readFile(path.join(directory, 'governance', 'activation-state.json'));
    await expect(readReleasedV3SourceHistory(directory)).rejects.toThrow();
    expect(await readFile(path.join(directory, 'governance', 'activation-state.json'))).toEqual(before);
  });

  it('rejects unknown published lanes and targets without version-order inference', () => {
    const { journal } = capturedV3Successor(2);
    expect(() => validateHistoricalV3SourceMigrationJournal({ ...journal, laneId: 'activation-v2-to-v4' })).toThrow();
    expect(() => validateHistoricalV3SourceMigrationJournal({ ...journal, targetIdentity: { ...journal.targetIdentity, phaseGraphHash: '0'.repeat(64) } })).toThrow();
    expect(() => validateHistoricalV3SourceMigrationJournal({ ...journal, sourceIdentity: journal.targetIdentity })).toThrow();
  });

  it('does not accept completed journal work without its exact original proof links', async () => {
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, 2);
    const journal = {
      ...captured.journal,
      revalidation: {
        ...captured.journal.revalidation, status: 'complete', nextAction: null,
        phases: captured.journal.revalidation.phases.map(phase => ({
          ...phase, status: 'complete', evidenceIds: [`missing-${phase.phaseId}`]
        }))
      }
    };
    await writeFixtureBytes(directory, ['governance', 'migration-state.json'], JSON.stringify(journal));
    await expect(readReleasedV3SourceHistory(directory)).rejects.toThrow(/original matching proof reference/);
  });

  it('rejects path aliases and traversal even when an edited journal rehashes the index', async () => {
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, 1);
    captured.index.files[0].copyPathParts = ['governance', 'history', '..', 'escape.json'];
    const indexBytes = Buffer.from(JSON.stringify(captured.index));
    captured.journal.historyIndexDigest = rawHistoryDigest(indexBytes);
    captured.state.successorHistory!.historyIndexDigest = captured.journal.historyIndexDigest;
    await writeFixtureBytes(directory, captured.journal.historyIndexPathParts, indexBytes);
    await writeFixtureBytes(directory, ['governance', 'activation-state.json'], JSON.stringify(captured.state));
    await writeFixtureBytes(directory, ['governance', 'migration-state.json'], JSON.stringify(captured.journal));
    await expect(readReleasedV3SourceHistory(directory)).rejects.toThrow(/unsafe|portable/);
  });

  it('validates a v3 -> v2 -> v1 chain and rejects a damaged ancestor', async () => {
    const v1 = capturedV3Successor(1);
    const sourceRoot = await root();
    await writeHistoricalV2Fixture(sourceRoot, {
      retention: 'retained',
      ancestor: { index: v1.index, indexContent: v1.indexContent, files: v1.files }
    });
    const inventory = await readHistoricalActivationInventory(sourceRoot, {
      reviewedUnreferencedPathParts: []
    });
    const originals = inventory.files.map(file => ({
      kind: file.kind, originalPathParts: file.pathParts, digest: file.digest, mode: file.mode
    }));
    const snapshotId = activationHistorySnapshotId(inventory.state.identity, originals);
    const index = validateActivationHistoryIndex({
      schemaVersion: 1, snapshotId, sourceIdentity: inventory.state.identity,
      files: originals.map(file => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
    });
    const directory = await root();
    const captured = await writeCapturedV3Successor(directory, 2);
    const indexContent = Buffer.from(canonicalJson(index));
    const indexDigest = rawHistoryDigest(indexContent);
    const journal = { ...captured.journal, snapshotId, historyIndexPathParts: activationHistoryIndexPathParts(snapshotId), historyIndexDigest: indexDigest };
    const state = {
      ...captured.state,
      successorHistory: { ...captured.state.successorHistory!, snapshotId, historyIndexPathParts: journal.historyIndexPathParts, historyIndexDigest: indexDigest }
    };
    await writeFixtureBytes(directory, ['governance', 'activation-state.json'], canonicalJson(state));
    await writeFixtureBytes(directory, ['governance', 'migration-state.json'], canonicalJson(journal));
    await writeFixtureBytes(directory, journal.historyIndexPathParts, indexContent);
    for (const file of index.files) {
      await writeFixtureBytes(directory, file.copyPathParts, inventory.files.find(source => source.pathParts.join('/') === file.originalPathParts.join('/'))!.content);
    }
    await writeFixtureBytes(directory, v1.journal.historyIndexPathParts, v1.indexContent);
    for (const file of v1.index.files) await writeFixtureBytes(directory, file.copyPathParts, v1.files.get(file.originalPathParts.join('/'))!);
    const result = await readReleasedV3SourceHistory(directory);
    expect(result.ancestors.map(ancestor => ancestor.index.sourceIdentity.activationContractVersion)).toEqual([2, 1]);
    expect(result.ancestors[0].inventory.state.bootstrapState?.retainedAt).toBe(inventory.state.bootstrapState?.retainedAt);
    expect(result.ancestors[0].inventory.state.bootstrapState?.disposeAfter).toBe(inventory.state.bootstrapState?.disposeAfter);
    await unlink(path.join(directory, ...v1.journal.historyIndexPathParts));
    await expect(readReleasedV3SourceHistory(directory)).rejects.toThrow(/raw digest/);
  });
});
