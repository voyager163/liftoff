import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { composeModernManifestPlugins, composeManifestPlugins } from '../src/application/project/plugins.js';
import { resolveModernManifestV8SourceContract, parseManifest } from '../src/application/project/manifest.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import { createModernCompatibilityContract } from '../src/governance-activation/modern-compatibility.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { validateReleasedV3CompatibilityMetadata } from '../src/governance-activation/compatibility.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import type { GeneratedArtifact } from '../src/domain/project/contracts.js';
import type { ModernCompatibilityMetadata } from '../src/governance-activation/modern-compatibility.js';

const api = createModernCompatibilityContract({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
function sourceContext(profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow', workflow: 'openspec' | 'spec-kit' | 'manual', legacy = false) {
  const agents = workflow === 'manual' || legacy ? [] : ['github-copilot'];
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: { name: 'compatibility-fixture', workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
      frontend: false, environments: ['dev'] }, specWorkflow: workflow, agents,
      ...(workflow === 'spec-kit' && !legacy ? { defaultAgent: 'github-copilot' } : {}) },
    framework: workflow === 'manual' ? { state: 'not-required' } : legacy ? { state: 'legacy', adapter: workflow } :
      { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' }
  });
  const composition = composeModernManifestPlugins({ workload: 'standard', stack: 'node-fastify', cloud: 'azure', workflow, agents,
    environments: ['dev'], frontend: 'omitted', governanceProfile: profile }, { safeProjectName: 'compatibility-fixture' });
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins },
    { stack: 'node-fastify', cloud: 'azure', workflow, agents });
  const source = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
  const activeLayout = { schemaVersion: 1, state: 'unresolved', bindings: [] };
  return { leaf, plugins, source, activeLayout, composition };
}
function manifest(profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow', workflow: 'openspec' | 'spec-kit' | 'manual', legacy = false) {
  const { leaf, plugins, source, activeLayout } = sourceContext(profile, workflow, legacy);
  const governance = profile === 'none' ? { profile, state: 'disabled' } : (() => {
    if (!('identity' in source.governanceSource)) throw new Error('Required actual source.');
    return { profile, policyVersion: source.governanceSource.identity.policyVersion, state: 'handoff-generated',
      activationIdentity: createModernActivationIdentityReader(projectCatalog).identityForSource({
        sourceVersion: source.governanceSource.identity.liftoffVersion, profile, policyVersion: source.governanceSource.identity.policyVersion,
        selection: { ...leaf, profile }, pluginResolutionDigest: plugins.resolutionDigest,
        activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor)
      }) };
  })();
  return { artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.13.0-dev.0',
    ...leaf, governance, plugins, activeLayout,
    managedArtifacts: source.managedArtifacts.map(artifact => ({ ...artifact, contentHash: `sha256:${canonicalSha256({ observedFixtureArtifact: artifact.logicalName })}` })),
    projectArtifacts: [], adoptionObservations: [] };
}
describe('compatibility5 with actual complete v8 root and source context', () => {
  it.each((['single-maintainer-gitflow', 'team-gitflow'] as const).flatMap(profile =>
    (['openspec', 'spec-kit', 'manual'] as const).map(workflow => ({ profile, workflow }))))(
    'validates complete $profile/$workflow roots and preserves same-intent lanes', ({ profile, workflow }) => {
      const source = manifest(profile, workflow), before = structuredClone(source), result = api.buildModernCompatibilityMetadata(source);
      expect(result.schemaVersion).toBe(5);
      expect(result.manifest.readableSourceVersions).toEqual([2, 3, 4, 5, 6, 7, 8]);
      expect(result.activation.execution).toBe('source-contract-only');
      expect(result.activation.targetPhaseContracts).toHaveLength(29);
      expect(result.activation.successorLanes).toHaveLength(profile === 'single-maintainer-gitflow' && workflow !== 'manual' ? 3 : 0);
      for (const lane of result.activation.successorLanes) {
        expect(lane.sourceWorkflow).toBe(workflow); expect(lane.profileTransition).toBe('preserve');
        expect(lane.targetIdentity).toEqual(result.activation.targetIdentity);
      }
      expect(api.validateModernCompatibilityMetadata(result, source)).toEqual(result);
      expect(source).toEqual(before);
      expect(Object.isFrozen(result.managedCore.inventory)).toBe(true);
      expect(() => parseManifest(source)).toThrow(/Unsupported manifest artifactVersion 8/);
      expect(() => validateReleasedV3CompatibilityMetadata(result)).toThrow();
    }
  );
  it('reads none roots without inventing activation and retains historical root interpretation', () => {
    expect(api.readSourceManifest(manifest('none', 'manual')).governance).toEqual({ profile: 'none', state: 'disabled' });
    expect(() => api.buildModernCompatibilityMetadata(manifest('none', 'manual'))).toThrow(/no activation/);
    expect(api.readSourceManifest(capturedV3Records().manifest)).toEqual(parseManifest(capturedV3Records().manifest));
  });

  describe('neutral source compatibility without a fabricated root or artifact hashes', () => {
    it.each((['single-maintainer-gitflow', 'team-gitflow'] as const).flatMap(profile =>
      (['openspec', 'spec-kit', 'manual'] as const).map(workflow => ({ profile, workflow }))))(
      'matches completed W1 root bytes for actual $profile/$workflow source', ({ profile, workflow }) => {
        const { leaf, source, plugins, composition } = sourceContext(profile, workflow);
        if (!('identity' in source.governanceSource)) throw new Error('Actual enabled source required.');
        const governanceSource = source.governanceSource;
        const activeLayout = { schemaVersion: 1, state: 'bound', bindings: composition.expected
          .filter(artifact => artifact.lifecycle === 'project').map(artifact => ({
            kind: 'artifact', logicalName: artifact.logicalName, pathParts: artifact.pathParts
          })) };
        const input = { selection: { ...leaf, profile }, plugins, activeLayout }, before = structuredClone(input);
        const neutral = api.buildModernCompatibilityMetadataForSource(input);
        expectTypeOf(neutral).toEqualTypeOf<ModernCompatibilityMetadata>();
        // Other artifact content is actual synthetic fixture text, not a claim of a qualified G1 renderer.
        const generatedArtifacts: GeneratedArtifact[] = composition.expected.filter(artifact => artifact.lifecycle !== 'manifest').map(artifact => {
          const content = artifact.logicalName === 'repository-governance-policy' ? readFileSync(path.join(...governanceSource.policyPathParts), 'utf8') :
            artifact.logicalName === 'repository-governance-phase-graph' ? canonicalJson(governanceSource.graph) :
              artifact.logicalName === 'repository-governance-compatibility' ? canonicalJson(neutral) :
                `Synthetic recorded artifact bytes: ${artifact.logicalName}\n`;
          const base = { logicalName: artifact.logicalName, category: artifact.category, pathParts: [...artifact.pathParts], content };
          if (artifact.lifecycle === 'project') {
            if (!artifact.provisioningGroup) throw new Error('Project fixture requires actual declared provisioning group.');
            return { ...base, lifecycle: 'project', provisioningGroup: artifact.provisioningGroup };
          }
          if (artifact.lifecycle === 'manifest') throw new Error('Manifest is produced by W1, not caller supplied.');
          return { ...base, lifecycle: artifact.lifecycle };
        });
        const candidate = createManifestV8Candidate({ origin: 'fresh', selection: { ...leaf, profile }, generatedArtifacts });
        const completed = api.buildModernCompatibilityMetadata(JSON.parse(candidate.content));
        expect(canonicalJson(neutral)).toBe(canonicalJson(completed));
        expect(api.validateModernCompatibilityMetadata(neutral, candidate.manifest)).toEqual(neutral);
        expect(input).toEqual(before);
        expect(Object.isFrozen(input.activeLayout)).toBe(false);
        expect(Object.isFrozen(neutral.managedCore.inventory)).toBe(true);
      }
    );

    it.each(['openspec', 'spec-kit'] as const)('retains explicit %s legacy metadata and custom partial/unresolved layouts', workflow => {
      const { leaf, plugins } = sourceContext('single-maintainer-gitflow', workflow, true);
      for (const activeLayout of [
        { schemaVersion: 1, state: 'unresolved', bindings: [] },
        { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['Custom', 'Original API'] }] }
      ]) {
        const neutral = api.buildModernCompatibilityMetadataForSource({ selection: { ...leaf, profile: 'single-maintainer-gitflow' }, plugins, activeLayout });
        const source = manifest('single-maintainer-gitflow', workflow, true);
        Reflect.set(source, 'activeLayout', activeLayout);
        Reflect.set(source.governance, 'activationIdentity', neutral.activation.targetIdentity);
        expect(canonicalJson(api.buildModernCompatibilityMetadata(source))).toBe(canonicalJson(neutral));
        expect(leaf.framework).toEqual({ state: 'legacy', adapter: workflow });
        expect(leaf.project.agents).toEqual([]);
        expect(neutral.activation.execution).toBe('source-contract-only');
      }
    });

    it.each(['none', 'extra', 'missing', 'old-registry', 'wrong-selection', 'plugin-row', 'unsafe-layout', 'fake-identity', 'undefined'] as const)(
      'rejects incomplete or mismatched source input %s', scenario => {
        const { leaf, plugins, activeLayout } = sourceContext('single-maintainer-gitflow', 'openspec');
        const value = structuredClone({ selection: { ...leaf, profile: 'single-maintainer-gitflow' }, plugins, activeLayout });
        if (scenario === 'none') Reflect.set(value.selection, 'profile', 'none');
        if (scenario === 'extra') Reflect.set(value, 'managedArtifacts', []);
        if (scenario === 'missing') Reflect.deleteProperty(value, 'activeLayout');
        if (scenario === 'old-registry') {
          const original = composeManifestPlugins({ workload: 'standard', stack: 'node-fastify', cloud: 'azure',
            workflow: 'openspec', agents: ['github-copilot'], environments: ['dev'], frontend: 'omitted',
            governanceProfile: 'single-maintainer-gitflow' }, { safeProjectName: 'compatibility-fixture' });
          Reflect.set(value, 'plugins', readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: original.resolution.digest,
            selections: original.resolution.plugins }, { stack: 'node-fastify', cloud: 'azure', workflow: 'openspec', agents: ['github-copilot'] }));
        }
        if (scenario === 'wrong-selection') Reflect.set(value.selection, 'profile', 'team-gitflow');
        if (scenario === 'plugin-row') Reflect.set(value.plugins.selections[0], 'contentVersion', 99);
        if (scenario === 'unsafe-layout') Reflect.set(value, 'activeLayout', { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['..'] }] });
        if (scenario === 'fake-identity') Reflect.set(value, 'activationIdentity', { activationContractVersion: 4 });
        if (scenario === 'undefined') Reflect.set(value, 'plugins', undefined);
        expect(() => api.buildModernCompatibilityMetadataForSource(value)).toThrow();
      }
    );

    it.each(['project', 'plugins', 'binding'] as const)('rejects %s hooks before normalization or digesting', target => {
      const { leaf, plugins, activeLayout } = sourceContext('single-maintainer-gitflow', 'manual');
      const value = structuredClone({ selection: { ...leaf, profile: 'single-maintainer-gitflow' }, plugins, activeLayout });
      const getter = vi.fn(() => { throw new Error('unexpected getter'); });
      if (target === 'project') Object.defineProperty(value.selection.project, 'name', { enumerable: true, get: getter });
      if (target === 'plugins') Object.defineProperty(value.plugins, 'resolutionDigest', { enumerable: true, get: getter });
      if (target === 'binding') Object.defineProperty(value.activeLayout, 'bindings', { enumerable: true, get: getter });
      expect(() => api.buildModernCompatibilityMetadataForSource(value)).toThrow(/own enumerable/);
      expect(getter).not.toHaveBeenCalled();
    });
  });
  it('keeps external legacy uncertainty without manufacturing current initialization', () => {
    const value = manifest('single-maintainer-gitflow', 'spec-kit', true);
    expect(api.readSourceManifest(value).framework).toEqual({ state: 'legacy', adapter: 'spec-kit' });
    expect(api.buildModernCompatibilityMetadata(value).activation.successorLanes).toHaveLength(3);
  });
  it.each(['managed', 'plugins', 'layout', 'policy', 'observation', 'history'] as const)('requires complete root validity for %s', field => {
    const value = manifest('single-maintainer-gitflow', 'openspec');
    if (field === 'managed') value.managedArtifacts.pop();
    if (field === 'plugins') Reflect.set(value, 'plugins', { ...value.plugins, resolutionDigest: `sha256:${'f'.repeat(64)}` });
    if (field === 'layout') Reflect.set(value.activeLayout, 'state', 'bound');
    if (field === 'policy') Reflect.set(value.governance, 'policyVersion', '6');
    if (field === 'observation') Reflect.set(value, 'adoptionObservations', [{ logicalName: 'forged', pathParts: ['file'], observedHash: 'missing' }]);
    if (field === 'history') Reflect.set(value, 'sourceManifestHistory', null);
    expect(() => api.buildModernCompatibilityMetadata(value)).toThrow();
  });
  it.each(['lane', 'identity', 'phase', 'inventory', 'schema', 'authority'] as const)('rejects forged %s compatibility', field => {
    const source = manifest('single-maintainer-gitflow', 'openspec'), metadata = structuredClone(api.buildModernCompatibilityMetadata(source));
    if (field === 'lane') Reflect.set(metadata.activation.successorLanes[0], 'sourceWorkflow', 'manual');
    if (field === 'identity') Reflect.set(metadata.activation.targetIdentity, 'profile', 'team-gitflow');
    if (field === 'phase') Reflect.set(metadata.activation.targetPhaseContracts[0], 'digest', 'f'.repeat(64));
    if (field === 'inventory') Reflect.set(metadata.managedCore.inventory[0], 'pathParts', ['elsewhere']);
    if (field === 'schema') Reflect.set(metadata, 'schemaVersion', 4);
    if (field === 'authority') Reflect.set(metadata.activation, 'execution', 'current');
    expect(() => api.validateModernCompatibilityMetadata(metadata, source)).toThrow(/exact independently resolved/);
  });
});
