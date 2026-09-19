import { afterEach, describe, expect, it } from 'vitest';
import { GitHubActivationClient, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import { environmentRuntimeInputs } from '../src/application/azure-activation/environment-runtime-inputs.js';
import { readEnvironmentRuntimeReceipt } from '../src/application/azure-activation/environment-runtime-receipt.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import type { PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { renderEnvironmentRuntimeWorkflow } from '../src/application/azure-activation/environment-runtime-workflow.js';
import {
  environmentRuntimeRunnerReadEffects, readEnvironmentRuntimeRunnerAssignment
} from '../src/application/azure-activation/environment-runtime-assignment.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { rm } from 'node:fs/promises';
import {
  environmentRuntimeArtifactDescriptor, environmentRuntimeArtifactReference,
  observeEnvironmentRuntimeArtifact, readEnvironmentRuntimeArtifact,
  type EnvironmentRuntimeArtifactSource
} from '../src/application/azure-activation/environment-runtime-artifact.js';
import { environmentQualificationFixture } from './helpers/environment-qualification-fixture.js';

const fixtures: Awaited<ReturnType<typeof environmentQualificationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function recordedArtifact(options: { producerSourceSha?: string } = {}) {
  const f = await environmentQualificationFixture(options);
  fixtures.push(f);
  const dispatched = await f.dispatchRun();
  expect(dispatched.status).toBe('completed');
  const source: EnvironmentRuntimeArtifactSource = {
    inputs: environmentRuntimeInputs(f.dispatch.inputs), operation: dispatched.operation, correlationId: f.protocol.correlation
  };
  const metadata = f.protocol.artifact();
  const reference = environmentRuntimeArtifactReference({
    artifactId: metadata.id, name: metadata.name, archiveDigest: metadata.digest
  });
  const client = new GitHubActivationClient(f.protocol);
  const observed = await observeEnvironmentRuntimeArtifact(client, source, reference, f.now);
  f.protocol.requests.length = 0;
  return { f, source, client, descriptor: observed.reportArtifact, observed };
}

describe('GitHub-only retained environment runtime report admission', () => {
  it('binds the actual provider-assigned worker without embedding an ID or nullable wildcard in published source', async () => {
    const f = await environmentQualificationFixture({ observedRunnerId: 9351 });
    fixtures.push(f);
    const dispatched = await f.dispatchRun();
    const metadata = f.protocol.artifact();
    const observed = await observeEnvironmentRuntimeArtifact(new GitHubActivationClient(f.protocol), {
      inputs: environmentRuntimeInputs(f.dispatch.inputs), operation: dispatched.operation, correlationId: f.protocol.correlation
    }, environmentRuntimeArtifactReference({ artifactId: metadata.id, name: metadata.name, archiveDigest: metadata.digest }), f.now);
    expect(f.recipe.runner).toEqual({ group: 'environment-test-group', label: 'environment-test-linux' });
    expect(observed.runner).toEqual({
      runnerId: 9351, runnerName: f.protocol.runner.name, runnerGroupId: f.protocol.runner.groupId,
      runnerGroupName: f.recipe.runner.group, labels: [f.recipe.runner.label]
    });
    expect(observed.report.producer.runnerId).toBe(f.protocol.job().runner_id);
    f.protocol.reportMutation = (report) => ({ ...report, producer: { ...report.producer, runnerId: 999 } });
    await expect(f.observe()).rejects.toThrow();
  });

  it('exports a required descriptor with separate provider archive and raw report digests, not the application OCI identity', async () => {
    const { f, descriptor, source, client, observed } = await recordedArtifact();
    expect(descriptor).toEqual({
      artifactId: f.protocol.artifactId, name: `liftoff-environment-${source.correlationId}`,
      archiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reportDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(descriptor.archiveDigest).not.toBe(`sha256:${'d'.repeat(64)}`);
    expect(await readEnvironmentRuntimeArtifact(client, source, descriptor, f.now)).toEqual(observed);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => request.path.endsWith('/artifacts'))).toBe(false);
    expect(f.protocol.armRequests).toEqual([]);
    expect(observed.kind).toBe('environment-runtime-artifact.v1');
    expect(observed).not.toHaveProperty('nativeQualification');
    expect(observed).not.toHaveProperty('rehearsalTransitions');
  });

  it('permits a separately authorized enforcing reader without impersonating the original producer or backdating its clock', async () => {
    const { f, source, descriptor } = await recordedArtifact();
    const later = new Date('2026-09-15T03:00:00.000Z');
    f.protocol.currentActorId = 981;
    const calls: GitHubRequest[] = [];
    const client = new GitHubActivationClient({ async request(request) {
      if (request.method !== 'GET' || request.path === '/user') throw new Error('Consumer attempted producer authority or an unapproved effect.');
      calls.push(request);
      return f.protocol.request(request);
    } });
    const original = structuredClone(source);
    const readback = await readEnvironmentRuntimeArtifact(client, source, descriptor, later);
    expect(readback.report.producer.actorId).toBe(7);
    expect(readback.report.observedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(source).toEqual(original);
    expect(calls.length).toBeGreaterThan(0);
    expect(f.protocol.armRequests).toEqual([]);
    f.input.clock = () => later;
    await expect(f.observe()).rejects.toThrow(/expired|stale|unexpired/);
  });

  it('retains no archive bytes and leaves independently owned transport response buffers unchanged', async () => {
    const { f, source, descriptor } = await recordedArtifact();
    const archives: Buffer[] = [];
    const client = new GitHubActivationClient({ async request(request) {
      const response = await f.protocol.request(request);
      if (Buffer.isBuffer(response.data)) archives.push(response.data);
      return response;
    } });
    const report = await readEnvironmentRuntimeArtifact(client, source, descriptor, f.now);
    expect(report.reportArtifact).toEqual(descriptor);
    expect(report).not.toHaveProperty('archive');
    expect(archives).toHaveLength(1);
    expect(archives[0]).toEqual(f.protocol.archive());
    for (const archive of archives) archive.fill(0);
  });

  it('does not change stable workflow bytes or reviewed dispatch inputs when a different actual ephemeral worker is assigned', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    const source = renderEnvironmentRuntimeWorkflow(f.recipe);
    const inputs = structuredClone(f.dispatch.inputs);
    await f.dispatchRun();
    f.protocol.runner.id = 9351;
    f.protocol.runner.name = 'another-actual-ephemeral-worker';
    const observed = await f.observe();
    expect(renderEnvironmentRuntimeWorkflow(f.recipe)).toBe(source);
    expect(f.dispatch.inputs).toEqual(inputs);
    expect(observed.workflowEvidence.runner).toMatchObject({
      runnerId: 9351, runnerName: 'another-actual-ephemeral-worker',
      runnerGroupId: f.protocol.runner.groupId, runnerGroupName: f.recipe.runner.group
    });
    expect(observed.report.producer.runnerId).toBe(9351);
    expect(observed.report.producer.runnerId).not.toBe(f.runnerAssignment.binding.definitionId);
    expect(f.runnerFixture.http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(f.runnerFixture.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('binds real post-creation group/definition IDs and exact original evidence only in the separately reviewed dispatch configuration', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    const before = renderEnvironmentRuntimeWorkflow(f.recipe);
    const config = environmentRuntimeInputs(f.dispatch.inputs);
    expect(config.runnerAssignment).toEqual({
      reference: f.runnerFixture.assignment.reference, binding: f.runnerFixture.binding
    });
    expect(config.runnerAssignment.binding).toMatchObject({ groupId: 55, definitionId: 300 });
    const { dispatchInputs: _dispatchInputs, ...reviewed } = config;
    const changed = {
      ...reviewed, runnerAssignment: {
        ...reviewed.runnerAssignment,
        binding: { ...reviewed.runnerAssignment.binding, groupId: 155, definitionId: 1300 }
      }
    };
    expect(() => environmentRuntimeInputs({ ...changed, dispatchInputs: config.dispatchInputs })).toThrow(/commit the complete/);
    const separatelyReviewed = environmentRuntimeInputs({
      ...changed, dispatchInputs: { qualification_digest: canonicalSha256(changed) }
    });
    expect(separatelyReviewed.dispatchInputs).not.toEqual(config.dispatchInputs);
    expect(renderEnvironmentRuntimeWorkflow(separatelyReviewed.runtime.recipe)).toBe(before);
    expect(separatelyReviewed.workflow.workflowDigest).toBe(config.workflow.workflowDigest);
    const { runnerAssignment: _assignment, ...withoutAssignment } = config;
    expect(() => environmentRuntimeInputs(withoutAssignment)).toThrow(/exactly its registered fields/);
    for (const extra of [{ runnerId: null }, { runnerId: 351 }, { approved: true }, { verified: true }]) {
      expect(() => environmentRuntimeInputs({
        ...config, runnerAssignment: { ...config.runnerAssignment, ...extra }
      })).toThrow();
    }
  });

  it('rejects another numeric provider group even when its actual group name and label match the published source', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    await f.dispatchRun();
    f.protocol.runner.groupId++;
    await expect(f.observe()).rejects.toThrow(/group identity differs/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('does not substitute a hosted definition ID for the actual ephemeral job runner in a report', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    await f.dispatchRun();
    expect(f.runnerAssignment.binding.definitionId).not.toBe(f.protocol.runner.id);
    f.protocol.reportMutation = (report) => ({
      ...report, producer: { ...report.producer, runnerId: f.runnerAssignment.binding.definitionId }
    });
    await expect(f.observe()).rejects.toThrow(/actual source\/run\/attempt\/job\/runner\/actor/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('requires separately issued exact assignment GET effects instead of borrowing repository-only or original creation authority', async () => {
    const f = await environmentQualificationFixture({ runnerReadEffects: false });
    fixtures.push(f);
    await f.dispatchRun();
    await expect(f.observe()).rejects.toThrow(/each exact runner assignment GET resource/i);
    expect(f.protocol.requests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
    expect(f.protocol.armRequests).toEqual([]);
    expect(f.runnerFixture.http.calls.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('requires the current project lease before any assignment control GET, even with a genuine old creation receipt', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    await expect(readEnvironmentRuntimeRunnerAssignment(f.input, f.dispatch)).rejects.toThrow(/project mutation lease/);
    expect(f.protocol.requests).toEqual([]);
  });

  it.each(['record', 'retained original plan', 'authoritative reference'] as const)(
    'requires the exact original runner %s before assignment control GETs', async (missing) => {
      const f = await environmentQualificationFixture();
      fixtures.push(f);
      await f.dispatchRun();
      if (missing === 'record') {
        f.inspection.evidence = f.inspection.evidence.filter((record) => record.evidenceId !== f.runnerAssignment.reference.evidenceId);
      } else if (missing === 'retained original plan') f.inspection.contexts['runner-ready'].reviewedPlans = [];
      else f.inspection.contexts['runner-ready'].evidenceReferences = [];
      await expect(f.observe()).rejects.toThrow(/explicitly referenced original activation receipt/);
      expect(f.protocol.requests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
      expect(f.protocol.armRequests).toEqual([]);
    });

  it('reads only the nine exact reviewed control/fleet resources and retains actual provider request IDs separately from job evidence', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    const effects = environmentRuntimeRunnerReadEffects(environmentRuntimeInputs(f.dispatch.inputs));
    expect(effects).toHaveLength(9);
    const assignment = await f.leased((execution) => readEnvironmentRuntimeRunnerAssignment(execution, f.dispatch));
    expect(assignment.binding).toEqual(f.runnerAssignment.binding);
    expect(assignment.requestIds).toHaveLength(9);
    expect(new Set(assignment.requestIds).size).toBe(9);
    expect(assignment.sources).toEqual([]);
    expect(assignment.job).toBeNull();
    expect(f.protocol.requests.map((request) => {
      expect(request.method).toBe('GET');
      const url = new URL(request.path, 'https://api.github.com');
      return `${url.origin}${url.pathname}`;
    })).toEqual(effects.map((effect) => effect.destination.identity));
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each([
    'wrongSubnet', 'foreignNetworkAssignment', 'extraHostedRunner', 'selfHostedRunner', 'runnerPending',
    'groupRepositoryIds', 'workflow allowlist'
  ] as const)('rejects actual assignment control drift: %s, before ARM or witness capture', async (fault) => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    await f.dispatchRun();
    if (fault === 'groupRepositoryIds') f.runnerFixture.http.state.groupRepositoryIds = [42, 43];
    else if (fault === 'workflow allowlist') f.runnerFixture.http.changeGroup((group) => {
      group.selected_workflows = [f.runnerAssignment.binding.allowedWorkflows[0]];
    });
    else f.runnerFixture.http.state[fault] = true;
    await expect(f.observe()).rejects.toThrow();
    expect(f.protocol.requests.some((request) => request.path.startsWith('/orgs/'))).toBe(true);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each([
    ['missing runner ID', { runner_id: null }],
    ['invalid runner ID', { runner_id: 0 }],
    ['missing group ID', { runner_group_id: null }],
    ['invalid group ID', { runner_group_id: 0 }],
    ['wrong group name', { runner_group_name: 'unreviewed-group' }],
    ['missing runner name', { runner_name: null }],
    ['blank runner name', { runner_name: '' }],
    ['wrong labels', { labels: ['other-label'] }],
    ['duplicated labels', { labels: ['environment-test-linux', 'environment-test-linux'] }]
  ] as const)('rejects actual provider %s before ARM or private witness capture', async (_name, mutation) => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    await f.dispatchRun();
    f.protocol.jobMutation = mutation;
    await expect(f.observe()).rejects.toThrow();
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['OCI as archive', 'different report', 'different artifact', 'different correlation'] as const)(
    'rejects retained descriptor %s substitution', async (field) => {
      const { f, source, descriptor, client } = await recordedArtifact();
      const changed = { ...descriptor };
      if (field === 'OCI as archive') changed.archiveDigest = `sha256:${'d'.repeat(64)}`;
      if (field === 'different report') changed.reportDigest = `${descriptor.reportDigest[0] === '0' ? '1' : '0'}${descriptor.reportDigest.slice(1)}`;
      if (field === 'different artifact') changed.artifactId++;
      if (field === 'different correlation') changed.name = 'liftoff-environment-11111111-2222-4333-8444-555555555555';
      await expect(readEnvironmentRuntimeArtifact(client, source, changed, f.now)).rejects.toThrow();
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(f.protocol.armRequests).toEqual([]);
    });

  it.each([
    { id: 1 }, { digest: `sha256:${'a'.repeat(64)}` }, { artifactDigest: `sha256:${'a'.repeat(64)}` },
    { approved: true }, { verified: true }, { reportDigest: undefined }
  ])('does not accept a legacy alias, absent commitment or approval flag in the descriptor: %j', async (extra) => {
    const { descriptor } = await recordedArtifact();
    expect(() => environmentRuntimeArtifactDescriptor({ ...descriptor, ...extra })).toThrow();
  });

  it.each(['latest attempt', 'producer actor', 'expired provider artifact', 'out-of-window job', 'source ref'] as const)(
    'rechecks actual %s instead of trusting decoded evidence', async (field) => {
      const { f, source, descriptor, client } = await recordedArtifact();
      if (field === 'latest attempt') f.protocol.runMutation = { run_attempt: 2 };
      if (field === 'producer actor') f.protocol.runMutation = { actor: { id: 999 } };
      if (field === 'expired provider artifact') f.protocol.artifactMutation = (metadata) => ({ ...metadata, expired: true });
      if (field === 'out-of-window job') f.protocol.jobMutation = { completed_at: '2026-09-15T00:16:00Z' };
      if (field === 'source ref') f.protocol.currentRefSha = 'a'.repeat(40);
      await expect(readEnvironmentRuntimeArtifact(client, source, descriptor, new Date('2026-09-15T03:00:00.000Z'))).rejects.toThrow();
      expect(f.protocol.armRequests).toEqual([]);
    });

  it('does not mistake a later provider bookkeeping update for a new execution or an expired runtime report', async () => {
    const { f, source, descriptor, client } = await recordedArtifact();
    f.protocol.runMutation = { updated_at: '2026-09-15T03:00:00Z' };
    const readback = await readEnvironmentRuntimeArtifact(client, source, descriptor, new Date('2026-09-15T03:00:00.000Z'));
    expect(readback.run.updatedAt).toBe('2026-09-15T03:00:00Z');
    expect(readback.job.completedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(readback.report.observedAt).toBe('2026-09-15T00:00:00.000Z');
  });

  it('independently reads published verifier bytes when publication and execution commits differ', async () => {
    const { f, source, descriptor, client } = await recordedArtifact({ producerSourceSha: 'a'.repeat(40) });
    const result = await readEnvironmentRuntimeArtifact(client, source, descriptor, f.now);
    expect(result.verifierSource).toMatchObject({
      producerSourceSha: 'a'.repeat(40), executionSourceSha: 'c'.repeat(40),
      workflowId: f.workflow.workflowId, workflowPath: f.workflow.workflowPath,
      workflowDigest: f.workflow.workflowDigest, workflowBlobSha: expect.stringMatching(/^[a-f0-9]{40}$/)
    });
    const refs = f.protocol.requests.filter((request) => request.path.includes('/contents/'))
      .map((request) => new URL(request.path, 'https://api.github.com').searchParams.get('ref'));
    expect(refs).toContain('a'.repeat(40));
    expect(refs).toContain('c'.repeat(40));
    f.protocol.publishedSourceContent += '\n# Different published verifier bytes\n';
    await expect(readEnvironmentRuntimeArtifact(client, source, descriptor, f.now)).rejects.toThrow(/source|producer/i);
  });
});

describe('original receipt, private approval and checkpoint binding for GitHub-only readers', () => {
  async function receiptFixture(options: { producerSourceSha?: string } = {}) {
    const recorded = await recordedArtifact(options);
    const { f } = recorded;
    const observation = await f.observe();
    const bound = f.boundReceipt({
      kind: 'staging-qualified.v1', applicationSourceSha: 'b'.repeat(40),
      artifactDigest: observation.artifactDigest, runtimeObservation: observation
    });
    f.protocol.requests.length = 0;
    f.protocol.armRequests.length = 0;
    const request = {
      phaseId: 'staging-qualified' as const, reference: bound.reference,
      verifierSource: { producerSourceSha: f.workflow.producerSourceSha, executionSourceSha: f.workflow.sourceSha },
      artifactDigest: observation.artifactDigest
    };
    return { ...recorded, ...bound, observation, request };
  }

  it('uses the original issued plan/checkpoint as read data while preserving a different current reader and clock', async () => {
    const { f, request, observation, client, record } = await receiptFixture();
    const original = structuredClone(record);
    f.protocol.currentActorId = 981;
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'rulesets-applied')!;
    expect(phase.allowedMutations.remote).not.toContain('azure-read');
    expect(phase.allowedMutations.remote).not.toContain('github-workflow-dispatch');
    const enforcing: PhasePlanningInput = {
      inspection: f.inspection, phase, runner: f.input.runner, now: new Date('2026-09-15T03:00:00.000Z'),
      adapters: { githubActivation: { storage: f.storage, transport: f.protocol } }
    };
    const readback = await readEnvironmentRuntimeReceipt(enforcing, client, request);
    expect(readback.reportArtifact).toEqual(observation.reportArtifact);
    expect(readback.report).toEqual(observation.report);
    expect(readback.job.checkRunId).toBe(f.protocol.checkId);
    expect(record).toEqual(original);
    expect(enforcing.phase).toBe(phase);
    expect(enforcing.now.toISOString()).toBe('2026-09-15T03:00:00.000Z');
    expect(f.protocol.requests.every((call) => call.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((call) => call.path === '/user')).toBe(false);
    expect(f.protocol.requests.some((call) => call.path.startsWith('/orgs/'))).toBe(false);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['local', 'repository', 'lifecycle'] as const)('does not admit an environment receipt under %s selection scope', async (scope) => {
    const { f, request, client } = await receiptFixture();
    f.inspection.scope = scope;
    await expect(readEnvironmentRuntimeReceipt(f.input, client, request)).rejects.toThrow(/requires activation scope/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('keeps application build-source claims separate from both published and executing verifier sources', async () => {
    const { f, request, client, observation, record } = await receiptFixture({ producerSourceSha: 'a'.repeat(40) });
    const readback = await readEnvironmentRuntimeReceipt(f.input, client, request);
    expect(record.payload).toHaveProperty('applicationSourceSha', 'b'.repeat(40));
    expect(observation.executionSourceSha).toBe('c'.repeat(40));
    expect(readback.verifierSource.producerSourceSha).toBe('a'.repeat(40));
    expect(readback.verifierSource.executionSourceSha).toBe('c'.repeat(40));
    expect(readback.report.source.commitSha).toBe('c'.repeat(40));
    expect(readback).not.toHaveProperty('applicationSourceSha');
    expect(readback.nativeWitness.binding.verifierSource).toEqual(readback.verifierSource);
    expect(readback.kind).toBe('environment-runtime-artifact.v1');
  });

  it('rejects a caller-rehashed public receipt instead of loading artifact bytes against unbound original state', async () => {
    const { f, request, record, client } = await receiptFixture();
    record.payload = { kind: 'staging-qualified.v1', sourceSha: f.workflow.sourceSha, artifactDigest: request.artifactDigest, verified: true };
    record.header.bodyDigest = evidenceBodyDigest(record.payload, record.liveReadback);
    request.reference = { evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(record.header), bodyDigest: record.header.bodyDigest };
    await expect(readEnvironmentRuntimeReceipt(f.input, client, request)).rejects.toThrow();
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('requires the genuine private issuance even when the original public body, header and plan remain internally coherent', async () => {
    const { f, request, client } = await receiptFixture();
    const issued = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
      .read(canonicalApprovalEnvelopeHash(f.envelope));
    expect(issued).not.toBeNull();
    await rm(issued!.path);
    await expect(readEnvironmentRuntimeReceipt(f.input, client, request)).rejects.toThrow(/no project-bound authority/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('requires exact current source and application artifact identity', async () => {
    const { f, request, client } = await receiptFixture();
    await expect(readEnvironmentRuntimeReceipt(f.input, client, {
      ...request, verifierSource: { ...request.verifierSource, executionSourceSha: 'a'.repeat(40) }
    })).rejects.toThrow(/same declared/);
    await expect(readEnvironmentRuntimeReceipt(f.input, client, { ...request, artifactDigest: `sha256:${'e'.repeat(64)}` })).rejects.toThrow(/same declared/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('does not adopt another project transaction from a cached report when this approved plan has no private dispatch checkpoint', async () => {
    const original = await receiptFixture();
    const other = await environmentQualificationFixture();
    fixtures.push(other);
    const bound = other.boundReceipt({
      kind: 'staging-qualified.v1', applicationSourceSha: 'b'.repeat(40),
      artifactDigest: original.observation.artifactDigest, runtimeObservation: original.observation
    });
    await expect(readEnvironmentRuntimeReceipt(other.input, new GitHubActivationClient(other.protocol), {
      phaseId: 'staging-qualified', reference: bound.reference,
      verifierSource: { producerSourceSha: other.workflow.producerSourceSha, executionSourceSha: other.workflow.sourceSha },
      artifactDigest: original.observation.artifactDigest
    })).rejects.toThrow(/private pre-effect and observed provider-operation/);
    expect(other.protocol.requests).toEqual([]);
    expect(other.protocol.armRequests).toEqual([]);
  });

  it('rejects repository scope even if the caller rehashes the header and public state reference together', async () => {
    const { f, request, record, client } = await receiptFixture();
    record.header.scope = 'repository';
    request.reference = { ...request.reference, headerDigest: evidenceHeaderDigest(record.header) };
    const context = f.inspection.contexts['staging-qualified'];
    context.evidenceReferences = context.evidenceReferences?.map((entry) =>
      entry.evidenceId === record.evidenceId ? { ...entry, headerDigest: request.reference.headerDigest } : entry);
    await expect(readEnvironmentRuntimeReceipt(f.input, client, request)).rejects.toThrow(/original activation receipt/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it.each(['check ID', 'step number', 'verifier blob', 'runner ID', 'runner name', 'group ID', 'group name', 'runner labels'] as const)(
    'rejects caller-rehashed %s metadata by comparing actual report bytes and provider identities', async (field) => {
      const { f, request, record, observation, client } = await receiptFixture();
      if (field === 'check ID') observation.workflowEvidence.job.checkRunId++;
      else if (field === 'step number') observation.workflowEvidence.job.steps = observation.workflowEvidence.job.steps.map((step) => ({ ...step, number: step.number + 10 }));
      else if (field === 'verifier blob') observation.workflowEvidence.verifierSource.workflowBlobSha = 'a'.repeat(40);
      else if (field === 'runner ID') observation.workflowEvidence.runner.runnerId++;
      else if (field === 'runner name') observation.workflowEvidence.runner.runnerName += '-forged';
      else if (field === 'group ID') observation.workflowEvidence.runner.runnerGroupId++;
      else if (field === 'group name') observation.workflowEvidence.runner.runnerGroupName += '-forged';
      else observation.workflowEvidence.runner.labels = ['forged-runner-label'];
      record.header.bodyDigest = evidenceBodyDigest(record.payload, record.liveReadback);
      request.reference = {
        evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(record.header), bodyDigest: record.header.bodyDigest
      };
      const context = f.inspection.contexts['staging-qualified'];
      context.evidenceReferences = context.evidenceReferences?.map((entry) =>
        entry.evidenceId === record.evidenceId ? { ...entry, headerDigest: request.reference.headerDigest } : entry);
      await expect(readEnvironmentRuntimeReceipt(f.input, client, request)).rejects.toThrow(/same-attempt provider job\/check\/step/);
      expect(f.protocol.requests.some((call) => call.path.endsWith('/zip'))).toBe(true);
      expect(f.protocol.armRequests).toEqual([]);
    });
});
