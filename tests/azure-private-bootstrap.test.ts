import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapArmPlanForInspection, executeBootstrapLocal, planBootstrapLocal } from '../src/application/azure-activation/producer-bootstrap.js';
import { readPrivateEffect } from '../src/application/azure-activation/private-checkpoints.js';
import { createPrivateBootstrapArmPort, type BootstrapArmPort } from '../src/adapters/azure/private-bootstrap-arm.js';
import { AzureArmError } from '../src/adapters/azure/activation-rest.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { evidenceHeaderFor } from '../src/governance-activation/transition-records.js';
import { bootstrapAccess, custody, encryptedFixtureWorkspace, fixtureBinding, fixtureTime, privateActivationFixture } from './helpers/private-activation-fixture.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../src/process-runner.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

async function fixture(issue = true) {
  const base = bootstrapAccess();
  const f = await privateActivationFixture('bootstrap-local', {});
  fixtures.push(f);
  const held = custody(f.root);
  f.inspection.activationInputs!.phases['bootstrap-local'] = {
    principalId: base.binding.principalId, expiresAt: base.expiresAt,
    access: { resourceGroup: base.resourceGroup, storageAccountResourceId: base.storageAccountResourceId, network: base.network, runner: base.runner },
    custody: held
  };
  const { workspace, storage } = encryptedFixtureWorkspace(held);
  const build = planBootstrapLocal(f.planning());
  const input = await f.execution(build, { issue });
  const { access } = bootstrapArmPlanForInspection(f.planning());
  const resources = new Map<string, Record<string, unknown>>();
  const prerequisites = privateStateHttpFixture().rows;
  const creates: string[] = [], providerIds: string[] = [];
  let pending = false, unknown = false, undispatched = false, polls = 0;
  const arm: BootstrapArmPort = {
    async read(resource) {
      const value = resources.get(resource.resourceId) ??
        (resource.resourceType.startsWith('Microsoft.Storage/') ? prerequisites.get(resource.resourceId) : undefined);
      return { status: value ? 200 : 404, requestId: randomUUID(), data: value ? structuredClone(value) : null };
    },
    async create(resource, _binding, clientId) {
      const op = input.plan.operations.find((entry) => (entry.inputs.resource as { resourceId: string }).resourceId === resource.resourceId)!;
      const checkpoint = await readPrivateEffect(currentInput, op, {
        kind: 'bootstrap-arm-resource', step: 'create', provider: 'azure', resourceId: resource.resourceId,
        request: { method: 'PUT', apiVersion: resource.apiVersion, body: resource.body, ifNoneMatch: '*' }
      });
      expect(checkpoint?.prepared.clientRequestId).toBe(clientId);
      expect(checkpoint?.submitted).toBeNull();
      if (undispatched) { undispatched = false; throw new AzureArmError('authentication-prerequisite', 'Withheld', undefined, undefined, false); }
      creates.push(resource.resourceId);
      const value = structuredClone(resource.body) as any;
      value.id = resource.resourceId;
      value.type = resource.resourceType;
      value.properties.provisioningState = pending ? 'Updating' : 'Succeeded';
      if (resource.resourceType === 'GitHub.Network/networkSettings') value.tags.GitHubId = 'actual-network-id';
      resources.set(resource.resourceId, value);
      if (unknown) throw new AzureArmError('transport-failure', 'SYNTHETIC_SECRET_MUST_NOT_APPEAR', undefined, undefined, true);
      const requestId = randomUUID();
      providerIds.push(requestId);
      return { status: 201, requestId, data: value,
        operationUrl: `https://management.azure.com/subscriptions/${base.binding.subscriptionId}/providers/Microsoft.Network/locations/eastus/operations/${requestId}?api-version=2024-05-01` };
    },
    async poll() {
      polls++;
      return { status: 200, requestId: randomUUID(), data: { status: pending ? 'Running' : 'Succeeded' } };
    }
  };
  let currentInput = input;
  const execute = (selected = input) => {
    currentInput = selected;
    return withProjectMutationLock(f.projectRoot, (lease) => executeBootstrapLocal({ ...selected, lease }, { arm, workspace, wait: async () => undefined }));
  };
  return {
    f, input, access, held, workspace, storage, arm, resources, creates, providerIds, execute,
    pending(value: boolean) { pending = value; if (!value) for (const resource of resources.values()) (resource.properties as any).provisioningState = 'Succeeded'; },
    unknown() { unknown = true; }, undispatched() { undispatched = true; }, polls: () => polls
  };
}

describe('checkpointed access-only bootstrap', () => {
  it('keeps producer provenance separate from strict provider readback digest admission', async () => {
    const f = await fixture();
    const outcome = await f.execute();
    expect(outcome.status).toBe('completed');
    if (!isRecord(outcome.evidencePayload)) throw new Error('The bootstrap produced no bound public evidence payload.');
    const publicPayload = outcome.evidencePayload;
    for (const op of f.input.plan.operations) {
      expect(op.inputs.producerSourceDigest).toBe(f.access.sourceDigest);
      expect(op.inputs.sourceDigest).toBeUndefined();
    }
    expect(outcome.liveReadback?.every((proof) => proof.sourceDigest !== f.access.sourceDigest &&
      proof.sourceDigest === proof.readbackDigest)).toBe(true);
    const admitted = (input: PhaseAdapterExecutionInput) => {
      const payload = {
        ...publicPayload, planDigest: input.plan.planDigest,
        savedPlanDigest: canonicalSha256(input.plan), outputBindings: outcome.outputs
      };
      const header = evidenceHeaderFor({
        ...input, result: 'verified', payload, liveReadback: outcome.liveReadback
      });
      const evidenceId = 'fixture-bootstrap-readback-seam';
      return validateEvidenceFreshness({ evidenceId, header, payload, liveReadback: outcome.liveReadback }, {
        ...input.inspection.contexts['bootstrap-local'], now: input.now, reviewedPlans: [input.plan],
        evidenceReferences: [{ evidenceId, phaseId: 'bootstrap-local', result: 'verified', headerDigest: evidenceHeaderDigest(header) }],
        remoteBindingDigest: header.remoteBindingDigest
      });
    };
    expect(admitted(f.input)).toMatchObject({ valid: true });
    const incorrect = await f.f.execution({
      operations: f.input.plan.operations.map((op) => ({
        ...op, inputs: { ...op.inputs, sourceDigest: f.access.sourceDigest }
      }))
    });
    const rejected = admitted(incorrect);
    expect(rejected.valid).toBe(false);
    if (rejected.valid) throw new Error('Software provenance was wrongly accepted as provider readback.');
    expect(rejected.issues.some((issue) => issue.field === 'liveReadback.destination')).toBe(true);
  });

  it('creates only exact reviewed network resources, retains encrypted custody and returns actual network settings identity', async () => {
    const f = await fixture();
    const result = await f.execute();
    expect(result).toMatchObject({
      status: 'completed', evidencePayload: {
        kind: 'bootstrap-local.v1', scope: 'access-establishing-only', applicationProvisioning: 'not-performed',
        backendVerified: false, retainedAt: f.held.retainedAt, disposeAfter: f.held.disposeAfter
      }, outputs: { values: { 'runner.networkSettingsId': 'actual-network-id', 'runner.githubBusinessId': '7', 'runner.region': 'eastus' } }
    });
    expect(f.creates).toEqual(f.access.resources.map((resource) => resource.resourceId));
    expect(result.liveReadback).toHaveLength(12);
    expect(result.completedOperations).toHaveLength(12);
    expect(f.f.calls).toEqual([]);
    expect(f.storage.files.size).toBe(1);
    for (const value of f.storage.files.values()) {
      const sealed = Buffer.from(value).toString('utf8');
      expect(sealed).toContain('"ciphertext"');
      expect(sealed).not.toContain('private-bootstrap-custody');
      expect(sealed).not.toContain(f.held.retainedAt);
    }
    const retained = [...f.storage.files.values()].map((bytes) => Buffer.from(bytes));
    expect((await f.execute()).status).toBe('completed');
    expect(f.creates).toHaveLength(12);
    expect([...f.storage.files.values()].map((bytes) => Buffer.from(bytes))).toEqual(retained);
  });

  it('does not adopt existing matching names or tags as creation authority', async () => {
    const f = await fixture();
    const resource = f.access.resources[0]!;
    f.resources.set(resource.resourceId, { ...resource.body, id: resource.resourceId, type: resource.resourceType });
    expect(await f.execute()).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.creates).toEqual([]);
  });

  it('bounds pending polling and resumes the actual returned request without a duplicate create', async () => {
    const f = await fixture();
    f.pending(true);
    const pending = await f.execute();
    expect(pending).toMatchObject({ status: 'pending', operation: { provider: 'azure', operationId: f.providerIds[0] } });
    expect(f.polls()).toBe(3);
    expect(f.creates).toHaveLength(1);
    f.pending(false);
    expect((await f.execute()).status).toBe('completed');
    expect(f.creates).toHaveLength(12);
    expect(new Set(f.creates).size).toBe(12);
  });

  it('retains unknown dispatch custody and never blindly retries or adopts a matching readback', async () => {
    const f = await fixture();
    f.unknown();
    const first = await f.execute();
    expect(first.status).toBe('blocked');
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET_MUST_NOT_APPEAR');
    expect((await f.execute()).status).toBe('blocked');
    expect(f.creates).toHaveLength(1);
    expect(f.resources.size).toBe(1);
    expect(f.storage.files.size).toBe(1);
  });

  it('requires a fresh issued recovery approval for a known undispatched attempt', async () => {
    const f = await fixture();
    f.undispatched();
    expect((await f.execute()).status).toBe('blocked');
    expect(f.creates).toEqual([]);
    expect((await f.execute()).status).toBe('blocked');
    const recovery = await f.f.execution(planBootstrapLocal(f.f.planning()), { recovery: true });
    expect((await f.execute(recovery)).status).toBe('completed');
    expect(f.creates).toHaveLength(12);
    expect(f.storage.files.size).toBe(1);
  });

  it('requires private issued phase authority and a real lease before any provider or custody operation', async () => {
    const f = await fixture(false);
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(f.creates).toEqual([]);
    expect(f.storage.files.size).toBe(0);
    expect((await executeBootstrapLocal(f.input, { arm: f.arm, workspace: f.workspace })).status).toBe('blocked');
  });

  it('rechecks real time-bound approval before any provider or custody operation', async () => {
    const f = await fixture();
    const result = await withProjectMutationLock(f.f.projectRoot, (lease) => executeBootstrapLocal({
      ...f.input, lease, clock: () => new Date('2026-09-15T01:00:00.000Z')
    }, { arm: f.arm, workspace: f.workspace }));
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('not current');
    expect(f.creates).toEqual([]);
    expect(f.storage.files.size).toBe(0);
  });

  it('preserves earlier effects when a later independent readback changes', async () => {
    const f = await fixture();
    const original = f.arm.read;
    let reads = 0;
    f.arm.read = async (resource, binding) => {
      const result = await original(resource, binding);
      if (resource.resourceId === f.access.resources[0]!.resourceId && result.status === 200 && ++reads > 1) {
        (result.data as any).tags['liftoff-repository-id'] = 'foreign';
      }
      return result;
    };
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.completedOperations).toHaveLength(12);
    expect(result.evidencePayload).toBeUndefined();
    expect(f.creates).toHaveLength(12);
  });
});

describe('concrete ARM create-only transport qualification boundary', () => {
  it('refuses unqualified conditional-create semantics before tokens or PUTs', async () => {
    let calls = 0;
    const runner: CommandRunner = { async run() { calls++; throw new Error('Unapproved ambient credential use'); } };
    const port = createPrivateBootstrapArmPort(runner, process.cwd());
    const resource = (await import('../src/application/azure-activation/private-resource-plans.js')).planBootstrapArmResources(bootstrapAccess()).resources[0]!;
    await expect(port.create(resource, fixtureBinding, randomUUID())).rejects.toMatchObject({ code: 'conditional-create-unqualified', dispatched: false });
    expect(calls).toBe(0);
  });

  it('uses scoped credentials, reviewed API/body, conditional headers and actual provider request IDs after exact capability admission', async () => {
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
      tid: fixtureBinding.tenantId, oid: fixtureBinding.principalId, aud: 'https://management.azure.com/', exp: Math.floor(Date.now() / 1000) + 300
    })).toString('base64url')}.signature`;
    const runner: CommandRunner = { async run(command) { return { command, signal: null, timedOut: false, status: 0, stdout: JSON.stringify({
      accessToken: token, tokenType: 'Bearer', subscription: fixtureBinding.subscriptionId, tenant: fixtureBinding.tenantId
    }), stderr: '', displayCommand: 'fixture' }; } };
    const admitted: unknown[] = [], sent: unknown[] = [];
    const providerId = randomUUID(), clientId = randomUUID();
    const fetch = (async (url, init) => {
      sent.push({ url, method: init?.method, body: init?.body, ifNoneMatch: new Headers(init?.headers).get('If-None-Match'),
        clientId: new Headers(init?.headers).get('x-ms-client-request-id') });
      return new Response('{}', { status: 201, headers: { 'x-ms-request-id': providerId } });
    }) as typeof globalThis.fetch;
    const port = createPrivateBootstrapArmPort(runner, process.cwd(), {
      fetch, qualification: { async assertQualified(request) { admitted.push(request); } }
    });
    const resource = (await import('../src/application/azure-activation/private-resource-plans.js')).planBootstrapArmResources(bootstrapAccess()).resources[0]!;
    const response = await port.create(resource, fixtureBinding, clientId);
    expect(response.requestId).toBe(providerId);
    expect(response.requestId).not.toBe(clientId);
    expect(admitted).toEqual([{ resourceType: resource.resourceType, apiVersion: resource.apiVersion, binding: fixtureBinding, location: 'eastus', recipe: 'azure-arm-if-none-match/1' }]);
    expect(sent).toEqual([{
      url: `https://management.azure.com${resource.resourceId}?api-version=${resource.apiVersion}`, method: 'PUT',
      body: JSON.stringify(resource.body), ifNoneMatch: '*', clientId
    }]);
    expect(JSON.stringify(sent)).not.toContain(token);
  });
});
