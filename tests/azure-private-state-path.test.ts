import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAzureCliStorageTokenProvider, PinnedPrivateAzureStateTransport } from '../src/adapters/azure/private-state-path.js';
import { planExistingPrivatePath, executeExistingPrivatePathVerification } from '../src/application/azure-activation/producer-private-path.js';
import { privateStateContext } from '../src/application/azure-activation/private-custody.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { stateDigest, inspectStateBytes } from '../src/domain/repair/stateful-invariants.js';
import { stateBytes } from './fixtures/state-migration/fakes.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';
import { fixtureBinding, fixtureStorageAccount, fixtureTime, privateActivationFixture, privateTarget } from './helpers/private-activation-fixture.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture() {
  const target = privateTarget();
  const f = await privateActivationFixture('existing-private-path', { target });
  fixtures.push(f);
  const http = privateStateHttpFixture(target);
  http.blob.bytes = stateBytes([{ address: 'azurerm_virtual_network.private', id: target.virtualNetworkId }]);
  const input = await f.execution(planExistingPrivatePath(f.planning()));
  const context = privateStateContext(f.planning(), target.binding, target.hostId, target.backend.ownerId);
  return { f, http, input, context };
}

describe('existing private state path with concrete bounded metadata protocols', () => {
  it('independently checks private endpoint DNS/TLS, exact ownership and metadata without acquiring a lease or reading state', async () => {
    const { f, input, http } = await fixture();
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeExistingPrivatePathVerification({ ...input, lease }, { path: http.path }));
    expect(outcome).toMatchObject({
      status: 'completed', evidencePayload: {
        kind: 'existing-private-path.v1', locking: { capability: 'azure-blob-exclusive-lease', acquired: false },
        statePayloadRead: false, observation: { permissions: { leaseCapability: true, acquiredExclusiveLease: false } }
      }
    });
    expect(http.armCalls.every((call) => call.method === 'GET')).toBe(true);
    expect(http.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
    expect(http.networkCalls.length).toBeGreaterThan(0);
    expect(f.calls).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain('SYNTHETIC_STATE_VALUE_NEVER_PUBLIC');
    expect(JSON.stringify(outcome)).not.toContain(stateDigest(http.blob.bytes!));
    expect(outcome.liveReadback?.[0]?.resourceId).toBe(http.target.privateEndpointId);
  });

  it.each(['public-network', 'public-container', 'wrong-owner', 'versioning', 'wrong-nic', 'wrong-dns', 'denied-lease'])('blocks %s rather than substituting storage-account presence', async (fault) => {
    const { f, input, http } = await fixture();
    const account = http.rows.get(fixtureStorageAccount)! as any;
    if (fault === 'public-network') account.properties.publicNetworkAccess = 'Enabled';
    if (fault === 'wrong-owner') account.tags['liftoff-repository-id'] = '43';
    if (fault === 'versioning') (http.rows.get(`${fixtureStorageAccount}/blobServices/default`) as any).properties.isVersioningEnabled = false;
    if (fault === 'public-container') (http.rows.get(`${fixtureStorageAccount}/blobServices/default/containers/tfstate`) as any).properties.publicAccess = 'Blob';
    if (fault === 'wrong-nic') {
      const nic = [...http.rows.values()].find((entry) => String(entry.id).includes('/networkInterfaces/'))! as any;
      nic.properties.ipConfigurations[0].properties.privateIPAddress = '10.60.9.4';
    }
    if (fault === 'wrong-dns') (http.rows.get(http.target.privateDnsLinkId) as any).properties.virtualNetwork.id += '-foreign';
    if (fault === 'denied-lease') {
      const permission = [...http.rows.values()].find((entry) => Array.isArray(entry.value))! as any;
      permission.value[0].dataActions = ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'];
    }
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeExistingPrivatePathVerification({ ...input, lease }, { path: http.path }));
    expect(outcome.status).toBe('blocked');
    expect(outcome.evidencePayload).toBeUndefined();
    expect(http.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it('does not infer a path, accept extra authority flags or proceed without the real project lease', async () => {
    const { f, input, http } = await fixture();
    expect((await executeExistingPrivatePathVerification(input, { path: http.path })).status).toBe('blocked');
    expect(http.armCalls).toHaveLength(0);
    Object.assign(f.inspection.activationInputs!.phases['existing-private-path']!, { approved: true });
    expect(planExistingPrivatePath(f.planning()).operations).toEqual([]);
  });

  it('does not reuse cached access for another principal or host', async () => {
    const { http, context } = await fixture();
    await http.path.inspect(context);
    await expect(http.path.observe(http.target.backend, { ...context, principalId: randomUUID() }, false)).rejects.toMatchObject({ code: 'ownership-mismatch' });
    await expect(http.path.observe(http.target.backend, { ...context, hostId: 'foreign-host' }, false)).rejects.toMatchObject({ code: 'ownership-mismatch' });
  });
});

describe('private storage credential and mutation boundaries', () => {
  function token(claims: object) {
    return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  }

  it('obtains only the exact tenant/subscription/storage audience without placing credential values in argv or public output', async () => {
    const secret = token({ tid: fixtureBinding.tenantId, oid: fixtureBinding.principalId, aud: 'https://storage.azure.com/', exp: fixtureTime.getTime() / 1000 + 100 });
    const calls: unknown[] = [];
    const returned: CommandResult = { command: { executable: 'az', args: [] }, signal: null, timedOut: false, status: 0,
      stdout: JSON.stringify({ accessToken: secret, tokenType: 'Bearer', subscription: fixtureBinding.subscriptionId, tenant: fixtureBinding.tenantId }), stderr: 'SYNTHETIC_SECRET', displayCommand: 'fixture' };
    const runner: CommandRunner = { async run(command, options) { calls.push({ command, options }); returned.command = command; return returned; } };
    const provider = createAzureCliStorageTokenProvider(runner, process.cwd(), fixtureBinding, () => fixtureTime.getTime());
    const credential = await provider.getToken({ tenantId: fixtureBinding.tenantId, principalId: fixtureBinding.principalId,
      scope: 'https://storage.azure.com/.default', signal: AbortSignal.timeout(5000) });
    expect(credential.token).toBe(secret);
    expect(JSON.stringify(calls)).not.toContain(secret);
    expect(calls[0]).toMatchObject({ command: { executable: 'az', args: expect.arrayContaining([
      '--subscription', fixtureBinding.subscriptionId, '--tenant', fixtureBinding.tenantId, '--resource', 'https://storage.azure.com/'
    ]) }, options: { stream: false, timeoutMs: 15000, maxOutputBytes: 65536 } });
    expect(returned.stdout).toBe('');
    expect(returned.stderr).toBe('');
  });

  it.each(['tenant', 'principal', 'audience', 'expired'])('rejects a %s token mismatch with suppressed diagnostics', async (fault) => {
    const claims = { tid: fixtureBinding.tenantId, oid: fixtureBinding.principalId, aud: 'https://storage.azure.com/', exp: fixtureTime.getTime() / 1000 + 100 };
    if (fault === 'tenant') claims.tid = randomUUID();
    if (fault === 'principal') claims.oid = randomUUID();
    if (fault === 'audience') claims.aud = 'https://management.azure.com/';
    if (fault === 'expired') claims.exp = 1;
    const runner: CommandRunner = { async run(command) { return { command, signal: null, timedOut: false, status: 0, stdout: JSON.stringify({
      accessToken: token(claims), tokenType: 'Bearer', tenant: fixtureBinding.tenantId, subscription: fixtureBinding.subscriptionId
    }), stderr: '', displayCommand: 'fixture' }; } };
    await expect(createAzureCliStorageTokenProvider(runner, process.cwd(), fixtureBinding, () => fixtureTime.getTime()).getToken({
      tenantId: fixtureBinding.tenantId, principalId: fixtureBinding.principalId, scope: 'https://storage.azure.com/.default',
      signal: AbortSignal.timeout(5000)
    })).rejects.toMatchObject({ code: 'access-denied' });
  });

  it('will not call lease acquisition read-only or mutate without a durable pre-effect recorder', async () => {
    const { http, context } = await fixture();
    const metadata = await http.path.backend.metadata(context);
    await expect(http.path.backend.acquire(metadata, context, randomUUID())).rejects.toMatchObject({ code: 'approval-mismatch' });
    expect(http.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it('checkpoints acquire, renew, write and release before the genuine fake HTTP mutations, retaining returned provider IDs', async () => {
    const { context } = await fixture();
    const events: string[] = [];
    const effects = {
      async before(effect: { action: string }) { events.push(`before:${effect.action}`); return String(events.length); },
      async returned(_ref: string, response: { requestId: string }) { expect(response.requestId).toMatch(/^[a-f0-9-]{36}$/); events.push('returned'); },
      async uncertain() { events.push('unknown'); }
    };
    const http = privateStateHttpFixture(privateTarget(), effects);
    http.blob.bytes = stateBytes([{ address: 'azurerm_virtual_network.private', id: http.target.virtualNetworkId }]);
    const metadata = await http.path.backend.metadata(context);
    const expected = inspectStateBytes(metadata, http.blob.bytes).snapshot;
    const lease = await http.path.backend.acquire(metadata, context, randomUUID());
    try {
      await lease.assertHeld();
      await http.path.backend.writePrivate({ bytes: stateBytes([{ address: 'azurerm_virtual_network.private', id: http.target.virtualNetworkId }], expected.lineage!, expected.serial! + 1),
        expected, lease, context, operationId: randomUUID() });
    } finally { await lease.release(); }
    for (const name of ['acquire', 'renew', 'write', 'release']) expect(events).toContain(`before:${name}`);
    expect(events.at(-1)).toBe('returned');
    expect(events).not.toContain('unknown');
    expect(JSON.stringify(http.transport)).not.toContain('SYNTHETIC_BEARER');
  });

  it('records an unknown returned outcome without exposing provider diagnostics or retrying the write', async () => {
    const { context } = await fixture();
    const events: string[] = [];
    const http = privateStateHttpFixture(privateTarget(), {
      async before(effect) { events.push(effect.action); return 'prepared'; },
      async returned() { events.push('returned'); },
      async uncertain() { events.push('unknown'); }
    });
    http.blob.unknownWrite = true;
    const operationId = randomUUID();
    await expect(http.transport.request({
      binding: http.target.backend, context, method: 'PUT', target: 'blob', operationId,
      body: new Uint8Array([1]), headers: { 'if-none-match': '*', 'x-ms-meta-liftoff-operation': operationId, 'x-ms-blob-type': 'BlockBlob' }
    })).rejects.toMatchObject({ code: 'recovery-required' });
    expect(events).toEqual(['write', 'unknown']);
    expect(http.blob.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });
});
