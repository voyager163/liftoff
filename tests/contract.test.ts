import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patterns } from '../src/catalogs.js';
import { loadManifest, validateGeneratedProject, writeArtifacts } from '../src/file-system.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type { ProjectOptions } from '../src/types.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const matrix: Array<{ key: string; options: ProjectOptions }> = [
  ...patterns.map((pattern) => ({
    key: pattern.id,
    options: { projectName: `${pattern.id} App`, pattern: pattern.id, cloud: 'azure' }
  })),
  { key: 'standard-python', options: { projectName: 'Standard Python', projectType: 'standard', apiStack: 'python', cloud: 'azure' } },
  { key: 'standard-node', options: { projectName: 'Standard Node', projectType: 'standard', apiStack: 'node', cloud: 'azure' } },
  { key: 'standard-go', options: { projectName: 'Standard Go', projectType: 'standard', apiStack: 'go', cloud: 'azure' } },
  { key: 'standard-node+frontend', options: { projectName: 'Standard Node UI', projectType: 'standard', apiStack: 'node', cloud: 'azure', includeFrontend: true } },
  { key: 'rag+frontend', options: { projectName: 'rag Frontend App', pattern: 'rag', cloud: 'azure', includeFrontend: true } },
  { key: 'workflow+spec-kit', options: { projectName: 'workflow Kit App', pattern: 'workflow', cloud: 'azure', specWorkflow: 'spec-kit' } }
];

const renderMatrixEntry = (options: ProjectOptions) =>
  buildArtifacts(buildProjectPlan(options, { requireProjectName: true }));

describe('manifest contract', () => {
  it('keeps generated logical names append-only against the checked-in snapshot', async () => {
    const snapshot = JSON.parse(await readFile(path.join(fixturesDir, 'logical-names.json'), 'utf8')) as Record<string, string[]>;

    for (const entry of matrix) {
      const names = renderMatrixEntry(entry.options)
        .map((artifact) => artifact.logicalName)
        .sort();
      expect(
        names,
        `logicalName set changed for plan "${entry.key}". Logical names are an append-only public contract: ` +
          'never rename or remove one (add a CLI-side alias when a rename is unavoidable). ' +
          'If you intentionally ADDED artifacts, regenerate tests/fixtures/logical-names.json.'
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
          second[index]?.content,
          `non-deterministic rendering for "${artifact.logicalName}" in plan "${entry.key}": ` +
            'artifact content must depend only on the plan and template code (no timestamps, randomness, or environment)'
        ).toBe(artifact.content);
      }
    }
  });

  it('loads the frozen v2 manifest fixture through the loader', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    try {
      const fixture = await readFile(path.join(fixturesDir, 'manifest-v2.json'), 'utf8');
      await writeFile(path.join(tempRoot, 'liftoff.manifest.json'), fixture, 'utf8');

      const manifest = await loadManifest(tempRoot);
      expect(manifest.artifactVersion).toBe(2);
      expect(manifest.project.projectType).toBe('genai');
      expect(manifest.project.apiStack).toBe('python-fastapi');
      expect(manifest.project.pattern).toBe('rag');
      expect(typeof manifest.liftoffVersion).toBe('string');
      expect(manifest.liftoffVersion.length).toBeGreaterThan(0);
      expect(manifest.artifacts.length).toBeGreaterThan(0);
      for (const artifact of manifest.artifacts) {
        expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(Array.isArray(artifact.pathParts)).toBe(true);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
      expect(manifest.project.projectType).toBe('standard');
      expect(manifest.project.apiStack).toBe('node-fastify');
      expect(manifest.project.pattern).toBeUndefined();
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

  it('records content hashes that reproduce from the files on disk', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-contract-'));
    const projectRoot = path.join(tempRoot, 'hash-app');
    try {
      const artifacts = renderMatrixEntry({ projectName: 'Hash App', pattern: 'rag', cloud: 'azure', includeFrontend: true });
      await writeArtifacts(projectRoot, artifacts);

      const manifest = await loadManifest(projectRoot);
      for (const artifact of manifest.artifacts) {
        const bytes = await readFile(path.join(projectRoot, ...artifact.pathParts));
        const diskHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(diskHash, `hash mismatch for ${artifact.logicalName}`).toBe(artifact.contentHash);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
