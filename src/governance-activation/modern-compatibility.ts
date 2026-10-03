import { parseManifest } from '../application/project/manifest.js';
import { createManifestV8Reader, type ManifestV8ReaderContext, type ManifestV8SourceContract } from '../domain/project/manifest/v8.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../domain/project/manifest/v8-project.js';
import { exactRecord } from '../domain/project/manifest/fields.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata, type ManifestPluginMetadata } from '../domain/project/manifest/plugins.js';
import { manifestActiveLayoutDigest, validateManifestActiveLayout } from '../domain/project/manifest/layout.js';
import type { ManifestActiveLayout } from '../domain/project/contracts.js';
import { createModernActivationIdentityReader } from '../domain/governance/activation/modern-identity.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { assertModernRecordData } from '../domain/governance/activation/source-values.js';
import { freezeModernValue, modernPhaseContractDigests } from '../domain/governance/activation/modern-graph.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity } from '../domain/governance/policy/identity.js';
import type { ModernActivationSourceInput, ModernGovernanceProfile, ModernPhaseId, ReadableModernActivationIdentity } from '../domain/governance/activation/modern-record-contracts.js';
import type { ReleasedActivationIdentity } from '../domain/governance/policy/identity.js';

export interface ModernCompatibilityMetadata {
  readonly schemaVersion: 5;
  readonly generatedBy: 'Mission Control Liftoff';
  readonly sourceVersion: '0.13.0-dev.0';
  readonly manifest: { readonly targetArtifactVersion: 8; readonly readableSourceVersions: readonly [2, 3, 4, 5, 6, 7, 8] };
  readonly activation: {
    readonly targetIdentity: ReadableModernActivationIdentity;
    readonly readableReleasedSources: readonly { readonly identity: ReleasedActivationIdentity; readonly reader: 'activation-v1' | 'activation-v2' | 'activation-v3' }[];
    readonly targetPhaseContracts: readonly { readonly phaseId: ModernPhaseId; readonly digest: string }[];
    readonly successorLanes: readonly {
      readonly id: 'activation-v1-to-v4' | 'activation-v2-to-v4' | 'activation-v3-to-v4';
      readonly sourceIdentity: ReleasedActivationIdentity;
      readonly targetIdentity: ReadableModernActivationIdentity;
      readonly sourceWorkflow: 'openspec' | 'spec-kit';
      readonly strategy: 'preserve-history-revalidate';
      readonly profileTransition: 'preserve';
    }[];
    readonly execution: 'source-contract-only';
  };
  readonly managedCore: {
    readonly inventory: readonly { readonly logicalName: string; readonly category: string; readonly pathParts: readonly string[]; readonly lifecycle: 'managed-core' }[];
    readonly contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash';
  };
}

export interface ModernCompatibilitySourceInput {
  readonly selection: ManifestV8ProjectLeaf & { readonly profile: ModernGovernanceProfile };
  readonly plugins: ManifestPluginMetadata;
  readonly activeLayout: ManifestActiveLayout;
}

/** Complete readable sources, not installed executable compatibility or a manifest writer. */
export function createModernCompatibilityContract(context: ManifestV8ReaderContext) {
  const { parseManifestV8 } = createManifestV8Reader(context);
  const released = [
    { identity: historicalV1ActivationIdentity, reader: 'activation-v1', lane: 'activation-v1-to-v4' },
    { identity: historicalV2ActivationIdentity, reader: 'activation-v2', lane: 'activation-v2-to-v4' },
    { identity: releasedV3ActivationIdentity, reader: 'activation-v3', lane: 'activation-v3-to-v4' }
  ] as const;
  function readSourceManifest(value: unknown) {
    assertModernRecordData(value, 'compatibility source manifest');
    const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'artifactVersion')?.value : undefined;
    return version === 8 ? parseManifestV8(value) : parseManifest(value);
  }
  function buildModernCompatibilityMetadata(value: unknown): ModernCompatibilityMetadata {
    const manifest = parseManifestV8(value);
    if (manifest.governance.profile === 'none') throw new Error('Disabled governance has no activation compatibility record.');
    const identity = manifest.governance.activationIdentity;
    const leaf = createManifestV8ProjectReader(context.catalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
    const source = context.resolveSourceContract({ selection: { ...leaf, profile: manifest.governance.profile },
      recordedPlugins: manifest.plugins });
    if (!('identity' in source.governanceSource)) throw new Error('Enabled compatibility requires the actual governance source contract.');
    return assembleMetadata(identity, manifest.project.specWorkflow, source);
  }
  function buildModernCompatibilityMetadataForSource(value: unknown): ModernCompatibilityMetadata {
    assertModernRecordData(value, 'modern compatibility source');
    const request = exactRecord(value, ['selection', 'plugins', 'activeLayout'], 'Modern compatibility source');
    const selection = exactRecord(request.selection, ['project', 'framework', 'profile'], 'Modern compatibility selection');
    const leaf = createManifestV8ProjectReader(context.catalog).validateManifestV8Project({
      project: selection.project, framework: selection.framework
    });
    const profile = selection.profile;
    if (profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
      throw new Error('Enabled compatibility requires a supported governance profile; none has no activation compatibility record.');
    }
    const plugins = readManifestPluginMetadata(request.plugins, {
      stack: leaf.project.workload.apiStack, cloud: leaf.project.workload.cloud,
      workflow: leaf.project.specWorkflow, agents: leaf.project.agents
    });
    const source = context.resolveSourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
    if (!manifestPluginMetadataMatches(plugins, source.plugins)) throw new Error('Modern compatibility plugins do not match the exact source resolution.');
    if (!('identity' in source.governanceSource) || source.governanceSource.identity.profile !== profile ||
      source.governanceSource.identity.workflow !== leaf.project.specWorkflow) {
      throw new Error('Enabled compatibility requires the exact profile/workflow source contract.');
    }
    const activeLayout = validateManifestActiveLayout(request.activeLayout, source.layoutDescriptor);
    const staticIdentity = source.governanceSource.identity;
    const reader = createModernActivationIdentityReader(context.catalog);
    const input: Omit<ModernActivationSourceInput, 'recordedIdentity'> = {
      profile, policyVersion: staticIdentity.policyVersion, selection: { ...leaf, profile },
      pluginResolutionDigest: plugins.resolutionDigest, activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor)
    };
    const identity = reader.validateReadableModernActivationIdentity({
      ...input, recordedIdentity: reader.identityForSource({ ...input, sourceVersion: staticIdentity.liftoffVersion })
    });
    if (Object.entries(staticIdentity).some(([key, value]) => !Object.hasOwn(identity, key) || Reflect.get(identity, key) !== value) ||
      canonicalSha256(source.governanceSource.graph) !== identity.phaseGraphHash) {
      throw new Error('Modern compatibility graph and policy differ from the authoritative source contract.');
    }
    return assembleMetadata(identity, leaf.project.specWorkflow, source);
  }
  function assembleMetadata(
    identity: ReadableModernActivationIdentity, workflow: ManifestV8ProjectLeaf['project']['specWorkflow'],
    source: ManifestV8SourceContract
  ): ModernCompatibilityMetadata {
    if (!('identity' in source.governanceSource)) throw new Error('Enabled compatibility requires the actual governance source contract.');
    const graph = source.governanceSource.graph, digests = modernPhaseContractDigests(graph);
    return freezeModernValue({
      schemaVersion: 5, generatedBy: 'Mission Control Liftoff', sourceVersion: identity.liftoffVersion,
      manifest: { targetArtifactVersion: 8, readableSourceVersions: [2, 3, 4, 5, 6, 7, 8] },
      activation: {
        targetIdentity: identity,
        readableReleasedSources: released.map(({ identity, reader }) => ({ identity: { ...identity }, reader })),
        targetPhaseContracts: graph.phases.map(phase => ({ phaseId: phase.id, digest: digests[phase.id]! })),
        successorLanes: identity.profile === 'single-maintainer-gitflow' && workflow !== 'manual' ? released.map(source => ({
          id: source.lane, sourceIdentity: { ...source.identity }, targetIdentity: identity, sourceWorkflow: workflow,
          strategy: 'preserve-history-revalidate', profileTransition: 'preserve'
        })) : [],
        execution: 'source-contract-only'
      },
      managedCore: {
        inventory: source.managedArtifacts.map(artifact => ({ ...artifact, pathParts: [...artifact.pathParts], lifecycle: 'managed-core' })),
        contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
      }
    });
  }
  function validateModernCompatibilityMetadata(value: unknown, manifest: unknown): ModernCompatibilityMetadata {
    assertModernRecordData(value, 'modern compatibility');
    const expected = buildModernCompatibilityMetadata(manifest);
    if (canonicalSha256(value) !== canonicalSha256(expected)) throw new Error('Compatibility5 differs from the exact independently resolved source contract.');
    return expected;
  }
  return Object.freeze({ readSourceManifest, buildModernCompatibilityMetadata, validateModernCompatibilityMetadata, buildModernCompatibilityMetadataForSource });
}
