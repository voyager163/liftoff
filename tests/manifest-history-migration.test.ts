import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { prepareUpdateReview } from '../src/application/update/review-plan.js';
import { updateProject } from '../src/application/update/use-case.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';
import type { HistoricalLiftoffManifest } from '../src/domain/project/contracts.js';

const fixtureRoot = path.resolve('tests/fixtures');
const roots: string[] = [];
const now = new Date('2026-09-14T16:00:00Z');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function historicalProject(file: string) {
  const parent = path.resolve('tests', `.manifest-history-${randomUUID()}`);
  roots.push(parent);
  const root = path.join(parent, 'project'), home = path.join(parent, 'home');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, '.git'), { mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const original = await readFile(path.join(fixtureRoot, file));
  const manifest = parseManifest(JSON.parse(original.toString('utf8'))) as HistoricalLiftoffManifest;
  const workload = manifest.project.workload;
  await writeFile(path.join(root, 'liftoff.manifest.json'), original);
  await writeFile(path.join(root, 'liftoff.config.json'), `${JSON.stringify({
    projectName: manifest.project.name, projectType: workload.kind, apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud, region: workload.region, includeFrontend: workload.frontend, environments: workload.environments,
    specWorkflow: manifest.project.specWorkflow, agents: manifest.project.agents.length ? manifest.project.agents : ['github-copilot'],
    ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {}), governanceProfile: 'none'
  }, null, 2)}\n`);
  const customized = manifest.projectArtifacts.find((artifact) => artifact.pathParts[0] === 'backend') ??
    manifest.projectArtifacts[0] ?? { logicalName: 'unrecorded-application', pathParts: ['business.txt'] };
  const customPath = path.join(root, ...customized.pathParts);
  await mkdir(path.dirname(customPath), { recursive: true });
  await writeFile(customPath, 'Preserved production-specific application bytes, not current starter output.\n');
  return { parent, root, home, original, manifest, customized, customPath };
}

async function runUpdate(
  fixture: Awaited<ReturnType<typeof historicalProject>>, check: boolean, approvePlan?: string
) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await updateProject({ project: fixture.root, check, approvePlan, force: false, jsonMode: true }, {
    cwd: fixture.parent, stdout, stderr, presentation: new PresentationSession({ stdout, stderr, json: true }),
    updateNow: () => now, updatePreview: { homedir: fixture.home, env: {}, repositoryRoot: fixture.root }
  });
  return { code, report: JSON.parse(stdout.text()) as { committed: boolean; reasonCode: string; plans: Array<{ mode: string; fingerprint: string }>; message?: string } };
}

describe('byte-exact supported manifest history', () => {
  it('characterizes each captured released writer without normalizing original fixture bytes', async () => {
    const index = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest-history-index.json'), 'utf8')) as {
      implementationBaseline: { commit: string };
      entries: Array<{ path: string; artifactVersion: number; sha256: string; negative: boolean }>;
    };
    expect(index.implementationBaseline.commit).toBe('70d10881b46d873118d825735696f39b6d35ebe0');
    expect(new Set(index.entries.filter((entry) => !entry.negative).map((entry) => entry.artifactVersion))).toEqual(new Set([2, 3, 4, 5, 6, 7]));
    for (const entry of index.entries) {
      const bytes = await readFile(path.join(fixtureRoot, entry.path));
      expect(digest(bytes)).toBe(entry.sha256);
      const raw = JSON.parse(bytes.toString('utf8'));
      const untouched = structuredClone(raw);
      if (entry.negative) expect(() => parseManifest(raw)).toThrow(/retired/);
      else expect(parseManifest(raw).artifactVersion).toBe(entry.artifactVersion);
      expect(raw).toEqual(untouched);
      expect(await readFile(path.join(fixtureRoot, entry.path))).toEqual(bytes);
    }
  });

  it.each([
    'manifest-v2.json', 'manifest-v3.json', 'manifest-v4-genai.json',
    'manifest-v5-standard-released.json', 'manifest-v6-genai-released.json', 'manifest-v7-standard-released.json'
  ])('reviewedly migrates %s while preserving absent/custom files and original profile uncertainty', async (file) => {
    const fixture = await historicalProject(file);
    const custom = await readFile(fixture.customPath);
    const entriesBefore = await readdir(fixture.root);
    const preview = await runUpdate(fixture, true);
    expect(preview.code, preview.report.message).toBe(2);
    expect(await readFile(path.join(fixture.root, 'liftoff.manifest.json'))).toEqual(fixture.original);
    expect(await readdir(fixture.root)).toEqual(entriesBefore);
    const fingerprint = preview.report.plans.find((plan) => plan.mode === 'normal')!.fingerprint;
    const applied = await runUpdate(fixture, false, fingerprint);
    expect(applied.code, applied.report.message).toBe(0);
    expect(applied.report.committed).toBe(true);
    const manifest = await loadManifest(fixture.root);
    expect(manifest.artifactVersion).toBe(8);
    expect(manifest.projectArtifacts).toEqual(fixture.manifest.projectArtifacts);
    expect(manifest.provenance).toMatchObject({
      kind: 'generated', origin: {
        kind: 'historical-manifest', artifactVersion: fixture.manifest.artifactVersion,
        writerVersion: fixture.manifest.liftoffVersion, contentHash: `sha256:${digest(fixture.original)}`, originalProfile: 'unknown'
      }
    });
    if (manifest.provenance?.kind !== 'generated' || manifest.provenance.origin.kind !== 'historical-manifest') throw new Error('Expected historical origin.');
    const history = path.join(fixture.root, ...manifest.provenance.origin.historyPathParts);
    expect(await readFile(history)).toEqual(fixture.original);
    expect(await readFile(fixture.customPath)).toEqual(custom);
    for (const artifact of fixture.manifest.projectArtifacts.filter((artifact) => artifact.logicalName !== fixture.customized.logicalName)) {
      await expect(access(path.join(fixture.root, ...artifact.pathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    if (fixture.manifest.framework.state === 'legacy') {
      expect(manifest.framework.state).toBe('legacy');
      expect(manifest.project.agents).toEqual([]);
    }
    const current = await inspectProjectUpdate(fixture.root);
    expect((await prepareUpdateReview(current, false, { now })).requiresApproval).toBe(false);
    await writeFile(history, '{"changed":"history"}\n');
    await expect(loadManifest(fixture.root)).rejects.toThrow(/history.*byte-mismatched/);
  });
});
