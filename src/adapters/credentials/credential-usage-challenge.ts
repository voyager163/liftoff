import { stringify } from 'yaml';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { runnerPreflightSecretName, type ExternalOperationState } from '../../domain/governance/activation/types.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { GitHubActivationError, githubRef, object, positiveId, type GitHubActivationClient } from '../github/activation-rest.js';
import { readbackWorkflowContent, type WorkflowFileDefinition } from '../github/production-workflows.js';
import { readBoundWorkflowRun, readBoundWorkflowArtifact, type WorkflowRunBinding } from '../github/production-checks.js';
import { credentialApiPermissions, credentialUuid, credentialProductionContractGaps, validateGitHubCredentialTarget, type GitHubCredentialTarget } from './github-enrollment.js';
import {
  credentialArtifactName, credentialReportFile, credentialUploadAction, credentialUploadStep,
  extractCredentialUsageReport, validateCredentialUsageReport, type CredentialUsageReport
} from './credential-usage-report.js';
import { credentialPermissionBoundary, type CredentialProviderPermissionBoundary } from './credential-permissions.js';

export const credentialUsageActionId = 'github.credential.usage-challenge';
export const credentialUsageWorkflowPath = '.github/workflows/liftoff-credential-usage.yml';
export const credentialUsageJob = 'credential-use';
export const credentialUsageStep = 'Verify stored credential and required permissions';

export interface CredentialUsageChallenge {
  kind: 'github-credential-usage.v1';
  challengeId: string;
  workflowId: number;
  sourceSha: string;
  ref: string;
  actorId: number;
  runId: number;
  runAttempt: number;
  notBefore: string;
  expiresAt: string;
}

export interface CredentialArtifactReference {
  id: number;
  name: string;
  zipDigest: string;
  reportDigest: string;
}

export interface CredentialUsageProof {
  kind: 'github-stored-credential-use.v1';
  repository: string;
  repositoryId: number;
  principal: GitHubCredentialTarget['principal'];
  credentialKind: 'github-app';
  protectedReference: string;
  custodyVersion: string | null;
  providerSecretVersion: null;
  challengeId: string;
  workflowId: number;
  workflowPath: string;
  sourceSha: string;
  workflowDigest: string;
  ref: string;
  actorId: number;
  runId: number;
  runAttempt: number;
  jobId: number;
  checkRunId: number;
  producerAppId: number;
  permissionsDigest: string;
  permissionBoundary: CredentialProviderPermissionBoundary;
  artifact: CredentialArtifactReference;
  report: CredentialUsageReport;
}

export function parseCredentialUsageSelection(value: unknown): Omit<CredentialUsageChallenge, 'runId'> {
  const input = object(value, 'Stored credential challenge');
  const fields = ['kind', 'challengeId', 'workflowId', 'sourceSha', 'ref', 'actorId', 'runAttempt', 'notBefore', 'expiresAt'];
  if (input.kind !== 'github-credential-usage.v1' || Object.keys(input).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(input, field)) ||
    typeof input.notBefore !== 'string' || typeof input.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(input.notBefore)) || !Number.isFinite(Date.parse(input.expiresAt)) ||
    input.runAttempt !== 1 || Date.parse(input.expiresAt) <= Date.parse(input.notBefore) ||
    Date.parse(input.expiresAt) - Date.parse(input.notBefore) > 3600_000) {
    throw new GitHubActivationError('credential-challenge', 'The challenge requires exact source, first attempt and a positive window of at most one hour.');
  }
  return {
    kind: 'github-credential-usage.v1', challengeId: credentialUuid(input.challengeId),
    workflowId: positiveId(input.workflowId), sourceSha: sourceSha(input.sourceSha),
    ref: githubRef(input.ref), actorId: positiveId(input.actorId),
    runAttempt: 1, notBefore: new Date(input.notBefore).toISOString(), expiresAt: new Date(input.expiresAt).toISOString()
  };
}

export function parseCredentialUsageChallenge(value: unknown): CredentialUsageChallenge {
  const { runId, ...selection } = object(value, 'Stored credential challenge');
  return { ...parseCredentialUsageSelection(selection), runId: positiveId(runId) };
}

function usageScript(target: GitHubCredentialTarget, challengeId: string): string {
  return `node --input-type=module <<'LIFTOFF_CREDENTIAL_PROBE'
import { createPrivateKey, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const expected = ${JSON.stringify({
    repository: target.repository, repositoryId: target.repositoryId, ownerId: target.ownerId, actorId: target.actor.id,
    configuration: target.configuration, principal: target.principal, reference: target.protectedReference,
    version: target.custodyVersion, source: target.source, challengeId, permissions: credentialApiPermissions,
    permissionBoundary: credentialPermissionBoundary(target.metadata.observedPermissions)
  })};
let secret, jwt, token, raw, envelope, report;
const probes = [];
const equal = (left, right) => {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return JSON.stringify(a) === JSON.stringify(b) && a.every(key => left[key] === right[key]);
};
const require = (value) => { if (!value) throw new Error('credential assertion'); };
const number = (value) => { require(typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); const n = Number(value); require(Number.isSafeInteger(n)); return n; };
async function request(auth, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const chunks = [];
  let size = 0;
  try {
    const response = await fetch('https://api.github.com' + path, {
      method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + auth.toString('utf8'), Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    require(response.status === (method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200));
    const requestId = response.headers.get('x-github-request-id');
    require(typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/.test(requestId) && !/(github_pat_|gh[pousr]_)/.test(requestId));
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      require(size <= 262144);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    try {
      const data = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      probes.push({ method, path, status: response.status, requestId });
      return data;
    } finally { bytes.fill(0); }
  } finally { clearTimeout(timer); chunks.forEach(bytes => bytes.fill(0)); }
}
let success = false;
try {
  require(process.env.LIFTOFF_CHALLENGE === expected.challengeId);
  require(/^[a-f0-9-]{36}$/.test(process.env.LIFTOFF_OPERATION_ID || ''));
  const run = {
    repository: process.env.GITHUB_REPOSITORY, repositoryId: number(process.env.LIFTOFF_REPOSITORY_ID),
    ownerId: number(process.env.LIFTOFF_OWNER_ID), actorId: number(process.env.LIFTOFF_ACTOR_ID),
    runId: number(process.env.GITHUB_RUN_ID), runAttempt: number(process.env.GITHUB_RUN_ATTEMPT),
    sourceSha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF_NAME,
    workflowRef: process.env.LIFTOFF_WORKFLOW_REF, job: process.env.GITHUB_JOB
  };
  require(run.repository === expected.repository && run.repositoryId === expected.repositoryId &&
    run.ownerId === expected.ownerId && run.actorId === expected.actorId && run.runAttempt === 1 &&
    run.job === 'credential-use' && /^[a-f0-9]{40}$/.test(run.sourceSha) &&
    run.workflowRef === expected.repository + '/.github/workflows/liftoff-credential-usage.yml@refs/heads/' + run.ref);
  raw = process.env.LIFTOFF_CREDENTIAL;
  delete process.env.LIFTOFF_CREDENTIAL;
  require(typeof raw === 'string' && Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 49152);
  require(expected.configuration.kind === 'github-app');
  if (expected.source === 'existing-app-private-key') secret = Buffer.from(raw);
  else {
    require(expected.source === 'custody-envelope-v1');
    envelope = JSON.parse(raw);
    require(equal(Object.fromEntries(Object.keys(envelope).map(key => [key, true])),
      { schemaVersion: true, kind: true, reference: true, version: true, value: true }));
    require(envelope.schemaVersion === 1 && envelope.kind === 'github-app' && envelope.reference === expected.reference &&
      envelope.version === expected.version && typeof envelope.value === 'string' && envelope.value.length > 0);
    secret = Buffer.from(envelope.value); delete envelope.value;
  }
  raw = undefined;
  const key = createPrivateKey(secret);
  require(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048);
  const issued = Math.floor(Date.now() / 1000) - 60;
  const unsigned = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url') + '.' +
    Buffer.from(JSON.stringify({ iat: issued, exp: issued + 540, iss: String(expected.configuration.appId) })).toString('base64url');
  jwt = Buffer.from(unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url'));
  const app = await request(jwt, 'GET', '/app');
  const installation = await request(jwt, 'GET', '/app/installations/' + expected.configuration.installationId);
  require(app.id === expected.configuration.appId && app.slug + '[bot]' === expected.principal.login);
  require(installation.id === expected.configuration.installationId && installation.app_id === app.id &&
    installation.account.id === expected.ownerId && installation.repository_selection === 'selected' &&
    installation.suspended_at === null && equal(installation.permissions, expected.permissions));
  require(expected.permissionBoundary.observedProviderPermissions.kind === 'github-app' &&
    equal(installation.permissions, expected.permissionBoundary.observedProviderPermissions.permissions));
  const access = await request(jwt, 'POST', '/app/installations/' + expected.configuration.installationId + '/access_tokens',
    { repository_ids: [expected.repositoryId], permissions: expected.permissions });
  require(typeof access.token === 'string' && access.token.length > 0);
  token = Buffer.from(access.token); delete access.token;
  require(equal(access.permissions, expected.permissions) && Number.isFinite(Date.parse(access.expires_at)) &&
    Date.parse(access.expires_at) > Date.now() && Date.parse(access.expires_at) <= Date.now() + 3600000);
  const selected = await request(token, 'GET', '/installation/repositories?per_page=100&page=1');
  require(selected.total_count === 1 && selected.repositories.length === 1 &&
    selected.repositories[0].id === expected.repositoryId && selected.repositories[0].full_name === expected.repository);
  const principal = await request(token, 'GET', '/users/' + expected.principal.login);
  require(principal.id === expected.principal.id && principal.login === expected.principal.login && principal.type === 'Bot');
  const repository = await request(token, 'GET', '/repos/' + expected.repository);
  require(repository.id === expected.repositoryId && repository.full_name === expected.repository && repository.owner.id === expected.ownerId);
  const owner = expected.repository.split('/')[0];
  const runners = await request(token, 'GET', '/orgs/' + owner + '/actions/hosted-runners?per_page=1&page=1');
  require(Array.isArray(runners.runners) && Number.isSafeInteger(runners.total_count));
  const networks = await request(token, 'GET', '/orgs/' + owner + '/settings/network-configurations?per_page=1&page=1');
  require(Array.isArray(networks.network_configurations) && Number.isSafeInteger(networks.total_count));
  report = {
    schemaVersion: 1, kind: 'github-credential-usage-report', challengeId: expected.challengeId,
    correlationId: process.env.LIFTOFF_OPERATION_ID, run,
    credential: { kind: 'github-app', appId: app.id, installationId: installation.id,
      principal: { id: principal.id, login: principal.login }, reference: expected.reference,
      source: expected.source, custodyVersion: expected.version, providerVersion: null },
    selectedRepository: { id: selected.repositories[0].id, fullName: selected.repositories[0].full_name },
    permissions: access.permissions, providerPermissionBoundary: {
      ...expected.permissionBoundary, observedProviderPermissions: { kind: 'github-app', permissions: access.permissions }
    }, probes, tokenExpiresAt: access.expires_at
  };
  success = true;
} catch { success = false; }
finally {
  if (token) { try { await request(token, 'DELETE', '/installation/token'); } catch { success = false; } }
  secret?.fill(0); jwt?.fill(0); token?.fill(0); raw = undefined; envelope = undefined;
}
if (success) {
  try { report.observedAt = new Date().toISOString(); await writeFile('${credentialReportFile}', JSON.stringify(report) + '\\n', { flag: 'wx', mode: 0o600 }); }
  catch { success = false; }
}
if (!success) { process.stderr.write('Stored credential proof, public report or ephemeral credential settlement failed. Details withheld.\\n'); process.exitCode = 1; }
LIFTOFF_CREDENTIAL_PROBE`;
}

export function renderCredentialUsageWorkflow(target: GitHubCredentialTarget, challengeId: string): WorkflowFileDefinition {
  target = validateGitHubCredentialTarget(target);
  if (target.source === 'protected-input') throw new GitHubActivationError('credential-source', 'A usage recipe must select existing stored App material, not an unenrolled protected input.');
  credentialUuid(challengeId);
  const content = stringify({
    name: 'Liftoff stored credential proof',
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: { workflow_dispatch: { inputs: {
      liftoff_operation_id: { required: true, type: 'string' },
      challenge: { required: true, type: 'string', description: 'Exact reviewed non-secret challenge identity' }
    } } },
    permissions: {},
    jobs: { [credentialUsageJob]: {
      name: credentialUsageJob, 'runs-on': 'ubuntu-24.04', 'timeout-minutes': 5, permissions: {},
      steps: [{
        name: credentialUsageStep, shell: 'bash',
        env: {
          LIFTOFF_CREDENTIAL: `\${{ secrets.${runnerPreflightSecretName} }}`, LIFTOFF_CHALLENGE: '${{ inputs.challenge }}',
          LIFTOFF_OPERATION_ID: '${{ inputs.liftoff_operation_id }}', LIFTOFF_REPOSITORY_ID: '${{ github.repository_id }}',
          LIFTOFF_OWNER_ID: '${{ github.repository_owner_id }}', LIFTOFF_ACTOR_ID: '${{ github.actor_id }}',
          LIFTOFF_WORKFLOW_REF: '${{ github.workflow_ref }}'
        },
        run: usageScript(target, challengeId)
      }, {
        name: credentialUploadStep, uses: credentialUploadAction,
        with: {
          name: `liftoff-credential-usage-${challengeId}-\${{ github.run_attempt }}`,
          path: credentialReportFile, 'if-no-files-found': 'error', 'retention-days': 1,
          'compression-level': 0, 'include-hidden-files': false, overwrite: false
        }
      }]
    } }
  }, { lineWidth: 0 });
  return { path: credentialUsageWorkflowPath, content, digest: canonicalSha256(content) };
}

export function credentialWorkflowRunBinding(target: GitHubCredentialTarget, challenge: Omit<CredentialUsageChallenge, 'runId'>): WorkflowRunBinding {
  const selected = parseCredentialUsageSelection(challenge);
  const source = renderCredentialUsageWorkflow(target, selected.challengeId);
  return {
    repository: target.repository, repositoryId: target.repositoryId, workflowPath: source.path,
    workflowId: selected.workflowId, workflowDigest: source.digest, sourceSha: selected.sourceSha,
    ref: selected.ref, actorId: selected.actorId, event: 'workflow_dispatch', expectedJobs: [credentialUsageJob], runAttempt: 1
  };
}

/** Verifies provider facts and raw grants. Policy admission is separate; factual success is not permission to use that grant. */
export async function verifyCredentialUsageChallenge(input: {
  client: GitHubActivationClient;
  target: GitHubCredentialTarget;
  challenge: CredentialUsageChallenge;
  dispatchCorrelationId: string;
  operation: ExternalOperationState;
  expectedArtifact?: CredentialArtifactReference;
  now: Date;
}): Promise<CredentialUsageProof> {
  const target = validateGitHubCredentialTarget(input.target);
  const challenge = parseCredentialUsageChallenge(input.challenge);
  const correlation = credentialUuid(input.dispatchCorrelationId);
  if (target.configuration.kind !== 'github-app') throw new GitHubActivationError('credential-pat-identity', credentialProductionContractGaps.patIdentity);
  if (challenge.actorId !== target.actor.id || input.now.getTime() < Date.parse(challenge.notBefore) ||
    input.now.getTime() >= Date.parse(challenge.expiresAt) || input.operation.operationId !== String(challenge.runId) ||
    input.operation.actionId !== credentialUsageActionId) {
    throw new GitHubActivationError('credential-challenge-stale', 'The credential challenge actor, operation or time window differs from review.');
  }
  const { runId: _runId, ...selection } = challenge;
  const binding = credentialWorkflowRunBinding(target, selection);
  const definition = renderCredentialUsageWorkflow(target, challenge.challengeId);
  const source = await readbackWorkflowContent(input.client, target.repository, definition.path, challenge.sourceSha);
  if (source.content !== definition.content) throw new GitHubActivationError('credential-challenge-source', 'Credential usage requires the exact published report-producing recipe.');
  const result = await readBoundWorkflowRun(input.client, binding, input.operation);
  const run = result.providerRun;
  if (result.conclusion !== 'success' || object(run.head_repository).id !== target.repositoryId ||
    object(run.triggering_actor).id !== challenge.actorId || run.display_title !== `liftoff-${correlation}` ||
    typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at)) ||
    Date.parse(run.created_at) < Date.parse(challenge.notBefore) || typeof run.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(run.updated_at)) || Date.parse(run.updated_at) > input.now.getTime()) {
    throw new GitHubActivationError('credential-challenge-run', 'The public report producer is foreign, stale or not successful.');
  }
  const jobs = await input.client.list(`${input.operation.resourceId}/attempts/${challenge.runAttempt}/jobs`, 'jobs');
  const job = result.jobs[0];
  if (jobs.length !== 1 || result.jobs.length !== 1 || !job || jobs[0]!.run_attempt !== challenge.runAttempt) {
    throw new GitHubActivationError('credential-challenge-step', 'The exact credential job/attempt is missing.');
  }
  for (const name of [credentialUsageStep, credentialUploadStep]) {
    const matching = job.steps.filter((step) => step.name === name);
    if (matching.length !== 1 || matching[0]!.status !== 'completed' || matching[0]!.conclusion !== 'success') {
      throw new GitHubActivationError('credential-challenge-step', 'The required credential proof or public report upload step did not succeed.');
    }
  }
  const name = credentialArtifactName(challenge.challengeId, challenge.runAttempt);
  const artifacts = await input.client.list(`/repos/${target.repository}/actions/runs/${challenge.runId}/artifacts`, 'artifacts');
  const matching = artifacts.filter((artifact) => artifact.name === name);
  if (matching.length !== 1 || matching[0]!.expired !== false ||
    input.expectedArtifact && input.expectedArtifact.id !== matching[0]!.id) {
    throw new GitHubActivationError('credential-artifact-selection', 'The exact run-specific credential artifact is absent, replaced, expired or ambiguous.');
  }
  const artifact = await readBoundWorkflowArtifact({
    client: input.client, binding, operation: input.operation, artifactId: positiveId(matching[0]!.id),
    name, expectedDigest: input.expectedArtifact?.zipDigest
  });
  const bytes = extractCredentialUsageReport(artifact.archive);
  const report = validateCredentialUsageReport(bytes, target, challenge, correlation, input.now, run.updated_at);
  const reference = { id: artifact.artifactId, name, zipDigest: artifact.digest, reportDigest: canonicalSha256(report) };
  if (input.expectedArtifact && canonicalSha256(input.expectedArtifact) !== canonicalSha256(reference)) {
    throw new GitHubActivationError('credential-artifact-changed', 'The public credential report differs from the exact retained artifact.');
  }
  return {
    kind: 'github-stored-credential-use.v1', repository: target.repository, repositoryId: target.repositoryId,
    principal: report.credential.principal, credentialKind: 'github-app', protectedReference: report.credential.reference,
    custodyVersion: report.credential.custodyVersion, providerSecretVersion: null, challengeId: challenge.challengeId,
    workflowId: challenge.workflowId, workflowPath: binding.workflowPath, sourceSha: challenge.sourceSha,
    workflowDigest: binding.workflowDigest, ref: challenge.ref, actorId: challenge.actorId, runId: result.runId,
    runAttempt: 1, jobId: job.id, checkRunId: job.checkRunId, producerAppId: job.appId,
    permissionsDigest: canonicalSha256(report.permissions), permissionBoundary: report.providerPermissionBoundary,
    artifact: reference, report
  };
}
