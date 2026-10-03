import { createHash } from 'node:crypto';
import { readDeclaredAssetBytes, type DeclaredPackagedAsset, type PackagedAssetReadBounds } from '../../adapters/packaged-assets/plugin-assets.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';
import { modernAssets, modernGovernanceAssets, modernRegistryInput } from '../../plugins/builtin/modern.js';
import { modernRelease } from '../../plugins/builtin/modern-release.js';
import { pluginRegistryLimits, type PackagedAssetBytes, type PluginRegistry } from '../../plugins/contracts.js';
import { createPluginRegistry } from '../../plugins/registry.js';

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
