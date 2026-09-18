import path from 'node:path';
import { appendFile, chmod, lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { nativeStateHostId } from '../src/adapters/state/native-system.js';
import { stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { evidenceHeaderFor } from '../src/governance-activation/transition-records.js';
import type { EvidenceHeader, LiveReadbackProof, PhaseOutputBindings } from '../src/domain/governance/activation/types.js';
import type { StateExecutionContext } from '../src/domain/repair/stateful.js';
import type { AzureArmTransport } from '../src/adapters/azure/activation-rest.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import {
  executeApplicationPrivateExecution, executeApplicationPrivatePlan, planApplicationPrivateExecution
} from '../src/application/azure-activation/application-private-execution.js';
import { applicationPrivateContext, applicationPrivateIntent } from '../src/application/azure-activation/application-private-inputs.js';
import type {
  ApplicationPrivateConfiguration, ApplicationPrivateIntent, ApplicationPrivateJournal, ApplicationPrivateResult,
  ApplicationPrivateReview, ApplicationPrivateSavedPlan
} from '../src/application/azure-activation/application-private-contracts.js';
import type { ApplicationPrivateAdapters } from '../src/adapters/azure/application-private-runtime.js';
import {
  custody, encryptedFixtureWorkspace, fixtureBinding, fixtureTime, privateActivationFixture, privateTarget
} from './helpers/private-activation-fixture.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';
import { EnvironmentWorkflowProtocol } from './helpers/environment-qualification-fixture.js';
import { environmentRunnerAssignmentFixture } from './helpers/environment-runner-assignment-fixture.js';
import {
  environmentRuntimeJob, renderEnvironmentRuntimeWorkflow, type EnvironmentRuntimeRecipe
} from '../src/application/azure-activation/environment-runtime-workflow.js';
import { planProductionDevProof, executeProductionDevProof } from '../src/application/azure-activation/producer-dev-proof.js';
import { planProductionStaging, executeProductionStaging } from '../src/application/azure-activation/producer-staging-qualification.js';
import type { DisposableTargetConfig } from '../src/application/azure-activation/qualification-authority.js';
import type { WorkflowRunBinding } from '../src/adapters/github/workflow-dispatch.js';
import { currentGovernanceManifest } from './governance-activation-fixtures.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { stagingProducerRecipe, StagingProducerProtocol } from './helpers/staging-producer-protocol.js';
import {
  renderStagingSecurityWorkflow
} from '../src/application/azure-activation/staging-security-workflow.js';
import { buildCanonicalGitFlowRulesets } from '../src/adapters/github/production-rulesets.js';
import { planRepositoryWorkflowSource, executeRepositoryWorkflowSource } from '../src/application/repository-governance/producer-workflow-source.js';
import { storePhaseReview } from '../src/governance-activation/phase-reviews.js';
import type { GitHubActivationTransport } from '../src/adapters/github/activation-rest.js';
import { applicationArtifactFixture, applicationImageBytes } from './helpers/application-artifact-fixture.js';
import { planApplicationArtifactReady } from '../src/application/azure-activation/producer-artifact.js';
import { createApplicationRehearsalComponent } from '../src/application/azure-activation/application-rehearsal-execution.js';
import { readVerifiedStagingQualification } from '../src/application/azure-activation/staging-qualification-receipt.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  rehearsalPrivateArtifact, type ApplicationRehearsalArtifact, type ApplicationRehearsalPrivateConfiguration,
  type ApplicationRehearsalInputs
} from '../src/application/azure-activation/application-rehearsal-inputs.js';
import { fullProductionPredecessorVerifier } from '../src/application/azure-activation/producer-full-checks.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) {
    await stopOwnedStateProcessesIn(fixture.root);
    await fixture.cleanup();
  }
});
const rootParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
const moduleParts = ['infrastructure', 'opentofu', 'azure', 'modules', 'core'];
const group = `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-app`;
const registryId = `${group}/providers/Microsoft.ContainerRegistry/registries/crliftoff`;
const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-workload`;
const environmentId = `${group}/providers/Microsoft.App/managedEnvironments/application-environment`;
const applicationId = `${group}/providers/Microsoft.App/containerApps/application`;
const healthUrl = 'https://application.fixture.azurecontainerapps.io/health';
const originalSecret = 'SYNTHETIC_ORIGINAL_PRIVATE_STATE_NEVER_PUBLIC';
const variableSecret = 'SYNTHETIC_PRIVATE_VARIABLE_NEVER_PUBLIC';
const credentialSecret = 'SYNTHETIC_KEYCHAIN_CREDENTIAL_NEVER_PUBLIC';

function stagingSourceFiles(security: ReturnType<typeof stagingProducerRecipe>) {
  return [
    { path: security.workflowPath, content: renderStagingSecurityWorkflow(security) },
    { path: '.github/rulesets/liftoff-gitflow-main.json',
      content: JSON.stringify(buildCanonicalGitFlowRulesets({ requiredChecks: ['verify'], actionsAppId: 15368 })[0]) }
  ];
}

async function fixture(
  scope: 'prerequisites-core' | 'prerequisites-rbac' | 'foundation' = 'prerequisites-core',
  action: 'create' | 'update' = 'create',
  existing?: Awaited<ReturnType<typeof privateActivationFixture>>,
  includeStagingSource = false,
  existingEnvironment: 'staging' | 'prod' = 'staging'
) {
  const base = existing ?? await privateActivationFixture(scope === 'foundation' ? 'application-foundation' : 'application-prerequisites-ready', {});
  if (!existing) fixtures.push(base);
  const rehearsal = existing !== undefined && existingEnvironment === 'prod';
  const stage = canonicalPhaseGraph.phases.find((entry) => entry.id === (rehearsal ? 'production-rehearsed' : 'staging-qualified'))!;
  const f = existing ? {
    ...base, phase: stage,
    planning: () => ({ ...base.planning(), phase: stage }),
    execution: (build: Parameters<typeof base.execution>[0], options: Parameters<typeof base.execution>[1] = {}) =>
      base.execution(build, { ...options, phaseId: stage.id })
  } : base;
  const environment = existing ? existingEnvironment : 'dev';
  const rootParts = ['infrastructure', 'opentofu', 'azure', 'environments', environment];
  const moduleParts = ['infrastructure', 'opentofu', 'azure', 'modules', existing ? environment : 'core'];
  const groupName = existing ? `rg-${environment}` : 'rg-app';
  const group = `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/${groupName}`;
  const environmentId = `${group}/providers/Microsoft.App/managedEnvironments/application-environment`;
  const applicationId = `${group}/providers/Microsoft.App/containerApps/application`;
  const healthUrl = `https://${existing ? environment : 'application'}.fixture.azurecontainerapps.io/health`;
  const held = custody(f.root);
  held.tools.hostId = nativeStateHostId();
  await mkdir(held.workspaceRoot, { recursive: true, mode: 0o700 });
  const nativeRoot = path.join(f.root, existing ? `native-${environment}` : 'native');
  await mkdir(nativeRoot, { mode: 0o700 });
  const auditPath = path.join(nativeRoot, 'audit.jsonl');
  const controlPath = path.join(nativeRoot, 'control.json');
  const providerStatePath = path.join(nativeRoot, 'provider-state.json');
  const providerDirectory = path.join(nativeRoot, 'mirror', 'registry.opentofu.org', 'hashicorp', 'azurerm', '4.30.0',
    `darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`);
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  const providerPath = path.join(providerDirectory, 'terraform-provider-azurerm_v4.30.0');
  await writeFile(providerPath, 'ISOLATED_PROVIDER_PACKAGE_NEVER_EXECUTED', { mode: 0o500 });
  await writeFile(controlPath, '{}', { mode: 0o600 });
  const existingIdentity = {
    id: identityId, name: 'id-workload', type: 'Microsoft.ManagedIdentity/userAssignedIdentities', location: 'eastus',
    tags: { 'liftoff-repository-id': '42' }, properties: {
      principalId: randomUUID(), clientId: randomUUID(), tenantId: fixtureBinding.tenantId
    }
  };
  const existingRegistry = {
    id: registryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
    tags: { 'liftoff-repository-id': '42' }, sku: { name: 'Basic' },
    properties: { provisioningState: 'Succeeded', adminUserEnabled: false, loginServer: 'crliftoff.azurecr.io' }
  };
  await writeFile(providerStatePath, JSON.stringify(scope !== 'prerequisites-core' || action === 'update' ? {
    [identityId]: existingIdentity, [registryId]: existingRegistry
  } : {}), { mode: 0o600 });
  await writeFile(auditPath, '', { mode: 0o600 });
  const target = { ...privateTarget(), hostId: held.tools.hostId };
  if (existing) target.backend.key = `${environment}.tfstate`;
  const provider = {
    source: 'registry.opentofu.org/hashicorp/azurerm' as const, version: '4.30.0',
    mirrorDirectory: path.join(nativeRoot, 'mirror'), binary: { path: providerPath, sha256: stateDigest('ISOLATED_PROVIDER_PACKAGE_NEVER_EXECUTED') }
  };
  const manifestBytes = applicationImageBytes('b'.repeat(40)).manifest;
  const imageDigest = `sha256:${stateDigest(manifestBytes)}`;
  const imageRef = `crliftoff.azurecr.io/team/app@${imageDigest}`;
  const roleName = randomUUID(), roleId = `${registryId}/providers/Microsoft.Authorization/roleAssignments/${roleName}`;
  const roleDefinitionId = `/subscriptions/${fixtureBinding.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`;
  const targets: ApplicationPrivateIntent['targets'] = scope === 'foundation' ? [
    {
      address: 'module.core.azurerm_container_app_environment.environment', type: 'azurerm_container_app_environment', resourceId: environmentId,
      actions: ['create'], expected: { name: 'application-environment', location: 'eastus',
        resource_group_name: groupName, 'tags.liftoff-repository-id': '42' }, role: null, runtime: null
    },
    {
      address: 'module.core.azurerm_container_app.application', type: 'azurerm_container_app', resourceId: applicationId,
      actions: ['create'], expected: {
        name: 'application', resource_group_name: groupName, container_app_environment_id: environmentId,
        revision_mode: 'Single', 'identity.0.type': 'UserAssigned', 'identity.0.identity_ids.0': identityId,
        'template.0.min_replicas': 1, 'template.0.max_replicas': 1,
        'template.0.container.0.name': 'app', 'template.0.container.0.image': imageRef,
        'template.0.container.0.cpu': 0.25, 'template.0.container.0.memory': '0.5Gi',
        'ingress.0.external_enabled': true, 'ingress.0.target_port': 8080, 'ingress.0.transport': 'auto',
        'tags.liftoff-repository-id': '42'
      }, role: null, runtime: { url: healthUrl, statusField: 'status', statusValue: 'ok' }
    }
  ] : scope === 'prerequisites-rbac' ? [{
    address: 'module.core.azurerm_role_assignment.pull', type: 'azurerm_role_assignment', resourceId: roleId,
    actions: ['create'], expected: {
      name: roleName, scope: registryId, principal_id: existingIdentity.properties.principalId,
      role_definition_id: roleDefinitionId, principal_type: 'ServicePrincipal'
    }, role: {
      scope: registryId, roleDefinitionId, principalId: existingIdentity.properties.principalId,
      identityResourceId: identityId, clientId: existingIdentity.properties.clientId
    }, runtime: null
  }] : [
    {
      address: 'module.core.azurerm_container_registry.registry', type: 'azurerm_container_registry', resourceId: registryId,
      actions: ['create'], expected: { name: 'crliftoff', location: 'eastus', resource_group_name: 'rg-app',
        sku: 'Basic', admin_enabled: false, 'tags.liftoff-repository-id': '42' }, role: null, runtime: null
    },
    {
      address: 'module.core.azurerm_user_assigned_identity.workload', type: 'azurerm_user_assigned_identity', resourceId: identityId,
      actions: ['create'], expected: { name: 'id-workload', location: 'eastus', resource_group_name: 'rg-app',
        'tags.liftoff-repository-id': '42' }, role: null, runtime: null
    }
  ];
  const template = {
    format_version: '1.2', terraform_version: '1.12.6', complete: true, errored: false, applyable: true,
    configuration: {
      provider_config: { azurerm: { name: 'azurerm', full_name: provider.source, version_constraint: '=4.30.0' } },
      root_module: { module_calls: { core: {
        source: `../../modules/${moduleParts.at(-1)}`, module: { resources: targets.map((item) => ({
          address: item.address.slice('module.core.'.length), provider_config_key: 'azurerm'
        })) }
      } } }
    },
    resource_changes: targets.map((item) => ({
      address: item.address, mode: 'managed', type: item.type, provider_name: provider.source,
      change: {
        actions: ['create'], before: null,
        after: { name: item.expected.name,
          ...(item.type === 'azurerm_role_assignment' ? {
            scope: registryId, principal_id: existingIdentity.properties.principalId,
            role_definition_id: roleDefinitionId, principal_type: 'ServicePrincipal'
          } : { resource_group_name: groupName, tags: { 'liftoff-repository-id': '42' } }),
          id: null, ...(item.type === 'azurerm_container_registry'
            ? { location: 'eastus', sku: 'Basic', admin_enabled: false, login_server: null }
            : item.type === 'azurerm_user_assigned_identity'
              ? { location: 'eastus', principal_id: null, client_id: null, tenant_id: null }
              : item.type === 'azurerm_role_assignment' ? {} : item.type === 'azurerm_container_app_environment'
                ? { location: 'eastus', default_domain: null, static_ip_address: null }
                : {
                  container_app_environment_id: environmentId, revision_mode: 'Single',
                  identity: [{ type: 'UserAssigned', identity_ids: [identityId], principal_id: null, tenant_id: null }],
                  registry: [{ server: 'crliftoff.azurecr.io', identity: identityId }],
                  template: [{ min_replicas: 1, max_replicas: 1,
                    container: [{ name: 'app', image: imageRef, cpu: 0.25, memory: '0.5Gi' }] }],
                  ingress: [{ external_enabled: true, target_port: 8080, transport: 'auto', fqdn: null,
                    traffic_weight: [{ percentage: 100, latest_revision: true }] }],
                  latest_revision_name: null, latest_revision_fqdn: null
                }) },
        after_unknown: item.type === 'azurerm_container_registry' ? { id: true, login_server: true }
          : item.type === 'azurerm_role_assignment' ? { id: true }
            : item.type === 'azurerm_user_assigned_identity' ? { id: true, principal_id: true, client_id: true, tenant_id: true }
            : item.type === 'azurerm_container_app_environment' ? { id: true, default_domain: true, static_ip_address: true }
              : { id: true, latest_revision_name: true, latest_revision_fqdn: true, ingress: [{ fqdn: true }],
                identity: [{ principal_id: true, tenant_id: true }] }
      }
    }))
  };
  const originalResources: Record<string, unknown>[] = [];
  if (existing && !rehearsal) {
    const subnet = `${privateTarget().virtualNetworkId}/subnets/runners`;
    Object.assign(targets[0]!.expected, { internal_load_balancer_enabled: true, infrastructure_subnet_id: subnet });
    Object.assign(template.resource_changes[0]!.change.after, { internal_load_balancer_enabled: true, infrastructure_subnet_id: subnet });
  }
  if (rehearsal) {
    targets.splice(0, 1);
    template.resource_changes.splice(0, 1);
    template.configuration.root_module.module_calls.core.module.resources.splice(0, 1);
    targets[0]!.actions = ['update'];
    const change = template.resource_changes[0]!.change;
    const before = structuredClone(change.after);
    Object.assign(before, { id: applicationId, latest_revision_name: 'application--baseline',
      latest_revision_fqdn: 'application--baseline.fixture.azurecontainerapps.io' });
    before.template![0]!.container[0]!.image = `crliftoff.azurecr.io/team/app@sha256:${stateDigest(applicationImageBytes('a'.repeat(40)).manifest)}`;
    before.ingress![0]!.fqdn = new URL(healthUrl).hostname;
    before.identity![0]!.principal_id = existingIdentity.properties.principalId;
    before.identity![0]!.tenant_id = fixtureBinding.tenantId;
    Object.assign(change, { actions: ['update'], before, after: {
      ...before, latest_revision_name: null, latest_revision_fqdn: null,
      template: [{ ...before.template![0], container: [{ ...before.template![0]!.container[0], image: imageRef }] }]
    }, after_unknown: { latest_revision_name: true, latest_revision_fqdn: true } });
    originalResources.push({
      module: 'module.core', mode: 'managed', type: 'azurerm_container_app', name: 'application',
      provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]', instances: [{ schema_version: 0, attributes: before }]
    });
    await writeFile(providerStatePath, JSON.stringify({
      [identityId]: existingIdentity, [registryId]: existingRegistry,
      [environmentId]: {
        id: environmentId, name: 'application-environment', type: 'Microsoft.App/managedEnvironments',
        location: 'eastus', properties: { provisioningState: 'Succeeded', defaultDomain: 'fixture.azurecontainerapps.io', staticIp: '10.50.1.4' }
      },
      [applicationId]: {
        id: applicationId, name: 'application', type: 'Microsoft.App/containerApps', location: 'eastus',
        tags: { 'liftoff-repository-id': '42' },
        identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {
          principalId: existingIdentity.properties.principalId, clientId: existingIdentity.properties.clientId
        } } },
        properties: {
          provisioningState: 'Succeeded', runningStatus: 'Running', managedEnvironmentId: environmentId,
          latestRevisionName: 'application--baseline', latestReadyRevisionName: 'application--baseline',
          configuration: { activeRevisionsMode: 'Single', secrets: [], registries: before.registry,
            ingress: { fqdn: new URL(healthUrl).hostname, external: true, targetPort: 8080, transport: 'auto',
              traffic: [{ latestRevision: true, weight: 100 }] } },
          template: { scale: { minReplicas: 1, maxReplicas: 1 }, containers: [{
            name: 'app', image: before.template![0]!.container[0]!.image, resources: { cpu: 0.25, memory: '0.5Gi' }
          }] }
        }
      },
      [`${applicationId}/revisions/application--baseline`]: {
        id: `${applicationId}/revisions/application--baseline`, name: 'application--baseline',
        type: 'Microsoft.App/containerApps/revisions', properties: {
          active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running',
          template: { containers: [{ name: 'app', image: before.template![0]!.container[0]!.image,
            resources: { cpu: 0.25, memory: '0.5Gi' } }], scale: { minReplicas: 1, maxReplicas: 1 } }
        }
      }
    }), { mode: 0o600 });
  }
  if (action === 'update') {
    expect(scope).toBe('prerequisites-core');
    for (const [index, target] of targets.entries()) {
      const change = template.resource_changes[index]!.change;
      const before = {
        ...change.after, id: target.resourceId,
        ...(target.type === 'azurerm_container_registry' ? { login_server: 'crliftoff.azurecr.io' } : {
          principal_id: existingIdentity.properties.principalId, client_id: existingIdentity.properties.clientId,
          tenant_id: fixtureBinding.tenantId
        })
      };
      originalResources.push({
        module: 'module.core', mode: 'managed', type: target.type, name: target.address.split('.').at(-1),
        provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]', instances: [{ schema_version: 0, attributes: before }]
      });
      Object.assign(change, {
        actions: [index === 0 ? 'update' : 'no-op'], before,
        after: index === 0 ? { ...before, sku: 'Standard' } : before, after_unknown: {}
      });
      Object.assign(target, { actions: index === 0 ? ['update'] : ['no-op'] });
      if (index === 0) Object.assign(target.expected, { sku: 'Standard' });
    }
  }
  const node = await realpath(process.execPath);
  const script = `#!${node}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const auditPath = ${JSON.stringify(auditPath)};
const controlPath = ${JSON.stringify(controlPath)};
const providerStatePath = ${JSON.stringify(providerStatePath)};
const providerDirectory = ${JSON.stringify(providerDirectory)};
const targets = ${JSON.stringify(targets)};
const template = ${JSON.stringify(template)};
const args = process.argv.slice(2);
const append = (data) => fs.appendFileSync(auditPath, JSON.stringify(data) + '\\n');
const command = args[0];
if (command === 'version') {
  process.stdout.write(JSON.stringify({ terraform_version: '1.12.6', platform: ${JSON.stringify(`darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)} }));
  process.exit(0);
}
const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const root = process.cwd();
const statePath = JSON.parse(fs.readFileSync(path.join(root, 'liftoff-application-backend.tf.json'), 'utf8')).terraform.backend.local.path;
append({ kind: args.includes('-refresh-only') ? 'refresh' : command, args, credentialPresent: Boolean(process.env.ARM_CLIENT_SECRET),
  registration: process.env.ARM_RESOURCE_PROVIDER_REGISTRATIONS, home: process.env.HOME, cwd: root });
if (command === 'init') {
  const platform = ${JSON.stringify(`darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)};
  const install = path.join(root, '.terraform/providers/registry.opentofu.org/hashicorp/azurerm/4.30.0');
  fs.mkdirSync(install, { recursive: true, mode: 448 });
  fs.symlinkSync(providerDirectory, path.join(install, platform), 'dir');
  fs.mkdirSync(path.join(root, '.terraform/modules'), { recursive: true, mode: 448 });
  fs.writeFileSync(path.join(root, '.terraform/modules/modules.json'), JSON.stringify({ Modules: [
    { Key: '', Source: '', Dir: '.' }, { Key: 'core', Source: '../../modules/${moduleParts.at(-1)}', Dir: '../../modules/${moduleParts.at(-1)}' }
  ] }), { mode: 384 });
  process.stdout.write('PRIVATE_INIT_OUTPUT_WITHHELD'); process.exit(0);
}
if (command === 'plan' && args.includes('-refresh-only')) {
  if (control.refreshFault === 'drift') process.exit(2);
  if (control.refreshFault === 'mutate') fs.writeFileSync(statePath, 'UNEXPECTED_PRIVATE_REFRESH_MUTATION');
  process.stdout.write('PRIVATE_REFRESH_OUTPUT_WITHHELD');
  process.exit(0);
}
if (command === 'plan') {
  const planned = structuredClone(template);
  const variables = JSON.parse(fs.readFileSync(path.join(root, 'liftoff.private.tfvars.json'), 'utf8'));
  planned.variables = Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, { value }]));
  if (${rehearsal}) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const before = state.resources.find((entry) => entry.type === 'azurerm_container_app').instances[0].attributes;
    const change = planned.resource_changes[0].change;
    change.before = structuredClone(before);
    change.after = structuredClone(before);
    change.after.template[0].container[0].image = variables.application_image;
    change.after.latest_revision_name = null; change.after.latest_revision_fqdn = null;
  }
  if (control.planFault === 'delete') planned.resource_changes[0].change.actions = ['delete'];
  if (control.planFault === 'replace') planned.resource_changes[0].change.actions = ['delete', 'create'];
  if (control.planFault === 'drift') planned.resource_drift = [structuredClone(planned.resource_changes[0])];
  if (control.planFault === 'unknown-input') planned.resource_changes[0].change.after_unknown.name = true;
  if (control.planFault === 'unknown-principal') {
    planned.resource_changes[0].change.after.principal_id = null;
    planned.resource_changes[0].change.after_unknown.principal_id = true;
  }
  if (control.planFault === 'extra') {
    const extra = structuredClone(planned.resource_changes[0]); extra.address += '_foreign'; planned.resource_changes.push(extra);
  }
  fs.writeFileSync(args.find((arg) => arg.startsWith('-out=')).slice(5), JSON.stringify(planned), { mode: 384 });
  process.stdout.write('PRIVATE_PLAN_OUTPUT_WITHHELD');
  process.exit(2);
}
if (command === 'show') {
  process.stdout.write(fs.readFileSync(args[2]));
  if (control.planFault === 'changed-during-show') fs.writeFileSync(args[2], 'DIFFERENT_PRIVATE_PLAN_BYTES', { mode: 384 });
  process.exit(0);
}
if (command !== 'apply') process.exit(64);
const planBytes = fs.readFileSync(args.at(-1));
const plan = JSON.parse(planBytes);
const prior = fs.readFileSync(auditPath, 'utf8').trim().split('\\n').map(JSON.parse);
if (!plan.resource_changes.filter((change) => change.change.actions[0] !== 'no-op').every((target) =>
  prior.some((entry) => entry.kind === 'durable-resource-intent' && entry.address === target.address))) process.exit(65);
append({ kind: 'applied-saved-plan', digest: crypto.createHash('sha256').update(planBytes).digest('hex') });
if (control.applyDelayMs) await new Promise((resolve) => setTimeout(resolve, control.applyDelayMs));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const rows = JSON.parse(fs.readFileSync(providerStatePath, 'utf8'));
for (const [index, change] of plan.resource_changes.entries()) {
  if (change.change.actions[0] === 'no-op') continue;
  const target = targets.find((entry) => entry.address === change.address);
  const attributes = structuredClone(change.change.after);
  attributes.id = target.resourceId;
  if (target.type === 'azurerm_container_registry') {
    attributes.login_server = 'crliftoff.azurecr.io';
    rows[target.resourceId] = { id: target.resourceId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries',
      location: 'eastus', tags: { 'liftoff-repository-id': '42' }, sku: { name: attributes.sku },
      properties: { provisioningState: 'Succeeded', adminUserEnabled: false, loginServer: attributes.login_server } };
  } else if (target.type === 'azurerm_user_assigned_identity') {
    attributes.principal_id = crypto.randomUUID(); attributes.client_id = crypto.randomUUID();
    attributes.tenant_id = ${JSON.stringify(fixtureBinding.tenantId)};
    rows[target.resourceId] = { id: target.resourceId, name: 'id-workload', type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
      location: 'eastus', tags: { 'liftoff-repository-id': '42' },
      properties: { principalId: attributes.principal_id, clientId: attributes.client_id, tenantId: attributes.tenant_id } };
  } else if (target.type === 'azurerm_role_assignment') {
    rows[target.resourceId] = { id: target.resourceId, name: attributes.name, type: 'Microsoft.Authorization/roleAssignments',
      properties: { scope: attributes.scope, principalId: attributes.principal_id, principalType: attributes.principal_type,
        roleDefinitionId: attributes.role_definition_id } };
  } else if (target.type === 'azurerm_container_app_environment') {
    attributes.default_domain = 'fixture.azurecontainerapps.io'; attributes.static_ip_address = '10.50.1.4';
    rows[target.resourceId] = { id: target.resourceId, name: 'application-environment', type: 'Microsoft.App/managedEnvironments',
      location: 'eastus', tags: { 'liftoff-repository-id': '42' },
      properties: { provisioningState: 'Succeeded', defaultDomain: attributes.default_domain, staticIp: attributes.static_ip_address,
        ...(attributes.internal_load_balancer_enabled ? { vnetConfiguration: {
          internal: true, infrastructureSubnetId: attributes.infrastructure_subnet_id
        } } : {}) } };
  } else {
    attributes.latest_revision_name = control.revisionName ?? 'application--fixture1';
    attributes.latest_revision_fqdn = attributes.latest_revision_name + '.fixture.azurecontainerapps.io';
    attributes.ingress[0].fqdn = ${JSON.stringify(new URL(healthUrl).hostname)};
    rows[target.resourceId] = { id: target.resourceId, name: 'application', type: 'Microsoft.App/containerApps', location: 'eastus',
      tags: { 'liftoff-repository-id': '42' }, identity: { type: 'UserAssigned', userAssignedIdentities: {
        [${JSON.stringify(identityId)}]: { principalId: rows[${JSON.stringify(identityId)}].properties.principalId,
          clientId: rows[${JSON.stringify(identityId)}].properties.clientId }
      } },
      properties: { provisioningState: 'Succeeded', runningStatus: 'Running', managedEnvironmentId: ${JSON.stringify(environmentId)},
        latestRevisionName: attributes.latest_revision_name, latestReadyRevisionName: attributes.latest_revision_name,
        configuration: { activeRevisionsMode: 'Single', secrets: [], registries: attributes.registry,
          ingress: { fqdn: attributes.ingress[0].fqdn, external: true, targetPort: 8080, transport: 'auto',
            traffic: [{ latestRevision: true, weight: 100 }] } },
        template: { scale: { minReplicas: 1, maxReplicas: 1 },
          containers: [{ name: 'app', image: attributes.template[0].container[0].image, resources: { cpu: 0.25, memory: '0.5Gi' } }] } } };
    if (${rehearsal}) for (const [id, revision] of Object.entries(rows)) {
      if (id.startsWith(target.resourceId + '/revisions/')) revision.properties.active = false;
    }
    if (${rehearsal}) rows[target.resourceId + '/revisions/' + attributes.latest_revision_name] = {
      id: target.resourceId + '/revisions/' + attributes.latest_revision_name, name: attributes.latest_revision_name,
      type: 'Microsoft.App/containerApps/revisions', properties: {
        active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running',
        template: structuredClone(rows[target.resourceId].properties.template)
      }
    };
  }
  const parts = change.address.split('.');
  const resultResource = { module: 'module.core', mode: 'managed', type: target.type, name: parts.at(-1),
    provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]',
    instances: [{ schema_version: 0, attributes }] };
  const priorIndex = state.resources.findIndex((resource) => resource.type === target.type && resource.name === parts.at(-1));
  if (priorIndex >= 0) state.resources[priorIndex] = resultResource; else state.resources.push(resultResource);
  state.serial++;
  state.outputs.private_output = { value: plan.variables.private_input.value, sensitive: true };
  fs.writeFileSync(providerStatePath, JSON.stringify(rows), { mode: 384 });
  if (control.applyFault !== 'missing-state') fs.writeFileSync(statePath, JSON.stringify(state), { mode: 384 });
  append({ kind: 'simulated-provider-effect', address: change.address });
  if (control.applyFault === 'partial' && index === 0) process.exit(1);
}
if (control.applyFault === 'unknown-response') process.kill(process.pid, 'SIGKILL');
process.stdout.write('PRIVATE_APPLY_OUTPUT_WITHHELD'); process.exit(0);
`;
  const tofuPath = path.join(nativeRoot, 'tofu');
  const pythonPath = path.join(nativeRoot, 'python');
  const python = `#!${node}\nprocess.stdout.write(JSON.stringify({implementation:'CPython',version:'3.14.0'}));\n`;
  await writeFile(tofuPath, script, { mode: 0o500 });
  await writeFile(pythonPath, python, { mode: 0o500 });
  held.tools.tofu = { path: tofuPath, sha256: stateDigest(script) };
  held.tools.python = { path: pythonPath, sha256: stateDigest(python) };
  const { workspace, storage } = encryptedFixtureWorkspace(held);
  const put = workspace.put.bind(workspace);
  workspace.put = async (purpose, scope, bytes, id) => {
    const descriptor = await put(purpose, scope, bytes, id);
    if (purpose === 'journal') {
      const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (value.kind === 'resource-effect-intent') await appendFile(auditPath, JSON.stringify({
        kind: 'durable-resource-intent', address: value.address, ref: descriptor.ref
      }) + '\n');
    }
    return descriptor;
  };
  const variableId = randomUUID();
  const intent: ApplicationPrivateIntent = {
    schemaVersion: 1, scope: rehearsal ? 'rehearsal-rollout' : existing ? 'staging' : scope, binding: fixtureBinding, backend: target, custody: held,
    writer: { ...fixtureBinding, clientId: '12345678-1111-4222-8333-555555555555',
      keychainPath: path.join(f.root, 'writer.keychain'), service: 'org.liftoff.azure-application-writer.fixture', account: '42' },
    source: { rootPathParts: rootParts, backendPathParts: [...rootParts, 'backend.tf'],
      variablesRef: `${workspace.workspaceRef}/${variableId}`, provider },
    targets, artifact: scope === 'foundation' ? {
      evidenceId: 'isolated-immutable-build', headerDigest: 'a'.repeat(64), imageRef, sourceSha: 'b'.repeat(40), registryResourceId: registryId
    } : null, notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z',
    releaseUntil: '2026-09-15T00:17:00.000Z', maxCommandMs: 5_000
  };
  const sourceFiles = [
    { parts: [...rootParts, 'main.tf'], bytes: `terraform {
  required_version = "=1.12.6"
  required_providers { azurerm = { source = "hashicorp/azurerm", version = "=4.30.0" } }
}
provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}
variable "private_input" {
  type = string
  sensitive = true
}
module "core" {
  source = "../../modules/${moduleParts.at(-1)}"
  private_input = var.private_input
}
` },
    { parts: [...rootParts, 'backend.tf'], bytes: `terraform {
  backend "azurerm" {
    resource_group_name = "${target.backend.resourceGroup}"
    storage_account_name = "${target.backend.account}"
    container_name = "${target.backend.container}"
    key = "${target.backend.key}"
    subscription_id = "${fixtureBinding.subscriptionId}"
    tenant_id = "${fixtureBinding.tenantId}"
    use_azuread_auth = true
  }
}\n` },
    { parts: [...rootParts, '.terraform.lock.hcl'], bytes: `provider "${provider.source}" {
  version = "${provider.version}"
  hashes = ["zh:${'a'.repeat(64)}"]
}\n` },
    { parts: [...moduleParts, 'main.tf'], bytes: `variable "private_input" {
  type = string
  sensitive = true
}
resource "azurerm_container_registry" "registry" {
  name = "crliftoff"
  resource_group_name = "${groupName}"
  location = "eastus"
  sku = "Basic"
  admin_enabled = false
  tags = { liftoff-repository-id = "42" }
}
resource "azurerm_user_assigned_identity" "workload" {
  name = "id-workload"
  resource_group_name = "${groupName}"
  location = "eastus"
  tags = { liftoff-repository-id = "42" }
}
output "private_output" {
  value = var.private_input
  sensitive = true
}\n` }
  ];
  if (scope === 'foundation') sourceFiles[3]!.bytes = `variable "private_input" {
  type = string
  sensitive = true
}
resource "azurerm_container_app_environment" "environment" {
  name = "application-environment"
  resource_group_name = "${groupName}"
  location = "eastus"
  tags = { liftoff-repository-id = "42" }
}
resource "azurerm_container_app" "application" {
  name = "application"
  resource_group_name = "${groupName}"
  container_app_environment_id = "${environmentId}"
  revision_mode = "Single"
  depends_on = [azurerm_container_app_environment.environment]
  tags = { liftoff-repository-id = "42" }
  identity {
    type = "UserAssigned"
    identity_ids = ["${identityId}"]
  }
  registry {
    server = "crliftoff.azurecr.io"
    identity = "${identityId}"
  }
  template {
    min_replicas = 1
    max_replicas = 1
    container {
      name = "app"
      image = "${imageRef}"
      cpu = 0.25
      memory = "0.5Gi"
    }
  }
  ingress {
    external_enabled = true
    target_port = 8080
    transport = "auto"
    traffic_weight {
      percentage = 100
      latest_revision = true
    }
  }
}
`;
  if (scope === 'prerequisites-rbac') sourceFiles[3]!.bytes = `variable "private_input" {
  type = string
  sensitive = true
}
resource "azurerm_role_assignment" "pull" {
  name = "${roleName}"
  scope = "${registryId}"
  principal_id = "${existingIdentity.properties.principalId}"
  principal_type = "ServicePrincipal"
  role_definition_id = "${roleDefinitionId}"
}
`;
  if (rehearsal) {
    sourceFiles[0]!.bytes = sourceFiles[0]!.bytes.replace('module "core" {', 'variable "application_image" { type = string }\nmodule "core" {')
      .replace('private_input = var.private_input', 'private_input = var.private_input\n  application_image = var.application_image');
    sourceFiles[3]!.bytes = sourceFiles[3]!.bytes
      .replace(/resource "azurerm_container_app_environment" "environment" \{[\s\S]*?\n\}\n/u, '')
      .replace('  depends_on = [azurerm_container_app_environment.environment]\n', '')
      .replace(`image = "${imageRef}"`, 'image = var.application_image') +
      '\nvariable "application_image" { type = string }\n';
  }
  if (existing && !rehearsal) {
    sourceFiles[3]!.bytes = sourceFiles[3]!.bytes.replace('resource "azurerm_container_app_environment" "environment" {',
      `resource "azurerm_container_app_environment" "environment" {\n  internal_load_balancer_enabled = true\n  infrastructure_subnet_id = "${privateTarget().virtualNetworkId}/subnets/runners"`);
  }
  if (action === 'update') sourceFiles[3]!.bytes = sourceFiles[3]!.bytes.replace('sku = "Basic"', 'sku = "Standard"');
  for (const source of sourceFiles) {
    await mkdir(path.join(f.projectRoot, ...source.parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(f.projectRoot, ...source.parts), source.bytes);
  }
  if (includeStagingSource) {
    const recipe = stagingProducerRecipe({
      ...fixtureBinding, sourceSha: intent.artifact!.sourceSha, imageDigest,
      resourceId: `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-staging/providers/Microsoft.App/containerApps/application`,
      fqdn: 'staging.fixture.azurecontainerapps.io'
    });
    for (const file of stagingSourceFiles(recipe)) {
      await mkdir(path.dirname(path.join(f.projectRoot, file.path)), { recursive: true });
      await writeFile(path.join(f.projectRoot, file.path), file.content);
    }
  }
  f.inspection.activationInputs!.budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 };
  f.inspection.activationInputs!.phases[f.phase.id] = { privateExecution: { ...intent, mode: 'prepare' } };
  const context = applicationPrivateContext(f.planning(), { ...intent, mode: 'prepare' });
  await workspace.assertAvailable(context);
  await workspace.put('inspection', protectedStateScope(context), Buffer.from(JSON.stringify({
    private_input: variableSecret, ...(rehearsal ? { application_image: imageRef } : {})
  })), variableId);
  const initial = Buffer.from(JSON.stringify({
    version: 4, terraform_version: '1.12.6', lineage: randomUUID(), serial: 1,
    outputs: { retained: { value: originalSecret, sensitive: true },
      ...(rehearsal ? { private_output: { value: variableSecret, sensitive: true } } : {}) }, resources: originalResources
  }));
  let http: ReturnType<typeof privateStateHttpFixture> | undefined;
  const armCalls: string[] = [];
  const arm: AzureArmTransport = {
    async request(request, binding) {
      expect(request.method).toBe('GET');
      expect(binding).toEqual(fixtureBinding);
      armCalls.push(request.resourceId);
      const match = new RegExp(`^/subscriptions/${fixtureBinding.subscriptionId}/providers/([^/]+)$`, 'u').exec(request.resourceId);
      if (match) return { status: 200, requestId: randomUUID(), data: {
        namespace: match[1], registrationState: 'Registered', id: request.resourceId
      } };
      const rows = JSON.parse(await readFile(providerStatePath, 'utf8'));
      if (faults.runtimeImage && request.resourceId === applicationId && rows[applicationId]) {
        rows[applicationId].properties.template.containers[0].image = `crliftoff.azurecr.io/team/app@sha256:${'f'.repeat(64)}`;
      }
      if (faults.runtimeEnvironment && request.resourceId === applicationId && rows[applicationId]) {
        rows[applicationId].properties.template.containers[0].env = [{ name: 'UNREVIEWED', value: 'unreviewed' }];
      }
      if (faults.runtimeSecret && request.resourceId === applicationId && rows[applicationId]) {
        rows[applicationId].properties.configuration.secrets = [{ name: 'unreviewed-secret' }];
      }
      if (faults.malformedResource && request.resourceId === registryId && rows[registryId]) rows[registryId].type = 'Unknown.Provider/type';
      return { status: rows[request.resourceId] ? 200 : 404, requestId: randomUUID(),
        data: rows[request.resourceId] ?? { error: { code: 'ResourceNotFound' } } };
    }
  };
  const faults = { principal: false, stateWrite: false, unknownStateWrite: false, leaseChanged: false, backendAbsent: false,
    health: false, artifactBytes: false, runtimeImage: false, runtimeEnvironment: false, runtimeSecret: false, malformedResource: false };
  const credentialFetch: typeof globalThis.fetch = async (url, init) => {
    const value = new URL(String(url));
    expect(init?.redirect).toBe('error');
    if (value.href === healthUrl) {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(JSON.stringify({ status: 'ok' }), { status: faults.health ? 503 : 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.origin === 'https://crliftoff.azurecr.io') {
      const jwt = (claims: object) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
        exp: fixtureTime.getTime() / 1000 + 3600, ...claims
      })).toString('base64url')}.signature`;
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (value.pathname === '/oauth2/exchange') {
        expect(init?.method).toBe('POST');
        expect(form.get('tenant')).toBe(fixtureBinding.tenantId);
        return new Response(JSON.stringify({ refresh_token: jwt({
          aud: 'crliftoff.azurecr.io', grant_type: 'refresh_token', tenant: fixtureBinding.tenantId
        }) }));
      }
      if (value.pathname === '/oauth2/token') {
        expect(init?.method).toBe('POST');
        expect(form.get('scope')).toBe('repository:team/app:pull');
        return new Response(JSON.stringify({ access_token: jwt({
          aud: 'crliftoff.azurecr.io', grant_type: 'access_token', access: [{ type: 'repository', name: 'team/app', actions: ['pull'] }]
        }) }));
      }
      expect(init?.method).toBe('GET');
      const baselineBytes = applicationImageBytes('a'.repeat(40)).manifest;
      const baselineDigest = `sha256:${stateDigest(baselineBytes)}`;
      const baseline = rehearsal && value.pathname === `/v2/team/app/manifests/${baselineDigest}`;
      expect(value.pathname).toBe(`/v2/team/app/manifests/${baseline ? baselineDigest : imageDigest}`);
      return new Response(faults.artifactBytes ? Buffer.from('CHANGED_IMMUTABLE_ARTIFACT') : Uint8Array.from(baseline ? baselineBytes : manifestBytes), {
        headers: { 'docker-content-digest': baseline ? baselineDigest : imageDigest, 'x-ms-request-id': 'SYNTHETIC-REGISTRY-GET' }
      });
    }
    if (value.origin === 'https://login.microsoftonline.com') {
      expect(init?.method).toBe('POST');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_secret')).toBe(credentialSecret);
      const claims = {
        tid: fixtureBinding.tenantId, oid: faults.principal ? randomUUID() : fixtureBinding.principalId,
        appid: intent.writer.clientId, aud: 'https://management.azure.com/', exp: fixtureTime.getTime() / 1000 + 3600
      };
      return new Response(JSON.stringify({
        access_token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
        token_type: 'Bearer', expires_in: 3600
      }));
    }
    expect(value.origin).toBe('https://management.azure.com');
    expect(value.pathname).toMatch(/\/providers\/Microsoft\.Authorization\/permissions$/u);
    expect(init?.method).toBe('GET');
    return new Response(JSON.stringify({ value: [{ actions: ['*'], notActions: [], dataActions: [], notDataActions: [] }] }));
  };
  const adapters: ApplicationPrivateAdapters = {
    storage: {
      workspace,
      async assertDirectory(directory: string, selected: StateExecutionContext) {
        expect(selected.hostId).toBe(nativeStateHostId());
        const relative = path.relative(held.workspaceRoot, directory);
        expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
        expect(await realpath(directory)).toBe(directory);
        const info = await lstat(directory);
        expect(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0).toBe(true);
      }
    },
    bridge: { async request(operation) {
      expect(operation).toBe('keychain-secret');
      return { uid: process.getuid?.(), value: Buffer.from(credentialSecret).toString('base64') };
    } },
    fetch: credentialFetch,
    backend(recorder) {
      const fresh = privateStateHttpFixture(target, recorder);
      fresh.blob.bytes = faults.backendAbsent ? null : http
        ? http.blob.bytes ? Uint8Array.from(http.blob.bytes) : null : Uint8Array.from(initial);
      if (http) {
        fresh.blob.version = http.blob.version; fresh.blob.operationId = http.blob.operationId;
        fresh.blob.calls = http.blob.calls; fresh.blob.leaseId = http.blob.leaseId;
      }
      fresh.blob.staleWrite = faults.stateWrite;
      fresh.blob.unknownWrite = faults.unknownStateWrite;
      http = fresh;
      return fresh.path.backend;
    }
  };
  let last: ApplicationPrivateResult | undefined;
  const issue = async (configuration: ApplicationPrivateConfiguration, recovery = false, issued = true) => {
    f.now.setTime(f.now.getTime() + 1_000);
    f.inspection.activationInputs!.phases[f.phase.id] = { privateExecution: structuredClone(configuration) };
    const plan = await planApplicationPrivateExecution(f.planning());
    const input = await f.execution(plan, { recovery, issue: issued });
    input.adapters.azureActivation!.transport = arm;
    if (scope === 'foundation') {
      input.runner = { async run(command) {
        expect(command.executable).toBe('az');
        expect(command.args.slice(0, 2)).toEqual(['account', 'get-access-token']);
        return {
          status: 0, stderr: '', displayCommand: 'isolated scoped artifact credential fixture',
          stdout: JSON.stringify({ tokenType: 'Bearer', subscription: fixtureBinding.subscriptionId, tenant: fixtureBinding.tenantId,
            accessToken: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
              exp: fixtureTime.getTime() / 1000 + 3600, oid: fixtureBinding.principalId, tid: fixtureBinding.tenantId,
              aud: 'https://management.azure.com/'
            })).toString('base64url')}.signature`
          })
        };
      } };
    }
    return input;
  };
  const execute = async (input: PhaseAdapterExecutionInput) => {
    last = await withProjectMutationLock(f.projectRoot, (lease) => executeApplicationPrivatePlan({ ...input, lease }, adapters));
    return last;
  };
  const prepare = async () => execute(await issue({ ...intent, mode: 'prepare' }));
  const applyInput = async (reviewed: ApplicationPrivateReview) => issue({ ...intent, mode: 'apply', reviewed });
  const recover = async (mode: 'inspect' | 'publish-retained' | 'close-unapplied' = 'publish-retained') => {
    if (!last?.journalRef || !last.transactionId) throw new Error('No original fixture checkpoint.');
    return execute(await issue({
      ...intent, mode: 'recover', recovery: mode, reviewed: last.reviewed ?? null,
      checkpoint: { journalRef: last.journalRef, transactionId: last.transactionId },
      candidateRef: last.retainedCandidateRef, recoveryWindow: {
        notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z', releaseUntil: '2026-09-15T00:17:00.000Z'
      }
    }, true));
  };
  const journal = async (): Promise<ApplicationPrivateJournal> => {
    const bytes = await workspace.get(last!.journalRef!, 'journal', protectedStateScope(context));
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } finally { bytes.fill(0); }
  };
  const saved = async (): Promise<ApplicationPrivateSavedPlan> => {
    const current = await journal();
    const bytes = await workspace.get(current.planRef!, 'plan', protectedStateScope(context));
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } finally { bytes.fill(0); }
  };
  if (intent.artifact) {
    await f.refreshInputs();
    const context = f.inspection.contexts['application-artifact-ready'];
    const outputs: PhaseOutputBindings = {
      values: { 'azure.artifact.digest': imageDigest, 'azure.artifact.imageRef': imageRef, 'azure.artifact.sourceSha': intent.artifact.sourceSha },
      resources: [{ provider: 'azure', resourceType: 'containerRegistry', resourceId: registryId }]
    };
    const payload = {
      kind: 'application-artifact-ready.v1', digest: imageDigest, imageRef, sourceCommitSha: intent.artifact.sourceSha,
      outputBindings: outputs
    };
    const liveReadback: LiveReadbackProof[] = (['azure', 'github'] as const).map((provider) => ({
      schemaVersion: context.identity.evidenceHeaderSchemaVersion, identity: context.identity,
      repositoryId: context.repositoryId, phaseGraphHash: context.phaseGraphHash, phaseId: 'application-artifact-ready',
      baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
      observedAt: fixtureTime.toISOString(), provider, matches: true,
      resourceType: provider === 'azure' ? 'containerRegistry' : 'workflow-run',
      resourceId: provider === 'azure' ? registryId : '/repos/owner/repo/actions/runs/100',
      sourceDigest: canonicalSha256({ fixture: 'independently-observed-build', imageDigest }),
      readbackDigest: canonicalSha256({ fixture: 'independently-observed-build', imageDigest })
    }));
    const header: EvidenceHeader = {
      schemaVersion: context.identity.evidenceHeaderSchemaVersion, identity: context.identity, repositoryId: context.repositoryId,
      phaseGraphHash: context.phaseGraphHash, phaseId: 'application-artifact-ready', phaseContractDigest: context.phaseContractDigest,
      baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
      remoteBindingDigest: context.remoteBindingDigest, producedAt: fixtureTime.toISOString(),
      producer: 'isolated-upstream-build-proof-fixture', result: 'verified', bodyDigest: evidenceBodyDigest(payload, liveReadback)
    };
    intent.artifact.headerDigest = evidenceHeaderDigest(header);
    f.inspection.evidence = [{ evidenceId: intent.artifact.evidenceId, header, payload, liveReadback }];
    f.inspection.state.phases['application-artifact-ready'].state = 'verified';
    f.inspection.state.phases['application-artifact-ready'].evidence = [{
      evidenceId: intent.artifact.evidenceId, headerDigest: intent.artifact.headerDigest, phaseId: 'application-artifact-ready', result: 'verified'
    }];
    f.inspection.state.phaseOutputs = { 'application-artifact-ready': outputs };
    f.inspection.activationInputs!.phases[f.phase.id] = { privateExecution: { ...intent, mode: 'prepare' } };
    await f.refreshInputs();
  }
  return {
    f, intent, sourceFiles, workspace, storage, adapters, initial, faults, context, auditPath, controlPath,
    providerStatePath, armCalls, issue, execute, prepare, applyInput, recover, journal, saved, credentialFetch,
    targetIds: { groupName, environmentId, applicationId, healthUrl }, arm, identity: existingIdentity,
    http: () => http!,
    audit: async () => (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    control: (value: object) => writeFile(controlPath, JSON.stringify(value), { mode: 0o600 })
  };
}

describe('default private application saved-plan process and backend protocol', () => {
  it('accepts the real governance ordering where plan creation precedes separately issued approval', async () => {
    const f = await fixture();
    const preparation = await f.issue({ ...f.intent, mode: 'prepare' });
    preparation.plan.createdAt = new Date(f.f.now.getTime() - 20_000).toISOString();
    const prepared = await f.execute(preparation);
    expect(prepared.status, prepared.blocker).toBe('prepared');
    const apply = await f.applyInput(prepared.reviewed!);
    apply.plan.createdAt = new Date(f.f.now.getTime() - 20_000).toISOString();
    const outcome = await f.execute(apply);
    expect(outcome.status, outcome.blocker).toBe('executed');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
  });

  it('updates an exactly owned resource without replacing its ID or mutating a no-op workload identity', async () => {
    const f = await fixture('prerequisites-core', 'update');
    const original = JSON.parse(f.initial.toString('utf8'));
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    expect(prepared.reviewed!.changes.map((change) => change.action)).toEqual(['update', 'no-op']);
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.status, outcome.blocker).toBe('executed');
    const after = JSON.parse(Buffer.from(f.http().blob.bytes!).toString('utf8'));
    expect(after.resources).toHaveLength(2);
    expect(after.resources[0].instances[0].attributes.id).toBe(original.resources[0].instances[0].attributes.id);
    expect(after.resources[0].instances[0].attributes.sku).toBe('Standard');
    expect(after.resources[1]).toEqual(original.resources[1]);
    expect((await f.journal()).effectIntents).toHaveLength(1);
    expect((await f.audit()).filter((entry) => entry.kind === 'simulated-provider-effect')).toHaveLength(1);
  });

  it('runs the exact privately saved plan with separate durable resource intents, actual readbacks and one leased state publication', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect(prepared, prepared.blocker).toMatchObject({ status: 'prepared', state: 'unchanged', effects: [
      { status: 'not-attempted' }, { status: 'not-attempted' }
    ] });
    const saved = await f.saved();
    const applied = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(applied, applied.blocker).toMatchObject({
      status: 'executed', state: 'published-verified', additionalReview: 'exact-workload-rbac',
      atomicAcrossProviders: false, qualification: 'unqualified-source-component',
      effects: [{ status: 'observed', mutationRequestId: null }, { status: 'observed', mutationRequestId: null }]
    });

    expect(applied.identities).toEqual([{
      address: f.intent.targets[1]!.address, resourceId: identityId,
      principalId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      clientId: expect.stringMatching(/^[a-f0-9-]{36}$/u), tenantId: fixtureBinding.tenantId
    }]);
    expect(applied.identities[0]!.principalId).not.toBe(fixtureBinding.principalId);
    const audit = await f.audit();
    expect(audit.filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(audit.find((entry) => entry.kind === 'applied-saved-plan').digest).toBe(saved.savedPlan.digest);
    const index = audit.findIndex((entry) => entry.kind === 'apply');
    expect(audit.slice(0, index).filter((entry) => entry.kind === 'durable-resource-intent')).toHaveLength(2);
    expect(audit.filter((entry) => entry.kind === 'plan')).toHaveLength(1);
    expect(audit.filter((entry) => entry.kind === 'refresh')).toEqual([expect.objectContaining({
      registration: 'none', credentialPresent: true,
      args: expect.arrayContaining(['-refresh-only', '-detailed-exitcode', '-lock=true'])
    })]);
    expect(audit.filter((entry) => entry.kind === 'apply')[0]).toMatchObject({
      registration: 'none', credentialPresent: true, args: expect.arrayContaining(['-lock=true', '-json'])
    });
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    expect(f.http().blob.leaseId).toBeNull();
    const retained = await f.journal();
    expect(retained.effectIntents).toHaveLength(2);
    expect(retained).toMatchObject({ nativeStarted: true, processSettled: true, nativeExitCode: 0, publication: 'verified' });
    expect(retained.events.some((event) => event.kind === 'state-readback' &&
      event.details.kind === 'independent-private-resource-refresh' && event.details.result === 'no-change')).toBe(true);
    const backup = await f.workspace.get(retained.original!.ref, 'backup', protectedStateScope(f.context));
    expect(Buffer.from(backup)).toEqual(f.initial);
    backup.fill(0);
    const publicText = JSON.stringify({ prepared, applied });
    for (const forbidden of [originalSecret, variableSecret, credentialSecret, stateDigest(f.initial), saved.savedPlan.digest,
      saved.variables.digest, stateDigest(f.http().blob.bytes!)]) expect(publicText).not.toContain(forbidden);
    expect(JSON.stringify(audit)).not.toContain(credentialSecret);
    for (const bytes of f.storage.files.values()) {
      const text = Buffer.from(bytes).toString('utf8');
      expect(text).not.toContain(variableSecret);
      expect(text).not.toContain(originalSecret);
    }
  });

  it.each(['drift', 'mutate'] as const)('retains the candidate without publication when independent private refresh detects %s', async (refreshFault) => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.control({ refreshFault });
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
    expect(failed.blocker).toContain(refreshFault === 'drift' ? 'independent-private-refresh-drift' : 'private-readback-mutated-state');
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(0);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(failed.retainedCandidateRef).not.toBeNull();
    await f.control({});
    const recovered = await f.recover();
    if (refreshFault === 'drift') expect(recovered.status, recovered.blocker).toBe('executed');
    else expect(recovered.blocker).toContain('private-readback-state-changed');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
  });

  it('retains partial real effects and state, then only publishes the reviewed accounted candidate during recovery', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    await f.control({ applyFault: 'partial' });
    const input = await f.applyInput(prepared.reviewed!);
    const failed = await f.execute(input);
    expect(failed, failed.blocker).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    expect((await f.journal()).nativeExitCode).toBe(1);
    const again = await f.execute(input);
    expect(again.status).toBe('blocked');
    const recovered = await f.recover();
    expect(recovered, recovered.blocker).toMatchObject({ status: 'partial-published', state: 'published-verified' });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(JSON.parse(Buffer.from(f.http().blob.bytes!).toString('utf8')).resources).toHaveLength(1);
    expect((await f.journal()).original).not.toBeNull();
  });

  it('recovers an unknown state PUT by exact private state readback without a duplicate apply or PUT', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    f.faults.unknownStateWrite = true;
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed, failed.blocker).toMatchObject({ status: 'blocked', state: 'publication-uncertain' });
    f.faults.unknownStateWrite = false;
    const recovered = await f.recover();
    expect(recovered, recovered.blocker).toMatchObject({ status: 'executed', state: 'published-verified' });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('requires a real project lease and privately issued approval before any native/backend access', async () => {
    const f = await fixture();
    const approved = await f.issue({ ...f.intent, mode: 'prepare' });
    expect((await executeApplicationPrivatePlan(approved, f.adapters)).status).toBe('blocked');
    const fake = await executeApplicationPrivatePlan({ ...approved, lease: { async assertHeld() {} } }, f.adapters);
    expect(fake.blocker).toContain('real-project-mutation-lease-required');
    expect(await f.audit()).toEqual([]);
    const unissued = await f.issue({ ...f.intent, mode: 'prepare' }, false, false);
    expect((await f.execute(unissued)).status).toBe('blocked');
    expect(await f.audit()).toEqual([]);
    expect(f.armCalls).toEqual([]);
  });

  it('names exact read destinations and lease scope without pretending preparation provisions application resources', async () => {
    const f = await fixture();
    const input = await f.issue({ ...f.intent, mode: 'prepare' });
    expect(input.plan.operations).toHaveLength(1);
    expect(input.plan.operations[0]).toMatchObject({
      actionId: 'azure.application-private.prepare', mutationClass: 'backend-state-write'
    });
    expect(input.plan.operations.flatMap((operation) => operation.effects?.map((effect) => effect.destination.identity) ?? []))
      .toEqual(expect.arrayContaining([registryId, identityId]));
    for (const operation of input.plan.operations) {
      expect(operation.inputs.resourceMutation).toBe('forbidden');
      expect(operation.inputs.stateLeaseActions).toEqual(['acquire', 'renew', 'release']);
    }
  });

  it.each(['delete', 'replace', 'drift', 'unknown-input', 'extra', 'changed-during-show'])('refuses saved-plan %s before resource effects and retains the original backup', async (planFault) => {
    const f = await fixture();
    await f.control({ planFault });
    const outcome = await f.prepare();
    expect(outcome.status).toBe('blocked');
    expect((await f.audit()).some((entry) => entry.kind === 'apply')).toBe(false);
    expect(f.http().blob.calls.some((call) => call.method === 'PUT' && call.target === 'blob')).toBe(false);
    expect((await f.journal()).original).not.toBeNull();
    expect(f.http().blob.leaseId).toBeNull();
    expect((await f.recover('close-unapplied')).status).toBe('closed-unapplied');
  });

  it.each(['source', 'source-added', 'source-mode', 'principal', 'backend'] as const)(
    'rejects a %s binding change and retains the original reference rather than claiming no earlier effects', async (changed) => {
      const f = await fixture();
      const prepared = await f.prepare();
      expect(prepared.status, prepared.blocker).toBe('prepared');
      const input = await f.applyInput(prepared.reviewed!);
      const root = path.join(f.f.projectRoot, ...rootParts);
      if (changed === 'source') await appendFile(path.join(root, 'main.tf'), '\nlocals { changed = true }\n');
      if (changed === 'source-added') await writeFile(path.join(root, 'new.tf'), 'locals { changed = true }\n');
      if (changed === 'source-mode') await chmod(path.join(root, 'main.tf'), 0o600);
      if (changed === 'principal') {
        const config = f.f.inspection.activationInputs!.phases[f.f.phase.id]!.privateExecution as ApplicationPrivateConfiguration;
        config.binding.principalId = randomUUID();
      }
      if (changed === 'backend') {
        const config = f.f.inspection.activationInputs!.phases[f.f.phase.id]!.privateExecution as ApplicationPrivateConfiguration;
        config.backend.backend.key = 'another-state.tfstate';
      }
      const outcome = await f.execute(input);
      expect(outcome, outcome.blocker).toMatchObject({
        status: 'blocked', journalRef: prepared.journalRef, state: 'unresolved-private-record'
      });
      expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
      expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    }
  );

  it('refuses a changed remote ETag/version before native execution', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const input = await f.applyInput(prepared.reviewed!);
    f.http().blob.version++;
    const outcome = await f.execute(input);
    expect(outcome, outcome.blocker).toMatchObject({ status: 'blocked' });
    expect(outcome.blocker).toContain('private-backend-changed');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
  });

  it('never substitutes an absent/conditional-create backend for a real held application lease', async () => {
    const f = await fixture();
    f.faults.backendAbsent = true;
    const outcome = await f.prepare();
    expect(outcome.blocker).toContain('existing-private-state-required');
    expect(f.http().blob.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect((await f.audit()).length).toBe(0);
  });

  it('rejects changed private saved-plan bytes without replanning or applying', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const saved = await f.saved();
    const input = await f.applyInput(prepared.reviewed!);
    await writeFile(path.join(saved.directory.path, ...rootParts.slice(3), 'review.tfplan'), 'different saved plan', { mode: 0o600 });
    const outcome = await f.execute(input);
    expect(outcome.blocker).toContain('saved-native-input-changed');
    expect((await f.audit()).filter((entry) => entry.kind === 'plan')).toHaveLength(1);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
  });

  it('checks exact bytes again after credential resolution, immediately before the real process spawn', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const saved = await f.saved();
    const fetch = f.adapters.fetch!;
    f.adapters.fetch = async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).startsWith('https://login.microsoftonline.com/')) {
        await writeFile(path.join(saved.directory.path, ...rootParts.slice(3), 'review.tfplan'), 'late substituted bytes', { mode: 0o600 });
      }
      return response;
    };
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.blocker).toContain('last-moment-saved-input-change');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect((await f.journal()).nativeStarted).toBe(true);
    expect(outcome.retainedCandidateRef).not.toBeNull();
  });

  it('checks the actual AAD writer principal instead of trusting client IDs or configuration declarations', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.principal = true;
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.blocker).toContain('writer-principal-or-scope');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain(credentialSecret);
  });

  it('stops the owned native process when the actual Blob lease changes and preserves candidate/original custody', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.control({ applyDelayMs: 3_000 });
    const input = await f.applyInput(prepared.reviewed!);
    const executing = f.execute(input);
    for (let attempt = 0; attempt < 100 && !(await f.audit()).some((entry) => entry.kind === 'applied-saved-plan'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await f.audit()).some((entry) => entry.kind === 'applied-saved-plan')).toBe(true);
    f.http().blob.leaseId = randomUUID();
    const outcome = await executing;
    expect(outcome.status).toBe('blocked');
    expect(outcome.retainedCandidateRef).not.toBeNull();
    expect(f.http().blob.calls.some((call) => call.method === 'PUT' && call.target === 'blob')).toBe(false);
    expect((await f.journal()).processSettled).toBe(true);
    expect((await f.audit()).filter((entry) => entry.kind === 'simulated-provider-effect')).toHaveLength(0);
  });

  it('retains rejected state publication and retries only the reviewed candidate under a new real lease', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.stateWrite = true;
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.state).toBe('publication-uncertain');
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    f.faults.stateWrite = false;
    const recovered = await f.recover();
    expect(recovered, recovered.blocker).toMatchObject({ status: 'executed', state: 'published-verified' });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(2);
  });

  it('recovers a lost native response by resource and state readback, not by repeating the saved apply', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.control({ applyFault: 'unknown-response' });
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
    const recovered = await f.recover();
    expect(recovered, recovered.blocker).toMatchObject({ status: 'executed', state: 'published-verified' });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect((await f.journal()).nativeExitCode).not.toBe(0);
  });

  it('retains real resource identities when the provider failed to persist matching state and refuses blind recovery', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.control({ applyFault: 'missing-state' });
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.status).toBe('blocked');
    expect(failed.observations.map((entry) => entry.resourceId)).toEqual([registryId, identityId]);
    expect(failed.effects.every((effect) => effect.mutationRequestId === null && effect.readbackRequestId !== null)).toBe(true);
    expect(failed.identities[0]!.principalId).not.toBe(fixtureBinding.principalId);
    const recovered = await f.recover();
    expect(recovered.status).toBe('blocked');
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
  });

  it('cannot start any resource effect unless every individual durable resource intent was retained', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const put = f.workspace.put.bind(f.workspace);
    f.workspace.put = async (purpose, scope, bytes, id) => {
      if (purpose === 'journal') {
        const record = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (record.kind === 'resource-effect-intent' && record.address === f.intent.targets[1]!.address) {
          throw new Error('PRIVATE_CUSTODY_FAILURE_WITHHELD');
        }
      }
      return put(purpose, scope, bytes, id);
    };
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.status).toBe('blocked');
    expect((await f.journal()).effectIntents).toHaveLength(1);
    expect((await f.journal()).nativeStarted).toBe(false);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect((await f.recover('close-unapplied')).status).toBe('closed-unapplied');
  });

  it('requires exact fresh recovery authority and will not close an attempted apply or replace its journal', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.control({ applyFault: 'partial' });
    const input = await f.applyInput(prepared.reviewed!);
    const failed = await f.execute(input);
    expect(failed.status).toBe('blocked');
    const refused = await f.recover('close-unapplied');
    expect(refused.blocker).toContain('resource-effects-cannot-be-abandoned');
    const replacement = await f.execute(await f.issue({ ...f.intent, mode: 'prepare' }));
    expect(replacement.status).toBe('blocked');
    expect(replacement.journalRef).toBe(failed.journalRef);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
  });

  it('never turns the successful core stage into ready/RBAC evidence at the phase wrapper', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const input = await f.applyInput(prepared.reviewed!);
    const outcome = await withProjectMutationLock(f.f.projectRoot, (lease) =>
      executeApplicationPrivateExecution({ ...input, lease }, f.adapters));
    expect(outcome).toMatchObject({ status: 'review-required', completedOperations: input.plan.operations,
      review: { kind: 'application-prerequisites-rbac', sourcePlanDigest: input.plan.planDigest } });
    expect(outcome.blocker).toContain('separate exact RBAC plan');
    expect(outcome.resultState).toBeUndefined();
    expect(outcome.operation).toBeUndefined();
    expect(outcome.liveReadback).toHaveLength(2);
  });

  it.each(['registration', 'program', 'automatic-variables', 'remote-module', 'link'] as const)(
    'rejects %s in the exact HCL closure without running a project program or contacting a provider', async (fault) => {
      const f = await fixture();
      const root = path.join(f.f.projectRoot, ...rootParts);
      const main = path.join(root, 'main.tf');
      if (fault === 'registration') await writeFile(main, (await readFile(main, 'utf8')).replace('"none"', '"all"'));
      if (fault === 'program') await appendFile(path.join(f.f.projectRoot, ...moduleParts, 'main.tf'),
        '\nresource "azurerm_resource_group" "unapproved" {\n name = "foreign"\n provisioner "local-exec" { command = "never run" }\n}\n');
      if (fault === 'automatic-variables') await writeFile(path.join(root, 'secret.auto.tfvars'), 'x = "private"\n');
      if (fault === 'remote-module') await writeFile(main, (await readFile(main, 'utf8')).replace('../../modules/core', 'git::https://example.invalid/source'));
      if (fault === 'link') await symlink(path.join(f.f.projectRoot, ...moduleParts, 'main.tf'), path.join(root, 'linked.tf'));
      const build = await planApplicationPrivateExecution(f.f.planning());
      expect(build.operations).toEqual([]);
      expect(build.blockers).toHaveLength(1);
      expect(await f.audit()).toEqual([]);
      expect(f.armCalls).toEqual([]);
    }
  );

  it('refuses a replaced protected directory without deleting the replacement or applying', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const saved = await f.saved();
    await rename(saved.directory.path, `${saved.directory.path}-original`);
    await mkdir(saved.directory.path, { mode: 0o700 });
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.blocker).toContain('private-directory-replaced');
    expect((await lstat(saved.directory.path)).isDirectory()).toBe(true);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
  });

  it('binds exact private variable bytes and never replaces changed variables under the saved approval', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const saved = await f.saved();
    const changed = Buffer.from(JSON.stringify({ private_input: 'PRIVATE_CHANGED_BODY' }));
    await f.workspace.replace(saved.variables.ref, 'inspection', saved.variables.scope, saved.variables.digest, changed);
    changed.fill(0);
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.blocker).toContain('private-artifact-changed');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_CHANGED_BODY');
  });

  it('retains unresolved prior records when encrypted checkpoint data is unreadable and cannot open a replacement', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const input = await f.applyInput(prepared.reviewed!);
    const id = prepared.journalRef!.split('/').at(-1)!;
    f.storage.files.set(id, Buffer.from('DAMAGED_ENCRYPTED_RECORD'));
    const outcome = await f.execute(input);
    expect(outcome).toMatchObject({ status: 'blocked', state: 'unresolved-private-record', journalRef: prepared.journalRef });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    const replacement = await f.execute(await f.issue({ ...f.intent, mode: 'prepare' }));
    expect(replacement.status).toBe('blocked');
  });

  it('does not replay a completed apply and uses inspect for repeat readback', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const input = await f.applyInput(prepared.reviewed!);
    expect((await f.execute(input)).status).toBe('executed');
    const again = await f.execute(input);
    expect(again.blocker).toContain('saved-plan-already-attempted');
    expect(again.state).toBe('published-verified');
    expect((await f.recover('inspect')).status).toBe('inspected');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('inspects original effects without publishing and retains independent resource drift as a recovery conflict', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.stateWrite = true;
    expect((await f.execute(await f.applyInput(prepared.reviewed!))).status).toBe('blocked');
    f.faults.stateWrite = false;
    expect((await f.recover('inspect')).status).toBe('inspected');
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    const rows = JSON.parse(await readFile(f.providerStatePath, 'utf8'));
    rows[registryId].properties.adminUserEnabled = true;
    await writeFile(f.providerStatePath, JSON.stringify(rows));
    const recovered = await f.recover();
    expect(recovered.status).toBe('blocked');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
  });

  it('preserves candidate and original state when a remote state precondition changes during recovery', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.stateWrite = true;
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.status).toBe('blocked');
    f.faults.stateWrite = false;
    f.http().blob.version++;
    const recovered = await f.recover();
    expect(recovered.blocker).toContain('recovery-state-precondition');
    expect(recovered.retainedCandidateRef).toBe(failed.retainedCandidateRef);
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
  });

  it('retains actual failed GET request identities without labeling them mutation IDs', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.malformedResource = true;
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.status).toBe('blocked');
    const failed = outcome.effects.find((effect) => effect.address === f.intent.targets[0]!.address)!;
    expect(failed).toMatchObject({ resourceId: null, mutationRequestId: null, status: 'attempted-uncertain' });
    expect(failed.readbackRequestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await f.journal()).events.some((event) => event.kind === 'resource-observed' &&
      event.details.requestedResourceId === registryId && event.details.readbackRequestId === failed.readbackRequestId)).toBe(true);
    expect(f.http().blob.calls.some((call) => call.method === 'PUT' && call.target === 'blob')).toBe(false);
  });

  it('requires independent private remote state readback even after a successful resource apply and state PUT', async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const backend = f.adapters.backend!;
    let corruptReadback = true;
    f.adapters.backend = (recorder) => {
      const adapter = backend(recorder);
      const blob = f.http().blob, send = blob.send.bind(blob);
      blob.send = async (request) => {
        const response = await send(request);
        if (corruptReadback && blob.operationId && request.method === 'GET' && request.target === 'blob' && response.body.length) {
          response.body[0] = 0;
        }
        return response;
      };
      return adapter;
    };
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed).toMatchObject({ status: 'blocked', state: 'publication-uncertain' });
    expect(failed.blocker).toContain('private-state-publication-readback');
    corruptReadback = false;
    expect((await f.recover()).status).toBe('executed');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it.each(['approval-plan', 'process-unsettled'] as const)('checks the original %s record and never repairs authority or process proof by assumption', async (fault) => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.faults.stateWrite = true;
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.status).toBe('blocked');
    f.faults.stateWrite = false;
    const journal = await f.journal();
    if (fault === 'approval-plan') {
      const original = journal.applyGovernancePlan!;
      original.operations[0]!.inputs.intentDigest = 'a'.repeat(64);
    } else journal.processSettled = false;
    const descriptor = await f.workspace.describe(failed.journalRef!, 'journal', protectedStateScope(f.context));
    const bytes = Buffer.from(JSON.stringify(journal));
    await f.workspace.replace(failed.journalRef!, 'journal', descriptor!.scope, descriptor!.digest, bytes);
    bytes.fill(0);
    const recovered = await f.recover();
    expect(recovered.status).toBe('blocked');
    expect(recovered.blocker).toContain(fault === 'approval-plan' ? 'original-issued-approval-mismatch' : 'original-process-unsettled');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    if (fault === 'process-unsettled') expect((await f.journal()).processSettled).toBe(false);
  });
});

describe('private foundation artifact and actual runtime readback', () => {
  it('does not turn foundation authority into a production rehearsal', async () => {
    const f = await fixture('foundation');
    const production = structuredClone(f.intent);
    production.source.rootPathParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'prod'];
    f.f.inspection.activationInputs!.phases[f.f.phase.id] = { privateExecution: { ...production, mode: 'prepare' } };
    const plan = await planApplicationPrivateExecution(f.f.planning());
    expect(plan.operations).toEqual([]);
    expect(plan.blockers?.[0]).toContain('foundation-is-not-rehearsal-authority');
    expect(await f.audit()).toEqual([]);
  });

  it('executes an exact foundation saved plan and verifies ARM, immutable ACR bytes, runtime health and private remote state', async () => {
    const f = await fixture('foundation');
    vi.stubGlobal('fetch', f.credentialFetch);
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    const input = await f.applyInput(prepared.reviewed!);
    const started = performance.now(), anchor = input.now.getTime();
    input.clock = () => new Date(anchor + performance.now() - started);
    const outcome = await withProjectMutationLock(f.f.projectRoot, (lease) =>
      executeApplicationPrivateExecution({ ...input, lease }, f.adapters));
    expect(outcome, outcome.blocker).toMatchObject({
      status: 'completed', resultState: 'verified',
      evidencePayload: { kind: 'application-foundation.v1', applicationPrivate: {
        status: 'executed', state: 'published-verified', additionalReview: null,
        observations: [{ resourceId: environmentId }, { resourceId: applicationId, runtime: { url: healthUrl, healthy: true } }]
      } }
    });
    expect(outcome.completedOperations).toHaveLength(3);
    expect(outcome.completedOperations?.filter((operation) => operation.actionId === 'azure.application-foundation.apply')).toHaveLength(2);
    expect(outcome.liveReadback).toHaveLength(4);
    expect(outcome.operation).toBeUndefined();
    const payload = {
      ...(outcome.evidencePayload as Record<string, unknown>), planDigest: input.plan.planDigest,
      savedPlanDigest: canonicalSha256(input.plan), outputBindings: outcome.outputs
    };
    const header = evidenceHeaderFor({
      inspection: input.inspection, phase: input.phase, plan: input.plan, result: 'verified',
      now: input.clock(), payload, liveReadback: outcome.liveReadback
    });
    const proof = validateEvidenceFreshness({ evidenceId: 'actual-private-foundation', header, payload, liveReadback: outcome.liveReadback }, {
      ...input.inspection.contexts['application-foundation'], now: input.clock(), reviewedPlans: [input.plan],
      evidenceReferences: [{ phaseId: 'application-foundation', evidenceId: 'actual-private-foundation', headerDigest: evidenceHeaderDigest(header), result: 'verified' }]
    });
    expect(proof.valid, JSON.stringify(proof)).toBe(true);
    expect((await f.audit()).filter((entry) => entry.kind === 'plan')).toHaveLength(1);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('rejects changed/stale upstream artifact evidence before any resource-changing process', async () => {
    const f = await fixture('foundation');
    vi.stubGlobal('fetch', f.credentialFetch);
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    const input = await f.applyInput(prepared.reviewed!);
    (f.f.inspection.evidence[0]!.payload as Record<string, unknown>).sourceCommitSha = 'f'.repeat(40);
    const outcome = await f.execute(input);
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toContain('current-artifact-evidence');
    expect(outcome.journalRef).toBe(prepared.journalRef);
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
  });

  it('requires current actual exact-digest registry bytes rather than merely accepting saved artifact metadata', async () => {
    const f = await fixture('foundation');
    vi.stubGlobal('fetch', f.credentialFetch);
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    f.faults.artifactBytes = true;
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.status).toBe('blocked');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
  });

  it.each(['health', 'runtimeImage', 'runtimeEnvironment', 'runtimeSecret'] as const)('does not call zero-exit apply successful while %s readback is wrong', async (fault) => {
    const f = await fixture('foundation');
    vi.stubGlobal('fetch', f.credentialFetch);
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    f.faults[fault] = true;
    const failed = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(failed.status).toBe('blocked');
    expect(failed.state).toBe('candidate-retained');
    expect(f.http().blob.bytes).toEqual(Uint8Array.from(f.initial));
    expect((await f.journal()).nativeExitCode).toBe(0);
    f.faults[fault] = false;
    const recovered = await f.recover();
    expect(recovered, recovered.blocker).toMatchObject({ status: 'executed', state: 'published-verified', additionalReview: null });
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
  });
});

describe('separately reviewed private prerequisite RBAC', () => {
  it('uses exact observed dependency identities without requiring tags absent from generated source', async () => {
    const f = await fixture('prerequisites-rbac');
    const rows = JSON.parse(await readFile(f.providerStatePath, 'utf8'));
    delete rows[registryId].tags;
    delete rows[identityId].tags;
    await writeFile(f.providerStatePath, JSON.stringify(rows));
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    const outcome = await f.execute(await f.applyInput(prepared.reviewed!));
    expect(outcome.status, outcome.blocker).toBe('executed');
    expect(outcome.observations[0]!.dependencies.map((entry) => entry.resourceId)).toEqual([identityId, registryId]);
  });

  describe('development consumes an actual completed private foundation', () => {
    async function devFixture(includeStaging = false) {
      const f = await fixture('foundation', 'create', undefined, includeStaging);
      let staging: Awaited<ReturnType<typeof fixture>> | undefined;
      let production: Awaited<ReturnType<typeof fixture>> | undefined;
      if (includeStaging) {
        f.f.inspection.state.applicability.privateStagingDast = true;
        Object.assign(f.f.inspection.manifest, parseManifest(currentGovernanceManifest('Activation producer', ['dev', 'staging', 'prod'])));
        await writeFile(path.join(f.f.projectRoot, 'liftoff.manifest.json'), canonicalJson(f.f.inspection.manifest));
        staging = await fixture('foundation', 'create', f.f);
        production = await fixture('foundation', 'create', f.f, false, 'prod');
        Object.assign(f.intent.artifact!, production.intent.artifact);
        Object.assign(staging.intent.artifact!, production.intent.artifact);
      }
      f.f.inspection.state.applicability.privateRunnerRequired = true;
      vi.stubGlobal('fetch', f.credentialFetch);
      const recipe: EnvironmentRuntimeRecipe = {
        workflowPath: '.github/workflows/liftoff-environment-dev.yml', environment: 'dev', resourceId: applicationId,
        fqdn: new URL(healthUrl).hostname, healthPath: '/health', schemaPath: '/openapi.json',
        runner: { group: 'dev-private', label: 'dev-linux' }, uploadArtifactActionSha: 'f'.repeat(40)
      };
      const workflow: WorkflowRunBinding & { producerSourceSha: string } = {
        repository: 'owner/repo', repositoryId: 42, workflowPath: recipe.workflowPath, workflowId: 41,
        workflowDigest: canonicalSha256(renderEnvironmentRuntimeWorkflow(recipe)), sourceSha: f.intent.artifact!.sourceSha,
        producerSourceSha: f.intent.artifact!.sourceSha, ref: 'develop', actorId: 7, event: 'workflow_dispatch',
        expectedJobs: [environmentRuntimeJob], runAttempt: 1
      };
      const runtime = { recipe, imageRef: f.intent.artifact!.imageRef, revisionName: 'application--fixture1' };
      const security = staging ? stagingProducerRecipe({
        ...fixtureBinding, sourceSha: workflow.sourceSha, resourceId: staging.targetIds.applicationId,
        fqdn: new URL(staging.targetIds.healthUrl).hostname, imageDigest: f.intent.artifact!.imageRef.split('@')[1]!
      }) : undefined;
      const sourceFiles = security ? stagingSourceFiles(security) : [];
      for (const file of sourceFiles) {
        await mkdir(path.dirname(path.join(f.f.projectRoot, file.path)), { recursive: true });
        await writeFile(path.join(f.f.projectRoot, file.path), file.content);
      }
      const runnerFixture = await environmentRunnerAssignmentFixture({
        ...f.f.planning(), phase: canonicalPhaseGraph.phases.find((entry) => entry.id === 'runner-ready')!,
        runner: { async run(command) {
          if (command.executable !== 'git') throw new Error('This fixture permits local Git metadata only.');
          return { status: 128, stdout: '', stderr: '', displayCommand: 'isolated Git metadata' };
        } },
        adapters: { githubActivation: { storage: f.f.storage }, azureActivation: { storage: f.f.storage } }
      }, {
        schemaVersion: 1, kind: 'environment-runtime', repository: workflow.repository, repositoryId: workflow.repositoryId,
        workflowId: workflow.workflowId, workflowDigest: workflow.workflowDigest, sourceSha: workflow.producerSourceSha,
        ref: workflow.ref, actorId: workflow.actorId, recipe
      }, security ? [{
        schemaVersion: 1, kind: 'staging-security', repository: security.repository, repositoryId: security.repositoryId,
        workflowId: security.workflowId, workflowDigest: canonicalSha256(renderStagingSecurityWorkflow(security)),
        sourceSha: workflow.sourceSha, ref: security.ref, actorId: security.actorId,
        recipe: { ...security, workflowId: null, sourceSha: null, runner: { group: security.runner.group, label: security.runner.label } }
      }] : []);
      if (security) security.runner.runnerGroupId = runnerFixture.binding.groupId;
      const runnerAssignment = { reference: runnerFixture.reference, binding: runnerFixture.binding };
      const builds: Array<{
        fixture: Awaited<ReturnType<typeof applicationArtifactFixture>>;
        reference: { evidenceId: string; headerDigest: string; bodyDigest: string };
      }> = [];
      if (includeStaging) {
        for (const [index, sourceSha] of ['a'.repeat(40), 'b'.repeat(40)].entries()) {
          const build = await applicationArtifactFixture({
            sourceSha, runId: 100 + index * 100, ref: index === 0 ? 'release/baseline' : 'develop',
            existing: async (configuration, runner) => {
              f.f.inspection.activationInputs!.phases['application-artifact-ready'] = configuration.phases['application-artifact-ready'];
              const before = [...f.f.inspection.approvals];
              const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')!;
              const planned = planApplicationArtifactReady({ ...f.f.planning(), phase });
              const input = await f.f.execution(planned, { phaseId: phase.id });
              f.f.inspection.approvals = [...before, ...f.f.inspection.approvals];
              input.runner = runner;
              return {
                root: f.f.root, projectRoot: f.f.projectRoot, home: f.f.home, storage: f.f.storage, input,
                envelope: f.f.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId)!,
                cleanup: f.f.cleanup
              };
            }
          });
          vi.stubGlobal('fetch', build.fetch);
          const actual = await build.execute();
          expect(actual.status, actual.blocker).toBe('completed');
          const payload = { ...actual.evidencePayload as Record<string, unknown>, planDigest: build.input.plan.planDigest,
            savedPlanDigest: canonicalSha256(build.input.plan), outputBindings: actual.outputs };
          const header = evidenceHeaderFor({ inspection: f.f.inspection, phase: build.input.phase, plan: build.input.plan,
            result: 'verified', now: f.f.now, payload, liveReadback: actual.liveReadback });
          const reference = { evidenceId: randomUUID(), headerDigest: evidenceHeaderDigest(header), bodyDigest: header.bodyDigest };
          f.f.inspection.evidence.push({ evidenceId: reference.evidenceId, header, payload, liveReadback: actual.liveReadback });
          const context = f.f.inspection.contexts['application-artifact-ready'];
          context.reviewedPlans = [...context.reviewedPlans ?? [], build.input.plan];
          const refs = [{ phaseId: 'application-artifact-ready' as const, evidenceId: reference.evidenceId,
            headerDigest: reference.headerDigest, result: 'verified' as const }];
          f.f.inspection.state.phases['application-artifact-ready'].evidence = refs;
          context.evidenceReferences = refs;
          f.f.inspection.state.phaseOutputs!['application-artifact-ready'] = actual.outputs!;
          builds.push({ fixture: build, reference });
        }
        const current = builds[1]!;
        for (const intent of [f.intent, staging!.intent, production!.intent]) Object.assign(intent.artifact!, {
          evidenceId: current.reference.evidenceId, headerDigest: current.reference.headerDigest
        });
        vi.stubGlobal('fetch', f.credentialFetch);
      }
      const prepared = await f.prepare();
      expect(prepared.status, prepared.blocker).toBe('prepared');
      const original = await f.applyInput(prepared.reviewed!);
      const start = performance.now(), anchor = original.now.getTime();
      original.clock = () => new Date(anchor + performance.now() - start);
      const outcome = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeApplicationPrivateExecution({ ...original, lease }, f.adapters));
      expect(outcome.status, outcome.blocker).toBe('completed');
      const payload = { ...outcome.evidencePayload as Record<string, unknown>, planDigest: original.plan.planDigest,
        savedPlanDigest: canonicalSha256(original.plan), outputBindings: outcome.outputs };
      const producedAt = original.clock();
      f.f.now.setTime(producedAt.getTime());
      const header = evidenceHeaderFor({
        inspection: original.inspection, phase: original.phase, plan: original.plan, result: 'verified',
        now: producedAt, payload, liveReadback: outcome.liveReadback
      });
      const record = { evidenceId: randomUUID(), header, payload, liveReadback: outcome.liveReadback };
      const reference = { evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(header), bodyDigest: header.bodyDigest };
      const stateReference = { phaseId: original.phase.id, evidenceId: record.evidenceId, headerDigest: reference.headerDigest,
        result: 'verified' as const, producedAt: header.producedAt, pathParts: ['governance', 'evidence', `${record.evidenceId}.json`] };
      f.f.inspection.evidence.push(record);
      f.f.inspection.state.phases['application-foundation'] = {
        ...f.f.inspection.state.phases['application-foundation'], state: 'verified', evidence: [{
          phaseId: stateReference.phaseId, evidenceId: stateReference.evidenceId,
          headerDigest: stateReference.headerDigest, result: stateReference.result
        }]
      };
      f.f.inspection.state.phaseOutputs = { ...f.f.inspection.state.phaseOutputs, 'application-foundation': outcome.outputs! };
      f.f.inspection.contexts['application-foundation'] = {
        ...f.f.inspection.contexts['application-foundation'], reviewedPlans: [original.plan], evidenceReferences: [stateReference]
      };
      const target: DisposableTargetConfig = {
        authorityKind: 'disposable-operator-qualification',
        target: { environment: 'dev', subscriptionId: fixtureBinding.subscriptionId, tenantId: fixtureBinding.tenantId,
          resourceGroup: 'rg-app', appName: 'application', resourceId: applicationId },
        actor: { operator: 'isolated-fixture-operator', githubActorId: 7, azurePrincipalId: fixtureBinding.principalId },
        spendCeilingCents: 100, maxDurationMinutes: 15,
        permittedEffects: ['github-read', 'github-workflow-dispatch', 'azure-read', 'backend-state-read'],
        notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z'
      };
      const dispatchInputs = { qualification_digest: canonicalSha256({ workflow, disposableTarget: target, runnerAssignment, runtime }) };
      f.f.inspection.activationInputs!.phases['dev-proof'] = {
        disposableTarget: target, foundation: reference, observation: { workflow, runtime, runnerAssignment, dispatchInputs }
      };
      const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'dev-proof')!;
      const plan = await planProductionDevProof({ ...f.f.planning(), phase });
      expect(plan.blockers).toBeUndefined();
      const input = await f.f.execution(plan, { phaseId: 'dev-proof' });
      f.f.inspection.approvals = [...builds.map((build) => build.fixture.envelope), ...f.f.inspection.approvals];
      input.runner = original.runner;
      const protocol = new EnvironmentWorkflowProtocol(recipe, workflow, runtime.imageRef, runtime.revisionName,
        () => f.f.now, fixtureBinding.principalId);
      protocol.runnerFixture = runnerFixture;
      protocol.runner.groupId = runnerFixture.binding.groupId;
      protocol.runner.groupName = runnerFixture.binding.runnerGroupName;
      protocol.runner.labels = [runnerFixture.binding.runnerName];
      const arm = original.adapters.azureActivation!.transport!;
      input.adapters.githubActivation = { storage: f.f.storage, transport: protocol };
      input.adapters.azureActivation!.transport = { request: (request, binding) =>
        request.resourceId.includes('/revisions/') ? protocol.arm.request(request, binding) : arm.request(request, binding) };
      const execute = () => withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeProductionDevProof({ ...input, lease }, f.adapters));
      return { f, input, execute, protocol, record, staging, security, sourceFiles, runnerFixture, builds, production };
    }

    it('reads the original private approval/state and runs a source-bound dev observation without another deployment', async () => {
      const { f, input, execute, protocol, record } = await devFixture();
      const originalJournal = await f.journal();
      const originalRecord = structuredClone(record);
      const result = await execute();
      expect(result, result.blocker).toMatchObject({ status: 'completed', resultState: 'verified', evidencePayload: {
        kind: 'dev-proof.v1', foundation: { kind: 'completed-private-application-receipt.v1' },
        runtimeObservation: { kind: 'environment-runtime-observation.v1' }
      } });
      expect(result.completedOperations).toEqual(input.plan.operations);
      expect(protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
      expect(f.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
      expect(await f.journal()).toEqual(originalJournal);
      expect(record).toEqual(originalRecord);
      const body = { ...result.evidencePayload as Record<string, unknown>, planDigest: input.plan.planDigest,
        savedPlanDigest: canonicalSha256(input.plan), outputBindings: result.outputs };
      const header = evidenceHeaderFor({ inspection: input.inspection, phase: input.phase, plan: input.plan,
        result: 'verified', now: f.f.now, payload: body, liveReadback: result.liveReadback });
      const proof = validateEvidenceFreshness({ evidenceId: 'actual-dev-proof', header, payload: body, liveReadback: result.liveReadback }, {
        ...input.inspection.contexts['dev-proof'], now: f.f.now, reviewedPlans: [input.plan],
        evidenceReferences: [{ phaseId: 'dev-proof', evidenceId: 'actual-dev-proof', headerDigest: evidenceHeaderDigest(header), result: 'verified' }]
      });
      expect(proof.valid, JSON.stringify(proof)).toBe(true);
    });

    it('refuses changed actual private state before dispatch and preserves the original proof', async () => {
      const { f, execute, protocol, record } = await devFixture();
      const original = structuredClone(record);
      f.http().blob.bytes![0] = 0;
      const result = await execute();
      expect(result.status).toBe('blocked');
      expect(protocol.requests.filter((request) => request.method === 'POST')).toEqual([]);
      expect(record).toEqual(original);
      expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    });

    it('retains an unknown actual dev dispatch and recovers by its correlation without another apply or dispatch', async () => {
      const { f, execute, protocol } = await devFixture();
      protocol.loseDispatchResponse = true;
      expect((await execute()).status).toBe('blocked');
      const result = await execute();
      expect(result.status, result.blocker).toBe('completed');
      expect(protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
    });

    async function stagingFixture() {
      const { f, input: devInput, execute, protocol, staging, security, sourceFiles, runnerFixture, builds, production } = await devFixture(true);
      if (!staging || !security) throw new Error('The distinct staging fixture was not constructed.');
      const outcome = await execute();
      expect(outcome.status, outcome.blocker).toBe('completed');
      const inspection = f.f.inspection;
      const body = { ...outcome.evidencePayload as Record<string, unknown>, planDigest: devInput.plan.planDigest,
        savedPlanDigest: canonicalSha256(devInput.plan), outputBindings: outcome.outputs };
      const header = evidenceHeaderFor({ inspection, phase: devInput.phase, plan: devInput.plan,
        result: 'verified', now: f.f.now, payload: body, liveReadback: outcome.liveReadback });
      const dev = { evidenceId: randomUUID(), headerDigest: evidenceHeaderDigest(header), bodyDigest: header.bodyDigest };
      inspection.evidence.push({ evidenceId: dev.evidenceId, header, payload: body, liveReadback: outcome.liveReadback });
      inspection.state.phases['dev-proof'].state = 'verified';
      inspection.state.phases['dev-proof'].evidence = [{
        phaseId: 'dev-proof', evidenceId: dev.evidenceId, headerDigest: dev.headerDigest, result: 'verified'
      }];
      inspection.contexts['dev-proof'].evidenceReferences = inspection.state.phases['dev-proof'].evidence;
      inspection.contexts['dev-proof'].reviewedPlans = [devInput.plan];
      const originalApprovals = [...inspection.approvals];
      const target: DisposableTargetConfig = {
        authorityKind: 'disposable-operator-qualification',
        target: { environment: 'staging', subscriptionId: fixtureBinding.subscriptionId, tenantId: fixtureBinding.tenantId,
          resourceGroup: staging.targetIds.groupName,
          appName: 'application', resourceId: staging.targetIds.applicationId },
        actor: { operator: 'isolated-fixture-operator', githubActorId: 7, azurePrincipalId: fixtureBinding.principalId },
        spendCeilingCents: 100, maxDurationMinutes: 15, permittedEffects: ['github-read', 'azure-read', 'backend-state-read', 'backend-state-write'],
        notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z'
      };
      const issue = async (privateExecution: ApplicationPrivateConfiguration, qualification: Record<string, unknown> = {
        stage: 'deploy', dev, deployment: null, security: null, source: null, runner: null
      }) => {
        inspection.activationInputs!.phases['staging-qualified'] = {
          privateExecution, disposableTarget: target, qualification
        };
        let plan = await planProductionStaging(staging.f.planning());
        expect(plan.blockers, plan.blockers?.join(' ')).toBeUndefined();
        target.permittedEffects = [...new Set(plan.operations.flatMap((op) => [op, ...(op.effects ?? [])])
          .filter((op) => op.remote).map((op) => op.mutationClass))];
        plan = await planProductionStaging(staging.f.planning());
        const current = await staging.f.execution(plan);
        inspection.approvals = [...originalApprovals, ...inspection.approvals];
        current.runner = devInput.runner;
        current.adapters.githubActivation = { transport: protocol, storage: f.f.storage };
        current.adapters.azureActivation!.transport = staging.arm;
        return current;
      };
      const preparation = await issue({ ...staging.intent, mode: 'prepare' });
      const prepared = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeProductionStaging({ ...preparation, lease }, staging.adapters));
      expect(prepared.status, prepared.blocker).toBe('review-required');
      const review = (prepared.review?.payload.result as ApplicationPrivateResult).reviewed!;
      originalApprovals.push(...inspection.approvals.filter((entry) => !originalApprovals.some((saved) => saved.id === entry.id)));
      const application = await issue({ ...staging.intent, mode: 'apply', reviewed: review });
      const applied = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeProductionStaging({ ...application, lease }, staging.adapters));
      expect(applied.status, applied.blocker).toBe('review-required');
      expect(applied.review?.payload).toMatchObject({ stage: 'staging-deployed', result: { status: 'executed' } });
      expect(applied).not.toHaveProperty('resultState', 'verified');
      const stored = await withProjectMutationLock(f.f.projectRoot, () =>
        storePhaseReview(inspection, application.plan, applied, f.f.now, f.f.storage));
      inspection.contexts['staging-qualified'].reviewedPlans = [preparation.plan, application.plan];
      const stageProtocol = new StagingProducerProtocol(security, () => f.f.now);
      stageProtocol.runnerFixture = runnerFixture;
      stageProtocol.runner = { ...protocol.runner };
      const transport: GitHubActivationTransport = { async request(request) {
        const endpoint = new URL(request.path, 'https://api.github.com').pathname;
        const response = (data: unknown) => ({ status: 200, headers: { 'x-github-request-id': 'ABCD:1234:5678:0001' }, data });
        if (request.method === 'GET') {
          if (endpoint === '/user') return response({ id: 7, login: 'owner', type: 'User' });
          if (endpoint === '/repos/owner/repo') return response({
            id: 42, full_name: 'owner/repo', default_branch: 'develop', archived: false, disabled: false,
            private: true, owner: { id: 7, login: 'owner', type: 'Organization' }
          });
          if (endpoint === '/repos/owner/repo/git/ref/heads/develop') return response({
            ref: 'refs/heads/develop', object: { type: 'commit', sha: security.sourceSha }
          });
          const file = sourceFiles.find((entry) => endpoint === `/repos/owner/repo/contents/${entry.path}`);
          if (file) return response({
            type: 'file', path: file.path, encoding: 'base64', content: Buffer.from(file.content).toString('base64'),
            size: Buffer.byteLength(file.content),
            sha: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0${file.content}`).digest('hex')
          });
          if (endpoint === `/repos/owner/repo/actions/workflows/${security.workflowPath.split('/').at(-1)}`) {
            return response({ id: security.workflowId, path: security.workflowPath, state: 'active' });
          }
        }
        if (endpoint.includes(`/workflows/${stageProtocol.workflow.workflowId}`) ||
          endpoint.includes(`/runs/${stageProtocol.runId}`) || endpoint.includes(`/artifacts/${stageProtocol.artifactId}`) ||
          endpoint.includes(`/check-runs/${stageProtocol.checkId}`)) return stageProtocol.request(request);
        return protocol.request(request);
      } };
      const sourcePhase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'workflow-source-ready')!;
      inspection.activationInputs!.phases['workflow-source-ready'] = { sourceSha: security.sourceSha, paths: sourceFiles.map((file) => file.path) };
      const sourcePlan = await planRepositoryWorkflowSource({
        ...f.f.planning(), phase: sourcePhase, adapters: { githubActivation: { storage: f.f.storage, transport } }
      });
      expect(sourcePlan.blockers, sourcePlan.blockers?.join(' ')).toBeUndefined();
      originalApprovals.push(...inspection.approvals.filter((entry) => !originalApprovals.some((saved) => saved.id === entry.id)));
      const sourceInput = await f.f.execution(sourcePlan, { phaseId: 'workflow-source-ready' });
      sourceInput.adapters.githubActivation = { storage: f.f.storage, transport };
      inspection.approvals = [...originalApprovals, ...inspection.approvals];
      const sourceOutcome = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeRepositoryWorkflowSource({ ...sourceInput, lease }));
      expect(sourceOutcome.status, sourceOutcome.blocker).toBe('completed');
      const sourcePayload = { ...sourceOutcome.evidencePayload as Record<string, unknown>,
        planDigest: sourceInput.plan.planDigest, savedPlanDigest: canonicalSha256(sourceInput.plan), outputBindings: sourceOutcome.outputs };
      const sourceHeader = evidenceHeaderFor({ inspection, phase: sourcePhase, plan: sourceInput.plan,
        result: 'verified', now: f.f.now, payload: sourcePayload, liveReadback: sourceOutcome.liveReadback });
      const source = { evidenceId: randomUUID(), headerDigest: evidenceHeaderDigest(sourceHeader), bodyDigest: sourceHeader.bodyDigest };
      inspection.evidence.push({ evidenceId: source.evidenceId, header: sourceHeader, payload: sourcePayload, liveReadback: sourceOutcome.liveReadback });
      inspection.state.phases['workflow-source-ready'].state = 'verified';
      inspection.state.phases['workflow-source-ready'].evidence = [{
        phaseId: 'workflow-source-ready', evidenceId: source.evidenceId, headerDigest: source.headerDigest, result: 'verified'
      }];
      inspection.contexts['workflow-source-ready'].reviewedPlans = [sourceInput.plan];
      inspection.contexts['workflow-source-ready'].evidenceReferences = inspection.state.phases['workflow-source-ready'].evidence;
      originalApprovals.push(...inspection.approvals.filter((entry) => !originalApprovals.some((saved) => saved.id === entry.id)));
      const actual = applied.review!.payload.result as ApplicationPrivateResult;
      const verification = await issue({
        ...staging.intent, mode: 'recover', recovery: 'inspect', reviewed: actual.reviewed!,
        checkpoint: { transactionId: actual.transactionId!, journalRef: actual.journalRef! },
        candidateRef: actual.retainedCandidateRef ?? null,
        recoveryWindow: { notBefore: fixtureTime.toISOString(), expiresAt: target.expiresAt, releaseUntil: staging.intent.releaseUntil }
      }, {
        stage: 'verify', dev, deployment: { sourcePlanDigest: application.plan.planDigest, reviewDigest: canonicalSha256(stored) },
        source, runner: runnerFixture.reference, security
      });
      verification.adapters.githubActivation = { storage: f.f.storage, transport };
      verification.adapters.azureActivation!.transport = { request: (request, binding) =>
        request.resourceId.includes('/revisions/') ? stageProtocol.arm.request(request, binding) : staging.arm.request(request, binding) };
      stageProtocol.pending = true;
      const pending = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeProductionStaging({ ...verification, lease }, staging.adapters));
      expect(pending.status, pending.blocker).toBe('pending');
      inspection.state.phases['staging-qualified'].operation = pending.operation;
      inspection.state.phases['staging-qualified'].executionPlanDigest = verification.plan.planDigest;
      stageProtocol.pending = false;
      const qualified = await withProjectMutationLock(f.f.projectRoot, (lease) =>
        executeProductionStaging({ ...verification, lease }, staging.adapters));
      expect(qualified.status, qualified.blocker).toBe('completed');
      expect(qualified.evidencePayload).toMatchObject({ kind: 'staging-qualified.v1', nativeWitness: { recordKey: expect.any(String) } });
      const qualifiedBody = { ...qualified.evidencePayload as Record<string, unknown>, planDigest: verification.plan.planDigest,
        savedPlanDigest: canonicalSha256(verification.plan), outputBindings: qualified.outputs };
      const qualifiedHeader = evidenceHeaderFor({ inspection, phase: verification.phase, plan: verification.plan,
        result: 'verified', now: f.f.now, payload: qualifiedBody, liveReadback: qualified.liveReadback });
      const reference = { evidenceId: randomUUID(), headerDigest: evidenceHeaderDigest(qualifiedHeader), bodyDigest: qualifiedHeader.bodyDigest };
      inspection.evidence.push({ evidenceId: reference.evidenceId, header: qualifiedHeader, payload: qualifiedBody, liveReadback: qualified.liveReadback });
      const state = inspection.state.phases['staging-qualified'];
      state.state = 'verified';
      state.evidence = [{ phaseId: 'staging-qualified', evidenceId: reference.evidenceId,
        headerDigest: reference.headerDigest, result: 'verified' }];
      delete state.operation;
      inspection.contexts['staging-qualified'].evidenceReferences = state.evidence;
      inspection.contexts['staging-qualified'].reviewedPlans!.push(verification.plan);
      await readVerifiedStagingQualification(verification, new GitHubActivationClient(transport), reference);
      expect(stageProtocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      expect((await staging.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
      expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
      expect(protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      return { f, production: production!, builds, inspection, transport, verification, reference };
    }

    it('executes separately reviewed staging deployment, pending security recovery and original witness readback through production producers', async () => {
      await stagingFixture();
    }, 90_000);

    it('performs real privately checkpointed rollout and separate rollback through the production rehearsal coordinator', async () => {
      const s = await stagingFixture();
      const { production: p, inspection, builds } = s;
      vi.stubGlobal('fetch', p.credentialFetch);
      const producer = createApplicationRehearsalComponent({ executeApplicationPrivatePlan }, p.adapters);
      const artifact = (index: number): ApplicationRehearsalArtifact => ({
        evidence: builds[index]!.reference, imageRef: builds[index]!.fixture.report.image.loginServer + '/team/app@' + builds[index]!.fixture.imageDigest,
        sourceSha: builds[index]!.fixture.config.workflow.sourceSha, registryResourceId: registryId
      });
      const baseline = artifact(0), candidate = artifact(1);
      const target: DisposableTargetConfig = {
        authorityKind: 'disposable-operator-qualification',
        target: { environment: 'prod', subscriptionId: fixtureBinding.subscriptionId, tenantId: fixtureBinding.tenantId,
          resourceGroup: p.targetIds.groupName, appName: 'application', resourceId: p.targetIds.applicationId },
        actor: { operator: 'isolated-fixture-operator', githubActorId: 7, azurePrincipalId: fixtureBinding.principalId },
        spendCeilingCents: 100, maxDurationMinutes: 15, permittedEffects: ['github-read', 'azure-read', 'backend-state-read', 'backend-state-write'],
        notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z'
      };
      const rehearsal: ApplicationRehearsalInputs['rehearsal'] = {
        stage: 'rollout', staging: s.reference, baseline: { artifact: baseline, revisionName: 'application--baseline',
          workloadIdentity: { resourceId: identityId, principalId: p.identity.properties.principalId,
            clientId: p.identity.properties.clientId, tenantId: fixtureBinding.tenantId } },
        candidate, rolloutReview: null, rollbackReview: null
      };
      const allApprovals = [...inspection.approvals];
      const providerCalls: string[] = [];
      const arm: AzureArmTransport = { async request(request, binding) {
        providerCalls.push(`ARM ${request.method} ${request.resourceId}`);
        if (request.method === 'GET' && (request.resourceId === `${p.targetIds.applicationId}/revisions` ||
          request.resourceId.startsWith(`${p.targetIds.applicationId}/revisions/`))) {
          const rows = JSON.parse(await readFile(p.providerStatePath, 'utf8'));
          if (request.resourceId.endsWith('/revisions')) return {
            status: 200, requestId: randomUUID(), data: { value: Object.entries(rows)
              .filter(([key]) => key.startsWith(`${p.targetIds.applicationId}/revisions/`)).map(([, value]) => value) }
          };
          return { status: rows[request.resourceId] ? 200 : 404, requestId: randomUUID(), data: rows[request.resourceId] };
        }
        return p.arm.request(request, binding);
      } };
      const github: GitHubActivationTransport = { async request(request) {
        providerCalls.push(`GitHub ${request.method} ${request.path}`);
        const url = new URL(request.path, 'https://api.github.com');
        const build = builds.find(({ fixture }) => {
          const id = fixture.report.producer.runId;
          return url.pathname.includes(`/runs/${id}`) || url.pathname.includes(`/check-runs/${id * 100}`) ||
            url.pathname.includes(`/artifacts/${fixture.artifact.metadata.id}`) ||
            url.pathname.endsWith(`/git/commits/${fixture.config.workflow.sourceSha}`) ||
            url.pathname === `/repos/owner/repo/git/ref/heads/${fixture.config.workflow.ref}` ||
            url.pathname.includes(`/contents/${fixture.config.workflow.workflowPath}`) &&
              url.searchParams.get('ref') === fixture.config.workflow.sourceSha;
        });
        if (build) return build.fixture.github.request(request);
        if (url.pathname === '/repos/owner/repo/actions/workflows/4') return builds[1]!.fixture.github.request(request);
        return s.transport.request(request);
      } };
      const run = async (privateExecution: ApplicationRehearsalPrivateConfiguration, expectedBlocked = false) => {
        p.f.now.setTime(p.f.now.getTime() + 30_000);
        inspection.activationInputs!.phases['production-rehearsed'] = { privateExecution, disposableTarget: target, rehearsal };
        let plan = await producer.plan(p.f.planning());
        expect(plan.blockers, plan.blockers?.join(' ')).toBeUndefined();
        target.permittedEffects = [...new Set(plan.operations.flatMap((op) => [op, ...(op.effects ?? [])])
          .filter((op) => op.remote).map((op) => op.mutationClass))];
        plan = await producer.plan(p.f.planning());
        if (rehearsal.stage === 'verify') {
          await p.f.execution(plan, { recovery: true });
          allApprovals.push(...inspection.approvals);
          p.f.now.setTime(p.f.now.getTime() + 1);
        }
        const input = await p.f.execution(plan, { recovery: privateExecution.mode === 'recover' });
        allApprovals.push(...inspection.approvals);
        inspection.approvals = [...new Map(allApprovals.map((entry) => [entry.id, entry])).values()];
        input.runner = s.verification.runner;
        input.adapters.githubActivation = { transport: github, storage: p.f.storage };
        input.adapters.azureActivation!.transport = arm;
        const started = performance.now(), anchor = input.now.getTime();
        input.clock = () => new Date(anchor + performance.now() - started);
        const outcome = await withProjectMutationLock(p.f.projectRoot, (lease) => producer.execute({ ...input, lease }));
        p.f.now.setTime(input.clock().getTime());
        expect(expectedBlocked ? ['blocked'] : ['review-required', 'completed'],
          `${outcome.blocker}; ${providerCalls.slice(-6).join('; ')}`).toContain(outcome.status);
        inspection.contexts['production-rehearsed'].reviewedPlans = [
          ...inspection.contexts['production-rehearsed'].reviewedPlans ?? [], input.plan
        ];
        if (outcome.review) await withProjectMutationLock(p.f.projectRoot, () =>
          storePhaseReview(inspection, input.plan, outcome, p.f.now, p.f.storage));
        return { input, outcome };
      };
      const rollout = { ...p.intent, scope: 'rehearsal-rollout' as const, artifact: rehearsalPrivateArtifact(candidate), mode: 'prepare' as const };
      const prepared = await run(rollout);
      const rolloutReview = prepared.outcome.review!;
      rehearsal.rolloutReview = { sourcePlanDigest: prepared.input.plan.planDigest, reviewDigest: canonicalSha256(rolloutReview) };
      const originalRolloutReview = rolloutReview.payload.reviewed as ApplicationPrivateReview;
      await p.control({ revisionName: 'application--promoted', applyFault: 'unknown-response' });
      const uncertain = await run({ ...rollout, mode: 'apply', reviewed: originalRolloutReview }, true);
      const retained = (uncertain.outcome.evidencePayload as { applicationPrivate: ApplicationPrivateResult }).applicationPrivate;
      expect(retained).toMatchObject({ status: 'blocked', state: 'candidate-retained' });
      expect((await p.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(1);
      await p.control({ revisionName: 'application--promoted' });
      const promoted = await run({
        ...rollout, mode: 'recover', recovery: 'publish-retained', reviewed: originalRolloutReview,
        checkpoint: { transactionId: retained.transactionId!, journalRef: retained.journalRef! },
        candidateRef: retained.retainedCandidateRef!,
        recoveryWindow: { notBefore: fixtureTime.toISOString(), expiresAt: target.expiresAt, releaseUntil: p.intent.releaseUntil }
      });
      expect(promoted.outcome).not.toHaveProperty('resultState', 'verified');
      rehearsal.rolloutReview = { sourcePlanDigest: promoted.input.plan.planDigest, reviewDigest: canonicalSha256(promoted.outcome.review) };
      rehearsal.stage = 'rollback';
      const variableId = randomUUID();
      await p.workspace.put('inspection', protectedStateScope(p.context),
        Buffer.from(JSON.stringify({ private_input: variableSecret, application_image: baseline.imageRef })), variableId);
      const rollback = {
        ...rollout, scope: 'rehearsal-rollback' as const, artifact: rehearsalPrivateArtifact(baseline),
        source: { ...p.intent.source, variablesRef: `${p.workspace.workspaceRef}/${variableId}` },
        targets: [{ ...p.intent.targets[0]!, expected: { ...p.intent.targets[0]!.expected, 'template.0.container.0.image': baseline.imageRef } }]
      };
      const rollbackPrepared = await run(rollback);
      rehearsal.rollbackReview = { sourcePlanDigest: rollbackPrepared.input.plan.planDigest, reviewDigest: canonicalSha256(rollbackPrepared.outcome.review) };
      await p.control({ revisionName: 'application--restored' });
      const rollbackPrivateReview = rollbackPrepared.outcome.review!.payload.reviewed as ApplicationPrivateReview;
      const restored = await run({ ...rollback, mode: 'apply', reviewed: rollbackPrivateReview });
      rehearsal.rollbackReview = { sourcePlanDigest: restored.input.plan.planDigest, reviewDigest: canonicalSha256(restored.outcome.review) };
      rehearsal.stage = 'verify';
      const verified = await run({
        ...rollback, mode: 'recover', recovery: 'inspect', reviewed: rollbackPrivateReview,
        checkpoint: { journalRef: rollbackPrivateReview.journalRef, transactionId: rollbackPrivateReview.transactionId },
        candidateRef: null,
        recoveryWindow: { notBefore: fixtureTime.toISOString(), expiresAt: target.expiresAt, releaseUntil: p.intent.releaseUntil }
      });
      expect(verified.outcome).toMatchObject({ status: 'completed', resultState: 'verified',
        evidencePayload: { kind: 'production-rehearsed.v1', applicationRehearsal: { originalConfigurationRestored: true,
          originalStateOwnershipRestored: true, atomicAcrossProviders: false } } });
      const payload = { ...verified.outcome.evidencePayload as Record<string, unknown>, planDigest: verified.input.plan.planDigest,
        savedPlanDigest: canonicalSha256(verified.input.plan), outputBindings: verified.outcome.outputs };
      const header = evidenceHeaderFor({ inspection, phase: verified.input.phase, plan: verified.input.plan,
        result: 'verified', now: p.f.now, payload, liveReadback: verified.outcome.liveReadback });
      const reference = { evidenceId: randomUUID(), headerDigest: evidenceHeaderDigest(header), bodyDigest: header.bodyDigest };
      inspection.evidence.push({ evidenceId: reference.evidenceId, header, payload, liveReadback: verified.outcome.liveReadback });
      const state = inspection.state.phases['production-rehearsed'];
      state.state = 'verified';
      state.evidence = [{ phaseId: 'production-rehearsed', evidenceId: reference.evidenceId,
        headerDigest: reference.headerDigest, result: 'verified' }];
      inspection.contexts['production-rehearsed'].evidenceReferences = state.evidence;
      const fullChecks = {
        inspection, phase: canonicalPhaseGraph.phases.find((entry) => entry.id === 'green-red-proof')!,
        runner: verified.input.runner, adapters: verified.input.adapters, now: p.f.now
      };
      const consumed = await fullProductionPredecessorVerifier(fullChecks)({
        staging: s.reference, rehearsal: reference, sourceSha: candidate.sourceSha, artifactDigest: builds[1]!.fixture.imageDigest
      });
      expect(consumed).toMatchObject({
        sourceSha: candidate.sourceSha, artifactDigest: builds[1]!.fixture.imageDigest,
        staging: { evidenceId: s.reference.evidenceId }, rehearsal: { evidenceId: reference.evidenceId }
      });
      await expect(fullProductionPredecessorVerifier({ ...fullChecks, inspection: { ...inspection, scope: 'repository' } })({
        staging: s.reference, rehearsal: reference, sourceSha: candidate.sourceSha, artifactDigest: builds[1]!.fixture.imageDigest
      })).rejects.toThrow(/activation scope/u);
      expect((await p.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(2);
      expect(p.http().blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(2);
    }, 120_000);
  });

  it('executes only exact known assignee/scope/role IDs and returns independently observed dependencies', async () => {
    const f = await fixture('prerequisites-rbac');
    const prepared = await f.prepare();
    expect(prepared.status, prepared.blocker).toBe('prepared');
    const input = await f.applyInput(prepared.reviewed!);
    const outcome = await withProjectMutationLock(f.f.projectRoot, (lease) =>
      executeApplicationPrivateExecution({ ...input, lease }, f.adapters));
    expect(outcome, outcome.blocker).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome.completedOperations).toHaveLength(2);
    expect(outcome.liveReadback?.map((entry) => entry.resourceId)).toEqual([f.intent.targets[0]!.resourceId, identityId, registryId]);
    const row = JSON.parse(await readFile(f.providerStatePath, 'utf8'))[f.intent.targets[0]!.resourceId];
    expect(row.properties.principalId).toBe(f.intent.targets[0]!.role!.principalId);
    expect(row.properties.principalId).not.toBe(fixtureBinding.principalId);
    expect(outcome.operation).toBeUndefined();
  });

  it('blocks provider-generated/unknown principals until another exact plan can be reviewed', async () => {
    const f = await fixture('prerequisites-rbac');
    await f.control({ planFault: 'unknown-principal' });
    const outcome = await f.prepare();
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toContain('unknown-effect-requires-additional-plan');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
    expect(f.http().blob.calls.some((call) => call.method === 'PUT' && call.target === 'blob')).toBe(false);
  });

  it('refuses role changes on an unowned registry despite matching names and valid actor credentials', async () => {
    const f = await fixture('prerequisites-rbac');
    const rows = JSON.parse(await readFile(f.providerStatePath, 'utf8'));
    rows[registryId].tags['liftoff-repository-id'] = 'another-project';
    await writeFile(f.providerStatePath, JSON.stringify(rows));
    const outcome = await f.prepare();
    expect(outcome.blocker).toContain('dependency-ownership');
    expect((await f.audit()).filter((entry) => entry.kind === 'apply')).toHaveLength(0);
  });
});
