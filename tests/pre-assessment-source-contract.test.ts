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
    expect(registry.registryDigest).toBe('sha256:7d18a600634ef9ab188e6e3ad92cd6a5fbe8114067b543bbed73d682bc90ff64');
    expect(registry.pluginSetDigest).toBe('sha256:1438e540e33b28c2b2ac5125826a6569e5ffea7b022d715152a37e199a7e31c4');
    expect(registry.coreContributionDigest).toBe('sha256:5784008ee1d3dd674b4fdbfad14350e34077499d4ece524ecb6b2e6d0d1de190');
    expect(registry.inventory.find(plugin => plugin.id === 'node-fastify')).toMatchObject({
      contentVersion: 5,
      contentDigest: 'sha256:9983d4c99c7bf47bc7306f11cdab2a2e3b370fcfaa235041ceb4db8f92b19d42'
    });
    expect(registry.inventory.find(plugin => plugin.id === 'python-fastapi')).toMatchObject({
      contentVersion: 4,
      contentDigest: 'sha256:624bccb0b4bc257bc45b110cfb7c1896384306447fb048f2129822f2b9a43136'
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
