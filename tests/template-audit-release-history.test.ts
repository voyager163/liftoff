import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveModernManifestV8Source } from '../src/application/project/manifest.js';
import {
  modernPreAssessmentRegistry, modernPreWorkflowRegistry, modernSourceRegistry
} from '../src/application/project/modern-plugins.js';
import { templateAssetsFromRegistry } from '../src/application/project/plugins.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import type { ManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import type { PluginSelection } from '../src/plugins/contracts.js';
import { pluginResolutionDigest } from '../src/plugins/registry.js';
import { modernTemplateAuditPreviousReleases } from '../src/plugins/builtin/modern-template-audit-previous-release.js';
import { buildCurrentArtifacts, resolveGeneratorContext } from '../src/templates.js';

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

const bytes = readFileSync(new URL('./fixtures/template-audit-release-history.json', import.meta.url));
const captured: {
  schemaVersion: number;
  sourceRevision: string;
  selections: Selection[];
  pluginSelections: ManifestPluginMetadata['selections'][];
  sourceIdentities: Record<string, unknown>[];
  families: Array<{ family: 'pre-assessment' | 'pre-workflow' | 'current'; cases: CapturedCase[] }>;
} = JSON.parse(bytes.toString('utf8'));

function original(entry: CapturedCase) {
  const selection = captured.selections[entry.selection];
  const selections = captured.pluginSelections[entry.plugins];
  const sourceIdentity = captured.sourceIdentities[entry.sourceIdentity];
  if (!selection || !selections || !sourceIdentity) throw new Error('Incomplete captured template request.');
  return {
    request: {
      selection,
      recordedPlugins: { schemaVersion: 1 as const, resolutionDigest: entry.resolutionDigest, selections }
    },
    sourceIdentity
  };
}

function selected({ project, profile }: Selection): PluginSelection {
  const workload = project.workload;
  return {
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow: project.specWorkflow,
    agents: project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    environments: workload.environments, governanceProfile: profile
  };
}

const retained = captured.families.filter(family => family.family !== 'current');
const registries = [
  ['pre-assessment', modernPreAssessmentRegistry],
  ['pre-workflow', modernPreWorkflowRegistry],
  ['current', modernSourceRegistry]
] as const;

describe('Vite and Certifi patch preserves exact source history', () => {
  it('pins all 432 captured accepted requests without rewriting the capture', () => {
    expect(bytes.length).toBe(203168);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('ef273011723f0a1fb7e2099dc63a04d9a0809f75444857d2c66b7c23bedc535d');
    expect(captured.schemaVersion).toBe(1);
    expect(captured.sourceRevision).toBe('4103bb429f39362dab7731ba9c06efcbb524016e');
    expect(captured.families.map(({ family, cases }) => [family, cases.length]))
      .toEqual([['pre-assessment', 144], ['pre-workflow', 144], ['current', 144]]);
    expect(captured.selections).toHaveLength(144);
    const standard = captured.selections.filter(value => value.project.workload.kind === 'standard');
    const genai = captured.selections.filter(value => value.project.workload.kind === 'genai');
    expect(standard).toHaveLength(36);
    expect(genai).toHaveLength(108);
    expect(new Set(standard.map(value => value.project.workload.apiStack)))
      .toEqual(new Set(['node-fastify', 'python-fastapi', 'go-huma']));
    expect(new Set(genai.map(value => value.project.workload.kind === 'genai' && value.project.workload.pattern)))
      .toEqual(new Set(['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']));
    for (const { cases } of captured.families) {
      expect(new Set(cases.map(entry => original(entry).request.selection.profile)))
        .toEqual(new Set(['single-maintainer-gitflow', 'team-gitflow']));
      expect(new Set(cases.map(entry => original(entry).request.selection.project.specWorkflow)))
        .toEqual(new Set(['manual', 'openspec', 'spec-kit']));
      expect(new Set(cases.map(entry => original(entry).request.selection.project.workload.frontend)))
        .toEqual(new Set([false, true]));
    }
    expect(Object.values(modernTemplateAuditPreviousReleases).every(family =>
      family.sourceRevision === captured.sourceRevision)).toBe(true);
  });

  it.each(retained)('retains every original $family activation-4 identity and plugin record', ({ family, cases }) => {
    for (const entry of cases) {
      const before = original(entry), unchanged = structuredClone(before);
      const resolved = resolveModernManifestV8Source(before.request);
      expect(resolved.release).toBe(family);
      expect(resolved.contract.plugins).toEqual(before.request.recordedPlugins);
      if (!('identity' in resolved.contract.governanceSource)) throw new Error('Missing original governance identity.');
      expect(resolved.contract.governanceSource.identity).toEqual(before.sourceIdentity);
      expect(before.sourceIdentity.activationContractVersion).toBe(4);
      expect(before).toEqual(unchanged);
    }
  });

  it('refuses all 144 unpublished old current-5 requests rather than retagging them', () => {
    const unpublished = captured.families.find(family => family.family === 'current')!;
    expect(unpublished.cases).toHaveLength(144);
    for (const entry of unpublished.cases) {
      const before = original(entry), unchanged = structuredClone(before);
      expect(before.sourceIdentity.activationContractVersion).toBe(5);
      expect(() => resolveModernManifestV8Source(before.request)).toThrow(/plugin metadata does not match/u);
      expect(before).toEqual(unchanged);
    }
  });

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])(
    'refuses altered %s in every original source request', field => {
      for (const { cases } of captured.families) {
        for (const entry of cases) {
          const { request } = structuredClone(original(entry));
          if (field === 'resolutionDigest') {
            Reflect.set(request.recordedPlugins, field, `sha256:${'f'.repeat(64)}`);
          } else {
            const stack = request.recordedPlugins.selections.find(plugin => plugin.category === 'stack');
            if (!stack) throw new Error('Missing captured stack plugin.');
            Reflect.set(stack, field, field === 'contentDigest' ? `sha256:${'f'.repeat(64)}` : 99);
          }
          expect(() => resolveModernManifestV8Source(request)).toThrow(/plugin metadata does not match/u);
        }
      }
    }
  );

  it.each(retained)('refuses self-consistent unallocated $family stack identities', ({ family, cases }) => {
    const registry = family === 'pre-workflow' ? modernPreWorkflowRegistry() : modernPreAssessmentRegistry();
    for (const entry of cases) {
      const { request } = original(entry);
      const { hostPlatform: _host, digest: _digest, ...semantic } =
        registry.resolveSelection(selected(request.selection), { platform: 'linux/arm64' });
      const plugins = request.recordedPlugins.selections.map(plugin =>
        plugin.category === 'stack' ? { ...plugin, contentVersion: 99 } : plugin);
      expect(() => resolveModernManifestV8Source({
        selection: request.selection,
        recordedPlugins: {
          schemaVersion: 1, selections: plugins,
          resolutionDigest: pluginResolutionDigest({ ...semantic, plugins })
        }
      })).toThrow(/plugin metadata does not match/u);
    }
  });

  it.each(registries)('renders actual patched dependency bytes through the %s registry', (_family, createRegistry) => {
    const registry = createRegistry();
    expect(registry.inventory.find(plugin => plugin.id === 'node-fastify')?.contentVersion).toBe(5);
    expect(registry.inventory.find(plugin => plugin.id === 'python-fastapi')?.contentVersion).toBe(4);
    for (const [apiStack, pattern] of [['node-fastify', undefined], ['python-fastapi', undefined], ['python-fastapi', 'rag']] as const) {
      const plan = buildCurrentProjectPlan({
        projectName: 'Patched closure', projectType: pattern ? 'genai' : 'standard', apiStack,
        ...(pattern ? { pattern } : {}), cloud: 'azure', specWorkflow: 'manual', agents: [],
        includeFrontend: true, governanceProfile: 'single-maintainer-gitflow'
      }, { requireProjectName: true });
      const artifacts = buildCurrentArtifacts(plan, resolveGeneratorContext(plan, templateAssetsFromRegistry(registry)));
      const artifact = (file: string) => {
        const found = artifacts.find(value => value.pathParts.join('/') === file);
        if (!found) throw new Error(`Missing rendered dependency file ${file}.`);
        return found.content;
      };
      const frontend = JSON.parse(artifact('frontend/package.json'));
      expect(frontend.dependencies.vite).toBe('^8.2.4');
      expect(frontend).not.toHaveProperty('devDependencies');
      expect(JSON.parse(artifact('frontend/package-lock.json')).packages['node_modules/vite'].version).toBe('8.2.4');
      if (apiStack === 'node-fastify') {
        expect(JSON.parse(artifact('backend/package.json')).devDependencies.vite).toBe('8.2.4');
        expect(JSON.parse(artifact('backend/package-lock.json')).packages['node_modules/vite'].version).toBe('8.2.4');
      } else {
        expect(artifact('backend/uv.lock')).toContain('name = "certifi"\nversion = "2026.10.19"');
        expect(artifact('backend/uv.lock')).not.toContain('certifi-2026.7.22');
        if (pattern) expect(artifact('functions/rag-worker/requirements.txt')).toContain('\ncertifi==2026.10.19 \\\n');
      }
    }
  });
});
