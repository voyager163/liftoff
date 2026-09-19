import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import type { LiftoffManifestV8 } from '../src/domain/project/contracts.js';
import {
  hasGeneratedWorkload, isApiManifestWorkload, isComponentOnlyManifest
} from '../src/domain/project/manifest/applicability.js';

function generated(includeFrontend = false): LiftoffManifestV8 {
  const plan = buildProjectPlan({
    projectName: 'applicability', projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', includeFrontend, environments: ['dev'],
    specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  return buildManifest(plan, buildArtifacts(plan));
}

describe('manifest applicability separates facts from generation', () => {
  it.each([
    'manifest-v2.json', 'manifest-v3.json', 'manifest-v4-genai.json',
    'manifest-v5-standard-released.json', 'manifest-v6-genai-released.json', 'manifest-v7-governed-released.json'
  ])('retains generated-workload source semantics for %s without requiring v8', async (file) => {
    const manifest = parseManifest(JSON.parse(await readFile(`tests/fixtures/${file}`, 'utf8')));
    expect(hasGeneratedWorkload(manifest)).toBe(true);
    expect(isApiManifestWorkload(manifest.project.workload)).toBe(true);
    expect(isComponentOnlyManifest(manifest)).toBe(false);
  });

  it('narrows a current generated API while retaining its actual workload fields', () => {
    const manifest = generated();
    expect(hasGeneratedWorkload(manifest)).toBe(true);
    if (!hasGeneratedWorkload(manifest)) throw new Error('Expected a generated workload.');
    expect(manifest.project.workload.apiStack).toBe('node-fastify');
    expect(manifest.project.workload.cloud).toBe('azure');
    expect(isComponentOnlyManifest(manifest)).toBe(false);
  });

  it('uses the canonical generated component helper for an explicitly selected frontend', () => {
    const manifest = generated(true);
    expect(manifest.standards.components.map((component) => ({
      id: component.id, profile: component.profile.id, root: component.rootPathParts
    }))).toEqual([
      { id: 'backend', profile: 'node-fastify', root: ['backend'] },
      { id: 'frontend', profile: 'vue-component', root: ['frontend'] }
    ]);
    expect(parseManifest(manifest)).toEqual(manifest);
  });

  it('does not treat adopted full API facts as generated seed authority', () => {
    const manifest: LiftoffManifestV8 = {
      ...generated(), projectArtifacts: [],
      provenance: { kind: 'adopted', recordId: 'a'.repeat(64), observationDigest: 'b'.repeat(64), repairs: [] }
    };
    const parsed = parseManifest(manifest);
    expect(isApiManifestWorkload(parsed.project.workload)).toBe(true);
    expect(hasGeneratedWorkload(parsed)).toBe(false);
    expect(isComponentOnlyManifest(parsed)).toBe(false);
  });

  it('does not manufacture an API or generated seed for component-only adoption', () => {
    const manifest: LiftoffManifestV8 = {
      ...generated(), projectArtifacts: [],
      project: { name: 'component', workload: { kind: 'components' }, specWorkflow: 'openspec', agents: [] },
      framework: { state: 'uninitialized', adapter: 'openspec' },
      managedArtifacts: [],
      provenance: { kind: 'adopted', recordId: 'a'.repeat(64), observationDigest: 'b'.repeat(64), repairs: [] }
    };
    const parsed = parseManifest(manifest);
    expect(isComponentOnlyManifest(parsed)).toBe(true);
    expect(isApiManifestWorkload(parsed.project.workload)).toBe(false);
    expect(hasGeneratedWorkload(parsed)).toBe(false);
  });
});
