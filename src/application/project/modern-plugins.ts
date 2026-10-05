import { createHash } from 'node:crypto';
import { readDeclaredAssetBytes, type DeclaredPackagedAsset, type PackagedAssetReadBounds } from '../../adapters/packaged-assets/plugin-assets.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';
import { modernAssets, modernCore, modernDescriptors, modernGovernanceAssets, modernRegistryInput, modernSelectionSpace } from '../../plugins/builtin/modern.js';
import { builtinOperations } from '../../plugins/builtin/index.js';
import { modernRelease } from '../../plugins/builtin/modern-release.js';
import { modernHistoricalRelease } from '../../plugins/builtin/modern-historical-release.js';
import { pluginRegistryLimits, type PackagedAssetBytes, type PluginRegistry, type PluginResolution } from '../../plugins/contracts.js';
import { createPluginRegistry, pluginResolutionDigest } from '../../plugins/registry.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata, type ManifestPluginMetadata } from '../../domain/project/manifest/plugins.js';

type ModernAssetReader = (
  declarations: readonly DeclaredPackagedAsset[],
  bounds: PackagedAssetReadBounds
) => readonly PackagedAssetBytes[];

/** Verifies the complete actual packaged source family, without rendering or initializing project tools. */
export function createModernSourceRegistry(read: ModernAssetReader = readDeclaredAssetBytes): PluginRegistry {
  const bytes = read(modernAssets, {
    maxAssetBytes: pluginRegistryLimits.maxAssetBytes,
    maxTotalAssetBytes: pluginRegistryLimits.maxTotalAssetBytes,
    maxPathParts: pluginRegistryLimits.maxPathParts,
    maxPartLength: pluginRegistryLimits.maxStringLength
  });
  const registry = createPluginRegistry(modernRegistryInput(bytes, modernRelease));
  const sources = modernActivationSourceContracts();
  const assetByPath = new Map(bytes.map((asset) => [asset.pathParts.join('/'), asset.bytes]));
  const table = modernGovernanceAssets.find((asset) => asset.id === 'modern-governance-source-contracts')!;
  const actualTable = assetByPath.get(table.pathParts.join('/'));
  const expectedTable = canonicalJson({
    schemaVersion: 1,
    kind: 'liftoff-modern-source-contracts',
    sources: sources.map(({ identity, savedPlanSchemaVersion, compatibilityMetadataSchemaVersion }) =>
      ({ identity, savedPlanSchemaVersion, compatibilityMetadataSchemaVersion }))
  });
  if (!actualTable || !Buffer.from(actualTable).equals(Buffer.from(expectedTable, 'utf8'))) {
    throw new Error('Packaged modern source table does not exactly match the authoritative static source contracts.');
  }
  for (const source of sources) {
    if (canonicalSha256(source.graph) !== source.identity.phaseGraphHash) {
      throw new Error('Modern source graph does not match its authoritative canonical hash.');
    }
    const policyId = source.identity.profile === 'single-maintainer-gitflow'
      ? 'modern-single-maintainer-policy' : 'modern-team-policy';
    const declaredPolicy = modernGovernanceAssets.find((asset) => asset.id === policyId)!;
    if (source.policyPathParts.join('\0') !== declaredPolicy.pathParts.join('\0')) {
      throw new Error('Modern source policy path does not match its exact packaged declaration.');
    }
    const policy = assetByPath.get(declaredPolicy.pathParts.join('/'));
    if (!policy || `sha256:${createHash('sha256').update(policy).digest('hex')}` !== source.identity.policyDigest) {
      throw new Error('Modern source policy bytes do not match their authoritative raw digest.');
    }
  }
  return registry;
}

let registry: PluginRegistry | undefined;

export function modernSourceRegistry(): PluginRegistry {
  registry ??= createModernSourceRegistry();
  return registry;
}

/** Recognizes one pinned historical source family, never old template bytes or execution permission. */
export function matchesHistoricalModernPlugins(recorded: ManifestPluginMetadata, resolution: PluginResolution): boolean {
  const declarationsDigest = `sha256:${canonicalSha256({
    descriptors: modernDescriptors.map(({ contentVersion: _version, ...descriptor }) => descriptor),
    core: modernCore, selectionSpace: modernSelectionSpace, operations: builtinOperations
  })}`;
  if (declarationsDigest !== modernHistoricalRelease.declarationsDigest ||
      canonicalJson(resolution.sharedAssets) !== canonicalJson([...modernHistoricalRelease.sharedAssets]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    return false;
  }
  const plugins = resolution.plugins.map((plugin) => modernHistoricalRelease.plugins.find((entry) =>
    entry.category === plugin.category && entry.id === plugin.id));
  if (plugins.some((plugin) => plugin === undefined)) return false;
  const { hostPlatform: _host, digest: _digest, ...semantic } = resolution;
  const historical = plugins.filter((plugin) => plugin !== undefined);
  return manifestPluginMetadataMatches(recorded, readManifestPluginMetadata({
    schemaVersion: 1,
    resolutionDigest: pluginResolutionDigest({ ...semantic, plugins: historical }),
    selections: historical
  }, {
    stack: resolution.selection.stack, cloud: resolution.selection.cloud,
    workflow: resolution.selection.workflow, agents: resolution.selection.agents
  }));
}
