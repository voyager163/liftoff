import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACR_API_VERSION, AzureApplicationProvisioningClient, acrPullRoleDefinitionId,
  containerAppResourceId, managedIdentityResourceId, roleAssignmentResourceId,
  inspectApplicationPrerequisiteResources, inspectApplicationFoundationResources,
  validateApplicationPrerequisitesConfig, validateApplicationFoundationConfig, parseApplicationImageReference,
  deterministicRoleAssignmentUuid
} from '../src/adapters/azure/application-provisioning.js';
import type { AzureArmBinding, AzureArmResponse, AzureArmTransport } from '../src/adapters/azure/activation-rest.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import {
  executeApplicationPrerequisites, planApplicationPrerequisites
} from '../src/application/azure-activation/producer-prerequisites.js';
import {
  executeApplicationFoundation, planApplicationFoundation
} from '../src/application/azure-activation/producer-foundation.js';
import { ApplicationPrivateError } from '../src/application/azure-activation/application-private-errors.js';
import type { ActivationConfiguration, TransitionOperation } from '../src/domain/governance/activation/types.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity, phaseContractDigests
} from '../src/domain/governance/activation/graph.js';
import { applicationSubscription, applicationTenant, applicationPrincipal, applicationRegistryId } from './helpers/application-artifact-fixture.js';

const binding: AzureArmBinding = {
  subscriptionId: applicationSubscription, tenantId: applicationTenant, principalId: applicationPrincipal
};
const workloadPrincipal = '99999999-2222-4333-8444-555555555557';
const workloadClient = '99999999-2222-4333-8444-555555555556';
const roleName = 'bbbbbbbb-2222-4333-8444-555555555558';
const prerequisites = {
  ...binding, region: 'eastus', resourceGroup: 'rg-app', acrName: 'crliftoff',
  identityName: 'id-application', identityPrincipalId: workloadPrincipal, identityClientId: workloadClient,
  roleAssignmentName: roleName
};
const foundation = {
  ...binding, region: 'eastus', resourceGroup: 'rg-app', appName: 'application',
  environmentName: 'application-environment', expectedDigest: `sha256:${'a'.repeat(64)}`,
  imageRef: `crliftoff.azurecr.io/team/app@sha256:${'a'.repeat(64)}`,
  identityResourceId: managedIdentityResourceId(applicationSubscription, 'rg-app', 'id-application')
};
const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

function registry() {
  return {
    id: applicationRegistryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
    properties: { loginServer: 'crliftoff.azurecr.io', provisioningState: 'Succeeded', adminUserEnabled: false }
  };
}

function readback(response: AzureArmResponse) {
  const request = vi.fn<AzureArmTransport['request']>(async () => response);
  return { request, client: new AzureApplicationProvisioningClient({ request }, binding) };
}

describe('application resource inventories do not grant provisioning authority', () => {
  it('uses the exact integrated candidate activation and manifest identity while correcting application executors', () => {
    expect(canonicalPhaseGraphHash).toBe('7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9');
    const contracts = phaseContractDigests(canonicalPhaseGraph);
    expect(contracts['workflow-source-ready']).toBe('c5b2a39dc5199066b7ab3723a527e4bdd72c7c979d952badf73e7ea5c61f6fbe');
    expect(contracts['rulesets-applied']).toBe('fee1c1caa631007261866350359467427fe39351da51c518f8e67d249a4863a4');
    expect(currentActivationIdentity).toMatchObject({
      manifestArtifactVersion: 8, policyVersion: '8', activationContractVersion: 4, phaseGraphSchemaVersion: 3
    });
  });

  it('binds exact declared resources and never substitutes the Azure actor for the workload identity', () => {
    const config = validateApplicationPrerequisitesConfig(prerequisites);
    expect(config.principalId).toBe(applicationPrincipal);
    expect(config.identityPrincipalId).toBe(workloadPrincipal);
    const inventory = inspectApplicationPrerequisiteResources(config);
    expect(inventory.namespaces).toEqual(['Microsoft.Authorization', 'Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity']);
    expect(inventory.resources).toEqual([
      { resourceId: applicationRegistryId, type: 'Microsoft.ContainerRegistry/registries',
        namespace: 'Microsoft.ContainerRegistry', name: 'crliftoff', phaseId: 'application-prerequisites-ready' },
      { resourceId: foundation.identityResourceId, type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
        namespace: 'Microsoft.ManagedIdentity', name: 'id-application', phaseId: 'application-prerequisites-ready' },
      { resourceId: roleAssignmentResourceId(applicationRegistryId, roleName), type: 'Microsoft.Authorization/roleAssignments',
        namespace: 'Microsoft.Authorization', name: roleName, phaseId: 'application-prerequisites-ready' }
    ]);
    expect(inventory.inventoryDigest).not.toBe(inspectApplicationPrerequisiteResources({
      ...config, roleAssignmentName: 'cccccccc-2222-4333-8444-555555555558'
    }).inventoryDigest);
    expect(inspectApplicationFoundationResources(foundation).resources.map((resource) => resource.type))
      .toEqual(['Microsoft.App/managedEnvironments', 'Microsoft.App/containerApps']);
  });

  it.each(['principalId', 'tenantId', 'region', 'resourceGroup', 'identityName', 'identityPrincipalId', 'identityClientId', 'roleAssignmentName'] as const)(
    'rejects missing %s instead of adding provider guesses', (field) => {
      const value: Record<string, unknown> = { ...prerequisites };
      delete value[field];
      expect(() => validateApplicationPrerequisitesConfig(value)).toThrow();
    }
  );

  it.each([
    'crliftoff.azurecr.io/team/app:latest',
    `crliftoff.azurecr.io/team/app@sha256:${'a'.repeat(64)}suffix`,
    `crliftoff.azurecr.io/team/app@sha256:${'a'.repeat(64)}@other`,
    `crliftoff.azurecr.io.evil.example/team/app@sha256:${'a'.repeat(64)}`,
    `https://crliftoff.azurecr.io/team/app@sha256:${'a'.repeat(64)}`,
    `crliftoff.azurecr.io/team/../app@sha256:${'a'.repeat(64)}`
  ])('rejects non-exact image reference %s', (imageRef) => {
    expect(() => parseApplicationImageReference(imageRef)).toThrow();
    expect(() => validateApplicationFoundationConfig({ ...foundation, imageRef })).toThrow();
  });

  it('rejects contradictory digest or unbound workload identity and keeps deterministic names separate from provider request IDs', () => {
    expect(() => validateApplicationFoundationConfig({ ...foundation, expectedDigest: `sha256:${'b'.repeat(64)}` })).toThrow();
    expect(() => validateApplicationFoundationConfig({ ...foundation, identityResourceId: undefined })).toThrow();
    const role = acrPullRoleDefinitionId(applicationSubscription);
    const name = deterministicRoleAssignmentUuid(applicationRegistryId, workloadPrincipal, role);
    expect(name).toBe(deterministicRoleAssignmentUuid(applicationRegistryId, workloadPrincipal, role));
    expect(name).not.toBe(deterministicRoleAssignmentUuid(applicationRegistryId, applicationPrincipal, role));
    expect(name).toMatch(/^[a-f0-9-]{36}$/u);
  });
});

describe('strict real ARM application observations', () => {
  it('decodes actual nested ARM properties and retains the actual response request ID', async () => {
    const requestId = randomUUID();
    const { client, request } = readback({ status: 200, requestId, data: registry() });
    expect(await client.getAcr('rg-app', 'crliftoff')).toEqual({
      id: applicationRegistryId, name: 'crliftoff', location: 'eastus',
      loginServer: 'crliftoff.azurecr.io', provisioningState: 'Succeeded', adminUserEnabled: false, requestId
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'GET', resourceId: applicationRegistryId, apiVersion: ACR_API_VERSION
    }, binding);
    for (const name of ['putAcr', 'putIdentity', 'putRoleAssignment', 'putContainerAppEnvironment', 'putContainerApp', 'scheduleAcrBuild']) {
      expect(Reflect.get(client, name)).toBeUndefined();
    }
  });

  it.each(['missing-request-id', 'missing-properties', 'foreign-id', 'wrong-type', 'wrong-name', 'missing-state', 'missing-host', 'missing-admin', 'denied'] as const)(
    'rejects %s without synthetic successful values', async (kind) => {
      const data: Record<string, unknown> = registry();
      const properties = data.properties as Record<string, unknown>;
      const response: AzureArmResponse = { status: 200, requestId: randomUUID(), data };
      if (kind === 'missing-request-id') delete response.requestId;
      if (kind === 'missing-properties') delete data.properties;
      if (kind === 'foreign-id') data.id = applicationRegistryId.replace('rg-app', 'foreign-group');
      if (kind === 'wrong-type') data.type = 'Microsoft.Storage/storageAccounts';
      if (kind === 'wrong-name') data.name = 'otherregistry';
      if (kind === 'missing-state') delete properties.provisioningState;
      if (kind === 'missing-host') delete properties.loginServer;
      if (kind === 'missing-admin') delete properties.adminUserEnabled;
      if (kind === 'denied') response.status = 403;
      await expect(readback(response).client.getAcr('rg-app', 'crliftoff')).rejects.toThrow();
    }
  );

  it('requires exact identity tenant/client/principal and observed scoped RBAC fields', async () => {
    const requestId = randomUUID();
    const identity = readback({
      status: 200, requestId, data: {
        id: foundation.identityResourceId, name: 'id-application', type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
        location: 'eastus', properties: { clientId: workloadClient, principalId: workloadPrincipal, tenantId: applicationTenant }
      }
    });
    expect(await identity.client.getIdentity('rg-app', 'id-application')).toMatchObject({
      clientId: workloadClient, principalId: workloadPrincipal, tenantId: applicationTenant, requestId
    });
    const assignment = {
      id: roleAssignmentResourceId(applicationRegistryId, roleName), name: roleName, type: 'Microsoft.Authorization/roleAssignments',
      properties: { scope: applicationRegistryId, principalId: workloadPrincipal,
        principalType: 'ServicePrincipal', roleDefinitionId: acrPullRoleDefinitionId(applicationSubscription) }
    };
    expect(await readback({ status: 200, requestId, data: assignment }).client.getRoleAssignment(applicationRegistryId, roleName))
      .toMatchObject({ id: assignment.id, scope: applicationRegistryId, principalId: workloadPrincipal, requestId });
    assignment.properties.scope = `/subscriptions/${applicationSubscription}`;
    await expect(readback({ status: 200, requestId, data: assignment }).client.getRoleAssignment(applicationRegistryId, roleName)).rejects.toThrow(/scope/u);
  });

  it('refuses unsafe target paths before any provider request', async () => {
    const { client, request } = readback({ status: 200, requestId: randomUUID(), data: registry() });
    await expect(client.getAcr('../outside', 'crliftoff')).rejects.toThrow();
    await expect(client.getIdentity('rg-app', '../identity')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('retains observed request identity and dispatch classification for malformed provider responses', async () => {
    const requestId = randomUUID();
    const { client } = readback({ status: 200, requestId, data: { ...registry(), properties: {} } });
    await expect(client.getAcr('rg-app', 'crliftoff')).rejects.toMatchObject({ status: 200, requestId, dispatched: true });
  });
});

describe('application private-plan interface boundaries', () => {
  it.each([
    { phaseId: 'application-prerequisites-ready' as const, actionId: 'azure.prerequisites.apply',
      config: prerequisites, plan: planApplicationPrerequisites, execute: executeApplicationPrerequisites },
    { phaseId: 'application-foundation' as const, actionId: 'azure.application-foundation.apply',
      config: foundation, plan: planApplicationFoundation, execute: executeApplicationFoundation }
  ])('rejects $phaseId target metadata without an exact private execution contract', async (contract) => {
    const destination = {
      type: 'subscription' as const, subscriptionId: applicationSubscription,
      identity: contract.phaseId === 'application-foundation'
        ? containerAppResourceId(applicationSubscription, foundation.resourceGroup, foundation.appName) : applicationRegistryId
    };
    const operation: TransitionOperation = {
      phaseId: contract.phaseId, adapter: 'azure-opentofu', actionId: contract.actionId, mutationClass: 'azure-resource-provision',
      remote: true, destructive: false, destination, inputs: { application: contract.config },
      effects: (['backend-state-read', 'backend-state-write', 'azure-read'] as const).map((mutationClass) => ({
        mutationClass, destination, remote: true, destructive: false
      }))
    };
    const configuration: ActivationConfiguration = {
      schemaVersion: 1, azure: { subscriptionId: applicationSubscription, tenantId: applicationTenant, region: 'eastus' },
      budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 },
      phases: { [contract.phaseId]: contract.config }
    };
    const run = vi.fn(async () => { throw new Error('No provider, credential, state or tool access is authorized by target metadata alone.'); });
    const fixture = await workflowOperationFixture(contract.phaseId, [operation], { run }, { configuration });
    fixtures.push(fixture);
    const request = vi.fn<AzureArmTransport['request']>(async () => { throw new Error('No ARM fallback is permitted.'); });
    fixture.input.adapters.azureActivation = { storage: fixture.storage, transport: { request } };
    const blocker = new ApplicationPrivateError('input-fields').message;
    expect(await contract.plan(fixture.input)).toEqual({ operations: [], blockers: [blocker] });
    const outcome = await withProjectMutationLock(fixture.projectRoot, (lease) => contract.execute({ ...fixture.input, lease }));
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(outcome.blocker).toBe(blocker);
    expect(outcome.resultState).toBeUndefined();
    expect(outcome.liveReadback).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    const prior = {
      provider: 'azure' as const, actionId: contract.actionId, operationId: 'cccccccc-dddd-4eee-8fff-111111111111',
      resourceId: applicationRegistryId, status: 'running' as const,
      startedAt: fixture.input.now.toISOString(), observedAt: fixture.input.now.toISOString()
    };
    fixture.input.inspection.state.phases[contract.phaseId].operation = prior;
    expect((await contract.execute(fixture.input)).operation).toEqual(prior);
    expect(run).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
