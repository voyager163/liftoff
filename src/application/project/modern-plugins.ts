import { createHash } from 'node:crypto';
import { readDeclaredAssetBytes, type DeclaredPackagedAsset, type PackagedAssetReadBounds } from '../../adapters/packaged-assets/plugin-assets.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';
import { modernAssets, modernGovernanceAssets, modernRegistryInput } from '../../plugins/builtin/modern.js';
import { modernRelease } from '../../plugins/builtin/modern-release.js';
import { modernHistoricalRelease } from '../../plugins/builtin/modern-historical-release.js';
import { modernPreviousRelease } from '../../plugins/builtin/modern-previous-release.js';
import { modernPythonPreviousReleases } from '../../plugins/builtin/modern-python-previous-release.js';
import {
  modernPreWorkflowDeclarationsDigest, modernPreWorkflowGovernanceSourceContracts, modernPreWorkflowSource
} from '../../plugins/builtin/modern-pre-workflow.js';
import {
  modernPreAssessmentDeclarationsDigest,
  modernPreAssessmentGovernanceSourceContracts,
  modernPreAssessmentSource
} from '../../plugins/builtin/modern-pre-assessment.js';
import {
  pluginRegistryLimits, type AssetDigest, type PackagedAssetBytes, type PluginRegistry, type PluginRegistryInput,
  type PluginResolution, type ResolvedPlugin
} from '../../plugins/contracts.js';
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
let preWorkflowRegistry: PluginRegistry | undefined;
const historicalSourceContractsId = 'modern-governance-source-contracts';

export function modernSourceRegistry(): PluginRegistry {
  registry ??= createModernSourceRegistry();
  return registry;
}

const readModernPreAssessmentAssets: ModernAssetReader = (declarations, bounds) => {
  const assets = readDeclaredAssetBytes(declarations, bounds);
  const sourceContracts = declarations.find((asset) =>
    asset.owner.kind === 'core' && asset.id === historicalSourceContractsId);
  if (!sourceContracts) return assets;
  const sourcePath = sourceContracts.pathParts.join('/');
  return assets.map((asset) => asset.pathParts.join('/') === sourcePath
    ? { ...asset, bytes: Buffer.from(modernPreAssessmentGovernanceSourceContracts, 'utf8') }
    : asset);
};

// Frozen source declarations compose with the current template closure; recorded predecessor metadata stays separate.
function createModernCompatibilityRegistry(
  source: Omit<PluginRegistryInput, 'assets'>, assets: readonly PackagedAssetBytes[]
): PluginRegistry {
  const currentFrontendAssets = new Map(modernRelease.sharedAssets
    .filter((asset) => asset.id === 'frontend-package-manifest' || asset.id === 'frontend-package-lock')
    .map((asset) => [asset.id, asset]));
  const currentNode = modernRelease.plugins.find((plugin) =>
    plugin.category === 'stack' && plugin.id === 'node-fastify');
  const currentPython = modernRelease.plugins.find((plugin) =>
    plugin.category === 'stack' && plugin.id === 'python-fastapi');
  if (currentFrontendAssets.size !== 2 || currentNode === undefined || currentPython === undefined) {
    throw new Error('Current template release is missing the retained modern compatibility closure.');
  }
  return createPluginRegistry({
    ...source,
    descriptors: source.descriptors.map(descriptor => descriptor.category === 'stack' &&
      (descriptor.id === 'node-fastify' || descriptor.id === 'python-fastapi')
      ? { ...descriptor, contentVersion: descriptor.id === 'node-fastify' ? currentNode.contentVersion : currentPython.contentVersion } : descriptor),
    release: {
      ...source.release,
      sharedAssets: source.release.sharedAssets.map((asset) =>
        currentFrontendAssets.get(asset.id) ?? asset),
      plugins: source.release.plugins.map((plugin) =>
        plugin.category === 'stack' && plugin.id === 'node-fastify' ? currentNode :
          plugin.category === 'stack' && plugin.id === 'python-fastapi' ? currentPython : plugin)
    },
    assets
  });
}

export function createModernPreAssessmentRegistry(read: ModernAssetReader = readModernPreAssessmentAssets): PluginRegistry {
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
  return createModernCompatibilityRegistry(modernPreAssessmentSource, assets);
}

export function modernPreAssessmentRegistry(): PluginRegistry {
  preAssessmentRegistry ??= createModernPreAssessmentRegistry();
  return preAssessmentRegistry;
}

/** Custody4 declarations with current template bytes; original metadata remains separate from execution. */
export function modernPreWorkflowRegistry(): PluginRegistry {
  if (!preWorkflowRegistry) {
    const declarations = [
      ...modernPreWorkflowSource.core.sharedAssets.map(asset => ({ ...asset, owner: { kind: 'core' as const } })),
      ...modernPreWorkflowSource.descriptors.flatMap(descriptor => descriptor.assets.map(asset => ({
        ...asset, owner: { kind: 'plugin' as const, category: descriptor.category, id: descriptor.id }
      })))
    ];
    const bytes = readDeclaredAssetBytes(declarations, {
      maxAssetBytes: pluginRegistryLimits.maxAssetBytes,
      maxTotalAssetBytes: pluginRegistryLimits.maxTotalAssetBytes,
      maxPathParts: pluginRegistryLimits.maxPathParts,
      maxPartLength: pluginRegistryLimits.maxStringLength
    }).map(asset => asset.pathParts.join('/') === 'assets/governance/modern/source-contracts.json'
      ? { ...asset, bytes: Buffer.from(modernPreWorkflowGovernanceSourceContracts, 'utf8') } : asset);
    preWorkflowRegistry = createModernCompatibilityRegistry(modernPreWorkflowSource, bytes);
  }
  return preWorkflowRegistry;
}

interface ModernMetadataFamily {
  readonly declarationsDigest: string;
  readonly sharedAssets: readonly AssetDigest[];
  readonly plugins: readonly ResolvedPlugin[];
}

function matchesRetainedModernPlugins(
  recorded: ManifestPluginMetadata, resolution: PluginResolution,
  declarations: Omit<PluginRegistryInput, 'assets'>, registry: PluginRegistry,
  expectedDeclarationsDigest: string, families: readonly ModernMetadataFamily[]
): boolean {
  const historicalResolution = registry.resolveSelection(resolution.selection, { platform: resolution.hostPlatform });
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
    descriptors: declarations.descriptors.map(({ contentVersion: _version, ...descriptor }) => descriptor),
    core: declarations.core, selectionSpace: declarations.selectionSpace, operations: declarations.operations
  })}`;
  if (declarationsDigest !== expectedDeclarationsDigest) {
    throw new Error('Frozen modern source declarations do not match their captured identity.');
  }
  const originalFamily = {
    declarationsDigest: expectedDeclarationsDigest,
    sharedAssets: declarations.release.sharedAssets.map(({ id, sha256 }) => ({ id, sha256 })),
    plugins: declarations.release.plugins.map(
      ({ category, id, apiVersion, contentVersion, contentDigest }) =>
        ({ category, id, apiVersion, contentVersion, contentDigest })
    )
  };
  return [...families, originalFamily].some((family) => {
    const familySharedAssets = [...family.sharedAssets]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const historicalSharedAssetIds = historicalResolution.sharedAssets.map(({ id }) => id).sort();
    if (declarationsDigest !== family.declarationsDigest ||
        canonicalJson(historicalSharedAssetIds) !== canonicalJson(familySharedAssets.map(({ id }) => id))) {
      return false;
    }
    const plugins = historicalResolution.plugins.map((plugin) => family.plugins.find((entry) =>
      entry.category === plugin.category && entry.id === plugin.id && entry.apiVersion === plugin.apiVersion));
    if (plugins.some((plugin) => plugin === undefined)) return false;
    const { hostPlatform: _host, digest: _digest, ...historicalSemantic } = historicalResolution;
    const historical = plugins.filter((plugin) => plugin !== undefined);
    return manifestPluginMetadataMatches(recorded, readManifestPluginMetadata({
      schemaVersion: 1, resolutionDigest: pluginResolutionDigest({
        ...historicalSemantic, sharedAssets: familySharedAssets, plugins: historical
      }),
      selections: historical
    }, {
      stack: resolution.selection.stack, cloud: resolution.selection.cloud,
      workflow: resolution.selection.workflow, agents: resolution.selection.agents
    }));
  });
}

/** Recognizes exact original custody4 metadata, never the current5 family or execution permission. */
export function matchesPreWorkflowModernPlugins(recorded: ManifestPluginMetadata, resolution: PluginResolution): boolean {
  return matchesRetainedModernPlugins(recorded, resolution, modernPreWorkflowSource, modernPreWorkflowRegistry(),
    modernPreWorkflowDeclarationsDigest, [modernPythonPreviousReleases.preWorkflow]);
}

/** Recognizes exact pinned source families, never old template bytes or execution permission. */
export function matchesHistoricalModernPlugins(recorded: ManifestPluginMetadata, resolution: PluginResolution): boolean {
  return matchesRetainedModernPlugins(recorded, resolution, modernPreAssessmentSource, modernPreAssessmentRegistry(),
    modernPreAssessmentDeclarationsDigest, [
      modernHistoricalRelease, modernPreviousRelease, modernPythonPreviousReleases.preAssessment
    ]);
}
