import { describe, expect, it } from 'vitest';
import { planBootstrapArmResources, planRunnerArmResources, privateArmInventory } from '../src/application/azure-activation/private-resource-plans.js';
import { bootstrapAccess, fixtureVnet } from './helpers/private-activation-fixture.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraphHash } from '../src/domain/governance/activation/graph.js';

describe('exact access-establishing SDK inventory (unqualified fixtures)', () => {
  it('plans concrete immutable network resources and runner settings before any provider effect', () => {
    const input = bootstrapAccess();
    const plan = planBootstrapArmResources(input);
    expect(plan.resources).toHaveLength(12);
    expect(plan).toEqual(planBootstrapArmResources(input));
    expect(plan.phaseId).toBe('bootstrap-local');
    expect(Object.isFrozen(plan.resources)).toBe(true);
    const ids = new Set<string>();
    for (const resource of plan.resources) {
      expect(resource.resourceId).toContain(`/subscriptions/${input.binding.subscriptionId}/resourceGroups/private-access/`);
      expect(resource.bodyDigest).toBe(canonicalSha256(resource.body));
      expect(resource.resourceType).toMatch(/^(Microsoft\.Network|GitHub\.Network)\//);
      expect(Object.isFrozen(resource.body)).toBe(true);
      expect(resource.dependsOn.every((id) => ids.has(id))).toBe(true);
      ids.add(resource.resourceId);
    }
    const inventory = privateArmInventory(plan);
    expect(inventory.resources.map((resource) => resource.resourceType)).toContain('GitHub.Network/networkSettings');
    expect(JSON.stringify(inventory)).not.toMatch(/Microsoft\.App|Microsoft\.ContainerRegistry|Microsoft\.Storage|Microsoft\.Authorization|placeholder/);
    expect(inventory.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalPhaseGraphHash).toBe('7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9');
  });

  it('binds the exact business ID/subnet without putting Azure writes into runner-ready', () => {
    const input = bootstrapAccess();
    const plan = planRunnerArmResources({
      binding: input.binding, repositoryId: input.repositoryId, region: input.region,
      configurationDigest: input.configurationDigest, expiresAt: input.expiresAt,
      resourceGroup: input.resourceGroup, networkSettingsName: input.runner.networkSettingsName,
      githubBusinessId: input.runner.githubBusinessId, subnetId: `${fixtureVnet}/subnets/runners`
    });
    expect(plan.resources).toHaveLength(1);
    expect(plan.resources[0]).toMatchObject({
      resourceType: 'GitHub.Network/networkSettings', apiVersion: '2024-04-02',
      body: { location: 'eastus', properties: { businessId: '7', subnetId: `${fixtureVnet}/subnets/runners` } }
    });
    expect(plan.phaseId).toBe('bootstrap-local');
  });

  it.each([
    ['overlapping subnets', (input: ReturnType<typeof bootstrapAccess>) => { input.network.endpointSubnetPrefix = input.network.runnerSubnetPrefix; }],
    ['public address space', (input: ReturnType<typeof bootstrapAccess>) => { input.network.addressPrefix = '192.0.2.0/24'; }],
    ['reserved endpoint IP', (input: ReturnType<typeof bootstrapAccess>) => { input.network.endpointAddress = '10.60.2.3'; }],
    ['wildcard egress', (input: ReturnType<typeof bootstrapAccess>) => { input.network.outboundHttpsPrefixes = ['0.0.0.0/0']; }],
    ['nil principal', (input: ReturnType<typeof bootstrapAccess>) => { input.binding = { ...input.binding, principalId: '00000000-0000-0000-0000-000000000000' }; }],
    ['cross-subscription storage', (input: ReturnType<typeof bootstrapAccess>) => { input.storageAccountResourceId = input.storageAccountResourceId.replace(input.binding.subscriptionId, input.binding.tenantId); }],
    ['namespace flag', (input: ReturnType<typeof bootstrapAccess>) => { Object.assign(input, { additionalProviders: ['Microsoft.App'] }); }],
    ['resource injection', (input: ReturnType<typeof bootstrapAccess>) => { Object.assign(input.network, { application: 'placeholder' }); }]
  ])('rejects %s before exposing an executable inventory', (_name, change) => {
    const input = bootstrapAccess();
    change(input);
    expect(() => planBootstrapArmResources(input)).toThrow();
  });

  it('binds changes in exact resource payload, owner, principal, region and expiry', () => {
    const original = planBootstrapArmResources(bootstrapAccess());
    for (const field of ['repositoryId', 'region', 'expiresAt'] as const) {
      const input = bootstrapAccess();
      input[field] = field === 'repositoryId' ? '43' : field === 'region' ? 'eastus2' : '2026-09-15T01:00:00.000Z';
      expect(planBootstrapArmResources(input).planDigest).not.toBe(original.planDigest);
    }
    const changed = structuredClone(original);
    changed.resources[0]!.bodyDigest = 'f'.repeat(64);
    expect(() => privateArmInventory(changed)).toThrow(/changed/);
  });
});
