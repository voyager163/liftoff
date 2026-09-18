import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { privateLeaseChallenge, runPrivateLeaseProbe, type PrivateLeaseEffectResult, type PrivateLeaseWireResponse } from '../src/application/azure-activation/private-backend-lease.js';
import { PrivateBlobHttpFixture } from './helpers/private-state-http-fixture.js';
import { fixtureTime, privateTarget } from './helpers/private-activation-fixture.js';
import { stateBytes, syntheticStateValue } from './fixtures/state-migration/fakes.js';
import type { AzureStateResponse, StateExecutionContext } from '../src/domain/repair/stateful.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

function fixture() {
  const target = privateTarget();
  const blob = new PrivateBlobHttpFixture();
  blob.bytes = stateBytes([{ address: 'azurerm_virtual_network.fixture', id: target.virtualNetworkId }]);
  let now = fixtureTime.getTime();
  const challenge = privateLeaseChallenge({
    challengeId: randomUUID(), expectedEtag: '"0x1"', expectedVersion: '2026-09-15T00:00:00.0000001Z',
    activeUntil: new Date(now + 60_000).toISOString(), releaseUntil: new Date(now + 90_000).toISOString()
  }, canonicalSha256(target));
  const context: StateExecutionContext = {
    projectRoot: process.cwd(), projectId: target.backend.ownerId, hostId: target.hostId, principalId: target.binding.principalId,
    configurationDigest: canonicalSha256('configuration'), artifactDigest: canonicalSha256('artifact'), cliDigest: canonicalSha256('cli')
  };
  const records: PrivateLeaseEffectResult[] = [], privateIds: string[] = [];
  const faults = { loseAcquire: false, loseRenew: false, loseRelease: false, expireAfterAcquire: false,
    badRequestId: false, releaseRejected: false, replaceBeforeContend: false, rejectAcquire: false,
    expireCleanupAfterAcquire: false };
  const decode = (response: AzureStateResponse): PrivateLeaseWireResponse => ({
    status: response.status, requestId: faults.badRequestId ? null : response.headers['x-ms-request-id'] ?? null,
    etag: response.headers.etag ?? null, version: response.headers['x-ms-version-id'] ?? null,
    leaseId: response.headers['x-ms-lease-id'] ?? null, leaseStatus: response.headers['x-ms-lease-status'] ?? null,
    leaseState: response.headers['x-ms-lease-state'] ?? null, serverEncrypted: response.headers['x-ms-server-encrypted'] === 'true',
    errorCode: response.headers['x-ms-error-code'] ?? null, observedAt: new Date(now).toISOString()
  });
  const run = () => runPrivateLeaseProbe(challenge, {
    now: () => now,
    randomUuid: () => { const id = randomUUID(); privateIds.push(id); return id; },
    metadata: async (headers) => decode(await blob.send({ binding: target.backend, context, method: 'HEAD', target: 'blob', headers })),
    async lease(headers) {
      if (faults.rejectAcquire && headers['x-ms-client-request-id'] === challenge.clientRequestIds.acquire) {
        return { status: 409, requestId: randomUUID(), etag: challenge.expectedEtag, version: null,
          leaseId: null, leaseStatus: 'locked', leaseState: 'leased', serverEncrypted: true,
          errorCode: 'LeaseAlreadyPresent', observedAt: new Date(now).toISOString() };
      }
      if (faults.replaceBeforeContend && headers['x-ms-client-request-id'] === challenge.clientRequestIds.contend) blob.leaseId = null;
      if (faults.releaseRejected && headers['x-ms-lease-action'] === 'release') {
        return { status: 403, requestId: randomUUID(), etag: challenge.expectedEtag, version: null,
          leaseId: null, leaseStatus: 'locked', leaseState: 'leased', serverEncrypted: true,
          errorCode: 'AuthorizationPermissionMismatch', observedAt: new Date(now).toISOString() };
      }
      const response = await blob.send({ binding: target.backend, context, method: 'PUT', target: 'lease', headers,
        operationId: headers['x-ms-client-request-id'] });
      if (headers['x-ms-lease-action'] === 'acquire' && response.status === 201) {
        if (faults.expireAfterAcquire) now += 61_000;
        if (faults.expireCleanupAfterAcquire) now += 91_000;
        if (faults.loseAcquire) throw new Error('SYNTHETIC_SECRET_RESPONSE');
      }
      if (headers['x-ms-lease-action'] === 'renew' && faults.loseRenew) throw new Error('SYNTHETIC_SECRET_RESPONSE');
      if (headers['x-ms-lease-action'] === 'release' && faults.loseRelease) throw new Error('SYNTHETIC_SECRET_RESPONSE');
      return decode(response);
    },
    async record(record) { records.push(structuredClone(record)); }
  });
  return { target, blob, challenge, records, privateIds, faults, run, now: (value: number) => { now = value; } };
}

describe('fixed private backend lease protocol (local fake service, UNQUALIFIED)', () => {
  it('performs real exclusive acquire/conflicting-acquire/renew/release without changing or reading state bodies', async () => {
    const f = fixture();
    const original = Uint8Array.from(f.blob.bytes!);
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: 'verified', reason: null, leaseDurationSeconds: 60,
      effects: [
        { step: 'acquire', outcome: 'returned', status: 201 },
        { step: 'contend', outcome: 'returned', status: 409, errorCode: 'LeaseAlreadyPresent' },
        { step: 'renew', outcome: 'returned', status: 200 },
        { step: 'release', outcome: 'returned', status: 200 }
      ],
      metadata: [{ stage: 'before', leaseStatus: 'unlocked' }, { stage: 'held', leaseStatus: 'locked' }, { stage: 'after', leaseStatus: 'unlocked' }]
    });
    expect(Buffer.from(f.blob.bytes!)).toEqual(Buffer.from(original));
    expect(f.blob.leaseId).toBeNull();
    expect(f.blob.calls.every((call) => call.method === 'HEAD' || call.method === 'PUT' && call.target === 'lease')).toBe(true);
    expect(f.records).toHaveLength(4);
    for (const record of f.records) expect(record.requestId).not.toBe(record.clientRequestId);
    const publicText = JSON.stringify(result);
    for (const id of f.privateIds) expect(publicText).not.toContain(id);
    expect(publicText).not.toContain(syntheticStateValue);
    expect(publicText).not.toContain(stateDigest(original));
  });

  it('does not confuse an absent backend with acquired or conditional-create locking proof', async () => {
    const f = fixture();
    f.blob.bytes = null;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'backend-absent' });
    expect(result.effects.every((effect) => effect.outcome === 'not-attempted')).toBe(true);
    expect(f.blob.calls).toHaveLength(1);
    expect(f.blob.calls[0]!.method).toBe('HEAD');
    expect(f.privateIds).toEqual([]);
  });

  it('does not acquire or break a foreign lease', async () => {
    const f = fixture();
    const foreign = randomUUID();
    f.blob.leaseId = foreign;
    expect(await f.run()).toMatchObject({ outcome: 'blocked', reason: 'backend-already-leased' });
    expect(f.blob.leaseId).toBe(foreign);
    expect(f.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it.each(['loseAcquire', 'loseRenew', 'loseRelease'] as const)('retains %s uncertainty and never retries a lease action', async (fault) => {
    const f = fixture();
    f.faults[fault] = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(result.effects.some((effect) => effect.outcome === 'unknown')).toBe(true);
    expect(f.blob.calls.filter((call) => call.headers?.['x-ms-lease-action'] === 'renew').length).toBeLessThanOrEqual(1);
    expect(f.blob.calls.filter((call) => call.headers?.['x-ms-lease-action'] === 'release')).toHaveLength(fault === 'loseAcquire' ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_RESPONSE');
    if (fault === 'loseAcquire') expect(f.blob.leaseId).toBe(f.privateIds[0]);
    else expect(f.blob.leaseId).toBeNull();
  });

  it('does not release a merely proposed lease after the provider rejected its acquire', async () => {
    const f = fixture();
    f.faults.rejectAcquire = true;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'lease-acquire-not-confirmed' });
    expect(result.effects[0]).toMatchObject({ step: 'acquire', outcome: 'returned', status: 409 });
    expect(result.effects.slice(1).every((effect) => effect.outcome === 'not-attempted')).toBe(true);
    expect(f.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it('stops new active effects at expiry while using only the separately bounded release window', async () => {
    const f = fixture();
    f.faults.expireAfterAcquire = true;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'lease-authority-expired' });
    expect(f.blob.calls.filter((call) => call.target === 'lease').map((call) => call.headers?.['x-ms-lease-action'])).toEqual(['acquire', 'release']);
    expect(f.blob.leaseId).toBeNull();
  });

  it('retains the finite accepted lease without issuing cleanup after its separately approved deadline', async () => {
    const f = fixture();
    f.faults.expireCleanupAfterAcquire = true;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'lease-release-authority-expired' });
    expect(f.blob.calls.filter((call) => call.target === 'lease').map((call) => call.headers?.['x-ms-lease-action'])).toEqual(['acquire']);
    expect(result.effects.at(-1)).toMatchObject({ outcome: 'not-attempted' });
    expect(JSON.stringify(result)).not.toContain(f.privateIds[0]);
  });
  it('rejects changed exact metadata before any lease mutation', async () => {
    const f = fixture();
    f.blob.version++;
    expect(await f.run()).toMatchObject({ outcome: 'blocked', reason: 'backend-metadata-changed' });
    expect(f.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it('never treats a missing actual provider request ID as success', async () => {
    const f = fixture();
    f.faults.badRequestId = true;
    const result = await f.run();
    expect(result.outcome).toBe('blocked');
    expect(f.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
  });

  it('retains a rejected release as blocked without pretending the actual lease was freed', async () => {
    const f = fixture();
    f.faults.releaseRejected = true;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'lease-release-uncertain' });
    expect(result.effects.at(-1)).toMatchObject({ step: 'release', outcome: 'returned', status: 403 });
    expect(f.blob.leaseId).toBe(f.privateIds[0]);
    expect(result.metadata.some((entry) => entry.stage === 'after')).toBe(false);
  });

  it('cleans up only a positively accepted own contender if exclusivity unexpectedly fails', async () => {
    const f = fixture();
    f.faults.replaceBeforeContend = true;
    const result = await f.run();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'exclusive-lease-not-confirmed' });
    const release = f.blob.calls.find((call) => call.headers?.['x-ms-lease-action'] === 'release');
    expect(release?.headers?.['x-ms-lease-id']).toBe(f.privateIds[1]);
    expect(f.blob.leaseId).toBeNull();
    for (const id of f.privateIds) expect(JSON.stringify(result)).not.toContain(id);
  });
});
