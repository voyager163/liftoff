import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import {
  historicalV4Policy7ActivationIdentity as originalIdentity
} from '../src/domain/governance/policy/identity.js';
import {
  validateActivationIdentity, validateApprovalEnvelope, validateCredentialPolicy,
  validateReadableActivationIdentity, validateUserActivationState
} from '../src/domain/governance/activation/validators.js';
import type { SavedTransitionPlan } from '../src/domain/governance/activation/types.js';
import {
  historicalV4Policy7PhaseGraph, historicalV4Policy7ApprovalEnvelopeHash,
  validateHistoricalV4Policy7ActivationState, validateHistoricalV4Policy7ApprovalEnvelope,
  validateHistoricalV4Policy7AuxiliaryRecord, validateHistoricalV4Policy7SavedTransitionPlan,
  validateHistoricalV4Policy7EvidenceRecord
} from '../src/governance-activation/historical-v4-policy7.js';
import {
  buildGovernanceCompatibilityMetadata, validateGovernanceCompatibilityMetadata, validatePolicy7CompatibilityMetadata
} from '../src/governance-activation/compatibility.js';
import {
  finalizeActivationHistoryMigration, planActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { readHistoricalActivationInventory } from '../src/governance-activation/historical-state.js';
import { rawHistoryDigest, validateMigrationJournal } from '../src/governance-activation/history-contracts.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { buildHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { updateProject } from '../src/application/update/use-case.js';
import { CaptureStream } from './helpers.js';
import { PresentationSession } from '../src/terminal.js';
import type { CommandRunner } from '../src/process-runner.js';

const roots: string[] = [];
const createdAt = '2026-09-01T00:00:00.000Z';
const expiresAt = '2026-10-01T00:00:00.000Z';
const now = new Date('2026-09-18T00:00:00.000Z');
const originalApprovals: Pick<typeof import('../src/domain/governance/activation/approvals.js'), 'savedPlanAuthorityDigest'> =
  createRequire(import.meta.url)('../assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/domain/governance/activation/approvals.js');
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function originalApproval() {
  return validateHistoricalV4Policy7ApprovalEnvelope({
    schemaVersion: 4, scope: 'activation', identity: originalIdentity,
    id: 'original-credential-approval', phaseId: 'credential-ready', gateKind: 'credential-enrollment',
    baselineSha: canonicalSha256('original baseline'), planDigest: canonicalSha256('original reviewed plan'),
    resources: [{ type: 'github-app', identity: 'fixture-installation-42' }],
    destinations: [{ type: 'repository', identity: 'fixture/policy-seven', repository: 'fixture/policy-seven', subscriptionId: null }],
    permissions: ['github-read'], costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
    policyExceptions: [], destructiveScope: [], approvedAt: createdAt, expiresAt, approver: 'fixture-maintainer'
  });
}

function originalState() {
  const state = {
    schemaVersion: 4, identity: originalIdentity,
    repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'policy-seven', defaultBranch: 'develop' },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(historicalV4Policy7PhaseGraph().phases.map(({ id }) => [id, {
      state: 'pending', updatedAt: createdAt, evidence: [], approvals: [], blockers: []
    }])),
    createdAt, updatedAt: createdAt
  };
  return validateHistoricalV4Policy7ActivationState(state);
}

function originalPolicy() {
  return {
    schemaVersion: 1, identity: originalIdentity,
    repository: { id: '42', owner: 'fixture', name: 'policy-seven', fullName: 'fixture/policy-seven' },
    owner: 'fixture', authKind: 'github-app', displayNameTemplate: '<repo>-runner-preflight-read',
    displayName: 'policy-seven-runner-preflight-read', secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
    createdAt, expiresAt, rotationLeadDays: 7, rotationDueAt: '2026-09-24T00:00:00.000Z',
    permissions: { repository: ['metadata:read'], organization: ['hosted-runners:read', 'network-configurations:read'] },
    allowedWorkflows: [{ path: '.github/workflows/staging.yml', jobs: ['preflight'] }],
    nonForwarding: true, status: 'active',
    proof: { verifiedAt: createdAt, readbackDigest: canonicalSha256('bounded source fixture, not provider proof'), readbackProvider: 'adapter-fixture', payloadFree: true },
    app: {
      installationId: 42, appSlug: 'fixture-app', selection: 'selected-repository', repositoryFullName: 'fixture/policy-seven',
      permissionsVerifiedAt: createdAt, token: { strategy: 'installation-token', ttlSeconds: 3600, generatedBy: 'github-app' }
    },
    pat: null
  };
}

function originalPlan() {
  const phase = historicalV4Policy7PhaseGraph().phases.find((entry) => entry.id === 'seed-valid')!;
  const plan: SavedTransitionPlan = {
    schemaVersion: 2, scope: 'local', phaseId: phase.id, createdAt, expiresAt,
    identity: originalIdentity, graphHash: originalIdentity.phaseGraphHash,
    stateHash: canonicalSha256(originalState()), baselineDigest: canonicalSha256('original baseline'),
    inputDigest: canonicalSha256('original input'), transitionDigest: canonicalSha256('original transition'),
    planDigest: canonicalSha256('not yet sealed'), mutationClasses: phase.allowedMutations,
    operations: [{
      phaseId: phase.id, adapter: 'selected-spec-workflow', actionId: 'openspec.seed.validate',
      mutationClass: 'read-worktree', remote: false, destructive: false,
      destination: { type: 'local', identity: 'policy-seven' }, inputs: {}
    }],
    approval: {
      gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, envelopeId: null, envelopeHash: null,
      evaluation: {
        phaseId: phase.id, gateKind: phase.approvalGate.kind, questionKind: null,
        approvalRequired: false, status: 'not-required', envelopeId: null, envelopeHash: null,
        reasons: [], expansionReasons: []
      }
    },
    rollbackPlan: { phaseId: phase.id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    noSecrets: true
  };
  plan.planDigest = canonicalSha256({
    phaseId: plan.phaseId, transitionDigest: plan.transitionDigest,
    approvalPlanDigest: originalApprovals.savedPlanAuthorityDigest(plan, phase), operations: plan.operations
  });
  return validateHistoricalV4Policy7SavedTransitionPlan(plan);
}

function originalEvidence() {
  const plan = originalPlan();
  const { label: _label, ...behavior } = historicalV4Policy7PhaseGraph().phases.find((phase) => phase.id === plan.phaseId)!;
  const payload = { kind: 'seed-valid.v1', planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan) };
  return validateHistoricalV4Policy7EvidenceRecord({
    evidenceId: 'original-local-proof',
    header: {
      schemaVersion: 4, scope: 'local', identity: originalIdentity, phaseId: plan.phaseId,
      repositoryId: originalState().repository.id, phaseGraphHash: originalIdentity.phaseGraphHash,
      phaseContractDigest: canonicalSha256(behavior), baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest,
      transition: { phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest, transitionDigest: plan.transitionDigest },
      producedAt: createdAt, producer: 'liftoff-governance-transition-engine', result: 'verified',
      bodyDigest: canonicalSha256({ payload, liveReadback: [] })
    }, payload
  });
}

function originalCompatibility() {
  const value = buildGovernanceCompatibilityMetadata([], [], []);
  return {
    ...value, activation: {
      ...value.activation, currentCompatibleTuples: [originalIdentity],
      recognizedGraphHashes: [originalIdentity.phaseGraphHash],
      historicalReadability: {
        ...value.activation.historicalReadability,
        tuples: value.activation.historicalReadability.tuples.filter((identity) => identity.activationContractVersion < 4),
        readers: ['activation-v1', 'activation-v2', 'activation-v3']
      },
      successorMigrations: value.activation.successorMigrations
        .filter((lane) => lane.id !== 'activation-v4-policy7-to-policy8')
        .map((lane) => ({ ...lane, toIdentity: originalIdentity }))
    }
  };
}

async function source() {
  const root = path.resolve('tests', `.policy7-history-${randomUUID()}`);
  roots.push(root);
  await mkdir(root);
  const artifacts = buildArtifacts(buildProjectPlan({
    projectName: 'policy-seven', projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', governanceProfile: 'none', includeFrontend: false, agents: ['github-copilot']
  }, { requireProjectName: true }));
  const manifest = JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content);
  manifest.governance = { profile: 'single-maintainer-gitflow', policyVersion: '7', state: 'handoff-generated', activationIdentity: originalIdentity };
  manifest.managedArtifacts.push(...buildHistoricalV1Fixture().manifest.managedArtifacts);
  const approval = originalApproval();
  const state = originalState();
  state.phases['credential-ready'].approvals = [approval.id];
  const documents = new Map<string, unknown>([
    ['liftoff.manifest.json', manifest],
    ['governance/activation-state.json', state],
    [`governance/approvals/${approval.id}.json`, approval],
    ['governance/credentials/preflight-policy.json', originalPolicy()],
    ['.liftoff/governance/phase-graph.json', historicalV4Policy7PhaseGraph()],
    ['.liftoff/governance/compatibility.json', originalCompatibility()]
  ]);
  for (const artifact of manifest.managedArtifacts) {
    const document = documents.get(artifact.pathParts.join('/'));
    if (document) {
      artifact.contentHash = `sha256:${rawHistoryDigest(Buffer.from(`${JSON.stringify(document, null, '\t')}\n`.replaceAll('\n', '\r\n')))}`;
    }
  }
  const bytes = new Map<string, Buffer>();
  for (const [name, value] of documents) {
    const content = Buffer.from(`${JSON.stringify(value, null, '\t')}\n`.replaceAll('\n', '\r\n'));
    bytes.set(name, content);
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content, { mode: 0o600 });
  }

  return { root, bytes, state, approval };
}

async function publicSource() {
  const fixture = await source();
  const home = await mkdtemp(path.join(tmpdir(), 'liftoff-policy7-private-'));
  roots.push(home);
  await writeFile(path.join(fixture.root, 'liftoff.config.json'), JSON.stringify({
    projectName: 'policy-seven', projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', includeFrontend: false, environments: ['dev'],
    specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'single-maintainer-gitflow'
  }));
  const runner: CommandRunner = {
    async run(command) {
      return {
        command, displayCommand: command.executable, status: 1, signal: null, stdout: '',
        stderr: 'The source fixture does not execute project or provider commands.',
        timedOut: false, processTreeSettled: true
      };
    }
  };
  const invoke = async (check: boolean, approvePlan?: string) => {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await updateProject({
      project: fixture.root, check, approvePlan, force: false, jsonMode: true
    }, {
      cwd: fixture.root, stdout, stderr, runner, updateNow: () => now,
      presentation: new PresentationSession({ stdout, stderr, json: true }),
      updatePreview: { homedir: home, repositoryRoot: fixture.root, env: {} }
    });
    return { code, report: JSON.parse(stdout.text()), diagnostic: stderr.text() };
  };
  return { ...fixture, invoke };
}

describe('exact pre-amendment policy-7 history', () => {
  it('registers a distinct readable tuple without enabling current execution', () => {
    expect(validateReadableActivationIdentity(originalIdentity)).toEqual(originalIdentity);
    expect(() => validateActivationIdentity(originalIdentity)).toThrow(/diagnostic-only/);
    expect(currentActivationIdentity).toMatchObject({ policyVersion: '8', credentialPolicySchemaVersion: 2 });
    expect(currentActivationIdentity.phaseGraphHash).not.toBe(originalIdentity.phaseGraphHash);
    expect(canonicalSha256(historicalV4Policy7PhaseGraph())).toBe(originalIdentity.phaseGraphHash);
  });

  it('retains original state, approval hash and credential policy without granting broader scope', () => {
    const state = originalState(), approval = originalApproval(), policy = originalPolicy();
    const before = JSON.stringify({ state, approval, policy });
    expect(validateHistoricalV4Policy7ActivationState(state)).toEqual(state);
    expect(validateHistoricalV4Policy7ApprovalEnvelope(approval)).toEqual(approval);
    const hash = historicalV4Policy7ApprovalEnvelopeHash(approval);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateHistoricalV4Policy7AuxiliaryRecord(policy, 'credential-policy')).not.toThrow();
    expect(() => validateUserActivationState(state)).toThrow();
    expect(() => validateApprovalEnvelope(approval)).toThrow();
    expect(() => validateCredentialPolicy(policy)).toThrow();
    expect(JSON.stringify({ state, approval, policy })).toBe(before);
    expect(historicalV4Policy7ApprovalEnvelopeHash(approval)).toBe(hash);
  });

  it.each([
    { policyVersion: '8' }, { credentialPolicySchemaVersion: 2 },
    { phaseGraphHash: 'f'.repeat(64) }, { activationContractVersion: 5 }
  ])('rejects mixed or retagged original identities %j', (changed) => {
    const state = originalState();
    expect(() => validateHistoricalV4Policy7ActivationState({
      ...state, identity: { ...originalIdentity, ...changed }
    })).toThrow();
    expect(() => validateHistoricalV4Policy7ApprovalEnvelope({
      ...originalApproval(), identity: { ...originalIdentity, ...changed }
    })).toThrow();
  });

  it('reads only the original compatibility inventory without accepting it for current execution', () => {
    const metadata = originalCompatibility(), before = JSON.stringify(metadata);
    expect(validatePolicy7CompatibilityMetadata(metadata).activation.currentCompatibleTuples).toEqual([originalIdentity]);
    expect(() => validateGovernanceCompatibilityMetadata(metadata)).toThrow();
    expect(() => validatePolicy7CompatibilityMetadata({
      ...metadata, activation: { ...metadata.activation, historicalReadability: {
        ...metadata.activation.historicalReadability, readers: ['activation-v1', 'activation-v2', 'activation-v3', 'activation-v4-policy7']
      } }
    })).toThrow();
    expect(JSON.stringify(metadata)).toBe(before);
  });

  it('validates plans and proof with the original authority and phase digests without rewriting input', () => {
    const plan = originalPlan(), evidence = originalEvidence();
    const before = JSON.stringify({ plan, evidence });
    expect(validateHistoricalV4Policy7SavedTransitionPlan(plan)).toEqual(plan);
    expect(validateHistoricalV4Policy7EvidenceRecord(evidence)).toEqual(evidence);
    expect(JSON.stringify({ plan, evidence })).toBe(before);
  });

  it.each(['digest', 'identity', 'mutation', 'scope', 'expiry'])('rejects tampered original plan %s', (change) => {
    const plan: SavedTransitionPlan = structuredClone(originalPlan());
    if (change === 'digest') plan.planDigest = 'f'.repeat(64);
    if (change === 'identity') plan.identity = currentActivationIdentity;
    if (change === 'mutation') plan.operations = [{ ...plan.operations[0]!, mutationClass: 'github-write', remote: true }];
    if (change === 'scope') plan.scope = 'repository';
    if (change === 'expiry') plan.expiresAt = plan.createdAt;
    expect(() => validateHistoricalV4Policy7SavedTransitionPlan(plan)).toThrow();
  });

  it.each(['payload', 'phase', 'identity', 'readback'])('rejects tampered original proof %s', (change) => {
    const evidence = originalEvidence();
    const changed = change === 'payload' ? { ...evidence, payload: { kind: 'invented-success' } } :
      change === 'phase' ? { ...evidence, header: { ...evidence.header, phaseContractDigest: 'f'.repeat(64) } } :
        change === 'identity' ? { ...evidence, header: { ...evidence.header, identity: currentActivationIdentity } } :
          { ...evidence, liveReadback: [{ matches: true }] };
    expect(() => validateHistoricalV4Policy7EvidenceRecord(changed)).toThrow();
  });

  it('preserves linked original plans and evidence rather than converting their hashes to the target identity', async () => {
    const fixture = await source(), plan = originalPlan(), evidence = originalEvidence();
    await mkdir(path.join(fixture.root, 'governance', 'plans'));
    await mkdir(path.join(fixture.root, 'governance', 'evidence'));
    const planBytes = Buffer.from(JSON.stringify(plan)), evidenceBytes = Buffer.from(JSON.stringify(evidence));
    await writeFile(path.join(fixture.root, 'governance', 'plans', 'original.json'), planBytes);
    await writeFile(path.join(fixture.root, 'governance', 'evidence', `${evidence.evidenceId}.json`), evidenceBytes);
    fixture.state.phases['seed-valid'] = {
      state: 'verified', updatedAt: createdAt, approvals: [], blockers: [],
      evidence: [{ phaseId: 'seed-valid', evidenceId: evidence.evidenceId, result: 'verified', headerDigest: canonicalSha256(evidence.header) }]
    };
    await writeFile(path.join(fixture.root, 'governance', 'activation-state.json'), JSON.stringify(fixture.state));
    const inventory = await readHistoricalActivationInventory(fixture.root);
    expect(inventory.unreviewedRecords).toEqual([]);
    expect(inventory.files.find((entry) => entry.kind === 'plan')?.content).toEqual(planBytes);
    expect(inventory.files.find((entry) => entry.kind === 'evidence')?.content).toEqual(evidenceBytes);
    const migration = await planActivationHistoryMigration(fixture.root);
    expect(migration.status, JSON.stringify(migration)).toBe('eligible');
    if (migration.status !== 'eligible') throw new Error('Expected a reviewed original-proof transition.');
    const result = finalizeActivationHistoryMigration(migration, canonicalSha256('new explicit review'), now);
    expect(result.successor.phases['seed-valid'].state).toBe('pending');
    expect(result.successor.phases['seed-valid'].evidence).toEqual([]);
    expect(await readFile(path.join(fixture.root, 'governance', 'plans', 'original.json'))).toEqual(planBytes);
  });

  it('plans an exact same-schema successor and preserves every original byte without copying approval into new state', async () => {
    const fixture = await source();
    const inventory = await readHistoricalActivationInventory(fixture.root);
    expect(inventory.state.identity).toEqual(originalIdentity);
    const plan = await planActivationHistoryMigration(fixture.root);
    expect(plan.status, JSON.stringify(plan)).toBe('eligible');
    if (plan.status !== 'eligible') throw new Error('Expected the exact registered successor.');
    expect(plan.semanticPlan.laneId).toBe('activation-v4-policy7-to-policy8');
    const result = finalizeActivationHistoryMigration(plan, canonicalSha256('explicit fixture review'), now);
    expect(validateMigrationJournal(result.journal).sourceIdentity).toEqual(originalIdentity);
    expect(result.successor.identity).toEqual(currentActivationIdentity);
    expect(result.successor.repository.id).toBe(fixture.state.repository.id);
    expect(Object.values(result.successor.phases).every((phase) =>
      phase.state === 'pending' && phase.approvals.length === 0 && phase.evidence.length === 0)).toBe(true);
    for (const file of plan.index.files) {
      const copy = result.mutations.find((mutation) => mutation.type === 'write' &&
        mutation.pathParts.join('/') === file.copyPathParts.join('/'));
      expect(copy?.type).toBe('write');
      if (copy?.type !== 'write') throw new Error('Missing exact history copy.');
      expect(Buffer.from(copy.content)).toEqual(fixture.bytes.get(file.originalPathParts.join('/')));
      expect(await readFile(path.join(fixture.root, ...file.originalPathParts))).toEqual(fixture.bytes.get(file.originalPathParts.join('/')));
    }
    expect(result.requiredRetirements.some((entry) => entry.pathParts.join('/') === 'governance/credentials/preflight-policy.json')).toBe(true);
    expect(result.mutations.some((mutation) => mutation.type === 'write' &&
      mutation.pathParts.join('/') === 'governance/credentials/preflight-policy.json')).toBe(false);
  });

  it.each(['running-phase', 'running-provider'])('preserves unsettled original work instead of resetting it through migration: %s', async (kind) => {
    const fixture = await source();
    const phase = fixture.state.phases['credential-ready'];
    if (kind === 'running-phase') phase.state = 'running';
    else phase.operation = {
      provider: 'github', actionId: 'github.credential.usage-challenge', operationId: '82',
      resourceId: '/repos/fixture/policy-seven/actions/runs/82',
      startedAt: createdAt, observedAt: createdAt, status: 'running'
    };
    const original = Buffer.from(JSON.stringify(fixture.state));
    await writeFile(path.join(fixture.root, 'governance', 'activation-state.json'), original);
    const plan = await planActivationHistoryMigration(fixture.root);
    expect(plan).toMatchObject({
      status: 'blocked', reasonCode: 'unsupported-active-record',
      issues: [expect.stringContaining('unsettled work in credential-ready')]
    });
    expect(await readFile(path.join(fixture.root, 'governance', 'activation-state.json'))).toEqual(original);
    await expect(readFile(path.join(fixture.root, 'governance', 'migration-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses public reviewed update without giving old credential approval to the successor', async () => {
    const f = await publicSource();
    const preview = await f.invoke(true);
    expect(preview.code, `${preview.report.reasonCode}: ${preview.report.message}`).toBe(2);
    const fingerprint = preview.report.plans.find((plan: { mode: string }) => plan.mode === 'normal')?.fingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const [name, bytes] of f.bytes) expect(await readFile(path.join(f.root, name))).toEqual(bytes);
    const applied = await f.invoke(false, fingerprint);
    expect(applied.report.committed, `${applied.report.reasonCode}: ${applied.report.message}`).toBe(true);
    const state = JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.identity).toEqual(currentActivationIdentity);
    expect(state.phases['credential-ready']).toMatchObject({ approvals: [], evidence: [], state: 'pending' });
    const index = JSON.parse(await readFile(path.join(f.root, ...state.successorHistory.historyIndexPathParts), 'utf8'));
    for (const entry of index.files) {
      const original = f.bytes.get(entry.originalPathParts.join('/'));
      if (original) expect(await readFile(path.join(f.root, ...entry.copyPathParts))).toEqual(original);
    }
    await expect(readFile(path.join(f.root, ...['governance', 'credentials', 'preflight-policy.json']))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed original state under the public previously approved preview', async () => {
    const f = await publicSource(), preview = await f.invoke(true);
    const fingerprint = preview.report.plans.find((plan: { mode: string }) => plan.mode === 'normal')?.fingerprint;
    expect(fingerprint, `${preview.report.reasonCode}: ${preview.report.message}`).toMatch(/^[a-f0-9]{64}$/);
    const changed = Buffer.from(`${JSON.stringify(f.state)}\n`);
    await writeFile(path.join(f.root, 'governance', 'activation-state.json'), changed);
    const result = await f.invoke(false, fingerprint);
    expect(result.code).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(await readFile(path.join(f.root, 'governance', 'activation-state.json'))).toEqual(changed);
  });
});
