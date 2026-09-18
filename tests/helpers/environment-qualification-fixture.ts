import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { buildArtifacts } from '../../src/templates.js';
import { buildProjectPlan } from '../../src/application/project/planning.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity
} from '../../src/domain/governance/activation/graph.js';
import {
  evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../../src/domain/governance/activation/operations.js';
import {
  validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState
} from '../../src/domain/governance/activation/validators.js';
import { phaseIds, type ActivationConfiguration, type PhaseEvidenceRecord, type TransitionOperation } from '../../src/domain/governance/activation/types.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../../src/domain/governance/activation/evidence.js';
import { writeGovernanceApprovalAuthority } from '../../src/governance-activation/authority-records.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../../src/governance-activation/inputs.js';
import { loadActivationState } from '../../src/governance-activation/activation-state.js';
import { evidenceHeaderFor, readbackProof, saveTransitionPlan } from '../../src/governance-activation/transition-records.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput } from '../../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../../src/process-runner.js';
import type {
  GitHubActivationTransport, GitHubRequest, GitHubResponse
} from '../../src/adapters/github/activation-rest.js';
import { object } from '../../src/adapters/github/activation-rest.js';
import type { AzureArmRequest, AzureArmTransport } from '../../src/adapters/azure/activation-rest.js';
import { containerAppResourceId } from '../../src/adapters/azure/application-provisioning.js';
import { dispatchApprovedWorkflowRun, type WorkflowRunBinding } from '../../src/adapters/github/workflow-dispatch.js';
import { withProjectMutationLock } from '../../src/adapters/filesystem/project-lock.js';
import type { DisposableTargetConfig } from '../../src/application/azure-activation/qualification-authority.js';
import {
  environmentRuntimeJob, environmentRuntimeReportFile, environmentRuntimeStep, environmentRuntimeUploadStep,
  renderEnvironmentRuntimeWorkflow, type EnvironmentRuntimeRecipe, type EnvironmentRuntimeReport
} from '../../src/application/azure-activation/environment-runtime-workflow.js';
import { readEnvironmentRuntimeProof } from '../../src/application/azure-activation/environment-runtime-proof.js';
import { environmentRunnerAssignmentFixture } from './environment-runner-assignment-fixture.js';
import { environmentRuntimeRunnerReadEffects } from '../../src/application/azure-activation/environment-runtime-assignment.js';
import { environmentRuntimeInputs } from '../../src/application/azure-activation/environment-runtime-inputs.js';

export const environmentFixtureTime = '2026-09-15T00:00:00.000Z';
export const environmentFixturePrincipal = '77777777-8888-4999-8aaa-111111111111';
const producerSubscription = '11111111-2222-4333-8444-555555555555';
const producerTenant = '66666666-7777-4888-8999-000000000001';

export function environmentReportZip(
  content: Buffer, options: { name?: string; deflate?: boolean; descriptor?: boolean } = {}
): Buffer {
  const name = Buffer.from(options.name ?? environmentRuntimeReportFile);
  const compressed = options.deflate ? deflateRawSync(content) : content;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  const descriptor = Buffer.alloc(options.descriptor ? 16 : 0);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(options.descriptor ? 8 : 0, 6); local.writeUInt16LE(options.deflate ? 8 : 0, 8);
  local.writeUInt16LE(name.length, 26);
  if (options.descriptor) {
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc32(content), 4);
    descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(content.length, 12);
  } else {
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
  }
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(options.descriptor ? 8 : 0, 8); central.writeUInt16LE(options.deflate ? 8 : 0, 10);
  central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

export class EnvironmentWorkflowProtocol implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];
  readonly armRequests: AzureArmRequest[] = [];
  correlation = '';
  configurationDigest = '';
  dispatched = false;
  pending = false;
  loseDispatchResponse = false;
  hideRun = false;
  duplicateRun = false;
  duplicateArtifact = false;
  corruptArchive = false;
  reportMutation?: (report: EnvironmentRuntimeReport) => unknown;
  artifactMutation?: (metadata: Record<string, unknown>) => Record<string, unknown>;
  archiveMutation?: (bytes: Buffer) => Buffer;
  beforeRequest?: (request: GitHubRequest) => Promise<void>;
  readonly runId: number = 7412;
  readonly jobId: number = 8201;
  readonly checkId: number = 9201;
  readonly artifactId: number = 6201;
  runMutation: Record<string, unknown> = {};
  jobMutation: Record<string, unknown> = {};
  checkMutation: Record<string, unknown> = {};
  armAppMutation: Record<string, unknown> = {};
  armRevisionMutation: Record<string, unknown> = {};
  sourceContent: string;
  publishedSourceContent: string;
  currentActorId: number;
  currentRepositoryId: number;
  currentRefSha: string;
  runner = {
    id: 351, name: 'isolated-ephemeral-runner', groupId: 451,
    groupName: 'environment-test-group', labels: ['environment-test-linux']
  };
  effectTime = environmentFixtureTime;
  runnerFixture?: Awaited<ReturnType<typeof environmentRunnerAssignmentFixture>>;
  private requestCount = 0;

  constructor(
    readonly recipe: EnvironmentRuntimeRecipe, readonly workflow: WorkflowRunBinding,
    readonly imageRef: string, readonly revisionName: string,
    readonly clock: () => Date = () => new Date(environmentFixtureTime),
    readonly azurePrincipalId: string = environmentFixturePrincipal
  ) {
    this.sourceContent = renderEnvironmentRuntimeWorkflow(recipe);
    this.publishedSourceContent = this.sourceContent;
    this.currentActorId = workflow.actorId;
    this.currentRepositoryId = workflow.repositoryId;
    this.currentRefSha = workflow.sourceSha;
  }

  run() {
    return {
      id: this.runId, run_attempt: 1, workflow_id: this.workflow.workflowId, path: this.workflow.workflowPath,
      head_sha: this.workflow.sourceSha, head_branch: this.workflow.ref, event: 'workflow_dispatch',
      actor: { id: this.workflow.actorId }, triggering_actor: { id: this.workflow.actorId },
      repository: { id: this.workflow.repositoryId, full_name: this.workflow.repository },
      display_title: `liftoff-${this.correlation}`, check_suite_id: 5001,
      created_at: this.effectTime, updated_at: this.effectTime,
      status: this.pending ? 'in_progress' : 'completed', conclusion: this.pending ? null : 'success',
      ...this.runMutation
    };
  }

  job() {
    return {
      id: this.jobId, name: environmentRuntimeJob, run_id: this.runId, head_sha: this.workflow.sourceSha,
      check_run_url: `https://api.github.com/repos/${this.workflow.repository}/check-runs/${this.checkId}`,
      runner_id: this.runner.id, runner_group_id: this.runner.groupId,
      runner_name: this.runner.name, runner_group_name: this.runner.groupName, labels: this.runner.labels,
      status: 'completed', conclusion: 'success', started_at: this.effectTime, completed_at: this.effectTime,
      steps: [environmentRuntimeStep, environmentRuntimeUploadStep].map((name, index) =>
        ({ number: index + 1, name, status: 'completed', conclusion: 'success' })),
      ...this.jobMutation
    };
  }

  report(): EnvironmentRuntimeReport {
    return {
      schemaVersion: 1, kind: 'liftoff-environment-runtime',
      correlationId: this.correlation, configurationDigest: this.configurationDigest, recipeDigest: canonicalSha256(this.recipe),
      source: { repository: this.workflow.repository, repositoryId: this.workflow.repositoryId, commitSha: this.workflow.sourceSha },
      producer: {
        workflowId: this.workflow.workflowId, workflowPath: this.workflow.workflowPath, runId: this.runId,
        runAttempt: 1, actorId: this.workflow.actorId, jobId: this.jobId,
        runnerId: this.job().runner_id, runnerName: this.job().runner_name,
        runnerGroupId: this.job().runner_group_id, runnerGroupName: this.job().runner_group_name, labels: this.job().labels
      },
      target: { environment: this.recipe.environment, resourceId: this.recipe.resourceId, fqdn: this.recipe.fqdn },
      health: { path: this.recipe.healthPath, status: 200, mediaType: 'application/json',
        bodyDigest: canonicalSha256({ status: 'ok' }), statusValue: 'ok' },
      schema: { path: this.recipe.schemaPath, status: 200, mediaType: 'application/json',
        bodyDigest: canonicalSha256({ openapi: '3.1.0', paths: { '/api/v1/quote': {} } }),
        openapi: '3.1.0', paths: ['/api/v1/quote'] },
      observedAt: this.effectTime
    };
  }

  reportBytes(): Buffer {
    const report = this.report();
    return Buffer.from(`${JSON.stringify(this.reportMutation ? this.reportMutation(report) : report)}\n`);
  }

  archive(): Buffer {
    const archive = environmentReportZip(this.reportBytes(), { deflate: true, descriptor: true });
    return this.archiveMutation ? this.archiveMutation(archive) : archive;
  }

  artifact() {
    const archive = this.archive();
    const data = {
      id: this.artifactId, name: `liftoff-environment-${this.correlation}`, expired: false, size_in_bytes: archive.length,
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
      workflow_run: { id: this.runId, repository_id: this.workflow.repositoryId, head_repository_id: this.workflow.repositoryId,
        head_sha: this.workflow.sourceSha, head_branch: this.workflow.ref }
    };
    return this.artifactMutation ? this.artifactMutation(data) : data;
  }

  private reply(data: unknown, status = 200): GitHubResponse {
    return { status, data, headers: { 'x-github-request-id': `ABCD:1234:5678:${(++this.requestCount).toString(16).padStart(4, '0')}` } };
  }

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(structuredClone(request));
    await this.beforeRequest?.(request);
    const url = new URL(request.path, 'https://api.github.com');
    const endpoint = url.pathname;
    const root = `/repos/${this.workflow.repository}`;
    if (request.method === 'POST' && endpoint === `${root}/actions/workflows/${this.workflow.workflowId}/dispatches`) {
      const body = object(request.body), inputs = object(body.inputs);
      if (body.ref !== this.workflow.ref || typeof inputs.liftoff_operation_id !== 'string' ||
        typeof inputs.qualification_digest !== 'string') throw new Error('Fixture received an unbound dispatch.');
      this.dispatched = true;
      this.effectTime = this.clock().toISOString();
      this.correlation = inputs.liftoff_operation_id;
      this.configurationDigest = inputs.qualification_digest;
      if (this.loseDispatchResponse) {
        this.loseDispatchResponse = false;
        throw new Error('Isolated protocol fixture lost the dispatch response.');
      }
      return this.reply({
        workflow_run_id: this.runId,
        run_url: `https://api.github.com${root}/actions/runs/${this.runId}`,
        html_url: `https://github.com/${this.workflow.repository}/actions/runs/${this.runId}`
      });
    }
    if (request.method !== 'GET') throw new Error(`Unregistered fixture mutation: ${request.method} ${endpoint}`);
    if (endpoint === root) return this.reply({
      id: this.currentRepositoryId, full_name: this.workflow.repository, private: true,
      archived: false, disabled: false, owner: { id: 7 }
    });
    if (endpoint === '/user') return this.reply({ id: this.currentActorId });
    if (endpoint === `${root}/git/ref/heads/${this.workflow.ref}`) return this.reply({
      ref: `refs/heads/${this.workflow.ref}`, object: { type: 'commit', sha: this.currentRefSha }
    });
    if (endpoint === `${root}/actions/workflows/${this.workflow.workflowId}`) return this.reply({
      id: this.workflow.workflowId, path: this.workflow.workflowPath, state: 'active'
    });
    if (endpoint === `${root}/contents/${this.workflow.workflowPath}`) {
      const content = this.workflow.producerSourceSha !== this.workflow.sourceSha &&
        url.searchParams.get('ref') === this.workflow.producerSourceSha ? this.publishedSourceContent : this.sourceContent;
      return this.reply({
        type: 'file', path: this.workflow.workflowPath, encoding: 'base64',
        content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content),
        sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex')
      });
    }
    if (endpoint === `${root}/actions/workflows/${this.workflow.workflowId}/runs`) {
      const runs = !this.dispatched || this.hideRun ? [] : this.duplicateRun ? [this.run(), { ...this.run(), id: this.runId + 1 }] : [this.run()];
      return this.reply({ total_count: runs.length, workflow_runs: runs });
    }
    const runRoot = `${root}/actions/runs/${this.runId}`;
    if (endpoint === runRoot || endpoint === `${runRoot}/attempts/1`) return this.reply(this.run(), this.hideRun ? 404 : 200);
    if (endpoint === `${runRoot}/attempts/1/jobs`) return this.reply({ total_count: 1, jobs: [this.job()] });
    if (endpoint === `${root}/check-runs/${this.checkId}`) return this.reply({
      id: this.checkId, name: environmentRuntimeJob, head_sha: this.workflow.sourceSha,
      status: 'completed', conclusion: this.job().conclusion, check_suite: { id: 5001 },
      app: { id: 15368, slug: 'github-actions' }, output: {}, ...this.checkMutation
    });
    if (endpoint === `${runRoot}/artifacts`) {
      const artifacts = this.duplicateArtifact ? [this.artifact(), { ...this.artifact(), id: this.artifactId + 1 }] : [this.artifact()];
      return this.reply({ total_count: artifacts.length, artifacts });
    }
    if (endpoint === `${root}/actions/artifacts/${this.artifactId}`) return this.reply(this.artifact());
    if (endpoint === `${root}/actions/artifacts/${this.artifactId}/zip` && request.binary) {
      const archive = this.archive();
      if (this.corruptArchive) archive[0] = archive[0]! ^ 1;
      return this.reply(archive);
    }
    const prerequisite = this.runnerFixture;
    if (prerequisite && (endpoint === '/orgs/owner' || endpoint.startsWith('/orgs/owner/') ||
      endpoint === `${root}/contents/${prerequisite.source.recipe.workflowPath}` ||
      [`${root}/actions/workflows/${prerequisite.source.workflowId}`,
        `${root}/actions/runs/${prerequisite.http.state.runId}`, `${root}/actions/artifacts/987`]
        .some((base) => endpoint === base || endpoint.startsWith(`${base}/`)) ||
      endpoint === `${root}/check-runs/899`)) {
      return prerequisite.http.client.transport.request(request);
    }
    throw new Error(`Unexpected environment protocol request ${request.method} ${request.path}`);
  }

  readonly arm: AzureArmTransport = { request: async (request, binding) => {
    this.armRequests.push(structuredClone(request));
    if (request.method !== 'GET' || binding.principalId !== this.azurePrincipalId ||
      binding.subscriptionId !== producerSubscription || binding.tenantId !== producerTenant) {
      throw new Error('Fixture forbids ARM mutations and unbound principal/target access.');
    }
    if (request.resourceId === this.recipe.resourceId) return {
      status: 200, requestId: 'aaaa1111-2222-4333-8444-555555555555',
      data: { id: request.resourceId, type: 'Microsoft.App/containerApps', properties: {
        provisioningState: 'Succeeded', latestReadyRevisionName: this.revisionName,
        configuration: { ingress: { fqdn: this.recipe.fqdn, traffic: [{ revisionName: this.revisionName, weight: 100 }] } },
        ...this.armAppMutation
      } }
    };
    if (request.resourceId === `${this.recipe.resourceId}/revisions/${this.revisionName}`) return {
      status: 200, requestId: 'bbbb1111-2222-4333-8444-555555555555',
      data: { id: request.resourceId, type: 'Microsoft.App/containerApps/revisions', properties: {
        active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running',
        template: { containers: [{ name: 'application', image: this.imageRef }] }, ...this.armRevisionMutation
      } }
    };
    throw new Error(`Unregistered fixture ARM resource ${request.resourceId}`);
  } };
}

export async function environmentQualificationFixture(options: {
  phaseId?: 'dev-proof' | 'staging-qualified';
  producerSourceSha?: string;
  approvedAt?: string;
  approvalExpiresAt?: string;
  planExpiresAt?: string;
  observedRunnerId?: number;
  runnerReadEffects?: boolean;
} = {}) {
  const phaseId = options.phaseId ?? 'staging-qualified';
  const environment = phaseId === 'dev-proof' ? 'dev' : 'staging';
  const target: DisposableTargetConfig = {
    authorityKind: 'disposable-operator-qualification',
    target: {
      environment, subscriptionId: producerSubscription, tenantId: producerTenant,
      resourceGroup: 'rg-environment-test', appName: 'environment-test',
      resourceId: containerAppResourceId(producerSubscription, 'rg-environment-test', 'environment-test')
    },
    actor: { operator: 'isolated-environment-test-operator', githubActorId: 7, azurePrincipalId: environmentFixturePrincipal },
    spendCeilingCents: 125, maxDurationMinutes: 15,
    permittedEffects: ['github-workflow-dispatch', 'github-read', 'azure-read'],
    notBefore: environmentFixtureTime, expiresAt: '2026-09-15T00:15:00.000Z'
  };
  const recipe: EnvironmentRuntimeRecipe = {
    workflowPath: `.github/workflows/liftoff-environment-${environment}.yml`, environment,
    resourceId: target.target.resourceId, fqdn: 'environment-test.fixture.eastus.azurecontainerapps.io',
    healthPath: '/health', schemaPath: '/openapi.json',
    runner: { group: 'environment-test-group', label: 'environment-test-linux' },
    uploadArtifactActionSha: 'f'.repeat(40)
  };
  const workflow: WorkflowRunBinding & { producerSourceSha: string } = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: recipe.workflowPath, workflowId: 41,
    workflowDigest: canonicalSha256(renderEnvironmentRuntimeWorkflow(recipe)), sourceSha: 'c'.repeat(40),
    producerSourceSha: options.producerSourceSha ?? 'c'.repeat(40), ref: 'develop', actorId: 7, event: 'workflow_dispatch',
    expectedJobs: [environmentRuntimeJob], runAttempt: 1
  };
  const runtime = { recipe, imageRef: `fixture.azurecr.io/application@sha256:${'d'.repeat(64)}`, revisionName: 'environment-test--candidate-01' };
  const runner: CommandRunner = { async run(command) {
    if (command.executable !== 'git') throw new Error('Fixture must not invoke live provider or credential commands.');
    return { command, status: 128, signal: null, stdout: '', stderr: '', displayCommand: 'isolated non-Git fixture', timedOut: false };
  } };
  const root = path.resolve(`tests/.environment-qualification-${randomUUID()}`);
  const projectRoot = path.join(root, 'project'), home = path.join(root, 'home');
  const now = new Date(environmentFixtureTime);
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  await mkdir(root, { mode: 0o700 });
  const creation = await lstat(root);
  const pending = new Set<Promise<unknown>>();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    if (pending.size) throw new Error(`Retain fixture while its owning operations are not settled: ${root}`);
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== creation.dev ||
      current.ino !== creation.ino || current.birthtimeMs !== creation.birthtimeMs) {
      throw new Error(`Retain fixture because its exact directory creation identity changed: ${root}`);
    }
    await rm(root, { recursive: true });
    cleaned = true;
  };
  try {
    await mkdir(projectRoot, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await mkdir(path.join(projectRoot, 'governance'), { mode: 0o700 });
    const generated = buildArtifacts(buildProjectPlan({
      projectName: 'Environment protocol fixture', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
      region: 'eastus', environments: ['dev', 'staging', 'prod'], includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot']
    }, { requireProjectName: true })).find((artifact) => artifact.logicalName === 'manifest');
    if (!generated) throw new Error('Actual generated manifest missing.');
    const manifest = parseManifest(JSON.parse(generated.content));
    const configuration: ActivationConfiguration = {
      schemaVersion: 1, azure: { subscriptionId: producerSubscription, tenantId: producerTenant, region: 'eastus' },
      phases: { [phaseId]: { disposableTarget: target } }
    };
    const state = validateUserActivationState({
      schemaVersion: 4, identity: currentActivationIdentity,
      repository: { id: `local:${randomUUID()}`, name: 'environment-protocol-fixture', defaultBranch: 'develop' },
      remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop',
        pushUrl: 'https://github.com/owner/repo.git', verifiedAt: environmentFixtureTime },
      activeChange: null,
      applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false,
        cloudStateRequired: true, privateRunnerRequired: false },
      activationInputs: configuration,
      phases: Object.fromEntries(phaseIds.map((id) => [id, {
        state: 'pending', updatedAt: environmentFixtureTime, evidence: [], approvals: [], blockers: []
      }])),
      createdAt: environmentFixtureTime, updatedAt: environmentFixtureTime
    });
    await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
    await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
    const snapshot = await readActivationInputSnapshot(projectRoot, manifest, runner);
    const inspection: GovernanceTransitionInspection = {
      projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'activation',
      activationInputs: configuration, state, loadedState: await loadActivationState(projectRoot),
      approvals: [], evidence: [], contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
      readiness: { nextReadyPhase: null, nextPlannablePhase: phaseId, phases: state.phases },
      sourceOfTruth: {
        status: 'none', selected: null, candidates: [],
        createPlan: { status: 'blocked', changeId: 'environment-protocol-fixture', workflowKind: 'openspec',
          reason: 'Protocol behavior under real private issuance is not live environment qualification.', requiredFacts: [] }
      }
    };
    const f = { root, projectRoot, home, now, storage, inspection, cleanup };
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
    const runnerPhase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'runner-ready')!;
    const runnerFixture = await environmentRunnerAssignmentFixture({
      inspection, phase: runnerPhase, runner, now,
      adapters: { githubActivation: { storage }, azureActivation: { storage } }
    }, {
      schemaVersion: 1, kind: 'environment-runtime', repository: workflow.repository, repositoryId: workflow.repositoryId,
      workflowId: workflow.workflowId, workflowDigest: workflow.workflowDigest, sourceSha: workflow.producerSourceSha,
      ref: workflow.ref, actorId: workflow.actorId, recipe
    });
    const runnerAssignment = { reference: runnerFixture.reference, binding: runnerFixture.binding };
    const dispatchInputs = { qualification_digest: canonicalSha256({ workflow, disposableTarget: target, runnerAssignment, runtime }) };
    const inputs = { workflow, disposableTarget: target, runnerAssignment, runtime, dispatchInputs };
    await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(inspection.state));
    inspection.loadedState = await loadActivationState(projectRoot);
    const runtimeSnapshot = await readActivationInputSnapshot(projectRoot, manifest, runner);
    inspection.contexts[phaseId] = activationEvidenceContexts(canonicalPhaseGraph, inspection.state, runtimeSnapshot, now)[phaseId];
    const destination = { type: 'repository' as const, identity: workflow.repository, repository: workflow.repository };
    const dispatch: TransitionOperation = {
      phaseId: phase.id, adapter: 'github', actionId: phaseId === 'dev-proof' ? 'github.checks.dev-proof' : 'github.checks.staging',
      mutationClass: 'github-workflow-dispatch',
      inputs, destination, remote: true, destructive: false,
      effects: [
        { mutationClass: 'github-read', destination, remote: true, destructive: false },
        ...(options.runnerReadEffects === false ? [] : environmentRuntimeRunnerReadEffects(environmentRuntimeInputs(inputs)))
      ]
    };
    const readback: TransitionOperation = {
      phaseId: phase.id, adapter: 'azure-opentofu', actionId: phaseId === 'dev-proof' ? 'azure.dev.readback' : 'azure.staging.readback',
      mutationClass: 'azure-read',
      inputs, destination: { type: 'subscription', identity: target.target.resourceId, subscriptionId: producerSubscription },
      remote: true, destructive: false
    };
    const operations = [dispatch, readback];
    const context = f.inspection.contexts[phase.id];
    const requested = transitionPlanForPhase(phase, f.inspection.state, context.transition, f.projectRoot, undefined, {
      operations, configuration: f.inspection.activationInputs, selectionScope: 'activation', fileChanges: [], recovery: false
    });
    const envelope = validateApprovalEnvelope({
      ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: options.approvedAt ?? environmentFixtureTime,
      expiresAt: options.approvalExpiresAt ?? target.expiresAt, approver: target.actor.operator
    });
    now.setTime(Date.parse(envelope.approvedAt));
    await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(requested), envelope, f.storage);
    f.inspection.approvals = [envelope];
    const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: f.now });
    const plan = validateSavedTransitionPlan({
      schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
      createdAt: environmentFixtureTime, expiresAt: options.planExpiresAt ?? target.expiresAt,
      identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash, stateHash: f.inspection.loadedState!.contentHash,
      baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
      planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
      mutationClasses: phase.allowedMutations, operations,
      approval: { gateKind: phase.approvalGate.kind, required: true, evaluation, envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
      rollbackPlan: rollbackPlanForPhase(phase), fileChanges: [], recovery: false, noSecrets: true,
      configuration: f.inspection.activationInputs
    });
    await saveTransitionPlan(f.projectRoot, plan);
    const protocol = new EnvironmentWorkflowProtocol(recipe, workflow, runtime.imageRef, runtime.revisionName, () => now);
    protocol.runnerFixture = runnerFixture;
    protocol.runner.groupId = runnerFixture.binding.groupId;
    if (options.observedRunnerId !== undefined) protocol.runner.id = options.observedRunnerId;
    const input: PhaseAdapterExecutionInput = {
      inspection: f.inspection, plan, phase, runner, now: f.now,
      adapters: { githubActivation: { storage: f.storage, transport: protocol }, azureActivation: { storage: f.storage, transport: protocol.arm } }
    };
    const leased = <T>(action: (execution: PhaseAdapterExecutionInput) => Promise<T>) => {
      const operation = withProjectMutationLock(f.projectRoot, (lease) => action({ ...input, lease }));
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    const dispatchRun = () => leased((execution) => dispatchApprovedWorkflowRun(execution, dispatch, workflow, dispatchInputs));
    const observe = () => leased((execution) => readEnvironmentRuntimeProof(execution, dispatch));
    const boundReceipt = (payload: Record<string, unknown>) => {
      const body = { ...payload, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan) };
      const liveReadback = [
        readbackProof(input, 'github', 'workflow-run', `/repos/${workflow.repository}/actions/runs/${protocol.runId}`, body),
        readbackProof(input, 'azure', 'containerApp', target.target.resourceId, body)
      ];
      const header = evidenceHeaderFor({ inspection: f.inspection, phase, plan, result: 'verified', now: f.now, payload: body, liveReadback });
      const record: PhaseEvidenceRecord = { evidenceId: randomUUID(), header, payload: body, liveReadback };
      const reference = { evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(header), bodyDigest: evidenceBodyDigest(body, liveReadback) };
      const stateReference = { evidenceId: record.evidenceId, phaseId: phase.id, pathParts: ['governance', 'evidence', `${record.evidenceId}.json`],
        headerDigest: reference.headerDigest, producedAt: header.producedAt, result: header.result };
      f.inspection.evidence = [...f.inspection.evidence.filter((entry) => entry.header.phaseId !== phase.id), record];
      f.inspection.contexts[phase.id] = { ...f.inspection.contexts[phase.id], reviewedPlans: [plan], evidenceReferences: [stateReference] };
      return { record, reference };
    };
    return {
      ...f, input, target, recipe, workflow, runtime, runnerAssignment, runnerFixture,
      dispatchInputs, dispatch, readback, envelope, protocol, leased, dispatchRun, observe, boundReceipt
    };
  } catch (error) { await cleanup(); throw error; }
}
