import type {
  AssetDeclaration, ContributionOwner, PackagedAssetBytes, PluginDescriptor, PluginRegistryInput, PluginReleaseInventory
} from '../contracts.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { builtinAssets } from './assets.js';
import { builtinDescriptor, deepFrozen } from './core.js';
import { builtinCore, builtinDescriptors, builtinOperations, builtinSelectionSpace } from './index.js';

const enabledProfiles = ['single-maintainer-gitflow', 'team-gitflow'] as const;
const handoffNames = new Set([
  'repository-governance-policy', 'repository-governance-context', 'repository-governance-guide',
  'repository-governance-phase-graph', 'repository-governance-compatibility', 'repository-governance-credential-policy-schema'
]);

export const modernGovernanceAssets: readonly (AssetDeclaration & { readonly owner: ContributionOwner })[] = deepFrozen([
  {
    owner: { kind: 'core' }, id: 'modern-single-maintainer-policy',
    pathParts: ['assets', 'governance', 'single-maintainer-gitflow', 'policy-v7.md']
  },
  {
    owner: { kind: 'core' }, id: 'modern-team-policy',
    pathParts: ['assets', 'governance', 'team-gitflow', 'policy-v1.md']
  },
  {
    owner: { kind: 'core' }, id: 'modern-governance-source-contracts',
    pathParts: ['assets', 'governance', 'modern', 'source-contracts.json']
  }
]);

export const modernAssets: readonly (AssetDeclaration & { readonly owner: ContributionOwner })[] = deepFrozen([
  ...builtinAssets.map(({ owner, id, pathParts }) => ({ owner, id, pathParts })),
  ...modernGovernanceAssets
]);

const manual = builtinDescriptor({
  category: 'workflow', id: 'manual', contentVersion: 1, supports: [{}], artifacts: []
});

export const modernDescriptors: readonly PluginDescriptor[] = deepFrozen([
  ...builtinDescriptors.map((descriptor): PluginDescriptor => {
    if (descriptor.category !== 'agent') return descriptor;
    const integration = Object.entries(governanceAgentIntegrations).find(([id]) => id === descriptor.id)?.[1];
    if (!integration) throw new Error(`No registered governance integrations for modern agent ${descriptor.id}.`);
    return {
      ...descriptor,
      contentVersion: 2,
      artifacts: descriptor.artifacts.map((artifact) =>
        artifact.logicalName === integration.setup.logicalName || artifact.logicalName === integration.assessment.logicalName
          ? { ...artifact, when: { governanceProfile: [...enabledProfiles] } }
          : artifact)
    };
  }),
  manual
]);

export const modernCore = deepFrozen({
  ...builtinCore,
  artifacts: builtinCore.artifacts.map((artifact) => handoffNames.has(artifact.logicalName)
    ? { ...artifact, when: { governanceProfile: [...enabledProfiles] } }
    : artifact),
  sharedAssets: [
    ...builtinCore.sharedAssets,
    ...modernGovernanceAssets.map(({ id, pathParts }) => ({ id, pathParts }))
  ]
});

export const modernSelectionSpace = deepFrozen({
  ...builtinSelectionSpace,
  governanceProfiles: ['none', ...enabledProfiles]
});

/** Data assembly only; the registry must verify every declared asset and the actual release inventory. */
export function modernRegistryInput(
  assets: readonly PackagedAssetBytes[],
  release: PluginReleaseInventory
): PluginRegistryInput {
  return {
    descriptors: modernDescriptors,
    core: modernCore,
    selectionSpace: modernSelectionSpace,
    operations: builtinOperations,
    release,
    assets
  };
}
