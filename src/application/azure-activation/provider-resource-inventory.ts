import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { phaseConfigurationProjection, providerSdkConfigurationProjection } from '../../domain/governance/activation/inputs.js';
import { phaseById } from '../../domain/governance/activation/operations.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import type { AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import { AzureActivationAdmissionError } from './authority.js';
import { inspectProviderSources, type ProviderSourceInventory } from './provider-inventory.js';
import { bootstrapArmPlanForInspection } from './producer-bootstrap.js';
import { privateArmInventory, type PrivateArmResourcePlan } from './private-resource-plans.js';
import { resolveAzureInputs } from './producer-discovery.js';

export interface ProviderArmResource {
  kind: 'sdk-arm';
  resourceId: string;
  resourceType: string;
  apiVersion: string;
  bodyDigest: string;
  namespace: string;
}

export interface ProviderSdkInventory {
  recipe: PrivateArmResourcePlan['recipe'];
  phaseId: 'bootstrap-local';
  binding: AzureArmBinding;
  repositoryId: string;
  region: string;
  expiresAt: string;
  producerSourceDigest: string;
  resources: readonly ProviderArmResource[];
}

export interface ProviderResourceInventory extends Omit<ProviderSourceInventory, 'schemaVersion' | 'sourceDigest' | 'resources' | 'namespaces'> {
  schemaVersion: 2;
  statePath: 'existing-private' | 'bootstrap-local';
  hclSourceDigest: string;
  configurationDigest: string;
  sourceDigest: string;
  sdk: readonly ProviderSdkInventory[];
  resources: readonly (ProviderSourceInventory['resources'][number] | ProviderArmResource)[];
  namespaces: readonly string[];
}

export async function inspectProviderResourceInventory(
  input: PhasePlanningInput, rootPathParts: readonly string[]
): Promise<ProviderResourceInventory> {
  if (input.phase.id !== 'provider-ready' || (input.inspection.scope ?? 'activation') !== 'activation') {
    throw new AzureActivationAdmissionError('provider-inventory-scope', 'Complete provider inventory belongs only to provider-ready in full activation.');
  }
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const configurationDigest = canonicalSha256(phaseConfigurationProjection('provider-ready', configuration));
  const selected = providerSdkConfigurationProjection(configuration).statePath;
  if (selected !== 'existing-private' && selected !== 'bootstrap-local') {
    throw new AzureActivationAdmissionError('provider-topology-required',
      'Provider readiness requires phases.state-path-selected.statePath before namespace planning: existing-private or bootstrap-local. Future phase configuration selects the inventory, not mutation authority.');
  }
  const binding = validateAzureBindings(resolveAzureInputs(input));
  if (!binding.valid || !binding.subscriptionId || !binding.tenantId || !binding.region) {
    throw new AzureActivationAdmissionError('provider-inventory-binding', `Complete provider inventory requires exact Azure bindings: ${binding.errors.join(' ')}`);
  }
  const hcl = await inspectProviderSources(input.inspection, rootPathParts);
  const sdk: ProviderSdkInventory[] = [];
  if (selected === 'bootstrap-local') {
    const { access } = bootstrapArmPlanForInspection({
      ...input, phase: phaseById(canonicalPhaseGraph, 'bootstrap-local')
    });
    if (access.binding.subscriptionId !== binding.subscriptionId || access.binding.tenantId !== binding.tenantId) {
      throw new AzureActivationAdmissionError('provider-sdk-binding',
        'Planned bootstrap and runner resources belong to a different subscription or tenant from the reviewed provider registration target.');
    }
    const inventory = privateArmInventory(access);
    const resources = inventory.resources.map<ProviderArmResource>((resource) => {
      const [namespace, ...types] = resource.resourceType.split('/');
      if (!namespace || types.length === 0 || !resource.resourceId.includes(`/providers/${namespace}/`)) {
        throw new AzureActivationAdmissionError('provider-sdk-resource', 'A planned SDK resource has inconsistent provider namespace and resource identity.');
      }
      return { kind: 'sdk-arm', ...resource, namespace };
    }).sort((left, right) => left.resourceId.localeCompare(right.resourceId, 'en'));
    if (resources.length === 0 || new Set(resources.map((resource) => resource.resourceId)).size !== resources.length) {
      throw new AzureActivationAdmissionError('provider-sdk-resource', 'The actual SDK plan has an empty or duplicate resource inventory.');
    }
    // Registration commits resource definitions, not the future deployment's whole-configuration approval digest.
    sdk.push({
      recipe: inventory.recipe, phaseId: inventory.phaseId,
      binding: access.binding, repositoryId: access.repositoryId, region: access.region, expiresAt: access.expiresAt,
      producerSourceDigest: inventory.sourceDigest, resources
    });
  }
  const currentConfiguration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  if (canonicalSha256(phaseConfigurationProjection('provider-ready', currentConfiguration)) !== configurationDigest) {
    throw new AzureActivationAdmissionError('provider-inventory-changed', 'Consumed provider or SDK configuration changed while the exact resource inventory was captured.');
  }
  const resources = [...hcl.resources, ...sdk.flatMap((inventory) => inventory.resources)];
  const namespaces = [...new Set(resources.map((resource) => resource.namespace))].sort();
  if (resources.length > 256 || namespaces.length > 32) {
    throw new AzureActivationAdmissionError('provider-inventory-limit', 'Complete provider inventory exceeds its 256-resource or 32-namespace bound.');
  }
  const inventory: Omit<ProviderResourceInventory, 'sourceDigest'> = {
    schemaVersion: 2, statePath: selected,
    rootPathParts: hcl.rootPathParts, roots: hcl.roots, files: hcl.files,
    hclSourceDigest: hcl.sourceDigest, configurationDigest, sdk, resources, namespaces
  };
  return { ...inventory, sourceDigest: canonicalSha256(inventory) };
}
