import { createHash } from 'node:crypto';
import { readDeclaredAssetBytes, type DeclaredPackagedAsset, type PackagedAssetReadBounds } from '../../adapters/packaged-assets/plugin-assets.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';
import { modernAssets, modernGovernanceAssets, modernRegistryInput } from '../../plugins/builtin/modern.js';
import { modernRelease } from '../../plugins/builtin/modern-release.js';
import { modernHistoricalRelease } from '../../plugins/builtin/modern-historical-release.js';
import { modernPreviousRelease } from '../../plugins/builtin/modern-previous-release.js';
import { modernPreAssessmentDeclarationsDigest, modernPreAssessmentSource } from '../../plugins/builtin/modern-pre-assessment.js';
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
let preAssessmentRegistry: PluginRegistry | undefined;

export function modernSourceRegistry(): PluginRegistry {
  registry ??= createModernSourceRegistry();
  return registry;
}

export function createModernPreAssessmentRegistry(read: ModernAssetReader = readDeclaredAssetBytes): PluginRegistry {
  const declarations = [
    ...modernPreAssessmentSource.core.sharedAssets.map(asset => ({ ...asset, owner: { kind: 'core' as const } })),
    ...modernPreAssessmentSource.descriptors.flatMap(descriptor => descriptor.assets.map(asset => ({
      ...asset, owner: { kind: 'plugin' as const, category: descriptor.category, id: descriptor.id }
    })))
  ];
  const assets = read(declarations, {
    maxAssetBytes: pluginRegistryLimits.maxAssetBytes,
    maxTotalAssetBytes: pluginRegistryLimits.maxTotalAssetBytes,
    maxPathParts: pluginRegistryLimits.maxPathParts,
    maxPartLength: pluginRegistryLimits.maxStringLength
  });
  return createPluginRegistry({ ...modernPreAssessmentSource, assets });
}

export function modernPreAssessmentRegistry(): PluginRegistry {
  preAssessmentRegistry ??= createModernPreAssessmentRegistry();
  return preAssessmentRegistry;
}

/** Recognizes exact pinned source families, never old template bytes or execution permission. */
export function matchesHistoricalModernPlugins(recorded: ManifestPluginMetadata, resolution: PluginResolution): boolean {
  const source = modernPreAssessmentRegistry();
  const historicalResolution = source.resolveSelection(resolution.selection, { platform: resolution.hostPlatform });
  const currentResolution = modernSourceRegistry().resolveSelection(resolution.selection, { platform: resolution.hostPlatform });
  const semantic = ({ hostPlatform: _host, ...value }: PluginResolution) => canonicalJson(value);
  if (semantic(resolution) !== semantic(currentResolution) && semantic(resolution) !== semantic(historicalResolution)) {
    return false;
  }
  const historicalMetadata = readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: historicalResolution.digest, selections: historicalResolution.plugins
  }, {
    stack: resolution.selection.stack, cloud: resolution.selection.cloud,
    workflow: resolution.selection.workflow, agents: resolution.selection.agents
  });
  if (manifestPluginMetadataMatches(recorded, historicalMetadata)) return true;
  const declarationsDigest = `sha256:${canonicalSha256({
    descriptors: modernPreAssessmentSource.descriptors.map(({ contentVersion: _version, ...descriptor }) => descriptor),
    core: modernPreAssessmentSource.core, selectionSpace: modernPreAssessmentSource.selectionSpace,
    operations: modernPreAssessmentSource.operations
  })}`;
  if (declarationsDigest !== modernPreAssessmentDeclarationsDigest) {
    throw new Error('Frozen modern source declarations do not match their captured identity.');
  }
  return [modernHistoricalRelease, modernPreviousRelease].some((family) => {
    if (declarationsDigest !== family.declarationsDigest ||
        canonicalJson(historicalResolution.sharedAssets) !== canonicalJson([...family.sharedAssets]
          .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
      return false;
    }
    const plugins = historicalResolution.plugins.map((plugin) => family.plugins.find((entry) =>
      entry.category === plugin.category && entry.id === plugin.id && entry.apiVersion === plugin.apiVersion));
    if (plugins.some((plugin) => plugin === undefined)) return false;
    const { hostPlatform: _host, digest: _digest, ...historicalSemantic } = historicalResolution;
    const historical = plugins.filter((plugin) => plugin !== undefined);
    return manifestPluginMetadataMatches(recorded, readManifestPluginMetadata({
      schemaVersion: 1,
      resolutionDigest: pluginResolutionDigest({ ...historicalSemantic, plugins: historical }),
      selections: historical
    }, {
      stack: resolution.selection.stack, cloud: resolution.selection.cloud,
      workflow: resolution.selection.workflow, agents: resolution.selection.agents
    }));
  });
}
