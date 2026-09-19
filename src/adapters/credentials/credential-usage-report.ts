import { isUtf8 } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import { GitHubActivationError, object, positiveId } from '../github/activation-rest.js';
import { githubProviderRequestId } from './credential-checkpoints.js';
import { credentialApiPermissions, type GitHubCredentialTarget } from './github-enrollment.js';
import type { CredentialUsageChallenge } from './credential-usage-challenge.js';
import { credentialPermissionBoundary, observeCredentialPermissions, type CredentialProviderPermissionBoundary } from './credential-permissions.js';
import { extractWorkflowReport } from '../github/workflow-report-archive.js';

export const credentialReportFile = 'liftoff-credential-usage.json';
export const credentialUploadStep = 'Upload public credential report';
export const credentialUploadAction = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
export const credentialReportMaximumBytes = 32 * 1024;

export interface CredentialUsageReport {
  schemaVersion: 1;
  kind: 'github-credential-usage-report';
  challengeId: string;
  correlationId: string;
  run: {
    repository: string; repositoryId: number; ownerId: number; actorId: number;
    runId: number; runAttempt: number; sourceSha: string; ref: string; workflowRef: string; job: string;
  };
  credential: {
    kind: 'github-app'; appId: number; installationId: number;
    principal: { id: number; login: string }; reference: string;
    source: GitHubCredentialTarget['source']; custodyVersion: string | null; providerVersion: null;
  };
  selectedRepository: { id: number; fullName: string };
  permissions: typeof credentialApiPermissions;
  providerPermissionBoundary: CredentialProviderPermissionBoundary;
  probes: readonly { method: 'GET' | 'POST' | 'DELETE'; path: string; status: number; requestId: string }[];
  tokenExpiresAt: string;
  observedAt: string;
}

function fail(): never {
  throw new GitHubActivationError('credential-public-report', 'Credential artifact is malformed, sensitive, stale, or not bound to the exact stored principal, provider requests and reviewed run.');
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value, 'Public credential report');
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) fail();
  return result;
}

export function credentialArtifactName(challengeId: string, runAttempt: number): string {
  if (!/^[a-f0-9-]{36}$/u.test(challengeId) || runAttempt !== 1) fail();
  return `liftoff-credential-usage-${challengeId}-${runAttempt}`;
}

export function credentialProbeRequirements(target: GitHubCredentialTarget) {
  if (target.configuration.kind !== 'github-app') fail();
  const owner = target.repository.split('/')[0]!;
  return [
    { method: 'GET', path: '/app', status: 200 },
    { method: 'GET', path: `/app/installations/${target.configuration.installationId}`, status: 200 },
    { method: 'POST', path: `/app/installations/${target.configuration.installationId}/access_tokens`, status: 201 },
    { method: 'GET', path: '/installation/repositories?per_page=100&page=1', status: 200 },
    { method: 'GET', path: `/users/${target.principal.login}`, status: 200 },
    { method: 'GET', path: `/repos/${target.repository}`, status: 200 },
    { method: 'GET', path: `/orgs/${owner}/actions/hosted-runners?per_page=1&page=1`, status: 200 },
    { method: 'GET', path: `/orgs/${owner}/settings/network-configurations?per_page=1&page=1`, status: 200 },
    { method: 'DELETE', path: '/installation/token', status: 204 }
  ] as const;
}

export function validateCredentialUsageReport(
  bytes: Buffer, target: GitHubCredentialTarget, challenge: CredentialUsageChallenge,
  correlationId: string, now: Date, providerCompletedAt: string
): CredentialUsageReport {
  if (target.configuration.kind !== 'github-app' || !isUtf8(bytes) || !bytes.length || bytes.length > credentialReportMaximumBytes) fail();
  const text = bytes.toString('utf8');
  if (detectCredentialLeaks([{ source: 'imported-evidence', label: credentialReportFile, text }]).status !== 'clear') fail();
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { fail(); }
  // The producer writes one canonical JSON line; this also rejects duplicate keys and ambiguous numeric encodings.
  if (`${JSON.stringify(decoded)}\n` !== text) fail();
  const report = fields(decoded, [
    'schemaVersion', 'kind', 'challengeId', 'correlationId', 'run', 'credential', 'selectedRepository',
    'permissions', 'providerPermissionBoundary', 'probes', 'tokenExpiresAt', 'observedAt'
  ]);
  const run = fields(report.run, ['repository', 'repositoryId', 'ownerId', 'actorId', 'runId', 'runAttempt', 'sourceSha', 'ref', 'workflowRef', 'job']);
  const expectedRun = {
    repository: target.repository, repositoryId: target.repositoryId, ownerId: target.ownerId, actorId: challenge.actorId,
    runId: challenge.runId, runAttempt: challenge.runAttempt, sourceSha: challenge.sourceSha, ref: challenge.ref,
    workflowRef: `${target.repository}/.github/workflows/liftoff-credential-usage.yml@refs/heads/${challenge.ref}`, job: 'credential-use'
  };
  const credential = fields(report.credential, ['kind', 'appId', 'installationId', 'principal', 'reference', 'source', 'custodyVersion', 'providerVersion']);
  const principal = fields(credential.principal, ['id', 'login']);
  const selected = fields(report.selectedRepository, ['id', 'fullName']);
  const observedPermissions = observeCredentialPermissions('github-app', report.permissions);
  const permissionBoundary = credentialPermissionBoundary(observedPermissions);
  const expectedCredential = {
    kind: 'github-app', appId: target.configuration.appId, installationId: target.configuration.installationId,
    principal: target.principal, reference: target.protectedReference, source: target.source,
    custodyVersion: target.custodyVersion, providerVersion: null
  };
  const observed = typeof report.observedAt === 'string' ? Date.parse(report.observedAt) : NaN;
  const expires = typeof report.tokenExpiresAt === 'string' ? Date.parse(report.tokenExpiresAt) : NaN;
  if (report.schemaVersion !== 1 || report.kind !== 'github-credential-usage-report' ||
    report.challengeId !== challenge.challengeId || report.correlationId !== correlationId ||
    canonicalSha256(run) !== canonicalSha256(expectedRun) || canonicalSha256(credential) !== canonicalSha256(expectedCredential) ||
    canonicalSha256(report.permissions) !== canonicalSha256(credentialApiPermissions) ||
    canonicalSha256(observedPermissions) !== canonicalSha256(target.metadata.observedPermissions) ||
    canonicalSha256(report.providerPermissionBoundary) !== canonicalSha256(permissionBoundary) ||
    selected.id !== target.repositoryId || selected.fullName !== target.repository ||
    !Number.isFinite(observed) || !Number.isFinite(expires) || !Number.isFinite(Date.parse(providerCompletedAt)) ||
    observed < Date.parse(challenge.notBefore) || observed > now.getTime() || observed > Date.parse(providerCompletedAt) ||
    observed >= Date.parse(challenge.expiresAt) || expires <= observed || expires > observed + 3600_000 ||
    !Array.isArray(report.probes)) fail();
  const required = credentialProbeRequirements(target);
  if (report.probes.length !== required.length) fail();
  const probes = report.probes.map((value, index) => {
    const probe = fields(value, ['method', 'path', 'status', 'requestId']);
    const expected = required[index]!;
    if (probe.method !== expected.method || probe.path !== expected.path || probe.status !== expected.status) fail();
    return { ...expected, requestId: githubProviderRequestId(probe.requestId) };
  });
  return {
    schemaVersion: 1, kind: 'github-credential-usage-report', challengeId: challenge.challengeId, correlationId,
    run: expectedRun,
    credential: { ...expectedCredential, kind: 'github-app', principal: { id: positiveId(principal.id), login: String(principal.login) } },
    selectedRepository: { id: positiveId(selected.id), fullName: String(selected.fullName) },
    permissions: observedPermissions.permissions as typeof credentialApiPermissions, providerPermissionBoundary: permissionBoundary,
    probes, tokenExpiresAt: String(report.tokenExpiresAt), observedAt: String(report.observedAt)
  };
}

export function credentialReportCrc32(bytes: Uint8Array): number {
  return crc32(bytes);
}

/** One regular report entry, ZIP/ZIP64, stored or deflated; never extract an untrusted archive to disk. */
export function extractCredentialUsageReport(archive: Buffer): Buffer {
  return extractWorkflowReport(archive, { filename: credentialReportFile, maxBytes: credentialReportMaximumBytes });
}
