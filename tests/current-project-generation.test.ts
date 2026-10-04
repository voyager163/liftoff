import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCurrentProjectPlan, buildProjectPlan } from '../src/application/project/planning.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { buildArtifacts, buildCurrentArtifacts } from '../src/templates.js';
import { validateGeneratedProject, writeArtifacts } from '../src/file-system.js';
import type { CodingAgentId, GeneratedArtifact, ProjectOptions } from '../src/domain/project/contracts.js';

const agents: CodingAgentId[] = ['github-copilot', 'claude', 'codex'];
const subsets = Array.from({ length: 8 }, (_, mask) =>
  agents.filter((_, index) => (mask & (1 << index)) !== 0)
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manifestFor(artifacts: readonly GeneratedArtifact[]) {
  const file = artifacts.find(artifact => artifact.logicalName === 'manifest');
  if (!file) throw new Error('Expected generated manifest.');
  const manifest = parseProjectManifest(JSON.parse(file.content));
  if (manifest.artifactVersion !== 8) throw new Error('Expected a current manifest.');
  return manifest;
}

const workloads: ProjectOptions[] = [
  { projectType: 'standard', apiStack: 'python-fastapi' },
  { projectType: 'standard', apiStack: 'node-fastify' },
  { projectType: 'standard', apiStack: 'go-huma' },
  ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
];
const selection = {
  projectName: 'Manual Real Application', cloud: 'azure', region: 'eastus',
  environments: ['dev', 'prod'], includeFrontend: true
};

describe('current real-project generation', () => {
  for (const governanceProfile of ['none', 'single-maintainer-gitflow']) {
    it.each(subsets.map(selected => [selected] as const))(
      `renders exact Manual integrations with ${governanceProfile} and agents %j`,
      selected => {
        const plan = buildCurrentProjectPlan({
          ...selection, projectType: 'standard', apiStack: 'go-huma',
          specWorkflow: 'manual', agents: selected, governanceProfile
        }, { requireProjectName: true });
        const before = JSON.stringify(plan);
        const artifacts = buildCurrentArtifacts(plan);
        expect(buildCurrentArtifacts(plan)).toEqual(artifacts);
        expect(JSON.stringify(plan)).toBe(before);
        const manifest = manifestFor(artifacts);
        expect(manifest.framework).toEqual({ state: 'not-required' });
        expect(manifest.project.agents).toEqual(selected);
        expect(manifest.project).not.toHaveProperty('defaultAgent');
        expect(manifest).not.toHaveProperty('sourceManifestHistory');
        expect(manifest).not.toHaveProperty('activationTargetHistory');
        expect(manifest).not.toHaveProperty('telemetry');
        expect(manifest.adoptionObservations).toEqual([]);
        expect(artifacts.filter(artifact => artifact.lifecycle === 'seed' || artifact.lifecycle === 'framework')).toEqual([]);
        expect(artifacts.filter(artifact => ['openspec', '.specify', 'specs'].includes(artifact.pathParts[0]!))).toEqual([]);
        const managed = artifacts.filter(artifact => artifact.lifecycle === 'managed-core');
        expect(managed.length).toBe(governanceProfile === 'none' ? selected.length : 6 + selected.length * 3);
        expect(manifest.governance.profile).toBe(governanceProfile);
        expect(manifest.governance.state).toBe(governanceProfile === 'none' ? 'disabled' : 'handoff-generated');
        for (const artifact of manifest.managedArtifacts) {
          const actual = managed.find(candidate => candidate.logicalName === artifact.logicalName);
          expect(actual).toBeDefined();
          expect(artifact.contentHash).toBe(`sha256:${createHash('sha256').update(actual!.content).digest('hex')}`);
        }
        const config = artifacts.find(artifact => artifact.logicalName === 'liftoff-config');
        expect(JSON.parse(config!.content)).toMatchObject({ specWorkflow: 'manual', agents: selected, governanceProfile });
        const readme = artifacts.find(artifact => artifact.logicalName === 'root-readme')!.content;
        expect(readme).toContain('Update JSON uses schema 4.');
        expect(readme).toContain('Manual has no external specification framework');
        expect(readme).not.toContain('legacy framework');
        if (selected.length === 0) {
          expect(readme).toContain('Use the CLI directly');
          expect(artifacts.some(artifact => ['.agents', '.claude', '.github'].includes(artifact.pathParts[0]!))).toBe(false);
        }
      }
    );
  }

  it.each(workloads)('renders actual workload bytes and provenance for Manual %j', workload => {
    const input = { ...selection, ...workload, governanceProfile: 'none' };
    const legacy = buildArtifacts(buildProjectPlan(input, { requireProjectName: true }));
    const current = buildCurrentArtifacts(buildCurrentProjectPlan({
      ...input, specWorkflow: 'manual', agents: []
    }, { requireProjectName: true }));
    const manifest = manifestFor(current);
    const application = (artifacts: GeneratedArtifact[]) => artifacts
      .filter(artifact => artifact.lifecycle === 'project' && !['root-readme', 'opentofu-readme'].includes(artifact.logicalName));
    expect(application(current)).toEqual(application(legacy));
    expect(current.find(artifact => artifact.logicalName === 'opentofu-readme')!.content)
      .toContain('Manual does not require OpenSpec, Spec Kit, a framework archive, or an agent');
    expect(manifest.activeLayout.bindings).toEqual(expect.arrayContaining([
      { kind: 'component', component: 'backend', pathParts: ['backend'] },
      { kind: 'component', component: 'database', pathParts: ['database'] },
      { kind: 'component', component: 'frontend', pathParts: ['frontend'] },
      { kind: 'component', component: 'opentofu-application', pathParts: ['infrastructure', 'opentofu', 'azure', 'modules', 'application'] },
      { kind: 'component', component: 'opentofu-environment:dev', pathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'] },
      { kind: 'component', component: 'opentofu-environment:prod', pathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'prod'] }
    ]));
    expect(manifest.activeLayout.bindings.some(binding =>
      binding.kind === 'component' && binding.component === 'opentofu-environment:staging')).toBe(false);
    expect(manifest.projectArtifacts.length).toBe(current.filter(artifact => artifact.lifecycle === 'project').length);
    for (const artifact of manifest.projectArtifacts) {
      const actual = current.find(candidate => candidate.logicalName === artifact.logicalName)!;
      expect(artifact.generationHash).toBe(`sha256:${createHash('sha256').update(actual.content).digest('hex')}`);
      const binding = {
        kind: 'artifact', logicalName: artifact.logicalName, pathParts: artifact.pathParts
      };
      if (artifact.pathParts.some(part => part.startsWith('.env.') || part.endsWith('.tfvars'))) {
        expect(manifest.activeLayout.bindings).not.toContainEqual(binding);
      } else {
        expect(manifest.activeLayout.bindings).toContainEqual(binding);
      }
    }
  });

  it('binds complete fresh layout explicitly without changing artifact-only candidate or maintenance semantics', () => {
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      ...selection, projectType: 'standard', apiStack: 'go-huma', specWorkflow: 'manual', agents: []
    }, { requireProjectName: true }));
    const manifest = manifestFor(artifacts);
    const input = {
      origin: 'fresh',
      selection: { project: manifest.project, framework: manifest.framework, profile: manifest.governance.profile },
      generatedArtifacts: artifacts.filter(artifact => artifact.lifecycle !== 'manifest')
    };
    expect(createManifestV8Candidate({ ...input, activeLayout: manifest.activeLayout }).manifest).toEqual(manifest);
    expect(createManifestV8Candidate(input).manifest.activeLayout.bindings.every(binding => binding.kind === 'artifact')).toBe(true);
    const missingComponent = { ...manifest.activeLayout, bindings: manifest.activeLayout.bindings.filter(binding =>
      binding.kind !== 'component' || binding.component !== 'backend') };
    expect(() => createManifestV8Candidate({ ...input, activeLayout: missingComponent })).toThrow('exact generated runtime layout');
    const movedArtifact = {
      ...manifest.activeLayout, bindings: manifest.activeLayout.bindings.map(binding =>
        binding.kind === 'artifact' && binding.logicalName === 'root-readme'
          ? { ...binding, pathParts: ['different-readme.md'] } : binding)
    };
    expect(() => createManifestV8Candidate({ ...input, activeLayout: movedArtifact })).toThrow('exact generated runtime layout');
    expect(() => createManifestV8Candidate({ ...input, activeLayout: undefined })).toThrow('plain own-data JSON');
    const maintained = createManifestV8Candidate({
      origin: 'maintenance', source: manifest,
      managed: manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
    });
    expect(maintained.manifest).toEqual(manifest);
  });

  it.each(['openspec', 'spec-kit'])('keeps real %s identities and seed inventories in current output', specWorkflow => {
    const input = {
      ...selection, projectType: 'standard', apiStack: 'node-fastify', specWorkflow,
      agents: ['github-copilot', 'claude', 'codex'], ...(specWorkflow === 'spec-kit' ? { defaultAgent: 'codex' } : {})
    };
    const historical = buildArtifacts(buildProjectPlan(input, { requireProjectName: true }));
    const current = buildCurrentArtifacts(buildCurrentProjectPlan(input, { requireProjectName: true }));
    const manifest = manifestFor(current);
    expect(manifest.framework).toEqual({
      state: 'initialized', adapter: specWorkflow, contractVersion: specWorkflow === 'openspec' ? '1.11.0' : '1.0.1'
    });
    const external = (artifacts: GeneratedArtifact[]) => artifacts.filter(artifact =>
      artifact.lifecycle === 'framework' || artifact.lifecycle === 'seed'
    );
    expect(external(current)).toEqual(external(historical));
    expect(manifest.projectArtifacts.some(artifact => artifact.category === 'seed')).toBe(false);
    expect(manifest.managedArtifacts.some(artifact => external(current).some(seed => seed.logicalName === artifact.logicalName)))
      .toBe(false);
  });

  it.each(['none', 'single-maintainer-gitflow'])('writes a valid Manual tree with spaces and %s governance', async governanceProfile => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff manual generation '));
    roots.push(root);
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      ...selection, projectType: 'standard', apiStack: 'go-huma', specWorkflow: 'manual',
      governanceProfile, agents: []
    }, { requireProjectName: true }));
    await writeArtifacts(root, artifacts);
    expect(await validateGeneratedProject(root)).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
    expect(await readFile(path.join(root, 'backend', 'go.mod'), 'utf8')).toContain('example.com/manual-real-application/backend');
  });
});
