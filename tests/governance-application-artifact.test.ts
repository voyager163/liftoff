import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildSavedTransitionPlan, canonicalSha256, canonicalPhaseGraph, evidenceBodyDigest, evidenceHeaderDigest,
  executeApplyNext, validateEvidenceFreshness, type PhaseEvidenceRecord, type PhaseId
} from '../src/governance-activation/index.js';
import {
  applicationArtifactBinding, executeApplicationArtifactPublication,
  observeImmutableApplicationArtifact, readVerifiedApplicationArtifact
} from '../src/governance-activation/application-artifact.js';
import {
  applicationPrerequisiteBinding, executeApplicationPrerequisites
} from '../src/governance-activation/application-prerequisites.js';
import {
  applicationDeadlineInput, applicationProtectionBlocker, assertApplicationAuthority,
  observeApplicationProtection
} from '../src/governance-activation/application-readiness.js';
import { protectedStateCustodyRequest } from '../src/governance-activation/protected-state-handover.js';
import { loadActivationState, writeActivationState } from '../src/governance-activation/activation-state.js';
import { readReviewedTransitionPlans } from '../src/governance-activation/proof-records.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { protectedStateCustodyIdentityDigest } from '../src/governance-activation/protected-state-custody.js';
import { readbackProof } from '../src/governance-activation/transition-records.js';
import { nativeStateHostId } from '../src/adapters/state/native-system.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { NodeCommandRunner, type CommandRunner, type CommandResult, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../src/adapters/github/activation-rest.js';
import { GitHubActivationError } from '../src/adapters/github/activation-rest.js';
import type {
  PhaseAdapterExecutionInput, ProtectedStateCustodyProof, ProtectedStateCustodyPort, ProtectedStateHandoverPort
} from '../src/governance-activation/transition-ports.js';
import {
  coverageNow, coveragePrincipal, coverageSubscription, coverageTenant, coverageInspection,
  isolateUserLocalStorage, isolatedGitEnvironment, issuePriorApproval, readState, scratchDirectory, resetDirectory, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';
import {
  applicationPlanningFixture, applicationFixtureClient, applicationFixtureWorkloadClient, applicationFixtureWorkloadPrincipal
} from './fixtures/governance-coverage/application-project.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import {
  applicationArtifactContextStep, applicationContextDirectory
} from '../src/governance-activation/application-artifact-context-recipe.js';

const scratch = scratchDirectory('application-artifact');
const imageDigest = `sha256:${'d'.repeat(64)}`;
let storage: Awaited<ReturnType<typeof isolateUserLocalStorage>>;
let gitEnvironment: NodeJS.ProcessEnv;
let counter = 0;
beforeAll(async () => {
  await resetDirectory(scratch);
  storage = await isolateUserLocalStorage();
  gitEnvironment = await isolatedGitEnvironment(scratch);
});
afterAll(async () => { await storage.restore(); await rm(scratch, { recursive: true, force: true }); });

function result(command: ExternalCommand, value: unknown): CommandResult {
  return { command, displayCommand: command.executable, status: 0, signal: null,
    stdout: JSON.stringify(value), stderr: '', timedOut: false };
}
function argument(command: ExternalCommand, key: string) { return command.args[command.args.indexOf(key) + 1]!; }

class ApplicationRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  options: RunCommandOptions[] = [];
  prerequisite?: ReturnType<typeof applicationPrerequisiteBinding>;
  artifact?: ReturnType<typeof applicationArtifactBinding>;
  inventory: { id: string; type: string }[] = [];
  deploymentState = 'Succeeded';
  deployedTemplate: unknown;
  permissions = ['*'];
  permissionExclusions: string[] = [];
  providerRegistered = true;
  validationState = 'Succeeded';
  occupied = false;
  failPoll = false;
  onValidation: (() => void) | undefined;
  onDeploymentRead: (() => Promise<void>) | undefined;
  onExport: (() => Promise<void>) | undefined;
  failExport = false;
  onManifestRead: (() => void) | undefined;
  actualDigest = imageDigest;
  tagMutable = false;
  attestationRun = '901';
  attestationSource: string | undefined;
  private readonly native = new NodeCommandRunner();
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.calls.push(command); this.options.push(options ?? {});
    const key = command.args.join(' ');
    if (command.executable === 'git') return this.native.run(command, { ...options, env: { ...options?.env, ...gitEnvironment } });
    if (command.executable === 'tofu') return result(command, {
      terraform_version: '1.12.6',
      platform: `${process.platform === 'win32' ? 'windows' : process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`
    });
    if (command.executable === 'gh' && key.startsWith('attestation verify ')) {
      const binding = this.artifact!;
      return result(command, [{ verificationResult: {
        signature: { certificate: { extensions: {
          runInvocationURI: `https://github.com/owner/repo/actions/runs/${this.attestationRun}/attempts/1`,
          buildSignerDigest: this.attestationSource ?? binding.sourceSha,
          sourceRepositoryDigest: binding.sourceSha, sourceRepositoryIdentifier: '123',
          sourceRepositoryURI: 'https://github.com/owner/repo', runnerEnvironment: 'github-hosted', buildTrigger: 'workflow_dispatch'
        } } }, verifiedTimestamps: [{ type: 'transparency-log' }],
        statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ digest: { sha256: imageDigest.slice(7) } }] }
      } }]);
    }
    if (command.executable !== 'az') throw new Error(`Unexpected fixture command ${command.executable}`);
    if (key.startsWith('account show ')) return result(command, {
      id: coverageSubscription, tenantId: coverageTenant, state: 'Enabled', environmentName: 'AzureCloud',
      user: { type: 'servicePrincipal', name: applicationFixtureClient }
    });
    if (key.startsWith('ad sp show ')) return result(command, {
      id: coveragePrincipal, appId: applicationFixtureClient, servicePrincipalType: 'Application', accountEnabled: true
    });
    if (key.startsWith('cloud show ')) return result(command, {
      name: 'AzureCloud', resourceManager: 'https://management.azure.com/', resourceManagerAudience: 'https://management.core.windows.net/'
    });
    if (key.startsWith('group exists ')) return result(command, true);
    if (key.startsWith('group show ')) return result(command, {
      id: this.prerequisite!.groupId, name: this.prerequisite!.resourceGroup, location: 'eastus',
      managedBy: null, provisioningState: 'Succeeded', tags: {}
    });
    if (key.startsWith('resource list ')) return result(command, this.inventory.map((entry) =>
      ({ ...entry, name: entry.id.split('/').at(-1), location: 'eastus', managedBy: null })));
    if (key.includes('Microsoft.Authorization/permissions')) return result(command, {
      value: [{ actions: this.permissions, notActions: this.permissionExclusions }]
    });
    if (key.startsWith('provider show ')) return result(command, {
      id: `/subscriptions/${coverageSubscription}/providers/${argument(command, '--namespace')}`,
      namespace: argument(command, '--namespace'), registrationState: this.providerRegistered ? 'Registered' : 'NotRegistered'
    });
    if (key.startsWith('deployment sub list ')) return result(command, this.occupied ? [{ id: this.prerequisite!.deploymentId }] : []);
    if (key.startsWith('deployment sub export ')) {
      await this.onExport?.();
      if (this.failExport) return { ...result(command, null), status: 1, stderr: 'secret-provider-diagnostics' };
      return result(command, this.deployedTemplate);
    }
    if (key.startsWith('rest --method POST ') && key.includes('/validate?')) {
      this.onValidation?.();
      return result(command, { properties: { provisioningState: this.validationState } });
    }
    if (key.startsWith('rest --method PUT ')) {
      this.deployedTemplate = JSON.parse(argument(command, '--body')).properties.template;
      return result(command, { id: this.prerequisite!.deploymentId });
    }
    if (key.startsWith('rest --method GET ') && key.includes('/deployments/')) {
      await this.onDeploymentRead?.();
      if (this.failPoll) return { ...result(command, null), status: 1, stderr: 'secret-provider-diagnostics' };
      return result(command, { id: this.prerequisite!.deploymentId, name: this.prerequisite!.deploymentName,
        properties: { provisioningState: this.deploymentState } });
    }
    if (key.startsWith('acr show ')) return result(command, {
      id: this.prerequisite!.registryId, name: this.prerequisite!.registryName, location: 'eastus', sku: 'Basic',
      adminUserEnabled: false, provisioningState: 'Succeeded', loginServer: `${this.prerequisite!.registryName}.azurecr.io`,
      tags: { 'liftoff-binding': this.prerequisite!.bindingDigest, 'liftoff-environment': this.prerequisite!.environment,
        'unrelated-sensitive-tag': 'withheld-fixture-value' }
    });
    if (key.startsWith('identity show ')) return result(command, {
      id: this.prerequisite!.identityId, name: this.prerequisite!.identityName, location: 'eastus',
      tenantId: coverageTenant, principalId: applicationFixtureWorkloadPrincipal, clientId: applicationFixtureWorkloadClient,
      tags: { 'liftoff-binding': this.prerequisite!.bindingDigest, 'liftoff-environment': this.prerequisite!.environment }
    });
    if (key.includes('/roleAssignments/')) {
      const role = this.prerequisite!.roles.find((entry) => argument(command, '--url').includes(entry.id))!;
      return result(command, { id: role.id, properties: { scope: this.prerequisite!.registryId, roleDefinitionId: role.roleDefinitionId,
        principalId: role.principal === 'workload-identity' ? applicationFixtureWorkloadPrincipal : coveragePrincipal, principalType: 'ServicePrincipal' } });
    }
    if (key.startsWith('acr repository list ')) return result(command, []);
    if (key.startsWith('acr repository show ')) {
      this.onManifestRead?.();
      return result(command, {
        digest: this.actualDigest, name: argument(command, '--image'), changeableAttributes: { writeEnabled: this.tagMutable, deleteEnabled: false }
      });
    }
    if (key.startsWith('acr task show-run ')) return result(command, {
      runId: 'ca1', runType: 'QuickBuild', status: 'Succeeded',
      outputImages: [{ registry: this.artifact!.loginServer, repository: this.artifact!.imageRepository,
        tag: this.artifact!.tag, digest: this.actualDigest }]
    });
    if (key.startsWith('rest --method GET ')) return result(command, {
      subscriptionId: coverageSubscription, tenantId: coverageTenant, state: 'Enabled'
    });
    throw new Error(`Unexpected fixture Azure shape: ${key}`);
  }
  get writes() { return this.calls.filter((command) => command.executable === 'az' && command.args.includes('PUT')); }
}

class ArtifactTransport implements GitHubActivationTransport {
  calls: GitHubRequest[] = [];
  binding!: ReturnType<typeof applicationArtifactBinding>;
  workflow = '';
  dispatched = false;
  runStatus = 'completed';
  conclusion = 'success';
  duplicate = false;
  invisible = false;
  movedSource = false;
  executionTagPresent = true;
  executionTagProtected = true;
  executionTagBypass = false;
  executionTagSha: string | undefined;
  executionTreeSha: string | undefined;
  providerScopes = 'repo, workflow';
  runnerUsesBranch = false;
  dispatchResponse: Record<string, unknown> | null = {
    workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
    html_url: 'https://github.com/owner/repo/actions/runs/901'
  };
  onRunRead: (() => Promise<void>) | undefined;
  onJobsRead: (() => Promise<void>) | undefined;
  onDispatch: (() => void) | undefined;
  onExecutionTagRead: (() => void) | undefined;
  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.calls.push(request);
    let data: unknown;
    if (request.path.includes('/contents/')) data = {
      type: 'file', encoding: 'base64', path: this.binding.workflowPath, content: Buffer.from(this.workflow).toString('base64')
    };
    else if (request.path.includes('/git/ref/tags/')) {
      this.onExecutionTagRead?.();
      if (!this.executionTagPresent) return { status: 404, headers: {}, data: null };
      data = { ref: `refs/tags/${this.binding.executionRef}`,
        object: { type: 'commit', sha: this.executionTagSha ?? this.binding.sourceSha } };
    }
    else if (request.path.includes('/git/ref/')) data = { object: { sha: this.movedSource ? 'f'.repeat(40) : this.binding.sourceSha } };
    else if (request.path.includes('/git/commits/')) data = {
      sha: this.binding.sourceSha, tree: { sha: this.executionTreeSha ?? this.binding.sourceTreeSha }
    };
    else if (request.path.includes('/rulesets?includes_parents=true')) data = this.executionTagProtected ? [{
      id: 11, source_type: 'Repository', source: this.binding.repository
    }] : [];
    else if (request.path.endsWith('/rulesets/11')) data = {
      id: 11, source_type: 'Repository', source: this.binding.repository, target: 'tag', enforcement: 'active',
      bypass_actors: this.executionTagBypass ? [{ actor_id: 1 }] : [],
      conditions: { ref_name: { include: ['refs/tags/liftoff-execution-*'], exclude: [] } },
      rules: [{ type: 'update' }, { type: 'deletion' }]
    };
    else if (request.path === '/repos/owner/repo') data = {
      id: 123, full_name: this.binding.repository, permissions: { push: true }
    };
    else if (request.path.includes('/runner-groups/')) data = {
      id: 333, name: this.binding.runnerGroupName, network_configuration_id: 'NC_fixture', restricted_to_workflows: true,
      selected_workflows: [this.runnerUsesBranch
        ? `owner/repo/${this.binding.workflowPath}@refs/heads/develop`
        : `owner/repo/${this.binding.workflowPath}@refs/tags/${this.binding.executionRef}`]
    };
    else if (request.method === 'POST') {
      this.dispatched = true;
      this.onDispatch?.();
      return { status: this.dispatchResponse ? 200 : 204, headers: {}, data: this.dispatchResponse };
    } else if (request.path.includes('/jobs')) {
      await this.onJobsRead?.();
      data = { total_count: 1, jobs: [{
        id: 902, name: 'Liftoff application artifact', runner_id: 444, runner_group_id: 333,
        conclusion: this.conclusion, steps: [{ name: `Liftoff artifact ${imageDigest} run ca1`, conclusion: 'success' }]
      }] };
    }
    else if (request.path.includes('/workflows/')) {
      const runs = this.dispatched && !this.invisible ? [this.run()] : [];
      if (this.duplicate && runs.length) runs.push(this.run());
      data = { total_count: runs.length, workflow_runs: runs };
    } else { await this.onRunRead?.(); data = this.run(); }
    return { status: 200, headers: { 'x-oauth-scopes': this.providerScopes }, data };
  }
  run() { return {
    id: 901, head_sha: this.binding.sourceSha, head_branch: this.binding.executionRef, path: this.binding.workflowPath,
    display_title: this.binding.runTitle, event: 'workflow_dispatch', run_attempt: 1, repository: { id: 123 },
    created_at: coverageNow.toISOString(), status: this.runStatus, conclusion: this.conclusion
  }; }
}

function record(input: PhaseAdapterExecutionInput, id: PhaseId, payload: Record<string, unknown>, resources = input.inspection.state.phaseOutputs?.[id]?.resources ?? []): PhaseEvidenceRecord {
  const context = input.inspection.contexts[id];
  const proofInput = { ...input, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === id)! };
  const liveReadback = resources.map((resource) => readbackProof(proofInput, resource.provider, resource.resourceType, resource.resourceId, { fixture: true }));
  const body = { ...payload, ...(input.inspection.state.phaseOutputs?.[id] ? { outputBindings: input.inspection.state.phaseOutputs[id] } : {}) };
  const header = { schemaVersion: 3 as const, repositoryId: context.repositoryId, identity: context.identity,
    phaseGraphHash: context.phaseGraphHash, phaseId: id, phaseContractDigest: context.phaseContractDigest,
    inputDigest: context.inputDigest, baselineSha: context.baselineSha, transition: context.transition,
    producedAt: coverageNow.toISOString(), producer: 'isolated-application-fixture', bodyDigest: evidenceBodyDigest(body, liveReadback), result: 'verified' as const,
    ...(context.remoteBindingDigest ? { remoteBindingDigest: context.remoteBindingDigest } : {}) };
  const evidence = { evidenceId: `${id}-isolated-fixture`, header, payload: body, liveReadback };
  input.inspection.state.phases[id].evidence = [{ phaseId: id, evidenceId: evidence.evidenceId, headerDigest: evidenceHeaderDigest(header), result: 'verified' }];
  context.evidenceReferences = input.inspection.state.phases[id].evidence;
  return evidence;
}

async function fixture(artifact = false, rootContext = false,
  contextRecipe: 'exact' | 'missing' | 'wrong-directory' | 'changed-projection' = 'exact',
  publication: 'accepted' | 'fresh' = 'accepted') {
  const root = await writeCoverageProject(path.join(scratch, `${++counter}`));
  const runner = new ApplicationRunner();
  const f = await applicationPlanningFixture(root, artifact ? 'application-artifact-ready' : 'application-prerequisites-ready', runner);
  runner.prerequisite = f.prerequisite;
  const transport = new ArtifactTransport();
  if (artifact) {
    let contextPaths: string[] | undefined;
    if (rootContext) {
      const generated = buildArtifacts(buildProjectPlan({
        projectName: 'coverage', projectType: 'standard', apiStack: 'node-fastify',
        cloud: 'azure', region: 'eastus', environments: ['dev'], includeFrontend: false,
        specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'single-maintainer-gitflow'
      }, { requireProjectName: true }));
      const source = generated.filter(file => file.logicalName === 'backend-dockerfile' ||
        file.logicalName === 'root-dockerignore' || ['backend', 'database'].includes(file.pathParts[0]!));
      for (const file of [...source, generated.find(file => file.logicalName === 'manifest')!]) {
        const target = path.join(root, ...file.pathParts);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      contextPaths = source.map(file => file.pathParts.join('/'));
      f.inputs.phases['application-artifact-ready'] = { ...f.inputs.phases['application-artifact-ready'],
        contextPath: '.', contextPaths, dockerfilePath: 'Dockerfile' };
    }
    const projection = contextPaths ? applicationArtifactContextStep(contextPaths) : undefined;
    if (projection && contextRecipe === 'changed-projection') projection.run += '\nprintf changed-projection\\n';
    const steps = projection ? [
      ...(contextRecipe === 'missing' ? [] : [projection]),
      { run: 'echo isolated fixture only', 'working-directory': contextRecipe === 'wrong-directory'
        ? '${{ github.workspace }}' : applicationContextDirectory }
    ] : [{ run: 'echo isolated fixture only' }];
    const inputs = ['binding_digest', 'source_sha', 'context_path', 'dockerfile_path', 'image_repository', 'image_tag',
      'registry_id', 'client_id', 'subscription_id', 'tenant_id', 'environment'];
    transport.workflow = stringify({
      name: 'Reviewed fixture build', 'run-name': 'Liftoff application artifact ${{ inputs.binding_digest }}',
      concurrency: { group: 'liftoff-application-artifact-${{ inputs.binding_digest }}', 'cancel-in-progress': false },
      on: { workflow_dispatch: { inputs: Object.fromEntries(inputs.map((id) => [id, { type: 'string', required: true }])) } },
      jobs: { publish: {
        name: 'Liftoff application artifact', if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
        'runs-on': { group: f.runnerPlan.runnerGroupName, labels: [f.runnerPlan.label] }, 'timeout-minutes': 15,
        steps
      } }
    });
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await mkdir(path.join(root, 'backend'), { recursive: true });
    await writeFile(path.join(root, '.github', 'workflows', 'application-artifact.yml'), transport.workflow);
    if (!rootContext) await writeFile(path.join(root, 'backend', 'Dockerfile'), 'FROM scratch\n');
    for (const args of [['init', '--initial-branch=develop'], ['add', '.'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Isolated fixture']]) {
      const value = await runner.run({ executable: 'git', args }, { cwd: root }); expect(value.status).toBe(0);
    }
    const sha = (await runner.run({ executable: 'git', args: ['rev-parse', 'HEAD'] }, { cwd: root })).stdout.trim();
    const treeSha = (await runner.run({ executable: 'git', args: ['rev-parse', `${sha}^{tree}`] }, { cwd: root })).stdout.trim();
    f.inputs.phases['application-artifact-ready'] = { ...f.inputs.phases['application-artifact-ready'],
      sourceSha: sha, sourceTreeSha: treeSha, workflowDigest: createHash('sha256').update(transport.workflow).digest('hex') };
  }
  f.inspection = await coverageInspection({ root, phaseId: f.phase.id, state: f.state, activationInputs: f.inputs });
  if (artifact && publication === 'accepted') {
    await writeActivationState(root, f.state, { expectedContentHash: null });
  }
  const preview = (await buildSavedTransitionPlan(f))!;
  const approval = await issuePriorApproval(root, f.state, preview);
  f.inspection.approvals = [approval];
  const plan = (await buildSavedTransitionPlan(f))!;
  const request = protectedStateCustodyRequest(f);
  const body = { kind: 'protected-state-custody.v1' as const, bindingDigest: request.bindingDigest,
    runnerId: 444, runnerLabel: request.runner.label, runnerGroupId: 333, networkConfigurationId: 'NC_fixture',
    hostId: nativeStateHostId(), workspaceRef: 'state-workspace:isolated', storageRef: 'protected-storage:isolated',
    keyProviderRef: 'key-provider:isolated', protectedStorage: 'encrypted-private' as const,
    keyCustody: 'external-nonexporting' as const, locking: 'azure-blob-lease' as const, writerQuiesced: true as const,
    plaintextFallback: false as const, disposalSupported: true as const,
    observedAt: coverageNow.toISOString(), expiresAt: new Date(coverageNow.getTime() + 86_400_000).toISOString() };
  const custody: ProtectedStateCustodyProof = { ...body, qualificationDigest: canonicalSha256(body) };
  const custodyPort: ProtectedStateCustodyPort = {
    qualify: async () => ({ status: 'qualified', proof: custody }),
    dispose: async () => ({ status: 'blocked', reason: 'capability-unavailable' })
  };
  const handoverPort: ProtectedStateHandoverPort = {
    proveBackend: async () => ({ status: 'blocked', reason: 'capability-unavailable' }),
    handover: async () => ({ status: 'blocked', reason: 'capability-unavailable' })
  };
  const input: PhaseAdapterExecutionInput = { ...f, plan,
    recordApplicationDispatchIntent: async () => {}, recordApplicationProgress: async () => {},
    adapters: {
    protectedStateCustody: custodyPort, protectedStateHandover: handoverPort,
    githubActivation: { transport }
  } };
  f.state.phases['remote-ready'].state = 'retained';
  f.state.phaseOutputs!['remote-import-verified'] = {
    values: { custodyIdentityDigest: protectedStateCustodyIdentityDigest(custody) }, resources: []
  };
  f.state.phases['private-backend-proof'].state = 'verified';
  f.state.phaseOutputs!['private-backend-proof'] = {
    values: { stateHandoverBindingDigest: request.bindingDigest, backendBindingDigest: f.bootstrap.backend.bindingDigest,
      bootstrapBindingDigest: f.bootstrap.bindingDigest, runnerId: 444, runnerLabel: request.runner.label,
      targetStateExists: false, locking: 'azure-blob-lease' }, resources: []
  };
  const remoteInspection = await coverageInspection({ root, phaseId: 'remote-import-verified', state: f.state, activationInputs: f.inputs });
  input.inspection.contexts = remoteInspection.contexts;
  const remotePlan = (await buildSavedTransitionPlan({ ...input, inspection: remoteInspection }))!;
  input.inspection.contexts['remote-import-verified'].reviewedPlans = [remotePlan];
  const remote = record(input, 'remote-import-verified', {
    kind: 'remote-import-verified.v1', bindingDigest: request.bindingDigest, backendBindingDigest: f.bootstrap.backend.bindingDigest,
    planDigest: remotePlan.planDigest, savedPlanDigest: canonicalSha256(remotePlan),
    mappingDigest: 'a'.repeat(64), concurrencyDigest: 'b'.repeat(64), remoteBackendDigest: 'c'.repeat(64), noChangePlanDigest: 'd'.repeat(64),
    workflowRunId: 500, workflowJobId: 501, headSha: 'a'.repeat(40), runnerId: 444, runnerLabel: request.runner.label,
    locking: 'azure-blob-lease', targetStatePreviouslyExisted: false, plan: { add: 0, change: 0, destroy: 0 },
    mappings: [{ resourceId: f.prerequisite.groupId }], custody,
    backups: [{ artifactDigest: 'e'.repeat(64), encryptedStateRef: `${custody.workspaceRef}/backup`, encryptionKeyRef: custody.keyProviderRef }],
    encryptedStatePathParts: [['protected-custody', canonicalSha256(`${custody.workspaceRef}/backup`)]],
    encryptionKeyPathParts: [['protected-custody', canonicalSha256(custody.keyProviderRef)]], publicExistingStateMigration: false
  }, [{ provider: 'github', resourceType: 'workflow-run', resourceId: '/repos/owner/repo/actions/runs/500' },
    { provider: 'azure', resourceType: 'private-state-backend', resourceId: f.bootstrap.backend.containerResourceId }]);
  f.state.bootstrapState = { status: 'retained', remoteImportEvidenceId: remote.evidenceId,
    remoteImportEvidenceDigest: evidenceHeaderDigest(remote.header), retainedAt: coverageNow.toISOString(),
    disposeAfter: new Date(coverageNow.getTime() + 30 * 86_400_000).toISOString(),
    encryptedStatePathParts: [], encryptionKeyPathParts: [] };
  const bootstrapInspection = await coverageInspection({ root, phaseId: 'bootstrap-local', state: f.state, activationInputs: f.inputs });
  const bootstrapPlan = (await buildSavedTransitionPlan({ ...input, inspection: bootstrapInspection }))!;
  input.inspection.contexts['bootstrap-local'].reviewedPlans = [bootstrapPlan];
  f.state.phases['bootstrap-local'].executionPlanDigest = bootstrapPlan.planDigest;
  f.state.phases['bootstrap-local'].operation = {
    provider: 'azure', actionId: 'azure.bootstrap-local.apply', operationId: 'azure-deployment:isolated-bootstrap',
    resourceId: f.bootstrap.deploymentResourceId, startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString(),
    status: 'completed', planDigest: bootstrapPlan.planDigest
  };
  const bootstrapRecord = record(input, 'bootstrap-local', { kind: 'bootstrap-local.v1',
    planDigest: bootstrapPlan.planDigest, savedPlanDigest: canonicalSha256(bootstrapPlan) });
  input.inspection.evidence = [remote, bootstrapRecord];
  for (const evidence of input.inspection.evidence) {
    const checked = validateEvidenceFreshness(evidence, input.inspection.contexts[evidence.header.phaseId]);
    expect(checked, JSON.stringify(checked)).toMatchObject({ valid: true });
  }
  runner.inventory = f.bootstrap.resourceIds.filter((entry) =>
    entry.resourceType !== 'Microsoft.Resources/resourceGroups' &&
    entry.resourceId.startsWith(`${f.prerequisite.groupId}/providers/`)).map((entry) => ({ id: entry.resourceId, type: entry.resourceType }));
  const newPreview = (await buildSavedTransitionPlan(input))!;
  input.inspection.approvals = [await issuePriorApproval(root, f.state, newPreview)];
  input.plan = (await buildSavedTransitionPlan(input))!;
  if (artifact) {
    transport.binding = applicationArtifactBinding(input); runner.artifact = transport.binding;
    if (publication === 'accepted') {
      input.inspection.contexts[f.phase.id].reviewedPlans = [input.plan];
      transport.dispatched = true;
      const phase = f.state.phases[f.phase.id];
      phase.state = 'running';
      phase.executionPlanDigest = input.plan.planDigest;
      const acceptedAt = new Date(coverageNow.getTime() - 1).toISOString();
      phase.operation = {
        provider: 'github', actionId: 'github.artifact.build-dispatch', operationId: 'github-actions:901',
        resourceId: '/repos/owner/repo/actions/runs/901', pollUrl: 'https://api.github.com/repos/owner/repo/actions/runs/901',
        startedAt: acceptedAt, observedAt: acceptedAt,
        status: 'running', planDigest: input.plan.planDigest
      };
      const prior = await loadActivationState(root);
      await writeActivationState(root, f.state, { expectedContentHash: prior!.contentHash });
      input.inspection.loadedState = await loadActivationState(root);
    }
  }
  return { ...f, input, runner, transport, custody };
}

describe('application source producers behind real prerequisites', () => {
  it('plans exact registry, workload identity, narrowly scoped roles and nonzero cost', async () => {
    const f = await fixture();
    const operation = f.input.plan.operations.find((entry) => entry.actionId === 'azure.prerequisites.apply')!;
    expect(operation.inputs).toMatchObject({ registrySku: 'Basic', adminUserEnabled: false, adoptsExistingResources: false, deployment: false });
    expect(operation.inputs).not.toHaveProperty('acr');
    expect(f.input.plan.operations.map((entry) => entry.actionId)).toContain('azure.deployment.classify-ownership');
    expect(await observeApplicationProtection(f.input)).toMatchObject({ custody: { hostId: nativeStateHostId() } });
  });
  it('uses bounded real ARM dispatch/readback shapes and sanitized provider output', async () => {
    const f = await fixture();
    const outcome = await executeApplicationPrerequisites(f.input);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified',
      operation: { status: 'completed' }, outputs: { values: { workloadPrincipalId: applicationFixtureWorkloadPrincipal } } });
    expect(f.runner.writes).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain('withheld-fixture-value');
    expect(f.runner.options.filter((entry) => entry.timeoutMs).every((entry) => entry.timeoutMs! <= 30_000 && entry.stream === false)).toBe(true);
  });
  it.each(['registry', 'identity'].flatMap(resource => [
    { resource, drift: 'missing', value: undefined },
    { resource, drift: 'changed', value: 'staging' },
    { resource, drift: 'null', value: null },
    { resource, drift: 'nonstring', value: false }
  ]))('refuses $resource $drift environment metadata rather than manufacturing an approved readback tag', async ({ resource, value }) => {
    const f = await fixture();
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, 'run').mockImplementation(async (command, options) => {
      const observed = await run(command, options);
      if (command.args.join(' ').startsWith(resource === 'registry' ? 'acr show ' : 'identity show ')) {
        const body: unknown = JSON.parse(observed.stdout);
        if (!isRecord(body) || !isRecord(body.tags)) throw new Error('Isolated provider fixture has invalid tag metadata.');
        const tags = { ...body.tags };
        if (value === undefined) delete tags['liftoff-environment'];
        else tags['liftoff-environment'] = value;
        return result(command, { ...body, tags });
      }
      return observed;
    });
    const outcome = await executeApplicationPrerequisites(f.input);
    expect(outcome).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/prerequisite/), operation: { status: 'completed' }
    });
    expect(outcome.evidencePayload).toBeUndefined();
    expect(outcome.outputs?.values.loginServer).toBeUndefined();
    expect(outcome.outputs?.values.workloadPrincipalId).toBeUndefined();
    expect(f.runner.writes).toHaveLength(1);
  });
  it.each(['ports', 'authority', 'permission', 'provider', 'collision', 'ownership'] as const)('refuses %s before dispatch', async (kind) => {
    const f = await fixture();
    if (kind === 'ports') f.input.adapters = {};
    if (kind === 'authority') f.input.inspection.approvals = [];
    if (kind === 'permission') f.runner.permissions = ['Microsoft.Resources/deployments/read'];
    if (kind === 'provider') f.runner.providerRegistered = false;
    if (kind === 'collision') f.runner.occupied = true;
    if (kind === 'ownership') f.runner.inventory.push({ id: `${f.prerequisite.groupId}/providers/Microsoft.Storage/storageAccounts/unknown`, type: 'Microsoft.Storage/storageAccounts' });
    expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked' });
    expect(f.runner.writes).toEqual([]);
  });
  it('retains accepted partial handles and observes pending operations without redispatch', async () => {
    const f = await fixture();
    f.runner.deploymentState = 'Running';
    const first = await executeApplicationPrerequisites(f.input);
    expect(first).toMatchObject({ status: 'pending', operation: { status: 'running' } });
    f.input.inspection.state.phases[f.phase.id].operation = first.operation;
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    f.input.inspection.state.phaseOutputs![f.phase.id] = first.outputs!;
    if (first.operation) first.operation.planDigest = f.input.plan.planDigest;
    const next = await executeApplicationPrerequisites(f.input);
    expect(next, JSON.stringify(next)).toMatchObject({ status: 'pending' });
    expect(f.runner.writes).toHaveLength(1);
  });
  it.each(['Running', 'Succeeded'])('observes the original %s prerequisite deployment without fresh create or role-assignment grants', async state => {
    const f = await fixture();
    f.runner.deploymentState = 'Running';
    const first = await executeApplicationPrerequisites(f.input);
    expect(first).toMatchObject({ status: 'pending', operation: { status: 'running' } });
    f.input.inspection.state.phases[f.phase.id].operation = {
      ...first.operation!, planDigest: f.input.plan.planDigest
    };
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    f.runner.permissions = [
      'Microsoft.Resources/deployments/read', 'Microsoft.Resources/deployments/exportTemplate/action',
      'Microsoft.Resources/subscriptions/resourceGroups/read',
      'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/read',
      'Microsoft.Authorization/roleAssignments/read'
    ];
    f.runner.deploymentState = state;
    const next = await executeApplicationPrerequisites({
      ...f.input, applicationObservationOnly: true, now: new Date(coverageNow.getTime() + 1000)
    });
    expect(next, JSON.stringify(next)).toMatchObject({
      status: state === 'Running' ? 'pending' : 'completed',
      operation: { operationId: first.operation!.operationId, startedAt: first.operation!.startedAt,
        planDigest: f.input.plan.planDigest }
    });
    expect(f.runner.writes).toHaveLength(1);
  });
  it('blocks actual prerequisite read denial without discarding its original handle or redispatching', async () => {
    const f = await fixture();
    f.runner.deploymentState = 'Running';
    const first = await executeApplicationPrerequisites(f.input);
    expect(first).toMatchObject({ status: 'pending' });
    const operation = { ...first.operation!, planDigest: f.input.plan.planDigest };
    f.input.inspection.state.phases[f.phase.id].operation = operation;
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    f.runner.permissions = [];
    f.runner.failPoll = true;
    const outcome = await executeApplicationPrerequisites({ ...f.input, applicationObservationOnly: true });
    expect(outcome).toMatchObject({ status: 'blocked' });
    expect(f.input.inspection.state.phases[f.phase.id].operation).toEqual(operation);
    expect(outcome.evidencePayload).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('secret-provider-diagnostics');
    expect(f.runner.writes).toHaveLength(1);
  });
  it.each(['owned', 'unknown-extra', 'poll-failure'] as const)(
    'resumes the engine read-only with %s inventory and never repeats creation', async (kind) => {
      const f = await fixture(); f.runner.deploymentState = 'Running';
      const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
        runner: f.runner, now: coverageNow, adapters: f.input.adapters });
      expect(first).toMatchObject({ applied: false, reason: 'external-operation-pending' });
      const saved = (await readState(f.root))!;
      f.runner.inventory.push({ id: f.prerequisite.registryId, type: 'Microsoft.ContainerRegistry/registries' },
        { id: f.prerequisite.identityId, type: 'Microsoft.ManagedIdentity/userAssignedIdentities' });
      if (kind === 'unknown-extra') f.runner.inventory.push({
        id: `${f.prerequisite.groupId}/providers/Microsoft.Storage/storageAccounts/unknown`, type: 'Microsoft.Storage/storageAccounts'
      });
      f.runner.deploymentState = 'Succeeded';
      f.runner.failPoll = kind === 'poll-failure';
      const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id, state: saved,
        activationInputs: f.inputs, approvals: f.input.inspection.approvals, evidence: f.input.inspection.evidence,
        reviewedPlans: [f.input.plan] });
      inspection.loadedState = await loadActivationState(f.root);
      for (const id of ['bootstrap-local', 'remote-import-verified'] as const) {
        inspection.contexts[id].reviewedPlans = f.input.inspection.contexts[id].reviewedPlans;
      }
      const next = await executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
        now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters });
      expect(f.runner.writes).toHaveLength(1);
      const after = (await readState(f.root))!;
      expect(after.phases[f.phase.id].operation?.operationId).toBe(saved.phases[f.phase.id].operation?.operationId);
      if (kind === 'owned') {
        expect(next, JSON.stringify(next)).toMatchObject({ applied: true });
        const evidence = JSON.parse(await readFile(path.join(f.root, ...next.evidence!.pathParts), 'utf8'));
        expect(evidence.payload.deploymentOwnership.environments[0].status).toBe('same-operation-owned');
      } else {
        expect(next, JSON.stringify(next)).toMatchObject({ applied: false });
        expect(after.phases[f.phase.id].state).not.toBe('verified');
        if (kind === 'poll-failure') expect(after.phases[f.phase.id].operation).toEqual(saved.phases[f.phase.id].operation);
      }
    }
  );
  it('blocks a resource appearing during validation before any prerequisite write', async () => {
    const f = await fixture();
    f.runner.onValidation = () => f.runner.inventory.push({
      id: f.prerequisite.registryId, type: 'Microsoft.ContainerRegistry/registries'
    });
    expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked',
      blocker: expect.stringMatching(/uncertain/) });
    expect(f.runner.writes).toEqual([]);
  });
  it('does not confuse preflight refusal with uncertain dispatch and can retry after permission is corrected', async () => {
    const f = await fixture(); f.runner.permissions = ['Microsoft.Resources/deployments/read'];
    const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(first).toMatchObject({ applied: false });
    const saved = (await readState(f.root))!;
    expect(saved.phases[f.phase.id].executionPlanDigest).toBeUndefined();
    expect(f.runner.writes).toEqual([]);
    const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id, state: saved,
      activationInputs: f.inputs, approvals: f.input.inspection.approvals, evidence: f.input.inspection.evidence,
      reviewedPlans: [f.input.plan] });
    inspection.loadedState = await loadActivationState(f.root);
    for (const id of ['bootstrap-local', 'remote-import-verified'] as const) {
      inspection.contexts[id].reviewedPlans = f.input.inspection.contexts[id].reviewedPlans;
    }
    f.runner.permissions = ['*'];
    expect(await executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
      now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters })).toMatchObject({ applied: true });
    expect(f.runner.writes).toHaveLength(1);
  });
  it.each(['Running', 'Failed', 'unknown'])('does not create on %s ARM validation', async (state) => {
    const f = await fixture(); f.runner.validationState = state;
    expect(await executeApplicationPrerequisites(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/completed validation/)
    });
    expect(f.runner.writes).toEqual([]);
  });
  it('requires durable engine progress writers before production dispatch', async () => {
    const f = await fixture(); delete f.input.recordApplicationDispatchIntent;
    expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked',
      blocker: expect.stringMatching(/engine-owned durable intent/) });
    expect(f.runner.calls.filter((entry) => entry.executable === 'az')).toEqual([]);
  });
  it('does not lose a confirmed deployment handle on failed first poll or expose provider diagnostics', async () => {
    const f = await fixture(); f.runner.failPoll = true;
    const outcome = await executeApplicationPrerequisites(f.input);
    expect(outcome).toMatchObject({ status: 'pending', operation: { resourceId: f.prerequisite.deploymentId } });
    expect(JSON.stringify(outcome)).not.toContain('secret-provider-diagnostics');
  });
  it.each(['read-failure', 'source-change'] as const)(
    'checkpoints completed prerequisite dispatch before %s during recipe export without inventing resource proof', async (kind) => {
      const f = await fixture();
      let checkpointDuringExport: Awaited<ReturnType<typeof readState>> | undefined;
      const policyPath = path.join(f.root, '.liftoff', 'governance', 'policy.md');
      const policy = await readFile(policyPath, 'utf8');
      f.runner.failExport = true;
      f.runner.onExport = async () => {
        checkpointDuringExport = await readState(f.root);
        if (kind === 'source-change') await writeFile(policyPath, `${policy}\n`);
      };
      const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
        runner: f.runner, now: coverageNow, adapters: f.input.adapters });
      expect(first).toMatchObject({ applied: false, reason: 'blocked' });
      expect(checkpointDuringExport?.phases[f.phase.id]).toMatchObject({
        state: 'running', operation: { resourceId: f.prerequisite.deploymentId, status: 'completed' }
      });
      const saved = (await readState(f.root))!;
      const operation = saved.phases[f.phase.id].operation!;
      expect(operation.status).toBe('completed');
      expect(saved.phaseOutputs?.[f.phase.id]?.resources).toEqual([{
        provider: 'azure', resourceType: 'Microsoft.Resources/deployments', resourceId: f.prerequisite.deploymentId
      }]);
      expect(saved.phaseOutputs?.[f.phase.id]?.values.workloadPrincipalId).toBeUndefined();
      expect(saved.phases[f.phase.id].evidence.some((entry) => entry.result === 'verified')).toBe(false);
      expect(JSON.stringify(first)).not.toContain('secret-provider-diagnostics');
      if (kind === 'source-change') {
        expect(first.blockers).toEqual(['Relevant project inputs changed during execution; no outcome was persisted.']);
        expect(await readFile(policyPath, 'utf8')).toBe(`${policy}\n`);
      } else {
        f.runner.failExport = false;
        f.runner.onExport = undefined;
        const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id, state: saved,
          activationInputs: f.inputs, approvals: f.input.inspection.approvals, evidence: f.input.inspection.evidence,
          reviewedPlans: [f.input.plan] });
        inspection.loadedState = await loadActivationState(f.root);
        for (const id of ['bootstrap-local', 'remote-import-verified'] as const) {
          inspection.contexts[id].reviewedPlans = f.input.inspection.contexts[id].reviewedPlans;
        }
        await expect(executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
          now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters })).rejects.toThrow(/terminal external operation requires explicit recovery/);
        const next = await executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
          now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters, recovery: true });
        expect(next, JSON.stringify(next)).toMatchObject({ applied: true });
        expect((await readState(f.root))!.phases[f.phase.id].operation).toMatchObject({
          operationId: operation.operationId, startedAt: operation.startedAt, planDigest: operation.planDigest, status: 'completed'
        });
      }
      expect(f.runner.writes).toHaveLength(1);
    }
  );
  it('preserves actual failed prerequisite status when concurrent source changes refuse the final outcome', async () => {
    const f = await fixture();
    const policyPath = path.join(f.root, '.liftoff', 'governance', 'policy.md');
    const policy = await readFile(policyPath, 'utf8');
    f.runner.deploymentState = 'Failed';
    f.runner.onDeploymentRead = async () => { await writeFile(policyPath, `${policy}\n`); };
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: false, reason: 'blocked',
      blockers: ['Relevant project inputs changed during execution; no outcome was persisted.'] });
    expect((await readState(f.root))!.phases[f.phase.id]).toMatchObject({
      state: 'running', operation: { resourceId: f.prerequisite.deploymentId, status: 'failed' }
    });
    expect(await readFile(policyPath, 'utf8')).toBe(`${policy}\n`);
    expect(f.runner.writes).toHaveLength(1);
  });
  it('checkpoints only the actual accepted operation, never future resources', async () => {
    const f = await fixture(); f.runner.deploymentState = 'Running';
    const checkpoints: Parameters<NonNullable<PhaseAdapterExecutionInput['recordApplicationProgress']>>[0][] = [];
    f.input.recordApplicationProgress = async (progress) => { checkpoints.push(progress); };
    await executeApplicationPrerequisites(f.input);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.outputs.resources).toEqual([{
      provider: 'azure', resourceType: 'Microsoft.Resources/deployments', resourceId: f.prerequisite.deploymentId
    }]);
  });
  it.each(['Succeeded', 'Failed'] as const)(
    'blocks regressing nonterminal readback of a known %s prerequisite deployment without redispatch', async (state) => {
      const f = await fixture();
      f.runner.deploymentState = state;
      f.runner.failExport = true;
      const first = await executeApplicationPrerequisites(f.input);
      const terminalStatus = state === 'Succeeded' ? 'completed' : 'failed';
      expect(first).toMatchObject({ status: 'blocked', operation: { status: terminalStatus } });
      const operation = { ...first.operation!, planDigest: f.input.plan.planDigest };
      f.input.inspection.state.phases[f.phase.id].operation = operation;
      f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
      f.runner.deploymentState = 'Running';
      const progress = vi.spyOn(f.input, 'recordApplicationProgress');
      const next = await executeApplicationPrerequisites({
        ...f.input, now: new Date(coverageNow.getTime() + 1000), recovery: true
      });
      expect(next).toMatchObject({
        status: 'blocked', blocker: expect.stringMatching(/terminal.*nonterminal/),
        operation: { operationId: operation.operationId, startedAt: operation.startedAt,
          planDigest: operation.planDigest, status: terminalStatus }
      });
      expect(next.evidencePayload).toBeUndefined();
      expect(next.outputs?.values.workloadPrincipalId).toBeUndefined();
      expect(progress).not.toHaveBeenCalled();
      expect(f.runner.writes).toHaveLength(1);
    }
  );
  it.each(['registrySku', 'assignRegistryRoles', 'environment', 'budget', 'principal', 'unknown'] as const)(
    'rejects malformed prerequisite %s without inventing resources or roles', async (kind) => {
      const f = await fixture();
      const config = f.inputs.phases['application-prerequisites-ready']!;
      if (kind === 'registrySku') Object.assign(config, { registrySku: 'Premium' });
      if (kind === 'assignRegistryRoles') Object.assign(config, { assignRegistryRoles: false });
      if (kind === 'environment') Object.assign(config, { environment: 'customer-prod' });
      if (kind === 'budget') f.inputs.budget!.usageMonthlyCents = 0;
      if (kind === 'principal') Object.assign(f.input.inspection.state.phaseOutputs!['phase-0-complete']!.values, { principalType: 'user' });
      if (kind === 'unknown') Object.assign(config, { command: 'arbitrary-shell' });
      expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked' });
      expect(f.runner.writes).toEqual([]);
    }
  );
  it('keeps terminal failure and actual partial resource inventory for recovery', async () => {
    const f = await fixture(); f.runner.deploymentState = 'Failed';
    expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked', operation: { status: 'failed' }, outputs: { resources: expect.any(Array) } });
  });
  it('separates absent production capabilities, unsupported host and malformed current authority', async () => {
    const f = await fixture();
    expect(applicationProtectionBlocker({ adapters: {} })).toMatch(/both production/);
    f.input.inspection.state.applicability.statePath = 'existing-private';
    await expect(observeApplicationProtection(f.input)).rejects.toThrow(/existing-private/);
    f.input.plan.expiresAt = coverageNow.toISOString();
    await expect(assertApplicationAuthority(f.input, f.input.plan.operations[1]!)).rejects.toThrow(/expired/);
  });
  it.each(['retention', 'blocked-host', 'custody-drift', 'authority-store'] as const)(
    'refuses %s rather than borrowing protected execution or imported authority', async (kind) => {
      const f = await fixture();
      if (kind === 'retention') f.input.inspection.state.bootstrapState!.disposeAfter = coverageNow.toISOString();
      if (kind === 'blocked-host') f.input.adapters.protectedStateCustody!.qualify = async () => ({
        status: 'blocked', reason: 'capability-unavailable'
      });
      if (kind === 'custody-drift') {
        const { qualificationDigest: _digest, ...body } = f.custody;
        body.storageRef = 'protected-storage:different';
        Object.assign(f.custody, body, { qualificationDigest: canonicalSha256(body) });
      }
      if (kind === 'authority-store') {
        const authority = await createScopedUserLocalRecordStore(f.root, 'governance-approval')
          .read(canonicalApprovalEnvelopeHash(f.input.inspection.approvals[0]!));
        await rm(authority!.path);
      }
      expect(await executeApplicationPrerequisites(f.input)).toMatchObject({ status: 'blocked' });
      expect(f.runner.writes).toEqual([]);
    }
  );
});

describe('immutable application publication and independent readback', () => {
  it.each([false, true])('refuses fresh publication without actual no-replace admission for root context %s', async rootContext => {
    const f = await fixture(true, rootContext, 'exact', 'fresh');
    const intent = vi.spyOn(f.input, 'recordApplicationDispatchIntent');
    const progress = vi.spyOn(f.input, 'recordApplicationProgress');
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/no-replace|overwrite/) });
    expect(intent).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(f.transport.calls.some(entry => entry.method !== 'GET')).toBe(false);
    expect(f.runner.writes).toEqual([]);
    expect(outcome.operation).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
    expect(outcome.outputs?.values.immutableImage).toBeUndefined();
  });
  it.each([
    'Microsoft.ContainerRegistry/registries/read',
    'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action',
    'Microsoft.ContainerRegistry/registries/scheduleRun/action',
    'Microsoft.ContainerRegistry/registries/runs/read'
  ])('refuses absent actual registry build permission %s before dispatch or source upload', async missing => {
    const f = await fixture(true, false, 'exact', 'fresh');
    f.runner.permissions = [
      'Microsoft.ContainerRegistry/registries/read',
      'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action',
      'Microsoft.ContainerRegistry/registries/scheduleRun/action',
      'Microsoft.ContainerRegistry/registries/runs/read'
    ].filter(action => action !== missing);
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/build.*permission/) });
    expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
    expect(f.runner.writes).toEqual([]);
  });
  it('honors actual registry build permission exclusions instead of treating AcrPush as build scheduling authority', async () => {
    const f = await fixture(true, false, 'exact', 'fresh');
    f.runner.permissionExclusions = ['Microsoft.ContainerRegistry/registries/scheduleRun/action'];
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/build.*permission/)
    });
    expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
  });
  it('independently observes build permissions at the exact registry scope on every pre-dispatch check', async () => {
    const f = await fixture(true, false, 'exact', 'fresh');
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/no-replace/)
    });
    const url = `https://management.azure.com${f.transport.binding.registryId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`;
    const observations = f.runner.calls.filter(command => command.args.includes(url));
    expect(observations).toHaveLength(3);
    expect(observations.every(command => command.executable === 'az' && argument(command, '--method') === 'GET' &&
      argument(command, '--resource') === 'https://management.core.windows.net/')).toBe(true);
  });
  it('refuses build authority revoked during awaited execution-tag admission before any fresh publication intent', async () => {
    const f = await fixture(true, false, 'exact', 'fresh');
    const intent = vi.spyOn(f.input, 'recordApplicationDispatchIntent');
    let tagReads = 0;
    f.transport.onExecutionTagRead = () => {
      if (++tagReads === 2) f.runner.permissionExclusions = ['Microsoft.ContainerRegistry/registries/scheduleRun/action'];
    };
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(tagReads).toBe(2);
    expect(intent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/build.*permission/) });
    expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
    expect(outcome.operation).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
  });
  it('binds the actual generated root Dockerfile and exact manifest-owned context during accepted-run observation', async () => {
    const f = await fixture(true, true);
    expect(f.transport.binding).toMatchObject({ contextPath: '.', dockerfilePath: 'Dockerfile',
      contextPaths: expect.arrayContaining(['Dockerfile', '.dockerignore', 'backend/package.json']),
      sourceManifestDigest: canonicalSha256(f.input.inspection.manifest) });
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(f.transport.calls.some(entry => entry.method !== 'GET')).toBe(false);
    expect(f.input.plan.operations.find(entry => entry.actionId === 'github.artifact.build-dispatch')?.inputs)
      .toMatchObject({ contextPaths: f.transport.binding.contextPaths });
  });
  it.each(['missing', 'wrong-directory', 'changed-projection'] as const)(
    'refuses a reviewed %s root-context recipe before dispatch rather than uploading the whole repository', async kind => {
      const f = await fixture(true, true, kind);
      expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
        status: 'blocked', blocker: expect.stringMatching(/exact reviewed immutable-file projection/)
      });
      expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
      expect(f.runner.calls.some(entry => entry.executable === 'gh')).toBe(false);
    }
  );
  it('preserves and refuses changed selected root-context source without dispatch', async () => {
    const f = await fixture(true, true);
    await writeFile(path.join(f.root, 'backend', 'package.json'), '{"preserved":"customization"}\n');
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/source differs/)
    });
    expect(await readFile(path.join(f.root, 'backend', 'package.json'), 'utf8')).toBe('{"preserved":"customization"}\n');
    expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
  });
  it.each([undefined, [], ['../private'], ['Dockerfile', 'backend']].map(paths => ({ paths })))(
    'blocks an absent, unsafe or directory-sweep root context $paths without throwing or dispatching', async ({ paths }) => {
      const f = await fixture(true, true);
      f.inputs.phases['application-artifact-ready'] = { ...f.inputs.phases['application-artifact-ready'], contextPaths: paths };
      expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked' });
      expect(f.transport.calls.some(entry => entry.method === 'POST')).toBe(false);
    }
  );
  it.each(['fresh-no-handle', 'intent-only-recovery'] as const)(
    'refuses new publication or run-list adoption without original accepted-run provenance during %s', async (kind) => {
      const f = await fixture(true, false, 'exact', 'fresh');
      f.transport.dispatchResponse = null;
      if (kind === 'intent-only-recovery') {
        f.transport.dispatched = true;
        f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
      }
      const progress = vi.spyOn(f.input, 'recordApplicationProgress');
      const outcome = await executeApplicationArtifactPublication(f.input);
      expect(outcome).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/acceptance|accepted/) });
      expect(outcome.operation).toBeUndefined();
      expect(outcome.evidencePayload).toBeUndefined();
      expect(outcome.outputs?.values.immutableImage).toBeUndefined();
      expect(progress).not.toHaveBeenCalled();
      expect(f.transport.calls.some((entry) => entry.path.includes('/jobs'))).toBe(false);
      expect(f.runner.calls.some((entry) => entry.executable === 'gh')).toBe(false);
      expect(f.transport.calls.filter((entry) => entry.method === 'POST'))
        .toHaveLength(0);
    }
  );
  it('observes the original accepted run ID without eventually consistent discovery or a new dispatch', async () => {
    const f = await fixture(true);
    f.transport.invisible = true;
    const run = f.transport.run.bind(f.transport);
    vi.spyOn(f.transport, 'run').mockImplementation(() => ({ ...run(), privateDiagnostic: 'fixture-secret-response' }));
    const progress = vi.fn(f.input.recordApplicationProgress!);
    f.input.recordApplicationProgress = progress;
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified',
      operation: { operationId: 'github-actions:901' } });
    expect(progress).toHaveBeenCalledOnce();
    expect(progress.mock.calls[0]![0]).toMatchObject({
      operation: { operationId: 'github-actions:901', resourceId: '/repos/owner/repo/actions/runs/901', status: 'completed' },
      liveReadback: [{ provider: 'github', resourceId: '/repos/owner/repo/actions/runs/901' }]
    });
    expect(f.transport.calls.filter((entry) => entry.method === 'GET' && entry.path.includes('/actions/workflows/'))).toHaveLength(0);
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(JSON.stringify([outcome, progress.mock.calls])).not.toContain('fixture-secret-response');
  });
  it('retains the original checkpointed provider ID through failed metadata observation and retries without write permission', async () => {
    const f = await fixture(true);
    f.transport.invisible = true;
    f.transport.runStatus = 'in_progress';
    f.transport.dispatchResponse = {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901'
    };
    let checkpointDuringPoll: Awaited<ReturnType<typeof readState>> | undefined;
    f.transport.onRunRead = async () => {
      checkpointDuringPoll = await readState(f.root);
      throw new GitHubActivationError('provider-response', 'Isolated metadata observation is unavailable.', 503);
    };
    const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(first).toMatchObject({ applied: false, reason: 'blocked' });
    expect(checkpointDuringPoll?.phases[f.phase.id]).toMatchObject({
      state: 'running', operation: { operationId: 'github-actions:901', status: 'running' }
    });
    const saved = (await readState(f.root))!;
    const operation = saved.phases[f.phase.id].operation!;
    expect(operation).toMatchObject({ operationId: 'github-actions:901', status: 'running',
      pollUrl: 'https://api.github.com/repos/owner/repo/actions/runs/901' });
    f.transport.onRunRead = undefined;
    f.runner.permissions = [];
    f.input.inspection.state = saved;
    f.input.inspection.contexts[f.phase.id].reviewedPlans = [f.input.plan];
    const next = await executeApplicationArtifactPublication({ ...f.input, now: new Date(coverageNow.getTime() + 1000) });
    expect(next, JSON.stringify(next)).toMatchObject({ status: 'pending',
      operation: { operationId: operation.operationId, startedAt: operation.startedAt, planDigest: operation.planDigest } });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it.each(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'] as const)(
    'checkpoints actual terminal %s run status before a failing job read and recovers without dispatch', async (conclusion) => {
      const f = await fixture(true);
      f.transport.conclusion = conclusion;
      const terminalStatus = conclusion === 'success' ? 'completed' : 'failed';
      let checkpointDuringJobs: Awaited<ReturnType<typeof readState>> | undefined;
      f.transport.onJobsRead = async () => {
        checkpointDuringJobs = await readState(f.root);
        throw new GitHubActivationError('provider-response', 'Isolated job observation is unavailable.', 503);
      };
      const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
        runner: f.runner, now: coverageNow, adapters: f.input.adapters });
      expect(first).toMatchObject({ applied: false, reason: 'blocked',
        blockers: [expect.stringMatching(/job observation is unavailable/)] });
      expect(checkpointDuringJobs?.phases[f.phase.id]).toMatchObject({
        state: 'running', operation: { operationId: 'github-actions:901', status: terminalStatus }
      });
      const saved = (await readState(f.root))!;
      const operation = saved.phases[f.phase.id].operation!;
      expect(saved.phases[f.phase.id]).toMatchObject({ state: 'blocked',
        operation: { operationId: 'github-actions:901', status: terminalStatus } });
      expect(saved.phaseOutputs?.[f.phase.id]?.values.artifactDigest).toBeUndefined();
      expect(saved.phaseOutputs?.[f.phase.id]?.values.immutableImage).toBeUndefined();
      expect(saved.phases[f.phase.id].evidence).toEqual([
        expect.objectContaining({ phaseId: f.phase.id, result: 'failed' })
      ]);
      f.transport.onJobsRead = undefined;
      const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id, state: saved,
        activationInputs: f.inputs, approvals: f.input.inspection.approvals, evidence: f.input.inspection.evidence,
        reviewedPlans: [f.input.plan] });
      inspection.loadedState = await loadActivationState(f.root);
      for (const id of ['bootstrap-local', 'remote-import-verified'] as const) {
        inspection.contexts[id].reviewedPlans = f.input.inspection.contexts[id].reviewedPlans;
      }
      await expect(executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
        now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters })).rejects.toThrow(/terminal external operation requires explicit recovery/);
      const next = await executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
        now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters, recovery: true });
      expect(next, JSON.stringify(next)).toMatchObject({ applied: conclusion === 'success' });
      expect((await readState(f.root))!.phases[f.phase.id].operation).toMatchObject({
        operationId: operation.operationId, startedAt: operation.startedAt, planDigest: operation.planDigest,
        status: terminalStatus
      });
      expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    }
  );
  it.each(['success', 'failure'] as const)('blocks regressing nonterminal readback of a known %s terminal run without redispatch', async (conclusion) => {
    const f = await fixture(true);
    f.transport.conclusion = conclusion;
    f.transport.onJobsRead = async () => {
      throw new GitHubActivationError('provider-response', 'Isolated job observation is unavailable.', 503);
    };
    const first = await executeApplicationArtifactPublication(f.input);
    const terminalStatus = conclusion === 'success' ? 'completed' : 'failed';
    expect(first).toMatchObject({ status: 'blocked', operation: { status: terminalStatus } });
    const operation = first.operation!;
    operation.planDigest = f.input.plan.planDigest;
    f.input.inspection.state.phases[f.phase.id].operation = operation;
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    f.transport.runStatus = 'in_progress';
    f.transport.conclusion = '';
    const next = await executeApplicationArtifactPublication({
      ...f.input, now: new Date(coverageNow.getTime() + 1000), recovery: true
    });
    expect(next).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/terminal.*nonterminal/),
      operation: { operationId: operation.operationId, startedAt: operation.startedAt,
        planDigest: operation.planDigest, status: terminalStatus } });
    expect(next.evidencePayload).toBeUndefined();
    expect(next.outputs?.values.immutableImage).toBeUndefined();
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it.each(['', 'unknown'] as const)('refuses unsupported terminal conclusion %j without inferring publication success', async (conclusion) => {
    const f = await fixture(true);
    f.transport.conclusion = conclusion;
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: false, reason: 'blocked',
      blockers: [expect.stringMatching(/unknown conclusion/)] });
    const saved = (await readState(f.root))!;
    expect(saved.phases[f.phase.id].state).toBe('blocked');
    expect(saved.phaseOutputs?.[f.phase.id]?.values.immutableImage).toBeUndefined();
    expect(saved.phases[f.phase.id].evidence.some((entry) => entry.result === 'verified')).toBe(false);
    expect(f.transport.calls.some((entry) => entry.path.includes('/jobs'))).toBe(false);
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('retains actual terminal run progress when source changes during a later failed job observation', async () => {
    const f = await fixture(true);
    f.transport.onJobsRead = async () => {
      await writeFile(path.join(f.root, 'backend', 'Dockerfile'), 'FROM preserved-customization\n');
      throw new GitHubActivationError('provider-response', 'Isolated job observation is unavailable.', 503);
    };
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: false, reason: 'blocked',
      blockers: ['Relevant project inputs changed during execution; no outcome was persisted.'] });
    const saved = (await readState(f.root))!;
    expect(saved.phases[f.phase.id]).toMatchObject({
      state: 'running', operation: { operationId: 'github-actions:901', status: 'completed' }
    });
    expect(saved.phaseOutputs?.[f.phase.id]?.values.artifactDigest).toBeUndefined();
    expect(saved.phases[f.phase.id].evidence).toEqual([]);
    expect(await readFile(path.join(f.root, 'backend', 'Dockerfile'), 'utf8')).toBe('FROM preserved-customization\n');
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it.each(['poll-url', 'resource-id', 'operation-id', 'missing-handle'] as const)(
    'refuses malformed original %s metadata without inventing a scoped handle or repeating dispatch', async (kind) => {
      const f = await fixture(true);
      f.transport.invisible = true;
      const phase = f.input.inspection.state.phases[f.phase.id];
      if (kind === 'poll-url') phase.operation!.pollUrl = 'https://api.github.com/repos/other/repo/actions/runs/901';
      if (kind === 'resource-id') phase.operation!.resourceId = '/repos/owner/repo/actions/runs/902';
      if (kind === 'operation-id') phase.operation!.operationId = 'fixture-secret-response';
      if (kind === 'missing-handle') delete phase.operation;
      const progress = vi.fn(f.input.recordApplicationProgress!);
      f.input.recordApplicationProgress = progress;
      const outcome = await executeApplicationArtifactPublication(f.input);
      expect(outcome).toMatchObject({ status: 'blocked' });
      expect(outcome.operation).toBeUndefined();
      expect(progress).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain('fixture-secret-response');
      f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
      expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked' });
      expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    }
  );
  it('binds original accepted source/run/registry/digest readback without any new publication', async () => {
    const f = await fixture(true);
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified',
      outputs: { values: { artifactDigest: imageDigest, immutableImage: `${f.transport.binding.loginServer}/application/backend@${imageDigest}` } } });
    expect(outcome.evidencePayload).toMatchObject({
      executionRefAdmission: { kind: 'immutable-workflow-execution-ref.v1',
        binding: { sourceSha: f.transport.binding.sourceSha, treeSha: f.transport.binding.sourceTreeSha,
          executionRef: f.transport.binding.executionRef }, protectingRulesetIds: [11] }
    });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(f.input.plan.operations.find((entry) => entry.actionId === 'github.artifact.build-dispatch')?.inputs)
      .toMatchObject({ sourceSha: f.transport.binding.sourceSha, sourceTreeSha: f.transport.binding.sourceTreeSha,
        executionRef: f.transport.binding.executionRef });
    expect(f.transport.calls.some(entry => entry.method !== 'GET')).toBe(false);
    expect(outcome.liveReadback?.map((entry) => entry.provider)).toEqual(['github', 'azure', 'azure']);
    const verification = f.runner.calls.find((entry) => entry.executable === 'gh')!;
    expect(verification.args).toContain('--source-digest');
    expect(verification.args).not.toContain('--token');
  });
  it.each(['missing-tag', 'unprotected', 'bypass', 'tag-source', 'commit-tree', 'provider-grants', 'branch-runner'] as const)(
    'refuses %s execution-ref admission without tag/policy writes or mutable-ref fallback', async (kind) => {
      const f = await fixture(true);
      if (kind === 'missing-tag') f.transport.executionTagPresent = false;
      if (kind === 'unprotected') f.transport.executionTagProtected = false;
      if (kind === 'bypass') f.transport.executionTagBypass = true;
      if (kind === 'tag-source') f.transport.executionTagSha = 'f'.repeat(40);
      if (kind === 'commit-tree') f.transport.executionTreeSha = 'f'.repeat(40);
      if (kind === 'provider-grants') f.transport.providerScopes = 'repo';
      if (kind === 'branch-runner') f.transport.runnerUsesBranch = true;
      const outcome = await executeApplicationArtifactPublication(f.input);
      expect(outcome).toMatchObject({ status: 'blocked' });
      expect(outcome.evidencePayload).toBeUndefined();
      expect(outcome.outputs?.values.immutableImage).toBeUndefined();
      expect(f.transport.calls.every((entry) => entry.method === 'GET')).toBe(true);
      expect(f.runner.writes).toEqual([]);
      expect(f.runner.calls.some((entry) => entry.executable === 'gh')).toBe(false);
    }
  );
  it('reobserves original execution-ref admission before accepted-handle observation', async () => {
    const f = await fixture(true);
    let tagReads = 0;
    f.transport.onExecutionTagRead = () => { if (++tagReads === 1) f.transport.executionTagProtected = false; };
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked' });
    expect(f.transport.calls.every((entry) => entry.method === 'GET')).toBe(true);
    expect(f.runner.calls.some((entry) => entry.executable === 'gh')).toBe(false);
  });
  it('rechecks authority after awaited execution-tag admission before any fresh publication intent', async () => {
    const f = await fixture(true, false, 'exact', 'fresh');
    let now = coverageNow;
    let tagReads = 0;
    f.input.clock = () => now;
    const intent = vi.fn(async () => {});
    f.input.recordApplicationDispatchIntent = intent;
    f.transport.onExecutionTagRead = () => {
      if (++tagReads === 2) now = new Date(Date.parse(f.input.plan.expiresAt) + 1000);
    };
    const progress = vi.spyOn(f.input, 'recordApplicationProgress');
    const outcome = await executeApplicationArtifactPublication(f.input);
    expect(outcome).toMatchObject({ status: 'blocked' });
    expect(tagReads).toBe(2);
    expect(intent).not.toHaveBeenCalled();
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
    expect(outcome.operation).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
    expect(f.runner.calls.some((entry) => entry.executable === 'gh')).toBe(false);
  });
  it.each(['stored', 'resumed'] as const)(
    'refuses changed execution-ref admission at %s observation while retaining the actual invocation', async (kind) => {
      const f = await fixture(true);
      if (kind === 'stored') {
        let tagReads = 0;
        f.transport.onExecutionTagRead = () => { if (++tagReads === 1) f.transport.executionTagProtected = false; };
      } else {
        f.transport.runStatus = 'in_progress';
        const first = await executeApplicationArtifactPublication(f.input);
        expect(first).toMatchObject({ status: 'pending', operation: { operationId: 'github-actions:901' } });
        f.input.inspection.state.phases[f.phase.id].operation = {
          ...first.operation!, planDigest: f.input.plan.planDigest
        };
        f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
        f.transport.executionTagProtected = false;
      }
      const outcome = await executeApplicationArtifactPublication(f.input);
      expect(outcome).toMatchObject({
        status: 'blocked',
        blocker: expect.stringMatching(/independently read repository tag-update/)
      });
      expect(f.input.inspection.state.phases[f.phase.id].operation).toMatchObject({
        operationId: 'github-actions:901', status: 'running'
      });
      expect(outcome.evidencePayload).toBeUndefined();
      expect(outcome.outputs?.values.immutableImage).toBeUndefined();
      expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
      expect(f.runner.calls.some((entry) => entry.executable === 'gh')).toBe(false);
    }
  );
  it('rejects a legacy plan lacking its complete source-tree and execution-tag binding before provider reads', async () => {
    const f = await fixture(true);
    const dispatch = f.input.plan.operations.find((entry) => entry.actionId === 'github.artifact.build-dispatch')!;
    const { sourceTreeSha, executionRef, ...legacyInputs } = dispatch.inputs;
    expect(sourceTreeSha).toBe(f.transport.binding.sourceTreeSha);
    expect(executionRef).toBe(f.transport.binding.executionRef);
    Object.assign(dispatch, { inputs: legacyInputs });
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/changed exact source/)
    });
    expect(f.transport.calls).toEqual([]);
    expect(f.runner.writes).toEqual([]);
  });
  it.each(['stored', 'resumed'] as const)(
    'refuses a different actual workflow run at the exact %s publication handle', async (kind) => {
      const f = await fixture(true);
      if (kind === 'resumed') {
        f.transport.runStatus = 'in_progress';
        const pending = await executeApplicationArtifactPublication(f.input);
        expect(pending).toMatchObject({ status: 'pending', operation: { operationId: 'github-actions:901' } });
        f.input.inspection.state.phases[f.phase.id].operation = {
          ...pending.operation!, planDigest: f.input.plan.planDigest
        };
        f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
        f.transport.runStatus = 'completed';
      }
      const progress = vi.spyOn(f.input, 'recordApplicationProgress');
      const run = f.transport.run.bind(f.transport);
      vi.spyOn(f.transport, 'run').mockImplementation(() => ({ ...run(), id: 999 }));
      const jobReads = f.transport.calls.filter((entry) => entry.path.includes('/jobs')).length;
      const outcome = await executeApplicationArtifactPublication(f.input);
      expect(outcome).toMatchObject({
        status: 'blocked',
        blocker: expect.stringMatching(/exact.*workflow.*handle/)
      });
      expect(f.input.inspection.state.phases[f.phase.id].operation).toMatchObject({
        operationId: 'github-actions:901', status: 'running'
      });
      expect(outcome.evidencePayload).toBeUndefined();
      expect(outcome.outputs?.values.immutableImage).toBeUndefined();
      expect(progress.mock.calls.every(([entry]) => entry.operation.operationId === 'github-actions:901' &&
        entry.operation.status === 'running')).toBe(true);
      expect(f.transport.calls.filter((entry) => entry.path.includes('/jobs'))).toHaveLength(jobReads);
      expect(f.runner.calls.filter((entry) => entry.executable === 'gh')).toEqual([]);
      expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    }
  );
  it('persists real producer output through the engine and exposes a strict downstream immutable artifact interface', async () => {
    const f = await fixture(true);
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ applied: true });
    const saved = (await readState(f.root))!;
    const receipt = JSON.parse(await readFile(path.join(f.root, ...outcome.evidence!.pathParts), 'utf8'));
    const inspection = await coverageInspection({ root: f.root, phaseId: 'application-artifact-ready',
      state: saved, activationInputs: f.inputs, evidence: [receipt], reviewedPlans: await readReviewedTransitionPlans(f.root) });
    const freshness = validateEvidenceFreshness(receipt, inspection.contexts[f.phase.id]);
    expect(freshness, JSON.stringify(freshness)).toMatchObject({ valid: true });
    expect(readVerifiedApplicationArtifact(inspection)).toMatchObject({ sourceSha: f.transport.binding.sourceSha,
      digest: imageDigest, environment: 'dev', registryResourceId: f.prerequisite.registryId,
      workflowRunId: 901, workflowJobId: 902, acrRunId: 'ca1' });
    Object.assign(saved.phaseOutputs!['application-artifact-ready']!.values, { artifactDigest: 'latest' });
    expect(() => readVerifiedApplicationArtifact(inspection)).toThrow(/authoritative/);
  });
  it('refuses an earlier verified artifact after independently inspecting changed recipe or transmission consent', async () => {
    const f = await fixture(true);
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: true });
    const saved = (await readState(f.root))!;
    const receipt = JSON.parse(await readFile(path.join(f.root, ...outcome.evidence!.pathParts), 'utf8'));
    for (const change of [
      { contextPath: 'backend/changed' },
      { dockerfilePath: 'backend/Custom.Dockerfile' },
      { sourceTransmissionApproved: false }
    ]) {
      const changed = { ...f.inputs, phases: { ...f.inputs.phases,
        'application-artifact-ready': { ...f.inputs.phases['application-artifact-ready'], ...change } } };
      const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id,
        state: { ...saved, activationInputs: changed }, activationInputs: changed,
        evidence: [receipt], reviewedPlans: [f.input.plan] });
      expect(() => readVerifiedApplicationArtifact(inspection)).toThrow(/authoritative/);
    }
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('observes a real pending run without issuing a second dispatch', async () => {
    const f = await fixture(true); f.transport.runStatus = 'in_progress';
    const first = await executeApplicationArtifactPublication(f.input);
    expect(first).toMatchObject({ status: 'pending' });
    f.input.inspection.state.phases[f.phase.id].operation = first.operation;
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    first.operation!.planDigest = f.input.plan.planDigest;
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'pending' });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('reobserves a later engine retry using original dispatch time and never retags the historical handle', async () => {
    const f = await fixture(true); f.transport.runStatus = 'in_progress';
    const first = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(first).toMatchObject({ reason: 'external-operation-pending' });
    const saved = (await readState(f.root))!;
    const inspection = await coverageInspection({ root: f.root, phaseId: f.phase.id, state: saved,
      activationInputs: f.inputs, approvals: f.input.inspection.approvals, evidence: f.input.inspection.evidence,
      reviewedPlans: [f.input.plan] });
    inspection.loadedState = await loadActivationState(f.root);
    for (const id of ['bootstrap-local', 'remote-import-verified'] as const) {
      inspection.contexts[id].reviewedPlans = f.input.inspection.contexts[id].reviewedPlans;
    }
    f.transport.runStatus = 'completed';
    const next = await executeApplyNext({ inspection, reinspect: async () => inspection, runner: f.runner,
      now: new Date(coverageNow.getTime() + 1000), adapters: f.input.adapters });
    expect(next, JSON.stringify(next)).toMatchObject({ applied: true });
    const operation = (await readState(f.root))!.phases[f.phase.id].operation!;
    expect(operation).toMatchObject({ status: 'completed', planDigest: saved.phases[f.phase.id].operation!.planDigest });
    expect(Date.parse(operation.observedAt)).toBeGreaterThan(Date.parse(saved.phases[f.phase.id].operation!.observedAt));
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('preserves a confirmed actual dispatch when source changes before outcome persistence', async () => {
    const f = await fixture(true); f.transport.runStatus = 'in_progress';
    f.transport.onRunRead = async () => { await writeFile(path.join(f.root, 'backend', 'Dockerfile'), 'FROM preserved-customization\n'); };
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: false, reason: 'blocked',
      blockers: ['Relevant project inputs changed during execution; no outcome was persisted.'] });
    const saved = await readState(f.root);
    expect(saved?.phases['application-artifact-ready']).toMatchObject({ state: 'running',
      operation: { operationId: 'github-actions:901', resourceId: '/repos/owner/repo/actions/runs/901' } });
    expect(await readFile(path.join(f.root, 'backend', 'Dockerfile'), 'utf8')).toBe('FROM preserved-customization\n');
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('keeps published partial progress but does not qualify a changed/mutable digest', async () => {
    const f = await fixture(true); f.runner.tagMutable = true;
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked',
      operation: { status: 'completed' }, outputs: { values: { artifactDigest: imageDigest, acrRunId: 'ca1' } },
      blocker: expect.stringMatching(/writable\/deletable/) });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it('retains completed dispatch truth when independently sealed authority disappears before readback', async () => {
    const f = await fixture(true);
    f.transport.onRunRead = async () => {
      const authority = await createScopedUserLocalRecordStore(f.root, 'governance-approval')
        .read(canonicalApprovalEnvelopeHash(f.input.inspection.approvals[0]!));
      await rm(authority!.path);
    };
    const outcome = await executeApplyNext({ inspection: f.input.inspection, reinspect: async () => f.input.inspection,
      runner: f.runner, now: coverageNow, adapters: f.input.adapters });
    expect(outcome).toMatchObject({ applied: false, blockers: [expect.stringMatching(/external authority/)] });
    const state = (await readState(f.root))!;
    expect(state.phases[f.phase.id]).toMatchObject({ state: 'blocked', operation: {
      operationId: 'github-actions:901', status: 'completed'
    } });
    expect(f.runner.calls.filter((entry) => entry.executable === 'gh')).toEqual([]);
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it.each(['invisible', 'duplicate'] as const)('refuses unavailable/ambiguous %s fresh publication without treating a candidate as proof', async (kind) => {
    const f = await fixture(true, false, 'exact', 'fresh'); f.transport[kind] = true;
    f.transport.dispatched = kind === 'duplicate';
    f.transport.dispatchResponse = null;
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', blocker: expect.stringMatching(/no-replace|ambiguous/)
    });
    f.input.inspection.state.phases[f.phase.id].executionPlanDigest = f.input.plan.planDigest;
    expect(await executeApplicationArtifactPublication(f.input)).not.toMatchObject({ status: 'completed' });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
  it.each(['source', 'recipe', 'untracked', 'ref'] as const)('refuses changed %s before source transmission/build dispatch', async (kind) => {
    const f = await fixture(true);
    if (kind === 'source') await writeFile(path.join(f.root, 'backend', 'Dockerfile'), 'FROM changed\n');
    if (kind === 'recipe') await writeFile(path.join(f.root, ...f.transport.binding.workflowPath.split('/')), `${f.transport.workflow}\n`);
    if (kind === 'untracked') await writeFile(path.join(f.root, 'backend', 'custom.ts'), '// preserved\n');
    if (kind === 'ref') f.transport.movedSource = true;
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked' });
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toEqual([]);
    if (kind === 'source') expect(await readFile(path.join(f.root, 'backend', 'Dockerfile'), 'utf8')).toBe('FROM changed\n');
  });
  it.each(['digest', 'mutable', 'wrong-run', 'wrong-source', 'tag-only'] as const)('rejects %s independent publication proof', async (kind) => {
    const f = await fixture(true);
    const values = { artifactBindingDigest: f.transport.binding.bindingDigest, sourceSha: f.transport.binding.sourceSha,
      workflowDigest: f.transport.binding.workflowDigest, registryResourceId: f.transport.binding.registryId,
      acrRunId: 'ca1', artifactDigest: imageDigest };
    if (kind === 'digest') f.runner.actualDigest = `sha256:${'e'.repeat(64)}`;
    if (kind === 'mutable') f.runner.tagMutable = true;
    if (kind === 'wrong-run') f.runner.attestationRun = '999';
    if (kind === 'wrong-source') f.runner.attestationSource = 'f'.repeat(40);
    if (kind === 'tag-only') values.artifactDigest = 'latest';
    await expect(observeImmutableApplicationArtifact(f.input, { values, resources: [] }, {
      provider: 'github', actionId: 'github.artifact.build-dispatch', operationId: 'github-actions:901',
      resourceId: '/repos/owner/repo/actions/runs/901', status: 'completed', startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString()
    })).rejects.toThrow();
  });
  it.each(['acr-run', 'tag', 'digest', 'attestation', 'final-tag'] as const)(
    'retains original artifact inputs while the %s read is awaiting a response', async (boundary) => {
      const f = await fixture(true);
      const binding = f.transport.binding;
      const values = { artifactBindingDigest: binding.bindingDigest, sourceSha: binding.sourceSha,
        workflowDigest: binding.workflowDigest, registryResourceId: binding.registryId,
        acrRunId: 'ca1', artifactDigest: imageDigest };
      const outputs = { values, resources: [] };
      const operation = {
        provider: 'github' as const, actionId: 'github.artifact.build-dispatch', operationId: 'github-actions:901',
        resourceId: '/repos/owner/repo/actions/runs/901', status: 'completed' as const,
        startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString(), planDigest: f.input.plan.planDigest
      };
      const original = structuredClone(await observeImmutableApplicationArtifact(f.input, outputs, operation));
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const run = f.runner.run.bind(f.runner);
      let tagReads = 0;
      const calls: ExternalCommand[] = [];
      vi.spyOn(f.runner, 'run').mockImplementation(async (command, options) => {
        calls.push(command);
        const key = command.args.join(' ');
        const tagRead = key.startsWith('acr repository show ') && argument(command, '--image') === `${binding.imageRepository}:${binding.tag}`;
        if (tagRead) tagReads++;
        const selected = boundary === 'acr-run' ? key.startsWith('acr task show-run ')
          : boundary === 'attestation' ? command.executable === 'gh'
          : boundary === 'digest' ? key.startsWith('acr repository show ') && argument(command, '--image') === `${binding.imageRepository}@${imageDigest}`
          : tagRead && tagReads === (boundary === 'tag' ? 1 : 2);
        if (selected) { entered.resolve(); await release.promise; }
        return run(command, options);
      });
      const progress = vi.spyOn(f.input, 'recordApplicationProgress');
      const intent = vi.spyOn(f.input, 'recordApplicationDispatchIntent');
      const phase = structuredClone(f.input.inspection.state.phases[f.phase.id]);
      const pending = observeImmutableApplicationArtifact(f.input, outputs, operation);
      await entered.promise;
      try {
        Object.assign(values, { artifactBindingDigest: 'e'.repeat(64), sourceSha: 'f'.repeat(40),
          workflowDigest: 'e'.repeat(64), registryResourceId: `${binding.registryId}-replacement`,
          acrRunId: 'ca2', artifactDigest: `sha256:${'e'.repeat(64)}` });
        outputs.values = { ...values, acrRunId: 'ca3' };
        Object.assign(operation, { operationId: 'github-actions:999', resourceId: '/repos/owner/repo/actions/runs/999',
          startedAt: new Date(coverageNow.getTime() + 1000).toISOString(), planDigest: 'f'.repeat(64) });
        Object.assign(f.inputs.phases['application-artifact-ready']!, {
          sourceSha: 'f'.repeat(40), workflowDigest: 'e'.repeat(64), imageRepository: 'application/replacement'
        });
      } finally { release.resolve(); }
      expect(await pending).toEqual(original);
      expect(argument(calls[0]!, '--run-id')).toBe('ca1');
      expect(calls.filter((command) => command.args.join(' ').startsWith('acr repository show '))
        .map((command) => argument(command, '--image'))).toEqual([
        `${binding.imageRepository}:${binding.tag}`, `${binding.imageRepository}@${imageDigest}`,
        `${binding.imageRepository}:${binding.tag}`
      ]);
      expect(calls.find((command) => command.executable === 'gh')!.args).toContain(binding.sourceSha);
      expect(calls).toHaveLength(5);
      expect(f.transport.calls).toEqual([]);
      expect(f.runner.writes).toEqual([]);
      expect(progress).not.toHaveBeenCalled();
      expect(intent).not.toHaveBeenCalled();
      expect(f.input.inspection.state.phases[f.phase.id]).toEqual(phase);
      expect(operation.operationId).toBe('github-actions:999');
      expect(outputs.values.acrRunId).toBe('ca3');
      expect(f.inputs.phases['application-artifact-ready']!.imageRepository).toBe('application/replacement');
    }
  );
  it.each(['acr-run', 'operation', 'tag', 'digest', 'source'] as const)(
    'refuses replacement %s proof after caller inputs change during the original read', async (replacement) => {
      const f = await fixture(true);
      const binding = f.transport.binding;
      const values = { artifactBindingDigest: binding.bindingDigest, sourceSha: binding.sourceSha,
        workflowDigest: binding.workflowDigest, registryResourceId: binding.registryId,
        acrRunId: 'ca1', artifactDigest: imageDigest };
      const operation = {
        provider: 'github' as const, actionId: 'github.artifact.build-dispatch', operationId: 'github-actions:901',
        resourceId: '/repos/owner/repo/actions/runs/901', status: 'completed' as const,
        startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString(), planDigest: f.input.plan.planDigest
      };
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const run = f.runner.run.bind(f.runner);
      const calls: ExternalCommand[] = [];
      vi.spyOn(f.runner, 'run').mockImplementation(async (command, options) => {
        calls.push(command);
        const selected = ['operation', 'source'].includes(replacement)
          ? command.executable === 'gh' : command.args.join(' ').startsWith('acr task show-run ');
        if (selected) { entered.resolve(); await release.promise; }
        const observed = await run(command, options);
        if (selected && replacement === 'acr-run') {
          return { ...observed, stdout: JSON.stringify({ ...JSON.parse(observed.stdout), runId: 'ca2' }) };
        }
        return observed;
      });
      const pending = observeImmutableApplicationArtifact(f.input, { values, resources: [] }, operation);
      const rejected = expect(pending).rejects.toThrow(
        ['operation', 'source'].includes(replacement) ? /certificate does not bind/ : /ACR publication run does not own/
      );
      await entered.promise;
      try {
        if (replacement === 'acr-run') values.acrRunId = 'ca2';
        if (replacement === 'operation') {
          operation.operationId = 'github-actions:999';
          operation.resourceId = '/repos/owner/repo/actions/runs/999';
          f.runner.attestationRun = '999';
        }
        if (replacement === 'tag') {
          Object.assign(f.inputs.phases['application-artifact-ready']!, { imageRepository: 'application/replacement' });
          f.runner.artifact = { ...binding, tag: `${binding.tag}-replacement` };
        }
        if (replacement === 'digest') {
          values.artifactDigest = `sha256:${'e'.repeat(64)}`;
          f.runner.actualDigest = values.artifactDigest;
        }
        if (replacement === 'source') {
          values.sourceSha = 'f'.repeat(40);
          Object.assign(f.inputs.phases['application-artifact-ready']!, { sourceSha: values.sourceSha });
          f.runner.attestationSource = values.sourceSha;
        }
      } finally { release.resolve(); }
      await rejected;
      expect(argument(calls[0]!, '--run-id')).toBe('ca1');
      expect(calls).toHaveLength(['operation', 'source'].includes(replacement) ? 4 : 1);
      expect(f.transport.calls).toEqual([]);
      expect(f.runner.writes).toEqual([]);
      expect(f.input.inspection.state.phases[f.phase.id].state).not.toBe('verified');
      expect(operation).toMatchObject({ startedAt: coverageNow.toISOString(), planDigest: f.input.plan.planDigest });
    }
  );
  it('withholds completion after a failed job and retains its actual operation for recovery', async () => {
    const f = await fixture(true); f.transport.conclusion = 'failure';
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({ status: 'blocked',
      operation: { status: 'failed' }, cleanupWarnings: expect.any(Array) });
  });
  it('requires independent source, network and build consent instead of resource approval', async () => {
    const f = await fixture(true);
    Object.assign(f.inputs.phases['application-artifact-ready']!, { dependencyNetworkApproved: false });
    expect(() => applicationArtifactBinding(f.input)).toThrow(/each require explicit consent/);
    expect(f.transport.calls.filter((entry) => entry.method === 'POST')).toEqual([]);
  });
  it('bounds total process observation instead of extending per-call deadlines', async () => {
    const f = await fixture();
    const bounded = applicationDeadlineInput(f.input);
    await bounded.runner.run({ executable: 'tofu', args: ['version'] }, { timeoutMs: 600_000, maxOutputBytes: 100_000_000 });
    expect(f.runner.options.at(-1)).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(Date.now() + 180_001);
    await expect(bounded.runner.run({ executable: 'tofu', args: ['version'] })).rejects.toThrow(/deadline/);
    clock.mockRestore();
  });
  it.each(['custody', 'transport'] as const)('bounds a nonsettling registered %s port without fallback', async (kind) => {
    const f = await fixture();
    if (kind === 'custody') f.input.adapters.protectedStateCustody!.qualify = () => new Promise(() => {});
    else f.transport.request = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const bounded = applicationDeadlineInput(f.input);
      const pending = kind === 'custody'
        ? bounded.adapters.protectedStateCustody!.qualify(protectedStateCustodyRequest(f.input))
        : bounded.adapters.githubActivation!.transport!.request({ method: 'GET', path: '/repos/owner/repo' });
      const assertion = expect(pending).rejects.toThrow(/bounded deadline/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  it('rejects a tag changed after attestation instead of treating the initial digest as final proof', async () => {
    const f = await fixture(true);
    let reads = 0;
    f.runner.onManifestRead = () => { if (++reads === 3) f.runner.actualDigest = `sha256:${'e'.repeat(64)}`; };
    expect(await executeApplicationArtifactPublication(f.input)).toMatchObject({
      status: 'blocked', operation: { status: 'completed' }, blocker: expect.stringMatching(/digest\/tag changed/)
    });
  });
});
