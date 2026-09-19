import { createHash, randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient, type GitHubRequest, type GitHubResponse } from '../../src/adapters/github/activation-rest.js';
import { PrivateBackendAuditClient, type PrivateBackendAuditBinding } from '../../src/adapters/azure/private-backend-audit.js';
import { azureStateUrl } from '../../src/adapters/state/azure-blob.js';
import {
  privateBackendArtifactPrefix, privateBackendJobName, privateBackendReportFilename, renderPrivateBackendWorkflow,
  type PrivateBackendRunReport, type PrivateBackendWorkflowSource
} from '../../src/application/azure-activation/private-backend-workflow.js';
import { privateLeaseChallenge, runPrivateLeaseProbe, type PrivateLeaseChallenge, type PrivateLeaseWireResponse } from '../../src/application/azure-activation/private-backend-lease.js';
import { PrivateBlobHttpFixture, privateStateHttpFixture } from './private-state-http-fixture.js';
import { fixtureBinding, fixtureGroup, fixtureTime, fixtureVnet, privateTarget } from './private-activation-fixture.js';
import { singleReportZip } from './private-runner-http-fixture.js';
import { stateBytes } from '../fixtures/state-migration/fakes.js';
import type { AzureStateRequest, AzureStateResponse, StateExecutionContext } from '../../src/domain/repair/stateful.js';
import type { CommandRunner } from '../../src/process-runner.js';

export function backendSource(): PrivateBackendWorkflowSource {
  const recipe = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: '.github/workflows/liftoff-bootstrap-backend.yml',
    runnerGroupName: 'repo-private-group', runnerLabel: 'repo-private-linux',
    runnerSubnetId: `${fixtureVnet}/subnets/runners`, runnerSubnetPrefix: '10.60.1.0/24',
    azureClientId: '12345678-1111-4222-8333-444444444444', uploadArtifactActionSha: 'b'.repeat(40),
    target: privateTarget()
  };
  return { sourceSha: 'c'.repeat(40), workflowId: 16, workflowDigest: canonicalSha256(renderPrivateBackendWorkflow(recipe)),
    ref: 'develop', actorId: 9, recipe };
}

export function backendAuditBinding(): PrivateBackendAuditBinding {
  return {
    workspaceResourceId: `${fixtureGroup}/providers/Microsoft.OperationalInsights/workspaces/private-audit`,
    workspaceId: '44444444-1111-4222-8333-888888888888', reader: fixtureBinding
  };
}

export function backendChallengeInput() {
  return {
    challengeId: randomUUID(), expectedEtag: '"0x1"', expectedVersion: '2026-09-15T00:00:00.0000001Z',
    activeUntil: '2026-09-15T00:03:00.000Z', releaseUntil: '2026-09-15T00:04:00.000Z'
  };
}

export function backendHttpFixture(
  source = backendSource(),
  options: { beforeLease?: (request: AzureStateRequest) => Promise<void>; now?: () => number } = {}
) {
  const target = source.recipe.target;
  const auditBinding = backendAuditBinding();
  const blob = new PrivateBlobHttpFixture();
  blob.bytes = stateBytes([{ address: 'azurerm_virtual_network.private', id: target.virtualNetworkId }]);
  const calls: GitHubRequest[] = [], logRows: unknown[][] = [], queries: string[] = [];
  const states = { lostDispatch: false, unknownAcquire: false, unknownRenew: false, unknownRelease: false,
    missingAudit: false, wrongAuditActor: false, wrongRunner: false, wrongActor: false, wrongSource: false,
    tamperReport: false, workflowPending: false, groupMissingSource: false, hiddenRun: false,
    ambiguousRuns: false, rejectDispatch: false };
  const context: StateExecutionContext = {
    projectRoot: process.cwd(), projectId: '42', hostId: target.hostId, principalId: target.binding.principalId,
    configurationDigest: canonicalSha256('configuration'), artifactDigest: canonicalSha256('artifact'), cliDigest: canonicalSha256('cli')
  };
  let correlation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let configurationDigest = canonicalSha256('configuration');
  let challenge: PrivateLeaseChallenge = privateLeaseChallenge(backendChallengeInput(), canonicalSha256({ source, audit: auditBinding }));
  let report: PrivateBackendRunReport | null = null;
  let count = 0;
  const runId = 9876;
  const accountId = `${fixtureGroup}/providers/Microsoft.Storage/storageAccounts/${target.backend.account}`;
  const expectedWorkflows = [
    'owner/repo/.github/workflows/liftoff-bootstrap-private.yml@refs/heads/develop',
    `owner/repo/${source.recipe.workflowPath}@refs/heads/develop`
  ];
  const response = (data: unknown, status = 200): GitHubResponse => ({
    status, data, headers: { 'x-github-request-id': `ABCD:1234:FFFF:${(++count).toString(16).padStart(4, '0')}` }
  });
  const decode = (value: AzureStateResponse): PrivateLeaseWireResponse => ({
    status: value.status, requestId: value.headers['x-ms-request-id'] ?? null, etag: value.headers.etag ?? null,
    version: value.headers['x-ms-version-id'] ?? null, leaseId: value.headers['x-ms-lease-id'] ?? null,
    leaseStatus: value.headers['x-ms-lease-status'] ?? null, leaseState: value.headers['x-ms-lease-state'] ?? null,
    serverEncrypted: value.headers['x-ms-server-encrypted'] === 'true', errorCode: value.headers['x-ms-error-code'] ?? null,
    observedAt: fixtureTime.toISOString()
  });
  const job = () => ({
    id: 7891, name: privateBackendJobName, run_id: runId, head_sha: source.sourceSha, status: 'completed',
    conclusion: 'success', runner_id: states.wrongRunner ? 991 : 990, runner_group_id: 55,
    runner_name: 'actual-backend-runner', labels: ['self-hosted', source.recipe.runnerLabel],
    check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/891',
    started_at: fixtureTime.toISOString(), completed_at: fixtureTime.toISOString(),
    steps: ['Private backend lease probe', 'Retain backend lease report'].map((name, index) => ({
      number: index + 1, name, status: 'completed', conclusion: 'success'
    }))
  });
  const run = () => ({
    id: runId, run_attempt: 1, workflow_id: source.workflowId, path: source.recipe.workflowPath,
    head_sha: states.wrongSource ? 'd'.repeat(40) : source.sourceSha, head_branch: source.ref,
    actor: { id: 9 }, triggering_actor: { id: states.wrongActor ? 10 : 9 },
    repository: { id: 42, full_name: 'owner/repo' }, event: 'workflow_dispatch',
    display_title: `liftoff-${correlation}`, created_at: fixtureTime.toISOString(), check_suite_id: 7771,
    status: states.workflowPending ? 'in_progress' : 'completed', conclusion: states.workflowPending ? null : 'success'
  });
  const executeProbe = async () => {
    const probe = await runPrivateLeaseProbe(challenge, {
      now: () => fixtureTime.getTime(), randomUuid: randomUUID,
      metadata: async (headers) => decode(await blob.send({ binding: target.backend, context, method: 'HEAD', target: 'blob', headers })),
      async lease(headers) {
        const request: AzureStateRequest = { binding: target.backend, context, method: 'PUT', target: 'lease', headers,
          operationId: headers['x-ms-client-request-id'] };
        await options.beforeLease?.(request);
        const wire = await blob.send(request);
        logRows.push([
          fixtureTime.toISOString(), headers['x-ms-client-request-id'],
          headers['x-ms-lease-action'] === 'acquire' ? 'AcquireBlobLease' : headers['x-ms-lease-action'] === 'renew' ? 'RenewBlobLease' : 'ReleaseBlobLease',
          String(wire.status), `${accountId}/blobServices/default`, target.binding.subscriptionId,
          target.binding.tenantId, target.binding.principalId, source.recipe.azureClientId, 'OAuth', 'HTTPS', 'TLS 1.3',
          azureStateUrl(target.backend, 'blob'),
          wire.headers.etag, '10.60.1.5:49152', `liftoff-private-lease/${challenge.intentDigest}/${runId}/1/${correlation}`,
          wire.headers['x-ms-request-id'], 0
        ]);
        if (states.unknownAcquire && wire.status === 201 && headers['x-ms-lease-action'] === 'acquire') throw new Error('SYNTHETIC_SECRET_RESPONSE');
        if (states.unknownRenew && headers['x-ms-lease-action'] === 'renew') throw new Error('SYNTHETIC_SECRET_RESPONSE');
        if (states.unknownRelease && headers['x-ms-lease-action'] === 'release') throw new Error('SYNTHETIC_SECRET_RESPONSE');
        return decode(wire);
      },
      async record() {}
    });
    report = {
      schemaVersion: 1, kind: 'private-backend-lease-run-report', repository: 'owner/repo', repositoryId: 42,
      workflowPath: source.recipe.workflowPath, sourceSha: source.sourceSha, runId, runAttempt: 1,
      correlationId: correlation, configurationDigest, targetDigest: canonicalSha256(target),
      principalId: target.binding.principalId, failure: null, observedAt: fixtureTime.toISOString(),
      job: { id: 7891, name: privateBackendJobName, runnerId: 990, runnerGroupId: 55, runnerName: 'actual-backend-runner',
        labels: ['self-hosted', source.recipe.runnerLabel] },
      network: { hostname: `${target.backend.account}.blob.core.windows.net`,
        cname: `${target.backend.account}.privatelink.blob.core.windows.net`, addresses: [target.endpointAddress],
        connectedAddress: target.endpointAddress, tlsProtocol: 'TLSv1.3',
        route: { destination: target.endpointAddress, gateway: '10.60.1.1', device: 'eth0', source: '10.60.1.5' } },
      probe
    };
  };
  const artifact = () => {
    if (!report) throw new Error('No actual fixture backend protocol ran.');
    const body = structuredClone(report);
    if (states.tamperReport) Object.assign(body, { leaseId: randomUUID() });
    const archive = singleReportZip(body, privateBackendReportFilename);
    return {
      id: 9912, name: `${privateBackendArtifactPrefix}${correlation}`, size_in_bytes: archive.length,
      expired: false, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
      workflow_run: { id: runId, repository_id: 42, head_repository_id: 42, head_sha: source.sourceSha, head_branch: source.ref },
      archive
    };
  };
  const content = renderPrivateBackendWorkflow(source.recipe);
  const client = new GitHubActivationClient({
    async request(request) {
      calls.push(structuredClone(request));
      const pathname = new URL(request.path, 'https://api.github.com').pathname;
      if (request.method === 'POST' && pathname === '/repos/owner/repo/actions/workflows/16/dispatches') {
        const body = request.body as { inputs: Record<string, string> };
        correlation = body.inputs.liftoff_operation_id!;
        configurationDigest = body.inputs.configuration_digest!;
        challenge = JSON.parse(body.inputs.lease_challenge!);
        if (states.rejectDispatch) return response({}, 403);
        await executeProbe();
        if (states.lostDispatch) throw new Error('SYNTHETIC_PRIVATE_DISPATCH_FAILURE');
        return response({ workflow_run_id: runId, run_url: `https://api.github.com/repos/owner/repo/actions/runs/${runId}`,
          html_url: `https://github.com/owner/repo/actions/runs/${runId}` });
      }
      if (request.method !== 'GET') throw new Error('Unapproved fixture mutation.');
      if (pathname === '/repos/owner/repo') return response({ id: 42, full_name: 'owner/repo' });
      if (pathname === '/user') return response({ id: 9 });
      if (pathname === '/repos/owner/repo/git/ref/heads/develop') return response({ ref: 'refs/heads/develop', object: { sha: source.sourceSha, type: 'commit' } });
      if (pathname === '/repos/owner/repo/actions/workflows/16') return response({ id: 16, path: source.recipe.workflowPath, state: 'active' });
      if (pathname === `/repos/owner/repo/contents/${source.recipe.workflowPath}`) return response({
        type: 'file', path: source.recipe.workflowPath, encoding: 'base64', size: Buffer.byteLength(content),
        sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex'), content: Buffer.from(content).toString('base64')
      });
      if (pathname === '/orgs/owner/actions/runner-groups/55') return response({
        id: 55, name: source.recipe.runnerGroupName, default: false, inherited: false, visibility: 'selected',
        allows_public_repositories: false, restricted_to_workflows: true, network_configuration_id: 'network81',
        selected_workflows: states.groupMissingSource ? expectedWorkflows.slice(0, 1) : expectedWorkflows
      });
      if (pathname === '/orgs/owner/actions/runner-groups/55/repositories') return response({ total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] });
      if (pathname === '/orgs/owner/settings/network-configurations/network81') return response({
        id: 'network81', compute_service: 'actions', network_settings_ids: ['settings81'], failover_network_enabled: false
      });
      if (pathname === '/orgs/owner/settings/network-settings/settings81') return response({
        id: 'settings81', subnet_id: source.recipe.runnerSubnetId, region: target.region
      });
      if (pathname === '/orgs/owner/actions/runner-groups/55/hosted-runners') return response({
        total_count: 1, runners: [{ id: 300, name: source.recipe.runnerLabel, runner_group_id: 55, status: 'Ready', public_ip_enabled: false }]
      });
      if (pathname === '/orgs/owner/actions/runner-groups/55/runners') return response({ total_count: 0, runners: [] });
      if (pathname === `/repos/owner/repo/actions/runs/${runId}` || pathname === `/repos/owner/repo/actions/runs/${runId}/attempts/1`) {
        return states.hiddenRun ? response({}, 404) : response(run());
      }
      if (pathname === `/repos/owner/repo/actions/runs/${runId}/attempts/1/jobs`) return response({ total_count: 1, jobs: [job()] });
      if (pathname === '/repos/owner/repo/actions/workflows/16/runs') {
        const runs = !report || states.hiddenRun ? [] : states.ambiguousRuns ? [run(), { ...run(), id: runId + 1 }] : [run()];
        return response({ total_count: runs.length, workflow_runs: runs });
      }
      if (pathname === '/repos/owner/repo/check-runs/891') return response({
        id: 891, name: privateBackendJobName, head_sha: source.sourceSha, status: 'completed', conclusion: 'success',
        check_suite: { id: 7771 }, app: { id: 15368, slug: 'github-actions' }, output: {}
      });
      if (pathname === `/repos/owner/repo/actions/runs/${runId}/artifacts`) {
        const { archive: _archive, ...metadata } = artifact();
        return response({ total_count: 1, artifacts: [metadata] });
      }
      if (pathname === '/repos/owner/repo/actions/artifacts/9912') {
        const { archive: _archive, ...metadata } = artifact();
        return response(metadata);
      }
      if (pathname === '/repos/owner/repo/actions/artifacts/9912/zip' && request.binary) return response(artifact().archive);
      throw new Error(`Unexpected bounded backend fixture endpoint ${pathname}`);
    }
  });
  const azure = privateStateHttpFixture(target);
  azure.rows.set(auditBinding.workspaceResourceId, { id: auditBinding.workspaceResourceId, properties: { customerId: auditBinding.workspaceId } });
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
    tid: auditBinding.reader.tenantId, oid: auditBinding.reader.principalId, aud: 'https://api.loganalytics.io', exp: fixtureTime.getTime() / 1000 + 600
  })).toString('base64url')}.signature`;
  const tokenCalls: unknown[] = [];
  const tokenRunner: CommandRunner = {
    async run(command, runOptions) {
      tokenCalls.push({ command, runOptions });
      return { command, status: 0, signal: null, timedOut: false, stdout: JSON.stringify({
        tokenType: 'Bearer', accessToken: token, tenant: auditBinding.reader.tenantId, subscription: auditBinding.reader.subscriptionId
      }), stderr: '', displayCommand: 'fixture private log token' };
    }
  };
  const audit = (authorize: () => Promise<void>) => new PrivateBackendAuditClient({
    runner: tokenRunner, projectRoot: process.cwd(), target, binding: auditBinding, arm: azure.arm,
    now: options.now ?? (() => fixtureTime.getTime()), authorize,
    fetch: (async (url, options) => {
      if (String(url) !== `https://api.loganalytics.azure.com/v1/workspaces/${auditBinding.workspaceId}/query`) throw new Error('Wrong audit endpoint');
      const request = JSON.parse(String(options?.body));
      queries.push(request.query);
      const names = ['TimeGenerated', 'ClientRequestId', 'OperationName', 'StatusCode', 'ResourceId', 'SubscriptionId',
        'RequesterTenantId', 'RequesterObjectId', 'RequesterAppId', 'AuthenticationType', 'Protocol', 'TlsVersion',
        'TargetUri', 'Etag', 'CallerIpAddress', 'UserAgentHeader', 'CorrelationId', 'OperationCount'];
      const rows = structuredClone(states.missingAudit ? logRows.slice(0, 3) : logRows);
      if (states.wrongAuditActor && rows[0]) rows[0][7] = randomUUID();
      return new Response(JSON.stringify({ tables: [{ name: 'PrimaryResult', columns: names.map((name) => ({ name, type: 'string' })), rows }] }), {
        status: 200, headers: { 'x-ms-request-id': randomUUID() }
      });
    }) as typeof globalThis.fetch
  });
  return {
    source, target, client, calls, states, blob, auditBinding, audit, azure, tokenCalls, token, queries, logRows,
    expectedWorkflows, runId, job, run, report: () => report, challenge: () => challenge, correlation: () => correlation,
    configurationDigest: () => configurationDigest, executeProbe
  };
}
