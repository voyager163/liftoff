import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { exactObject, privateDigest } from './private-resource-plans.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';

export const privateLeaseSteps = ['acquire', 'contend', 'renew', 'release'] as const;
export type PrivateLeaseStep = typeof privateLeaseSteps[number];

export interface PrivateLeaseChallenge {
  schemaVersion: 1;
  challengeId: string;
  expectedEtag: string;
  expectedVersion: string;
  activeUntil: string;
  releaseUntil: string;
  intentDigest: string;
  clientRequestIds: Readonly<Record<PrivateLeaseStep, string>>;
}

export interface PrivateLeaseWireResponse {
  status: number;
  requestId: string | null;
  etag: string | null;
  version: string | null;
  leaseId: string | null;
  leaseStatus: string | null;
  leaseState: string | null;
  serverEncrypted: boolean;
  errorCode: string | null;
  observedAt: string;
}

export interface PrivateLeaseEffectResult {
  step: PrivateLeaseStep;
  action: 'acquire' | 'renew' | 'release';
  clientRequestId: string;
  outcome: 'returned' | 'unknown' | 'not-attempted';
  requestId: string | null;
  status: number | null;
  etag: string | null;
  errorCode: string | null;
  startedAt: string | null;
  observedAt: string | null;
}

export interface PrivateLeaseMetadataResult {
  stage: 'before' | 'held' | 'after';
  requestId: string;
  status: number;
  etag: string | null;
  version: string | null;
  leaseStatus: string | null;
  leaseState: string | null;
  serverEncrypted: boolean;
  observedAt: string;
}

export interface PrivateLeaseProbeResult {
  schemaVersion: 1;
  kind: 'private-backend-lease-probe';
  intentDigest: string;
  outcome: 'verified' | 'blocked' | 'unknown';
  reason: string | null;
  leaseDurationSeconds: 60;
  effects: readonly PrivateLeaseEffectResult[];
  metadata: readonly PrivateLeaseMetadataResult[];
}

export interface PrivateLeaseProbePorts {
  now(): number;
  randomUuid(): string;
  metadata(headers: Readonly<Record<string, string>>): Promise<PrivateLeaseWireResponse>;
  lease(headers: Readonly<Record<string, string>>): Promise<PrivateLeaseWireResponse>;
  record(effect: PrivateLeaseEffectResult): Promise<void>;
}

function requestId(seed: string, step: PrivateLeaseStep): string {
  const digest = canonicalSha256({ purpose: 'private-backend-lease-client-correlation/1', seed, step });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function privateLeaseChallenge(input: {
  challengeId: string; expectedEtag: string; expectedVersion: string; activeUntil: string; releaseUntil: string;
}, bindingDigest: string): PrivateLeaseChallenge {
  exactObject(input, ['challengeId', 'expectedEtag', 'expectedVersion', 'activeUntil', 'releaseUntil'], 'Exact private lease challenge');
  privateDigest(bindingDigest, 'Private lease binding');
  stateAssert(typeof input.challengeId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.challengeId) &&
    typeof input.expectedEtag === 'string' && /^"0x[a-f0-9]+"$/iu.test(input.expectedEtag) &&
    typeof input.expectedVersion === 'string' && input.expectedVersion.length > 0 && input.expectedVersion.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(input.expectedVersion) &&
    [input.activeUntil, input.releaseUntil].every((value) => typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) &&
    Date.parse(input.releaseUntil) > Date.parse(input.activeUntil) &&
    Date.parse(input.releaseUntil) - Date.parse(input.activeUntil) <= 120_000, 'invalid-binding');
  const intentDigest = canonicalSha256({ recipe: 'private-backend-lease/1', bindingDigest, ...input, leaseDurationSeconds: 60 });
  return {
    schemaVersion: 1, ...input, intentDigest,
    clientRequestIds: {
      acquire: requestId(intentDigest, 'acquire'), contend: requestId(intentDigest, 'contend'),
      renew: requestId(intentDigest, 'renew'), release: requestId(intentDigest, 'release')
    }
  };
}

// This same fixed protocol is embedded in the reviewed workflow; ports never receive state bodies.
export async function runPrivateLeaseProbe(
  challenge: PrivateLeaseChallenge, ports: PrivateLeaseProbePorts
): Promise<PrivateLeaseProbeResult> {
  const ids = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
  function must(value: unknown, code: string): asserts value {
    if (!value) throw new Error(code);
  }
  must(challenge.schemaVersion === 1 && ids.test(challenge.challengeId) &&
    /^"0x[a-f0-9]+"$/iu.test(challenge.expectedEtag) && typeof challenge.expectedVersion === 'string' &&
    challenge.expectedVersion.length > 0 && challenge.expectedVersion.length <= 128 &&
    /^[a-f0-9]{64}$/u.test(challenge.intentDigest) &&
    Object.values(challenge.clientRequestIds).length === 4 &&
    Object.values(challenge.clientRequestIds).every((id) => ids.test(id)) &&
    new Set(Object.values(challenge.clientRequestIds)).size === 4 &&
    Number.isFinite(Date.parse(challenge.activeUntil)) && Number.isFinite(Date.parse(challenge.releaseUntil)) &&
    Date.parse(challenge.releaseUntil) > Date.parse(challenge.activeUntil), 'lease-challenge-invalid');
  const steps = ['acquire', 'contend', 'renew', 'release'] as const;
  const effects: PrivateLeaseEffectResult[] = steps.map((step) => ({
    step, action: step === 'contend' ? 'acquire' : step, clientRequestId: challenge.clientRequestIds[step],
    outcome: 'not-attempted', requestId: null, status: null, etag: null, errorCode: null, startedAt: null, observedAt: null
  }));
  const metadata: PrivateLeaseMetadataResult[] = [];
  let leaseId = '';
  let acceptedLease = false;
  let verified = false;
  let reason: string | null = null;
  const deadline = (step: PrivateLeaseStep) => Date.parse(step === 'release' ? challenge.releaseUntil : challenge.activeUntil);
  const effect = async (step: PrivateLeaseStep, headers: Record<string, string>) => {
    must(ports.now() < deadline(step), 'lease-authority-expired');
    const record = effects[steps.indexOf(step)]!;
    must(record.outcome === 'not-attempted', 'lease-redispatch-forbidden');
    record.startedAt = new Date(ports.now()).toISOString();
    record.outcome = 'unknown';
    let response: PrivateLeaseWireResponse;
    try {
      response = await ports.lease({
        ...headers, 'x-ms-client-request-id': record.clientRequestId,
        'x-ms-lease-action': record.action, 'if-match': challenge.expectedEtag
      });
      must(typeof response.requestId === 'string' && ids.test(response.requestId) &&
        response.requestId !== record.clientRequestId, 'lease-provider-request-id-missing');
      must(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 &&
        Number.isFinite(Date.parse(response.observedAt)), 'lease-response-invalid');
      Object.assign(record, {
        outcome: 'returned', requestId: response.requestId, status: response.status, etag: response.etag,
        errorCode: [null, 'LeaseAlreadyPresent', 'BlobNotFound', 'ConditionNotMet',
          'LeaseIdMismatchWithLeaseOperation', 'AuthorizationPermissionMismatch'].includes(response.errorCode)
          ? response.errorCode : 'StorageError',
        observedAt: response.observedAt
      });
    } catch {
      await ports.record({ ...record });
      throw new Error('lease-dispatch-unknown');
    }
    await ports.record({ ...record });
    return response;
  };
  const head = async (stage: PrivateLeaseMetadataResult['stage'], held = false) => {
    must(ports.now() < Date.parse(challenge.releaseUntil), 'lease-readback-expired');
    const response = await ports.metadata({
      'if-match': challenge.expectedEtag, ...(held ? { 'x-ms-lease-id': leaseId } : {})
    });
    must(typeof response.requestId === 'string' && ids.test(response.requestId), 'lease-metadata-incomplete');
    metadata.push({
      stage, requestId: response.requestId, status: response.status, etag: response.etag, version: response.version,
      leaseStatus: response.leaseStatus, leaseState: response.leaseState, serverEncrypted: response.serverEncrypted,
      observedAt: response.observedAt
    });
    if (response.status === 404) throw new Error('backend-absent');
    must(response.status === 200 && response.etag === challenge.expectedEtag &&
      response.version === challenge.expectedVersion && response.serverEncrypted, 'backend-metadata-changed');
    return response;
  };
  try {
    const before = await head('before');
    must(before.leaseStatus === 'unlocked' && ['available', 'expired', 'broken'].includes(before.leaseState ?? ''), 'backend-already-leased');
    leaseId = ports.randomUuid();
    must(ids.test(leaseId) && !Object.values(challenge.clientRequestIds).includes(leaseId), 'private-lease-id-invalid');
    const acquired = await effect('acquire', { 'x-ms-lease-duration': '60', 'x-ms-proposed-lease-id': leaseId });
    acceptedLease = acquired.status === 201 && acquired.leaseId === leaseId;
    must(acceptedLease && acquired.etag === challenge.expectedEtag, 'lease-acquire-not-confirmed');
    const contender = ports.randomUuid();
    must(ids.test(contender) && contender !== leaseId && !Object.values(challenge.clientRequestIds).includes(contender), 'private-lease-id-invalid');
    const denied = await effect('contend', { 'x-ms-lease-duration': '60', 'x-ms-proposed-lease-id': contender });
    if (denied.status === 201 && denied.leaseId === contender) {
      leaseId = contender;
      acceptedLease = true;
    }
    must(denied.status === 409 && denied.errorCode === 'LeaseAlreadyPresent', 'exclusive-lease-not-confirmed');
    const renewed = await effect('renew', { 'x-ms-lease-id': leaseId });
    must(renewed.status === 200 && renewed.leaseId === leaseId && renewed.etag === challenge.expectedEtag, 'lease-renewal-not-confirmed');
    const held = await head('held', true);
    must(held.leaseStatus === 'locked' && held.leaseState === 'leased', 'owned-lease-not-held');
    verified = true;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const codes = [
      'backend-absent', 'backend-already-leased', 'backend-metadata-changed', 'lease-authority-expired',
      'lease-readback-expired', 'lease-acquire-not-confirmed', 'exclusive-lease-not-confirmed',
      'lease-renewal-not-confirmed', 'owned-lease-not-held', 'private-lease-id-invalid'
    ];
    reason = codes.includes(code) ? code : 'lease-observation-incomplete';
  } finally {
    if (acceptedLease && leaseId && ports.now() < Date.parse(challenge.releaseUntil)) {
      try {
        const released = await effect('release', { 'x-ms-lease-id': leaseId });
        must(released.status === 200 && released.etag === challenge.expectedEtag, 'lease-release-not-confirmed');
        const after = await head('after');
        must(after.leaseStatus === 'unlocked' && after.leaseState === 'available', 'lease-release-not-observed');
      } catch {
        verified = false;
        reason = 'lease-release-uncertain';
      }
    } else if (acceptedLease) {
      verified = false;
      reason = 'lease-release-authority-expired';
    }
    leaseId = '';
  }
  const unknown = effects.some((entry) => entry.outcome === 'unknown');
  return {
    schemaVersion: 1, kind: 'private-backend-lease-probe', intentDigest: challenge.intentDigest,
    outcome: verified && !reason && !unknown ? 'verified' : unknown ? 'unknown' : 'blocked',
    reason, leaseDurationSeconds: 60, effects, metadata
  };
}
