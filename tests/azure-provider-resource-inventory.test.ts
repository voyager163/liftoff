import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { inspectProviderResourceInventory } from '../src/application/azure-activation/provider-resource-inventory.js';
import { inspectProviderSources } from '../src/application/azure-activation/provider-inventory.js';
import { deriveRequiredProviders, planProviderReadiness } from '../src/application/azure-activation/producer-provider.js';
import { bootstrapArmPlanForInspection } from '../src/application/azure-activation/producer-bootstrap.js';
import { privateArmInventory } from '../src/application/azure-activation/private-resource-plans.js';
import type { PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import { activationProducerFixture } from './helpers/activation-producer-fixture.js';
import { providerBootstrapConfiguration } from './helpers/provider-sdk-fixture.js';

const rootParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
const principalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture(statePath: 'existing-private' | 'bootstrap-local' = 'bootstrap-local') {
  const calls: string[] = [];
  const f = await activationProducerFixture('provider-ready', {
    rootPathParts: rootParts, principalId, registration: 'register-missing'
  }, { async run(command) {
    calls.push(command.executable);
    throw new Error('Resource inventory cannot invoke provider, credential, custody or project commands.');
  } });
  fixtures.push(f);
  const configuration = f.inspection.activationInputs!;
  configuration.phases['state-path-selected'] = { statePath };
  const bootstrap = providerBootstrapConfiguration(f.root);
  if (statePath === 'bootstrap-local') configuration.phases['bootstrap-local'] = bootstrap;
  const source = path.join(f.projectRoot, ...rootParts, 'main.tf');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'resource "azurerm_storage_account" "state" {}\n');
  await f.refreshInputs();
  const input: PhasePlanningInput = {
    inspection: f.inspection, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'provider-ready')!,
    runner: f.runner, now: f.now
  };
  return { ...f, input, configuration, bootstrap, source, calls };
}

describe('complete source-backed provider resource inventory', () => {
  it('includes the actual bootstrap and runner SDK resource types absent from HCL without inventing namespaces', async () => {
    const f = await fixture();
    const hcl = await inspectProviderSources(f.inspection, rootParts);
    const inventory = await inspectProviderResourceInventory(f.input, rootParts);
    const { access } = bootstrapArmPlanForInspection({
      ...f.input, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'bootstrap-local')!
    });
    const actualSdk = privateArmInventory(access);
    expect(hcl.schemaVersion).toBe(1);
    expect(hcl.namespaces).toEqual(['Microsoft.Storage']);
    expect(hcl.sourceDigest).toBe(canonicalSha256({ roots: hcl.roots, files: hcl.files, resources: hcl.resources }));
    expect(inventory.schemaVersion).toBe(2);
    expect(inventory.hclSourceDigest).toBe(hcl.sourceDigest);
    expect(inventory.namespaces).toEqual(['GitHub.Network', 'Microsoft.Network', 'Microsoft.Storage']);
    expect(await deriveRequiredProviders(f.input)).toEqual(inventory.namespaces);
    expect(inventory.resources).toHaveLength(hcl.resources.length + actualSdk.resources.length);
    expect(inventory.sdk[0]?.resources.map((resource) => resource.resourceId).sort())
      .toEqual(actualSdk.resources.map((resource) => resource.resourceId).sort());
    expect(inventory.sdk[0]?.producerSourceDigest).toBe(actualSdk.sourceDigest);
    expect(inventory.sdk[0]?.resources.some((resource) => resource.resourceType === 'GitHub.Network/networkSettings')).toBe(true);
    expect(inventory.sdk[0]?.binding.principalId).not.toBe(principalId);
    expect(inventory.sdk[0]).not.toHaveProperty('planDigest');
    expect(f.calls).toEqual([]);
  });

  it('does not add or validate unused bootstrap configuration for an explicitly existing private path', async () => {
    const f = await fixture('existing-private');
    const original = await inspectProviderResourceInventory(f.input, rootParts);
    f.configuration.phases['bootstrap-local'] = { unselected: 'not a bootstrap plan' };
    const unchanged = await inspectProviderResourceInventory(f.input, rootParts);
    expect(unchanged).toEqual(original);
    expect(unchanged.namespaces).toEqual(['Microsoft.Storage']);
    expect(unchanged.sdk).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('requires the explicit future path rather than inferring bootstrap from names, state or available configuration', async () => {
    const f = await fixture();
    delete f.configuration.phases['state-path-selected'];
    f.inspection.state.applicability.statePath = 'bootstrap-local';
    await expect(inspectProviderResourceInventory(f.input, rootParts)).rejects.toThrow(/phases.state-path-selected.statePath/);
    await expect(planProviderReadiness(f.input)).rejects.toThrow(/phases.state-path-selected.statePath/);
    expect(f.calls).toEqual([]);
  });

  it.each(['subscriptionId', 'tenantId'] as const)('refuses SDK resources bound to a different %s before any provider observation', async (field) => {
    const f = await fixture();
    f.configuration.phases['provider-ready']![field] = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    await expect(inspectProviderResourceInventory(f.input, rootParts)).rejects.toThrow(/different subscription or tenant/);
    expect(f.calls).toEqual([]);
  });

  it('binds actual SDK resource definitions, not just the set of namespace names', async () => {
    const f = await fixture();
    const original = await inspectProviderResourceInventory(f.input, rootParts);
    const before = f.inspection.contexts['provider-ready'].inputDigest;
    const committed = f.inspection.contexts.committed.inputDigest;
    const pushed = f.inspection.contexts.pushed.inputDigest;
    f.configuration.phases['bootstrap-local'] = {
      ...f.bootstrap, access: { ...f.bootstrap.access, network: { ...f.bootstrap.access.network, vnetName: 'reviewed-other-network' } }
    };
    const changed = await inspectProviderResourceInventory(f.input, rootParts);
    await f.refreshInputs();
    expect(changed.namespaces).toEqual(original.namespaces);
    expect(changed.sourceDigest).not.toBe(original.sourceDigest);
    expect(f.inspection.contexts['provider-ready'].inputDigest).not.toBe(before);
    expect(f.inspection.contexts.committed.inputDigest).toBe(committed);
    expect(f.inspection.contexts.pushed.inputDigest).toBe(pushed);
    expect(f.calls).toEqual([]);
  });

  it('refuses a semantic configuration change while HCL and SDK inventory are being captured', async () => {
    const f = await fixture();
    const capture = inspectProviderResourceInventory(f.input, rootParts);
    f.configuration.phases['bootstrap-local'] = {
      ...f.bootstrap, access: { ...f.bootstrap.access, network: { ...f.bootstrap.access.network, vnetName: 'changed-during-capture' } }
    };
    await expect(capture).rejects.toThrow(/configuration changed while the exact resource inventory was captured/);
    expect(f.calls).toEqual([]);
  });

  it('ignores unrelated later phase inputs and preserves provider identity when the configured path is subsequently selected', async () => {
    const f = await fixture();
    const original = await inspectProviderResourceInventory(f.input, rootParts);
    const before = f.inspection.contexts['provider-ready'].inputDigest;
    f.configuration.phases['dev-proof'] = { unrelatedFutureInput: 'does not determine provider namespaces' };
    f.configuration.budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 1234 };
    f.inspection.state.applicability.statePath = 'bootstrap-local';
    await f.refreshInputs();
    expect(await inspectProviderResourceInventory(f.input, rootParts)).toEqual(original);
    expect(f.inspection.contexts['provider-ready'].inputDigest).toBe(before);
    expect(f.calls).toEqual([]);
  });

  it('does not admit arbitrary additional provider lists or repository-scope Azure inventory', async () => {
    const f = await fixture();
    f.configuration.phases['provider-ready']!.additionalProviders = ['Unplanned.Provider'];
    await expect(deriveRequiredProviders(f.input)).rejects.toThrow(/Configuration approval flags cannot authorize/);
    f.inspection.scope = 'repository';
    await expect(inspectProviderResourceInventory(f.input, rootParts)).rejects.toThrow(/only to provider-ready in full activation/);
    expect(f.calls).toEqual([]);
  });
});
