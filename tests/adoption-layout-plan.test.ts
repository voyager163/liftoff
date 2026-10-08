import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareAdoptionLayoutPlan } from '../src/application/adoption/layout-plan.js';
import {
  parseProjectManifest, resolveModernManifestV8SourceContract
} from '../src/application/project/manifest.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { modernProjectSourceInput } from '../src/application/project/source-context.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function put(root: string, pathParts: readonly string[], content: string): Promise<void> {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o640 });
}

function generatedSource(projectName: string) {
  const plan = buildCurrentProjectPlan({
    projectName,
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'manual',
    agents: [],
    governanceProfile: 'none',
    includeFrontend: false
  }, { requireProjectName: true });
  const artifacts = buildCurrentArtifacts(plan);
  const manifestArtifact = artifacts.find(artifact => artifact.logicalName === 'manifest');
  if (!manifestArtifact) throw new Error('Missing current manifest fixture.');
  const manifest = parseProjectManifest(JSON.parse(manifestArtifact.content) as unknown);
  if (manifest.artifactVersion !== 8) throw new Error('Expected a v8 manifest fixture.');
  return { artifacts, source: modernProjectSourceInput(manifest) };
}

describe('static preserved-layout adoption planning', () => {
  it('retains observed generated application paths while excluding protected infrastructure and preserving Git bytes', async () => {
    const root = await directory('liftoff-adoption-layout-');
    const { artifacts, source } = generatedSource(path.basename(root));
    for (const artifact of artifacts) {
      if (artifact.logicalName !== 'manifest') await put(root, artifact.pathParts, artifact.content);
    }
    await put(root, ['.git', 'HEAD'], 'ref: refs/heads/existing\n');
    const gitBefore = await stat(path.join(root, '.git', 'HEAD'));
    const before = (await readdir(root, { recursive: true })).sort();
    const plan = await prepareAdoptionLayoutPlan(root, source);
    expect(plan.report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-layout-plan',
      readOnly: true,
      projectRoot: root,
      status: 'ready-for-candidate-inspection',
      blockers: [],
      compatibility: 'not-verified',
      deployment: 'planning-only',
      gitHistory: 'not-read-or-modified'
    });
    expect(plan.report.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalName: 'node-backend-app',
        status: 'observed-preserved',
        pathParts: ['backend', 'src', 'app.ts']
      }),
      expect.objectContaining({
        logicalName: 'opentofu-application-main',
        status: 'planning-only-excluded',
        observedDigest: null
      })
    ]));
    expect(plan.source?.activeLayout.bindings.some(binding =>
      binding.kind === 'artifact' && binding.logicalName === 'node-backend-app')).toBe(true);
    expect(plan.source?.activeLayout.bindings.some(binding =>
      binding.kind === 'artifact' && binding.logicalName.startsWith('opentofu-'))).toBe(false);
    expect(plan.report.activeLayoutDigest).toBe(manifestActiveLayoutDigest(
      plan.source!.activeLayout,
      resolveModernManifestV8SourceContract({
        selection: source.selection,
        recordedPlugins: source.plugins
      }).layoutDescriptor
    ));
    expect(Object.keys(plan)).toEqual(['report']);
    expect(JSON.stringify(plan)).not.toContain('ref: refs/heads/existing');
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(path.join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/existing\n');
    expect(await stat(path.join(root, '.git', 'HEAD'))).toMatchObject({
      ino: gitBefore.ino,
      mode: gitBefore.mode,
      mtimeMs: gitBefore.mtimeMs,
      ctimeMs: gitBefore.ctimeMs
    });
  });

  it('preserves explicit noncanonical compatible bindings without canonical-folder moves', async () => {
    const root = await directory('liftoff-adoption-noncanonical-');
    const fixture = adoptionFixture();
    const backend = fixture.source.activeLayout.bindings.find(binding =>
      binding.kind === 'artifact' && binding.logicalName !== 'root-readme');
    if (!backend || backend.kind !== 'artifact') throw new Error('Missing backend binding fixture.');
    await put(root, backend.pathParts, 'export const existingApplication = true;\n');
    await put(root, ['README.md'], 'Existing application\n');
    const plan = await prepareAdoptionLayoutPlan(root, fixture.source);
    expect(plan.report.status).toBe('ready-for-candidate-inspection');
    expect(plan.source?.activeLayout).toEqual(fixture.source.activeLayout);
    expect(plan.report.bindings).toContainEqual(expect.objectContaining({
      logicalName: backend.logicalName,
      pathParts: backend.pathParts,
      status: 'observed-preserved'
    }));
    expect(await readFile(path.join(root, ...backend.pathParts), 'utf8'))
      .toBe('export const existingApplication = true;\n');
  });

  it('blocks documentation-only evidence without constructing a candidate source', async () => {
    const root = await directory('liftoff-adoption-no-application-');
    const { source } = generatedSource(path.basename(root));
    await put(root, ['README.md'], 'Documentation is not application compatibility.\n');
    const plan = await prepareAdoptionLayoutPlan(root, source);
    expect(plan.report).toMatchObject({
      status: 'blocked',
      activeLayout: null,
      activeLayoutDigest: null,
      plannedSourceDigest: null,
      blockers: [{ code: 'supported-application-binding-unobserved' }]
    });
    expect(plan.source).toBeNull();
    expect(await readdir(root)).toEqual(['README.md']);
  });

  it('captures validated target bindings before the first asynchronous root observation', async () => {
    const root = await directory('liftoff-adoption-captured-source-');
    const { source } = generatedSource(path.basename(root));
    const mutable = {
      ...source,
      selection: {
        ...source.selection,
        project: {
          ...source.selection.project,
          workload: {
            ...source.selection.project.workload,
            environments: [...source.selection.project.workload.environments]
          },
          agents: [...source.selection.project.agents]
        }
      },
      activeLayout: {
        ...source.activeLayout,
        bindings: source.activeLayout.bindings.map(binding => ({
          ...binding,
          pathParts: [...binding.pathParts]
        }))
      }
    };
    const backend = mutable.activeLayout.bindings.find(binding =>
      binding.kind === 'artifact' && binding.logicalName === 'node-backend-app');
    if (!backend || backend.kind !== 'artifact') throw new Error('Missing mutable backend binding.');
    await put(root, backend.pathParts, 'export const captured = true;\n');
    const expected = canonicalSha256(mutable);
    const pending = prepareAdoptionLayoutPlan(root, mutable);
    backend.pathParts[0] = 'changed-after-admission';
    mutable.selection.project.name = 'Changed after admission';
    const plan = await pending;
    expect(plan.report.sourceDigest).toBe(expected);
    expect(plan.source?.selection.project.name).toBe(source.selection.project.name);
    expect(plan.report.bindings).toContainEqual(expect.objectContaining({
      logicalName: 'node-backend-app',
      pathParts: ['backend', 'src', 'app.ts'],
      status: 'observed-preserved'
    }));
  });
});
