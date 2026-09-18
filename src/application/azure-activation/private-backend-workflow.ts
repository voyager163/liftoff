import { stringify } from 'yaml';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { githubRepository, positiveId, GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { validatePrivateStatePathTarget, type PrivateStatePathTarget } from '../../adapters/azure/private-state-path.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { exactObject, privateDigest, privateName } from './private-resource-plans.js';
import { runPrivateLeaseProbe, type PrivateLeaseChallenge, type PrivateLeaseProbeResult } from './private-backend-lease.js';
import type { WorkflowRunBinding } from '../../adapters/github/production-checks.js';
import type { PrivateRunnerNetworkReport } from './private-runner-workflow.js';

export const privateBackendJobName = 'Liftoff private backend lease proof';
export const privateBackendReportFilename = 'private-backend-lease-report.json';
export const privateBackendArtifactPrefix = 'liftoff-private-backend-';

export interface PrivateBackendWorkflowRecipe {
  repository: string;
  repositoryId: number;
  workflowPath: string;
  runnerGroupName: string;
  runnerLabel: string;
  runnerSubnetId: string;
  runnerSubnetPrefix: string;
  azureClientId: string;
  uploadArtifactActionSha: string;
  target: PrivateStatePathTarget;
}

export interface PrivateBackendWorkflowSource {
  sourceSha: string;
  workflowId: number;
  workflowDigest: string;
  ref: string;
  actorId: number;
  recipe: PrivateBackendWorkflowRecipe;
}

export interface PrivateBackendRunReport {
  schemaVersion: 1;
  kind: 'private-backend-lease-run-report';
  repository: string;
  repositoryId: number;
  workflowPath: string;
  sourceSha: string;
  runId: number;
  runAttempt: number;
  correlationId: string;
  configurationDigest: string;
  targetDigest: string;
  principalId: string | null;
  job: PrivateRunnerNetworkReport['job'] | null;
  network: PrivateRunnerNetworkReport['network'] | null;
  probe: PrivateLeaseProbeResult | null;
  failure: string | null;
  observedAt: string;
}

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('backend-workflow-source', message);
}

export function validatePrivateBackendRecipe(recipe: PrivateBackendWorkflowRecipe): PrivateBackendWorkflowRecipe {
  exactObject(recipe, [
    'repository', 'repositoryId', 'workflowPath', 'runnerGroupName', 'runnerLabel', 'runnerSubnetId', 'runnerSubnetPrefix',
    'azureClientId', 'uploadArtifactActionSha', 'target'
  ], 'Exact private backend workflow recipe');
  githubRepository(recipe.repository);
  positiveId(recipe.repositoryId);
  privateName(recipe.runnerGroupName, 'Private backend runner group');
  privateName(recipe.runnerLabel, 'Private backend runner label');
  sourceSha(recipe.uploadArtifactActionSha);
  const target = validatePrivateStatePathTarget(recipe.target);
  require(String(recipe.repositoryId) === target.backend.ownerId &&
    /^\.github\/workflows\/liftoff-bootstrap-backend(?:-[A-Za-z0-9_-]+)?\.yml$/u.test(recipe.workflowPath) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(recipe.azureClientId) &&
    recipe.azureClientId !== '00000000-0000-0000-0000-000000000000' &&
    recipe.runnerSubnetId.startsWith(`${target.virtualNetworkId}/subnets/`) &&
    recipe.runnerSubnetId !== target.subnetId &&
    /^(\d{1,3}\.){3}\d{1,3}\/(?:[89]|1\d|2[0-7])$/u.test(recipe.runnerSubnetPrefix),
  'Backend source requires exact repository, private runner/subnet, client and backend identities.');
  return structuredClone({ ...recipe, target });
}

export function privateBackendProbeScript(): string {
  return String.raw`import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const executeLease = ` + Function.prototype.toString.call(runPrivateLeaseProbe) + String.raw`;
const require = (ok) => { if (!ok) throw new Error('private-backend-observation-incomplete'); };
const recipe = JSON.parse(process.env.LIFTOFF_BACKEND_RECIPE);
const challenge = JSON.parse(process.env.LIFTOFF_LEASE_CHALLENGE);
const target = recipe.target;
const repo = process.env.GITHUB_REPOSITORY;
const runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const correlationId = process.env.LIFTOFF_OPERATION_ID;
const report = {
  schemaVersion:1,kind:'private-backend-lease-run-report',
  repository:repo,repositoryId:Number(process.env.GITHUB_REPOSITORY_ID),
  workflowPath:recipe.workflowPath,sourceSha:process.env.GITHUB_SHA,runId,runAttempt,correlationId,
  configurationDigest:process.env.LIFTOFF_CONFIGURATION_DIGEST,targetDigest:process.env.LIFTOFF_TARGET_DIGEST,
  principalId:null,job:null,network:null,probe:null,failure:null,observedAt:new Date().toISOString()
};
let oidc = '', accessToken = '';
const json = async (url, options, limit = 65536) => {
  const response = await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
  require(response.status === 200);
  const chunks = [];
  let length = 0;
  try {
    for await (const part of response.body) {
      length += part.length;
      require(length <= limit);
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { for (const bytes of chunks) bytes.fill(0); }
};
const claims = (token) => {
  const parts = token.split('.');
  require(parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)));
  return JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
};
try {
  require(repo === recipe.repository && report.repositoryId === recipe.repositoryId && runAttempt === 1 &&
    /^[a-f0-9-]{36}$/.test(correlationId) && /^[a-f0-9]{64}$/.test(report.configurationDigest));
  const jobs = await json('https://api.github.com/repos/' + repo + '/actions/runs/' + runId + '/attempts/' + runAttempt + '/jobs?per_page=100&page=1',
    {headers:{authorization:'Bearer ' + process.env.GH_TOKEN,accept:'application/vnd.github+json','x-github-api-version':'2026-03-10'}},262144);
  require(jobs.total_count === 1 && jobs.jobs.length === 1);
  const job = jobs.jobs[0];
  require(job.name === 'Liftoff private backend lease proof' && job.run_id === runId &&
    job.runner_id > 0 && job.runner_group_id === Number(process.env.LIFTOFF_RUNNER_GROUP_ID) &&
    Array.isArray(job.labels) && job.labels.includes(recipe.runnerLabel));
  report.job = {id:job.id,name:job.name,runnerId:job.runner_id,runnerGroupId:job.runner_group_id,runnerName:job.runner_name,labels:job.labels};
  require(Date.now() < Date.parse(challenge.activeUntil));
  const requestUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  require(requestUrl.protocol === 'https:' && !requestUrl.username && !requestUrl.password && !requestUrl.hash &&
    /(^|\.)actions\.githubusercontent\.com$/.test(requestUrl.hostname));
  requestUrl.searchParams.set('audience','api://AzureADTokenExchange');
  const oidcReply = await json(requestUrl.href,{headers:{authorization:'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});
  require(typeof oidcReply.value === 'string' && oidcReply.value.length < 48000);
  oidc = oidcReply.value;
  delete oidcReply.value;
  const gh = claims(oidc);
  require(gh.iss === 'https://token.actions.githubusercontent.com' && gh.aud === 'api://AzureADTokenExchange' &&
    gh.repository === repo && String(gh.repository_id) === String(recipe.repositoryId) &&
    gh.ref === process.env.GITHUB_REF && gh.sha === process.env.GITHUB_SHA &&
    String(gh.run_id) === String(runId) && String(gh.run_attempt) === String(runAttempt) &&
    gh.workflow_ref === repo + '/' + recipe.workflowPath + '@' + process.env.GITHUB_REF &&
    gh.exp * 1000 > Date.now() + 30000);
  const token = await json('https://login.microsoftonline.com/' + target.binding.tenantId + '/oauth2/v2.0/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:recipe.azureClientId,grant_type:'client_credentials',
      client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:oidc,
      scope:'https://storage.azure.com/.default'}).toString()
  });
  require(typeof token.access_token === 'string' && token.access_token.length < 48000 && token.token_type === 'Bearer');
  accessToken = token.access_token;
  delete token.access_token;
  oidc = '';
  const azure = claims(accessToken);
  require(azure.tid === target.binding.tenantId && azure.oid === target.binding.principalId &&
    (azure.appid === recipe.azureClientId || azure.azp === recipe.azureClientId) &&
    ['https://storage.azure.com','https://storage.azure.com/'].includes(azure.aud) &&
    azure.exp * 1000 > Date.parse(challenge.releaseUntil) + 15000);
  report.principalId = azure.oid;
  const hostname = target.backend.account + '.blob.core.windows.net';
  const cname = hostname.replace('.blob.','.privatelink.blob.');
  const resolver = new Resolver({timeout:10000,tries:1});
  const cnames = await resolver.resolveCname(hostname), addresses = await resolver.resolve4(hostname);
  require(cnames.length === 1 && cnames[0] === cname && addresses.length === 1 && addresses[0] === target.endpointAddress);
  const routeResult = await promisify(execFile)('ip',['-j','-4','route','get',target.endpointAddress],{timeout:10000,maxBuffer:65536,encoding:'utf8'});
  const routes = JSON.parse(routeResult.stdout);
  require(routes.length === 1 && routes[0].dst === target.endpointAddress && typeof routes[0].dev === 'string' && typeof routes[0].prefsrc === 'string');
  const route = {destination:target.endpointAddress,gateway:routes[0].gateway ?? null,device:routes[0].dev,source:routes[0].prefsrc};
  const blob = new URL(process.env.LIFTOFF_BACKEND_BLOB_URL);
  const lease = new URL(process.env.LIFTOFF_BACKEND_LEASE_URL);
  require([blob,lease].every((url) => url.protocol === 'https:' && url.hostname === hostname &&
    !url.port && !url.username && !url.password && !url.hash) &&
    !blob.search && lease.search === '?comp=lease' && lease.pathname === blob.pathname &&
    decodeURIComponent(blob.pathname) === '/' + target.backend.container + '/' + target.backend.key);
  const userAgent = 'liftoff-private-lease/' + challenge.intentDigest + '/' + runId + '/' + runAttempt + '/' + correlationId;
  const send = (method, endpoint, headers) => new Promise((resolve,reject) => {
    const req = request({hostname:target.endpointAddress,servername:hostname,port:443,method,path:endpoint.pathname + endpoint.search,
      agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:10000,
      headers:{...headers,host:hostname,authorization:'Bearer ' + accessToken,'x-ms-version':'2023-11-03',
        'x-ms-date':new Date().toUTCString(),'user-agent':userAgent}},(res) => {
      const tlsProtocol = res.socket.getProtocol(), connectedAddress = res.socket.remoteAddress;
      if (connectedAddress !== target.endpointAddress || !['TLSv1.2','TLSv1.3'].includes(tlsProtocol)) {
        req.destroy(new Error('private-transport-mismatch'));
        return;
      }
      report.network = {hostname,cname,addresses,connectedAddress,tlsProtocol,route};
      const h = res.headers;
      let received = 0;
      res.on('data',(bytes) => { received += bytes.length; bytes.fill(0); if (received > 4096) req.destroy(new Error('response-limit')); });
      res.once('end',() => resolve({status:res.statusCode,requestId:h['x-ms-request-id'] ?? null,
        etag:h.etag ?? null,version:h['x-ms-version-id'] ?? null,leaseId:h['x-ms-lease-id'] ?? null,
        leaseStatus:h['x-ms-lease-status'] ?? null,leaseState:h['x-ms-lease-state'] ?? null,
        serverEncrypted:h['x-ms-server-encrypted'] === 'true',errorCode:h['x-ms-error-code'] ?? null,observedAt:new Date().toISOString()}));
      res.once('aborted',() => reject(new Error('response-incomplete')));
      res.once('error',() => reject(new Error('response-incomplete')));
    });
    req.once('timeout',() => req.destroy(new Error('request-timeout')));
    req.once('error',() => reject(new Error('request-incomplete')));
    req.end();
  });
  report.probe = await executeLease(challenge,{
    now:Date.now,randomUuid:randomUUID,
    metadata:(headers) => send('HEAD',blob,{...headers,'x-ms-client-request-id':randomUUID()}),
    lease:(headers) => send('PUT',lease,headers),
    record:async (effect) => { process.stdout.write(JSON.stringify({kind:'private-lease-effect',intentDigest:challenge.intentDigest,effect}) + '\n'); }
  });
} catch {
  report.failure = 'private-backend-observation-incomplete';
}
oidc = ''; accessToken = '';
report.observedAt = new Date().toISOString();
if (report.failure || report.probe?.outcome !== 'verified') process.stderr.write('Private backend proof is blocked; inspect the payload-free report. No state payload or credential diagnostics are emitted.\n');
await writeFile('private-backend-lease-report.json',JSON.stringify(report),{flag:'wx',mode:0o600});
`;
}

export function renderPrivateBackendWorkflow(recipe: PrivateBackendWorkflowRecipe): string {
  const checked = validatePrivateBackendRecipe(recipe);
  return stringify({
    name: privateBackendJobName,
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: { workflow_dispatch: { inputs: {
      liftoff_operation_id: { description: 'Exact checkpoint correlation', required: true, type: 'string' },
      configuration_digest: { description: 'Reviewed public configuration binding', required: true, type: 'string' },
      lease_challenge: { description: 'Exact reviewed payload-free lease intent', required: true, type: 'string' },
      runner_group_id: { description: 'Actual approved private runner group ID', required: true, type: 'string' }
    } } },
    permissions: { actions: 'read', 'id-token': 'write' },
    jobs: {
      private_backend: {
        name: privateBackendJobName, 'runs-on': { group: checked.runnerGroupName, labels: checked.runnerLabel }, 'timeout-minutes': 5,
        steps: [
          { name: 'Private backend lease probe', shell: 'bash', env: {
            GH_TOKEN: '${{ github.token }}', LIFTOFF_BACKEND_RECIPE: canonicalJson(checked),
            LIFTOFF_BACKEND_BLOB_URL: azureStateUrl(checked.target.backend, 'blob'),
            LIFTOFF_BACKEND_LEASE_URL: azureStateUrl(checked.target.backend, 'lease'),
            LIFTOFF_TARGET_DIGEST: canonicalSha256(checked.target), LIFTOFF_LEASE_CHALLENGE: '${{ inputs.lease_challenge }}',
            LIFTOFF_RUNNER_GROUP_ID: '${{ inputs.runner_group_id }}', LIFTOFF_OPERATION_ID: '${{ inputs.liftoff_operation_id }}',
            LIFTOFF_CONFIGURATION_DIGEST: '${{ inputs.configuration_digest }}'
          }, run: `node --input-type=module <<'LIFTOFF_PRIVATE_BACKEND'\n${privateBackendProbeScript()}LIFTOFF_PRIVATE_BACKEND\n` },
          { name: 'Retain backend lease report', uses: `actions/upload-artifact@${checked.uploadArtifactActionSha}`,
            with: { name: `${privateBackendArtifactPrefix}\${{ inputs.liftoff_operation_id }}`, path: privateBackendReportFilename,
              'if-no-files-found': 'error', 'retention-days': 1, 'include-hidden-files': false } }
        ]
      }
    }
  }, { lineWidth: 0 });
}

export function validatePrivateBackendSource(value: PrivateBackendWorkflowSource): PrivateBackendWorkflowSource {
  exactObject(value, ['sourceSha', 'workflowId', 'workflowDigest', 'ref', 'actorId', 'recipe'], 'Exact private backend source');
  sourceSha(value.sourceSha); positiveId(value.workflowId); positiveId(value.actorId);
  privateDigest(value.workflowDigest, 'Private backend workflow source digest');
  require(typeof value.ref === 'string' && value.ref === 'develop' &&
    value.workflowDigest === canonicalSha256(renderPrivateBackendWorkflow(value.recipe)), 'Backend source must be the exact registered privileged dispatch-only recipe on its reviewed develop ref.');
  return structuredClone(value);
}

export function privateBackendWorkflowBinding(source: PrivateBackendWorkflowSource): WorkflowRunBinding {
  validatePrivateBackendSource(source);
  return {
    repository: source.recipe.repository, repositoryId: source.recipe.repositoryId, workflowPath: source.recipe.workflowPath,
    workflowId: source.workflowId, workflowDigest: source.workflowDigest, sourceSha: source.sourceSha, ref: source.ref,
    actorId: source.actorId, event: 'workflow_dispatch', expectedJobs: [privateBackendJobName], runAttempt: 1
  };
}

export function privateBackendDispatchInputs(challenge: PrivateLeaseChallenge, configurationDigest: string, runnerGroupId: number) {
  return { configuration_digest: privateDigest(configurationDigest, 'Backend dispatch configuration'),
    lease_challenge: JSON.stringify(challenge), runner_group_id: String(positiveId(runnerGroupId)) };
}
