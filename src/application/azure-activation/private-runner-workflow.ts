import { stringify } from 'yaml';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  expectStatus, GitHubActivationError, githubRef, githubRepository, object, positiveId, type GitHubActivationClient
} from '../../adapters/github/activation-rest.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import { readBoundWorkflowArtifact, readBoundWorkflowRun, type WorkflowRunBinding } from '../../adapters/github/production-checks.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { exactObject, privateDigest, privateIpv4, privateName } from './private-resource-plans.js';
import { azureArmUrl } from '../../adapters/azure/activation-rest.js';
import { privateRunnerReportFilename, readPrivateReportArchive } from './private-report-archive.js';
export { extractPrivateReportArchive, privateRunnerReportFilename, readPrivateReportArchive } from './private-report-archive.js';

export interface PrivateRunnerReachabilityTarget {
  hostname: string;
  endpointAddress: string;
  privateEndpointId: string;
  endpointSubnetId: string;
  virtualNetworkId: string;
  region: string;
}

export interface PrivateRunnerWorkflowRecipe {
  repository: string;
  repositoryId: number;
  workflowPath: string;
  runnerGroupName: string;
  runnerLabel: string;
  runnerSubnetId: string;
  runnerSubnetPrefix: string;
  uploadArtifactActionSha: string;
  target: PrivateRunnerReachabilityTarget;
  egressHosts: readonly string[];
}

export interface PrivateRunnerWorkflowSource {
  sourceSha: string;
  workflowId: number;
  workflowDigest: string;
  ref: string;
  actorId: number;
  recipe: PrivateRunnerWorkflowRecipe;
}

export interface PrivateRunnerRunIdentity {
  runId: number;
  runAttempt: number;
  correlationId: string;
  configurationDigest: string;
}

export interface PrivateRunnerNetworkReport {
  schemaVersion: 1;
  kind: 'private-runner-reachability-report';
  correlationId: string;
  configurationDigest: string;
  repository: string;
  repositoryId: number;
  sourceSha: string;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  targetDigest: string;
  job: { id: number; name: string; runnerId: number; runnerGroupId: number; runnerName: string; labels: readonly string[] };
  network: {
    hostname: string; cname: string; addresses: readonly string[]; connectedAddress: string; tlsProtocol: string;
    route: { destination: string; gateway: string | null; device: string; source: string };
  };
  egress: readonly {
    hostname: string; connectedAddress: string; tlsProtocol: string;
    route: { destination: string; gateway: string | null; device: string; source: string };
  }[];
  observedAt: string;
}

export const privateRunnerJobName = 'Liftoff private network observation';
export const privateRunnerArtifactPrefix = 'liftoff-private-path-';

const probeScript = String.raw`import { Resolver } from 'node:dns/promises';
import { connect } from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const run = promisify(execFile);
const expected = JSON.parse(process.env.LIFTOFF_PRIVATE_TARGET);
const require = (ok) => { if (!ok) throw new Error('Private network verification failed; diagnostics withheld.'); };
const probeTls = async (host, address) => new Promise((resolve, reject) => {
  const socket = connect({host:address, servername:host, port:443,
    rejectUnauthorized:true, minVersion:'TLSv1.2', timeout:15000});
  socket.once('secureConnect', () => {
    const tlsProtocol = socket.getProtocol(), connectedAddress = socket.remoteAddress;
    if (!socket.authorized || connectedAddress !== address || !['TLSv1.2','TLSv1.3'].includes(tlsProtocol)) {
      socket.destroy();
      reject(new Error('Private TLS observation failed.'));
      return;
    }
    resolve({tlsProtocol,connectedAddress});
    socket.destroy();
  });
  socket.once('timeout', () => socket.destroy(new Error('Bounded private observation timed out.')));
  socket.once('error', () => reject(new Error('Private TLS observation failed.')));
});
const route = async (address) => {
  const result = await run('ip', ['-j', '-4', 'route', 'get', address], {timeout:10000,maxBuffer:65536,encoding:'utf8'});
  const rows = JSON.parse(result.stdout);
  require(rows.length === 1 && rows[0].dst === address && typeof rows[0].dev === 'string' && typeof rows[0].prefsrc === 'string');
  return {destination:address,gateway:rows[0].gateway ?? null,device:rows[0].dev,source:rows[0].prefsrc};
};
try {
  const resolver = new Resolver({timeout:15000,tries:1});
  const host = expected.hostname;
  const cname = host.replace('.blob.','.privatelink.blob.');
  const aliases = await resolver.resolveCname(host), addresses = await resolver.resolve4(host);
  require(aliases.length === 1 && aliases[0] === cname && addresses.length === 1 && addresses[0] === expected.endpointAddress);
  const endpoint = await probeTls(host,addresses[0]);
  const egress = [];
  for (const hostname of JSON.parse(process.env.LIFTOFF_EGRESS_HOSTS)) {
    const resolved = await resolver.resolve4(hostname);
    require(resolved.length > 0);
    const observed = await probeTls(hostname,resolved[0]);
    egress.push({hostname,connectedAddress:observed.connectedAddress,tlsProtocol:observed.tlsProtocol,route:await route(resolved[0])});
  }
  const repo = process.env.GITHUB_REPOSITORY, runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const jobsResponse = await fetch('https://api.github.com/repos/' + repo + '/actions/runs/' + runId + '/attempts/' + runAttempt + '/jobs?per_page=100&page=1',
    {headers:{authorization:'Bearer ' + process.env.GH_TOKEN,accept:'application/vnd.github+json','x-github-api-version':'2026-03-10'},
      redirect:'error',signal:AbortSignal.timeout(15000)});
  require(jobsResponse.status === 200);
  let jobsSize = 0;
  const jobsChunks = [];
  for await (const bytes of jobsResponse.body) {
    jobsSize += bytes.length;
    require(jobsSize <= 262144);
    jobsChunks.push(bytes);
  }
  const jobs = JSON.parse(Buffer.concat(jobsChunks).toString('utf8'));
  require(jobs.total_count === 1 && jobs.jobs.length === 1);
  const job = jobs.jobs[0];
  require(job.name === 'Liftoff private network observation' && job.run_id === runId && job.runner_id > 0 && job.runner_group_id > 0);
  const report = {schemaVersion:1,kind:'private-runner-reachability-report',
    correlationId:process.env.LIFTOFF_CORRELATION_ID,configurationDigest:process.env.LIFTOFF_CONFIGURATION_DIGEST,
    repository:repo,repositoryId:Number(process.env.GITHUB_REPOSITORY_ID),sourceSha:process.env.GITHUB_SHA,
    workflowPath:process.env.LIFTOFF_WORKFLOW_PATH,runId,runAttempt,targetDigest:process.env.LIFTOFF_TARGET_DIGEST,
    job:{id:job.id,name:job.name,runnerId:job.runner_id,runnerGroupId:job.runner_group_id,runnerName:job.runner_name,labels:job.labels},
    network:{hostname:host,cname,addresses,connectedAddress:endpoint.connectedAddress,tlsProtocol:endpoint.tlsProtocol,route:await route(addresses[0])},
    egress,
    observedAt:new Date().toISOString()};
  await writeFile('private-path-report.json',JSON.stringify(report),{flag:'wx',mode:0o600});
} catch {
  process.stderr.write('Private network verification failed; state and credential diagnostics withheld.\n');
  process.exitCode = 1;
}
`;

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('private-runner-proof', message);
}

function host(value: unknown): string {
  require(typeof value === 'string' && value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(value) &&
    !value.includes('..') && !value.endsWith('.local') && !value.endsWith('.internal'),
  'Runner egress proof needs exact public DNS names, not URLs, wildcard domains or internal metadata targets.');
  return value;
}

export function validatePrivateRunnerRecipe(recipe: PrivateRunnerWorkflowRecipe): PrivateRunnerWorkflowRecipe {
  exactObject(recipe, ['repository', 'repositoryId', 'workflowPath', 'runnerGroupName', 'runnerLabel', 'runnerSubnetId', 'runnerSubnetPrefix',
    'uploadArtifactActionSha', 'target', 'egressHosts'], 'Private runner reachability recipe');
  githubRepository(recipe.repository);
  positiveId(recipe.repositoryId);
  privateName(recipe.runnerGroupName, 'Runner group');
  privateName(recipe.runnerLabel, 'Runner label');
  sourceSha(recipe.uploadArtifactActionSha);
  exactObject(recipe.target, ['hostname', 'endpointAddress', 'privateEndpointId', 'endpointSubnetId', 'virtualNetworkId', 'region'], 'Private runner reachability target');
  require(typeof recipe.target.hostname === 'string' && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(recipe.target.hostname) &&
    typeof recipe.target.region === 'string' && /^[a-z][a-z0-9]{1,39}$/u.test(recipe.target.region),
  'Reachability needs an exact endpoint hostname and region, not backend credentials or state paths.');
  const ip = privateIpv4(recipe.target.endpointAddress);
  require(ip >= 0x0a000000 && ip <= 0x0affffff || ip >= 0xac100000 && ip <= 0xac1fffff ||
    ip >= 0xc0a80000 && ip <= 0xc0a8ffff, 'Reachability requires the exact private endpoint address.');
  const subscription = /^\/subscriptions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\//iu.exec(recipe.target.privateEndpointId)?.[1];
  require(subscription && subscription !== '00000000-0000-0000-0000-000000000000', 'Reachability requires the exact declared network resource scope.');
  for (const resourceId of [recipe.target.privateEndpointId, recipe.target.endpointSubnetId, recipe.target.virtualNetworkId]) {
    azureArmUrl(resourceId, '2024-05-01', subscription);
  }
  require(/\/providers\/Microsoft\.Network\/privateEndpoints\/[^/]+$/u.test(recipe.target.privateEndpointId) &&
    /\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+$/u.test(recipe.target.virtualNetworkId) &&
    /\/subnets\/[^/]+$/u.test(recipe.target.endpointSubnetId),
  'Reachability binds explicit private endpoint and network resource IDs, not arbitrary ARM targets.');
  require(recipe.runnerSubnetId.startsWith(`${recipe.target.virtualNetworkId}/subnets/`) &&
    !recipe.runnerSubnetId.slice(recipe.target.virtualNetworkId.length + 9).includes('/') &&
    recipe.target.endpointSubnetId.startsWith(`${recipe.target.virtualNetworkId}/subnets/`) &&
    recipe.runnerSubnetId !== recipe.target.endpointSubnetId &&
    typeof recipe.runnerSubnetPrefix === 'string' && /^(\d{1,3}\.){3}\d{1,3}\/(?:[89]|1\d|2[0-7])$/u.test(recipe.runnerSubnetPrefix),
  'The workflow must bind the exact dedicated runner subnet, distinct from the private endpoint subnet.');
  privateIpv4(recipe.runnerSubnetPrefix.split('/')[0]);
  require(/^\.github\/workflows\/liftoff-bootstrap-[A-Za-z0-9_-]+\.yml$/u.test(recipe.workflowPath) &&
    Array.isArray(recipe.egressHosts) && recipe.egressHosts.length > 0 && recipe.egressHosts.length <= 16 &&
    new Set(recipe.egressHosts).size === recipe.egressHosts.length, 'Private runner source must bind its actual repository, registered workflow and bounded exact egress targets.');
  recipe.egressHosts.forEach(host);
  return structuredClone(recipe);
}

export function renderPrivateRunnerWorkflow(recipe: PrivateRunnerWorkflowRecipe): string {
  const checked = validatePrivateRunnerRecipe(recipe);
  return stringify({
    name: 'Liftoff private network observation',
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: { workflow_dispatch: { inputs: {
      liftoff_operation_id: { description: 'Exact private activation checkpoint correlation', required: true, type: 'string' },
      configuration_digest: { description: 'Exact reviewed non-sensitive configuration binding', required: true, type: 'string' }
    } } },
    permissions: { actions: 'read' },
    jobs: {
      private_network: {
        name: privateRunnerJobName, 'runs-on': { group: checked.runnerGroupName, labels: checked.runnerLabel },
        'timeout-minutes': 10,
        steps: [
          { name: 'Private network observations', shell: 'bash',
            env: {
              GH_TOKEN: '${{ github.token }}',
              LIFTOFF_PRIVATE_TARGET: canonicalJson(checked.target), LIFTOFF_EGRESS_HOSTS: canonicalJson(checked.egressHosts),
              LIFTOFF_CORRELATION_ID: '${{ inputs.liftoff_operation_id }}', LIFTOFF_CONFIGURATION_DIGEST: '${{ inputs.configuration_digest }}',
              LIFTOFF_TARGET_DIGEST: canonicalSha256(checked.target), LIFTOFF_WORKFLOW_PATH: checked.workflowPath
            },
            run: `node --input-type=module <<'LIFTOFF_PRIVATE_PROBE'\n${probeScript}LIFTOFF_PRIVATE_PROBE\n` },
          { name: 'Retain payload-free report', uses: `actions/upload-artifact@${checked.uploadArtifactActionSha}`,
            with: { name: `${privateRunnerArtifactPrefix}\${{ inputs.liftoff_operation_id }}`, path: privateRunnerReportFilename,
              'if-no-files-found': 'error', 'retention-days': 1, 'include-hidden-files': false } }
        ]
      }
    }
  }, { lineWidth: 0 });
}

export function validatePrivateRunnerSource(value: PrivateRunnerWorkflowSource): PrivateRunnerWorkflowSource {
  exactObject(value, ['sourceSha', 'workflowId', 'workflowDigest', 'ref', 'actorId', 'recipe'], 'Published private runner source');
  sourceSha(value.sourceSha);
  positiveId(value.workflowId);
  positiveId(value.actorId);
  githubRef(value.ref);
  privateDigest(value.workflowDigest, 'Immutable workflow digest');
  require(value.workflowDigest === canonicalSha256(renderPrivateRunnerWorkflow(value.recipe)), 'The published private runner workflow must be the exact registered payload-free observation recipe.');
  return structuredClone(value);
}

function uuid(value: unknown): string {
  require(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000', 'A private report requires its exact checkpoint correlation UUID, not a fabricated provider run/request ID.');
  return value;
}

function route(value: unknown, address: string, prefix: string) {
  const r = exactObject(value, ['destination', 'gateway', 'device', 'source'], 'Actual runner route');
  require(r.destination === address && (r.gateway === null || typeof r.gateway === 'string' && /^[0-9.]+$/u.test(r.gateway)) &&
    typeof r.device === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(r.device) &&
    typeof r.source === 'string' && /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/u.test(r.source),
  'The private runner must report its actual private source and route to each exact endpoint.');
  const network = privateIpv4(prefix.split('/')[0]), size = 2 ** (32 - Number(prefix.split('/')[1]));
  const source = privateIpv4(r.source);
  require(source >= network + 4 && source < network + size - 1, 'The observed runner route source is outside the exact approved dedicated subnet.');
}

export function assertPrivateNetworkObservation(
  value: unknown, target: Pick<PrivateRunnerReachabilityTarget, 'hostname' | 'endpointAddress'>, runnerSubnetPrefix: string
): void {
  const network = exactObject(value, ['hostname', 'cname', 'addresses', 'connectedAddress', 'tlsProtocol', 'route'], 'Actual private DNS/TLS observation');
  require(network.hostname === target.hostname && network.cname === target.hostname.replace('.blob.', '.privatelink.blob.') &&
    canonicalSha256(network.addresses) === canonicalSha256([target.endpointAddress]) &&
    network.connectedAddress === target.endpointAddress && ['TLSv1.2', 'TLSv1.3'].includes(String(network.tlsProtocol)),
  'Actual runner DNS, TLS and connected private endpoint do not match the reviewed path.');
  route(network.route, target.endpointAddress, runnerSubnetPrefix);
}

export function validatePrivateRunnerReport(
  value: unknown, source: PrivateRunnerWorkflowSource, identity: PrivateRunnerRunIdentity,
  job: Record<string, unknown>, runnerGroupId: number, runnerLabel: string, now: Date
): PrivateRunnerNetworkReport {
  const r = exactObject(value, ['schemaVersion', 'kind', 'correlationId', 'configurationDigest', 'repository', 'repositoryId',
    'sourceSha', 'workflowPath', 'runId', 'runAttempt', 'targetDigest', 'job', 'network', 'egress', 'observedAt'], 'Payload-free reachability report');
  const recipe = source.recipe;
  require(r.schemaVersion === 1 && r.kind === 'private-runner-reachability-report' &&
    r.correlationId === uuid(identity.correlationId) && r.configurationDigest === identity.configurationDigest &&
    r.repository === recipe.repository && r.repositoryId === recipe.repositoryId && r.sourceSha === source.sourceSha &&
    r.workflowPath === recipe.workflowPath && r.runId === identity.runId && r.runAttempt === identity.runAttempt &&
    r.targetDigest === canonicalSha256(recipe.target),
  'The report body is not committed to this exact source, run, attempt and network target.');
  const actualJob = exactObject(r.job, ['id', 'name', 'runnerId', 'runnerGroupId', 'runnerName', 'labels'], 'Actual runner job');
  require(actualJob.id === job.id && actualJob.name === privateRunnerJobName &&
    actualJob.runnerId === positiveId(job.runner_id) && actualJob.runnerGroupId === runnerGroupId &&
    job.runner_group_id === runnerGroupId && actualJob.runnerName === job.runner_name &&
    canonicalSha256(actualJob.labels) === canonicalSha256(job.labels) && Array.isArray(actualJob.labels) &&
    actualJob.labels.includes(runnerLabel), 'Job readback does not prove the exact repository-dedicated runner assignment.');
  assertPrivateNetworkObservation(r.network, recipe.target, recipe.runnerSubnetPrefix);
  require(Array.isArray(r.egress) && r.egress.length === recipe.egressHosts.length, 'The exact egress observation inventory is incomplete.');
  for (let i = 0; i < r.egress.length; i++) {
    const e = exactObject(r.egress[i], ['hostname', 'connectedAddress', 'tlsProtocol', 'route'], 'Actual runner egress');
    require(e.hostname === recipe.egressHosts[i] && typeof e.connectedAddress === 'string' && /^[0-9.]+$/u.test(e.connectedAddress) &&
      ['TLSv1.2', 'TLSv1.3'].includes(String(e.tlsProtocol)),
    'A required exact outbound TLS endpoint was not reached from the bound runner.');
    route(e.route, e.connectedAddress, recipe.runnerSubnetPrefix);
  }
  require(typeof r.observedAt === 'string' && Number.isFinite(Date.parse(r.observedAt)) &&
    new Date(r.observedAt).toISOString() === r.observedAt &&
    Date.parse(r.observedAt) <= now.getTime() && now.getTime() - Date.parse(r.observedAt) <= 15 * 60_000,
  'The private runner report is stale or future-dated.');
  return structuredClone(r) as unknown as PrivateRunnerNetworkReport;
}

export function privateRunnerWorkflowBinding(source: PrivateRunnerWorkflowSource): WorkflowRunBinding {
  validatePrivateRunnerSource(source);
  return {
    repository: source.recipe.repository, repositoryId: source.recipe.repositoryId, workflowPath: source.recipe.workflowPath,
    workflowId: source.workflowId, workflowDigest: source.workflowDigest, sourceSha: source.sourceSha,
    ref: source.ref, actorId: source.actorId, event: 'workflow_dispatch', expectedJobs: [privateRunnerJobName], runAttempt: 1
  };
}

export async function observePrivateRunnerRun(
  client: GitHubActivationClient, sourceInput: PrivateRunnerWorkflowSource, identity: PrivateRunnerRunIdentity,
  runnerGroupId: number, runnerLabel: string, now: Date, operation: ExternalOperationState
): Promise<{ status: 'pending' } | { status: 'verified'; report: PrivateRunnerNetworkReport; artifactId: number; reportDigest: string; runRequestId: string }> {
  const source = validatePrivateRunnerSource(sourceInput);
  positiveId(identity.runId); positiveId(identity.runAttempt); uuid(identity.correlationId);
  privateDigest(identity.configurationDigest, 'Run configuration binding');
  const repo = source.recipe.repository;
  require(operation.provider === 'github' && operation.operationId === String(identity.runId) &&
    operation.resourceId === `/repos/${repo}/actions/runs/${identity.runId}`,
  'Reachability readback requires the actual retained provider operation, not a reconstructed or unrelated run.');
  const observed = await client.transport.request({
    method: 'GET', path: `/repos/${repo}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`
  });
  if (observed.status === 404) return { status: 'pending' };
  const run = object(expectStatus(observed, [200], 'Read exact private workflow run').data);
  const runRequestId = observed.headers['x-github-request-id'];
  require(typeof runRequestId === 'string' && /^[A-Fa-f0-9]{4}:[A-Fa-f0-9:]{4,100}$/u.test(runRequestId),
    'Private workflow readback requires its actual provider request ID.');
  require(run.id === identity.runId && run.run_attempt === identity.runAttempt && run.workflow_id === source.workflowId &&
    run.path === source.recipe.workflowPath && run.head_sha === source.sourceSha && run.head_branch === source.ref &&
    run.event === 'workflow_dispatch' && object(run.actor).id === source.actorId &&
    object(run.repository).id === source.recipe.repositoryId && object(run.repository).full_name === repo &&
    run.display_title === `liftoff-${identity.correlationId}`,
  'The actual private workflow run differs from its exact published source, actor, attempt or dispatch checkpoint.');
  if (run.status !== 'completed') return { status: 'pending' };
  const binding = privateRunnerWorkflowBinding(source);
  const independent = await readBoundWorkflowRun(client, binding, operation);
  require(independent.conclusion === 'success', 'Failed, skipped, cancelled or neutral private runner workflows cannot establish readiness.');
  const content = await readbackWorkflowContent(client, repo, source.recipe.workflowPath, source.sourceSha);
  require(content.digest === source.workflowDigest && content.content === renderPrivateRunnerWorkflow(source.recipe),
    'Actual immutable workflow bytes do not match the registered private observation recipe.');
  const jobs = await client.list(`/repos/${repo}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs`, 'jobs');
  require(jobs.length === 1, 'Private runner proof must identify exactly its one registered observation job.');
  const job = jobs[0]!;
  require(independent.jobs.length === 1 && independent.jobs[0]!.id === job.id,
    'The independently verified Actions check must bind the exact observed runner job.');
  require(job.name === privateRunnerJobName && job.run_id === identity.runId && job.head_sha === source.sourceSha &&
    job.status === 'completed' && job.conclusion === 'success' && Array.isArray(job.steps), 'The actual required runner job did not complete successfully.');
  for (const name of ['Private network observations', 'Retain payload-free report']) {
    const steps = job.steps.filter((entry) => isRecord(entry) && entry.name === name);
    require(steps.length === 1 && object(steps[0]).status === 'completed' && object(steps[0]).conclusion === 'success',
      'A required network or identity validation step was skipped, failed or not executed.');
  }
  const artifacts = await client.list(`/repos/${repo}/actions/runs/${identity.runId}/artifacts`, 'artifacts');
  const matching = artifacts.filter((artifact) => artifact.name === `${privateRunnerArtifactPrefix}${identity.correlationId}`);
  require(matching.length === 1, 'An exact source/run-bound payload-free artifact is required; latest artifacts are not adopted.');
  const artifact = matching[0]!;
  require(artifact.expired === false && typeof artifact.size_in_bytes === 'number' && artifact.size_in_bytes <= 512 * 1024 &&
    typeof artifact.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) &&
    object(artifact.workflow_run).id === identity.runId && object(artifact.workflow_run).head_sha === source.sourceSha,
  'The actual private report artifact is absent, expired or bound to another run/source.');
  const artifactId = positiveId(artifact.id);
  const verifiedArtifact = await readBoundWorkflowArtifact({
    client, binding, operation, artifactId, name: `${privateRunnerArtifactPrefix}${identity.correlationId}`,
    expectedDigest: artifact.digest
  });
  let report: PrivateRunnerNetworkReport;
  try {
    report = validatePrivateRunnerReport(readPrivateReportArchive(verifiedArtifact.archive), source, identity, job, runnerGroupId, runnerLabel, now);
  } finally { verifiedArtifact.archive.fill(0); }
  require(typeof job.started_at === 'string' && typeof job.completed_at === 'string' &&
    Date.parse(job.completed_at) <= now.getTime() &&
    Date.parse(report.observedAt) >= Date.parse(job.started_at) && Date.parse(report.observedAt) <= Date.parse(job.completed_at),
  'The payload-free observations were not produced during the actual bound runner job.');
  return { status: 'verified', report, artifactId, reportDigest: canonicalSha256(report), runRequestId };
}
