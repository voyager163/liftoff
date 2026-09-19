import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import { preserveManifestProvenance } from '../src/application/project/manifest-provenance.js';
import { buildRepairedManifestV8, manifestRepairLinkPath } from '../src/application/project/repair-manifest.js';
import { buildRepairPreview } from '../src/application/repair/preview.js';
import { repairHistoryMutations } from '../src/application/repair/history.js';
import { repairValidationPolicy } from '../src/application/repair/validation.js';
import type { ManifestGeneratedProjectArtifact } from '../src/domain/project/contracts.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function write(root: string, mutation: ProjectFileMutation) {
  if (mutation.type !== 'write') throw new Error('Fixture expects a declared write.');
  const target = path.join(root, ...mutation.pathParts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, mutation.content);
}

describe('current repair writer and independent immutable provenance', () => {
  it('requires reviewed v8 metadata before any new manifest-writing repair', async () => {
    const bytes = await readFile('tests/fixtures/manifest-v7-standard-released.json');
    const source = parseManifest(JSON.parse(bytes.toString('utf8')));
    expect(() => buildRepairedManifestV8(source, bytes, [])).toThrow(/approve the manifest-8 metadata upgrade/);
    expect(await readFile('tests/fixtures/manifest-v7-standard-released.json')).toEqual(bytes);
  });

  it('links new v8 active provenance to unchanged repair receipt2 and exact original manifest bytes', async () => {
    const root = path.resolve('tests', `.repair-manifest8-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const released = await readFile('tests/fixtures/manifest-v5-standard-released.json');
    const old = parseManifest(JSON.parse(released.toString('utf8')));
    if (old.artifactVersion === 8 || old.project.workload.kind !== 'standard') throw new Error('Expected exact historical standard fixture.');
    const plan = buildProjectPlan({
      projectName: old.project.name, projectType: 'standard', apiStack: old.project.workload.apiStack,
      cloud: old.project.workload.cloud, region: old.project.workload.region,
      includeFrontend: false, environments: old.project.workload.environments,
      agents: old.project.agents, specWorkflow: old.project.specWorkflow, governanceProfile: 'none'
    }, { requireProjectName: true });
    const rendered = buildArtifacts(plan);
    const preserved = preserveManifestProvenance(old, released);
    const source = buildManifest(plan, rendered, { projectArtifacts: old.projectArtifacts, provenance: preserved.provenance });
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    const targetArtifacts = buildManifest(plan, rendered).projectArtifacts.filter(
      (artifact): artifact is ManifestGeneratedProjectArtifact => artifact.category === 'infrastructure' && typeof artifact.generatedBy === 'string'
    );
    const content = buildRepairedManifestV8(source, sourceBytes, targetArtifacts);
    const target = parseManifest(JSON.parse(content));
    expect(target.artifactVersion).toBe(8);
    expect(target.liftoffVersion).toBe(liftoffVersion);
    if (target.artifactVersion !== 8) throw new Error('Expected current writer.');
    expect(target.provenance.repairs).toHaveLength(1);
    expect(target.projectArtifacts.filter((artifact) => artifact.category !== 'infrastructure'))
      .toEqual(source.projectArtifacts.filter((artifact) => artifact.category !== 'infrastructure'));
    const mutation: ProjectFileMutation = { type: 'write', pathParts: ['liftoff.manifest.json'], content };
    const snapshots = [{ pathParts: ['liftoff.manifest.json'], content: sourceBytes, mode: 0o644 }];
    const preview = buildRepairPreview({
      projectRoot: root, snapshots, mutations: [mutation],
      scope: { layout: 'azure-flat-root-v1' }, live: false, now: new Date('2026-09-14T16:00:00Z')
    });
    const history = repairHistoryMutations({
      preview, sourceManifest: sourceBytes, snapshots, mutations: [mutation], verificationPolicy: repairValidationPolicy
    });
    const receiptMutation = history.find((entry) => entry.pathParts.at(-1) === 'receipt.json')!;
    if (receiptMutation.type !== 'write') throw new Error('Expected receipt serialization.');
    const receipt = JSON.parse(receiptMutation.content.toString());
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.repairContractVersion).toBe(1);
    expect(receipt.recipe.id).toBe('azure-local-layout');
    expect(receipt).not.toHaveProperty('adoptionContractVersion');
    const provenance = target.provenance.repairs[0]!;
    expect(provenance.sourceManifestHash).toBe(`sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`);
    expect(history.some((entry) => entry.pathParts.join('/') === manifestRepairLinkPath(provenance.recordId).join('/'))).toBe(true);
    await write(root, preserved.history!);
    for (const entry of [...history, mutation]) await write(root, entry);
    expect((await loadManifest(root)).projectArtifacts).toEqual(target.projectArtifacts);
    expect(await readFile(path.join(root, '.liftoff', 'repair-history', preview.fingerprint, 'manifest.json'))).toEqual(sourceBytes);
    await writeFile(path.join(root, '.liftoff', 'repair-history', preview.fingerprint, 'manifest.json'), '{"tampered":true}\n');
    await expect(loadManifest(root)).rejects.toThrow(/pre-repair manifest history is missing or changed/);
  });
});
