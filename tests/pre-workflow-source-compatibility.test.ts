import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseProjectManifest, resolveModernManifestV8Source } from '../src/application/project/manifest.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import {
  matchesHistoricalModernPlugins, matchesPreWorkflowModernPlugins, modernPreWorkflowRegistry, modernSourceRegistry
} from '../src/application/project/modern-plugins.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { projectTelemetryDimensions } from '../src/application/project/telemetry.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import type { ManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { PluginResolution } from '../src/plugins/contracts.js';
import {
  modernPreWorkflowDeclarationsDigest, modernPreWorkflowGovernanceSourceContracts, modernPreWorkflowSource
} from '../src/plugins/builtin/modern-pre-workflow.js';
import { modernRelease } from '../src/plugins/builtin/modern-release.js';

interface OriginalSource {
  kind: string;
  sourceCommit: string;
  sourceTree: string;
  registry: { pluginSetDigest: string; coreContributionDigest: string; registryDigest: string };
  cases: {
    profile: 'single-maintainer-gitflow' | 'team-gitflow';
    workflow: 'manual' | 'openspec' | 'spec-kit';
    frontend: boolean;
    request: {
      selection: { project: unknown; framework: unknown; profile: 'single-maintainer-gitflow' | 'team-gitflow' };
      recordedPlugins: ManifestPluginMetadata;
    };
    sourceIdentity: unknown;
  }[];
}
const bytes = readFileSync(new URL('./fixtures/pre-workflow-before-audit-source.json', import.meta.url));
const original: OriginalSource = JSON.parse(bytes.toString('utf8'));
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function specimen(entry: OriginalSource['cases'][number]) {
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: entry.request.selection.project, framework: entry.request.selection.framework
  });
  const work = leaf.project.workload;
  const selected = {
    workload: work.kind, ...(work.kind === 'genai' ? { variant: work.pattern } : {}),
    stack: work.apiStack, cloud: work.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents,
    frontend: work.frontend ? 'included' as const : 'omitted' as const,
    governanceProfile: entry.profile, environments: work.environments
  };
  const input = {
    selection: { ...leaf, profile: entry.profile }, plugins: entry.request.recordedPlugins,
    activeLayout: { schemaVersion: 1 as const, state: 'unresolved' as const, bindings: [] }
  };
  const target = modernSourceRegistry().resolveSelection(selected, { platform: 'linux/arm64' });
  const retained = composeModernManifestPlugins(selected, { safeProjectName: toSafeProjectName(leaf.project.name) },
    modernPreWorkflowRegistry()).resolution;
  return { leaf, input, target, retained };
}

describe('original custody4 metadata survives the reviewed dependency refresh', () => {
  it('pins the actual clean-parent capture without restoring executable or lock bytes', () => {
    expect(digest(bytes)).toBe('7695a0d71e529e5b0595170c78e4e89676906b257b05b9061fdc3780251fd367');
    expect(original.kind).toBe('original-custody4-metadata-only-before-dependency-composition');
    expect(original.sourceCommit).toBe('7e2b74e7e1adc8346c41a17a0c31e000250bdd3f');
    expect(original.sourceTree).toBe('66affa04d8c0eab4dbadfe925da58e4c4736afaf');
    expect(original.registry).toEqual({
      pluginSetDigest: 'sha256:16942ffaa2ee9ec4459e91935f550fce39ec97f5cfe146331713b3bd06ba4113',
      coreContributionDigest: 'sha256:6ad4e1c51410ecc5f9f8189482dc36f258c0125b272f60bf4a46f06410da547c',
      registryDigest: 'sha256:1e9632b5200f945536955f1078ca4194c4f9a56bd712d810ec69f8faac7d61b0'
    });
    expect(original.cases).toHaveLength(12);
    expect(modernPreWorkflowDeclarationsDigest)
      .toBe('sha256:57365e5bf84030cb1647e5cde6c18ac3b851f3696e61cb02678748c8942c6f25');
    expect(digest(modernPreWorkflowGovernanceSourceContracts))
      .toBe('74023432198c9eed026a3600a9f37cc1bb39dcda373a16929dd72b1f1b49731f');
    expect(modernPreWorkflowSource.release.plugins.find(plugin => plugin.id === 'node-fastify')?.contentVersion).toBe(3);
  });

  it.each(original.cases)(
    'reads original $profile/$workflow/frontend=$frontend with its exact identity and unchanged recorded metadata', entry => {
      const before = canonicalJson(entry), { leaf, input, target, retained } = specimen(entry);
      expect(matchesPreWorkflowModernPlugins(entry.request.recordedPlugins, target)).toBe(true);
      expect(matchesPreWorkflowModernPlugins(entry.request.recordedPlugins, retained)).toBe(true);
      expect(matchesHistoricalModernPlugins(entry.request.recordedPlugins, target)).toBe(false);
      const resolved = resolveModernManifestV8Source(entry.request);
      expect(resolved.release).toBe('pre-workflow');
      expect(resolved.contract.plugins).toEqual(entry.request.recordedPlugins);
      expect(resolved.contract.governanceSource).toHaveProperty('identity', entry.sourceIdentity);
      expect(resolved.contract.plugins.selections.find(plugin => plugin.id === 'node-fastify')).toMatchObject({
        contentVersion: 3, contentDigest: 'sha256:2140749905f08e15db0e18c0b0b97ffd72a9f7fb30ae5469c7678822e1dcee7c'
      });
      expect(retained.plugins.find(plugin => plugin.id === 'node-fastify')?.contentVersion).toBe(5);
      const contexts = createModernGovernanceContextContract({
        catalog: projectCatalog, resolveSourceContract: value => resolveModernManifestV8Source(value).contract
      });
      const context = contexts.buildModernGovernanceContext(input), core = buildModernManagedCore(input);
      const manifest = parseProjectManifest({
        artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.13.0-dev.0',
        project: leaf.project, framework: leaf.framework, plugins: input.plugins, activeLayout: input.activeLayout,
        governance: { profile: entry.profile, policyVersion: context.governance.policyVersion, state: 'handoff-generated',
          activationIdentity: context.governance.activationIdentity },
        managedArtifacts: core.map(file => ({
          logicalName: file.logicalName, category: file.category, pathParts: file.pathParts, contentHash: `sha256:${digest(file.content)}`
        })),
        projectArtifacts: [], adoptionObservations: []
      });
      if (manifest.artifactVersion !== 8) throw new Error('Expected the original custody4 v8 source.');
      expect(manifest.governance).toHaveProperty('activationIdentity.activationContractVersion', 4);
      expect(() => projectTelemetryDimensions(manifest)).toThrow('Historical source plugin metadata');
      const maintained = createManifestV8Candidate({
        origin: 'maintenance', source: manifest,
        managed: manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
      }).manifest;
      expect(maintained.plugins).toEqual(input.plugins);
      expect(maintained.governance).toEqual(manifest.governance);
      expect(maintained.activeLayout).toEqual(input.activeLayout);
      expect(canonicalJson(entry)).toBe(before);
    }
  );

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])(
    'refuses changed original %s instead of borrowing either family', field => {
      for (const entry of original.cases) {
        const { target } = specimen(entry), changed = structuredClone(entry.request);
        if (field === 'resolutionDigest') Reflect.set(changed.recordedPlugins, field, `sha256:${'f'.repeat(64)}`);
        else Reflect.set(changed.recordedPlugins.selections[0], field,
          field === 'contentDigest' ? `sha256:${'f'.repeat(64)}` : 99);
        expect(matchesPreWorkflowModernPlugins(changed.recordedPlugins, target)).toBe(false);
        expect(() => resolveModernManifestV8Source(changed)).toThrow();
      }
    }
  );

  it.each([
    ['environment', (value: PluginResolution) => Reflect.set(value.selection, 'environments', ['prod'])],
    ['frontend', (value: PluginResolution) => Reflect.set(value.selection, 'frontend', 'included')],
    ['artifact', (value: PluginResolution) => Reflect.set(value.artifacts[0], 'pathParts', ['changed'])],
    ['checks', (value: PluginResolution) => Reflect.set(value, 'checks', [{ operation: 'foreign' }])],
    ['shared asset', (value: PluginResolution) => Reflect.set(value.sharedAssets[0], 'sha256', `sha256:${'e'.repeat(64)}`)],
    ['plugin', (value: PluginResolution) => Reflect.set(value.plugins[0], 'id', 'foreign')]
  ] as const)('refuses substituted %s semantics', (_label, change) => {
    const { target } = specimen(original.cases[0]), changed = structuredClone(target);
    change(changed);
    expect(matchesPreWorkflowModernPlugins(original.cases[0].request.recordedPlugins, changed)).toBe(false);
  });

  it('verifies the real current Node/frontend bytes instead of manufacturing the original registry identity', () => {
    const registry = modernPreWorkflowRegistry();
    expect(registry.registryDigest).not.toBe(original.registry.registryDigest);
    const node = modernRelease.plugins.find(plugin => plugin.id === 'node-fastify');
    const lock = node?.assets.find(asset => asset.pathParts.join('/') === 'assets/plugins/node-fastify/node-backend/package-lock.json');
    if (!lock) throw new Error('Expected the actual current Node backend lock.');
    const backend = registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'node-fastify' }).own[lock.id];
    const frontend = registry.assetsFor({ kind: 'core' }).own['frontend-package-lock'];
    expect(backend).toBe(readFileSync(lock.pathParts.join('/'), 'utf8'));
    expect(frontend).toBe(readFileSync('assets/templates/common/frontend/package-lock.json', 'utf8'));
    if (typeof backend !== 'string' || typeof frontend !== 'string') throw new Error('Expected verified current lock texts.');
    for (const lockBytes of [backend, frontend]) {
      expect(JSON.parse(lockBytes).packages['node_modules/source-map-js'].version).toBe('1.2.2');
    }
  });
});
