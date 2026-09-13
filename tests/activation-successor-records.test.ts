import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, resolveActivationCompatibility, buildActivationCompatibilityMap
} from '../src/domain/governance/policy/identity.js';
import { validateApprovalEnvelope, validateEvidenceHeader, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import {
  activationHistoryIndexPathParts, historyPathParts, parseHistoryJson, rawHistoryDigest,
  validateHistoricalV2SourceMigrationJournal, validateMigrationJournal
} from '../src/governance-activation/history-contracts.js';
import {
  captureHistoryFile, readHistoricalActivationInventory, validateHistoricalActivationState, validateHistoricalApprovalEnvelope
} from '../src/governance-activation/historical-state.js';
import {
  historicalV2PhaseGraph, historicalV2PhaseContractDigest, validateHistoricalV2ActivationState, validateHistoricalV2ApprovalEnvelope,
  validateHistoricalV2Compatibility, validateHistoricalV2EvidenceRecord, validateHistoricalV2SavedTransitionPlan
} from '../src/governance-activation/historical-v2.js';
import {
  finalizeActivationHistoryMigration, historicalLifecyclePhaseBlockers, inspectActivationMigrationHistory,
  planActivationHistoryMigration, type ActivationHistoryMutation, type EligibleActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { planHistoricalActivationStateMigration } from '../src/governance-activation/migration.js';
import {
  buildGovernanceCompatibilityMetadata, packagedActivationSuccessorMigrations, validateGovernanceCompatibilityMetadata
} from '../src/governance-activation/compatibility.js';
import { captureMigrationRetainedProjectInputs, migrationSensitivePathExclusions } from '../src/governance-activation/historical-inputs.js';
import { applyProjectFileTransaction } from '../src/adapters/filesystem/project-transaction.js';
import { buildHistoricalV1Fixture, writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { historicalFixtureGraph } from './fixtures/activation-v1/graph.js';
import { buildHistoricalV2Fixture, writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';
import { historicalV1PhaseContractDigests } from '../src/governance-activation/historical-v1-phase-contracts.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';

const roots = new Set<string>();
const now = new Date('2026-09-12T00:00:00.000Z');
const approved = canonicalSha256({ explicitReviewedPlan: 'activation-control-records-only' });
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function root() {
  const directory = path.resolve('tests', `.activation-successor-${process.pid}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  roots.add(directory);
  return directory;
}

async function fixture(options: Parameters<typeof buildHistoricalV2Fixture>[0] = {}) {
  const directory = await root();
  return { root: directory, source: await writeHistoricalV2Fixture(directory, options) };
}

async function writeJson(directory: string, parts: string[], value: unknown) {
  const target = path.join(directory, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, '\t')}\r\n`);
}

async function bytes(directory: string) {
  const files = new Map<string, Buffer>();
  const walk = async (parts: string[]) => {
    for (const entry of await readdir(path.join(directory, ...parts), { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.set(child.join('/'), await readFile(path.join(directory, ...child)));
    }
  };
  await walk([]);
  return files;
}

async function eligible(directory: string): Promise<EligibleActivationHistoryMigration> {
  let plan = await planActivationHistoryMigration(directory);
  if (plan.status === 'blocked' && plan.reasonCode === 'unreviewed-historical-records') {
    plan = await planActivationHistoryMigration(directory, { reviewedUnreferencedPathParts: plan.unreviewedPathParts });
  }
  if (plan.status !== 'eligible') throw new Error(JSON.stringify(plan));
  return plan;
}

async function install(directory: string, mutations: readonly ActivationHistoryMutation[]) {
  for (const mutation of mutations) {
    const destination = path.join(directory, ...mutation.pathParts);
    if (mutation.type === 'delete') await unlink(destination);
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, mutation.content, { mode: mutation.mode });
      await chmod(destination, mutation.mode);
    }
  }
}

async function commit(directory: string, sourceManifest: ReturnType<typeof buildHistoricalV2Fixture>['manifest']) {
  const plan = await eligible(directory);
  const finalized = finalizeActivationHistoryMigration(plan, approved, now);
  await install(directory, finalized.mutations);
  await writeJson(directory, ['liftoff.manifest.json'], {
    ...sourceManifest, liftoffVersion: '0.12.0',
    governance: { ...sourceManifest.governance, activationIdentity: currentActivationIdentity }
  });
  await writeJson(directory, ['.liftoff', 'governance', 'phase-graph.json'], canonicalPhaseGraph);
  return { plan, finalized };
}

describe('exact published source readers and successor declarations', () => {
  it.each([1, 2])('rejects valid historical v%s through its strict reader with a v3 diagnostic', async (family) => {
    const directory = await root();
    if (family === 1) await writeHistoricalV1Fixture(directory);
    else await writeHistoricalV2Fixture(directory);
    const before = await bytes(directory);
    await expect(loadActivationState(directory)).rejects.toThrow(new RegExp(
      `Historical activation v${family} state is diagnostic-only.*v3 successor`
    ));
    expect(await bytes(directory)).toEqual(before);
  });

  it('does not call malformed v2 state a valid historical source', async () => {
    const project = await fixture();
    const { 'seed-valid': _missing, ...phases } = project.source.state.phases;
    await writeJson(project.root, ['governance', 'activation-state.json'], { ...project.source.state, phases });
    await expect(loadActivationState(project.root)).rejects.toThrow(/Invalid historical.*phases.seed-valid.*required/);
  });

  it('uses immutable actual graphs and separate version-specific proof formats', () => {
    const v1 = buildHistoricalV1Fixture();
    const v2 = buildHistoricalV2Fixture();
    expect(canonicalSha256(historicalFixtureGraph)).toBe(historicalV1ActivationIdentity.phaseGraphHash);
    for (const { label: _label, ...phase } of historicalFixtureGraph.phases) {
      expect(historicalV1PhaseContractDigests[phase.id as keyof typeof historicalV1PhaseContractDigests]).toBe(canonicalSha256(phase));
    }
    expect(canonicalSha256(historicalV2PhaseGraph())).toBe(historicalV2ActivationIdentity.phaseGraphHash);
    expect(v2.graph).not.toEqual(canonicalPhaseGraph);
    expect(validateHistoricalActivationState(v1.state)).toEqual(v1.state);
    expect(validateHistoricalV2ActivationState(v2.state)).toEqual(v2.state);
    expect(() => validateHistoricalActivationState(v2.state)).toThrow();
    expect(() => validateHistoricalV2ActivationState(v1.state)).toThrow();
    for (const record of v2.records) {
      expect(validateHistoricalV2EvidenceRecord(record)).toEqual(record);
      expect(() => validateEvidenceHeader(record.header)).toThrow();
      expect(() => validateHistoricalV2EvidenceRecord(record.header)).toThrow();
    }
    v2.plans.forEach((plan) => expect(validateHistoricalV2SavedTransitionPlan(plan)).toEqual(plan));
    expect(() => validateHistoricalApprovalEnvelope(v2.approvals[0])).toThrow();
    expect(() => validateHistoricalV2ApprovalEnvelope(v1.approvals[0])).toThrow();
    expect(() => validateUserActivationState(v2.state)).toThrow();
    expect(() => validateApprovalEnvelope(v2.approvals[0])).toThrow();
  });

  it('declares only direct v1/v2-to-v3 lanes and diagnostic source readability', () => {
    const lanes = packagedActivationSuccessorMigrations();
    expect(lanes.map((lane) => lane.id)).toEqual(['activation-v1-to-v3', 'activation-v2-to-v3']);
    expect(lanes.map((lane) => lane.fromIdentity)).toEqual([historicalV1ActivationIdentity, historicalV2ActivationIdentity]);
    expect(lanes.every((lane) => canonicalSha256(lane.toIdentity) === canonicalSha256(currentActivationIdentity))).toBe(true);
    const metadata = buildGovernanceCompatibilityMetadata([], [], []);
    expect(metadata.schemaVersion).toBe(4);
    expect(metadata.activation.historicalReadability.readers).toEqual(['activation-v1', 'activation-v2']);
    expect(validateGovernanceCompatibilityMetadata(metadata)).toEqual(metadata);
    for (const identity of [historicalV1ActivationIdentity, historicalV2ActivationIdentity]) {
      expect(resolveActivationCompatibility(identity, buildActivationCompatibilityMap([identity]))).toMatchObject({ compatible: false });
    }
    const modified = structuredClone(metadata);
    modified.activation.successorMigrations[0] = { ...modified.activation.successorMigrations[0], toIdentity: historicalV2ActivationIdentity };
    expect(() => validateGovernanceCompatibilityMetadata(modified)).toThrow(/successorMigrations/);
    expect(() => validateHistoricalV2Compatibility(metadata)).toThrow();
  });

  it.each([
    ['unknown tuple', (value: Record<string, any>) => { value.identity.policyVersion = '7'; }],
    ['unknown hash', (value: Record<string, any>) => { value.identity.phaseGraphHash = 'a'.repeat(64); }],
    ['mixed schema', (value: Record<string, any>) => { value.identity.approvalEnvelopeSchemaVersion = 1; }],
    ['unversioned', (value: Record<string, any>) => { delete value.schemaVersion; }],
    ['future', (value: Record<string, any>) => { value.schemaVersion = 4; }],
    ['new phase in old state', (value: Record<string, any>) => { value.phases['application-artifact-ready'] = value.phases['seed-valid']; }],
    ['v3 fields in v2 state', (value: Record<string, any>) => { value.baselineAnchor = 'a'.repeat(64); }]
  ])('blocks %s without source writes', async (_label, change) => {
    const project = await fixture();
    const value = structuredClone(project.source.state);
    change(value);
    await writeJson(project.root, ['governance', 'activation-state.json'], value);
    const before = await bytes(project.root);
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked' });
    expect(await bytes(project.root)).toEqual(before);
  });

  it('selects the activation family independently of the manifest last writer and current worktree freshness', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'backend', 'src', 'index.ts'), 'changed application; old proof is historical\n');
    expect(project.source.manifest.liftoffVersion).toBe('0.11.3');
    const plan = await eligible(project.root);
    expect(plan.semanticPlan.laneId).toBe('activation-v2-to-v3');
    expect(plan.index.sourceIdentity.liftoffVersion).toBe('0.11.0');
    expect(Date.parse(project.source.approvals[0].expiresAt)).toBeLessThan(now.getTime());
    expect(validateHistoricalV2ApprovalEnvelope(project.source.approvals[0])).toEqual(project.source.approvals[0]);
    const diagnostic = await planHistoricalActivationStateMigration(project.root);
    expect(diagnostic).toMatchObject({ status: 'blocked', mutations: [], report: { diagnosticOnly: true } });
  });

  it('blocks mixed active manifest/state and body or plan tampering', async () => {
    const project = await fixture();
    await writeJson(project.root, ['liftoff.manifest.json'], {
      ...project.source.manifest, governance: { ...project.source.manifest.governance, activationIdentity: historicalV1ActivationIdentity }
    });
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked', reasonCode: 'mixed-active-identity' });
    await writeJson(project.root, ['liftoff.manifest.json'], project.source.manifest);
    const record = project.source.records[0];
    await writeJson(project.root, ['governance', 'evidence', `${record.evidenceId}.json`], { ...record, payload: { changed: true } });
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked', reasonCode: 'invalid-historical-reference' });
    expect(() => validateHistoricalV2SavedTransitionPlan({ ...project.source.plans[0], planDigest: 'f'.repeat(64) })).toThrow(/plan digest/);
  });

  it('does not let injected mappings create an in-place current identity relabel', async () => {
    const project = await fixture();
    const result = await planHistoricalActivationStateMigration(project.root, now.toISOString(), {
      compatibility: buildActivationCompatibilityMap([historicalV2ActivationIdentity, currentActivationIdentity])
    });
    expect(result).toMatchObject({ status: 'blocked', mutations: [], report: { diagnosticOnly: true } });
  });

  it('rejects duplicate JSON fields and does not leak malformed source excerpts', () => {
    expect(() => parseHistoryJson(Buffer.from('{"schemaVersion":2,"schemaVersion":2}'), 'state')).toThrow(/duplicate JSON/);
    expect(() => parseHistoryJson(Buffer.from('{"a":[{"x":1,"\\u0078":2}]}'), 'state')).toThrow(/duplicate JSON/);
    try {
      parseHistoryJson(Buffer.from('{"credential":"must-not-be-echoed"'), 'state');
      throw new Error('Expected malformed JSON.');
    } catch (error) {
      expect(String(error)).not.toContain('must-not-be-echoed');
      expect(String(error)).toContain('malformed JSON');
    }
  });

  it.each([1, 2])('preserves and retires exact v%s auxiliary control records without carrying their authority', async (family) => {
    const directory = await root();
    if (family === 1) await writeHistoricalV1Fixture(directory);
    else await writeHistoricalV2Fixture(directory);
    const identity = family === 1 ? historicalV1ActivationIdentity : historicalV2ActivationIdentity;
    await writeJson(directory, ['governance', 'supersessions', 'old-change.json'], {
      schemaVersion: 1, identity, supersededChangeId: 'old-change', supersedingChangeId: 'later-change',
      reason: 'Historical approved supersession.', approvedAt: '2026-08-01T00:00:00.000Z', approver: 'historical-maintainer'
    });
    await writeJson(directory, ['governance', 'reconciliation', 'old-graph.json'], {
      schemaVersion: family, fromGraphHash: identity.phaseGraphHash, toGraphHash: identity.phaseGraphHash,
      fromIdentity: identity, toIdentity: identity,
      phaseMappings: Object.keys(historicalV1PhaseContractDigests).map((id) => ({
        phaseId: id, fromContractDigest: family === 1 ? historicalV1PhaseContractDigests[id as keyof typeof historicalV1PhaseContractDigests] : historicalV2PhaseContractDigest(id),
        toContractDigest: family === 1 ? historicalV1PhaseContractDigests[id as keyof typeof historicalV1PhaseContractDigests] : historicalV2PhaseContractDigest(id),
        preserveEvidence: true
      })), reconciledAt: '2026-08-01T00:00:00.000Z', producer: 'historical-reconciliation'
    });
    await writeJson(directory, ['governance', 'credentials', 'preflight-policy.json'], {
      schemaVersion: 1, identity, repository: { id: 'R_HISTORICAL', owner: 'example-org', name: 'flight-log', fullName: 'example-org/flight-log' },
      owner: 'example-org', authKind: 'fine-grained-pat', displayNameTemplate: '<repo>-runner-preflight-read',
      displayName: 'flight-log-runner-preflight-read', secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
      createdAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-31T00:00:00.000Z',
      rotationLeadDays: 7, rotationDueAt: '2026-08-24T00:00:00.000Z',
      permissions: { repository: ['metadata:read'], organization: ['hosted-runners:read', 'network-configurations:read'] },
      allowedWorkflows: [{ path: '.github/workflows/preflight.yml', jobs: ['probe'] }],
      nonForwarding: true, status: 'expired',
      proof: { verifiedAt: '2026-08-01T00:00:00.000Z', readbackDigest: 'a'.repeat(64), readbackProvider: 'github-api', payloadFree: true },
      app: null, pat: { lifetimeDays: 30, selectedRepositoryOnly: true, createdBy: 'manual-masked-entry' }
    });
    await writeFile(path.join(directory, 'governance', 'credentials', 'private-neighbor.txt'), 'unowned credential storage fixture\n');
    const plan = await eligible(directory);
    expect(plan.index.files.filter((file) => ['supersession', 'reconciliation', 'credential-policy'].includes(file.kind))).toHaveLength(3);
    const result = finalizeActivationHistoryMigration(plan, approved, now);
    expect(result.requiredRetirements.some((file) => file.pathParts.join('/') === 'governance/credentials/preflight-policy.json')).toBe(true);
    expect(result.requiredRetirements.some((file) => file.pathParts.at(-1) === 'private-neighbor.txt')).toBe(false);
    await install(directory, result.mutations);
    const publicInputs = await captureMigrationRetainedProjectInputs(directory);
    const policyCopy = plan.index.files.find((file) => file.kind === 'credential-policy')!;
    expect(publicInputs.some((file) => file.pathParts.join('/') === policyCopy.copyPathParts.join('/'))).toBe(true);
    expect(publicInputs.some((file) => file.pathParts.at(-1) === 'private-neighbor.txt')).toBe(false);
  });
});

describe('not-started versus orphaned execution records', () => {
  it.each([1, 2])('does not invent v%s history when no activation has started', async (family) => {
    const directory = await root();
    if (family === 1) await writeHistoricalV1Fixture(directory);
    else await writeHistoricalV2Fixture(directory);
    for (const collection of ['evidence', 'plans', 'approvals']) await rm(path.join(directory, 'governance', collection), { recursive: true });
    await unlink(path.join(directory, 'governance', 'activation-state.json'));
    const before = await bytes(directory);
    expect(await planActivationHistoryMigration(directory)).toEqual({ status: 'not-present' });
    expect(await planHistoricalActivationStateMigration(directory)).toMatchObject({ status: 'not-present', mutations: [] });
    expect(await loadActivationState(directory)).toBeUndefined();
    expect(await bytes(directory)).toEqual(before);
  });

  it.each(['evidence', 'plans', 'approvals', 'supersessions', 'reconciliation'])('does not treat orphaned %s as clean', async (collection) => {
    const directory = await root();
    await writeJson(directory, ['governance', collection, 'orphan.json'], { schemaVersion: 2 });
    expect(await planActivationHistoryMigration(directory)).toMatchObject({ status: 'blocked', reasonCode: 'missing-historical-record' });
    await expect(loadActivationState(directory)).rejects.toThrow(/missing while active execution records remain/);
    expect(await captureHistoryFile(directory, ['governance', 'activation-state.json'])).not.toHaveProperty('content');
  });
});

describe('byte-preserving successor commits and immutable history', () => {
  it('creates a strict 29-phase v3 successor with no copied evidence, approvals, remote binding, or state', async () => {
    const project = await fixture();
    const before = await bytes(project.root);
    const plan = await eligible(project.root);
    expect(await bytes(project.root)).toEqual(before);
    const result = finalizeActivationHistoryMigration(plan, approved, now);
    expect(result.successor.identity).toEqual(currentActivationIdentity);
    expect(result.successor.schemaVersion).toBe(3);
    expect(result.successor.repository.id).toBe(project.source.state.repository.id);
    expect(result.successor.remoteBinding).toBeUndefined();
    expect(result.successor.bootstrapState).toBeUndefined();
    expect(Object.keys(result.successor.phases)).toHaveLength(29);
    expect(Object.values(result.successor.phases).every((phase) =>
      phase.state === 'pending' && !phase.evidence.length && !phase.approvals.length)).toBe(true);
    for (const phase of ['bootstrap-workflow-source-ready', 'application-prerequisites-ready', 'application-artifact-ready'] as const) {
      expect(result.successor.phases[phase].state).toBe('pending');
    }
    expect(result.journal.laneId).toBe('activation-v2-to-v3');
    expect(validateMigrationJournal(result.journal)).toEqual(result.journal);
    for (const file of plan.index.files) {
      const copy = result.mutations.find((mutation) => mutation.type === 'write' && mutation.pathParts.join('/') === file.copyPathParts.join('/'));
      expect(copy && copy.type === 'write' && copy.content).toEqual(before.get(file.originalPathParts.join('/')));
      expect(file.digest).toBe(rawHistoryDigest(before.get(file.originalPathParts.join('/'))!));
    }
    const firstRetirement = result.mutations.findIndex((mutation) => mutation.type === 'delete');
    const indexWrite = result.mutations.findIndex((mutation) => mutation.pathParts.join('/') === activationHistoryIndexPathParts(plan.index.snapshotId).join('/'));
    expect(firstRetirement).toBeGreaterThan(indexWrite);
    expect(await bytes(project.root)).toEqual(before);
  });

  it('establishes a new local anchor instead of trusting a source remote identifier', async () => {
    const project = await fixture({ localAnchor: 'R_HISTORICAL_REMOTE_ONLY' });
    const result = finalizeActivationHistoryMigration(await eligible(project.root), approved, now);
    expect(result.successor.repository.id).toMatch(/^local:/);
    expect(result.successor.repository.id).not.toBe(project.source.state.repository.id);
  });

  it('keeps a committed successor current and resumable without duplicate history', async () => {
    const project = await fixture();
    const { plan, finalized } = await commit(project.root, project.source.manifest);
    const before = await bytes(project.root);
    const inspection = await inspectActivationMigrationHistory(project.root);
    expect(inspection).toMatchObject({ status: 'committed', journal: { transaction: { status: 'committed' }, revalidation: { status: 'pending' } } });
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'current', state: finalized.successor });
    expect(await planHistoricalActivationStateMigration(project.root)).toMatchObject({ status: 'current', mutations: [] });
    expect(await bytes(project.root)).toEqual(before);
    expect(await readFile(path.join(project.root, 'governance', 'evidence', 'notes.txt'), 'utf8')).toContain('Unowned');
    for (const file of plan.index.files) expect(await readFile(path.join(project.root, ...file.copyPathParts))).toEqual(project.source.files.get(file.originalPathParts.join('/')));
  });

  it('reuses a semantically matching completed snapshot without rewriting its noncanonical index bytes', async () => {
    const project = await fixture();
    const plan = await eligible(project.root);
    await install(project.root, finalizeActivationHistoryMigration(plan, approved, now).mutations
      .filter((mutation) => mutation.pathParts[1] === 'history'));
    const indexPath = activationHistoryIndexPathParts(plan.index.snapshotId);
    const noncanonical = Buffer.from(`${JSON.stringify(plan.index, null, '\t')}\r\n`);
    await writeFile(path.join(project.root, ...indexPath), noncanonical);
    const reused = await eligible(project.root);
    expect(reused.historyDisposition).toBe('reuse');
    expect(reused.indexContent).toEqual(noncanonical);
    expect(finalizeActivationHistoryMigration(reused, approved, now).mutations.some((mutation) => mutation.pathParts[1] === 'history')).toBe(false);
    expect(await readFile(path.join(project.root, ...indexPath))).toEqual(noncanonical);
  });

  it('binds source bytes and rejects concurrent edits before transaction writes', async () => {
    const project = await fixture();
    const plan = await eligible(project.root);
    const finalized = finalizeActivationHistoryMigration(plan, approved, now);
    await writeFile(path.join(project.root, 'governance', 'activation-state.json'), 'concurrent source edit');
    await expect(applyProjectFileTransaction(project.root, finalized.mutations, { preconditions: finalized.preconditions })).rejects.toThrow();
    expect(await readFile(path.join(project.root, 'governance', 'activation-state.json'), 'utf8')).toBe('concurrent source edit');
    expect((await captureHistoryFile(project.root, activationHistoryIndexPathParts(plan.index.snapshotId))).content).toBeUndefined();
  });

  it('rejects mutable parsed-state or target-identity substitutions without relabeling source bytes', async () => {
    const project = await fixture();
    const plan = await eligible(project.root);
    plan.inventory.state.activeChange = { id: 'unreviewed-change', kind: 'openspec' };
    expect(() => finalizeActivationHistoryMigration(plan, approved, now)).toThrow(/source mapping/);
    const second = await eligible(project.root);
    second.semanticPlan.targetIdentity.phaseGraphHash = 'f'.repeat(64);
    expect(() => finalizeActivationHistoryMigration(second, approved, now)).toThrow(/changed since planning/);
  });

  it('preserves desired component/agent changes as metadata rather than modifying active provenance', async () => {
    const project = await fixture();
    const requested = { projectName: 'Flight Log', agents: ['github-copilot', 'codex'], includeFrontend: true, environments: ['dev', 'staging', 'prod', 'additional'] };
    await writeJson(project.root, ['liftoff.config.json'], requested);
    const plan = await eligible(project.root);
    const final = finalizeActivationHistoryMigration(plan, approved, now);
    expect(plan.inventory.manifest.project).toEqual(project.source.manifest.project);
    expect(final.mutations.some((mutation) => mutation.pathParts.join('/') === 'liftoff.config.json')).toBe(false);
  });
});

describe('prior migration lineage and protective lifecycle obligations', () => {
  async function withAncestor() {
    const previousRoot = await root();
    const previous = await writeHistoricalV1Fixture(previousRoot);
    const previousPlan = await eligible(previousRoot);
    const project = await fixture({ ancestor: { index: previousPlan.index, indexContent: previousPlan.indexContent, files: previous.files } });
    return { ...project, previousPlan, previous };
  }

  it('retains v1 ancestors and the original v1-to-v2 journal as non-executable source records', async () => {
    const project = await withAncestor();
    const oldJournal = await readFile(path.join(project.root, 'governance', 'migration-state.json'));
    expect(validateHistoricalV2SourceMigrationJournal(JSON.parse(oldJournal.toString('utf8'))).targetIdentity).toEqual(historicalV2ActivationIdentity);
    const { plan } = await commit(project.root, project.source.manifest);
    expect(plan.semanticPlan.ancestorHistory).toHaveLength(1);
    expect(plan.index.files.some((file) => file.kind === 'migration')).toBe(true);
    expect(plan.index.files.some((file) => file.originalPathParts[1] === 'history')).toBe(false);
    const inspection = await inspectActivationMigrationHistory(project.root);
    expect(inspection).toMatchObject({ status: 'committed', ancestorHistory: [{ snapshotId: project.previousPlan.index.snapshotId }] });
    expect(await readFile(path.join(project.root, ...activationHistoryIndexPathParts(project.previousPlan.index.snapshotId)))).toEqual(project.previousPlan.indexContent);
    const copiedJournal = plan.index.files.find((file) => file.kind === 'migration')!;
    expect(await readFile(path.join(project.root, ...copiedJournal.copyPathParts))).toEqual(oldJournal);
  });

  it.each(['missing-index', 'changed-index', 'changed-copy'])('blocks a %s ancestor without inventing clean lineage', async (fault) => {
    const project = await withAncestor();
    const index = path.join(project.root, ...activationHistoryIndexPathParts(project.previousPlan.index.snapshotId));
    if (fault === 'missing-index') await unlink(index);
    else if (fault === 'changed-index') await writeFile(index, JSON.stringify(project.previousPlan.index));
    else await writeFile(path.join(project.root, ...project.previousPlan.index.files[0].copyPathParts), 'changed source copy');
    const before = await bytes(project.root);
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked' });
    expect(await bytes(project.root)).toEqual(before);
  });

  it('rejects a missing ancestor after commit while preserving the current backlink', async () => {
    const project = await withAncestor();
    await commit(project.root, project.source.manifest);
    await unlink(path.join(project.root, ...activationHistoryIndexPathParts(project.previousPlan.index.snapshotId)));
    const state = await readFile(path.join(project.root, 'governance', 'activation-state.json'));
    await expect(inspectActivationMigrationHistory(project.root)).rejects.toThrow();
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked' });
    expect(await readFile(path.join(project.root, 'governance', 'activation-state.json'))).toEqual(state);
  });

  it.each(['retained', 'disposed'] as const)('preserves original %s obligations without creating current authority or reading protected material', async (status) => {
    const project = await fixture({ retention: status });
    const sourceRetention = project.source.state.bootstrapState!;
    const material = sourceRetention.encryptedStatePathParts[0];
    await mkdir(path.join(project.root, ...material), { recursive: true });
    await writeFile(path.join(project.root, ...material, 'unread-private-content'), 'protected fixture; metadata migration must not inspect this\n');
    const plan = await eligible(project.root);
    expect(plan.semanticPlan.lifecycleObligations[0].retention).toEqual(sourceRetention);
    const publicInputs = await captureMigrationRetainedProjectInputs(project.root, migrationSensitivePathExclusions(plan));
    expect(publicInputs.some((file) => file.pathParts.join('/') === material.join('/'))).toBe(false);
    expect(plan.index.files.some((file) => file.originalPathParts.join('/') === material.join('/'))).toBe(false);
    const result = finalizeActivationHistoryMigration(plan, approved, now);
    expect(result.successor.bootstrapState).toBeUndefined();
    expect(result.successor.phases['bootstrap-state-disposed'].state).toBe('pending');
    expect(historicalLifecyclePhaseBlockers(plan.semanticPlan.lifecycleObligations)['bootstrap-local']).not.toHaveLength(0);
  });

  it('retains v1 protective obligations even when the intermediate v2 state did not carry them forward', async () => {
    const previousRoot = await root();
    const previous = await writeHistoricalV1Fixture(previousRoot);
    const phaseId = 'remote-import-verified' as const;
    const baselineSha = canonicalSha256({ historicalRemote: true });
    const inputDigest = canonicalSha256({ historicalRemoteInput: true });
    const record = {
      evidenceId: 'historical-v1-retention',
      header: {
        schemaVersion: 1, identity: historicalV1ActivationIdentity, repositoryId: previous.state.repository.id,
        phaseGraphHash: historicalV1ActivationIdentity.phaseGraphHash, phaseId,
        phaseContractDigest: historicalV1PhaseContractDigests[phaseId], baselineSha, inputDigest,
        transition: { phaseId, baselineSha, inputDigest, transitionDigest: 'a'.repeat(64) },
        producedAt: '2026-08-01T00:00:00.000Z', producer: 'historical-independent-observation', result: 'verified' as const
      }
    };
    previous.state.bootstrapState = {
      status: 'retained', retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z',
      remoteImportEvidenceId: record.evidenceId, remoteImportEvidenceDigest: canonicalSha256(record.header),
      encryptedStatePathParts: [['governance', 'protected-material', 'old-state.enc']],
      encryptionKeyPathParts: [['governance', 'protected-material', 'old-state.key']]
    };
    previous.state.phases[phaseId] = {
      state: 'verified', updatedAt: '2026-08-01T00:00:00.000Z', approvals: [], blockers: [],
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
    const stateBytes = Buffer.from(canonicalJson(previous.state));
    const recordBytes = Buffer.from(canonicalJson(record));
    previous.files.set('governance/activation-state.json', stateBytes);
    previous.files.set(`governance/evidence/${record.evidenceId}.json`, recordBytes);
    await writeFile(path.join(previousRoot, 'governance', 'activation-state.json'), stateBytes);
    await writeFile(path.join(previousRoot, 'governance', 'evidence', `${record.evidenceId}.json`), recordBytes);
    const previousPlan = await eligible(previousRoot);
    const project = await fixture({ ancestor: { index: previousPlan.index, indexContent: previousPlan.indexContent, files: previous.files } });
    expect(project.source.state.bootstrapState).toBeUndefined();
    const { plan } = await commit(project.root, project.source.manifest);
    expect(plan.semanticPlan.lifecycleObligations).toEqual([{
      snapshotId: previousPlan.index.snapshotId, sourceIdentity: historicalV1ActivationIdentity,
      repositoryId: previous.state.repository.id, retention: previous.state.bootstrapState,
      verification: 'required', authority: 'historical-protection-only'
    }]);
    expect(await inspectActivationMigrationHistory(project.root)).toMatchObject({
      status: 'committed', lifecycleObligations: [{ retention: { retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z' } }]
    });
  });
});

describe('sanitized preservation blockers and portable boundaries', () => {
  it.each([
    { credentialValue: 'DO_NOT_ECHO_CREDENTIAL' },
    { nested: { version: 4, terraform_version: '1.9.0', serial: 2, lineage: 'DO_NOT_ECHO_STATE', resources: [] } },
    { nested: { planned_values: { root_module: { resources: [] } } } },
    { privateKey: 'DO_NOT_ECHO_KEY' }
  ])('does not copy or echo prohibited payloads %#', async (payload) => {
    const project = await fixture();
    const record = project.source.records[0];
    await writeJson(project.root, ['governance', 'evidence', `${record.evidenceId}.json`], { ...record, payload });
    const result = await planActivationHistoryMigration(project.root);
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-historical-payload' });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_ECHO');
    expect((await captureHistoryFile(project.root, ['governance', 'migration-state.json'])).content).toBeUndefined();
  });

  it.each([
    ['..', 'outside'], ['drive:C'], ['C:\\outside'], ['\\\\server\\share'], ['nested/name'], ['CON'], ['trailing.']
  ])('rejects nonportable parts %j', (parts) => expect(() => historyPathParts(parts, 'history path')).toThrow());

  it('does not follow a historical state symlink', async () => {
    const project = await fixture();
    if (process.platform === 'win32') {
      const moved = path.join(project.root, 'original-governance');
      await rename(path.join(project.root, 'governance'), moved);
      await symlink(moved, path.join(project.root, 'governance'), 'junction');
    } else {
      await unlink(path.join(project.root, 'governance', 'activation-state.json'));
      await symlink(path.join(project.root, 'liftoff.manifest.json'), path.join(project.root, 'governance', 'activation-state.json'));
    }
    expect(await planActivationHistoryMigration(project.root)).toMatchObject({ status: 'blocked', reasonCode: 'unsafe-history-path' });
  });

  it('does not traverse conventional OpenTofu state, provider plans, or key destinations while hashing public inputs', async () => {
    const directory = await root();
    for (const name of ['terraform.tfstate', 'saved.tfplan', 'private.pem', '.env.production', 'bootstrap.enc']) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, 'unread-private-content'), 'protected fixture data\n');
    }
    await writeFile(path.join(directory, 'README.md'), 'public input\n');
    expect(await captureMigrationRetainedProjectInputs(directory)).toEqual([expect.objectContaining({ pathParts: ['README.md'] })]);
  });
});
