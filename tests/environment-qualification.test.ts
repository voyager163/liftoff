import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import {
  disposableTargetConfig, validateOperatorQualificationAuthority, readQualificationCheckpoints,
  requireQualificationEvidence, validateFullActivationProofReceipts, environmentQualificationWiring,
  executeAzureQualificationPhase, verifyArtifactEquality, environmentRuntimeInputs
} from '../src/application/azure-activation/producer-qualification.js';
import {
  environmentRuntimeStep, environmentRuntimeUploadStep, readEnvironmentRuntimeArchive,
  validateEnvironmentRuntimeReport
} from '../src/application/azure-activation/environment-runtime-workflow.js';
import {
  environmentQualificationFixture, environmentReportZip
} from './helpers/environment-qualification-fixture.js';
import type { EnvironmentRuntimeReport } from '../src/application/azure-activation/environment-runtime-workflow.js';
import * as qualificationAuthority from '../src/application/azure-activation/qualification-authority.js';
import * as qualificationProducers from '../src/application/azure-activation/producer-qualification.js';

const reviewedCurrentGraphHash = '7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9';
const fixtures: Awaited<ReturnType<typeof environmentQualificationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture(options: Parameters<typeof environmentQualificationFixture>[0] = {}) {
  const value = await environmentQualificationFixture(options);
  fixtures.push(value);
  expect(value.input.plan.graphHash).toBe(reviewedCurrentGraphHash);
  return value;
}

describe('environment qualification authority, using real private issuance and leases', () => {
  it('matches the parent-reviewed full current graph digest independently of producer fixtures', () => {
    expect(canonicalSha256(canonicalPhaseGraph)).toBe(reviewedCurrentGraphHash);
    expect(canonicalPhaseGraph.phases.find((phase) => phase.id === 'production-rehearsed')?.allowedMutations.remote)
      .toContain('registry-publish');
  });

  it('preserves the unscoped activation default without granting repository or local authority', async () => {
    const f = await fixture();
    f.inspection.scope = undefined;
    expect(await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch))).toMatchObject({ valid: true });
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['local', 'repository', 'lifecycle'] as const)('rejects %s scope before qualification authority or provider access', async (scope) => {
    const f = await fixture();
    f.inspection.scope = scope;
    expect(await validateOperatorQualificationAuthority(f.input, 'staging', f.dispatch)).toMatchObject({
      valid: false, blocker: expect.stringMatching(/requires activation scope/)
    });
    for (const planner of Object.values(environmentQualificationWiring.planners)) {
      expect(await planner(f.input)).toMatchObject({ operations: [], blockers: [expect.stringMatching(/requires activation scope/)] });
    }
    for (const execute of Object.values(environmentQualificationWiring.executors)) {
      expect(await execute(f.input)).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/requires activation scope/) });
    }
    await expect(f.observe()).rejects.toThrow(/requires activation scope/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('requires the nested target/actors and the actually issued exact phase plan, independent of monthly budget', async () => {
    const f = await fixture();
    expect(f.input.plan.identity).toMatchObject({
      manifestArtifactVersion: 8, policyVersion: '8', activationContractVersion: 4, phaseGraphSchemaVersion: 3
    });
    const result = await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch));
    expect(result).toEqual({
      valid: true, authority: {
        ...f.target,
        executionWindow: { notBefore: f.target.notBefore, expiresAt: f.target.expiresAt },
        approval: {
          envelopeId: f.envelope.id, envelopeHash: canonicalApprovalEnvelopeHash(f.envelope),
          approvedAt: f.envelope.approvedAt, planDigest: f.input.plan.planDigest, savedPlanDigest: canonicalSha256(f.input.plan)
        }
      }
    });
    expect(f.envelope.costCeiling).toEqual({ currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 });
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
    expect(result.valid && Object.hasOwn(result.authority, 'actorId')).toBe(false);
    expect(result.valid && Object.hasOwn(result.authority, 'approved')).toBe(false);
  });

  it.each(['lease', 'private issuance', 'configuration', 'operator', 'effects', 'expiry', 'future start', 'source actor'] as const)(
    'rejects missing or changed %s authority before any provider call', async (field) => {
      const f = await fixture();
      if (field === 'private issuance') {
        const issued = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
          .read(canonicalApprovalEnvelopeHash(f.envelope));
        expect(issued).not.toBeNull();
        await rm(issued!.path);
      }
      if (field === 'configuration') f.target.spendCeilingCents++;
      if (field === 'operator') f.target.actor.operator = 'another-operator';
      if (field === 'effects') f.target.permittedEffects = ['github-read'];
      if (field === 'expiry') f.input.clock = () => new Date(f.target.expiresAt);
      if (field === 'future start') f.target.notBefore = '2026-09-15T00:05:00.000Z';
      if (field === 'source actor') f.workflow.actorId++;
      const invoke = (input: typeof f.input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch);
      if (field === 'private issuance') {
        await expect(f.leased(invoke)).rejects.toThrow(/no project-bound authority issued by governance approve/);
        expect(f.protocol.requests).toEqual([]);
        expect(f.protocol.armRequests).toEqual([]);
        return;
      }
      const result = field === 'lease' ? await invoke(f.input) : await f.leased(invoke);
      expect(result.valid).toBe(false);
      expect(result).toHaveProperty('blocker', expect.any(String));
      expect(f.protocol.requests).toEqual([]);
      expect(f.protocol.armRequests).toEqual([]);
    });

  it.each([
    { approved: true }, { qualificationApproved: true }, { resourceId: '/a/resource' },
    { actorId: 'an-operator' }, { spendLimitUsd: 1 }, { approvalEnvelopeId: 'not-issued' }
  ])('rejects the legacy authority alias or flag %j rather than restoring it', async (extra) => {
    const f = await fixture();
    expect(() => disposableTargetConfig({ ...f.target, ...extra })).toThrow(/exactly its registered fields/);
  });

  it.each([-1, 0.01, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects non-integral disposable spending authority %s', async (amount) => {
    const f = await fixture();
    expect(() => disposableTargetConfig({ ...f.target, spendCeilingCents: amount })).toThrow(/whole cents/);
  });

  it('does not substitute a large monthly approval for absent disposable authority', async () => {
    const f = await fixture();
    const configuration = f.input.inspection.activationInputs!;
    configuration.budget = { currency: 'USD', fixedMonthlyCents: 999999, usageMonthlyCents: 999999 };
    configuration.phases = { ...configuration.phases, 'staging-qualified': {} };
    const result = await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch));
    expect(result).toMatchObject({ valid: false, blocker: expect.stringMatching(/Disposable qualification request/) });
    expect(f.protocol.requests).toEqual([]);
  });

  it('rejects a registered workflow budget that cannot fit the exact disposable authority interval', async () => {
    const f = await fixture();
    expect(() => environmentRuntimeInputs({
      ...f.dispatch.inputs, disposableTarget: { ...f.target, maxDurationMinutes: 4, expiresAt: '2026-09-15T00:04:00.000Z' }
    })).toThrow(/five-minute runtime job/);
    expect(() => environmentRuntimeInputs({
      ...f.dispatch.inputs, disposableTarget: { ...f.target, expiresAt: '2026-09-15T00:04:59.999Z' }
    })).toThrow(/five-minute runtime job/);
  });

  it('admits approval issued inside an already-open reviewed window without shifting its original start', async () => {
    const f = await fixture({ approvedAt: '2026-09-15T00:02:00.000Z' });
    f.now.setTime(Date.parse('2026-09-15T00:04:00.000Z'));
    const result = await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch));
    expect(result).toMatchObject({
      valid: true,
      authority: {
        notBefore: '2026-09-15T00:00:00.000Z',
        executionWindow: { notBefore: '2026-09-15T00:02:00.000Z', expiresAt: '2026-09-15T00:15:00.000Z' },
        approval: { approvedAt: '2026-09-15T00:02:00.000Z' }
      }
    });
    expect(f.protocol.requests).toEqual([]);
    f.now.setTime(Date.parse('2026-09-15T00:01:59.999Z'));
    expect(await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch))).toMatchObject({ valid: false });
  });

  it('uses the effective approval/plan expiry without extending the reviewed request', async () => {
    const f = await fixture({
      approvedAt: '2026-09-15T00:02:00.000Z',
      approvalExpiresAt: '2026-09-15T00:10:00.000Z', planExpiresAt: '2026-09-15T00:12:00.000Z'
    });
    f.now.setTime(Date.parse('2026-09-15T00:04:00.000Z'));
    expect(await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch))).toMatchObject({
      valid: true, authority: {
        expiresAt: '2026-09-15T00:15:00.000Z',
        executionWindow: { notBefore: '2026-09-15T00:02:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z' }
      }
    });
    f.now.setTime(Date.parse('2026-09-15T00:10:00.000Z'));
    expect(await f.leased((input) => validateOperatorQualificationAuthority(input, 'staging', f.dispatch))).toMatchObject({ valid: false });
    expect(f.protocol.requests).toEqual([]);
  });

  it('intersects all three windows and refuses an empty interval without resetting expiry', async () => {
    const f = await fixture();
    expect(qualificationAuthority.qualificationExecutionWindow(f.target, {
      createdAt: '2026-09-15T00:03:00.000Z', expiresAt: '2026-09-15T00:12:00.000Z'
    }, {
      approvedAt: '2026-09-15T00:02:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z'
    })).toEqual({ notBefore: '2026-09-15T00:03:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z' });
    expect(() => qualificationAuthority.qualificationExecutionWindow(f.target, {
      createdAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:15:00.000Z'
    }, {
      approvedAt: '2026-09-15T00:16:00.000Z', expiresAt: '2026-09-15T00:20:00.000Z'
    })).toThrow(/no common execution interval/);
  });
});

describe('registered runtime source, provider artifact bytes and independent ARM observation', () => {
  it('uses the current registered minimum dev reads without deployment or backend effects, and never substitutes them for foundation proof', async () => {
    const f = await fixture({ phaseId: 'dev-proof' });
    expect(f.input.plan.operations.map((operation) => operation.actionId)).toEqual(['github.checks.dev-proof', 'azure.dev.readback']);
    expect(f.input.plan.operations.flatMap((operation) => [operation, ...(operation.effects ?? [])])
      .every((operation) => ['github-workflow-dispatch', 'github-read', 'azure-read'].includes(operation.mutationClass))).toBe(true);
    await f.dispatchRun();
    const observation = await f.observe();
    expect(observation.kind).toBe('environment-runtime-observation.v1');
    expect(observation.authority.target.environment).toBe('dev');
    expect(f.protocol.armRequests.map((request) => request.method)).toEqual(['GET', 'GET']);
    const before = f.protocol.requests.length;
    expect(await environmentQualificationWiring.executors['dev-proof'](f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/Development proof requires exactly its registered fields/)
    });
    expect(f.protocol.requests).toHaveLength(before);
    expect(f.protocol.armRequests).toHaveLength(2);
  });

  it('refuses report adoption without the original private pre-dispatch record', async () => {
    const f = await fixture();
    await expect(f.observe()).rejects.toThrow(/private pre-dispatch checkpoint/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('reads real shared-dispatch IDs and ZIP bytes after a durable pre-effect checkpoint, without treating runtime as full qualification', async () => {
    const f = await fixture();
    let checkpointSeen = false;
    f.protocol.beforeRequest = async (request) => {
      if (request.method !== 'POST') return;
      const checkpoint = await readQualificationCheckpoints(f.input, f.dispatch, f.workflow, f.dispatchInputs);
      expect(checkpoint?.prepared.planDigest).toBe(f.input.plan.planDigest);
      expect(checkpoint?.prepared.approvalEnvelopeHash).toBe(canonicalApprovalEnvelopeHash(f.envelope));
      expect(checkpoint?.response).toBeNull();
      expect(checkpoint?.observed).toBeNull();
      checkpointSeen = true;
    };
    expect(await f.dispatchRun()).toMatchObject({ status: 'completed', operation: { operationId: String(f.protocol.runId) } });
    expect(checkpointSeen).toBe(true);
    const observed = await f.observe();
    expect(observed).toMatchObject({
      kind: 'environment-runtime-observation.v1', executionSourceSha: f.workflow.sourceSha,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      reportArtifact: { artifactId: f.protocol.artifactId, name: `liftoff-environment-${f.protocol.correlation}`,
        archiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), reportDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      report: { producer: { runId: f.protocol.runId, jobId: f.protocol.jobId, runnerId: f.protocol.runner.id } },
      resource: {
        resourceId: f.target.target.resourceId, revisionName: f.runtime.revisionName, imageRef: f.runtime.imageRef,
        appRequestId: 'aaaa1111-2222-4333-8444-555555555555',
        revisionRequestId: 'bbbb1111-2222-4333-8444-555555555555', trafficWeight: 100
      }
    });
    expect(observed).not.toHaveProperty('nativeQualification');
    expect(observed).not.toHaveProperty('securityDast');
    expect(observed).not.toHaveProperty('rehearsalLedger');
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.armRequests.map((request) => request.method)).toEqual(['GET', 'GET']);
    const repeated = await f.observe();
    expect(repeated).toMatchObject({
      operation: observed.operation, reportArtifact: observed.reportArtifact,
      report: observed.report, workflowEvidence: observed.workflowEvidence, resource: observed.resource
    });
    expect(repeated.assignmentObservation.binding).toEqual(observed.assignmentObservation.binding);
    expect(repeated.assignmentObservation.requestIds).not.toEqual(observed.assignmentObservation.requestIds);
    expect(repeated.nativeWitness).not.toEqual(observed.nativeWitness);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('recovers pending and a lost response through the same shared recorded operation without duplicate dispatch', async () => {
    const pending = await fixture();
    pending.protocol.pending = true;
    expect(await pending.dispatchRun()).toMatchObject({ status: 'pending' });
    await expect(pending.observe()).rejects.toThrow();
    expect(pending.protocol.armRequests).toEqual([]);
    pending.protocol.pending = false;
    expect(await pending.dispatchRun()).toMatchObject({ status: 'completed' });
    expect(await pending.observe()).toHaveProperty('operation.operationId', String(pending.protocol.runId));
    expect(pending.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    const uncertain = await fixture();
    uncertain.protocol.loseDispatchResponse = true;
    await expect(uncertain.dispatchRun()).rejects.toThrow(/lost the dispatch response/);
    await expect(uncertain.observe()).rejects.toThrow(/no independently observed provider run ID/);
    expect(await uncertain.dispatchRun()).toMatchObject({ status: 'completed' });
    expect(await uncertain.observe()).toHaveProperty('operation.operationId', String(uncertain.protocol.runId));
    expect(uncertain.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('retains uncertain effects when the exact provider run cannot be uniquely recovered', async () => {
    const f = await fixture();
    f.protocol.loseDispatchResponse = true;
    await expect(f.dispatchRun()).rejects.toThrow();
    const prepared = await readQualificationCheckpoints(f.input, f.dispatch, f.workflow, f.dispatchInputs);
    f.protocol.duplicateRun = true;
    await expect(f.dispatchRun()).rejects.toThrow(/no unique exact provider run/);
    f.protocol.duplicateRun = false;
    f.protocol.hideRun = true;
    await expect(f.dispatchRun()).rejects.toThrow(/no unique exact provider run/);
    expect((await readQualificationCheckpoints(f.input, f.dispatch, f.workflow, f.dispatchInputs))?.prepared).toEqual(prepared?.prepared);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('accepts actual GitHub UTC timestamps without milliseconds, without backdating the record or clock', async () => {
    const f = await fixture();
    await f.dispatchRun();
    f.protocol.runMutation = { created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z' };
    f.protocol.jobMutation = { started_at: '2026-09-15T00:00:00Z', completed_at: '2026-09-15T00:00:00Z' };
    expect(await f.observe()).toHaveProperty('report.observedAt', '2026-09-15T00:00:00.000Z');
  });

  it.each(['actor', 'repository'] as const)('requires the current readback %s, not just historical run metadata', async (field) => {
    const f = await fixture();
    await f.dispatchRun();
    if (field === 'actor') f.protocol.currentActorId++;
    else f.protocol.currentRepositoryId++;
    await expect(f.observe()).rejects.toThrow(/currently approved GitHub principal and repository/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  const runMutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['source', { head_sha: 'a'.repeat(40) }],
    ['attempt', { run_attempt: 2 }],
    ['repository', { repository: { id: 91, full_name: 'owner/other' } }],
    ['actor', { actor: { id: 81 } }],
    ['triggering actor', { triggering_actor: { id: 82 } }],
    ['workflow', { workflow_id: 99 }],
    ['ref', { head_branch: 'hotfix/unreviewed' }],
    ['correlation', { display_title: 'a manually selected successful run' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['neutral', { conclusion: 'neutral' }],
    ['skipped', { conclusion: 'skipped' }]
  ];
  it.each(runMutations)('rejects provider %s drift despite a success-shaped report', async (_label, mutation) => {
    const f = await fixture();
    await f.dispatchRun();
    f.protocol.runMutation = mutation;
    await expect(f.observe()).rejects.toThrow();
    expect(f.protocol.armRequests).toEqual([]);
  });

  const reportMutations: Array<[string, (report: EnvironmentRuntimeReport) => unknown]> = [
    ['source', (r) => ({ ...r, source: { ...r.source, commitSha: 'a'.repeat(40) } })],
    ['attempt', (r) => ({ ...r, producer: { ...r.producer, runAttempt: 2 } })],
    ['job', (r) => ({ ...r, producer: { ...r.producer, jobId: 999 } })],
    ['runner', (r) => ({ ...r, producer: { ...r.producer, runnerId: 999 } })],
    ['environment', (r) => ({ ...r, target: { ...r.target, environment: 'prod' } })],
    ['resource', (r) => ({ ...r, target: { ...r.target, resourceId: `${r.target.resourceId}-other` } })],
    ['correlation', (r) => ({ ...r, correlationId: '11111111-2222-4333-8444-555555555555' })],
    ['configuration', (r) => ({ ...r, configurationDigest: 'f'.repeat(64) })],
    ['HTML 200', (r) => ({ ...r, health: { ...r.health, mediaType: 'text/html' } })],
    ['blank schema', (r) => ({ ...r, schema: { ...r.schema, paths: [] } })],
    ['future observation', (r) => ({ ...r, observedAt: '2026-09-15T00:00:01.000Z' })],
    ['forged approval flag', (r) => ({ ...r, approved: true })]
  ];
  it.each(reportMutations)('rejects provider-digest-valid report %s forgery before independent ARM access', async (_label, mutate) => {
    const f = await fixture();
    await f.dispatchRun();
    f.protocol.reportMutation = mutate;
    await expect(f.observe()).rejects.toThrow();
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['runner assignment', 'skipped runtime step', 'infrastructure check', 'wrong workflow source', 'wrong ZIP', 'duplicate artifact', 'artifact source'] as const)(
    'rejects %s instead of trusting workflow or artifact labels', async (field) => {
      const f = await fixture();
      await f.dispatchRun();
      if (field === 'runner assignment') f.protocol.jobMutation = { runner_group_name: 'unreviewed-group' };
      if (field === 'skipped runtime step') f.protocol.jobMutation = { steps: [
        { number: 1, name: environmentRuntimeStep, status: 'completed', conclusion: 'skipped' },
        { number: 2, name: environmentRuntimeUploadStep, status: 'completed', conclusion: 'success' }
      ] };
      if (field === 'infrastructure check') f.protocol.checkMutation = { output: { summary: 'Runner lost communication' } };
      if (field === 'wrong workflow source') f.protocol.sourceContent = f.protocol.sourceContent.replace("node --input-type=module", "echo forged-report");
      if (field === 'wrong ZIP') f.protocol.corruptArchive = true;
      if (field === 'duplicate artifact') f.protocol.duplicateArtifact = true;
      if (field === 'artifact source') f.protocol.artifactMutation = (data) => ({
        ...data, workflow_run: { id: f.protocol.runId, repository_id: 42, head_repository_id: 42, head_sha: 'a'.repeat(40), head_branch: 'develop' }
      });
      await expect(f.observe()).rejects.toThrow();
      expect(f.protocol.armRequests).toEqual([]);
    });

  it.each(['image', 'revision', 'traffic', 'health', 'hostname'] as const)(
    'requires independent provider %s readback rather than trusting report self-assertions', async (field) => {
      const f = await fixture();
      await f.dispatchRun();
      if (field === 'image') f.protocol.armRevisionMutation = { template: { containers: [{ image: 'fixture.azurecr.io/application:latest' }] } };
      if (field === 'revision') f.protocol.armAppMutation = { latestReadyRevisionName: 'environment-test--other' };
      if (field === 'traffic') f.protocol.armAppMutation = { configuration: { ingress: {
        fqdn: f.recipe.fqdn, traffic: [{ revisionName: f.runtime.revisionName, weight: 50 }, { revisionName: 'unreviewed', weight: 50 }]
      } } };
      if (field === 'health') f.protocol.armRevisionMutation = { healthState: 'Unhealthy' };
      if (field === 'hostname') f.protocol.armAppMutation = { configuration: { ingress: {
        fqdn: 'other.azurecontainerapps.io', traffic: [{ revisionName: f.runtime.revisionName, weight: 100 }]
      } } };
      await expect(f.observe()).rejects.toThrow(/exact|actual|independent/i);
      expect(f.protocol.armRequests.length).toBeGreaterThan(0);
      expect(f.protocol.armRequests.every((request) => request.method === 'GET')).toBe(true);
    });
});

describe('strict report archive and original receipt commitments', () => {
  it('retains the exact environment report and archive byte ceilings above shared extraction', () => {
    const exact = Buffer.alloc(64 * 1024, 32);
    expect(readEnvironmentRuntimeArchive(environmentReportZip(exact))).toEqual(exact);
    expect(() => readEnvironmentRuntimeArchive(environmentReportZip(Buffer.alloc(64 * 1024 + 1, 32)))).toThrow();
    expect(() => readEnvironmentRuntimeArchive(Buffer.alloc(512 * 1024 + 1))).toThrow(/at most 512 KiB/);
  });

  it('accepts shared ZIP64 metadata without changing the caller archive or reserializing report bytes', () => {
    const content = Buffer.from('{"kind":"exact-original-report-bytes"}\n');
    const ordinary = environmentReportZip(content);
    const footer = ordinary.length - 22;
    const central = ordinary.readUInt32LE(footer + 16);
    const centralSize = ordinary.readUInt32LE(footer + 12);
    ordinary.writeUInt16LE(45, 4);
    ordinary.writeUInt16LE(45, central + 6);
    const end64 = Buffer.alloc(56), locator = Buffer.alloc(20);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(1n, 24);
    end64.writeBigUInt64LE(1n, 32);
    end64.writeBigUInt64LE(BigInt(centralSize), 40);
    end64.writeBigUInt64LE(BigInt(central), 48);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(footer), 8);
    locator.writeUInt32LE(1, 16);
    const archive = Buffer.concat([ordinary.subarray(0, footer), end64, locator, ordinary.subarray(footer)]);
    const original = Buffer.from(archive);
    const extracted = readEnvironmentRuntimeArchive(archive);
    expect(extracted).toEqual(content);
    expect(archive).toEqual(original);
    extracted.fill(0);
    expect(archive).toEqual(original);
  });

  it.each([
    { deflate: false, descriptor: false }, { deflate: true, descriptor: false },
    { deflate: false, descriptor: true }, { deflate: true, descriptor: true }
  ])('reads only the exact regular report bytes for ZIP layout %j', (options) => {
    const bytes = Buffer.from('{"kind":"fixture-bytes-not-qualification"}\n');
    expect(readEnvironmentRuntimeArchive(environmentReportZip(bytes, options))).toEqual(bytes);
  });

  it('rejects wrong names, truncation, CRC errors, duplicate entries, links, encryption and oversized expansion', () => {
    const content = Buffer.from('{"kind":"fixture"}\n');
    expect(() => readEnvironmentRuntimeArchive(environmentReportZip(content, { name: '../liftoff-environment-runtime.json' }))).toThrow();
    const archive = environmentReportZip(content);
    for (const length of [0, 1, 21, 30, archive.length - 1]) expect(() => readEnvironmentRuntimeArchive(archive.subarray(0, length))).toThrow();
    const central = archive.readUInt32LE(archive.length - 6);
    const corruptions = [
      (b: Buffer) => { b[30 + b.readUInt16LE(26)] = 0; },
      (b: Buffer) => { b.writeUInt16LE(2, b.length - 14); b.writeUInt16LE(2, b.length - 12); },
      (b: Buffer) => { b.writeUInt32LE(0o120000 << 16 >>> 0, central + 38); },
      (b: Buffer) => { b.writeUInt16LE(1, 6); b.writeUInt16LE(1, central + 8); },
      (b: Buffer) => { b.writeUInt32LE(65537, central + 24); }
    ];
    for (const corrupt of corruptions) {
      const copy = Buffer.from(archive); corrupt(copy);
      expect(() => readEnvironmentRuntimeArchive(copy)).toThrow();
    }
    expect(() => readEnvironmentRuntimeArchive(environmentReportZip(Buffer.alloc(65537, 32), { deflate: true }))).toThrow();
  });

  it('rejects duplicate JSON keys instead of normalizing them into a successful report', async () => {
    const f = await fixture();
    const bytes = Buffer.from('{"schemaVersion":9,"schemaVersion":1}\n');
    expect(() => validateEnvironmentRuntimeReport(bytes, f.recipe, f.workflow, {
      runId: 1, correlationId: '', configurationDigest: '', now: f.now,
      job: { id: 1, name: 'x', conclusion: 'success', checkRunId: 2, appId: 3, appSlug: 'github-actions', steps: [] },
      providerJob: {}
    })).toThrow(/duplicate keys/);
  });

  it('selects only an explicitly bound original receipt, never a newer success or first match', async () => {
    const f = await fixture();
    const { record, reference } = f.boundReceipt({ kind: 'staging-qualified.v1', marker: 'original fixture commitment only' });
    const unrelated = { ...structuredClone(record), evidenceId: 'unrelated-newer-receipt',
      header: { ...record.header, producedAt: '2026-09-15T00:00:01.000Z' } };
    f.inspection.evidence = [unrelated, record];
    expect(requireQualificationEvidence(f.inspection, 'staging-qualified', reference, f.now).record).toBe(record);
    f.inspection.evidence = [record, structuredClone(record)];
    expect(() => requireQualificationEvidence(f.inspection, 'staging-qualified', reference, f.now)).toThrow(/one explicitly referenced/);
  });

  it('rejects tampered body/header and caller-rehashed replacements not bound by original state', async () => {
    const f = await fixture();
    const { record, reference } = f.boundReceipt({ kind: 'staging-qualified.v1', marker: 'original' });
    if (!isRecord(record.payload)) throw new Error('The bound fixture receipt lost its object payload.');
    record.payload = { ...record.payload, marker: 'replaced' };
    expect(() => requireQualificationEvidence(f.inspection, 'staging-qualified', reference, f.now)).toThrow();
    record.header.bodyDigest = evidenceBodyDigest(record.payload, record.liveReadback);
    const rewritten = { evidenceId: record.evidenceId, bodyDigest: record.header.bodyDigest, headerDigest: evidenceHeaderDigest(record.header) };
    expect(() => requireQualificationEvidence(f.inspection, 'staging-qualified', rewritten, f.now)).toThrow(/authoritative state reference/);
  });

  it('cannot authorize full activation from even header/body-bound Boolean-only staging metadata', async () => {
    const f = await fixture();
    const { reference } = f.boundReceipt({
      kind: 'staging-qualified.v1', sourceSha: f.workflow.sourceSha, artifactDigest: `sha256:${'d'.repeat(64)}`,
      privateRunner: { verified: true }, securityDast: { dastJobVerified: true, securityCheckVerified: true },
      nativeQualification: { environment: 'staging', reportDigest: 'a'.repeat(64) }
    });
    const references = { sourceSha: f.workflow.sourceSha, artifactDigest: `sha256:${'d'.repeat(64)}`,
      staging: reference, rehearsal: reference, greenRed: reference };
    expect(validateFullActivationProofReceipts(f.inspection, 'activation', references, f.now).valid).toBe(false);
    expect(validateFullActivationProofReceipts(f.inspection, 'repository', references, f.now)).toMatchObject({
      valid: false, blocker: expect.stringMatching(/requires activation scope/)
    });
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('uses released freshness contexts and the original plan, without inventing a receipt-age cutoff', async () => {
    const f = await fixture();
    const { reference, record } = f.boundReceipt({ kind: 'staging-qualified.v1' });
    expect(requireQualificationEvidence(f.inspection, 'staging-qualified', reference, new Date('2026-09-15T03:00:00.000Z')).record).toBe(record);
    expect(() => requireQualificationEvidence(f.inspection, 'staging-qualified', reference, new Date(NaN))).toThrow();
    f.inspection.contexts['staging-qualified'].reviewedPlans = [];
    expect(() => requireQualificationEvidence(f.inspection, 'staging-qualified', reference, f.now)).toThrow(/retained-plan/);
  });
});

describe('default environment producers require their actual inputs, without inferred effects', () => {
  it('does not expose a Boolean approval shortcut through either authority or producer exports', () => {
    expect(Object.hasOwn(qualificationAuthority, 'isDisposableQualificationApproved')).toBe(false);
    expect(Object.hasOwn(qualificationProducers, 'isDisposableQualificationApproved')).toBe(false);
  });

  it('rejects incomplete phase inputs before provider access rather than relabeling runtime observations or repository checks', async () => {
    const f = await fixture();
    for (const planner of Object.values(environmentQualificationWiring.planners)) {
      expect(await planner(f.input)).toMatchObject({ operations: [], blockers: [expect.stringMatching(/\S/)] });
    }
    for (const execute of Object.values(environmentQualificationWiring.executors)) {
      const outcome = await execute(f.input);
      expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [], blocker: expect.stringMatching(/\S/) });
      expect(outcome).not.toHaveProperty('evidencePayload');
      expect(outcome).not.toHaveProperty('resultState');
    }
    for (const environment of ['staging', 'prod'] as const) {
      expect(await executeAzureQualificationPhase(f.input, environment)).toMatchObject({ status: 'blocked', completedOperations: [] });
    }
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('keeps digest comparison a pure comparison, not rollout or build-source proof', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    expect(verifyArtifactEquality(digest, digest)).toBe(true);
    for (const value of ['latest', `sha256:${'D'.repeat(64)}`, `${digest}-extra`, `sha256:${'e'.repeat(64)}`]) {
      expect(verifyArtifactEquality(digest, value)).toBe(false);
    }
  });

  it('does not erase a previously recorded unresolved provider operation while blocking qualification', async () => {
    const f = await fixture();
    const operation = {
      provider: 'github' as const, actionId: f.dispatch.actionId, operationId: '7412',
      resourceId: '/repos/owner/repo/actions/runs/7412', startedAt: f.now.toISOString(), observedAt: f.now.toISOString(),
      status: 'running' as const, planDigest: f.input.plan.planDigest
    };
    f.input.inspection.state.phases['staging-qualified'].operation = operation;
    const outcome = await environmentQualificationWiring.executors['staging-qualified'](f.input);
    expect(outcome).toMatchObject({ status: 'blocked', operation, cleanupWarnings: [expect.stringMatching(/retained/)] });
    expect(outcome).not.toHaveProperty('evidencePayload');
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['disposable target', 'Azure binding'] as const)(
    'preserves the recorded operation despite missing qualification inputs: %s', async (missing) => {
      const f = await fixture();
      const operation = {
        provider: 'github' as const, actionId: f.dispatch.actionId, operationId: '7412',
        resourceId: '/repos/owner/repo/actions/runs/7412', startedAt: f.now.toISOString(), observedAt: f.now.toISOString(),
        status: 'running' as const, planDigest: f.input.plan.planDigest
      };
      f.input.inspection.state.phases['staging-qualified'].operation = operation;
      const configuration = f.input.inspection.activationInputs!;
      if (missing === 'disposable target') configuration.phases = { ...configuration.phases, 'staging-qualified': {} };
      else configuration.azure = { subscriptionId: '', tenantId: '', region: '' };
      const outcome = await executeAzureQualificationPhase(f.input, 'staging');
      expect(outcome).toMatchObject({ status: 'blocked', operation, cleanupWarnings: [expect.stringMatching(/retained/)] });
      expect(outcome).not.toHaveProperty('evidencePayload');
      expect(f.protocol.requests).toEqual([]);
      expect(f.protocol.armRequests).toEqual([]);
    });
});
