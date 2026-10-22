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

const captured: {
  selections: Selection[];
  pluginSelections: ManifestPluginMetadata['selections'][];
  sourceIdentities: Record<string, unknown>[];
  families: Array<{ family: 'pre-assessment' | 'pre-workflow'; cases: CapturedCase[] }>;
  current5: CapturedCase[];
} = JSON.parse(readFileSync(new URL('./fixtures/python-template-release-history.json', import.meta.url), 'utf8'));

function original(entry: CapturedCase) {
  const selection = captured.selections[entry.selection];
  const selections = captured.pluginSelections[entry.plugins];
  const sourceIdentity = captured.sourceIdentities[entry.sourceIdentity];
  if (!selection || !selections || !sourceIdentity) throw new Error('Incomplete captured Python source request.');
  const recordedPlugins: ManifestPluginMetadata = {
    schemaVersion: 1, resolutionDigest: entry.resolutionDigest, selections
  };
  return { request: { selection, recordedPlugins }, sourceIdentity };
}

describe('physical Python refresh and exact retained source metadata', () => {
  it.each(captured.families)('preserves all 120 original $family requests and their activation-4 identities', family => {
    expect(family.cases).toHaveLength(120);
    const registry = family.family === 'pre-workflow' ? modernPreWorkflowRegistry() : modernPreAssessmentRegistry();
    expect(registry.inventory.find(plugin => plugin.id === 'python-fastapi')?.contentVersion).toBe(4);
    for (const entry of family.cases) {
      const before = original(entry);
      const unchanged = structuredClone(before);
      const resolved = resolveModernManifestV8Source(before.request);
      expect(resolved.release).toBe(family.family);
      expect(resolved.contract.plugins).toEqual(before.request.recordedPlugins);
      if (!('identity' in resolved.contract.governanceSource)) throw new Error('Missing retained enabled source identity.');
      expect(resolved.contract.governanceSource.identity).toEqual(before.sourceIdentity);
      expect(resolved.contract.governanceSource.identity.activationContractVersion).toBe(4);
      expect(before).toEqual(unchanged);
    }
  });

  it('refuses all 120 original unpublished current-5 requests instead of retagging them as activation 4', () => {
    expect(captured.current5).toHaveLength(120);
    for (const entry of captured.current5) {
      const before = original(entry);
      expect(before.sourceIdentity.activationContractVersion).toBe(5);
      expect(() => resolveModernManifestV8Source(before.request)).toThrow(/plugin metadata does not match/u);
    }
  });

  it('refuses all 240 altered digests and self-consistent unpublished Python version/digest hybrids', () => {
    for (const family of captured.families) {
      for (const entry of family.cases) {
        const request = structuredClone(original(entry).request);
        const digest = request.recordedPlugins.resolutionDigest;
        request.recordedPlugins = {
          ...request.recordedPlugins,
          resolutionDigest: `sha256:${digest.slice('sha256:'.length, -1)}${digest.endsWith('0') ? '1' : '0'}`
        };
        expect(() => resolveModernManifestV8Source(request)).toThrow(/plugin metadata does not match/u);
      }
      const registry = family.family === 'pre-workflow' ? modernPreWorkflowRegistry() : modernPreAssessmentRegistry();
      const currentPython = registry.inventory.find(plugin => plugin.id === 'python-fastapi');
      if (!currentPython) throw new Error('Missing actual current Python plugin.');
      for (const entry of family.cases.slice(0, 10)) {
        const { request } = original(entry);
        const selection = request.selection, workload = selection.project.workload;
        const selected: PluginSelection = {
          workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
          stack: workload.apiStack, cloud: workload.cloud, workflow: selection.project.specWorkflow,
          agents: selection.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
          environments: workload.environments, governanceProfile: selection.profile
        };
        const { hostPlatform: _host, digest: _digest, ...semantic } = registry.resolveSelection(selected, {
          platform: `${process.platform}/${process.arch}`
        });
        const mixed = request.recordedPlugins.selections.map(plugin => plugin.id === 'python-fastapi'
          ? { ...plugin, contentDigest: currentPython.contentDigest } : plugin);
        expect(() => resolveModernManifestV8Source({
          selection, recordedPlugins: {
            schemaVersion: 1, selections: mixed, resolutionDigest: pluginResolutionDigest({ ...semantic, plugins: mixed })
          }
        })).toThrow(/plugin metadata does not match/u);
      }
    }
  });
});
