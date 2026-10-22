import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createModernPreAssessmentRegistry,
  matchesHistoricalModernPlugins,
  modernPreAssessmentRegistry,
  modernSourceRegistry
} from '../src/application/project/modern-plugins.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { projectAssessmentAgentIntegrations } from '../src/domain/project/catalog.js';
import { renderProjectAssessmentIntegration } from '../src/generators/governance/integrations.js';
import { modernProjectSourceInput, resolveModernManifestSourceContext } from '../src/application/project/source-context.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { supportedHostPlatforms } from '../src/domain/project/supported-stack.js';
import type { ProjectOptions, ManifestLayoutDescriptor } from '../src/domain/project/contracts.js';
import {
  modernPreAssessmentDeclarationsDigest,
  modernPreAssessmentGovernanceSourceContracts,
  modernPreAssessmentSource,
  modernPreAssessmentSourceRevision
} from '../src/plugins/builtin/modern-pre-assessment.js';

interface BeforeSource {
  sourceHead: string;
  registryDigest: string;
  pluginSetDigest: string;
  declarations: unknown;
  release: unknown;
  cases: {
    options: ProjectOptions;
    manifest: unknown;
    layoutDescriptor: ManifestLayoutDescriptor;
    managedDeclarations: unknown;
    requiredHandoffLogicalNames: string[];
    managed: { logicalName: string; pathParts: string[]; category: string; sha256: string }[];
  }[];
  bodies: Record<string, string>;
}
const bytes = readFileSync(new URL('./fixtures/pre-assessment-guidance-source.json', import.meta.url));
const before: BeforeSource = JSON.parse(bytes.toString('utf8'));

describe('genuine pre-assessment declaration and managed-body source contract', () => {
  it('pins the original capture while composing it with the current reviewed template release', () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('b69ab1ecc4b7aca46d186abee998bb5c8f4c57e5a58a15781afbf2a255025d8c');
    expect(before.sourceHead).toBe(modernPreAssessmentSourceRevision);
    expect(before.cases).toHaveLength(24);
    expect(Object.keys(before.bodies)).toHaveLength(76);
    const declarations = {
      descriptors: modernPreAssessmentSource.descriptors.map(({ contentVersion: _version, ...descriptor }) => descriptor),
      core: modernPreAssessmentSource.core,
      selectionSpace: modernPreAssessmentSource.selectionSpace,
      operations: modernPreAssessmentSource.operations
    };
    expect(canonicalJson(declarations)).toBe(canonicalJson(before.declarations));
    expect(`sha256:${canonicalSha256(declarations)}`).toBe(modernPreAssessmentDeclarationsDigest);
    expect(`sha256:${createHash('sha256').update(modernPreAssessmentGovernanceSourceContracts).digest('hex')}`)
      .toBe('sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6');
    expect(modernPreAssessmentSource.release).toEqual(before.release);
    const registry = modernPreAssessmentRegistry();
    expect(before.registryDigest).toBe('sha256:3f586dc05020ab6f8f5f8c312098fef7e2a1a0ff3a802d60c1f0366ef25023a1');
    expect(before.pluginSetDigest).toBe('sha256:b37f1ea2319bdf25e2fda09faa271639c48007acdcbd80aaf540835a210eab73');
    expect(registry.registryDigest).toBe('sha256:d7079a699eb567487ec0147f114b90ba38cd843c51460e72fa8d29ef01c584fc');
    expect(registry.pluginSetDigest).toBe('sha256:7a039d0396480f9996fed04f383ed7dc6cdf9e5d022be4f3fbbd7c1f45fa72eb');
    expect(registry.coreContributionDigest).toBe('sha256:a4710c6c0be752760b7bf068e794974aba443d05510bd5ca634a4e1ed3064677');
    expect(registry.inventory.find(plugin => plugin.id === 'node-fastify')).toMatchObject({
      contentVersion: 4,
      contentDigest: 'sha256:ff7367554c22d874d133e96f39e147b0a34946da008abea75c80afc7426a7023'
    });
    expect(registry.inventory.find(plugin => plugin.id === 'python-fastapi')).toMatchObject({
      contentVersion: 3,
      contentDigest: 'sha256:007ef8be99fea8d880c5f4411e1a77f2f58bb0f5945f5c6728a599905cca7c5c'
    });
    expect(modernPreAssessmentRegistry()).toBe(registry);
    expect(Object.isFrozen(modernPreAssessmentSource)).toBe(true);
    expect(Object.isFrozen(modernPreAssessmentSource.descriptors[0].artifacts)).toBe(true);
  });

  it('rejects missing actual source assets rather than admitting only the captured hash', () => {
    expect(() => createModernPreAssessmentRegistry(() => [])).toThrow();
  });

  it.each(before.cases.map((entry, index) => ({ ...entry, index })))(
    'preserves exact recorded metadata, declarations, layout and every original managed body for source $index', entry => {
      const original = canonicalJson(entry.manifest);
      const manifest = parseProjectManifest(entry.manifest);
      if (manifest.artifactVersion !== 8) throw new Error('The genuine capture must contain v8 source manifests.');
      const input = modernProjectSourceInput(manifest);
      const context = resolveModernManifestSourceContext(manifest);
      expect(context.source.layoutDescriptor).toEqual(entry.layoutDescriptor);
      expect(context.source.managedArtifacts).toEqual(entry.managedDeclarations);
      expect(context.source.requiredHandoffLogicalNames).toEqual(entry.requiredHandoffLogicalNames);
      const workload = manifest.project.workload;
      const selection = {
        workload: workload.kind,
        ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
        stack: workload.apiStack, cloud: workload.cloud,
        workflow: manifest.project.specWorkflow, agents: manifest.project.agents,
        frontend: workload.frontend ? 'included' as const : 'omitted' as const,
        governanceProfile: manifest.governance.profile, environments: workload.environments
      };
      for (const platform of supportedHostPlatforms) {
        const target = modernSourceRegistry().resolveSelection(selection, { platform });
        expect(matchesHistoricalModernPlugins(manifest.plugins, target)).toBe(true);
      }
      const managed = buildModernManagedCore(input);
      expect(managed.map(artifact => ({
        logicalName: artifact.logicalName, pathParts: artifact.pathParts, category: artifact.category,
        sha256: createHash('sha256').update(artifact.content).digest('hex')
      }))).toEqual(entry.managed);
      for (const artifact of managed) {
        const digest = createHash('sha256').update(artifact.content).digest('hex');
        expect(artifact.content).toBe(before.bodies[digest]);
      }
      const candidate = createManifestV8Candidate({
        origin: 'maintenance', source: manifest,
        managed: managed.map(artifact => ({
          kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category,
          pathParts: artifact.pathParts, content: artifact.content
        }))
      });
      expect(candidate.manifest.plugins).toEqual(manifest.plugins);
      expect(candidate.manifest.activeLayout).toEqual(manifest.activeLayout);
      expect(candidate.manifest.managedArtifacts).toEqual(manifest.managedArtifacts);
      expect(candidate.manifest.projectArtifacts).toEqual(manifest.projectArtifacts);
      expect(canonicalJson(entry.manifest)).toBe(original);
    }
  );

  it.each(['github-copilot', 'claude', 'codex'] as const)(
    'rejects rather than silently discards undeclared %s assessment decisions for a genuine historical source', agent => {
      const entry = before.cases.find(entry => entry.options.agents?.includes(agent));
      if (!entry) throw new Error('The genuine capture must include each selected agent host.');
      const manifest = parseProjectManifest(entry.manifest);
      if (manifest.artifactVersion !== 8) throw new Error('The genuine capture must contain manifest 8.');
      const managed = buildModernManagedCore(modernProjectSourceInput(manifest));
      const integration = projectAssessmentAgentIntegrations[agent];
      expect(() => createManifestV8Candidate({
        origin: 'maintenance', source: manifest,
        managed: [
          ...managed.map(artifact => ({
            kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category,
            pathParts: artifact.pathParts, content: artifact.content
          })),
          {
            kind: 'bytes', logicalName: integration.logicalName, category: 'assessment',
            pathParts: integration.pathParts, content: renderProjectAssessmentIntegration(agent)
          }
        ]
      })).toThrow('exact applicable target declaration');
    }
  );
});
