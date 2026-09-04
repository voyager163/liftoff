import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activationStateContentHash,
  activationStateFilePathParts,
  calculateGraphReconciliation,
  calculatePhaseReadiness,
  canonicalEvidenceContextForPhase,
  canonicalPhaseContractDigests,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  canonicalSha256,
  currentActivationIdentity,
  evidenceContextForPhase,
  evidenceHeaderDigest,
  phaseContractDigests,
  phaseIds,
  projectOpenSpecTaskCheckboxes,
  selectLatestPhaseEvidence,
  validateEvidenceFreshness,
  validateGraphReconciliationRecord,
  writeActivationState,
  loadActivationState
} from '../src/governance-activation/index.js';
import { applyProjectFileTransaction, validateArtifactPathParts } from '../src/file-system.js';
import type {
  EvidenceFreshnessContext,
  EvidenceHeader,
  GraphReconciliationRecord,
  LiveReadbackProof,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseId,
  UserActivationState
} from '../src/governance-activation/index.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);
const now = new Date('2026-09-04T10:27:49.594Z');
const scratchRoot = path.join(process.cwd(), '.cache', 'governance-evidence-tests');
let scratchCounter = 0;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function testRoot(name: string): string {
  scratchCounter += 1;
  return path.join(scratchRoot, `${name}-${process.pid}-${scratchCounter}`);
}

function validState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  const phases = Object.fromEntries(phaseIds.map((id) => [id, {
    state: 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: [],
    approvals: [],
    blockers: []
  }])) as UserActivationState['phases'];
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/repo',
      defaultBranch: 'main'
    },
    activeChange: {
      id: 'governance-activation',
      kind: 'openspec'
    },
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: true
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  };
}

function context(phaseId: PhaseId): EvidenceFreshnessContext {
  return evidenceContextForPhase(phaseId, {
    baselineSha: digestA,
    inputDigest: digestB,
    transitionDigest: digestC,
    now
  });
}

function headerFor(
  freshness: EvidenceFreshnessContext,
  result: EvidenceHeader['result'] = 'verified',
  producedAt = '2026-09-04T00:00:00.000Z'
): EvidenceHeader {
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: freshness.repositoryId,
    identity: freshness.identity,
    phaseGraphHash: freshness.phaseGraphHash,
    phaseId: freshness.phaseId,
    phaseContractDigest: freshness.phaseContractDigest,
    inputDigest: freshness.inputDigest,
    baselineSha: freshness.baselineSha,
    transition: freshness.transition,
    producedAt,
    producer: 'vitest',
    result
  };
}

function recordFor(
  evidenceId: string,
  freshness: EvidenceFreshnessContext,
  result: EvidenceHeader['result'] = 'verified',
  producedAt = '2026-09-04T00:00:00.000Z',
  liveReadback?: readonly LiveReadbackProof[]
): PhaseEvidenceRecord {
  return {
    evidenceId,
    header: headerFor(freshness, result, producedAt),
    ...(liveReadback ? { liveReadback } : {})
  };
}

function liveProof(
  freshness: EvidenceFreshnessContext,
  provider: LiveReadbackProof['provider'],
  matches = true
): LiveReadbackProof {
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: freshness.repositoryId,
    identity: freshness.identity,
    phaseGraphHash: freshness.phaseGraphHash,
    phaseId: freshness.phaseId,
    baselineSha: freshness.baselineSha,
    inputDigest: freshness.inputDigest,
    transition: freshness.transition,
    observedAt: '2026-09-04T00:00:00.000Z',
    provider,
    resourceType: provider === 'github' ? 'ruleset' : 'azure-resource',
    resourceId: provider === 'github' ? 'owner/repo/rulesets/1' : '/subscriptions/000/resourceGroups/rg',
    sourceDigest: digestA,
    readbackDigest: digestA,
    matches
  };
}

function reconciliationRecord(
  fromGraphHash: string,
  toGraphHash: string,
  fromDigests: Record<PhaseId, string>,
  toDigests: Record<PhaseId, string>
): GraphReconciliationRecord {
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    fromGraphHash,
    toGraphHash,
    fromIdentity: { ...currentActivationIdentity, phaseGraphHash: fromGraphHash },
    toIdentity: { ...currentActivationIdentity, phaseGraphHash: toGraphHash },
    phaseMappings: phaseIds.map((phaseId) => ({
      phaseId,
      fromContractDigest: fromDigests[phaseId],
      toContractDigest: toDigests[phaseId],
      preserveEvidence: fromDigests[phaseId] === toDigests[phaseId]
    })),
    reconciledAt: '2026-09-04T00:00:00.000Z',
    producer: 'vitest'
  };
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe('evidence validation and latest selection', () => {
  it('reports precise stale, mismatched, and malformed evidence identity fields', () => {
    const freshness = context('seed-valid');
    const valid = validateEvidenceFreshness(recordFor('fresh', freshness), freshness);
    expect(valid.valid).toBe(true);

    const stale = validateEvidenceFreshness(recordFor('stale', freshness), {
      ...freshness,
      repositoryId: 'R_999',
      baselineSha: '9'.repeat(64),
      inputDigest: '8'.repeat(64),
      transition: {
        ...freshness.transition,
        baselineSha: '9'.repeat(64),
        inputDigest: '8'.repeat(64),
        transitionDigest: '7'.repeat(64)
      }
    });
    expect(stale.valid).toBe(false);
    expect(stale.valid ? [] : stale.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining([
      'repositoryId',
      'baselineSha',
      'inputDigest',
      'transition.baselineSha',
      'transition.inputDigest',
      'transition.transitionDigest'
    ]));

    const malformed: Record<string, unknown> = {
      ...headerFor(freshness),
      identity: {
        ...freshness.identity
      },
      producedAt: 'not-a-date'
    };
    const identity = malformed.identity as Record<string, unknown>;
    delete identity.credentialPolicySchemaVersion;
    const schemaFailure = validateEvidenceFreshness({ evidenceId: 'bad-schema', header: malformed as unknown as EvidenceHeader }, freshness);
    expect(schemaFailure.valid).toBe(false);
    expect(schemaFailure.valid ? '' : schemaFailure.issues[0]!.message).toContain('credentialPolicySchemaVersion');

    const invalidTimestamp = {
      ...headerFor(freshness),
      producedAt: 'not-a-date'
    };
    const timestampFailure = validateEvidenceFreshness({
      evidenceId: 'bad-time',
      header: invalidTimestamp
    }, freshness);
    expect(timestampFailure.valid).toBe(false);
    expect(timestampFailure.valid ? '' : timestampFailure.issues[0]!.message).toContain('producedAt');

    const invalidResult = {
      ...headerFor(freshness),
      result: 'pending'
    };
    const resultFailure = validateEvidenceFreshness({
      evidenceId: 'bad-result',
      header: invalidResult as unknown as EvidenceHeader
    }, freshness);
    expect(resultFailure.valid).toBe(false);
    expect(resultFailure.valid ? '' : resultFailure.issues[0]!.message).toContain('result');
  });

  it('selects latest valid evidence by identity and transition with deterministic duplicate behavior', () => {
    const freshness = context('seed-valid');
    const olderFailed = recordFor('older-failed', freshness, 'failed', '2026-09-04T00:00:00.000Z');
    const newerVerified = recordFor('newer-verified', freshness, 'verified', '2026-09-04T01:00:00.000Z');
    const selected = selectLatestPhaseEvidence([olderFailed, newerVerified], freshness);
    expect(selected.selected?.evidenceId).toBe('newer-verified');
    expect(selected.ignoredOlderContradictions).toEqual(['older-failed']);

    const sameResultTie = selectLatestPhaseEvidence([
      recordFor('a-record', freshness, 'verified', '2026-09-04T02:00:00.000Z'),
      recordFor('b-record', freshness, 'verified', '2026-09-04T02:00:00.000Z')
    ], freshness);
    expect(sameResultTie.selected?.evidenceId).toBe('b-record');

    const contradictoryTie = selectLatestPhaseEvidence([
      recordFor('verified', freshness, 'verified', '2026-09-04T03:00:00.000Z'),
      recordFor('failed', freshness, 'failed', '2026-09-04T03:00:00.000Z')
    ], freshness);
    expect(contradictoryTie.selected).toBeNull();
    expect(contradictoryTie.issues[0]?.message).toContain('contradictory deterministic tie');
  });

  it('blocks readiness when the latest evidence for the current transition failed', () => {
    const freshness = context('seed-valid');
    const readiness = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [recordFor('current-failure', freshness, 'failed')],
      transitionContexts: { 'seed-valid': freshness },
      now
    });
    expect(readiness.phases['seed-valid'].state).toBe('failed');
    expect(readiness.phases['seed-verified'].state).toBe('blocked');
  });
});

describe('graph reconciliation records', () => {
  it('preserves compatible immutable evidence and invalidates changed reverse-dependency descendants', () => {
    const nextGraph = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    const providerReady = nextGraph.phases.find((phase) => phase.id === 'provider-ready')!;
    providerReady.allowedMutations.local = ['write-evidence', 'write-local-state'];
    const nextHash = canonicalSha256(nextGraph);
    const record = reconciliationRecord(
      canonicalPhaseGraphHash,
      nextHash,
      canonicalPhaseContractDigests,
      phaseContractDigests(nextGraph)
    );

    const result = calculateGraphReconciliation(record, {
      fromGraph: canonicalPhaseGraph,
      toGraph: nextGraph,
      recognizedGraphHashes: new Set([canonicalPhaseGraphHash, nextHash])
    });
    expect(result.preservedPhaseIds).toContain('seed-valid');
    expect(result.preservedPhaseIds).toContain('credential-ready');
    expect(result.invalidPhaseIds).toEqual(expect.arrayContaining([
      'provider-ready',
      'state-path-selected',
      'bootstrap-local',
      'remote-ready'
    ]));
    expect(result.invalidPhaseIds).not.toContain('seed-valid');

    const invalidPreserve = {
      ...record,
      phaseMappings: record.phaseMappings.map((mapping) =>
        mapping.phaseId === 'provider-ready' ? { ...mapping, preserveEvidence: true } : mapping
      )
    };
    expect(() => validateGraphReconciliationRecord(invalidPreserve, new Set([canonicalPhaseGraphHash, nextHash])))
      .toThrow(/cannot preserve evidence for changed phase provider-ready/);
  });

  it('requires old and new graph hashes to be recognized', () => {
    const record = reconciliationRecord(
      canonicalPhaseGraphHash,
      canonicalPhaseGraphHash,
      canonicalPhaseContractDigests,
      canonicalPhaseContractDigests
    );
    expect(() => validateGraphReconciliationRecord({
      ...record,
      fromGraphHash: '4'.repeat(64),
      fromIdentity: { ...record.fromIdentity, phaseGraphHash: '4'.repeat(64) }
    })).toThrow(/fromGraphHash is not a recognized graph hash/);
  });
});

describe('OpenSpec checkbox projection', () => {
  it('corrects checkboxes from calculated phase state and preserves unrelated text', () => {
    const markdown = [
      '# Tasks',
      '- [x] 2.1 Validate evidence',
      '- [x] 2.2 Select evidence',
      '- [ ] unrelated task'
    ].join('\n');
    const result = projectOpenSpecTaskCheckboxes(markdown, [
      { phaseId: 'seed-valid', taskId: '2.1' },
      { phaseId: 'seed-verified', taskId: '2.2' }
    ], {
      'seed-valid': 'verified',
      'seed-verified': 'failed'
    });
    expect(result.markdown).toContain('- [x] 2.1 Validate evidence');
    expect(result.markdown).toContain('- [ ] 2.2 Select evidence');
    expect(result.markdown).toContain('- [ ] unrelated task');
    expect(result.changes).toHaveLength(1);

    const readiness = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [],
      now
    });
    expect(readiness.phases['seed-verified'].state).toBe('blocked');
  });

  it('rejects ambiguous and missing task mappings instead of guessing', () => {
    expect(() => projectOpenSpecTaskCheckboxes('- [ ] 2.1 A\n- [x] 2.1 B', [
      { phaseId: 'seed-valid', taskId: '2.1' }
    ], { 'seed-valid': 'verified' })).toThrow(/ambiguous/);
    expect(() => projectOpenSpecTaskCheckboxes('- [ ] 2.1 A', [
      { phaseId: 'seed-valid', taskId: '2.1' }
    ], {})).toThrow(/missing calculated phase state/);
  });
});

describe('live readback proof requirements', () => {
  it('rejects source-only evidence for remote mutations and accepts typed live readback', () => {
    const freshness = canonicalEvidenceContextForPhase('rulesets-applied');
    const sourceOnly = validateEvidenceFreshness(recordFor('source-only', freshness), freshness);
    expect(sourceOnly.valid).toBe(false);
    expect(sourceOnly.valid ? '' : sourceOnly.issues.map((issue) => issue.message).join('\n')).toContain('github live readback proof');

    const withReadback = validateEvidenceFreshness(
      recordFor('live', freshness, 'verified', '2026-09-04T00:00:00.000Z', [liveProof(freshness, 'github')]),
      freshness
    );
    expect(withReadback.valid).toBe(true);
  });

  it('does not require live readback for read-only phases', () => {
    const freshness = canonicalEvidenceContextForPhase('phase-0-complete');
    expect(validateEvidenceFreshness(recordFor('phase-zero', freshness), freshness).valid).toBe(true);
  });
});

describe('activation-state transactions', () => {
  it('writes canonical state, compares prior hash/version, and reloads it', async () => {
    const root = testRoot('success');
    await mkdir(root, { recursive: true });
    const state = validState();
    const written = await writeActivationState(root, state, { expectedContentHash: null });
    const loaded = await loadActivationState(root);
    expect(loaded?.contentHash).toBe(written.contentHash);
    expect(loaded?.schemaVersion).toBe(currentActivationIdentity.activationStateSchemaVersion);
    expect(written.pathParts).toEqual(activationStateFilePathParts);
    expect(activationStateContentHash(written.content)).toBe(written.contentHash);
    expect(written.content).toBe(JSON.stringify(JSON.parse(written.content)) + '\n');
  });

  it('rejects concurrent writes and interrupted writes roll back to the last valid state', async () => {
    const root = testRoot('rollback');
    await mkdir(root, { recursive: true });
    const initial = await writeActivationState(root, validState(), { expectedContentHash: null });
    const nextState = validState({ updatedAt: '2026-09-04T01:00:00.000Z' });
    const next = await writeActivationState(root, nextState, {
      expectedContentHash: initial.contentHash,
      expectedSchemaVersion: initial.schemaVersion,
      expectedContent: initial.content
    });
    await expect(writeActivationState(root, validState({ updatedAt: '2026-09-04T02:00:00.000Z' }), {
      expectedContentHash: initial.contentHash
    })).rejects.toThrow(/changed concurrently/);

    const interrupted = writeActivationState(root, validState({ updatedAt: '2026-09-04T03:00:00.000Z' }), {
      expectedContentHash: next.contentHash
    }, { failAfterReplace: true });
    await expect(interrupted).rejects.toThrow(/transactionally/);
    const disk = await readFile(path.join(root, ...activationStateFilePathParts), 'utf8');
    expect(disk).toBe(next.content);
    expect((await readdir(path.join(root, 'governance'))).filter((entry) => entry.includes('.liftoff-'))).toEqual([]);
  });

  it('does not silently initialize over malformed or incompatible existing state', async () => {
    const root = testRoot('malformed');
    await mkdir(path.join(root, 'governance'), { recursive: true });
    await writeFile(path.join(root, ...activationStateFilePathParts), '{malformed', 'utf8');
    await expect(loadActivationState(root)).rejects.toThrow(/Unable to parse/);
    await expect(writeActivationState(root, validState(), { expectedContentHash: null })).rejects.toThrow(/Unable to parse/);

    await writeFile(path.join(root, ...activationStateFilePathParts), JSON.stringify({
      ...validState(),
      identity: { ...currentActivationIdentity, phaseGraphHash: '9'.repeat(64) }
    }), 'utf8');
    await expect(loadActivationState(root)).rejects.toThrow(/Invalid governance\/activation-state.json/);
  });

  it('uses Windows, macOS, and Linux safe path parts for user-owned state', () => {
    expect(validateArtifactPathParts([...activationStateFilePathParts], 'Activation state path'))
      .toEqual(['governance', 'activation-state.json']);
    expect(path.posix.join('/repo', ...activationStateFilePathParts)).toBe('/repo/governance/activation-state.json');
    expect(path.win32.join('C:\\repo', ...activationStateFilePathParts)).toBe('C:\\repo\\governance\\activation-state.json');
    for (const unsafe of [
      ['..', 'activation-state.json'],
      ['governance', 'CON'],
      ['governance', 'state/activation-state.json'],
      ['governance', 'C:\\state.json'],
      ['governance', '\\\\server\\share\\state.json'],
      ['governance', '/var/state.json'],
      ['governance', 'activation-state.json '],
      ['governance', 'activation-state.json.']
    ]) {
      expect(() => validateArtifactPathParts(unsafe, 'Activation state path')).toThrow();
    }
  });

  it.runIf(process.platform !== 'win32')('preserves file permissions during transaction rollback when chmod is supported', async () => {
    const root = testRoot('permission-rollback');
    await mkdir(root, { recursive: true });
    const file = path.join(root, 'state.json');
    await writeFile(file, 'before\n', 'utf8');
    await chmod(file, 0o640);
    const beforeMode = (await stat(file)).mode & 0o777;

    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['state.json'], content: 'after\n' },
      { type: 'write', pathParts: ['created', 'nested.txt'], content: 'new\n' }
    ], {
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          throw new Error('injected rollback');
        }
      }
    })).rejects.toThrow(/rolled back/);

    expect(await readFile(file, 'utf8')).toBe('before\n');
    expect((await stat(file)).mode & 0o777).toBe(beforeMode);
    await expect(readdir(path.join(root, 'created'))).rejects.toThrow();
  });
});

describe('evidence references are immutable', () => {
  it('hashes evidence headers without rewriting old evidence', () => {
    const freshness = context('seed-valid');
    const record = recordFor('immutable', freshness);
    expect(evidenceHeaderDigest(record.header)).toMatch(/^[a-f0-9]{64}$/);
  });
});
