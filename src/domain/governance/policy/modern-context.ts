import { canonicalJson, canonicalSha256 } from '../activation/canonical-json.js';
import { createModernActivationIdentityReader } from '../activation/modern-identity.js';
import type { ModernActivationSourceInput, ModernGovernanceProfile, ReadableModernActivationIdentity } from '../activation/modern-record-contracts.js';
import { assertModernRecordData } from '../activation/source-values.js';
import { freezeModernValue } from '../activation/modern-graph.js';
import type { ManifestActiveLayout } from '../../project/contracts.js';
import { exactRecord } from '../../project/manifest/fields.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../../project/manifest/v8-project.js';
import type { ManifestV8ReaderContext } from '../../project/manifest/v8.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata, type ManifestPluginMetadata } from '../../project/manifest/plugins.js';
import { manifestActiveLayoutDigest, validateManifestActiveLayout } from '../../project/manifest/layout.js';

export type ModernGovernanceContext = ManifestV8ProjectLeaf & {
  readonly schemaVersion: 2;
  readonly kind: 'liftoff-governance-context';
  readonly execution: 'source-contract-only';
  readonly governance: {
    readonly profile: ModernGovernanceProfile;
    readonly policyVersion: string;
    readonly policyDigest: `sha256:${string}`;
    readonly activationIdentity: ReadableModernActivationIdentity;
    readonly liveEnforcement: 'not-observed';
  };
  readonly plugins: ManifestPluginMetadata;
  readonly activeLayout: ManifestActiveLayout;
  readonly sourceInterpretation: {
    readonly filesystemObservation: 'not-performed';
    readonly generationProvenance: 'not-inferred';
    readonly localVerification: 'requires-reviewed-operation';
    readonly externalDiscovery: 'not-performed';
  };
};

/** Private source context; no filesystem observations, command plans or execution capability are inferred. */
export function createModernGovernanceContextContract(context: ManifestV8ReaderContext) {
  const projectReader = createManifestV8ProjectReader(context.catalog);
  const identityReader = createModernActivationIdentityReader(context.catalog);

  function buildModernGovernanceContext(value: unknown): ModernGovernanceContext {
    assertModernRecordData(value, 'modern managed context source');
    const input = exactRecord(value, ['selection', 'plugins', 'activeLayout'], 'Modern managed context source');
    const selected = exactRecord(input.selection, ['project', 'framework', 'profile'], 'Modern managed context selection');
    const leaf = projectReader.validateManifestV8Project({ project: selected.project, framework: selected.framework });
    const profile = selected.profile;
    if (profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
      throw new Error('Modern governance context requires an enabled profile; none has no governance context.');
    }
    const plugins = readManifestPluginMetadata(input.plugins, {
      stack: leaf.project.workload.apiStack, cloud: leaf.project.workload.cloud,
      workflow: leaf.project.specWorkflow, agents: leaf.project.agents
    });
    const source = context.resolveSourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
    if (!manifestPluginMetadataMatches(plugins, source.plugins) || !('identity' in source.governanceSource) ||
      source.governanceSource.identity.profile !== profile || source.governanceSource.identity.workflow !== leaf.project.specWorkflow) {
      throw new Error('Modern governance context requires the exact independently resolved source identity.');
    }
    const activeLayout = validateManifestActiveLayout(input.activeLayout, source.layoutDescriptor);
    const row = source.governanceSource;
    const identityInput: Omit<ModernActivationSourceInput, 'recordedIdentity'> = {
      profile, policyVersion: row.identity.policyVersion, selection: { ...leaf, profile },
      pluginResolutionDigest: plugins.resolutionDigest,
      activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor)
    };
    const activationIdentity = identityReader.validateReadableModernActivationIdentity({
      ...identityInput,
      recordedIdentity: identityReader.identityForSource({ ...identityInput, sourceVersion: row.identity.liftoffVersion })
    });
    if (Object.entries(row.identity).some(([key, value]) => Reflect.get(activationIdentity, key) !== value) ||
      canonicalSha256(row.graph) !== activationIdentity.phaseGraphHash) {
      throw new Error('Modern context policy and graph do not match their authoritative source contract.');
    }
    return freezeModernValue({
      schemaVersion: 2, kind: 'liftoff-governance-context', execution: 'source-contract-only',
      ...leaf,
      governance: {
        profile, policyVersion: activationIdentity.policyVersion, policyDigest: activationIdentity.policyDigest,
        activationIdentity, liveEnforcement: 'not-observed'
      },
      plugins, activeLayout,
      sourceInterpretation: {
        filesystemObservation: 'not-performed', generationProvenance: 'not-inferred',
        localVerification: 'requires-reviewed-operation', externalDiscovery: 'not-performed'
      }
    });
  }

  function validateModernGovernanceContext(value: unknown): ModernGovernanceContext {
    assertModernRecordData(value, 'modern managed context');
    const input = exactRecord(value, [
      'schemaVersion', 'kind', 'execution', 'project', 'framework', 'governance',
      'plugins', 'activeLayout', 'sourceInterpretation'
    ], 'Modern managed context');
    const governance = exactRecord(input.governance,
      ['profile', 'policyVersion', 'policyDigest', 'activationIdentity', 'liveEnforcement'], 'Modern managed context governance');
    const expected = buildModernGovernanceContext({
      selection: { project: input.project, framework: input.framework, profile: governance.profile },
      plugins: input.plugins, activeLayout: input.activeLayout
    });
    if (canonicalJson(input) !== canonicalJson(expected)) {
      throw new Error('Modern managed context differs from its exact source-only interpretation.');
    }
    return expected;
  }

  return Object.freeze({ buildModernGovernanceContext, validateModernGovernanceContext });
}
