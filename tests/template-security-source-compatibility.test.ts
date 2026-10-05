import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { parseProjectManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { composeModernManifestPlugins, pluginSelectionForPlan } from '../src/application/project/plugins.js';
import { matchesHistoricalModernPlugins, modernPreAssessmentRegistry } from '../src/application/project/modern-plugins.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { modernProjectSourceInput, resolveModernManifestSourceContext } from '../src/application/project/source-context.js';
import { projectTelemetryDimensions } from '../src/application/project/telemetry.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import type { PluginResolution, ResolvedPlugin } from '../src/plugins/contracts.js';
import { modernHistoricalRelease } from '../src/plugins/builtin/modern-historical-release.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';

const baseline: {
  sourceRevision: string;
  declarationsDigest: string;
  plugins: ResolvedPlugin[];
  cases: { options: ProjectOptions; manifest: unknown }[];
} = JSON.parse(readFileSync(new URL('./fixtures/template-security-source-baseline.json', import.meta.url), 'utf8'));

function specimen(entry = baseline.cases[0]) {
  const plan = buildCurrentProjectPlan(entry.options, { requireProjectName: true });
  const composition = composeModernManifestPlugins(pluginSelectionForPlan(plan), { safeProjectName: plan.safeProjectName });
  const sourceComposition = composeModernManifestPlugins(
    pluginSelectionForPlan(plan), { safeProjectName: plan.safeProjectName }, modernPreAssessmentRegistry()
  );
  const manifest = parseProjectManifest(entry.manifest);
  if (manifest.artifactVersion !== 8) throw new Error('Expected a frozen v8 source.');
  const selection = { project: manifest.project, framework: manifest.framework, profile: manifest.governance.profile };
  return { manifest, composition, sourceComposition, selection };
}

describe('template security refresh preserves exact historical source contracts', () => {
  it('pins the independently captured pre-refresh family, not an inferred version interval', () => {
    expect(baseline.sourceRevision).toBe('289e703301dd14257d737b620b282bbaee86a845');
    expect(modernHistoricalRelease.sourceRevision).toBe(baseline.sourceRevision);
    expect(modernHistoricalRelease.declarationsDigest).toBe(baseline.declarationsDigest);
    expect(modernHistoricalRelease.plugins).toEqual(baseline.plugins);
    expect(baseline.cases).toHaveLength(10);
  });

  it.each(baseline.cases.map((entry, index) => ({ ...entry, index })))(
    'reads and maintains original source $index without retagging plugin identity or provenance', (entry) => {
      const before = canonicalJson(entry.manifest);
      const { manifest, composition, sourceComposition, selection } = specimen(entry);
      expect(manifest).toEqual(entry.manifest);
      expect(matchesHistoricalModernPlugins(manifest.plugins, composition.resolution)).toBe(true);
      const source = resolveModernManifestV8SourceContract({ selection, recordedPlugins: manifest.plugins });
      expect(source.plugins).toEqual(manifest.plugins);
      const shared = resolveModernManifestSourceContext(manifest);
      expect(shared.source).toEqual(source);
      expect(shared.plugins).toEqual(manifest.plugins);
      expect(shared.activeLayout).toEqual(manifest.activeLayout);
      expect(modernProjectSourceInput(manifest)).toEqual({
        selection, plugins: manifest.plugins, activeLayout: manifest.activeLayout
      });
      expect(source.managedArtifacts).toEqual(sourceComposition.expected.filter(artifact => artifact.lifecycle === 'managed-core')
        .map(({ logicalName, category, pathParts }) => ({ logicalName, category, pathParts })));
      const core = buildModernManagedCore({ selection, plugins: manifest.plugins, activeLayout: manifest.activeLayout });
      expect(core.map(artifact => artifact.logicalName)).toEqual(source.managedArtifacts.map(artifact => artifact.logicalName));
      const maintained = createManifestV8Candidate({
        origin: 'maintenance', source: entry.manifest,
        managed: manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
      }).manifest;
      expect(maintained.plugins).toEqual(manifest.plugins);
      expect(maintained.governance).toEqual(manifest.governance);
      expect(maintained.projectArtifacts).toEqual(manifest.projectArtifacts);
      expect(maintained.activeLayout).toEqual(manifest.activeLayout);
      expect(canonicalJson(entry.manifest)).toBe(before);
    }
  );

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])(
    'rejects changed historical %s rather than matching plugin IDs alone', (field) => {
      const { manifest, selection } = specimen();
      const plugins = structuredClone(manifest.plugins);
      if (field === 'resolutionDigest') Reflect.set(plugins, field, `sha256:${'f'.repeat(64)}`);
      else Reflect.set(plugins.selections[0], field, field === 'contentDigest' ? `sha256:${'f'.repeat(64)}` : 99);
      expect(() => resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins }))
        .toThrow('exact installed release-owned source contract');
    }
  );

  it('rejects a mixture of old and current plugin identities', () => {
    const { manifest, composition, selection } = specimen();
    const current = readManifestPluginMetadata({
      schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
    }, {
      stack: manifest.project.workload.apiStack, cloud: manifest.project.workload.cloud,
      workflow: manifest.project.specWorkflow, agents: manifest.project.agents
    }).selections[0];
    const plugins = {
      ...manifest.plugins,
      selections: manifest.plugins.selections.map((plugin, index) => index === 0 ? current : plugin)
    };
    expect(() => resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins })).toThrow();
  });

  it.each([
    ['environment', (resolution: PluginResolution) => { Reflect.set(resolution.selection, 'environments', ['staging']); }],
    ['frontend', (resolution: PluginResolution) => { Reflect.set(resolution.selection, 'frontend', 'omitted'); }],
    ['artifact', (resolution: PluginResolution) => { Reflect.set(resolution.artifacts[0], 'pathParts', ['different']); }],
    ['check', (resolution: PluginResolution) => { Reflect.set(resolution, 'checks', [{ operation: 'foreign' }]); }],
    ['shared source', (resolution: PluginResolution) => { Reflect.set(resolution.sharedAssets[0], 'sha256', `sha256:${'e'.repeat(64)}`); }],
    ['unknown plugin', (resolution: PluginResolution) => { Reflect.set(resolution.plugins[0], 'id', 'foreign'); }]
  ] as const)('does not borrow unchanged historical metadata for changed %s semantics', (_label, change) => {
    const { manifest, composition } = specimen();
    const resolution = structuredClone(composition.resolution);
    change(resolution);
    expect(matchesHistoricalModernPlugins(manifest.plugins, resolution)).toBe(false);
  });

  it('does not describe a readable historical template family as the installed telemetry bundle', () => {
    for (const entry of baseline.cases) {
      const { manifest, composition } = specimen(entry);
      const installed = readManifestPluginMetadata({
        schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
      }, {
        stack: manifest.project.workload.apiStack, cloud: manifest.project.workload.cloud,
        workflow: manifest.project.specWorkflow, agents: manifest.project.agents
      });
      if (manifestPluginMetadataMatches(manifest.plugins, installed)) {
        expect(projectTelemetryDimensions(manifest)).toHaveProperty('templateSetDigest');
      } else {
        expect(() => projectTelemetryDimensions(manifest)).toThrow('Historical source plugin metadata');
      }
    }
  });
});
