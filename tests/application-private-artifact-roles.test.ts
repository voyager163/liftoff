import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeCommandRunner } from '../src/process-runner.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import { object, parseHcl, singleBlock } from '../src/adapters/hcl/semantic.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { nativeStateHostId } from '../src/adapters/state/native-system.js';
import { stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import { stateBindingDigest, stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../src/domain/governance/activation/approvals.js';
import { evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { phaseIds, type PhaseEvidenceRecord } from '../src/domain/governance/activation/types.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import {
  evidenceHeaderFor, evidencePathParts, nextStateForOutcome, saveTransitionPlan, transitionPlanPathParts, writeOutcomeTransaction
} from '../src/governance-activation/transition-records.js';
import type {
  GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhasePlanBuild, PhasePlanningInput
} from '../src/governance-activation/transition-ports.js';
import type { StateBackendMetadata } from '../src/domain/repair/stateful.js';
import type { AzureStateRequest } from '../src/domain/repair/stateful.js';
import { requiredApplicationArtifacts, type ApplicationArtifactRole } from '../src/application/azure-activation/application-artifact-inputs.js';
import {
  applicationBuildWorkflowJob, applicationBuildWorkflowRecipeId, renderApplicationBuildWorkflow, type ApplicationBuildWorkflowRecipe
} from '../src/application/azure-activation/application-build-workflow.js';
import {
  applicationArtifactSetDigest, applicationArtifactSetInputs, planApplicationArtifactSetReady,
  type ApplicationArtifactSetConfiguration, type ApplicationArtifactSetEvidence, type ApplicationArtifactSetReference
} from '../src/application/azure-activation/application-artifact-set.js';
import { executeApplicationArtifactSetReady } from '../src/application/azure-activation/application-artifact-set-execution.js';
import {
  applicationPrivateArtifactForTarget, assertApplicationPrivateArtifactSet, assertApplicationPrivateArtifactVariables,
  readApplicationPrivateArtifactRoles
} from '../src/application/azure-activation/application-private-artifacts.js';
import {
  applicationPrivateContext, applicationPrivateInputs, applicationPrivateIntentDigest,
  applicationPrivateOperation, applicationPrivateReadResourceIds, assertApplicationPrivateReview
} from '../src/application/azure-activation/application-private-inputs.js';
import { inspectApplicationPrivateSource } from '../src/application/azure-activation/application-private-source.js';
import { admitApplicationPrivatePlan, inspectApplicationPrivateCandidate } from '../src/application/azure-activation/application-private-plan.js';
import {
  executeApplicationPrivatePlan, planApplicationPrivateExecution
} from '../src/application/azure-activation/application-private-execution.js';
import { ApplicationPrivateResourceReader } from '../src/adapters/azure/application-private-readback.js';
import { createAzureCliArmTransport } from '../src/adapters/azure/activation-rest.js';
import type { ApplicationPrivateAdapters } from '../src/adapters/azure/application-private-runtime.js';
import type {
  ApplicationPrivateConfiguration, ApplicationPrivateIntent, ApplicationPrivateJournal, ApplicationPrivateResult,
  ApplicationPrivateSavedPlan, ApplicationPrivateTarget
} from '../src/application/azure-activation/application-private-contracts.js';
import {
  applicationReportZip, applicationRegistryId, applicationSubscription, applicationTenant
} from './helpers/application-artifact-fixture.js';
import { custody, encryptedFixtureWorkspace, fixtureBinding, fixtureTime, privateTarget } from './helpers/private-activation-fixture.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';

const now = fixtureTime;
const sourceSha = createHash('sha1').update('private role local fixture source; not live qualification').digest('hex');
const treeSha = createHash('sha1').update('private role local fixture tree').digest('hex');
const sha = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const repository = 'owner/repo', host = 'crliftoff.azurecr.io';
const budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 };
const rootParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
const moduleParts = ['infrastructure', 'opentofu', 'azure', 'modules', 'application'];
const group = `/subscriptions/${applicationSubscription}/resourceGroups/rg-app`;
const environmentId = `${group}/providers/Microsoft.App/managedEnvironments/apps`;
const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`;
const mirrorId = `${group}/providers/Microsoft.ContainerRegistry/registries/crmirror`;
const artifactPhase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'application-artifact-ready')!;
const privatePhase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'application-foundation')!;
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local frontend</title>' +
  '<script type="module">throw new Error("THIS_MUST_NEVER_EXECUTE")</script></head>' +
  '<body><div id="app">PRIVATE_DOCUMENT_CONTENT_NEVER_PERSISTED</div></body></html>';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function roleFixture(role: ApplicationArtifactRole) {
  const build: ApplicationBuildWorkflowRecipe = {
    schemaVersion: 1, recipe: applicationBuildWorkflowRecipeId,
    workflowPath: `.github/workflows/build-${role}.yml`, repository, repositoryId: 42, actorId: 7, ref: 'develop',
    azure: { tenantId: applicationTenant, clientId: '11111111-2222-4333-8444-555555555559',
      principalId: '11111111-2222-4333-8444-555555555558' },
    registry: { resourceId: applicationRegistryId, loginServer: host, location: 'eastus', repository: `team/${role}` },
    artifactName: `${role}-build-report`, platform: 'linux/amd64', context: role, dockerfile: `${role}/Dockerfile`,
    tools: { dockerVersion: '28.0.0', buildxVersion: 'v0.21.0',
      buildkitImage: `moby/buildkit@${sha('isolated buildkit protocol fixture, not an upstream pin')}` },
    uploadArtifactActionSha: createHash('sha1').update('isolated action protocol fixture').digest('hex'),
    budget, limits: { maxRunMinutes: 5, httpTimeoutSeconds: 5, commandTimeoutSeconds: 10, buildTimeoutSeconds: 120 }
  };
  const source = renderApplicationBuildWorkflow(build);
  const workflowId = role === 'backend' ? 4 : 5, runId = role === 'backend' ? 100 : 200;
  const workflow = {
    repository, repositoryId: 42, workflowPath: build.workflowPath, workflowId, workflowDigest: canonicalSha256(source),
    sourceSha, ref: 'develop', actorId: 7, event: 'workflow_dispatch' as const, expectedJobs: [applicationBuildWorkflowJob], runAttempt: 1
  };
  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: {
    Labels: { 'org.opencontainers.image.source': `https://github.com/${repository}`, 'org.opencontainers.image.revision': sourceSha },
    Env: [`PRIVATE_${role.toUpperCase()}_CONFIG=not-public`]
  } }));
  const layer = Buffer.from(`isolated ${role} OCI layer bytes`);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: sha(layer), size: layer.length }]
  }));
  const report = {
    schemaVersion: 1, kind: 'liftoff-application-build', source: { repository, repositoryId: 42, commitSha: sourceSha },
    producer: { workflowId, workflowPath: workflow.workflowPath, workflowDigest: workflow.workflowDigest,
      runId, runAttempt: 1, actorId: 7, jobId: runId * 10 },
    image: { registryResourceId: applicationRegistryId, loginServer: host, repository: build.registry.repository, digest: sha(manifest) },
    oci: { manifestBase64: manifest.toString('base64'), configBase64: config.toString('base64') }
  };
  return { role, build, workflow, source, manifest, report, archive: applicationReportZip(report), runId, artifactId: runId + 1,
    run: null as Record<string, unknown> | null, registryBytes: manifest };
}

function applicationTarget(role: ApplicationArtifactRole, imageRef: string): ApplicationPrivateTarget {
  const name = role === 'backend' ? 'api' : 'site';
  return {
    address: `module.application.azurerm_container_app.${role}`, type: 'azurerm_container_app',
    resourceId: `${group}/providers/Microsoft.App/containerApps/${name}`, actions: ['create'],
    expected: { name, resource_group_name: 'rg-app', container_app_environment_id: environmentId,
      revision_mode: 'Single', 'identity.0.type': 'UserAssigned', 'identity.0.identity_ids.0': identityId,
      'template.0.min_replicas': 1, 'template.0.max_replicas': 1, 'template.0.container.0.name': 'app',
      'template.0.container.0.image': imageRef, 'template.0.container.0.cpu': 0.25, 'template.0.container.0.memory': '0.5Gi',
      'ingress.0.external_enabled': true, 'ingress.0.target_port': role === 'backend' ? 8000 : 80,
      'ingress.0.transport': 'auto', 'tags.liftoff-repository-id': '42' },
    role: null,
    runtime: role === 'backend' ? { url: `https://${name}.fixture.azurecontainerapps.io/health`, statusField: 'status', statusValue: 'ok' }
      : { kind: 'frontend-html/1', url: `https://${name}.fixture.azurecontainerapps.io/` }
  };
}

function minimalModule(targets: readonly ApplicationPrivateTarget[]): string {
  return targets.map((target) => `resource "azurerm_container_app" "${target.address.split('.').at(-1)}" {
  name = "${target.expected.name}"
  resource_group_name = "rg-app"
  container_app_environment_id = "${environmentId}"
  revision_mode = "Single"
  tags = { liftoff-repository-id = "42" }
  identity {
    type = "UserAssigned"
    identity_ids = ["${identityId}"]
  }
  registry {
    server = "${host}"
    identity = "${identityId}"
  }
  template {
    min_replicas = 1
    max_replicas = 1
    container {
      name = "app"
      image = var.${target.address.split('.').at(-1)}_image
      cpu = 0.25
      memory = "0.5Gi"
    }
  }
  ingress {
    external_enabled = true
    target_port = ${target.expected['ingress.0.target_port']}
    transport = "auto"
    traffic_weight {
      percentage = 100
      latest_revision = true
    }
  }
}
`).join('\n');
}

async function sourceFixture(options: { frontend?: boolean; generated?: boolean } = {}) {
  const root = path.resolve(`tests/.private-artifact-roles-${randomUUID()}`), projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  cleanups.push(async () => { await stopOwnedStateProcessesIn(root); await rm(root, { recursive: true, force: true }); });
  const frontend = options.frontend ?? true;
  const project = buildProjectPlan({
    projectName: 'Private artifact roles', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
    environments: ['dev'], includeFrontend: frontend, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  const generated = buildArtifacts(project), manifest = parseManifest(JSON.parse(generated.find((entry) => entry.logicalName === 'manifest')!.content));
  const roles = { backend: roleFixture('backend'), frontend: roleFixture('frontend') };
  const targets = (frontend ? ['backend', 'frontend'] as const : ['backend'] as const)
    .map((role) => applicationTarget(role, `${host}/team/${role}@${roles[role].report.image.digest}`));
  for (const artifact of generated.filter((entry) => entry.pathParts.slice(0, 3).join('/') === 'infrastructure/opentofu/azure' &&
    entry.pathParts.at(-1)?.endsWith('.tf') && (options.generated || entry.pathParts.at(-1) !== 'outputs.tf'))) {
    const destination = path.join(projectRoot, ...artifact.pathParts);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, !options.generated && artifact.pathParts.join('/') === [...moduleParts, 'main.tf'].join('/')
      ? minimalModule(targets) : artifact.content);
  }
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  const versions = singleBlock((await parseHcl(await readFile(path.join(projectRoot, ...rootParts, 'versions.tf'), 'utf8'), 'Fixture versions')).terraform, 'Terraform');
  const providerVersion = object(singleBlock(versions.required_providers, 'Providers').azurerm, 'Azure provider').version;
  if (typeof providerVersion !== 'string') throw new Error('Generated source omitted its actual provider pin.');
  await writeFile(path.join(projectRoot, ...rootParts, '.terraform.lock.hcl'),
    `provider "registry.opentofu.org/hashicorp/azurerm" {\n version = "${providerVersion}"\n hashes = ["zh:${stateDigest('local provider archive fixture')}"]\n}\n`);
  const held = custody(root), variableId = randomUUID();
  const reference: ApplicationArtifactSetReference = {
    evidenceId: `local-set-${randomUUID()}`, headerDigest: stateDigest('local header placeholder'),
    bodyDigest: stateDigest('local body placeholder'), planPathParts: ['governance', 'plans', `application-artifact-ready-${randomUUID()}.json`],
    savedPlanDigest: stateDigest('local saved plan placeholder'), setDigest: stateDigest('local set placeholder')
  };
  const deployment = (target: ApplicationPrivateTarget) => ({
    address: target.address, imageRef: String(target.expected['template.0.container.0.image']), registryResourceId: applicationRegistryId
  });
  const intent: ApplicationPrivateIntent = {
    schemaVersion: 1, scope: 'foundation', binding: fixtureBinding, backend: privateTarget(), custody: held,
    writer: { ...fixtureBinding, clientId: randomUUID(), keychainPath: path.join(root, 'writer.keychain'),
      service: 'org.liftoff.azure-application-writer.fixture', account: '42' },
    source: { rootPathParts: rootParts, backendPathParts: [...rootParts, 'backend.local.tf'],
      variablesRef: `state-workspace:${held.workspaceId}/${variableId}`,
      provider: { source: 'registry.opentofu.org/hashicorp/azurerm', version: providerVersion, mirrorDirectory: path.join(root, 'mirror'),
        binary: { path: path.join(root, 'mirror', 'provider'), sha256: stateDigest('local provider fixture') } } },
    artifact: null, artifactSet: { reference, sourceSha,
      deployments: { backend: deployment(targets[0]!), ...(frontend ? { frontend: deployment(targets[1]!) } : {}) } },
    targets, notBefore: now.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z',
    releaseUntil: '2026-09-15T00:17:00.000Z', maxCommandMs: 5000
  };
  return { root, projectRoot, manifest, roles, intent, generated, variableId };
}

type SourceFixture = Awaited<ReturnType<typeof sourceFixture>>;

async function planningFixture(f: SourceFixture): Promise<PhasePlanningInput> {
    const runner = new NodeCommandRunner(), home = path.join(f.root, 'home');
    await mkdir(home, { mode: 0o700 }); await mkdir(path.join(f.projectRoot, 'governance'), { mode: 0o700 });
    const selected = (role: ApplicationArtifactRole) => ({
      componentId: requiredApplicationArtifacts(f.manifest).find((entry) => entry.role === role)!.component.id,
      workflow: f.roles[role].workflow, build: f.roles[role].build, principalId: fixtureBinding.principalId
    });
    const artifactSet: ApplicationArtifactSetConfiguration = {
      schemaVersion: 1, mode: 'artifact-set', source: { repository, repositoryId: 42, sourceSha },
      artifacts: { backend: selected('backend'), ...(f.intent.artifactSet!.deployments.frontend ? { frontend: selected('frontend') } : {}) }
    };
    const configuration = {
      schemaVersion: 1 as const, budget, azure: { subscriptionId: applicationSubscription, tenantId: applicationTenant, region: 'eastus' },
      phases: {
        'application-artifact-ready': artifactSet as unknown as Record<string, unknown>,
        'application-foundation': { privateExecution: { ...f.intent, mode: 'prepare' } }
      }
    };
    const state = validateUserActivationState({
      schemaVersion: 4, identity: currentActivationIdentity,
      repository: { id: `local:${randomUUID()}`, name: 'private-role-fixture', defaultBranch: 'develop' },
      remoteBinding: { id: '42', name: repository, defaultBranch: 'develop', pushUrl: `https://github.com/${repository}.git`, verifiedAt: now.toISOString() },
      activeChange: null, activationInputs: configuration,
      applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false, cloudStateRequired: true, privateRunnerRequired: false },
      phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }])),
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    });
    await writeFile(path.join(f.projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
    const snapshot = await readActivationInputSnapshot(f.projectRoot, f.manifest, runner);
    const inspection: GovernanceTransitionInspection = {
      projectRoot: f.projectRoot, manifest: f.manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash,
      scope: 'activation', activationInputs: configuration, state, loadedState: await loadActivationState(f.projectRoot),
      approvals: [], evidence: [], contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
      readiness: { nextReadyPhase: privatePhase.id, phases: state.phases },
      sourceOfTruth: { status: 'none', selected: null, candidates: [],
        createPlan: { status: 'blocked', changeId: 'private-role-fixture', workflowKind: 'openspec',
          reason: 'Local fixtures do not qualify deployment.', requiredFacts: [] } }
    };
    const storage = { homedir: home, repositoryRoot: f.projectRoot, env: {}, clock: () => now };
    return { inspection, phase: privatePhase, runner, now, adapters: { azureActivation: { storage }, githubActivation: { storage } } };
  }

  async function approve(input: PhasePlanningInput, build: PhasePlanBuild, recovery = false): Promise<PhaseAdapterExecutionInput> {
    expect(build.blockers, JSON.stringify(build)).toBeUndefined();
    if (!input.adapters) throw new Error('Local approval requires explicit isolated private storage.');
    const { inspection, phase } = input, configuration = inspection.activationInputs;
    const snapshot = await readActivationInputSnapshot(inspection.projectRoot, inspection.manifest, input.runner);
    inspection.state.activationInputs = configuration;
    const contexts = activationEvidenceContexts(canonicalPhaseGraph, inspection.state, snapshot, now);
    for (const id of phaseIds) contexts[id].reviewedPlans = inspection.contexts[id].reviewedPlans;
    inspection.contexts = contexts;
    const context = contexts[phase.id];
    const request = transitionPlanForPhase(phase, inspection.state, context.transition, inspection.projectRoot, undefined, {
      operations: build.operations, selectionScope: 'activation', fileChanges: [], recovery, configuration
    });
    const expiresAt = '2026-09-15T00:15:00.000Z';
    const envelope = validateApprovalEnvelope({ ...request, schemaVersion: 4, id: randomUUID(),
      approvedAt: now.toISOString(), expiresAt, approver: 'isolated-local-fixture' });
    await withProjectMutationLock(inspection.projectRoot, () => writeGovernanceApprovalAuthority(
      inspection.projectRoot, canonicalSha256(request), envelope, input.adapters?.azureActivation?.storage));
    inspection.approvals = [...inspection.approvals, envelope];
    const evaluation = evaluateApprovalForTransitionPlan(request, [envelope], { now });
    const plan = validateSavedTransitionPlan({
      schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id, createdAt: now.toISOString(), expiresAt,
      identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash, stateHash: inspection.loadedState!.contentHash,
      baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
      planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations: build.operations, approvalPlanDigest: request.planDigest }),
      mutationClasses: phase.allowedMutations, operations: build.operations, approval: {
        gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
        envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash
      }, rollbackPlan: rollbackPlanForPhase(phase), fileChanges: [], recovery, noSecrets: true, configuration
    });
    return { ...input, adapters: input.adapters, plan, clock: () => now, recovery };
  }

  async function produceSet(f: SourceFixture, planning: PhasePlanningInput) {
    const source = { ...planning, phase: artifactPhase };
    const input = await approve(source, planApplicationArtifactSetReady(source));
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeApplicationArtifactSetReady({ ...input, lease }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified' });
    const { inspection, plan } = input;
    const payload = { ...outcome.evidencePayload as ApplicationArtifactSetEvidence,
      planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan), outputBindings: outcome.outputs };
    const evidenceId = `local-artifact-set-${randomUUID()}`;
    const record: PhaseEvidenceRecord = {
      evidenceId, payload, liveReadback: outcome.liveReadback,
      header: evidenceHeaderFor({ inspection, phase: artifactPhase, plan, result: 'verified', now, payload, liveReadback: outcome.liveReadback })
    };
    const next = nextStateForOutcome({
      inspection, phase: artifactPhase, plan, resultState: 'verified', now, operation: outcome.operation, outputs: outcome.outputs,
      evidenceReference: { phaseId: artifactPhase.id, evidenceId, headerDigest: evidenceHeaderDigest(record.header), result: 'verified' }
    });
    await withProjectMutationLock(f.projectRoot, async () => {
      await saveTransitionPlan(f.projectRoot, plan);
      await writeOutcomeTransaction({ projectRoot: f.projectRoot, plan, nextState: next, evidenceRecord: record,
        evidencePathParts: evidencePathParts(evidenceId), expectedStateHash: inspection.loadedState!.contentHash });
    });
    inspection.state = next; inspection.loadedState = await loadActivationState(f.projectRoot); inspection.evidence = [record];
    inspection.contexts[artifactPhase.id] = { ...inspection.contexts[artifactPhase.id],
      reviewedPlans: [plan], evidenceReferences: next.phases[artifactPhase.id].evidence };
    const reference: ApplicationArtifactSetReference = {
      evidenceId, headerDigest: evidenceHeaderDigest(record.header), bodyDigest: record.header.bodyDigest!,
      planPathParts: transitionPlanPathParts(plan), savedPlanDigest: canonicalSha256(plan),
      setDigest: applicationArtifactSetDigest(applicationArtifactSetInputs(input))
    };
    f.intent.artifactSet!.reference = reference;
    inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: { ...f.intent, mode: 'prepare' } };
    return { input, outcome, record, reference };
  }

  function targetValues(target: ApplicationPrivateTarget) {
    return {
      id: target.resourceId, name: target.expected.name, resource_group_name: 'rg-app', tags: { 'liftoff-repository-id': '42' },
      container_app_environment_id: environmentId, revision_mode: 'Single',
      identity: [{ type: 'UserAssigned', identity_ids: [identityId] }],
      registry: [{ server: String(target.expected['template.0.container.0.image']).split('/')[0], identity: identityId }],
      template: [{ min_replicas: 1, max_replicas: 1, container: [{
        name: 'app', image: target.expected['template.0.container.0.image'], cpu: 0.25, memory: '0.5Gi'
      }] }],
      ingress: [{ external_enabled: true, target_port: target.expected['ingress.0.target_port'], transport: 'auto',
        traffic_weight: [{ percentage: 100, latest_revision: true }] }]
    };
  }

  function armApplication(target: ApplicationPrivateTarget) {
    const values = targetValues(target), revision = `${target.expected.name}--fixture1`;
    return {
      id: target.resourceId, type: 'Microsoft.App/containerApps', name: target.expected.name, location: 'eastus', tags: values.tags,
      identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } },
      properties: { provisioningState: 'Succeeded', runningStatus: 'Running', managedEnvironmentId: environmentId,
        latestRevisionName: revision, latestReadyRevisionName: revision,
        configuration: { activeRevisionsMode: 'Single', registries: values.registry, secrets: [],
          ingress: { fqdn: new URL(target.runtime!.url).hostname, external: true, targetPort: values.ingress[0]!.target_port,
            transport: 'auto', traffic: [{ latestRevision: true, weight: 100 }] } },
        template: { scale: { minReplicas: 1, maxReplicas: 1 },
          containers: [{ name: 'app', image: values.template[0]!.container[0]!.image, resources: { cpu: 0.25, memory: '0.5Gi' } }] } }
    };
  }

  function savedPlanFixture(f: SourceFixture) {
    const original = Buffer.from(JSON.stringify({ version: 4, terraform_version: '1.12.6',
      lineage: randomUUID(), serial: 1, outputs: { private: { sensitive: true, value: 'PRIVATE_ORIGINAL_OUTPUT' } }, resources: [] }));
    const metadata: StateBackendMetadata = {
      backendId: f.intent.backend.backend.id, bindingDigest: stateBindingDigest(f.intent.backend.backend),
      exists: true, etag: '"original"', version: 'original', size: original.length, observedAt: now.getTime()
    };
    const value = {
      format_version: '1.2', terraform_version: '1.12.6', complete: true, errored: false, applyable: true,
      configuration: { provider_config: { azurerm: { full_name: f.intent.source.provider.source } },
        root_module: { module_calls: { application: { source: '../../modules/application', module: {
          resources: f.intent.targets.map((target) => ({ address: target.address.slice('module.application.'.length), provider_config_key: 'azurerm' }))
        } } } } },
      resource_changes: f.intent.targets.map((target) => ({ address: target.address, mode: 'managed', type: target.type,
        provider_name: f.intent.source.provider.source,
        change: { actions: ['create'], before: null, after: { ...targetValues(target), id: null }, after_unknown: { id: true } } }))
    };
    const candidate = (targets: readonly ApplicationPrivateTarget[]) => Buffer.from(JSON.stringify({
      ...JSON.parse(original.toString()), serial: 1 + targets.length, resources: targets.map((target) => ({
        module: 'module.application', type: target.type, name: target.address.split('.').at(-1), mode: 'managed',
        provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]', instances: [{ schema_version: 0, attributes: targetValues(target) }]
      }))
    }));
    return { original, metadata, value, candidate };
  }

  async function nativeFixture(f: SourceFixture, providers: LocalRoleProviders) {
    const held = f.intent.custody;
    held.tools.hostId = nativeStateHostId(); f.intent.backend.hostId = held.tools.hostId;
    await mkdir(held.workspaceRoot, { mode: 0o700 });
    const directory = path.join(f.root, 'native'); await mkdir(directory, { mode: 0o700 });
    const auditPath = path.join(directory, 'audit.jsonl'), controlPath = path.join(directory, 'control.json');
    providers.rowsPath = path.join(directory, 'provider-state.json');
    await writeFile(auditPath, '', { mode: 0o600 }); await writeFile(controlPath, '{}', { mode: 0o600 });
    await writeFile(providers.rowsPath, '{}', { mode: 0o600 });
    const platform = `darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, provider = f.intent.source.provider;
    const providerDirectory = path.join(directory, 'mirror', 'registry.opentofu.org', 'hashicorp', 'azurerm', provider.version, platform);
    await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
    const providerBytes = 'ISOLATED_PROVIDER_FIXTURE_NOT_A_QUALIFIED_PACKAGE';
    provider.mirrorDirectory = path.join(directory, 'mirror');
    provider.binary = { path: path.join(providerDirectory, `terraform-provider-azurerm_v${provider.version}`), sha256: stateDigest(providerBytes) };
    await writeFile(provider.binary.path, providerBytes, { mode: 0o500 });
    const native = savedPlanFixture(f), executable = await realpath(process.execPath);
    const script = `#!${executable}
  import fs from 'node:fs';
  import path from 'node:path';
  import crypto from 'node:crypto';
  const args=process.argv.slice(2), command=args[0];
  const audit=${JSON.stringify(auditPath)}, rowsPath=${JSON.stringify(providers.rowsPath)}, controls=${JSON.stringify(controlPath)};
  const append=value=>fs.appendFileSync(audit, JSON.stringify(value)+'\\n');
  if(command==='version') {
   process.stdout.write(JSON.stringify({terraform_version:'1.12.6',platform:${JSON.stringify(platform)}})); process.exit(0);
  }
  const root=process.cwd(), fault=JSON.parse(fs.readFileSync(controls,'utf8'));
  const statePath=JSON.parse(fs.readFileSync(path.join(root,'liftoff-application-backend.tf.json'),'utf8')).terraform.backend.local.path;
  append({kind:args.includes('-refresh-only')?'refresh':command,args,hasPrivateWriter:Boolean(process.env.ARM_CLIENT_SECRET)});
  if(command==='init') {
   const install=path.join(root,'.terraform','providers','registry.opentofu.org','hashicorp','azurerm',${JSON.stringify(provider.version)});
   fs.mkdirSync(install,{recursive:true,mode:448});
   fs.symlinkSync(${JSON.stringify(providerDirectory)},path.join(install,${JSON.stringify(platform)}),'dir');
   fs.mkdirSync(path.join(root,'.terraform','modules'),{recursive:true,mode:448});
   fs.writeFileSync(path.join(root,'.terraform','modules','modules.json'),JSON.stringify({Modules:[
    {Key:'',Source:'',Dir:'.'},{Key:'application',Source:'../../modules/application',Dir:'../../modules/application'}
   ]}),{mode:384}); process.exit(0);
  }
  if(command==='plan' && args.includes('-refresh-only')) {
   const state=JSON.parse(fs.readFileSync(statePath,'utf8')), rows=JSON.parse(fs.readFileSync(rowsPath,'utf8'));
   for(const resource of state.resources) {
    const value=resource.instances[0].attributes;
    if(rows[value.id]?.properties.template.containers[0].image !== value.template[0].container[0].image) process.exit(2);
   }
   process.exit(fault.refreshDrift?2:0);
  }
  if(command==='plan') {
   const plan=${JSON.stringify(native.value)};
   const variables=JSON.parse(fs.readFileSync(path.join(root,'liftoff.private.tfvars.json'),'utf8'));
   plan.variables=Object.fromEntries(Object.entries(variables).map(([key,value])=>[key,{value}]));
   fs.writeFileSync(args.find(arg=>arg.startsWith('-out=')).slice(5),JSON.stringify(plan),{mode:384}); process.exit(2);
  }
  if(command==='show') { process.stdout.write(fs.readFileSync(args[2])); process.exit(0); }
  if(command!=='apply') process.exit(92);
  const bytes=fs.readFileSync(args.at(-1)), digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const plan=JSON.parse(bytes), entries=fs.readFileSync(audit,'utf8').trim().split('\\n').map(JSON.parse);
  if(!plan.resource_changes.every(change=>entries.some(entry=>entry.kind==='durable-intent' &&
   entry.value.address===change.address && entry.value.savedPlanDigest===digest && entry.value.artifactSet &&
   entry.value.artifactRole===change.address.split('.').at(-1)))) process.exit(93);
  append({kind:'applied-whole-saved-plan',digest,addresses:plan.resource_changes.map(change=>change.address)});
  const targets=${JSON.stringify(f.intent.targets)}, arm=${JSON.stringify(f.intent.targets.map(armApplication))};
  const state=JSON.parse(fs.readFileSync(statePath,'utf8')), rows=JSON.parse(fs.readFileSync(rowsPath,'utf8'));
  for(const [index,change] of plan.resource_changes.entries()) {
   const target=targets.find(entry=>entry.address===change.address), value={...change.change.after,id:target.resourceId};
   rows[target.resourceId]=arm[index];
   state.resources.push({module:'module.application',type:target.type,name:change.address.split('.').at(-1),mode:'managed',
    provider:'provider["registry.opentofu.org/hashicorp/azurerm"]',instances:[{schema_version:0,attributes:value}]});
   state.serial++;
   fs.writeFileSync(rowsPath,JSON.stringify(rows),{mode:384}); fs.writeFileSync(statePath,JSON.stringify(state),{mode:384});
   append({kind:'local-provider-effect',address:change.address});
   if(fault.partial && index===0) process.exit(1);
  }
  process.stdout.write('PRIVATE_NATIVE_OUTPUT_NEVER_PUBLIC'); process.exit(0);
  `;
    const python = `#!${executable}\nprocess.stdout.write(JSON.stringify({implementation:'CPython',version:'3.14.0'}));\n`;
    held.tools.tofu = { path: path.join(directory, 'tofu'), sha256: stateDigest(script) };
    held.tools.python = { path: path.join(directory, 'python'), sha256: stateDigest(python) };
    await writeFile(held.tools.tofu.path, script, { mode: 0o500 }); await writeFile(held.tools.python.path, python, { mode: 0o500 });
    const { workspace } = encryptedFixtureWorkspace(held), put = workspace.put.bind(workspace);
    workspace.put = async (purpose, scope, bytes, id) => {
      const descriptor = await put(purpose, scope, bytes, id);
      if (purpose === 'journal') {
        const value = JSON.parse(Buffer.from(bytes).toString());
        if (value.kind === 'resource-effect-intent') await appendFile(auditPath, JSON.stringify({ kind: 'durable-intent', value }) + '\n');
      }
      return descriptor;
    };
    let http: ReturnType<typeof privateStateHttpFixture> | undefined;
    const pending = new Map<string, AzureStateRequest>();
    const adapters: ApplicationPrivateAdapters = {
      storage: { workspace, async assertDirectory(directory, context) {
        expect(context.hostId).toBe(nativeStateHostId());
        const relative = path.relative(held.workspaceRoot, directory), info = await lstat(directory);
        expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
        expect(await realpath(directory)).toBe(directory);
        expect(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0).toBe(true);
      } },
      bridge: { async request(operation) {
        expect(operation).toBe('keychain-secret');
        return { uid: process.getuid?.(), value: Buffer.from('PRIVATE_FIXTURE_WRITER_VALUE').toString('base64') };
      } },
      backend(recorder) {
        const fresh = privateStateHttpFixture(f.intent.backend, recorder);
        fresh.blob.bytes = Uint8Array.from(http?.blob.bytes ?? native.original);
        if (http) {
          fresh.blob.version = http.blob.version; fresh.blob.operationId = http.blob.operationId;
          fresh.blob.leaseId = http.blob.leaseId; fresh.blob.calls = http.blob.calls;
        }
        const actual = fresh.blob.send.bind(fresh.blob);
        providers.blobRequest = async (request, bytes) => {
          const original = pending.get(String(request.headers['x-fixture-request']));
          expect(original).toBeDefined(); expect(request.method).toBe(original!.method);
          for (const [key, value] of Object.entries(original!.headers ?? {})) expect(request.headers[key]).toBe(value);
          const result = await actual({ ...original!, ...(original!.body ? { body: new Uint8Array(bytes) } : {}) });
          return { ...result, headers: { ...result.headers,
            ...(request.method === 'HEAD' ? {} : { 'content-length': String(result.body.length) }) } };
        };
        fresh.blob.send = async (request) => {
          const id = randomUUID(); pending.set(id, request);
          try {
            const response = await providers.originalFetch(`${providers.address}/fixture-blob`, {
              method: request.method, redirect: 'error', signal: request.signal, headers: { ...request.headers, 'x-fixture-request': id },
              ...(request.body ? { body: new Uint8Array(request.body) } : {})
            });
            return { status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
          } finally { pending.delete(id); }
        };
        http = fresh; return fresh.path.backend;
      }
    };
    const enroll = async (input: PhasePlanningInput) => {
      const config: ApplicationPrivateConfiguration = { ...f.intent, mode: 'prepare' };
      const context = applicationPrivateContext(input, config);
      await workspace.assertAvailable(context);
      const variables = { backend_image: f.intent.artifactSet!.deployments.backend.imageRef,
        frontend_image: f.intent.artifactSet!.deployments.frontend!.imageRef, postgres_admin_password: 'PRIVATE_VARIABLE_VALUE',
        resource_suffix: 'localfixture', location: 'eastus', environment: 'dev' };
      await workspace.put('inspection', protectedStateScope(context), Buffer.from(JSON.stringify(variables)), f.variableId);
      return context;
    };
    return {
      workspace, adapters, enroll, native, control: (value: Record<string, unknown>) => writeFile(controlPath, JSON.stringify(value)),
      audit: async () => (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
      backend: () => http!
    };
  }

  describe('private complete artifact-role declarations and source custody', () => {
    it('accepts exact manifest-required roles and rejects aliases, omissions, wrong health and noncanonical URLs', async () => {
      const f = await sourceFixture(), input = await planningFixture(f);
      const valid = applicationPrivateInputs(input);
      expect(valid.artifact).toBeNull();
      expect(valid.artifactSet).toEqual(f.intent.artifactSet);
      const before = applicationPrivateIntentDigest(input, valid);
      const invalid: Array<(config: ApplicationPrivateConfiguration) => void> = [
        (config) => { delete config.artifactSet!.deployments.frontend; },
        (config) => { Reflect.deleteProperty(config.artifactSet!.deployments, 'backend'); },
        (config) => { Object.assign(config.artifactSet!.deployments, { worker: config.artifactSet!.deployments.backend }); },
        (config) => { config.artifactSet!.deployments.frontend = { ...config.artifactSet!.deployments.backend }; },
        (config) => { config.artifactSet!.deployments.frontend!.imageRef = config.artifactSet!.deployments.backend.imageRef;
          Object.assign(config.targets[1]!.expected, { 'template.0.container.0.image': config.artifactSet!.deployments.backend.imageRef }); },
        (config) => { config.targets = config.targets.slice(0, 1); },
        (config) => { config.artifactSet!.deployments.frontend!.address = 'module.application.azurerm_user_assigned_identity.frontend'; },
        (config) => { config.targets[1]!.runtime = { url: config.targets[1]!.runtime!.url, statusField: 'status', statusValue: 'ok' }; },
        (config) => { config.targets[0]!.runtime = { kind: 'frontend-html/1', url: config.targets[0]!.runtime!.url }; },
        (config) => { config.artifactSet!.sourceSha = sourceSha.slice(1); },
        (config) => { config.artifact = { evidenceId: 'legacy', headerDigest: stateDigest('legacy'), sourceSha,
          imageRef: config.artifactSet!.deployments.backend.imageRef, registryResourceId: applicationRegistryId }; },
        (config) => { config.scope = 'foundation-dependencies'; }
      ];
      for (const change of invalid) {
        const config = structuredClone(valid); change(config);
        input.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: config };
        expect(() => applicationPrivateInputs(input)).toThrow();
      }
      for (const url of [
        'http://site.fixture.azurecontainerapps.io/', 'https://site.fixture.azurecontainerapps.io',
        'https://site.fixture.azurecontainerapps.io:443/', 'https://user@site.fixture.azurecontainerapps.io/',
        'https://site.fixture.azurecontainerapps.io/a/../', 'https://site.fixture.azurecontainerapps.io//',
        'https://site.fixture.azurecontainerapps.io/%2f', 'https://site.fixture.azurecontainerapps.io/?auth=private',
        'https://site.fixture.azurecontainerapps.io/#fragment', 'https://foreign.invalid/'
      ]) {
        const config = structuredClone(valid); config.targets[1]!.runtime = { kind: 'frontend-html/1', url };
        input.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: config };
        expect(() => applicationPrivateInputs(input), url).toThrow();
      }
      input.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: valid };
      const changed = structuredClone(valid); changed.artifactSet!.reference.bodyDigest = stateDigest('another private body');
      expect(applicationPrivateIntentDigest(input, changed)).not.toBe(before);
      expect(applicationPrivateContext(input, changed).artifactDigest).not.toBe(applicationPrivateContext(input, valid).artifactDigest);
      expect(() => assertApplicationPrivateArtifactVariables({ backend_image: f.intent.artifactSet!.deployments.backend.imageRef }, f.intent)).toThrow();
      expect(() => assertApplicationPrivateArtifactVariables({
        backend_image: f.intent.artifactSet!.deployments.backend.imageRef, frontend_image: f.intent.artifactSet!.deployments.frontend!.imageRef
      }, f.intent)).not.toThrow();
    });

    describe('independent role-bound ARM and document/runtime health', () => {
      it('reads backend JSON and strict frontend HTML over actual loopback HTTP without executing or retaining the document', async () => {
        const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
        const planning = await planningFixture(f); await produceSet(f, planning);
        for (const target of f.intent.targets) providers.rows.set(target.resourceId, armApplication(target));
        const reader = new ApplicationPrivateResourceReader({
          intent: f.intent, transport: createAzureCliArmTransport(planning.runner, f.projectRoot, { now: () => now.getTime() }),
          authorize: async () => { await readApplicationPrivateArtifactRoles(planning, f.intent); }, now: () => now.getTime()
        });
        const [backend, frontend] = await Promise.all(f.intent.targets.map((target) => reader.observe(target, true)));
        expect(backend!.artifact).toMatchObject({ role: 'backend', sourceSha, imageRef: f.intent.artifactSet!.deployments.backend.imageRef });
        expect(backend!.runtime).toEqual({ url: f.intent.targets[0]!.runtime!.url, healthy: true, observedAt: now.toISOString() });
        expect(frontend!.artifact).toMatchObject({ role: 'frontend', sourceSha, imageRef: f.intent.artifactSet!.deployments.frontend!.imageRef });
        expect(frontend!.runtime).toEqual({ kind: 'frontend-html/1', url: f.intent.targets[1]!.runtime!.url,
          healthy: true, observedAt: now.toISOString(), status: 200, contentType: 'text/html', bodyDigest: stateDigest(html) });
        expect(JSON.stringify([backend, frontend])).not.toMatch(/PRIVATE_DOCUMENT_CONTENT_NEVER_PERSISTED|THIS_MUST_NEVER_EXECUTE/);
        const target = f.intent.targets[1]!;
        const badDocuments = [
          '', 'ok', '{"status":"ok"}',
          '<!doctype html><html><head></head><body></body></html>',
          '<html><head><title></title></head><body></body></html>',
          '<html><head><!-- <title>comment only</title> --></head><body></body></html>',
          '<html><head><script>"<title>script only</title>"</script></head><body></body></html>',
          '<html><head><title>Title</title></head><body><div></body></html>',
          '<html><head><title>Title</title></head><body></body><body></body></html>',
          '<html><head><title>Title</title></head><body></body></html><html></html>',
          '<html><head><title>Title</title></head><body><img src="unterminated></body></html>'
        ].map((value) => Buffer.from(value));
        badDocuments.push(Buffer.concat([Buffer.from(html), Buffer.from([0xff])]), Buffer.from(html.replace('</body>', `${'x'.repeat(65_537)}</body>`)));
        for (const bytes of badDocuments) {
          providers.frontend.bytes = bytes;
          await expect(reader.observe(target, true)).rejects.toThrow(/runtime-html/);
        }
        providers.frontend.bytes = Buffer.from(html);
        for (const type of ['application/json', 'text/plain', 'text/html; charset=iso-8859-1', 'text/html; charset=utf-8; charset=iso-8859-1']) {
          providers.frontend.type = type;
          await expect(reader.observe(target, true)).rejects.toThrow(/runtime-html-readback/);
        }
        providers.frontend.type = 'text/html'; providers.frontend.status = 302;
        providers.frontend.location = 'https://site.fixture.azurecontainerapps.io/other';
        const count = providers.requests.filter((entry) => entry.host === 'site.fixture.azurecontainerapps.io').length;
        await expect(reader.observe(target, true)).rejects.toThrow();
        expect(providers.requests.filter((entry) => entry.host === 'site.fixture.azurecontainerapps.io')).toHaveLength(count + 1);
        providers.frontend.status = 200; providers.frontend.location = null;
        providers.backend.type = 'text/html'; providers.backend.bytes = Buffer.from(html);
        await expect(reader.observe(f.intent.targets[0]!, true)).rejects.toThrow(/runtime-health-readback/);
        expect(providers.requests.filter((entry) => entry.host === 'management.azure.com').every((entry) => entry.method === 'GET')).toBe(true);
      }, 120_000);

      it('will not accept another role image, identity, revision or observed ingress before probing health', async () => {
        const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
        const planning = await planningFixture(f); await produceSet(f, planning);
        const target = f.intent.targets[1]!, original = armApplication(target);
        const reader = new ApplicationPrivateResourceReader({
          intent: f.intent, transport: createAzureCliArmTransport(planning.runner, f.projectRoot, { now: () => now.getTime() }),
          authorize: async () => { await readApplicationPrivateArtifactRoles(planning, f.intent); }, now: () => now.getTime()
        });
        const changes: Array<(value: ReturnType<typeof armApplication>) => void> = [
          (value) => { value.properties.template.containers[0]!.image = f.intent.artifactSet!.deployments.backend.imageRef; },
          (value) => { Object.assign(value.identity.userAssignedIdentities, { [`${identityId}-other`]: {} }); },
          (value) => { value.properties.latestReadyRevisionName = 'site--older'; },
          (value) => { value.properties.configuration.ingress.fqdn = 'api.fixture.azurecontainerapps.io'; },
          (value) => { value.properties.configuration.registries[0]!.server = 'crmirror.azurecr.io'; },
          (value) => { value.properties.configuration.ingress.traffic[0]!.weight = 50; }
        ];
        for (const change of changes) {
          const value = structuredClone(original); change(value); providers.rows.set(target.resourceId, value);
          await expect(reader.observe(target, true)).rejects.toThrow();
        }
        expect(providers.requests.filter((entry) => entry.host.endsWith('.azurecontainerapps.io'))).toEqual([]);
      }, 90_000);
    });

    it('requires no frontend only when the actual manifest has no frontend component', async () => {
      const f = await sourceFixture({ frontend: false }), input = await planningFixture(f);
      expect(applicationPrivateInputs(input).targets).toHaveLength(1);
      expect(() => assertApplicationPrivateArtifactSet(f.intent, f.manifest)).not.toThrow();
      const source = await inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent);
      expect(source.resources.filter((resource) => resource.artifactRole).map((resource) => resource.artifactRole)).toEqual(['backend']);
    });

    it('binds real generated image-variable ASTs through module calls, not container resource names', async () => {
      const f = await sourceFixture({ generated: true });
      const names = { backend: 'customer_page', frontend: 'service_api' };
      for (const artifact of f.generated.filter((entry) => entry.pathParts.at(-1)?.endsWith('.tf') &&
        entry.pathParts.slice(0, 3).join('/') === 'infrastructure/opentofu/azure')) {
        let text = artifact.content;
        for (const role of ['backend', 'frontend'] as const) text = text
          .replaceAll(`resource "azurerm_container_app" "${role}"`, `resource "azurerm_container_app" "${names[role]}"`)
          .replaceAll(`azurerm_container_app.${role}`, `azurerm_container_app.${names[role]}`);
        await writeFile(path.join(f.projectRoot, ...artifact.pathParts), text);
      }
      for (const [index, role] of (['backend', 'frontend'] as const).entries()) {
        f.intent.targets[index]!.address = `module.application.azurerm_container_app.${names[role]}`;
        f.intent.artifactSet!.deployments[role]!.address = f.intent.targets[index]!.address;
      }
      const observed = await inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent);
      expect(observed.resources.filter((resource) => resource.artifactRole).map(({ address, artifactRole }) => [address, artifactRole]))
        .toEqual([['module.application.azurerm_container_app.customer_page', 'backend'],
          ['module.application.azurerm_container_app.service_api', 'frontend']]);
      expect(observed.artifactSet).toEqual(f.intent.artifactSet);
    });

    it('refuses unregistered image dataflow, child or root role swaps, and lifecycle additions', async () => {
      const f = await sourceFixture(), filename = path.join(f.projectRoot, ...moduleParts, 'main.tf');
      const original = await readFile(filename, 'utf8');
      for (const expression of [
        'var.backend_image', 'local.frontend_image', 'upper(var.frontend_image)',
        'true ? var.frontend_image : var.frontend_image', JSON.stringify(f.intent.artifactSet!.deployments.frontend!.imageRef)
      ]) {
        await writeFile(filename, original.replace('image = var.frontend_image', `image = ${expression}`));
        await expect(inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent)).rejects.toThrow(/artifact-set-image-expression/);
      }
      await writeFile(filename, original.replace('revision_mode = "Single"', 'revision_mode = "Single"\n lifecycle { ignore_changes = all }'));
      await expect(inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent)).rejects.toThrow(/dynamic-or-lifecycle-effect/);
      await writeFile(filename, original);
      const main = path.join(f.projectRoot, ...rootParts, 'main.tf'), root = await readFile(main, 'utf8');
      await writeFile(main, root.replace(/frontend_image(\s*)=\s*var\.frontend_image/u, 'frontend_image$1= var.backend_image'));
      await expect(inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent)).rejects.toThrow(/artifact-set-module-image-expression/);
      await writeFile(main, root.replace(/^\s*frontend_image\s*=\s*var\.frontend_image\s*$/mu, ''));
      await expect(inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent)).rejects.toThrow(/artifact-set-module-image-expression/);
      await writeFile(main, root);
      await writeFile(path.join(f.projectRoot, ...moduleParts, 'unregistered.tf'), 'locals { extra = "unregistered source" }\n');
      await expect(inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent)).rejects.toThrow(/artifact-set-unregistered-source/);
    });

    it('admits the whole saved plan and accounts for exact partial candidates without swapping a role', async () => {
      const f = await sourceFixture(), source = await inspectApplicationPrivateSource(f.projectRoot, f.manifest, f.intent);
      const native = savedPlanFixture(f);
      const admit = () => admitApplicationPrivatePlan(Buffer.from(JSON.stringify(native.value)), native.original, native.metadata, source, f.intent);
      const admitted = admit();
      expect(admitted.changes).toHaveLength(2);
      const partial = inspectApplicationPrivateCandidate(native.candidate(f.intent.targets.slice(0, 1)), native.original, native.metadata, admitted);
      expect(partial).toMatchObject({ realized: [f.intent.targets[0]!.address], complete: false });
      expect(inspectApplicationPrivateCandidate(native.candidate(f.intent.targets), native.original, native.metadata, admitted).complete).toBe(true);
      const wrong = structuredClone(f.intent.targets);
      Object.assign(wrong[1]!.expected, { 'template.0.container.0.image': f.intent.artifactSet!.deployments.backend.imageRef });
      expect(() => inspectApplicationPrivateCandidate(native.candidate(wrong), native.original, native.metadata, admitted)).toThrow(/candidate-partially-changed-resource/);
      const expected = structuredClone(native.value);
      for (const actions of [['delete'], ['delete', 'create'], ['update', 'create']]) {
        native.value.resource_changes[0]!.change.actions = actions;
        expect(admit).toThrow(/deletion-replacement-or-import/);
      }
      native.value.resource_changes = structuredClone(expected.resource_changes);
      Object.assign(native.value.resource_changes[0]!.change.after_unknown, { template: [{ container: [{ image: true }] }] });
      expect(admit).toThrow(/unknown-effect-requires-additional-plan/);
      native.value.resource_changes = structuredClone(expected.resource_changes);
      native.value.resource_changes[1]!.change.after.registry[0]!.server = 'crmirror.azurecr.io';
      expect(admit).toThrow(/artifact-set-plan-registry/);
      native.value.resource_changes = expected.resource_changes.slice(0, 1);
      expect(admit).toThrow(/plan-inventory-incomplete/);
      native.value.resource_changes = structuredClone(expected.resource_changes);
      const changedSource = structuredClone(source); changedSource.artifactSet!.sourceSha = 'b'.repeat(40);
      expect(() => admitApplicationPrivatePlan(Buffer.from(JSON.stringify(native.value)), native.original, native.metadata, changedSource, f.intent))
        .toThrow(/artifact-set-plan-source/);
    });

    it('requires actual stored whole-set producer custody and declares both mirror source reads without any provider write', async () => {
      const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
      const planning = await planningFixture(f);
      const missing = await planApplicationPrivateExecution(planning);
      expect(missing.operations).toEqual([]); expect(missing.blockers).toHaveLength(1);
      expect(providers.requests).toHaveLength(0);
      const producer = await produceSet(f, planning), before = providers.requests.length;
      const roles = await readApplicationPrivateArtifactRoles(planning, f.intent);
      expect(roles.map((entry) => [entry.role, entry.imageRef, entry.reference.set])).toEqual([
        ['backend', f.intent.artifactSet!.deployments.backend.imageRef, producer.reference],
        ['frontend', f.intent.artifactSet!.deployments.frontend!.imageRef, producer.reference]
      ]);
      expect(providers.requests).toHaveLength(before);
      expect((await planApplicationPrivateExecution(planning)).blockers).toBeUndefined();
      const invalid = structuredClone(f.intent); invalid.artifactSet!.sourceSha = 'a'.repeat(40);
      await expect(readApplicationPrivateArtifactRoles(planning, invalid)).rejects.toThrow(/artifact-set-source/);
      const changed = structuredClone(f.intent); changed.artifactSet!.reference.bodyDigest = stateDigest('not original evidence');
      await expect(readApplicationPrivateArtifactRoles(planning, changed)).rejects.toThrow();
      const mirror = structuredClone(f.intent); mirror.scope = 'staging';
      for (const [index, role] of (['backend', 'frontend'] as const).entries()) {
        const deployment = mirror.artifactSet!.deployments[role]!;
        deployment.sourceRegistryResourceId = applicationRegistryId; deployment.registryResourceId = mirrorId;
        deployment.imageRef = deployment.imageRef.replace(host, 'crmirror.azurecr.io');
        Object.assign(mirror.targets[index]!.expected, { 'template.0.container.0.image': deployment.imageRef });
      }
      expect((await readApplicationPrivateArtifactRoles(planning, mirror)).map((entry) => entry.producerRegistryResourceId))
        .toEqual([applicationRegistryId, applicationRegistryId]);
      expect(applicationPrivateReadResourceIds(mirror)).toEqual(expect.arrayContaining([applicationRegistryId, mirrorId]));
      mirror.artifactSet!.deployments.frontend!.sourceRegistryResourceId = mirrorId;
      await expect(readApplicationPrivateArtifactRoles(planning, mirror)).rejects.toThrow(/artifact-mirror-scope/);
      const file = path.join(f.projectRoot, ...producer.reference.planPathParts), bytes = await readFile(file);
      await writeFile(file, JSON.stringify({ ...producer.input.plan, operations: producer.input.plan.operations.slice(0, 2) }));
      await expect(readApplicationPrivateArtifactRoles(planning, f.intent)).rejects.toThrow();
      await writeFile(file, bytes);
      expect(providers.requests).toHaveLength(before);
    }, 90_000);
  });

class LocalRoleProviders {
  readonly requests: Array<{ host: string; method: string; pathname: string }> = [];
  readonly originalFetch = globalThis.fetch;
  readonly server = createServer((request, response) => { void this.route(request, response).catch((error) => {
    this.failures.push(error); response.destroy();
  }); });
  readonly failures: unknown[] = [];
  readonly rows = new Map<string, Record<string, unknown>>([
    [applicationRegistryId, { id: applicationRegistryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
      tags: { 'liftoff-repository-id': '42' }, properties: { loginServer: host, adminUserEnabled: false, provisioningState: 'Succeeded' } }],
    [mirrorId, { id: mirrorId, name: 'crmirror', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
      tags: { 'liftoff-repository-id': '42' }, properties: { loginServer: 'crmirror.azurecr.io', adminUserEnabled: false, provisioningState: 'Succeeded' } }],
    [identityId, { id: identityId, name: 'workload', type: 'Microsoft.ManagedIdentity/userAssignedIdentities', location: 'eastus',
      tags: { 'liftoff-repository-id': '42' }, properties: { principalId: randomUUID(), clientId: randomUUID(), tenantId: applicationTenant } }],
    [environmentId, { id: environmentId, name: 'apps', type: 'Microsoft.App/managedEnvironments', location: 'eastus',
      properties: { provisioningState: 'Succeeded' } }]
  ]);
  frontend = { status: 200, type: 'text/html; charset=utf-8', bytes: Buffer.from(html), location: null as string | null };
  backend = { status: 200, type: 'application/json', bytes: Buffer.from('{"status":"ok"}') };
  registryFault: string | null = null;
  rowsPath: string | undefined;
  blobRequest?: (request: IncomingMessage, bytes: Buffer) => Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }>;
  address = '';
  constructor(readonly f: SourceFixture) {}

  token(claims: Record<string, unknown>) {
    return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
      exp: now.getTime() / 1000 + 3600, ...claims
    })).toString('base64url')}.${Buffer.from('isolated fixture; not an actual credential').toString('base64url')}`;
  }

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an actual loopback listener.');
    this.address = `http://127.0.0.1:${address.port}`;
    expect((await this.originalFetch(`${this.address}/fixture-health`)).status).toBe(200);
    cleanups.push(async () => {
      const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
      this.server.closeAllConnections(); await closed;
      expect(this.failures).toEqual([]);
    });
    vi.stubGlobal('fetch', async (resource: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.protocol !== 'https:' || ![
        'management.azure.com', host, 'crmirror.azurecr.io', 'api.fixture.azurecontainerapps.io',
        'site.fixture.azurecontainerapps.io', 'login.microsoftonline.com'
      ].includes(url.host)) throw new Error('Refusing every real or undeclared network target.');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers); headers.set('x-fixture-host', url.host);
      return this.originalFetch(`${this.address}${url.pathname}${url.search}`, { ...init, headers });
    });
    const bin = path.join(this.f.root, 'bin');
    await mkdir(bin, { mode: 0o700 });
    await writeFile(path.join(bin, 'az'), `#!${process.execPath}
const args = process.argv.slice(2);
const response = await fetch(${JSON.stringify(`${this.address}/fixture-token`)}, {
 method:'POST', body:JSON.stringify(args), redirect:'error'
});
if(response.status !== 200) process.exit(91);
process.stdout.write(await response.text());
`, { mode: 0o700 });
    await writeFile(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith('/repos/') || arg === '/user');
const method = args[args.indexOf('--method')+1];
if(args[0] !== 'api' || args[args.indexOf('--hostname')+1] !== 'github.com' ||
 !endpoint || !['GET','POST'].includes(method)) process.exit(92);
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const response = await fetch(${JSON.stringify(this.address)}+endpoint, {
 method, redirect:'error', headers:{'x-fixture-host':'github'},
 ...(chunks.length ? {body:Buffer.concat(chunks)} : {})
});
process.stdout.write('HTTP/1.1 '+response.status+'\\r\\n'+[...response.headers]
 .map(([key,value])=>key+': '+value+'\\r\\n').join('')+'\\r\\n');
process.stdout.write(Buffer.from(await response.arrayBuffer()));
`, { mode: 0o700 });
    await writeFile(path.join(bin, 'git'), `#!${process.execPath}\nprocess.exit(128);\n`, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  }

  async route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(`${this.address}${request.url}`), method = request.method ?? 'GET';
    if (url.pathname === '/fixture-health') { response.writeHead(200).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const json = (value: unknown, status = 200) => response.writeHead(status, {
      'content-type': 'application/json', 'x-ms-request-id': randomUUID(), 'x-github-request-id': randomUUID()
    }).end(JSON.stringify(value));
    if (url.pathname === '/fixture-blob') {
      expect(this.blobRequest).toBeDefined();
      const result = await this.blobRequest!(request, bytes);
      response.writeHead(result.status, result.headers).end(result.body); return;
    }
    if (url.pathname === '/fixture-token') {
      expect(method).toBe('POST');
      expect(JSON.parse(bytes.toString())).toEqual(['account', 'get-access-token', '--subscription', applicationSubscription,
        '--tenant', applicationTenant, '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors']);
      json({ tokenType: 'Bearer', tenant: applicationTenant, subscription: applicationSubscription,
        accessToken: this.token({ oid: fixtureBinding.principalId, tid: applicationTenant, aud: 'https://management.azure.com/' }) }); return;
    }
    const service = String(request.headers['x-fixture-host']);
    this.requests.push({ host: service, method, pathname: url.pathname });
    if (service === 'api.fixture.azurecontainerapps.io' || service === 'site.fixture.azurecontainerapps.io') {
      expect(method).toBe('GET');
      expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined();
      const selected = service.startsWith('api.') ? this.backend : this.frontend;
      expect(request.headers.accept).toBe(service.startsWith('api.') ? 'application/json' : 'text/html');
      response.writeHead(selected.status, { 'content-type': selected.type,
        ...(service.startsWith('site.') && this.frontend.location ? { location: this.frontend.location } : {}) }).end(selected.bytes);
      return;
    }
    if (service === 'login.microsoftonline.com') {
      expect(method).toBe('POST');
      expect(url.pathname).toBe(`/${applicationTenant}/oauth2/v2.0/token`);
      const form = new URLSearchParams(bytes.toString());
      expect(form.get('client_secret')).toBe('PRIVATE_FIXTURE_WRITER_VALUE');
      expect(form.get('client_id')).toBe(this.f.intent.writer.clientId);
      json({ token_type: 'Bearer', expires_in: 3600,
        access_token: this.token({ tid: applicationTenant, oid: fixtureBinding.principalId,
          appid: this.f.intent.writer.clientId, aud: 'https://management.azure.com/' }) }); return;
    }
    if (service === 'management.azure.com') {
      expect(method).toBe('GET');
      if (url.pathname.endsWith('/providers/Microsoft.Authorization/permissions')) {
        json({ value: [{ actions: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write'],
          notActions: [], dataActions: [], notDataActions: [] }] }); return;
      }
      const namespace = new RegExp(`^/subscriptions/${applicationSubscription}/providers/([^/]+)$`, 'u').exec(url.pathname);
      if (namespace) { json({ id: url.pathname, namespace: namespace[1], registrationState: 'Registered' }); return; }
      const privateRows = this.rowsPath ? JSON.parse(await readFile(this.rowsPath, 'utf8')) : {};
      const body = privateRows[url.pathname] ?? this.rows.get(url.pathname);
      if ([applicationRegistryId, mirrorId].includes(url.pathname)) expect(url.searchParams.get('api-version')).toBe('2023-07-01');
      json(body ?? { error: { code: 'ResourceNotFound' } }, body ? 200 : 404); return;
    }
    if (service === host || service === 'crmirror.azurecr.io') {
      const form = new URLSearchParams(bytes.toString());
      if (url.pathname === '/oauth2/exchange') {
        expect(method).toBe('POST'); expect(form.get('service')).toBe(service); expect(form.get('tenant')).toBe(applicationTenant);
        json({ refresh_token: this.token({ aud: service, tenant: applicationTenant, grant_type: 'refresh_token' }) }); return;
      }
      if (url.pathname === '/oauth2/token') {
        expect(method).toBe('POST');
        const selected = Object.values(this.f.roles).find((entry) => form.get('scope') === `repository:team/${entry.role}:pull`);
        expect(selected).toBeDefined();
        json({ access_token: this.token({ aud: service, grant_type: 'access_token',
          access: [{ type: 'repository', name: `team/${selected!.role}`, actions: ['pull'] }] }) }); return;
      }
      const selected = Object.values(this.f.roles).find((entry) => url.pathname === `/v2/team/${entry.role}/manifests/${entry.report.image.digest}`);
      expect(selected).toBeDefined(); expect(method).toBe('GET');
      response.writeHead(200, { 'docker-content-digest': selected!.report.image.digest, 'x-ms-request-id': randomUUID() })
        .end(this.registryFault === `${service}:${selected!.role}` ? Buffer.from('DIFFERENT_PRIVATE_REGISTRY_BYTES') : selected!.registryBytes); return;
    }
    expect(service).toBe('github');
    const root = `/repos/${repository}`;
    if (method === 'POST') {
      const selected = Object.values(this.f.roles).find((entry) => url.pathname === `${root}/actions/workflows/${entry.workflow.workflowId}/dispatches`);
      expect(selected).toBeDefined(); expect(selected!.run).toBeNull();
      const body = JSON.parse(bytes.toString());
      selected!.run = { id: selected!.runId, run_attempt: 1, workflow_id: selected!.workflow.workflowId,
        path: selected!.workflow.workflowPath, head_sha: sourceSha, head_branch: 'develop', event: 'workflow_dispatch',
        actor: { id: 7 }, triggering_actor: { id: 7 }, repository: { id: 42, full_name: repository }, created_at: now.toISOString(),
        display_title: `liftoff-${body.inputs.liftoff_operation_id}`, check_suite_id: selected!.runId * 1000 };
      json({ workflow_run_id: selected!.runId, run_url: `https://api.github.com${root}/actions/runs/${selected!.runId}`,
        html_url: `https://github.com/${repository}/actions/runs/${selected!.runId}` }); return;
    }
    expect(method).toBe('GET');
    if (url.pathname === '/user') { json({ id: 7, login: 'local-fixture' }); return; }
    if (url.pathname === root) { json({ id: 42, full_name: repository, default_branch: 'develop' }); return; }
    if (url.pathname === `${root}/git/ref/heads/develop`) { json({ ref: 'refs/heads/develop', object: { type: 'commit', sha: sourceSha } }); return; }
    if (url.pathname === `${root}/git/commits/${sourceSha}`) { json({ sha: sourceSha, tree: { sha: treeSha } }); return; }
    for (const selected of Object.values(this.f.roles)) {
      const workflow = selected.workflow, run = { ...selected.run, status: 'completed', conclusion: 'success' };
      if (url.pathname === `${root}/contents/${workflow.workflowPath}` && url.searchParams.get('ref') === sourceSha) {
        const content = Buffer.from(selected.source), blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
        json({ type: 'file', path: workflow.workflowPath, sha: blob, size: content.length, encoding: 'base64', content: content.toString('base64') }); return;
      }
      if (url.pathname === `${root}/actions/workflows/${workflow.workflowId}`) { json({ id: workflow.workflowId, path: workflow.workflowPath, state: 'active' }); return; }
      if (url.pathname === `${root}/actions/workflows/${workflow.workflowId}/runs`) {
        json({ total_count: selected.run ? 1 : 0, workflow_runs: selected.run ? [run] : [] }); return;
      }
      if (!selected.run) continue;
      const runPath = `${root}/actions/runs/${selected.runId}`;
      if ([runPath, `${runPath}/attempts/1`].includes(url.pathname)) { json(run); return; }
      if (url.pathname === `${runPath}/attempts/1/jobs`) {
        json({ total_count: 1, jobs: [{ id: selected.runId * 10, run_id: selected.runId, name: applicationBuildWorkflowJob,
          head_sha: sourceSha, status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com${root}/check-runs/${selected.runId * 100}`,
          steps: [{ number: 1, name: 'Build and verify exact source image', status: 'completed', conclusion: 'success' },
            { number: 2, name: 'Retain exact application build report', status: 'completed', conclusion: 'success' }] }] }); return;
      }
      if (url.pathname === `${root}/check-runs/${selected.runId * 100}`) {
        json({ id: selected.runId * 100, name: applicationBuildWorkflowJob, head_sha: sourceSha, status: 'completed', conclusion: 'success',
          app: { id: 15368, slug: 'github-actions' }, check_suite: { id: selected.runId * 1000 } }); return;
      }
      const artifact = { id: selected.artifactId, name: selected.build.artifactName, expired: false,
        digest: sha(selected.archive), size_in_bytes: selected.archive.length,
        workflow_run: { id: selected.runId, repository_id: 42, head_repository_id: 42, head_sha: sourceSha, head_branch: 'develop' } };
      if (url.pathname === `${runPath}/artifacts`) { json({ total_count: 1, artifacts: [artifact] }); return; }
      if (url.pathname === `${root}/actions/artifacts/${selected.artifactId}`) { json(artifact); return; }
      if (url.pathname === `${root}/actions/artifacts/${selected.artifactId}/zip`) {
        response.writeHead(200, { 'content-type': 'application/zip' }).end(selected.archive); return;
      }
    }
    json({ message: 'Not present in isolated fixture' }, 404);
  }
}

describe('actual private native process and whole artifact-set deployment protocol', () => {
  it.each([false, true])('runs one approved whole saved plan and preserves role custody through partial=%s', async (partial) => {
    const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
    const native = await nativeFixture(f, providers), planning = await planningFixture(f);
    const producer = await produceSet(f, planning), context = await native.enroll(planning);
    const run = async (configuration: ApplicationPrivateConfiguration) => {
      planning.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: configuration };
      const execution = await approve(planning, await planApplicationPrivateExecution(planning), configuration.mode === 'recover');
      const result = await withProjectMutationLock(f.projectRoot, (lease) =>
        executeApplicationPrivatePlan({ ...execution, lease }, native.adapters));
      return { execution, result };
    };
    const prepared = await run({ ...f.intent, mode: 'prepare' });
    expect(prepared.result, JSON.stringify(prepared.result)).toMatchObject({ status: 'prepared', effects: [
      { address: f.intent.targets[0]!.address, status: 'not-attempted' }, { address: f.intent.targets[1]!.address, status: 'not-attempted' }
    ] });
    const review = prepared.result.reviewed!;
    expect(review.artifactSet).toEqual(f.intent.artifactSet);
    expect(review.artifact).toBeNull();
    const bytes = await native.workspace.get(review.planRef, 'plan', protectedStateScope(context));
    let saved: ApplicationPrivateSavedPlan;
    try { saved = JSON.parse(Buffer.from(bytes).toString()); } finally { bytes.fill(0); }
    expect(saved.intent.artifactSet).toEqual(f.intent.artifactSet);
    expect(saved.source.artifactSet).toEqual(f.intent.artifactSet);
    expect(saved.review.artifactSet!.reference.savedPlanDigest).toBe(canonicalSha256(producer.input.plan));
    const configuration: ApplicationPrivateConfiguration = { ...f.intent, mode: 'apply', reviewed: review };
    const changedReview = structuredClone(configuration);
    changedReview.reviewed.artifactSet!.sourceSha = 'a'.repeat(40);
    expect(() => assertApplicationPrivateReview(planning, changedReview, saved.source)).toThrow(/review-binding/);
    for (const target of f.intent.targets) {
      const operation = applicationPrivateOperation(planning, configuration, saved.source, target);
      expect(operation.inputs.artifactSet).toEqual(f.intent.artifactSet);
      expect(operation.inputs.resourceEffect).toMatchObject({ artifact: applicationPrivateArtifactForTarget(f.intent, target) });
    }
    await native.control({ partial });
    const applied = await run(configuration);
    const effects = (await native.audit()).filter((entry) => entry.kind === 'durable-intent');
    expect(effects.map((entry) => entry.value.artifactRole)).toEqual(['backend', 'frontend']);
    expect(effects.every((entry) => canonicalSha256(entry.value.artifactSet) === canonicalSha256(f.intent.artifactSet))).toBe(true);
    const invocations = (await native.audit()).filter((entry) => entry.kind === 'applied-whole-saved-plan');
    expect(invocations).toEqual([{ kind: 'applied-whole-saved-plan', digest: saved.savedPlan.digest, addresses: f.intent.targets.map((target) => target.address) }]);
    let settled: ApplicationPrivateResult = applied.result;
    if (partial) {
      expect(applied.result, JSON.stringify(applied.result)).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
      expect(native.backend().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toEqual([]);
      const recovery: ApplicationPrivateConfiguration = {
        ...f.intent, mode: 'recover', reviewed: review, recovery: 'publish-retained',
        checkpoint: { transactionId: review.transactionId, journalRef: review.journalRef },
        candidateRef: applied.result.retainedCandidateRef,
        recoveryWindow: { notBefore: now.toISOString(), expiresAt: f.intent.expiresAt, releaseUntil: f.intent.releaseUntil }
      };
      const changed = structuredClone(recovery);
      changed.artifactSet!.reference.bodyDigest = stateDigest('different role set body');
      planning.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: changed };
      expect((await planApplicationPrivateExecution(planning)).operations).toEqual([]);
      settled = (await run(recovery)).result;
      expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'partial-published', state: 'published-verified' });
      expect(settled.observations.find((entry) => entry.address === f.intent.targets[1]!.address)).toMatchObject({
        exists: false, verified: false, artifact: { role: 'frontend', sourceSha }
      });
    } else {
      expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'executed', state: 'published-verified',
        qualification: 'unqualified-source-component' });
      expect(settled.observations.map((entry) => entry.artifact?.role)).toEqual(['backend', 'frontend']);
      expect(settled.observations[1]!.runtime).toMatchObject({ kind: 'frontend-html/1', status: 200, bodyDigest: stateDigest(html) });
    }
    expect(native.backend().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    expect((await native.audit()).filter((entry) => entry.kind === 'applied-whole-saved-plan')).toHaveLength(1);
    expect((await native.audit()).filter((entry) => entry.kind === 'refresh')).toHaveLength(1);
    for (const role of ['backend', 'frontend'] as const) {
      expect(providers.requests.filter((entry) => entry.host === host && entry.method === 'GET' &&
        entry.pathname === `/v2/team/${role}/manifests/${f.roles[role].report.image.digest}`).length).toBeGreaterThanOrEqual(4);
    }
    expect(providers.requests.filter((entry) => entry.host === 'github' && entry.method === 'POST')).toHaveLength(2);
    expect(providers.requests.filter((entry) => entry.host === 'management.azure.com').every((entry) => entry.method === 'GET')).toBe(true);
    expect(JSON.stringify(settled)).not.toMatch(/PRIVATE_VARIABLE_VALUE|PRIVATE_ORIGINAL_OUTPUT|PRIVATE_FIXTURE_WRITER_VALUE|PRIVATE_DOCUMENT_CONTENT_NEVER_PERSISTED|PRIVATE_NATIVE_OUTPUT_NEVER_PUBLIC/);
    const journalBytes = await native.workspace.get(review.journalRef, 'journal', protectedStateScope(context));
    try {
      const journal: ApplicationPrivateJournal = JSON.parse(Buffer.from(journalBytes).toString());
      expect(journal.nativeStarted && journal.processSettled).toBe(true);
      expect(journal.final).toBe(partial ? 'partial-published' : 'completed');
      expect(journal.originalGovernancePlan.planDigest).toBe(prepared.execution.plan.planDigest);
      expect(journal.applyGovernancePlan!.planDigest).toBe(applied.execution.plan.planDigest);
    } finally { journalBytes.fill(0); }
    const replay = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeApplicationPrivatePlan({ ...applied.execution, lease }, native.adapters));
    expect(replay.status).toBe('blocked');
    expect((await native.audit()).filter((entry) => entry.kind === 'applied-whole-saved-plan')).toHaveLength(1);
  }, 180_000);

  it('requires fresh actual frontend registry bytes again before the native effect, not just the stored role receipt', async () => {
    const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
    const native = await nativeFixture(f, providers), planning = await planningFixture(f);
    await produceSet(f, planning); await native.enroll(planning);
    const preparedInput = await approve(planning, await planApplicationPrivateExecution(planning));
    const prepared = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeApplicationPrivatePlan({ ...preparedInput, lease }, native.adapters));
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 'prepared' });
    planning.inspection.activationInputs!.phases[privatePhase.id] = {
      privateExecution: { ...f.intent, mode: 'apply', reviewed: prepared.reviewed }
    };
    const input = await approve(planning, await planApplicationPrivateExecution(planning));
    providers.registryFault = `${host}:frontend`;
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeApplicationPrivatePlan({ ...input, lease }, native.adapters));
    expect(result.status).toBe('blocked');
    expect((await native.audit()).filter((entry) => entry.kind === 'apply')).toEqual([]);
    expect(native.backend().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toEqual([]);
    expect(providers.requests.filter((entry) => entry.host === host && entry.method === 'GET').at(-1)!.pathname)
      .toBe(`/v2/team/frontend/manifests/${f.roles.frontend.report.image.digest}`);
  }, 180_000);

  it('retains a zero-exit native candidate until actual frontend document health passes during read-only recovery', async () => {
    const f = await sourceFixture(), providers = new LocalRoleProviders(f); await providers.start();
    const native = await nativeFixture(f, providers), planning = await planningFixture(f);
    await produceSet(f, planning); await native.enroll(planning);
    const run = async (configuration: ApplicationPrivateConfiguration) => {
      planning.inspection.activationInputs!.phases[privatePhase.id] = { privateExecution: configuration };
      const input = await approve(planning, await planApplicationPrivateExecution(planning), configuration.mode === 'recover');
      return withProjectMutationLock(f.projectRoot, (lease) => executeApplicationPrivatePlan({ ...input, lease }, native.adapters));
    };
    const prepared = await run({ ...f.intent, mode: 'prepare' });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 'prepared' });
    providers.frontend.type = 'application/json'; providers.frontend.bytes = Buffer.from('{"status":"ok"}');
    const failed = await run({ ...f.intent, mode: 'apply', reviewed: prepared.reviewed! });
    expect(failed, JSON.stringify(failed)).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
    expect(failed.blocker).toMatch(/runtime-html-readback/);
    expect(failed.observations.find((entry) => entry.address === f.intent.targets[1]!.address)).toMatchObject({ verified: false, runtime: null });
    expect(native.backend().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toEqual([]);
    expect((await native.audit()).filter((entry) => entry.kind === 'applied-whole-saved-plan')).toHaveLength(1);
    providers.frontend.type = 'text/html; charset=utf-8'; providers.frontend.bytes = Buffer.from(html);
    const recovered = await run({
      ...f.intent, mode: 'recover', recovery: 'publish-retained', reviewed: prepared.reviewed!,
      checkpoint: { transactionId: prepared.transactionId!, journalRef: prepared.journalRef! },
      candidateRef: failed.retainedCandidateRef,
      recoveryWindow: { notBefore: now.toISOString(), expiresAt: f.intent.expiresAt, releaseUntil: f.intent.releaseUntil }
    });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ status: 'executed', state: 'published-verified' });
    expect(recovered.observations[1]!.runtime).toMatchObject({ kind: 'frontend-html/1', bodyDigest: stateDigest(html) });
    expect((await native.audit()).filter((entry) => entry.kind === 'applied-whole-saved-plan')).toHaveLength(1);
    expect((await native.audit()).filter((entry) => entry.kind === 'refresh')).toHaveLength(1);
  }, 180_000);
});
