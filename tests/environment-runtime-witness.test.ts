import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import type { AzureArmResponse } from '../src/adapters/azure/activation-rest.js';
import { readEnvironmentRuntimeReceipt } from '../src/application/azure-activation/environment-runtime-receipt.js';
import { environmentRuntimeWitnessKey } from '../src/application/azure-activation/environment-runtime-witness.js';
import * as witnessApi from '../src/application/azure-activation/environment-runtime-witness.js';
import { environmentQualificationFixture } from './helpers/environment-qualification-fixture.js';

type Fixture = Awaited<ReturnType<typeof environmentQualificationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function capturedFixture(configure?: (fixture: Fixture) => void) {
  const f = await environmentQualificationFixture();
  fixtures.push(f);
  configure?.(f);
  await f.dispatchRun();
  const observation = await f.observe();
  const bound = f.boundReceipt({
    kind: 'staging-qualified.v1', applicationSourceSha: 'b'.repeat(40),
    artifactDigest: observation.artifactDigest, runtimeObservation: observation
  });
  const request = {
    phaseId: 'staging-qualified' as const, reference: bound.reference,
    verifierSource: { producerSourceSha: f.workflow.producerSourceSha, executionSourceSha: f.workflow.sourceSha },
    artifactDigest: observation.artifactDigest
  };
  const client = new GitHubActivationClient(f.protocol);
  const store = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
  f.protocol.requests.length = 0;
  f.protocol.armRequests.length = 0;
  const consume = () => readEnvironmentRuntimeReceipt({
    inspection: f.inspection, phase: f.input.phase, runner: f.input.runner,
    adapters: { githubActivation: { storage: f.storage, transport: f.protocol } },
    now: new Date('2026-09-15T03:00:00.000Z')
  }, client, request);
  const rehashPublic = () => {
    bound.record.header.bodyDigest = evidenceBodyDigest(bound.record.payload, bound.record.liveReadback);
    request.reference = {
      evidenceId: bound.record.evidenceId, headerDigest: evidenceHeaderDigest(bound.record.header),
      bodyDigest: bound.record.header.bodyDigest
    };
    const context = f.inspection.contexts['staging-qualified'];
    context.evidenceReferences = context.evidenceReferences?.map((entry) =>
      entry.evidenceId === bound.record.evidenceId ? { ...entry, headerDigest: request.reference.headerDigest } : entry);
  };
  return { f, ...bound, request, client, store, observation, consume, rehashPublic };
}

describe('immutable operation-specific private runtime readback witness', () => {
  it('admits a later approval inside the reviewed window and preserves actual effect/report/witness times during later consumption', async () => {
    const f = await environmentQualificationFixture({
      approvedAt: '2026-09-15T00:02:00.000Z',
      approvalExpiresAt: '2026-09-15T00:10:00.000Z', planExpiresAt: '2026-09-15T00:12:00.000Z'
    });
    fixtures.push(f);
    f.now.setTime(Date.parse('2026-09-15T00:04:00.000Z'));
    await f.dispatchRun();
    const observation = await f.observe();
    const bound = f.boundReceipt({
      kind: 'staging-qualified.v1', applicationSourceSha: 'b'.repeat(40),
      artifactDigest: observation.artifactDigest, runtimeObservation: observation
    });
    expect(observation.authority.notBefore).toBe('2026-09-15T00:00:00.000Z');
    expect(observation.authority.executionWindow).toEqual({
      notBefore: '2026-09-15T00:02:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z'
    });
    const original = structuredClone(bound.record);
    f.protocol.armRequests.length = 0;
    f.protocol.currentActorId = 981;
    const result = await readEnvironmentRuntimeReceipt({
      inspection: f.inspection, phase: f.input.phase, runner: f.input.runner,
      adapters: { githubActivation: { storage: f.storage, transport: f.protocol } },
      now: new Date('2026-09-15T03:00:00.000Z')
    }, new GitHubActivationClient(f.protocol), {
      phaseId: 'staging-qualified', reference: bound.reference,
      verifierSource: { producerSourceSha: f.workflow.producerSourceSha, executionSourceSha: f.workflow.sourceSha },
      artifactDigest: observation.artifactDigest
    });
    expect(result.report.observedAt).toBe('2026-09-15T00:04:00.000Z');
    expect(result.nativeWitness.recordedAt).toBe('2026-09-15T00:04:00.000Z');
    expect(result.nativeWitness.binding.authority.approval.approvedAt).toBe('2026-09-15T00:02:00.000Z');
    expect(bound.record).toEqual(original);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('persists actual response digests/IDs and normalized observations without persisting unrelated response content', async () => {
    const captured: AzureArmResponse[] = [];
    const { f, observation, store, consume } = await capturedFixture((fixture) => {
      fixture.protocol.armAppMutation = { unrelatedPrivateContent: 'not-persisted-provider-body-marker' };
      fixture.input.adapters.azureActivation!.transport = { async request(request, binding) {
        const response = await fixture.protocol.arm.request(request, binding);
        captured.push(structuredClone(response));
        return response;
      } };
    });
    const record = await store.read(observation.nativeWitness.recordKey);
    expect(record).not.toBeNull();
    expect(canonicalSha256(record!.value)).toBe(observation.nativeWitness.witnessDigest);
    expect(JSON.stringify(record!.value)).not.toContain('not-persisted-provider-body-marker');
    const readback = await consume();
    const witness = readback.nativeWitness;
    const { nativeWitness: _descriptor, ...base } = observation;
    expect(witness).toMatchObject({
      kind: 'environment-runtime-readback-witness.v1', projectRoot: f.projectRoot,
      observationDigest: canonicalSha256(base), resource: observation.resource,
      assignmentObservation: observation.assignmentObservation,
      binding: {
        authority: observation.authority, checkpointDigest: observation.checkpointDigest,
        runId: f.protocol.runId, runAttempt: 1, jobId: f.protocol.jobId, checkRunId: f.protocol.checkId,
        runner: observation.workflowEvidence.runner,
        runnerAssignment: f.runnerAssignment,
        reportArtifact: observation.reportArtifact, applicationArtifactDigest: observation.artifactDigest
      },
      responses: {
        app: { requestId: captured[0]!.requestId, responseBodyDigest: canonicalSha256(captured[0]!.data) },
        revision: { requestId: captured[1]!.requestId, responseBodyDigest: canonicalSha256(captured[1]!.data) }
      }
    });
    expect(f.protocol.armRequests).toEqual([]);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
    expect(witness.resource.revisionActive).toBe(true);
    expect(readback.kind).toBe('environment-runtime-artifact.v1');
  });

  it.each(['image', 'resource', 'request ID', 'FQDN'] as const)(
    'rejects caller-rehashed public %s assertions against the original immutable private witness', async (field) => {
      const { f, observation, consume, rehashPublic } = await capturedFixture();
      if (field === 'image') observation.resource.imageRef = `fixture.azurecr.io/other@sha256:${'e'.repeat(64)}`;
      if (field === 'resource') observation.resource.resourceId += '-other';
      if (field === 'request ID') observation.resource.appRequestId = '11111111-2222-4333-8444-555555555555';
      if (field === 'FQDN') observation.resource.fqdn = 'unrelated.fixture.eastus.azurecontainerapps.io';
      rehashPublic();
      await expect(consume()).rejects.toThrow(/immutable private.*witness/);
      expect(f.protocol.armRequests).toEqual([]);
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

  it('rejects caller-rehashed assignment request IDs against the original immutable provider observation', async () => {
    const { f, observation, consume, rehashPublic } = await capturedFixture();
    observation.assignmentObservation.requestIds = observation.assignmentObservation.requestIds.map((id, index) =>
      index === 0 ? 'ABCD:1234:AAAA:9999' : id);
    rehashPublic();
    await expect(consume()).rejects.toThrow(/immutable private.*witness/);
    expect(f.protocol.requests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('requires the private witness record even when the public header/body and artifact descriptor remain valid', async () => {
    const { observation, store, consume, f } = await capturedFixture();
    const record = await store.read(observation.nativeWitness.recordKey);
    expect(record).not.toBeNull();
    await rm(record!.path);
    await expect(consume()).rejects.toThrow(/private ARM readback witness is unavailable/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('does not backfill an older metadata-only observation that has no mandatory private witness descriptor', async () => {
    const { f, observation, client } = await capturedFixture();
    const { nativeWitness: _descriptor, ...oldObservation } = observation;
    const bound = f.boundReceipt({
      kind: 'staging-qualified.v1', applicationSourceSha: 'b'.repeat(40),
      artifactDigest: observation.artifactDigest, runtimeObservation: oldObservation
    });
    await expect(readEnvironmentRuntimeReceipt({
      inspection: f.inspection, phase: f.input.phase, runner: f.input.runner,
      adapters: { githubActivation: { storage: f.storage, transport: f.protocol } }, now: f.now
    }, client, {
      phaseId: 'staging-qualified', reference: bound.reference,
      verifierSource: { producerSourceSha: f.workflow.producerSourceSha, executionSourceSha: observation.executionSourceSha },
      artifactDigest: observation.artifactDigest
    })).rejects.toThrow(/Private runtime readback witness reference/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('cannot create a missing private witness by rehashing public resources and witness descriptors', async () => {
    const { observation, consume, rehashPublic, store, f } = await capturedFixture();
    const original = (await consume()).nativeWitness;
    const forged = structuredClone(original);
    forged.resource.imageRef = `fixture.azurecr.io/other@sha256:${'e'.repeat(64)}`;
    const digest = canonicalSha256(forged);
    observation.nativeWitness = { recordKey: environmentRuntimeWitnessKey(forged.binding, digest), witnessDigest: digest };
    observation.resource.imageRef = forged.resource.imageRef;
    rehashPublic();
    expect(await store.read(observation.nativeWitness.recordKey)).toBeNull();
    await expect(consume()).rejects.toThrow(/private ARM readback witness is unavailable/);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('refuses replacement of different private witness bytes through the released immutable store', async () => {
    const { observation, store, consume } = await capturedFixture();
    const record = await store.read(observation.nativeWitness.recordKey);
    if (!record || !isRecord(record.value)) throw new Error('The real private witness was not persisted.');
    await expect(store.write(observation.nativeWitness.recordKey, {
      ...record.value, observationDigest: 'a'.repeat(64)
    })).rejects.toThrow(/Refusing to replace different governance-operation metadata/);
    expect(canonicalSha256((await store.read(observation.nativeWitness.recordKey))!.value)).toBe(observation.nativeWitness.witnessDigest);
    expect((await consume()).nativeWitness.resource).toEqual(observation.resource);
  });

  it('records a later actual observation separately without overwriting the original witness', async () => {
    const { f, observation, store } = await capturedFixture();
    const first = await store.read(observation.nativeWitness.recordKey);
    f.protocol.armAppMutation = { laterActualResponse: 'different-response-body' };
    const later = await f.observe();
    expect(later.nativeWitness.recordKey).not.toBe(observation.nativeWitness.recordKey);
    expect((await store.read(observation.nativeWitness.recordKey))!.value).toEqual(first!.value);
    expect(await store.read(later.nativeWitness.recordKey)).not.toBeNull();
  });

  it('rejects split explicitly selected private stores before any provider read or witness write', async () => {
    const f = await environmentQualificationFixture();
    fixtures.push(f);
    f.input.adapters.azureActivation!.storage = { ...f.storage, homedir: path.join(f.root, 'other private home') };
    await expect(f.observe()).rejects.toThrow(/same explicitly selected private storage boundary/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('does not expose a caller-data witness writer or minting API', () => {
    expect(Object.keys(witnessApi).some((name) => /^(?:write|persist|mint|record).*Witness/u.test(name))).toBe(false);
  });
});
