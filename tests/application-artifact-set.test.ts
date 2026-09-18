import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeCommandRunner } from '../src/process-runner.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import {
  canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import { evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { phaseIds, type ActivationConfiguration, type PhaseEvidenceRecord } from '../src/domain/governance/activation/types.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import {
  evidenceHeaderFor, evidencePathParts, nextStateForOutcome, saveTransitionPlan, transitionPlanPathParts, writeOutcomeTransaction
} from '../src/governance-activation/transition-records.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../src/governance-activation/transition-ports.js';
import { applicationArtifactInputs, requiredApplicationArtifacts, type ApplicationArtifactRole } from '../src/application/azure-activation/application-artifact-inputs.js';
import {
  applicationBuildWorkflowDispatchInputs, applicationBuildWorkflowJob, applicationBuildWorkflowRecipeId, renderApplicationBuildWorkflow,
  type ApplicationBuildWorkflowRecipe
} from '../src/application/azure-activation/application-build-workflow.js';
import {
  applicationArtifactSetDigest, applicationArtifactSetInputs, applicationArtifactSetOperations, planApplicationArtifactSetReady,
  type ApplicationArtifactSetConfiguration, type ApplicationArtifactSetEvidence, type ApplicationArtifactSetReference
} from '../src/application/azure-activation/application-artifact-set.js';
import {
  executeApplicationArtifactSetReady, readApplicationArtifactRoleReference, readApplicationArtifactSetReference
} from '../src/application/azure-activation/application-artifact-set-execution.js';
import {
  executeApplicationArtifactReady, planApplicationArtifactReady, readApplicationArtifactRoleObservation
} from '../src/application/azure-activation/producer-artifact.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import {
  readApplicationRegistryPromotionSource, type ApplicationRegistryPromotionConfiguration
} from '../src/application/azure-activation/application-registry-promotion.js';
import {
  applicationReportZip, applicationPrincipal, applicationRegistryId, applicationSubscription, applicationTenant
} from './helpers/application-artifact-fixture.js';

const now = new Date('2026-09-15T00:00:00.000Z');
const sourceSha = createHash('sha1').update('isolated common application source, not a live commit').digest('hex');
const treeSha = createHash('sha1').update('isolated application component tree').digest('hex');
const host = 'crliftoff.azurecr.io';
const repository = 'owner/repo';
const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')!;
const budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 };
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blobSha = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function recipe(role: ApplicationArtifactRole): ApplicationBuildWorkflowRecipe {
  return {
    schemaVersion: 1, recipe: applicationBuildWorkflowRecipeId,
    workflowPath: `.github/workflows/build-${role}.yml`, repository, repositoryId: 42, actorId: 7, ref: 'develop',
    azure: {
      tenantId: applicationTenant, clientId: '11111111-2222-4333-8444-555555555559',
      principalId: '11111111-2222-4333-8444-555555555558'
    },
    registry: { resourceId: applicationRegistryId, loginServer: host, location: 'eastus', repository: `team/${role}` },
    artifactName: `${role}-build-report`, platform: 'linux/amd64', context: role, dockerfile: `${role}/Dockerfile`,
    tools: { dockerVersion: '28.0.0', buildxVersion: 'v0.21.0', buildkitImage: `moby/buildkit@${sha(Buffer.from('local fixture buildkit pin'))}` },
    uploadArtifactActionSha: createHash('sha1').update('local fixture action pin, not an upstream assertion').digest('hex'),
    budget, limits: { maxRunMinutes: 5, httpTimeoutSeconds: 5, commandTimeoutSeconds: 10, buildTimeoutSeconds: 120 }
  };
}

function roleFixture(role: ApplicationArtifactRole) {
  const build = recipe(role), source = renderApplicationBuildWorkflow(build);
  const workflowId = role === 'backend' ? 4 : 5, runId = role === 'backend' ? 100 : 200;
  const workflow = {
    repository, repositoryId: 42, workflowPath: build.workflowPath, workflowId, workflowDigest: canonicalSha256(source),
    sourceSha, ref: 'develop', actorId: 7, event: 'workflow_dispatch' as const,
    expectedJobs: [applicationBuildWorkflowJob], runAttempt: 1
  };
  const layer = Buffer.from(`actual local ${role} fixture layer bytes`);
  const config = Buffer.from(JSON.stringify({
    architecture: 'amd64', os: 'linux',
    config: {
      Labels: { 'org.opencontainers.image.source': `https://github.com/${repository}`, 'org.opencontainers.image.revision': sourceSha },
      Env: [`PRIVATE_FIXTURE_CONFIG=do-not-persist-${role}`]
    }
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: sha(layer), size: layer.length }]
  }));
  const report = {
    schemaVersion: 1, kind: 'liftoff-application-build',
    source: { repository, repositoryId: 42, commitSha: sourceSha },
    producer: { workflowId, workflowPath: workflow.workflowPath, workflowDigest: workflow.workflowDigest,
      runId, runAttempt: 1, actorId: 7, jobId: runId * 10 },
    image: { registryResourceId: applicationRegistryId, loginServer: host, repository: build.registry.repository, digest: sha(manifest) },
    oci: { manifestBase64: manifest.toString('base64'), configBase64: config.toString('base64') }
  };
  return {
    role, build, workflow, source, report, manifest, registryBytes: manifest, config, runId, artifactId: runId + 1,
    archive: applicationReportZip(report), status: 'completed', conclusion: 'success', run: null as Record<string, unknown> | null
  };
}

class LocalArtifactProviders {
  readonly roles = { backend: roleFixture('backend'), frontend: roleFixture('frontend') };
  readonly requests: Array<{ service: string; method: string; pathname: string }> = [];
  beforeDispatch?: (role: ApplicationArtifactRole, body: Record<string, any>) => Promise<void>;
  loseResponse: ApplicationArtifactRole | null = null;
  rejectDispatch: ApplicationArtifactRole | null = null;
  unavailableAttempt: ApplicationArtifactRole | null = null;
  credentialPrincipal = applicationPrincipal;
  readonly originalFetch = globalThis.fetch;
  readonly server = createServer((request, response) => {
    void this.route(request, response).catch(() => response.destroy());
  });
  address = '';

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback listener.');
    this.address = `http://127.0.0.1:${address.port}`;
    expect((await this.originalFetch(`${this.address}/fixture-health`)).status).toBe(200);
    vi.stubGlobal('fetch', async (resource: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.protocol !== 'https:' || !['management.azure.com', host].includes(url.host)) {
        throw new Error('Fixture refuses every real or undeclared network destination.');
      }
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      headers.set('x-fixture-service', url.host);
      return this.originalFetch(`${this.address}${url.pathname}${url.search}`, { ...init, headers });
    });
  }

  async close() {
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  token(claims: Record<string, unknown>) {
    return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
      exp: now.getTime() / 1000 + 3600, ...claims
    })).toString('base64url')}.${Buffer.from('local fixture, not a credential or signature').toString('base64url')}`;
  }

  async installExecutables(bin: string) {
    await mkdir(bin, { mode: 0o700 });
    await writeFile(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2), address = ${JSON.stringify(this.address)};
if (args[0] !== 'api' || args[args.indexOf('--hostname') + 1] !== 'github.com') process.exit(90);
const method = args[args.indexOf('--method') + 1];
const endpoint = args.find(arg => arg.startsWith('/repos/') || arg === '/user');
if (!endpoint || !['GET', 'POST'].includes(method)) process.exit(91);
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const response = await fetch(address + endpoint, {
    method, headers: {'x-fixture-service': 'github'}, redirect: 'error',
    ...(chunks.length ? {body: Buffer.concat(chunks)} : {})
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  process.stdout.write('HTTP/1.1 ' + response.status + '\\r\\n' +
    [...response.headers].map(([key, value]) => key + ': ' + value + '\\r\\n').join('') + '\\r\\n');
  process.stdout.write(bytes);
} catch { process.exitCode = 1; }
`, { mode: 0o700 });
    await writeFile(path.join(bin, 'az'), `#!${process.execPath}
const response = await fetch(${JSON.stringify(`${this.address}/fixture-azure-token`)}, {
  method: 'POST', headers: {'x-fixture-service': 'azure-cli'},
  body: JSON.stringify(process.argv.slice(2)), redirect: 'error'
});
if (response.status !== 200) process.exit(92);
process.stdout.write(await response.text());
`, { mode: 0o700 });
    await writeFile(path.join(bin, 'git'), `#!${process.execPath}\nprocess.exit(128);\n`, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  }

  async route(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/fixture-health') { response.writeHead(200).end(); return; }
    const url = new URL(`${this.address}${request.url}`), method = request.method ?? 'GET';
    const service = String(request.headers['x-fixture-service']);
    this.requests.push({ service, method, pathname: url.pathname });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const json = (value: unknown, status = 200) => response.writeHead(status, {
      'content-type': 'application/json', 'x-github-request-id': randomUUID(), 'x-ms-request-id': randomUUID()
    }).end(JSON.stringify(value));
    if (service === 'azure-cli') {
      const args = JSON.parse(body.toString());
      expect(args).toEqual(['account', 'get-access-token', '--subscription', applicationSubscription,
        '--tenant', applicationTenant, '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors']);
      json({ tokenType: 'Bearer', tenant: applicationTenant, subscription: applicationSubscription,
        accessToken: this.token({ oid: this.credentialPrincipal, tid: applicationTenant, aud: 'https://management.azure.com/' }) });
      return;
    }
    if (service === 'management.azure.com') {
      expect(method).toBe('GET');
      expect(url.pathname).toBe(applicationRegistryId);
      expect(url.searchParams.get('api-version')).toBe('2023-07-01');
      expect(request.headers.authorization).toMatch(/^Bearer /u);
      json({
        id: applicationRegistryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
        properties: { loginServer: host, provisioningState: 'Succeeded', adminUserEnabled: false }
      });
      return;
    }
    if (service === host) {
      const form = new URLSearchParams(body.toString());
      if (method === 'POST' && url.pathname === '/oauth2/exchange') {
        expect(form.get('service')).toBe(host);
        expect(form.get('tenant')).toBe(applicationTenant);
        json({ refresh_token: this.token({ aud: host, grant_type: 'refresh_token', tenant: applicationTenant }) });
        return;
      }
      if (method === 'POST' && url.pathname === '/oauth2/token') {
        const selected = Object.values(this.roles).find((entry) => form.get('scope') === `repository:${entry.build.registry.repository}:pull`);
        expect(selected).toBeDefined();
        json({ access_token: this.token({ aud: host, grant_type: 'access_token',
          access: [{ type: 'repository', name: selected!.build.registry.repository, actions: ['pull'] }] }) });
        return;
      }
      const selected = Object.values(this.roles).find((entry) =>
        url.pathname === `/v2/${entry.build.registry.repository}/manifests/${entry.report.image.digest}`);
      expect(selected).toBeDefined();
      expect(method).toBe('GET');
      expect(request.headers.authorization).toMatch(/^Bearer /u);
      response.writeHead(200, { 'docker-content-digest': selected!.report.image.digest, 'x-ms-request-id': randomUUID() }).end(selected!.registryBytes);
      return;
    }
    if (service !== 'github') throw new Error('Unknown fixture authority.');
    const root = `/repos/${repository}`, endpoint = url.pathname;
    if (method === 'POST') {
      const selected = Object.values(this.roles).find((entry) => endpoint === `${root}/actions/workflows/${entry.workflow.workflowId}/dispatches`);
      expect(selected).toBeDefined();
      const data = JSON.parse(body.toString());
      await this.beforeDispatch?.(selected!.role, data);
      if (this.rejectDispatch === selected!.role) { json({}, 403); return; }
      if (selected!.run) throw new Error('Duplicate dispatch must never be attempted.');
      selected!.run = {
        id: selected!.runId, run_attempt: 1, workflow_id: selected!.workflow.workflowId, path: selected!.workflow.workflowPath,
        head_sha: sourceSha, head_branch: 'develop', event: 'workflow_dispatch',
        actor: { id: 7 }, triggering_actor: { id: 7 }, repository: { id: 42, full_name: repository },
        created_at: now.toISOString(), display_title: `liftoff-${data.inputs.liftoff_operation_id}`,
        check_suite_id: selected!.runId * 1000
      };
      if (this.loseResponse === selected!.role) { this.loseResponse = null; response.destroy(); return; }
      json({ workflow_run_id: selected!.runId, run_url: `https://api.github.com${root}/actions/runs/${selected!.runId}`,
        html_url: `https://github.com/${repository}/actions/runs/${selected!.runId}` });
      return;
    }
    if (method !== 'GET') throw new Error('Fixture forbids unregistered GitHub mutations.');
    if (endpoint === '/user') { json({ id: 7, login: 'fixture-actor' }); return; }
    if (endpoint === root) { json({ id: 42, full_name: repository, default_branch: 'develop' }); return; }
    if (endpoint === `${root}/git/ref/heads/develop`) { json({ ref: 'refs/heads/develop', object: { type: 'commit', sha: sourceSha } }); return; }
    if (endpoint === `${root}/git/commits/${sourceSha}`) { json({ sha: sourceSha, tree: { sha: treeSha } }); return; }
    for (const selected of Object.values(this.roles)) {
      const w = selected.workflow, run = selected.run;
      if (endpoint === `${root}/contents/${w.workflowPath}` && url.searchParams.get('ref') === sourceSha) {
        const bytes = Buffer.from(selected.source);
        json({ type: 'file', path: w.workflowPath, sha: blobSha(bytes), size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
        return;
      }
      if (endpoint === `${root}/actions/workflows/${w.workflowId}`) { json({ id: w.workflowId, path: w.workflowPath, state: 'active' }); return; }
      const observedRun = { ...run, status: selected.status, conclusion: selected.status === 'completed' ? selected.conclusion : null };
      if (endpoint === `${root}/actions/workflows/${w.workflowId}/runs`) {
        json({ total_count: run ? 1 : 0, workflow_runs: run ? [observedRun] : [] }); return;
      }
      if (!run) continue;
      const runPath = `${root}/actions/runs/${selected.runId}`;
      if (endpoint === `${runPath}/attempts/1` && this.unavailableAttempt === selected.role) { json({}, 404); return; }
      if ([runPath, `${runPath}/attempts/1`].includes(endpoint)) { json(observedRun); return; }
      const steps = [
        { number: 1, name: 'Build and verify exact source image', status: 'completed', conclusion: selected.conclusion },
        { number: 2, name: 'Retain exact application build report', status: 'completed', conclusion: 'success' }
      ];
      if (endpoint === `${runPath}/attempts/1/jobs`) {
        json({ total_count: 1, jobs: [{
          id: selected.runId * 10, name: applicationBuildWorkflowJob, run_id: selected.runId, head_sha: sourceSha,
          status: selected.status, conclusion: selected.status === 'completed' ? selected.conclusion : null,
          check_run_url: `https://api.github.com${root}/check-runs/${selected.runId * 100}`, steps
        }] }); return;
      }
      if (endpoint === `${root}/check-runs/${selected.runId * 100}`) {
        json({ id: selected.runId * 100, name: applicationBuildWorkflowJob, head_sha: sourceSha,
          status: selected.status, conclusion: selected.conclusion, app: { id: 15368, slug: 'github-actions' },
          check_suite: { id: selected.runId * 1000 } }); return;
      }
      const artifact = {
        id: selected.artifactId, name: selected.build.artifactName, expired: false,
        digest: sha(selected.archive), size_in_bytes: selected.archive.length,
        workflow_run: { id: selected.runId, repository_id: 42, head_repository_id: 42, head_sha: sourceSha, head_branch: 'develop' }
      };
      if (endpoint === `${runPath}/artifacts`) { json({ total_count: 1, artifacts: [artifact] }); return; }
      if (endpoint === `${root}/actions/artifacts/${selected.artifactId}`) { json(artifact); return; }
      if (endpoint === `${root}/actions/artifacts/${selected.artifactId}/zip`) {
        response.writeHead(200, { 'content-type': 'application/zip' }).end(selected.archive); return;
      }
    }
    json({ message: 'Absent in isolated provider fixture' }, 404);
  }
}

async function fixture(options: { frontend?: boolean; legacy?: boolean; environments?: ('dev' | 'staging' | 'prod')[] } = {}) {
  const frontend = options.frontend ?? true;
  const root = path.resolve(`tests/.application-artifact-set-${randomUUID()}`);
  const projectRoot = path.join(root, 'project'), home = path.join(root, 'home');
  await mkdir(path.join(projectRoot, 'governance'), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const providers = new LocalArtifactProviders();
  await providers.start();
  cleanups.push(() => providers.close());
  await providers.installExecutables(path.join(root, 'bin'));
  const runner = new NodeCommandRunner();
  const project = buildProjectPlan({
    projectName: 'Role artifact fixture', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
    environments: options.environments ?? ['dev'], includeFrontend: frontend, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  const raw = JSON.parse(buildArtifacts(project).find((entry) => entry.logicalName === 'manifest')!.content);
  for (const component of raw.standards.components) component.id = component.rootPathParts[0] === 'backend' ? 'application-api' : 'customer-site';
  const manifest = parseManifest(raw);
  const setConfig: ApplicationArtifactSetConfiguration = {
    schemaVersion: 1, mode: 'artifact-set', source: { repository, repositoryId: 42, sourceSha },
    artifacts: {
      backend: { componentId: 'application-api', workflow: providers.roles.backend.workflow, build: providers.roles.backend.build, principalId: applicationPrincipal },
      ...(frontend ? { frontend: {
        componentId: 'customer-site', workflow: providers.roles.frontend.workflow, build: providers.roles.frontend.build, principalId: applicationPrincipal
      } } : {})
    }
  };
  const backend = providers.roles.backend;
  const legacy = {
    principalId: applicationPrincipal, resourceGroup: 'rg-app', acrName: 'crliftoff',
    imageName: backend.build.registry.repository, workflow: backend.workflow,
    dispatchInputs: applicationBuildWorkflowDispatchInputs(backend.build, sourceSha),
    artifactName: backend.build.artifactName, platform: backend.build.platform, maxRunMinutes: backend.build.limits.maxRunMinutes
  };
  const configuration: ActivationConfiguration = {
    schemaVersion: 1, azure: { subscriptionId: applicationSubscription, tenantId: applicationTenant, region: 'eastus' },
    budget, phases: { 'application-artifact-ready': (options.legacy ? legacy : setConfig) as unknown as Record<string, unknown> }
  };
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: 'fixture', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: repository, defaultBranch: 'develop', pushUrl: `https://github.com/${repository}.git`, verifiedAt: now.toISOString() },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false, cloudStateRequired: false, privateRunnerRequired: false },
    phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }])),
    activationInputs: configuration, createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, runner);
  const inspection: GovernanceTransitionInspection = {
    projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'activation',
    activationInputs: configuration, state, approvals: [], evidence: [], loadedState: await loadActivationState(projectRoot),
    contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
    readiness: { nextReadyPhase: phase.id, phases: state.phases },
    sourceOfTruth: { status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', changeId: 'artifact-set-fixture', workflowKind: 'openspec', reason: 'Local fixtures are not live qualification.', requiredFacts: [] } }
  };
  const planned = options.legacy
    ? planApplicationArtifactReady({ inspection, phase, runner, now }) : planApplicationArtifactSetReady({ inspection, phase, runner, now });
  expect(planned.blockers).toBeUndefined();
  const operations = planned.operations, context = inspection.contexts[phase.id];
  const requested = transitionPlanForPhase(phase, state, context.transition, projectRoot, undefined, {
    operations, selectionScope: 'activation', fileChanges: [], recovery: false, configuration
  });
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: now.toISOString(), expiresAt, approver: 'local-fixture-only'
  });
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  await writeGovernanceApprovalAuthority(projectRoot, canonicalSha256(requested), envelope, storage);
  inspection.approvals = [envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
    createdAt: now.toISOString(), expiresAt, identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
    stateHash: inspection.loadedState!.contentHash, baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: phase.allowedMutations, operations,
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase), fileChanges: [], recovery: false, noSecrets: true, configuration
  });
  const input: PhaseAdapterExecutionInput = {
    inspection, plan, phase, runner, now, adapters: { githubActivation: { storage }, azureActivation: { storage } }
  };
  const execute = () => withProjectMutationLock(projectRoot, (lease) =>
    (options.legacy ? executeApplicationArtifactReady : executeApplicationArtifactSetReady)({ ...input, lease }));
  const checkpoint = async (role: ApplicationArtifactRole) => {
    const config = applicationArtifactSetInputs(input).artifacts.find((entry) => entry.role === role)!.application;
    const operation = applicationArtifactSetOperations(applicationArtifactSetInputs(input)).find((entry) =>
      entry.actionId === 'github.artifact.build-dispatch' && (entry.inputs.artifactSet as { role: string }).role === role)!;
    return readWorkflowEffect(input, operation, {
      repositoryId: 42, ref: `develop:${config.workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow: config.workflow, dispatchInputs: config.dispatchInputs });
  };
  const persist = async (outcome: PhaseAdapterOutcome): Promise<ApplicationArtifactSetReference> => {
    const payload = {
      ...outcome.evidencePayload as ApplicationArtifactSetEvidence, planDigest: plan.planDigest,
      savedPlanDigest: canonicalSha256(plan), outputBindings: outcome.outputs
    };
    const evidenceId = `artifact-set-${randomUUID()}`;
    const record: PhaseEvidenceRecord = {
      evidenceId, payload, liveReadback: outcome.liveReadback,
      header: evidenceHeaderFor({ inspection, phase, plan, result: 'verified', now, payload, liveReadback: outcome.liveReadback })
    };
    const next = nextStateForOutcome({
      inspection, phase, plan, resultState: 'verified', now, operation: outcome.operation, outputs: outcome.outputs,
      evidenceReference: { phaseId: phase.id, evidenceId, headerDigest: evidenceHeaderDigest(record.header), result: 'verified' }
    });
    await withProjectMutationLock(projectRoot, async () => {
      await saveTransitionPlan(projectRoot, plan);
      await writeOutcomeTransaction({ projectRoot, plan, nextState: next, evidenceRecord: record,
        evidencePathParts: evidencePathParts(evidenceId), expectedStateHash: inspection.loadedState!.contentHash });
    });
    inspection.state = next;
    inspection.evidence = [record];
    inspection.loadedState = await loadActivationState(projectRoot);
    inspection.contexts[phase.id] = { ...context, evidenceReferences: next.phases[phase.id].evidence, reviewedPlans: [plan] };
    return {
      evidenceId, headerDigest: evidenceHeaderDigest(record.header), bodyDigest: record.header.bodyDigest!,
      planPathParts: transitionPlanPathParts(plan), savedPlanDigest: canonicalSha256(plan),
      setDigest: applicationArtifactSetDigest(applicationArtifactSetInputs(input))
    };
  };
  return { input, root, projectRoot, home, storage, providers, envelope, setConfig, execute, checkpoint, persist };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const dispatches = (f: Fixture) => f.providers.requests.filter((entry) => entry.service === 'github' && entry.method === 'POST');
async function privateRecords(f: Fixture) {
  const result: Array<{ path: string; hash: string; value: any }> = [];
  for (const entry of await readdir(f.home, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = path.join(entry.parentPath, entry.name), bytes = await readFile(name);
    result.push({ path: name, hash: sha(bytes), value: JSON.parse(bytes.toString()) });
  }
  return result;
}

describe('actual multi-artifact application producer and stored role references', () => {
  it('builds both manifest roles through default CLI/ARM/registry transports under one private whole-plan approval', async () => {
    const f = await fixture();
    const beforePlan = canonicalSha256(f.input.plan), beforeConfig = canonicalSha256(f.input.inspection.activationInputs);
    expect(f.input.adapters.githubActivation?.transport).toBeUndefined();
    expect(f.input.adapters.azureActivation?.transport).toBeUndefined();
    expect(requiredApplicationArtifacts(f.input.inspection.manifest).map(({ role, component }) => [role, component.id]))
      .toEqual([['backend', 'application-api'], ['frontend', 'customer-site']]);
    expect(f.input.plan.operations.map((entry) => entry.actionId)).toEqual([
      'github.artifact.build-dispatch', 'azure.artifact.readback', 'github.artifact.build-dispatch', 'azure.artifact.readback'
    ]);
    f.providers.beforeDispatch = async (role, body) => {
      const checkpoint = await f.checkpoint(role);
      expect(checkpoint?.response).toBeNull();
      expect(checkpoint?.observed).toBeNull();
      expect(checkpoint!.prepared).toMatchObject({ planDigest: f.input.plan.planDigest, approvalEnvelopeHash: f.input.plan.approval.envelopeHash });
      expect(body.inputs.liftoff_operation_id).toBe(checkpoint!.prepared.correlationId);
      expect((await privateRecords(f)).some((entry) => entry.value.kind === 'application-artifact-set-role-started.v1' && entry.value.role === role)).toBe(true);
    };
    const injection = vi.fn(async () => ({ status: 'completed', resultState: 'verified', evidencePayload: { fake: true } }));
    f.input.adapters.phases = { 'application-artifact-ready': { phaseId: phase.id, execute: injection as never } };
    const outcome = await f.execute();
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified',
      evidencePayload: { kind: 'application-artifact-ready.v1', mode: 'artifact-set', requiredRoles: ['backend', 'frontend'] } });
    expect(injection).not.toHaveBeenCalled();
    const evidence = outcome.evidencePayload as ApplicationArtifactSetEvidence;
    expect(evidence.source).toEqual({ repository, repositoryId: 42, sourceSha, treeSha });
    expect(evidence.artifacts.map((entry) => entry.provenance.digest)).toEqual([
      sha(f.providers.roles.backend.manifest), sha(f.providers.roles.frontend.manifest)
    ]);
    expect(evidence.artifacts.map((entry) => entry.provenance.configDigest)).toEqual([
      sha(f.providers.roles.backend.config), sha(f.providers.roles.frontend.config)
    ]);
    expect(outcome.outputs?.values['application.artifacts.frontend.imageRef']).toBe(`${host}/team/frontend@${sha(f.providers.roles.frontend.manifest)}`);
    expect(outcome.outputs?.values['azure.artifact.imageRef']).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_FIXTURE_CONFIG');
    expect(dispatches(f)).toHaveLength(2);
    expect(outcome.completedOperations).toHaveLength(4);
    expect(canonicalSha256(f.input.plan)).toBe(beforePlan);
    expect(canonicalSha256(f.input.inspection.activationInputs)).toBe(beforeConfig);
    const reference = await f.persist(outcome);
    const read = await readApplicationArtifactRoleReference(f.input, { set: reference, role: 'frontend' });
    expect(read.artifact.provenance.imageRef).toBe(outcome.outputs!.values['application.artifacts.frontend.imageRef']);
    expect(read.artifact.componentId).toBe('customer-site');
    expect((await readApplicationArtifactSetReference(f.input, reference)).evidence).toEqual(evidence);
    const before = await privateRecords(f);
    expect((await f.execute()).status).toBe('completed');
    expect(await privateRecords(f)).toEqual(before);
    expect(dispatches(f)).toHaveLength(2);
    expect(() => readApplicationArtifactRoleObservation({ status: 'completed', completedOperations: [] })).toThrow(/actual|supplied/u);
  }, 90_000);

  it('retains backend success privately while frontend is pending, then revalidates both without redispatch', async () => {
    const f = await fixture();
    f.providers.roles.frontend.status = 'queued';
    const pending = await f.execute();
    expect(pending.status, JSON.stringify(pending)).toBe('pending');
    expect(pending.evidencePayload).toBeUndefined();
    expect(pending.resultState).toBeUndefined();
    expect(Object.keys(pending.outputs!.values).some((key) => key.endsWith('.imageRef'))).toBe(false);
    const receipts = (await privateRecords(f)).filter((entry) => entry.value.kind === 'application-artifact-set-role-completed.v1');
    expect(receipts.map((entry) => entry.value.evidence.role)).toEqual(['backend']);
    f.input.inspection.state.phases[phase.id].operation = pending.operation;
    f.input.inspection.state.phases[phase.id].executionPlanDigest = f.input.plan.planDigest;
    const before = f.providers.requests.length;
    f.providers.roles.frontend.status = 'completed';
    const completed = await f.execute();
    expect(completed.status, JSON.stringify(completed)).toBe('completed');
    expect(f.providers.requests.slice(before).filter((entry) => entry.service === host && entry.pathname.includes('/team/backend/manifests/'))).toHaveLength(1);
    expect((await privateRecords(f)).find((entry) => entry.path === receipts[0]!.path)?.hash).toBe(receipts[0]!.hash);
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('recovers frontend response loss only by its original correlation while preserving successful backend custody', async () => {
    const f = await fixture();
    f.providers.loseResponse = 'frontend';
    const lost = await f.execute();
    expect(lost.status).toBe('blocked');
    expect(lost.evidencePayload).toBeUndefined();
    const checkpoint = await f.checkpoint('frontend');
    expect(checkpoint?.response).toBeNull();
    expect(checkpoint?.observed).toBeNull();
    const original = canonicalSha256(checkpoint!.prepared);
    expect((await f.execute()).status).toBe('completed');
    expect(canonicalSha256((await f.checkpoint('frontend'))!.prepared)).toBe(original);
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('keeps an unknown frontend submission blocked when no exact correlation can be observed', async () => {
    const f = await fixture();
    f.providers.loseResponse = 'frontend';
    expect((await f.execute()).status).toBe('blocked');
    f.providers.roles.frontend.run!.display_title = 'an unrelated provider run';
    const before = await privateRecords(f);
    const denied = await f.execute();
    expect(denied.status).toBe('blocked');
    expect(denied.blocker).toMatch(/no unique exact provider run identity/u);
    expect(denied.outputs?.values['application.artifactSet.roles.frontend.runId']).toBeNull();
    expect(denied.evidencePayload).toBeUndefined();
    expect(await privateRecords(f)).toEqual(before);
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('preserves an actual terminal provider handle while its attempt readback is temporarily unavailable', async () => {
    const f = await fixture();
    f.providers.unavailableAttempt = 'frontend';
    const pending = await f.execute();
    expect(pending, JSON.stringify(pending)).toMatchObject({
      status: 'blocked', operation: { operationId: '200', resourceId: `/repos/${repository}/actions/runs/200`, status: 'completed' }
    });
    expect(pending.outputs?.values['application.artifactSet.roles.frontend.responseRunId']).toBe('200');
    expect(pending.evidencePayload).toBeUndefined();
    expect((await f.checkpoint('frontend'))?.observed).toBeNull();
    f.input.inspection.state.phases[phase.id].operation = pending.operation;
    f.providers.unavailableAttempt = null;
    expect((await f.execute()).status).toBe('completed');
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('cannot substitute a retained success when registry bytes drift during continuation', async () => {
    const f = await fixture();
    f.providers.roles.frontend.status = 'queued';
    expect((await f.execute()).status).toBe('pending');
    const before = await privateRecords(f);
    f.providers.roles.backend.registryBytes = Buffer.from('changed actual registry bytes');
    f.providers.roles.frontend.status = 'completed';
    const denied = await f.execute();
    expect(denied.status).toBe('blocked');
    expect(denied.blocker).toMatch(/registry manifest bytes/u);
    expect(denied.evidencePayload).toBeUndefined();
    expect(await privateRecords(f)).toEqual(before);
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('keeps a failed frontend run incomplete and never launches a replacement', async () => {
    const f = await fixture();
    f.providers.roles.frontend.conclusion = 'failure';
    const first = await f.execute();
    expect(first.status).toBe('blocked');
    expect(first.operation).toMatchObject({ operationId: '200', status: 'failed' });
    const again = await f.execute();
    expect(again.status).toBe('blocked');
    expect(again.evidencePayload).toBeUndefined();
    expect(dispatches(f)).toHaveLength(2);
    expect((await privateRecords(f)).filter((entry) => entry.value.kind === 'application-artifact-set-role-completed.v1')).toHaveLength(1);
  }, 90_000);

  it('blocks a lost private dispatch checkpoint before any new role effects', async () => {
    const f = await fixture();
    f.providers.roles.frontend.status = 'queued';
    expect((await f.execute()).status).toBe('pending');
    const records = await privateRecords(f), checkpoint = await f.checkpoint('frontend');
    for (const entry of records) {
      if (entry.value.kind?.startsWith('github-workflow-effect-') &&
        (entry.value.intentDigest === checkpoint!.prepared.intentDigest || entry.value.preparedDigest === canonicalSha256(checkpoint!.prepared))) {
        await rm(entry.path);
      }
    }
    const before = f.providers.requests.length;
    const denied = await f.execute();
    expect(denied.status).toBe('blocked');
    expect(denied.blocker).toMatch(/no matching original private dispatch checkpoint/u);
    expect(f.providers.requests).toHaveLength(before);
    expect(dispatches(f)).toHaveLength(2);
  }, 90_000);

  it('refuses a frontend report or OCI configuration from the backend despite two successful runs', async () => {
    const f = await fixture();
    const frontend = f.providers.roles.frontend;
    frontend.report.oci.configBase64 = f.providers.roles.backend.config.toString('base64');
    frontend.archive = applicationReportZip(frontend.report);
    const denied = await f.execute();
    expect(denied.status).toBe('blocked');
    expect(denied.blocker).toMatch(/source\/run\/job-bound OCI/u);
    expect(denied.evidencePayload).toBeUndefined();
    expect((await privateRecords(f)).filter((entry) => entry.value.kind === 'application-artifact-set-role-completed.v1')).toHaveLength(1);
  }, 90_000);

  it('refuses backend bytes republished as the frontend even with internally consistent role report hashes', async () => {
    const f = await fixture(), backend = f.providers.roles.backend, frontend = f.providers.roles.frontend;
    frontend.report.image.digest = backend.report.image.digest;
    frontend.report.oci = { ...backend.report.oci };
    frontend.registryBytes = backend.manifest;
    frontend.archive = applicationReportZip(frontend.report);
    const denied = await f.execute();
    expect(denied.status).toBe('blocked');
    expect(denied.blocker).toMatch(/distinct actual image bytes/u);
    expect(denied.evidencePayload).toBeUndefined();
    expect(Object.keys(denied.outputs!.values).some((key) => key.endsWith('.imageRef'))).toBe(false);
  }, 90_000);

  it('does not trust stored public aggregate evidence after one private required role receipt disappears', async () => {
    const f = await fixture(), outcome = await f.execute();
    expect(outcome.status).toBe('completed');
    const reference = await f.persist(outcome);
    const frontend = (await privateRecords(f)).find((entry) =>
      entry.value.kind === 'application-artifact-set-role-completed.v1' && entry.value.evidence.role === 'frontend')!;
    await rm(frontend.path);
    await expect(readApplicationArtifactRoleReference(f.input, { set: reference, role: 'backend' })).rejects.toThrow(/any required role/u);
    await expect(readApplicationArtifactSetReference(f.input, { ...reference, bodyDigest: 'f'.repeat(64) })).rejects.toThrow();
  }, 90_000);

  it('supports a backend-only set but never falls back from an unconfigured frontend reference', async () => {
    const f = await fixture({ frontend: false }), outcome = await f.execute();
    expect(outcome.status).toBe('completed');
    expect((outcome.evidencePayload as ApplicationArtifactSetEvidence).requiredRoles).toEqual(['backend']);
    expect(dispatches(f)).toHaveLength(1);
    const reference = await f.persist(outcome);
    await expect(readApplicationArtifactRoleReference(f.input, { set: reference, role: 'frontend' })).rejects.toThrow(/no backend fallback/u);
  }, 90_000);

  it('preserves the original single-image facade and source-reader field shapes for a backend-only workload', async () => {
    const f = await fixture({ frontend: false, legacy: true });
    const config = applicationArtifactInputs(f.input), planned = planApplicationArtifactReady(f.input);
    const outcome = await f.execute();
    expect(outcome.status, JSON.stringify(outcome)).toBe('completed');
    expect(planned.operations).toHaveLength(2);
    expect(outcome.evidencePayload).toMatchObject({
      kind: 'application-artifact-ready.v1', sourceCommitSha: sourceSha, buildRunId: 100,
      imageRef: `${host}/${config.imageName}@${sha(f.providers.roles.backend.manifest)}`
    });
    expect(Object.keys((outcome.evidencePayload as any).provenance).sort()).toEqual([
      'actorId', 'configDigest', 'digest', 'imageRef', 'jobId', 'platform', 'registryResourceId', 'runAttempt', 'runId', 'sourceSha', 'workflowId'
    ]);
    expect(outcome.outputs?.values['azure.artifact.imageRef']).toBeDefined();
    expect((await privateRecords(f)).some((entry) => entry.value.kind?.startsWith('application-artifact-set'))).toBe(false);
  }, 90_000);
});

describe('whole-set admission rejects missing roles and widened authority before effects', () => {
  it.each(['staging', 'prod'] as const)('preserves a selected complete-set role as original %s registry promotion provenance', async (environment) => {
    const f = await fixture({ environments: ['dev', 'staging', 'prod'] }), outcome = await f.execute();
    expect(outcome.status, outcome.blocker).toBe('completed');
    const reference = await f.persist(outcome);
    const frontend = await readApplicationArtifactRoleReference(f.input, { set: reference, role: 'frontend' });
    const targetRegistryResourceId = `/subscriptions/${applicationSubscription}/resourceGroups/rg-${environment}/providers/Microsoft.ContainerRegistry/registries/cr${environment}`;
    const config: ApplicationRegistryPromotionConfiguration = {
      schemaVersion: 1, mode: 'promote',
      binding: { subscriptionId: applicationSubscription, tenantId: applicationTenant, principalId: applicationPrincipal, clientId: null },
      sourceBuild: {
        evidenceId: reference.evidenceId, headerDigest: reference.headerDigest, planPathParts: reference.planPathParts,
        savedPlanDigest: reference.savedPlanDigest,
        artifactSet: { role: 'frontend', bodyDigest: reference.bodyDigest, setDigest: reference.setDigest }
      },
      sourceRegistryResourceId: applicationRegistryId, sourceLoginServer: host, sourceRepository: 'team/frontend',
      imageDigest: frontend.artifact.provenance.digest, targetRegistryResourceId,
      targetLoginServer: `cr${environment}.azurecr.io`, targetRepository: 'release/frontend',
      disposableTarget: { authorityKind: 'disposable-registry-promotion', environment, registryResourceId: targetRegistryResourceId,
        operator: 'isolated-role-promotion-operator', spendCeilingCents: 50, maxDurationMinutes: 10,
        permittedEffects: ['azure-read', 'registry-publish'], notBefore: now.toISOString(),
        expiresAt: new Date(now.getTime() + 600000).toISOString() },
      transfer: { maxBlobs: 16, maxManifests: 8, maxBlobBytes: 65536, maxManifestBytes: 32768, maxConfigBytes: 32768,
        maxExpandedLayerBytes: 131072, maxImageBytes: 262144, maxTransferBytes: 16777216,
        maxRequests: 512, maxWriteRequests: 64, chunkBytes: 1024, requestTimeoutMs: 30000,
        deadline: new Date(now.getTime() + 600000).toISOString() },
      checkpoint: null
    };
    const phaseId = environment === 'staging' ? 'staging-qualified' : 'production-rehearsed';
    f.input.inspection.activationInputs!.phases[phaseId] = { registryPromotion: config };
    const input = { ...f.input, phase: canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)! };
    const calls = f.providers.requests.length;
    const source = await readApplicationRegistryPromotionSource(input);
    expect(source.provenance).toEqual(frontend.artifact.provenance);
    expect(source.reference.artifactSet?.role).toBe('frontend');
    expect(f.providers.requests).toHaveLength(calls);
    config.sourceBuild.artifactSet!.role = 'backend';
    await expect(readApplicationRegistryPromotionSource(input)).rejects.toThrow(/exact selected role/);
    expect(f.providers.requests).toHaveLength(calls);
  }, 90000);

  it.each(['missing-frontend', 'unknown-role', 'wrong-component', 'wrong-source', 'wrong-context', 'wrong-dockerfile',
    'workflow-alias', 'repository-alias', 'renderer-drift', 'budget-drift'] as const)('rejects %s configuration', async (kind) => {
    const f = await fixture(), config = f.setConfig as any;
    if (kind === 'missing-frontend') delete config.artifacts.frontend;
    if (kind === 'unknown-role') config.artifacts.worker = config.artifacts.backend;
    if (kind === 'wrong-component') config.artifacts.frontend.componentId = 'frontend';
    if (kind === 'wrong-source') config.artifacts.frontend.workflow.sourceSha = 'd'.repeat(40);
    if (kind === 'wrong-context') config.artifacts.frontend.build.context = 'backend';
    if (kind === 'wrong-dockerfile') config.artifacts.frontend.build.dockerfile = 'backend/Dockerfile';
    if (kind === 'workflow-alias') config.artifacts.frontend.workflow.workflowId = 4;
    if (kind === 'repository-alias') config.artifacts.frontend.build.registry.repository = config.artifacts.backend.build.registry.repository;
    if (kind === 'renderer-drift') config.artifacts.frontend.workflow.workflowDigest = 'c'.repeat(64);
    if (kind === 'budget-drift') config.artifacts.frontend.build.budget = { ...budget, usageMonthlyCents: 999 };
    expect(planApplicationArtifactSetReady(f.input)).toMatchObject({ operations: [], blockers: [expect.any(String)] });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.providers.requests).toHaveLength(0);
  });

  it.each(['missing-readback', 'extra-operation', 'missing-effect', 'foreign-destination', 'private-approval', 'expiry', 'lease'] as const)(
    'rejects %s authority before dispatching even the backend', async (kind) => {
      const f = await fixture();
      const operations = f.input.plan.operations as any[];
      if (kind === 'missing-readback') operations.pop();
      if (kind === 'extra-operation') operations.push(structuredClone(operations[0]));
      if (kind === 'missing-effect') operations[2].effects.pop();
      if (kind === 'foreign-destination') operations[2].effects[1].destination.identity = `${applicationRegistryId}other`;
      if (kind === 'private-approval') {
        const issued = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
          .read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(issued!.path);
      }
      if (kind === 'expiry') f.input.clock = () => new Date(now.getTime() + 3600_000);
      const denied = kind === 'lease' ? await executeApplicationArtifactSetReady(f.input) : await f.execute();
      expect(denied.status).toBe('blocked');
      expect(f.providers.requests).toHaveLength(0);
      expect(dispatches(f)).toHaveLength(0);
    }
  );

  it('rejects the legacy facade for a configured frontend rather than returning a backend deployment image', async () => {
    const f = await fixture();
    expect(() => applicationArtifactInputs(f.input)).toThrow(/frontend requires its own/u);
    expect(planApplicationArtifactReady(f.input)).toMatchObject({ operations: [], blockers: [expect.stringMatching(/frontend/u)] });
    expect(await withProjectMutationLock(f.projectRoot, (lease) => executeApplicationArtifactReady({ ...f.input, lease })))
      .toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.providers.requests).toHaveLength(0);
  });
});
