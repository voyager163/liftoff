import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { patterns } from '../src/catalogs.js';
import { managedCoreLogicalNames } from '../src/artifact-lifecycle.js';
import { loadManifest, validateGeneratedProject, writeArtifacts } from '../src/file-system.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { currentActivationIdentity } from '../src/governance-activation/index.js';
import type { ProjectOptions } from '../src/types.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const matrix: Array<{ key: string; options: ProjectOptions }> = [
  ...patterns.map((pattern) => ({
    key: pattern.id,
    options: { projectName: `${pattern.id} App`, pattern: pattern.id, cloud: 'azure' }
  })),
  { key: 'generic+frontend', options: { projectName: 'Generic Frontend App', pattern: 'generic', cloud: 'azure', includeFrontend: true } },
  { key: 'standard-python', options: { projectName: 'Standard Python', projectType: 'standard', apiStack: 'python', cloud: 'azure' } },
  { key: 'standard-node', options: { projectName: 'Standard Node', projectType: 'standard', apiStack: 'node', cloud: 'azure' } },
  { key: 'standard-go', options: { projectName: 'Standard Go', projectType: 'standard', apiStack: 'go', cloud: 'azure' } },
  { key: 'standard-node+frontend', options: { projectName: 'Standard Node UI', projectType: 'standard', apiStack: 'node', cloud: 'azure', includeFrontend: true } },
  { key: 'rag+frontend', options: { projectName: 'rag Frontend App', pattern: 'rag', cloud: 'azure', includeFrontend: true } },
  { key: 'workflow+spec-kit', options: { projectName: 'workflow Kit App', pattern: 'workflow', cloud: 'azure', specWorkflow: 'spec-kit' } },
  { key: 'power-apps-code-app', options: { projectName: 'Power Apps Code App', projectType: 'power-apps-code-app' } }
];

const renderMatrixEntry = (options: ProjectOptions) =>
  buildArtifacts(buildProjectPlan(options, { requireProjectName: true }));

describe('manifest contract', () => {
  it('keeps generated logical names aligned with the reviewed stable contract', async () => {
    const snapshot = JSON.parse(await readFile(path.join(fixturesDir, 'logical-names.json'), 'utf8')) as Record<string, string[]>;

    for (const entry of matrix) {
      const names = renderMatrixEntry(entry.options)
        .map((artifact) => artifact.logicalName)
        .sort();
      expect(
        names,
        `logicalName set changed for plan "${entry.key}". Non-environment logical names are append-only; ` +
          'environment-derived names may change only with an explicit environment retirement in the main spec. ' +
          'Update tests/fixtures/logical-names.json only after reviewing that contract.'
      ).toEqual(snapshot[entry.key]);
    }
  });

  it('renders deterministically: double render is byte-identical including the manifest', () => {
    for (const entry of matrix) {
      const first = renderMatrixEntry(entry.options);
      const second = renderMatrixEntry(entry.options);

      expect(second.length).toBe(first.length);
      for (const [index, artifact] of first.entries()) {
        expect(
          second[index],
          `non-deterministic rendering for "${artifact.logicalName}" in plan "${entry.key}": ` +
            'artifact content must depend only on the plan and template code (no timestamps, randomness, or environment)'
        ).toEqual(artifact);
      }
    }
  });

  it('classifies every artifact explicitly and keeps managed core on an exact allowlist', () => {
    const renderedManagedCore = new Set<string>();
    for (const entry of matrix) {
      for (const artifact of renderMatrixEntry(entry.options)) {
        expect(artifact.lifecycle).toMatch(
          /^(managed-core|project|desired-state|framework|seed|manifest)$/
        );
        for (const part of artifact.pathParts) {
          expect(part).not.toMatch(/[\\/\0]/);
          expect(part).not.toBe('');
        }
        if (artifact.lifecycle === 'project') {
          expect(artifact.provisioningGroup).toMatch(
            /^(base|frontend|power-apps-starter|environment:(dev|staging|prod))$/
          );
        } else {
          expect(artifact.provisioningGroup).toBeUndefined();
        }
        if (artifact.lifecycle === 'managed-core') {
          renderedManagedCore.add(artifact.logicalName);
          expect(managedCoreLogicalNames).toContain(artifact.logicalName);
        }
        if (artifact.logicalName === 'liftoff-config') {
          expect(artifact.lifecycle).toBe('desired-state');
        }
      }
    }
    for (const artifact of renderMatrixEntry({
      projectName: 'All Core Launchers',
      pattern: 'prompt',
      cloud: 'azure',
      agents: ['copilot', 'claude']
    })) {
      if (artifact.lifecycle === 'managed-core') {
        renderedManagedCore.add(artifact.logicalName);
      }
    }
    expect([...renderedManagedCore].sort()).toEqual(
      [...managedCoreLogicalNames].sort()
    );
  });

  it('keeps host-specific tool versions out of deterministic rendering', () => {
    const options: ProjectOptions = { projectName: 'Portable App', pattern: 'rag', cloud: 'azure' };
    vi.stubEnv('PATH', '/mock/node-24.20:/mock/openspec-1.11.0');
    const first = renderMatrixEntry(options);
    vi.stubEnv('PATH', '/mock/node-99:/mock/openspec-99');
    const second = renderMatrixEntry(options);
    vi.unstubAllEnvs();

    expect(second).toEqual(first);
  });

  it('loads the frozen v2 manifest fixture through the loader', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    try {
      const fixture = await readFile(path.join(fixturesDir, 'manifest-v2.json'), 'utf8');
      await writeFile(path.join(tempRoot, 'liftoff.manifest.json'), fixture, 'utf8');

      const manifest = await loadManifest(tempRoot);
      expect(manifest.artifactVersion).toBe(2);
      expect(manifest.project.workload).toMatchObject({
        kind: 'genai',
        apiStack: 'python-fastapi',
        pattern: 'rag'
      });
      expect(manifest.project.agents).toEqual([]);
      expect(manifest.framework).toEqual({ state: 'legacy', adapter: 'openspec' });
      expect(manifest.governance).toEqual({
        profile: 'unspecified',
        state: 'unspecified'
      });
      expect(typeof manifest.liftoffVersion).toBe('string');
      expect(manifest.liftoffVersion.length).toBeGreaterThan(0);
      expect(manifest.projectArtifacts.length).toBeGreaterThan(0);
      expect(manifest.managedArtifacts).toEqual([]);
      for (const artifact of manifest.projectArtifacts) {
        expect(artifact.generationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(Array.isArray(artifact.pathParts)).toBe(true);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads a frozen v3 manifest with explicit framework and agent state', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-v3-'));
    try {
      const fixture = await readFile(path.join(fixturesDir, 'manifest-v3.json'), 'utf8');
      await writeFile(path.join(tempRoot, 'liftoff.manifest.json'), fixture, 'utf8');

      const manifest = await loadManifest(tempRoot);
      expect(manifest.artifactVersion).toBe(3);
      expect(manifest.project.agents).toEqual(['github-copilot', 'claude']);
      expect(manifest.project.defaultAgent).toBe('claude');
      expect(manifest.framework).toEqual({
        state: 'initialized',
        adapter: 'spec-kit',
        contractVersion: '0.14.1'
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes schema v7 with framework, governance identity, and separated ownership', async () => {
    const artifacts = renderMatrixEntry({
      projectName: 'Manifest V3',
      pattern: 'rag',
      cloud: 'azure',
      agents: ['claude', 'copilot']
    });
    const manifestArtifact = artifacts.find((artifact) => artifact.logicalName === 'manifest');
    const manifest = JSON.parse(manifestArtifact?.content ?? '{}') as {
      artifactVersion: number;
      project: { agents: string[]; workload: { kind: string } };
      framework: { state: string; adapter: string; contractVersion: string };
      governance: { profile: string; policyVersion: string; activationIdentity: unknown; state: string };
    };

    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.project.workload.kind).toBe('genai');
    expect(manifest.project.agents).toEqual(['github-copilot', 'claude']);
    expect(manifest.framework).toEqual({
      state: 'initialized',
      adapter: 'openspec',
      contractVersion: '1.11.0'
    });
    expect(manifest.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '6',
      activationIdentity: currentActivationIdentity,
      state: 'handoff-generated'
    });
    expect((manifest as unknown as { managedArtifacts: unknown[] }).managedArtifacts)
      .toHaveLength(8);
    expect((manifest as unknown as { projectArtifacts: unknown[] }).projectArtifacts.length)
      .toBeGreaterThan(0);
  });

  it('records standard project identity without a GenAI pattern', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-contract-'));
    const projectRoot = path.join(tempRoot, 'standard-api');
    try {
      const artifacts = renderMatrixEntry({
        projectName: 'Standard API',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      });

      await writeArtifacts(projectRoot, artifacts);

      const manifest = await loadManifest(projectRoot);
      expect(manifest.project.workload).toEqual({
        kind: 'standard',
        apiStack: 'node-fastify',
        cloud: 'azure',
        region: 'eastus',
        frontend: false,
        environments: ['dev', 'staging', 'prod']
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records and reloads generic as an explicit schema-v7 GenAI identity', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-generic-contract-'));
    const projectRoot = path.join(tempRoot, 'generic-app');
    try {
      await writeArtifacts(projectRoot, renderMatrixEntry({
        projectName: 'Generic App',
        pattern: 'generic',
        cloud: 'azure'
      }));

      const manifest = await loadManifest(projectRoot);
      expect(manifest.artifactVersion).toBe(7);
      expect(manifest.project.workload).toMatchObject({
        kind: 'genai',
        apiStack: 'python-fastapi',
        pattern: 'generic'
      });
      expect(manifest.projectArtifacts.length).toBeGreaterThan(0);
      expect(manifest.projectArtifacts.every((artifact) =>
        artifact.generationHash.startsWith('sha256:')
      )).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records Power Apps starter identity without API fields', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-power-apps-contract-'));
    const projectRoot = path.join(tempRoot, 'power-apps-code-app');
    try {
      await writeArtifacts(projectRoot, renderMatrixEntry({
        projectName: 'Power Apps Code App',
        projectType: 'power-apps-code-app',
        codeAppsPlugin: true
      }));

      const manifest = await loadManifest(projectRoot);
      expect(manifest.project.workload).toEqual({
        kind: 'power-apps-code-app',
        starter: {
          repository: 'https://github.com/microsoft/PowerAppsCodeApps',
          path: 'templates/starter',
          commit: '3438c352483e40982f6c5c0fc36fd71f8e7adbbb'
        },
        codeAppsPlugin: true
      });
      expect('apiStack' in manifest.project.workload).toBe(false);
      expect('cloud' in manifest.project.workload).toBe(false);
      expect('environments' in manifest.project.workload).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported manifest versions with a remedy', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    try {
      await writeFile(
        path.join(tempRoot, 'liftoff.manifest.json'),
        JSON.stringify({ artifactVersion: 1, generatedBy: 'Mission Control Liftoff', artifacts: [] }),
        'utf8'
      );

      await expect(loadManifest(tempRoot)).rejects.toThrow(/Unsupported manifest artifactVersion 1.*Regenerate the project/s);

      const issues = await validateGeneratedProject(tempRoot);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('Unsupported manifest artifactVersion 1');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported project identity combinations', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    try {
      await writeFile(
        path.join(tempRoot, 'liftoff.manifest.json'),
        JSON.stringify({
          artifactVersion: 2,
          generatedBy: 'Mission Control Liftoff',
          liftoffVersion: '0.2.1',
          project: {
            name: 'Invalid',
            projectType: 'standard',
            apiStack: 'node-fastify',
            pattern: 'rag',
            cloud: 'azure',
            region: 'eastus',
            frontend: false,
            specWorkflow: 'openspec',
            environments: ['dev']
          },
          artifacts: []
        }),
        'utf8'
      );

      await expect(loadManifest(tempRoot)).rejects.toThrow(/Standard manifests cannot record a GenAI pattern/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects retired test deployment environments in manifests', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    const projectRoot = path.join(tempRoot, 'invalid-environment');
    try {
      await writeArtifacts(projectRoot, renderMatrixEntry({
        projectName: 'Invalid Environment',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }));
      const manifestPath = path.join(projectRoot, 'liftoff.manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.project.workload.environments = ['dev', 'test', 'prod'];
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      await expect(loadManifest(projectRoot)).rejects.toThrow(
        /Manifest project workload environment "test" is invalid/
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records content hashes that reproduce from the files on disk', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    const projectRoot = path.join(tempRoot, 'hash-app');
    try {
      const artifacts = renderMatrixEntry({ projectName: 'Hash App', pattern: 'rag', cloud: 'azure', includeFrontend: true });
      await writeArtifacts(projectRoot, artifacts);

      const manifest = await loadManifest(projectRoot);
      for (const artifact of manifest.managedArtifacts) {
        const bytes = await readFile(path.join(projectRoot, ...artifact.pathParts));
        const diskHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(diskHash, `hash mismatch for ${artifact.logicalName}`).toBe(artifact.contentHash);
      }
      for (const artifact of manifest.projectArtifacts) {
        const bytes = await readFile(path.join(projectRoot, ...artifact.pathParts));
        const diskHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(diskHash, `generation hash mismatch for ${artifact.logicalName}`)
          .toBe(artifact.generationHash);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
