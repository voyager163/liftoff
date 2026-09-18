import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import { preserveManifestProvenance } from '../src/application/project/manifest-provenance.js';
import { buildRepairedManifestV8 } from '../src/application/project/repair-manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { ApplicationFiles } from '../src/application/repair/application-files.js';
import { applicationBounds } from '../src/application/repair/application-types.js';
import { repairHistoryMutations } from '../src/application/repair/history.js';
import { buildRepairPreview } from '../src/application/repair/preview.js';
import { repairValidationPolicy } from '../src/application/repair/validation.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import type { LiftoffManifestV8, ManifestGeneratedProjectArtifact } from '../src/domain/project/contracts.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';

const roots: string[] = [];
const historyFileLimit = 4 * 1024 * 1024;
let seed: LiftoffManifestV8;
let origin: { pathParts: string[]; content: Buffer };
let infrastructure: ManifestGeneratedProjectArtifact[];

beforeAll(async () => {
  const bytes = await readFile('tests/fixtures/manifest-v4-standard.json');
  const historical = parseManifest(JSON.parse(bytes.toString('utf8')));
  if (historical.artifactVersion === 8 || historical.project.workload.kind !== 'standard') throw new Error('Expected frozen historical standard source.');
  const workload = historical.project.workload;
  const plan = buildProjectPlan({
    projectName: historical.project.name, projectType: 'standard', apiStack: workload.apiStack,
    cloud: workload.cloud, region: workload.region, includeFrontend: workload.frontend,
    environments: workload.environments, agents: historical.project.agents,
    defaultAgent: historical.project.defaultAgent, specWorkflow: historical.project.specWorkflow,
    governanceProfile: 'none'
  }, { requireProjectName: true });
  const rendered = buildArtifacts(plan);
  const preserved = preserveManifestProvenance(historical, bytes);
  if (!preserved.history || preserved.history.type !== 'write') throw new Error('Missing immutable historical-source write.');
  seed = buildManifest(plan, rendered, { projectArtifacts: historical.projectArtifacts, provenance: preserved.provenance });
  seed.framework = structuredClone(historical.framework);
  origin = { pathParts: preserved.history.pathParts, content: bytes };
  infrastructure = buildManifest(plan, rendered).projectArtifacts.filter(
    (artifact): artifact is ManifestGeneratedProjectArtifact => artifact.category === 'infrastructure' && typeof artifact.generatedBy === 'string'
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function projectRoot() {
  const root = path.resolve('tests', `.manifest-history-bound-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function historyChain(root: string, count: number, sourceSizes?: readonly number[]) {
  let source = structuredClone(seed);
  let previousManifest = source;
  const files = new Map<string, Buffer>([[origin.pathParts.join('/'), origin.content]]);
  const sources: string[] = [], receipts: string[] = [];
  for (let index = 0; index < count; index++) {
    const compact = Buffer.from(JSON.stringify(source));
    const size = sourceSizes?.[index] ?? compact.length;
    if (size < compact.length || size > historyFileLimit) throw new Error('Fixture source must fit the unchanged per-history-file limit.');
    const original = Buffer.concat([compact, Buffer.alloc(size - compact.length, 32)]);
    const content = buildRepairedManifestV8(source, original, infrastructure);
    const mutation: ProjectFileMutation = { type: 'write', pathParts: ['liftoff.manifest.json'], content };
    const snapshots = [{ pathParts: ['liftoff.manifest.json'], content: original, mode: 0o600 }];
    const preview = buildRepairPreview({
      projectRoot: root, snapshots, mutations: [mutation], live: false,
      scope: { layout: 'azure-partial-independent-v1', index },
      now: new Date(Date.UTC(2026, 8, 15, 8, 0, index))
    });
    for (const history of repairHistoryMutations({
      preview, sourceManifest: original, snapshots, mutations: [mutation], verificationPolicy: repairValidationPolicy
    })) {
      if (history.type !== 'write') throw new Error('Expected immutable serialized history writes.');
      const key = history.pathParts.join('/');
      if (files.has(key)) throw new Error('History fixture identities unexpectedly collided.');
      files.set(key, Buffer.from(history.content));
      if (history.pathParts.at(-1) === 'manifest.json') sources.push(key);
      if (history.pathParts.at(-1) === 'receipt.json') receipts.push(key);
    }
    const next = parseManifest(JSON.parse(content));
    if (next.artifactVersion !== 8) throw new Error('Expected current repair writer.');
    previousManifest = source;
    source = next;
  }
  const totalBytes = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  return { manifest: source, previousManifest, files, sources, receipts, totalBytes };
}

async function writeChain(root: string, graph: ReturnType<typeof historyChain>) {
  for (const [relative, content] of graph.files) {
    const filename = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
  }
  const marker = Buffer.from(`${JSON.stringify(graph.manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'liftoff.manifest.json'), marker, { flag: 'wx', mode: 0o600 });
  return marker;
}

function observeHistoryReads(root: string, afterRead?: (relative: string) => Promise<void>) {
  const original = ApplicationFiles.prototype.read;
  const consumed = new Map<string, number>();
  vi.spyOn(ApplicationFiles.prototype, 'read').mockImplementation(async function (this: ApplicationFiles, parts, limit) {
    const snapshot = await original.call(this, parts, limit);
    if (this.root === root && parts[0] === '.liftoff' && snapshot.content !== undefined) {
      const relative = parts.join('/');
      consumed.set(relative, snapshot.content.length);
      await afterRead?.(relative);
    }
    return snapshot;
  });
  return consumed;
}

describe('whole-manifest immutable history bounds', () => {
  it.each([0, 1])('enforces the real aggregate byte boundary at 8 MiB + %i bytes', async (extra) => {
    const root = await projectRoot();
    const measured = historyChain(root, 2, [3 * 1024 * 1024, 3 * 1024 * 1024]);
    const overhead = measured.totalBytes - 6 * 1024 * 1024;
    const graph = historyChain(root, 2, [
      historyFileLimit, applicationBounds.totalBytes + extra - historyFileLimit - overhead
    ]);
    expect(graph.totalBytes).toBe(applicationBounds.totalBytes + extra);
    expect([...graph.files.values()].every((bytes) => bytes.length <= historyFileLimit)).toBe(true);
    const marker = await writeChain(root, graph);
    const consumed = observeHistoryReads(root);
    if (extra === 0) {
      expect((await loadManifest(root)).provenance).toEqual(graph.manifest.provenance);
      expect([...consumed.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(applicationBounds.totalBytes);
    } else {
      await expect(loadManifest(root).then(() => 'trusted manifest')).rejects.toThrow(/total byte bound exceeded/);
      expect([...consumed.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(applicationBounds.totalBytes);
    }
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(marker);
    expect(await readFile(path.join(root, ...origin.pathParts))).toEqual(origin.content);
  }, 60_000);

  it('counts all referenced history files against the unchanged 512-file limit', async () => {
    const root = await projectRoot();
    const graph = historyChain(root, Math.ceil(applicationBounds.files / 3));
    expect(graph.files.size).toBeGreaterThan(applicationBounds.files);
    expect(graph.totalBytes).toBeLessThan(applicationBounds.totalBytes);
    const marker = await writeChain(root, graph);
    const consumed = observeHistoryReads(root);
    await writeFile(path.join(root, 'liftoff.manifest.json'), JSON.stringify(graph.previousManifest));
    expect((await loadManifest(root)).provenance).toEqual(graph.previousManifest.provenance);
    expect(consumed.size).toBe(graph.files.size - 3);
    await writeFile(path.join(root, 'liftoff.manifest.json'), marker);
    consumed.clear();
    await expect(loadManifest(root).then(() => 'trusted manifest')).rejects.toThrow(/file count bound/);
    expect(consumed.size).toBe(applicationBounds.files);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(marker);
  }, 90_000);

  it.each(['origin-bytes', 'earlier-receipt', 'same-byte-replacement'] as const)(
    'rejects %s changed during a later read, without rewriting the changed history',
    async (change) => {
      const root = await projectRoot();
      const graph = historyChain(root, 2);
      const marker = await writeChain(root, graph);
      const earlier = change === 'earlier-receipt' ? graph.receipts[0]! : origin.pathParts.join('/');
      const earlierPath = path.join(root, ...earlier.split('/'));
      const original = graph.files.get(earlier)!;
      let changed = false;
      observeHistoryReads(root, async (relative) => {
        if (changed || relative !== graph.sources.at(-1)) return;
        changed = true;
        if (change === 'same-byte-replacement') {
          await rename(earlierPath, path.join(path.dirname(earlierPath), 'retained-original.json'));
          await writeFile(earlierPath, original, { flag: 'wx', mode: 0o600 });
        } else {
          await writeFile(earlierPath, Buffer.concat([original, Buffer.from(' ')]));
        }
      });
      await expect(loadManifest(root).then(() => 'trusted manifest')).rejects.toThrow(/changed during bounded inspection/);
      expect(changed).toBe(true);
      expect(await readFile(earlierPath)).toEqual(change === 'same-byte-replacement' ? original : Buffer.concat([original, Buffer.from(' ')]));
      expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(marker);
    }
  );
});
