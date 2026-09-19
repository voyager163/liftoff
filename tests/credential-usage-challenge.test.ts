import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialUsageActionId, credentialUsageJob, renderCredentialUsageWorkflow, verifyCredentialUsageChallenge
} from '../src/adapters/credentials/credential-usage-challenge.js';
import {
  credentialReportCrc32, credentialReportFile, extractCredentialUsageReport, validateCredentialUsageReport, credentialUploadAction
} from '../src/adapters/credentials/credential-usage-report.js';
import { credentialUsageDispatchPlan } from '../src/adapters/credentials/credential-usage-authority.js';
import { credentialApiPermissions } from '../src/adapters/credentials/github-enrollment.js';
import { observeCredentialPermissions } from '../src/adapters/credentials/credential-permissions.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { credentialFixture, credentialNow, fixtureExistingAppTarget } from './helpers/credential-fixture.js';
import { credentialZip, publicUsageReport, usageChallenge, usageCorrelation, usageOperation, usageProvider } from './helpers/credential-usage-fixture.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

describe('existing App public artifact proof', () => {
  it('independently reads the exact ZIP and provider-response report without rewriting or reading the operator secret', async () => {
    const f = usageProvider();
    const proof = await f.verify();
    expect(proof).toMatchObject({
      principal: { id: 71, login: 'fixture-app[bot]' }, runId: 82, runAttempt: 1, jobId: 83, checkRunId: 84,
      custodyVersion: null, providerSecretVersion: null, artifact: { id: 94 },
      report: { credential: { appId: 72, installationId: 73, source: 'existing-app-private-key' } }
    });
    expect(proof.report.probes).toHaveLength(9);
    expect(proof.report.permissions).toEqual({
      metadata: 'read', organization_administration: 'read', organization_network_configurations: 'read'
    });
    expect(proof.permissionBoundary.policy.admission).toBe('exact-provider-read-scope');
    expect(f.calls).toContain('GET /repos/owner/repo/actions/artifacts/94/zip');
    expect(f.calls.every((entry) => entry.startsWith('GET ') && !entry.includes('/actions/secrets'))).toBe(true);
  });

  it.each([
    ['actor', { id: 999 }], ['triggering_actor', { id: 999 }],
    ['repository', { id: 999, full_name: 'owner/repo' }], ['head_repository', { id: 999 }],
    ['head_sha', 'c'.repeat(40)], ['head_branch', 'main'], ['run_attempt', 2],
    ['workflow_id', 999], ['event', 'pull_request'], ['display_title', 'unrelated run'],
    ['created_at', '2026-09-14T00:00:00Z'], ['conclusion', 'skipped']
  ])('rejects substituted %s rather than taking a latest run', async (key, value) => {
    const f = usageProvider(); f.run[key as string] = value;
    await expect(f.verify()).rejects.toThrow();
  });

  it.each(['skipped', 'neutral', 'cancelled', 'failure'])('rejects %s proof/upload steps', async (conclusion) => {
    for (const which of ['probe', 'upload'] as const) {
      const f = usageProvider(); f[which].conclusion = conclusion;
      await expect(f.verify()).rejects.toThrow(/step/);
    }
  });

  it('rejects missing, duplicate, expired, replaced and integrity-invalid artifacts', async () => {
    for (const count of [0, 2]) {
      const f = usageProvider(); f.setArtifactCount(count);
      await expect(f.verify()).rejects.toThrow(/absent|ambiguous/);
    }
    const expired = usageProvider(); expired.artifact.expired = true;
    await expect(expired.verify()).rejects.toThrow(/expired/);
    const hash = usageProvider(); hash.artifact.digest = `sha256:${'a'.repeat(64)}`;
    await expect(hash.verify()).rejects.toThrow(/bytes/);
    const f = usageProvider();
    const proof = await f.verify();
    await expect(verifyCredentialUsageChallenge({
      client: f.client, target: f.target, challenge: usageChallenge, dispatchCorrelationId: usageCorrelation,
      operation: usageOperation, expectedArtifact: { ...proof.artifact, id: 99 }, now: credentialNow
    })).rejects.toThrow(/replaced/);
  });

  it.each(['principal', 'nonce', 'repository', 'permissions', 'request-id', 'run', 'extra', 'expiry'] as const)(
    'rejects semantically forged %s even with a correct provider ZIP digest', async (change) => {
      const f = usageProvider();
      const report = publicUsageReport();
      let body: unknown = report;
      if (change === 'principal') report.credential.principal.id = 999;
      if (change === 'nonce') report.correlationId = '11111111-2222-4333-8444-555555555555';
      if (change === 'repository') report.selectedRepository.id = 999;
      if (change === 'permissions') body = { ...report, permissions: { ...report.permissions, contents: 'write' } };
      if (change === 'request-id') report.probes = report.probes.map((probe, index) => index ? probe : { ...probe, requestId: '' });
      if (change === 'run') report.run.runId = 999;
      if (change === 'extra') body = { ...report, userApproved: true };
      if (change === 'expiry') report.tokenExpiresAt = '2030-01-01T00:00:00Z';
      f.setArchive(credentialZip(Buffer.from(`${JSON.stringify(body)}\n`), { zip64: true }));
      await expect(f.verify()).rejects.toThrow();
    }
  );

  it('requires exact pinned report-producing source, independent App principal, and the canonical action', async () => {
    const f = usageProvider();
    f.setSource(renderCredentialUsageWorkflow(f.target, usageChallenge.challengeId).content.replace(credentialUploadAction, 'actions/upload-artifact@main'));
    await expect(f.verify()).rejects.toThrow(/exact published/);
    const { runId: _runId, ...selection } = usageChallenge;
    const plan = credentialUsageDispatchPlan(fixtureExistingAppTarget, selection, {
      name: 'RUNNER_CONFIGURATION_READ_TOKEN', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z'
    });
    expect(plan.target.principal.id).not.toBe(selection.actorId);
    expect(plan.effects).toEqual(['stored-secret-use', 'installation-token-create', 'installation-token-revoke']);
    expect(plan.challenge).not.toHaveProperty('runId');
    expect(credentialUsageActionId).toBe('github.credential.usage-challenge');
  });

  it('keeps PAT identity/lifetime unresolved without requiring those facts for the existing App path', async () => {
    const f = usageProvider();
    f.target.configuration = { kind: 'fine-grained-pat', tokenId: 91, owner: 'fixture-user', appUnavailableReason: 'No approved App available.' };
    f.target.source = 'custody-envelope-v1';
    f.target.protectedReference = 'protected-input:11111111-2222-4333-8444-555555555555';
    f.target.custodyVersion = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    f.target.principal = { id: 92, login: 'fixture-user' };
    f.target.metadata = { ...f.target.metadata, createdAt: null, accessGrantedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-10-01T00:00:00Z', grantId: 93, appSlug: null };
    f.target.metadata.observedPermissions = observeCredentialPermissions('fine-grained-pat', {
      repository: { metadata: 'read' },
      organization: { organization_administration: 'read', organization_network_configurations: 'read' }, other: {}
    });
    f.target.metadata.permissionsDigest = canonicalSha256(f.target.metadata.observedPermissions.permissions);
    await expect(f.verify()).rejects.toThrow(/exact approved grant/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('bounded credential ZIP and strict JSON', () => {
  it.each([{ zip64: false }, { zip64: true }, { deflated: true }, { zip64: true, deflated: true }])('reads the single public report with %j', (options) => {
    const bytes = Buffer.from(`${JSON.stringify(publicUsageReport())}\n`);
    expect(extractCredentialUsageReport(credentialZip(bytes, options)).equals(bytes)).toBe(true);
    expect(credentialReportCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects traversal, extra bytes, bad CRC, oversized inflation and ambiguous JSON encodings', () => {
    const bytes = Buffer.from(`${JSON.stringify(publicUsageReport())}\n`);
    expect(() => extractCredentialUsageReport(credentialZip(bytes, { name: '../report.json' }))).toThrow();
    expect(() => extractCredentialUsageReport(Buffer.concat([credentialZip(bytes), Buffer.from('extra')]))).toThrow();
    const damaged = credentialZip(bytes); damaged[40] ^= 1;
    expect(() => extractCredentialUsageReport(damaged)).toThrow();
    expect(() => extractCredentialUsageReport(credentialZip(Buffer.alloc(100_000), { deflated: true }))).toThrow();
    expect(() => validateCredentialUsageReport(Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')),
      fixtureExistingAppTarget, usageChallenge, usageCorrelation, credentialNow, credentialNow.toISOString())).toThrow();
  });

  it('uses the shared strict extractor without mutating caller bytes and rejects trailing deflate data', () => {
    const bytes = Buffer.from(`${JSON.stringify(publicUsageReport())}\n`);
    const archive = credentialZip(bytes, { deflated: true });
    const original = Buffer.from(archive);
    const report = extractCredentialUsageReport(archive);
    report.fill(0);
    expect(archive.equals(original)).toBe(true);
    const packed = archive.readUInt32LE(18);
    const central = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28) + packed;
    const trailing = Buffer.from('trailing');
    const invalid = Buffer.concat([archive.subarray(0, central), trailing, archive.subarray(central)]);
    invalid.writeUInt32LE(packed + trailing.length, 18);
    invalid.writeUInt32LE(packed + trailing.length, central + trailing.length + 20);
    invalid.writeUInt32LE(central + trailing.length, invalid.length - 22 + 16);
    expect(() => extractCredentialUsageReport(invalid)).toThrow(/archive/);
  });
});

type ProbeMode = 'valid' | 'wrong-principal' | 'overscoped-token' | 'read-fails' | 'revoke-fails' | 'missing-secret' | 'missing-request-id' | 'wrong-actor' | 'rerun';
async function runSyntheticProbe(mode: ProbeMode) {
  const f = await credentialFixture(); fixtures.push(f);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateBytes = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const parsed = parse(renderCredentialUsageWorkflow(fixtureExistingAppTarget, usageChallenge.challengeId).content);
  const script = parsed.jobs[credentialUsageJob].steps[0].run as string;
  const fixtureTransport = `
import { verify as verifySignature } from 'node:crypto';
const testMode = ${JSON.stringify(mode)}, publicPem = ${JSON.stringify(publicPem)};
const OriginalDate = Date, fixed = OriginalDate.parse('2026-09-15T00:00:20Z');
globalThis.Date = class extends OriginalDate { constructor(value) { super(value === undefined ? fixed : value); } static now() { return fixed; } };
let requests = 0;
globalThis.fetch = async (url, init) => {
  const pathname = new URL(url).pathname;
  process.stdout.write(init.method + ' ' + pathname + '\\n');
  const headers = { 'x-github-request-id': 'ABCD:1234:' + (++requests).toString(16).padStart(4, '0') };
  if (pathname.startsWith('/app')) {
    const authorization = init.headers.Authorization.slice(7).split('.');
    if (authorization.length !== 3 || !verifySignature('RSA-SHA256', Buffer.from(authorization.slice(0, 2).join('.')),
      publicPem, Buffer.from(authorization[2], 'base64url'))) return new Response(null, { status: 401 });
  }
  if (init.method === 'DELETE') return new Response(null, { status: testMode === 'revoke-fails' ? 403 : 204, headers });
  let data;
  if (pathname === '/app') data = { id: 72, slug: 'fixture-app' };
  else if (pathname === '/app/installations/73') data = { id: 73, app_id: 72, account: { id: 43 },
    suspended_at: null, repository_selection: 'selected', permissions: ${JSON.stringify(credentialApiPermissions)} };
  else if (pathname === '/app/installations/73/access_tokens') {
    const requested = JSON.parse(init.body);
    if (JSON.stringify(requested.repository_ids) !== '[42]') return new Response(null, { status: 422 });
    data = { token: 'ghs_' + 'x'.repeat(48), expires_at: new Date(Date.now() + 3500000).toISOString(),
      permissions: { ...requested.permissions, ...(testMode === 'overscoped-token' ? { contents: 'write' } : {}) } };
  } else if (pathname === '/installation/repositories') data = { total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] };
  else if (pathname === '/users/fixture-app[bot]') data = { id: testMode === 'wrong-principal' ? 999 : 71, login: 'fixture-app[bot]', type: 'Bot' };
  else if (pathname === '/repos/owner/repo') data = { id: 42, full_name: 'owner/repo', owner: { id: 43 } };
  else if (pathname === '/orgs/owner/actions/hosted-runners') data = { total_count: 0, runners: [] };
  else if (pathname === '/orgs/owner/settings/network-configurations') {
    if (testMode === 'read-fails') return new Response(null, { status: 403 });
    if (testMode === 'missing-request-id') delete headers['x-github-request-id'];
    data = { total_count: 0, network_configurations: [] };
  } else throw new Error('Unregistered fixture endpoint; no real fetch is available.');
  return new Response(JSON.stringify(data), { status: init.method === 'POST' ? 201 : 200, headers });
};
`;
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module'], {
        cwd: f.projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          LIFTOFF_CHALLENGE: usageChallenge.challengeId, LIFTOFF_OPERATION_ID: usageCorrelation,
          ...(mode === 'missing-secret' ? { GITHUB_TOKEN: 'must-not-be-used' } : { LIFTOFF_CREDENTIAL: privateBytes.toString('utf8') }),
          GITHUB_REPOSITORY: 'owner/repo', LIFTOFF_REPOSITORY_ID: '42', LIFTOFF_OWNER_ID: '43', LIFTOFF_ACTOR_ID: mode === 'wrong-actor' ? '999' : '70',
          GITHUB_RUN_ID: '82', GITHUB_RUN_ATTEMPT: mode === 'rerun' ? '2' : '1', GITHUB_SHA: usageChallenge.sourceSha, GITHUB_REF_NAME: 'develop',
          LIFTOFF_WORKFLOW_REF: `owner/repo/${'.github/workflows/liftoff-credential-usage.yml'}@refs/heads/develop`, GITHUB_JOB: credentialUsageJob
        }
      });
      f.trackProcess(child);
      let stdout = '', stderr = '';
      let processFailed = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); if (stdout.length > 8192) child.kill('SIGKILL'); });
      child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); if (stderr.length > 8192) child.kill('SIGKILL'); });
      child.once('error', () => { processFailed = true; });
      child.once('close', (status) => {
        clearTimeout(timer);
        if (processFailed) reject(new Error('Synthetic probe process failed after confirmed close.'));
        else if (/(?:PRIVATE KEY|ghs_|eyJ)/u.test(stdout + stderr)) reject(new Error('Synthetic probe output withheld due to protected material.'));
        else resolve({ status, stdout, stderr });
      });
      child.stdin.end(fixtureTransport + script.split('\n').slice(1, -1).join('\n'));
    });
    return { ...result, reportPath: path.join(f.projectRoot, credentialReportFile) };
  } finally { privateBytes.fill(0); }
}

describe('actual local execution of the existing-App report recipe', () => {
  it('uses an existing raw App key, writes only the public artifact, and proves all required APIs and revocation', async () => {
    const result = await runSyntheticProbe('valid');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DELETE /installation/token');
    expect(result.stderr).toBe('');
    const report = validateCredentialUsageReport(await readFile(result.reportPath), fixtureExistingAppTarget,
      usageChallenge, usageCorrelation, credentialNow, credentialNow.toISOString());
    expect(report.credential.custodyVersion).toBeNull();
    expect(report.providerPermissionBoundary.policy.admission).toBe('exact-provider-read-scope');
    expect(report.probes).toHaveLength(9);
  });

  it.each(['wrong-principal', 'overscoped-token', 'read-fails', 'revoke-fails', 'missing-request-id'] as const)(
    'fails on %s, revokes only its ephemeral token and publishes no success artifact', async (mode) => {
      const result = await runSyntheticProbe(mode);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('DELETE /installation/token');
      expect(result.stderr).toBe('Stored credential proof, public report or ephemeral credential settlement failed. Details withheld.\n');
      await expect(readFile(result.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('has no GITHUB_TOKEN or ambient credential fallback', async () => {
    const result = await runSyntheticProbe('missing-secret');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    await expect(readFile(result.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['wrong-actor', 'rerun'] as const)('rejects %s before any credential API or token-issuance effect', async (mode) => {
    const result = await runSyntheticProbe(mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    await expect(readFile(result.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
