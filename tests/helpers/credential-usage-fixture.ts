import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { GitHubActivationClient, type GitHubActivationTransport } from '../../src/adapters/github/activation-rest.js';
import {
  credentialUsageActionId, credentialUsageJob, credentialUsageStep, credentialUsageWorkflowPath,
  renderCredentialUsageWorkflow, verifyCredentialUsageChallenge, type CredentialUsageChallenge
} from '../../src/adapters/credentials/credential-usage-challenge.js';
import {
  credentialArtifactName, credentialProbeRequirements, credentialReportCrc32, credentialReportFile, credentialUploadStep,
  type CredentialUsageReport
} from '../../src/adapters/credentials/credential-usage-report.js';
import { credentialApiPermissions } from '../../src/adapters/credentials/github-enrollment.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import type { ExternalOperationState } from '../../src/domain/governance/activation/types.js';
import { credentialNow, fixtureExistingAppTarget } from './credential-fixture.js';
import { credentialPermissionBoundary } from '../../src/adapters/credentials/credential-permissions.js';

export const usageChallenge: CredentialUsageChallenge = {
  kind: 'github-credential-usage.v1', challengeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  workflowId: 81, sourceSha: 'b'.repeat(40), ref: 'develop', actorId: 70, runId: 82, runAttempt: 1,
  notBefore: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T01:00:00.000Z'
};
export const usageCorrelation = '99999999-8888-4777-8666-555555555555';
export const usageOperation: ExternalOperationState = {
  provider: 'github', actionId: credentialUsageActionId, operationId: '82',
  resourceId: '/repos/owner/repo/actions/runs/82', startedAt: usageChallenge.notBefore,
  observedAt: credentialNow.toISOString(), status: 'completed', planDigest: canonicalSha256('synthetic saved plan')
};

export function publicUsageReport(): CredentialUsageReport {
  return {
    schemaVersion: 1, kind: 'github-credential-usage-report', challengeId: usageChallenge.challengeId, correlationId: usageCorrelation,
    run: { repository: 'owner/repo', repositoryId: 42, ownerId: 43, actorId: 70, runId: 82, runAttempt: 1,
      sourceSha: usageChallenge.sourceSha, ref: 'develop', workflowRef: `owner/repo/${credentialUsageWorkflowPath}@refs/heads/develop`, job: credentialUsageJob },
    credential: { kind: 'github-app', appId: 72, installationId: 73, principal: { id: 71, login: 'fixture-app[bot]' },
      reference: fixtureExistingAppTarget.protectedReference, source: 'existing-app-private-key', custodyVersion: null, providerVersion: null },
    selectedRepository: { id: 42, fullName: 'owner/repo' }, permissions: credentialApiPermissions,
    providerPermissionBoundary: credentialPermissionBoundary(fixtureExistingAppTarget.metadata.observedPermissions),
    probes: credentialProbeRequirements(fixtureExistingAppTarget).map((request, index) => ({ ...request, requestId: `ABCD:1234:${index.toString(16).padStart(4, '0')}` })),
    tokenExpiresAt: '2026-09-15T00:59:00.000Z', observedAt: '2026-09-15T00:00:20.000Z'
  };
}

export function credentialZip(bytes: Buffer, options: { zip64?: boolean; deflated?: boolean; name?: string } = {}): Buffer {
  const name = Buffer.from(options.name ?? credentialReportFile);
  const packed = options.deflated ? deflateRawSync(bytes) : bytes;
  const crc = credentialReportCrc32(bytes);
  const flags = options.zip64 ? 0x0808 : 0x0800;
  const method = options.deflated ? 8 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(options.zip64 ? 45 : 20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
  if (!options.zip64) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); }
  local.writeUInt16LE(name.length, 26);
  const descriptor = options.zip64 ? Buffer.alloc(24) : Buffer.alloc(0);
  if (options.zip64) {
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(BigInt(packed.length), 8); descriptor.writeBigUInt64LE(BigInt(bytes.length), 16);
  }
  const extra = options.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
  if (options.zip64) {
    extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(bytes.length), 4); extra.writeBigUInt64LE(BigInt(packed.length), 12); extra.writeBigUInt64LE(0n, 20);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x032d, 4); central.writeUInt16LE(options.zip64 ? 45 : 20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(options.zip64 ? 0xffffffff : packed.length, 20);
  central.writeUInt32LE(options.zip64 ? 0xffffffff : bytes.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt32LE(options.zip64 ? 0xffffffff : 0, 42);
  const centralStart = local.length + name.length + packed.length + descriptor.length;
  const centralSize = central.length + name.length + extra.length;
  const zip64 = options.zip64 ? Buffer.alloc(76) : Buffer.alloc(0);
  if (options.zip64) {
    zip64.writeUInt32LE(0x06064b50); zip64.writeBigUInt64LE(44n, 4); zip64.writeUInt16LE(45, 12); zip64.writeUInt16LE(45, 14);
    zip64.writeBigUInt64LE(1n, 24); zip64.writeBigUInt64LE(1n, 32);
    zip64.writeBigUInt64LE(BigInt(centralSize), 40); zip64.writeBigUInt64LE(BigInt(centralStart), 48);
    zip64.writeUInt32LE(0x07064b50, 56); zip64.writeBigUInt64LE(BigInt(centralStart + centralSize), 64); zip64.writeUInt32LE(1, 72);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(options.zip64 ? 0xffff : 1, 8); end.writeUInt16LE(options.zip64 ? 0xffff : 1, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : centralSize, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : centralStart, 16);
  return Buffer.concat([local, name, packed, descriptor, central, name, extra, zip64, end]);
}

export function usageProvider() {
  const target = structuredClone(fixtureExistingAppTarget);
  let content = renderCredentialUsageWorkflow(target, usageChallenge.challengeId).content;
  let archive = credentialZip(Buffer.from(`${JSON.stringify(publicUsageReport())}\n`), { zip64: true });
  const run: Record<string, unknown> = {
    id: 82, workflow_id: 81, run_attempt: 1, path: credentialUsageWorkflowPath, head_sha: usageChallenge.sourceSha,
    event: 'workflow_dispatch', head_branch: 'develop', actor: target.actor, triggering_actor: target.actor,
    repository: { id: 42, full_name: target.repository }, head_repository: { id: 42, full_name: target.repository },
    display_title: `liftoff-${usageCorrelation}`, created_at: '2026-09-15T00:00:01Z', check_suite_id: 85,
    updated_at: '2026-09-15T00:00:25Z', status: 'completed', conclusion: 'success'
  };
  const probe: Record<string, unknown> = { name: credentialUsageStep, number: 2, status: 'completed', conclusion: 'success' };
  const upload: Record<string, unknown> = { name: credentialUploadStep, number: 3, status: 'completed', conclusion: 'success' };
  const job: Record<string, unknown> = {
    id: 83, run_id: 82, run_attempt: 1, head_sha: usageChallenge.sourceSha, name: credentialUsageJob,
    check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/84',
    status: 'completed', conclusion: 'success', steps: [{ name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' }, probe, upload]
  };
  const artifact: Record<string, unknown> = {
    id: 94, name: credentialArtifactName(usageChallenge.challengeId, 1), expired: false,
    workflow_run: { id: 82, repository_id: 42, head_repository_id: 42, head_sha: usageChallenge.sourceSha, head_branch: 'develop' }
  };
  let artifactCount = 1;
  const calls: string[] = [];
  const transport: GitHubActivationTransport = {
    async request(request) {
      calls.push(`${request.method} ${request.path}`);
      if (request.method !== 'GET') throw new Error('Readback fixture does not permit provider mutation.');
      const pathname = request.path.split('?')[0];
      let data: unknown;
      if (request.path.startsWith('/repos/owner/repo/contents/')) {
        const bytes = Buffer.from(content);
        data = { path: credentialUsageWorkflowPath, type: 'file', encoding: 'base64', content: bytes.toString('base64'),
          size: bytes.length, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
      } else if (pathname === '/repos/owner/repo/actions/runs/82/attempts/1/jobs') data = { total_count: 1, jobs: [job] };
      else if (pathname === '/repos/owner/repo/actions/runs/82/attempts/1' || pathname === '/repos/owner/repo/actions/runs/82') data = run;
      else if (pathname === '/repos/owner/repo/check-runs/84') data = {
        id: 84, name: credentialUsageJob, head_sha: usageChallenge.sourceSha, status: 'completed', conclusion: job.conclusion,
        check_suite: { id: 85 }, app: { id: 86, slug: 'github-actions' }
      };
      else if (pathname === '/repos/owner/repo/actions/runs/82/artifacts') data = { total_count: artifactCount, artifacts: Array.from({ length: artifactCount }, () => artifact) };
      else if (pathname === '/repos/owner/repo/actions/artifacts/94') data = {
        size_in_bytes: archive.length, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`, ...artifact
      };
      else if (pathname === '/repos/owner/repo/actions/artifacts/94/zip' && request.binary) data = archive;
      else throw new Error('Unregistered readback fixture endpoint.');
      return { status: 200, headers: {}, data };
    }
  };
  const client = new GitHubActivationClient(transport);
  const verify = () => verifyCredentialUsageChallenge({
    client, target, challenge: usageChallenge, dispatchCorrelationId: usageCorrelation, operation: usageOperation, now: credentialNow
  });
  return {
    target, run, probe, upload, job, artifact, calls, client, verify, transport,
    setSource: (source: string) => { content = source; },
    setArchive: (bytes: Buffer) => { archive = bytes; },
    setArtifactCount: (count: number) => { artifactCount = count; }
  };
}
