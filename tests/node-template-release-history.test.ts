import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveModernManifestV8Source } from '../src/application/project/manifest.js';
import { modernPreAssessmentRegistry, modernPreWorkflowRegistry } from '../src/application/project/modern-plugins.js';
import type { ManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import type { PluginSelection } from '../src/plugins/contracts.js';
import { pluginResolutionDigest } from '../src/plugins/registry.js';

interface CapturedCase {
  selection: number;
  plugins: number;
  resolutionDigest: ManifestPluginMetadata['resolutionDigest'];
  sourceIdentity: number;
}

interface Selection {
  project: LiftoffManifestV8['project'];
  framework: LiftoffManifestV8['framework'];
  profile: Exclude<LiftoffManifestV8['governance']['profile'], 'none'>;
}

const bytes = readFileSync(new URL('./fixtures/node-template-release-history.json', import.meta.url));
const captured: {
  schemaVersion: number;
  sourceRevision: string;
  selections: Selection[];
  pluginSelections: ManifestPluginMetadata['selections'][];
  sourceIdentities: Record<string, unknown>[];
  families: Array<{ family: 'pre-assessment' | 'pre-workflow' | 'current'; cases: CapturedCase[] }>;
} = JSON.parse(bytes.toString('utf8'));
const cases = captured.families.flatMap(({ family, cases }) =>
  cases.map((entry, index) => ({ family, entry, index })));
const retained = cases.filter(entry => entry.family !== 'current');
const unpublished = cases.filter(entry => entry.family === 'current');

function original(entry: CapturedCase) {
  const selection = captured.selections[entry.selection];
  const selections = captured.pluginSelections[entry.plugins];
  const sourceIdentity = captured.sourceIdentities[entry.sourceIdentity];
  if (!selection || !selections || !sourceIdentity) throw new Error('Incomplete captured Node source request.');
  return {
    request: {
      selection,
      recordedPlugins: { schemaVersion: 1 as const, resolutionDigest: entry.resolutionDigest, selections }
    },
    sourceIdentity
  };
}

describe('Node template patch and exact retained source metadata', () => {
  it('pins the independently captured qualified parent bytes and complete request inventory', () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('378a2e091759e31c435a381fa27c2e7c026eb498b6e72a7143081066e31e247b');
    expect(captured.schemaVersion).toBe(1);
    expect(captured.sourceRevision).toBe('420d43968ccaab508eec221d34e000d8458a7435');
    expect(captured.families.map(({ family, cases }) => [family, cases.length]))
      .toEqual([['pre-assessment', 12], ['pre-workflow', 12], ['current', 12]]);
    expect(new Set(retained.map(({ entry }) => original(entry).request.selection.profile)))
      .toEqual(new Set(['single-maintainer-gitflow', 'team-gitflow']));
    expect(new Set(retained.map(({ entry }) => original(entry).request.selection.project.specWorkflow)))
      .toEqual(new Set(['manual', 'openspec', 'spec-kit']));
    expect(new Set(retained.map(({ entry }) => original(entry).request.selection.project.workload.frontend)))
      .toEqual(new Set([false, true]));
  });

  it.each(retained)('preserves exact $family Node request $index without changing source identity', ({ family, entry }) => {
    const before = original(entry);
    const unchanged = structuredClone(before);
    const resolved = resolveModernManifestV8Source(before.request);
    expect(resolved.release).toBe(family);
    expect(resolved.contract.plugins).toEqual(before.request.recordedPlugins);
    if (!('identity' in resolved.contract.governanceSource)) throw new Error('Missing retained enabled source identity.');
    expect(resolved.contract.governanceSource.identity).toEqual(before.sourceIdentity);
    expect(before.sourceIdentity.activationContractVersion).toBe(4);
    expect(before).toEqual(unchanged);
  });

  it.each(unpublished)('refuses original unpublished current-5 Node request $index rather than retagging it', ({ entry }) => {
    const before = original(entry);
    const unchanged = structuredClone(before);
    expect(before.sourceIdentity.activationContractVersion).toBe(5);
    expect(() => resolveModernManifestV8Source(before.request)).toThrow(/plugin metadata does not match/u);
    expect(before).toEqual(unchanged);
  });

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])(
    'refuses changed original Node %s in every captured source family', field => {
      for (const { entry } of cases) {
        const { request } = structuredClone(original(entry));
        if (field === 'resolutionDigest') {
          Reflect.set(request.recordedPlugins, field, `sha256:${'f'.repeat(64)}`);
        } else {
          const node = request.recordedPlugins.selections.find(plugin => plugin.id === 'node-fastify');
          if (!node) throw new Error('Missing captured Node plugin.');
          Reflect.set(node, field, field === 'contentDigest' ? `sha256:${'f'.repeat(64)}` : 99);
        }
        expect(() => resolveModernManifestV8Source(request)).toThrow(/plugin metadata does not match/u);
      }
    }
  );

  it('refuses self-consistent but unallocated Node identities instead of accepting a version interval', () => {
    for (const { family, entry } of retained) {
      const { request } = structuredClone(original(entry));
      const registry = family === 'pre-workflow' ? modernPreWorkflowRegistry() : modernPreAssessmentRegistry();
      const { project, profile } = request.selection;
      const selection: PluginSelection = {
        workload: 'standard', stack: 'node-fastify', cloud: project.workload.cloud,
        workflow: project.specWorkflow, agents: project.agents,
        frontend: project.workload.frontend ? 'included' : 'omitted',
        environments: project.workload.environments, governanceProfile: profile
      };
      const { hostPlatform: _host, digest: _digest, ...semantic } =
        registry.resolveSelection(selection, { platform: 'linux/arm64' });
      const plugins = request.recordedPlugins.selections.map(plugin =>
        plugin.id === 'node-fastify' ? { ...plugin, contentVersion: 99 } : plugin);
      expect(() => resolveModernManifestV8Source({
        selection: request.selection,
        recordedPlugins: {
          schemaVersion: 1, selections: plugins,
          resolutionDigest: pluginResolutionDigest({ ...semantic, plugins })
        }
      })).toThrow(/plugin metadata does not match/u);
    }
  });
});
