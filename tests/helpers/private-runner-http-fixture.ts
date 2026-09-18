import { createHash } from 'node:crypto';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient, type GitHubRequest, type GitHubResponse } from '../../src/adapters/github/activation-rest.js';
import {
  privateRunnerArtifactPrefix, privateRunnerJobName, renderPrivateRunnerWorkflow,
  type PrivateRunnerNetworkReport, type PrivateRunnerWorkflowRecipe, type PrivateRunnerWorkflowSource
} from '../../src/application/azure-activation/private-runner-workflow.js';
import { renderPrivateBackendWorkflow, type PrivateBackendWorkflowSource } from '../../src/application/azure-activation/private-backend-workflow.js';
import { fixtureGroup, fixtureTime, fixtureVnet, privateTarget } from './private-activation-fixture.js';
import { singleReportZip } from './private-report-zip-fixture.js';
import {
  privateApplicationWorkflowContent, privateApplicationWorkflowJob, type PrivateRunnerApplicationSource
} from '../../src/application/azure-activation/private-runner-application-sources.js';
import type { ExternalOperationState } from '../../src/domain/governance/activation/types.js';
import type { WorkflowRunBinding } from '../../src/adapters/github/production-checks.js';
export { singleReportBytesZip, singleReportZip } from './private-report-zip-fixture.js';

export function runnerSource(): PrivateRunnerWorkflowSource {
  const endpoint = privateTarget();
  const recipe: PrivateRunnerWorkflowRecipe = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: '.github/workflows/liftoff-bootstrap-private.yml',
    runnerGroupName: 'repo-private-group', runnerLabel: 'repo-private-linux',
    runnerSubnetId: `${fixtureVnet}/subnets/runners`, runnerSubnetPrefix: '10.60.1.0/24',
    uploadArtifactActionSha: 'b'.repeat(40),
    target: { hostname: 'liftofffixture.blob.core.windows.net', endpointAddress: endpoint.endpointAddress,
      privateEndpointId: endpoint.privateEndpointId, endpointSubnetId: endpoint.subnetId,
      virtualNetworkId: endpoint.virtualNetworkId, region: endpoint.region },
    egressHosts: ['github.com']
  };
  return { sourceSha: 'c'.repeat(40), workflowId: 15, workflowDigest: canonicalSha256(renderPrivateRunnerWorkflow(recipe)),
    ref: 'develop', actorId: 9, recipe };
}

export function privateRunnerHttpFixture(source = runnerSource(), backendSource?: PrivateBackendWorkflowSource, options: {
  beforePatch?: (request: GitHubRequest) => Promise<void>;
} = {}) {
  const calls: GitHubRequest[] = [];
  let requestCount = 0;
  let network: Record<string, unknown> | null = null, group: Record<string, unknown> | null = null, pool: Record<string, unknown> | null = null;
  let correlation = '00000000-1111-4222-8333-444444444444', configurationDigest = 'f'.repeat(64);
  let dispatched = false;
  let pendingGroup: Record<string, unknown> | null = null;
  let lastPatchRequestId: string | null = null;
  let currentRefSha = source.sourceSha;
  let changeApplicationJob: ((job: Record<string, unknown>, read: number) => void) | undefined;
  const applicationSources = new Map<number, PrivateRunnerApplicationSource>();
  const applicationContents = new Map<number, Map<string, string>>();
  const applicationRuns = new Map<number, { source: PrivateRunnerApplicationSource; sourceSha: string; runnerId: number }>();
  const applicationJobReads = new Map<number, number>();
  const state = {
    groupRepositoryIds: [42], wrongSubnet: false, sourceMoved: false, workflowPending: false,
    runnerPending: false, unknownCreate: false, wrongReportRunner: false, extraReportPayload: false,
    wrongJobGroup: false, runId: 4321, foreignNetworkAssignment: false,
    legacyDispatch: false, lostDispatch: false, malformedDispatch: false, hiddenRun: false, ambiguousRuns: false,
    backendSourceChanged: false, applicationSourceChanged: false, applicationExecutionSourceChanged: false, applicationUnregistered: false,
    assignmentLost: false, assignmentRejected: false, assignmentServerError: false, assignmentPending: false,
    assignmentReadOnly: false, assignmentForeignAfter: false, extraHostedRunner: false, selfHostedRunner: false,
    applicationWrongJobGroup: false, applicationWrongRunActor: false
  };
  const reply = (data: unknown, status = 200): GitHubResponse => ({
    status, data, headers: { 'x-github-request-id': `ABCD:1234:FFFF:${(++requestCount).toString(16).padStart(4, '0')}` }
  });
  const workflowContent = renderPrivateRunnerWorkflow(source.recipe);
  const job = () => ({
    id: 789, name: privateRunnerJobName, run_id: state.runId, head_sha: source.sourceSha,
    check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/899',
    status: 'completed', conclusion: 'success', runner_id: 900, runner_group_id: state.wrongJobGroup ? 99 : 55,
    runner_name: 'actual-ephemeral-runner', labels: ['self-hosted', source.recipe.runnerLabel],
    started_at: fixtureTime.toISOString(), completed_at: fixtureTime.toISOString(),
    steps: ['Private network observations', 'Retain payload-free report'].map((name, index) => ({
      name, number: index + 1, status: 'completed', conclusion: 'success'
    }))
  });
  const run = () => ({
    id: state.runId, run_attempt: 1, workflow_id: source.workflowId, path: source.recipe.workflowPath,
    head_sha: source.sourceSha, head_branch: source.ref, event: 'workflow_dispatch',
    actor: { id: source.actorId }, triggering_actor: { id: source.actorId }, check_suite_id: 777,
    repository: { id: source.recipe.repositoryId, full_name: source.recipe.repository },
    display_title: `liftoff-${correlation}`, created_at: fixtureTime.toISOString(),
    status: state.workflowPending ? 'in_progress' : 'completed', conclusion: state.workflowPending ? null : 'success'
  });
  const report = (): PrivateRunnerNetworkReport => ({
    schemaVersion: 1, kind: 'private-runner-reachability-report', correlationId: correlation, configurationDigest,
    repository: source.recipe.repository, repositoryId: source.recipe.repositoryId, sourceSha: source.sourceSha,
    workflowPath: source.recipe.workflowPath, runId: state.runId, runAttempt: 1,
    targetDigest: canonicalSha256(source.recipe.target),
    job: { id: 789, name: privateRunnerJobName, runnerId: state.wrongReportRunner ? 901 : 900,
      runnerGroupId: 55, runnerName: 'actual-ephemeral-runner', labels: ['self-hosted', source.recipe.runnerLabel] },
    network: {
      hostname: 'liftofffixture.blob.core.windows.net', cname: 'liftofffixture.privatelink.blob.core.windows.net',
      addresses: ['10.60.2.4'], connectedAddress: '10.60.2.4', tlsProtocol: 'TLSv1.3',
      route: { destination: '10.60.2.4', gateway: '10.60.1.1', device: 'eth0', source: '10.60.1.5' }
    },
    egress: [{ hostname: 'github.com', connectedAddress: '192.0.2.15', tlsProtocol: 'TLSv1.3',
      route: { destination: '192.0.2.15', gateway: '10.60.1.1', device: 'eth0', source: '10.60.1.5' } }],
    observedAt: fixtureTime.toISOString(),
    ...(state.extraReportPayload ? { state: 'SYNTHETIC_SECRET_MUST_NOT_APPEAR' } : {})
  });
  const artifact = () => {
    const archive = singleReportZip(report());
    return { id: 987, name: `${privateRunnerArtifactPrefix}${correlation}`, size_in_bytes: archive.length,
      expired: false, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
      workflow_run: { id: state.runId, repository_id: source.recipe.repositoryId, head_repository_id: source.recipe.repositoryId,
        head_sha: source.sourceSha, head_branch: source.ref } };
  };
  const client = new GitHubActivationClient({
    async request(request) {
      calls.push(structuredClone(request));
      const url = new URL(request.path, 'https://api.github.com');
      const p = url.pathname;
      if (request.method === 'PATCH') {
        if (p !== '/orgs/owner/actions/runner-groups/55' || !group) throw new Error('Unapproved fixture assignment target.');
        await options.beforePatch?.(request);
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'name,restricted_to_workflows,selected_workflows') throw new Error('Unexpected fixture control write.');
        const next = { ...group, ...body };
        const response = reply(state.assignmentRejected ? {} : next, state.assignmentRejected ? 403 : state.assignmentServerError ? 500 : 200);
        lastPatchRequestId = response.headers['x-github-request-id'] ?? null;
        if (!state.assignmentRejected) {
          if (state.assignmentPending) pendingGroup = next;
          else group = next;
          if (state.assignmentForeignAfter) state.groupRepositoryIds = [42, 43];
        }
        if (state.assignmentLost) throw new Error('Lost assignment reply SYNTHETIC_SECRET_MUST_NOT_APPEAR');
        return response;
      }
      if (request.method === 'POST') {
        const body = request.body as any;
        if (p === '/orgs/owner/settings/network-configurations') {
          network = { ...body, id: 'ncfg81', created_on: fixtureTime.toISOString() };
          if (state.unknownCreate) throw new Error('Provider response with SYNTHETIC_SECRET_MUST_NOT_APPEAR');
          return reply(network, 201);
        }
        if (p === '/orgs/owner/actions/runner-groups') {
          group = { ...body, id: 55, default: false, inherited: false };
          return reply(group, 201);
        }
        if (p === '/orgs/owner/actions/hosted-runners') {
          pool = { id: 300, name: body.name, runner_group_id: body.runner_group_id, image_details: body.image,
            machine_size_details: { id: body.size }, maximum_runners: body.maximum_runners,
            public_ip_enabled: false, platform: 'linux-x64', status: state.runnerPending ? 'Provisioning' : 'Ready' };
          return reply(pool, 201);
        }
        if (p === `/repos/owner/repo/actions/workflows/${source.workflowId}/dispatches`) {
          dispatched = true; correlation = body.inputs.liftoff_operation_id; configurationDigest = body.inputs.configuration_digest;
          if (state.lostDispatch) throw new Error('Lost dispatch reply SYNTHETIC_SECRET_MUST_NOT_APPEAR');
          if (state.legacyDispatch) return reply(null, 204);
          return reply({
            workflow_run_id: state.runId,
            run_url: `https://api.github.com/repos/${state.malformedDispatch ? 'owner/foreign' : 'owner/repo'}/actions/runs/${state.runId}`,
            html_url: `https://github.com/owner/repo/actions/runs/${state.runId}`
          }, 200);
        }
        throw new Error(`Unregistered fixture mutation ${p}`);
      }
      if (request.method !== 'GET') throw new Error('The private runner fixture never permits deletion or an unreviewed method.');
      if (p === '/repos/owner/repo') return reply({ id: 42, full_name: 'owner/repo', private: true,
        archived: false, disabled: false, owner: { id: 7 }, permissions: { admin: true } });
      if (p === '/orgs/owner') return reply({ id: 7, type: 'Organization' });
      if (p === '/user') return reply({ id: 9 });
      if (p === '/orgs/owner/settings/network-settings/settings81') return reply({
        id: 'settings81', subnet_id: state.wrongSubnet ? `${fixtureVnet}/subnets/foreign` : source.recipe.runnerSubnetId, region: 'eastus',
        ...(state.foreignNetworkAssignment ? { network_configuration_id: 'foreign-network' } : network ? { network_configuration_id: 'ncfg81' } : {})
      });
      if (p === '/orgs/owner/actions/hosted-runners/images/github-owned') return reply({
        total_count: 1, images: [{ id: 'ubuntu-24.04', source: 'github', platform: 'linux-x64' }]
      });
      if (p === '/orgs/owner/actions/hosted-runners/machine-sizes') return reply({ total_count: 1, machine_sizes: [{ id: '4-core' }] });
      for (const application of applicationSources.values()) {
        if (p === `/repos/owner/repo/actions/workflows/${application.workflowId}`) return reply({
          id: application.workflowId, path: application.recipe.workflowPath, state: state.applicationUnregistered ? 'disabled' : 'active'
        });
        if (p === `/repos/owner/repo/contents/${application.recipe.workflowPath}`) {
          const requestedSha = url.searchParams.get('ref');
          const stored = requestedSha ? applicationContents.get(application.workflowId)?.get(requestedSha) : undefined;
          if (stored === undefined) return reply(null, 404);
          const changed = state.applicationSourceChanged ||
            state.applicationExecutionSourceChanged && requestedSha !== application.sourceSha;
          const content = stored + (changed ? '\n# changed application source\n' : '');
          return reply({ type: 'file', path: application.recipe.workflowPath, encoding: 'base64',
            content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content),
            sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex') });
        }
      }
      if (p === `/repos/owner/repo/actions/workflows/${source.workflowId}`) return reply({ id: source.workflowId, path: source.recipe.workflowPath, state: 'active' });
      if (backendSource && p === `/repos/owner/repo/actions/workflows/${backendSource.workflowId}`) {
        return reply({ id: backendSource.workflowId, path: backendSource.recipe.workflowPath, state: 'active' });
      }
      if (backendSource && p === `/repos/owner/repo/contents/${backendSource.recipe.workflowPath}`) {
        const content = renderPrivateBackendWorkflow(backendSource.recipe) + (state.backendSourceChanged ? '\n# changed source\n' : '');
        return reply({ type: 'file', path: backendSource.recipe.workflowPath, encoding: 'base64',
          content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content),
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex') });
      }
      if (p === `/repos/owner/repo/contents/${source.recipe.workflowPath}`) {
        return reply({ type: 'file', path: source.recipe.workflowPath, encoding: 'base64',
          content: Buffer.from(workflowContent).toString('base64'), size: Buffer.byteLength(workflowContent),
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(workflowContent)}\0${workflowContent}`).digest('hex') });
      }
      if (p === '/repos/owner/repo/git/ref/heads/develop') return reply({ ref: 'refs/heads/develop', object: {
        sha: state.sourceMoved ? 'd'.repeat(40) : currentRefSha, type: 'commit'
      } });
      if (p === '/orgs/owner/settings/network-configurations') return reply({ total_count: network ? 1 : 0, network_configurations: network ? [network] : [] });
      if (p === '/orgs/owner/settings/network-configurations/ncfg81') return reply(network);
      if (p === '/orgs/owner/actions/runner-groups') return reply({ total_count: group ? 1 : 0, runner_groups: group ? [group] : [] });
      if (p === '/orgs/owner/actions/runner-groups/55') {
        if (pendingGroup && !state.assignmentPending) { group = pendingGroup; pendingGroup = null; }
        return reply(group ? { ...group, ...(state.assignmentReadOnly ? { workflow_restrictions_read_only: true } : {}) } : null);
      }
      if (p === '/orgs/owner/actions/runner-groups/55/repositories') return reply({
        total_count: state.groupRepositoryIds.length, repositories: state.groupRepositoryIds.map((id) => ({ id, full_name: id === 42 ? 'owner/repo' : 'owner/foreign' }))
      });
      if (p === '/orgs/owner/actions/hosted-runners') return reply({ total_count: pool ? 1 : 0, runners: pool ? [pool] : [] });
      if (p === '/orgs/owner/actions/hosted-runners/300') return reply(pool ? { ...pool, status: state.runnerPending ? 'Provisioning' : 'Ready' } : null);
      if (p === '/orgs/owner/actions/runner-groups/55/hosted-runners') {
        const runners = pool ? state.extraHostedRunner ? [pool, { ...pool, id: 301 }] : [pool] : [];
        return reply({ total_count: runners.length, runners });
      }
      if (p === '/orgs/owner/actions/runner-groups/55/runners') return reply({
        total_count: state.selfHostedRunner ? 1 : 0, runners: state.selfHostedRunner ? [{ id: 444, name: 'unrelated-runner' }] : []
      });
      for (const [runId, observed] of applicationRuns) {
        const application = observed.source, name = privateApplicationWorkflowJob(application);
        const run = {
          id: runId, run_attempt: 1, workflow_id: application.workflowId, path: application.recipe.workflowPath,
          head_sha: observed.sourceSha, head_branch: application.ref, event: 'workflow_dispatch',
          actor: { id: application.actorId }, triggering_actor: { id: state.applicationWrongRunActor ? 99 : application.actorId },
          repository: { id: 42, full_name: 'owner/repo' }, check_suite_id: runId + 100,
          created_at: fixtureTime.toISOString(), status: 'completed', conclusion: 'success'
        };
        if (p === `/repos/owner/repo/actions/runs/${runId}` || p === `/repos/owner/repo/actions/runs/${runId}/attempts/1`) return reply(run);
        if (p === `/repos/owner/repo/actions/runs/${runId}/attempts/1/jobs`) {
          const job: Record<string, unknown> = {
            id: runId + 1, name, run_id: runId, head_sha: observed.sourceSha,
            status: 'completed', conclusion: 'success', runner_id: observed.runnerId,
            runner_group_id: state.applicationWrongJobGroup ? 99 : 55, runner_name: 'actual-application-runner',
            runner_group_name: application.recipe.runner.group,
            labels: ['self-hosted', application.recipe.runner.label],
            started_at: fixtureTime.toISOString(), completed_at: fixtureTime.toISOString(),
            check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${runId + 200}`,
            steps: [{ name: 'Actual registered observation', number: 1, status: 'completed', conclusion: 'success' }]
          };
          const read = (applicationJobReads.get(runId) ?? 0) + 1;
          applicationJobReads.set(runId, read);
          changeApplicationJob?.(job, read);
          return reply({ total_count: 1, jobs: [job] });
        }
        if (p === `/repos/owner/repo/check-runs/${runId + 200}`) return reply({
          id: runId + 200, name, head_sha: observed.sourceSha, status: 'completed', conclusion: 'success',
          check_suite: { id: runId + 100 }, app: { id: 15368, slug: 'github-actions' }, output: {}
        });
      }
      if (p === `/repos/owner/repo/actions/workflows/${source.workflowId}/runs`) {
        const runs = !dispatched || state.hiddenRun ? [] : state.ambiguousRuns ? [run(), { ...run(), id: state.runId + 1 }] : [run()];
        return reply({ total_count: runs.length, workflow_runs: runs });
      }
      if (p === `/repos/owner/repo/actions/runs/${state.runId}/attempts/1`) return state.hiddenRun ? reply(null, 404) : reply(run());
      if (p === `/repos/owner/repo/actions/runs/${state.runId}`) return state.hiddenRun ? reply(null, 404) : reply(run());
      if (p === `/repos/owner/repo/actions/runs/${state.runId}/attempts/1/jobs`) return reply({ total_count: 1, jobs: [job()] });
      if (p === '/repos/owner/repo/check-runs/899') return reply({
        id: 899, name: privateRunnerJobName, head_sha: source.sourceSha, status: 'completed', conclusion: 'success',
        check_suite: { id: 777 }, app: { id: 15368, slug: 'github-actions' }, output: {}
      });
      if (p === `/repos/owner/repo/actions/runs/${state.runId}/artifacts`) {
        return reply({ total_count: 1, artifacts: [artifact()] });
      }
      if (p === '/repos/owner/repo/actions/artifacts/987') return reply(artifact());
      if (p === '/repos/owner/repo/actions/artifacts/987/zip' && request.binary) return reply(singleReportZip(report()));
      throw new Error(`Unexpected private runner fixture request ${p}`);
    }
  });
  return {
    client, calls, state, source, report, job, run, correlation: () => correlation, configurationDigest: () => configurationDigest,
    publishApplication(application: PrivateRunnerApplicationSource) {
      applicationSources.set(application.workflowId, structuredClone(application));
      applicationContents.set(application.workflowId, new Map([[application.sourceSha, privateApplicationWorkflowContent(application)]]));
    },
    group: () => group ? structuredClone(group) : null,
    changeGroup(change: (group: Record<string, unknown>) => void) {
      if (!group) throw new Error('No actual fixture group was created.');
      change(group);
    },
    lastPatchRequestId: () => lastPatchRequestId,
    setRefSha(value: string) { currentRefSha = value; },
    changeApplicationJob(callback: (job: Record<string, unknown>, read: number) => void) { changeApplicationJob = callback; },
    observedApplicationRun(workflowId: number, runnerId: number, executionSha?: string): {
      workflow: WorkflowRunBinding; operation: ExternalOperationState
    } {
      const application = applicationSources.get(workflowId);
      if (!application) throw new Error('Unpublished fixture application workflow.');
      const runId = 8000 + workflowId;
      const commitSha = executionSha ?? application.sourceSha;
      applicationRuns.set(runId, { source: application, sourceSha: commitSha, runnerId });
      applicationContents.get(workflowId)!.set(commitSha, privateApplicationWorkflowContent(application));
      applicationJobReads.set(runId, 0);
      currentRefSha = commitSha;
      return {
        workflow: {
          repository: application.repository, repositoryId: application.repositoryId, workflowId,
          workflowPath: application.recipe.workflowPath, workflowDigest: application.workflowDigest,
          sourceSha: commitSha, ...(commitSha !== application.sourceSha ? { producerSourceSha: application.sourceSha } : {}),
          ref: application.ref, actorId: application.actorId,
          event: 'workflow_dispatch', expectedJobs: [privateApplicationWorkflowJob(application)], runAttempt: 1
        },
        operation: {
          provider: 'github', actionId: application.kind === 'environment-runtime' ? 'github.checks.dev-proof' : 'github.staging-security.dispatch',
          operationId: String(runId), resourceId: `/repos/owner/repo/actions/runs/${runId}`,
          startedAt: fixtureTime.toISOString(), observedAt: fixtureTime.toISOString(),
          status: 'completed', planDigest: canonicalSha256('fixture existing application run')
        }
      };
    }
  };
}

export function bootstrapRunnerOutputs() {
  const target = privateTarget();
  return {
    values: {
      'runner.networkSettingsId': 'settings81',
      'runner.networkSettingsResourceId': `${fixtureGroup}/providers/GitHub.Network/networkSettings/repo-runner-network`,
      'runner.subnetId': `${fixtureVnet}/subnets/runners`, 'runner.subnetPrefix': '10.60.1.0/24',
      'runner.region': 'eastus', 'runner.githubBusinessId': '7'
    },
    resources: [
      { provider: 'azure' as const, resourceType: 'Microsoft.Network/privateEndpoints', resourceId: target.privateEndpointId },
      { provider: 'azure' as const, resourceType: 'Microsoft.Network/virtualNetworks', resourceId: target.virtualNetworkId },
      { provider: 'azure' as const, resourceType: 'Microsoft.Network/virtualNetworks/subnets', resourceId: target.subnetId }
    ]
  };
}
