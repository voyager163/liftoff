import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildArtifacts } from '../../src/templates.js';
import { buildProjectPlan } from '../../src/planner.js';
import { loadManifest } from '../../src/application/project/manifest.js';
import { inspectApplicationLayout } from '../../src/application/repair/application-inventory.js';
import type {
  ApplicationPatchDocument, ApplicationPatchMapping, ApplicationVerificationCommand
} from '../../src/application/repair/application-types.js';

export async function writeFrameworkFixtureFile(root: string, parts: readonly string[], content: string | Buffer): Promise<void> {
  const target = path.join(root, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function createNodeFrameworkRepairFixture() {
  const dir = process.platform === 'win32'
    ? await mkdtemp(path.join(os.tmpdir(), 'lf-fw-')) : path.resolve(`.liftoff-framework-fixture-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const parent = await realpath(dir);
  try {
    return await populateNodeFrameworkFixture(parent);
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function populateNodeFrameworkFixture(parent: string) {
  const root = path.join(parent, 'project'), stage = path.join(parent, 'staged patch'), home = path.join(parent, 'private records');
  await Promise.all([root, stage, home].map((directory) => mkdir(directory)));
  const plan = buildProjectPlan({
    projectName: 'Actual framework repair', projectType: 'standard', apiStack: 'node',
    includeFrontend: true, environments: ['dev'], agents: ['copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(plan);
  for (const artifact of artifacts) await writeFrameworkFixtureFile(root, artifact.pathParts, artifact.content);
  const currentPrefix = ['backend', 'src'], legacyPrefix = ['backend', 'legacy-src'];
  const moved = new Map<string, string[]>();
  for (const artifact of artifacts.filter((item) =>
    item.lifecycle === 'project' && item.pathParts[0] === 'backend' && item.pathParts[1] === 'src')) {
    const legacy = [...legacyPrefix, ...artifact.pathParts.slice(2)];
    if (artifact.logicalName === 'node-backend-app') {
      await writeFrameworkFixtureFile(root, artifact.pathParts,
        `${artifact.content}\nexport const retainedRepairBusinessRule = (value: number): number => value * 7 + 3;\n`);
    }
    await mkdir(path.dirname(path.join(root, ...legacy)), { recursive: true });
    await rename(path.join(root, ...artifact.pathParts), path.join(root, ...legacy));
    moved.set(legacy.join('/'), artifact.pathParts);
  }
  const health = ['backend', 'test', 'health.test.ts'];
  await writeFrameworkFixtureFile(root, health,
    `${await readFile(path.join(root, ...health), 'utf8')}\n` +
    'import { test as reviewedRepairTest, expect as reviewedRepairExpect } from "vitest";\n' +
    'import { retainedRepairBusinessRule } from "../src/app.js";\n' +
    'reviewedRepairTest("preserves developer business behavior", () => reviewedRepairExpect(retainedRepairBusinessRule(5)).toBe(38));\n');
  const legacyText = (parts: readonly string[], content: string) => parts[0] === 'backend'
    ? content.replace(/(?<![\w-])src(?=[/"'])/gu, 'legacy-src')
    : content.replaceAll('backend/src', 'backend/legacy-src');
  const currentText = (parts: readonly string[], content: string) => parts[0] === 'backend'
    ? content.replace(/(?<![\w-])legacy-src(?=[/"'])/gu, 'src')
    : content.replaceAll('backend/legacy-src', 'backend/src');
  for (const artifact of artifacts.filter((item) =>
    item.lifecycle === 'project' && item.pathParts.at(-1) !== 'package-lock.json' &&
    !(item.pathParts[0] === 'backend' && item.pathParts[1] === 'src'))) {
    const content = await readFile(path.join(root, ...artifact.pathParts), 'utf8');
    const changed = legacyText(artifact.pathParts, content);
    if (changed !== content) await writeFrameworkFixtureFile(root, artifact.pathParts, changed);
  }
  await writeFrameworkFixtureFile(root, ['docs', 'application-layout.md'], 'Application source: `backend/legacy-src`.\n');
  await writeFrameworkFixtureFile(root, ['.github', 'workflows', 'application-check.yml'],
    "name: Application checks\non:\n  push:\n    paths: ['backend/legacy-src/**']\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test --ignore-scripts\n        working-directory: backend\n");
  const manifest = await loadManifest(root);
  const inspected = await inspectApplicationLayout(root, manifest);
  if (!inspected.report.complete || !inspected.report.target) {
    throw new Error(`Framework fixture inventory is incomplete: ${inspected.report.blockers.join('; ')}`);
  }
  const anchor = inspected.report.target.artifacts.find((entry) => entry.component === 'backend');
  if (!anchor) throw new Error('The generated Node fixture has no backend target identity.');
  const targetParts = (parts: readonly string[]) => parts[0] === 'backend' && parts[1] === 'legacy-src'
    ? [...currentPrefix, ...parts.slice(2)] : [...parts];
  const mappings: ApplicationPatchMapping[] = [];
  const expected = new Map<string, Buffer>();
  for (const file of inspected.report.files) {
    const sourceKey = file.pathParts.join('/');
    const before = await readFile(path.join(root, ...file.pathParts));
    if (!file.text && !moved.has(sourceKey)) continue;
    const destination = moved.get(sourceKey) ?? file.pathParts;
    const after = moved.has(sourceKey) ? before : Buffer.from(currentText(file.pathParts, before.toString('utf8')));
    const reviewAffectedContext = inspected.report.references.some((entry) =>
      entry.sourcePathParts.join('/') === sourceKey &&
      [...moved.keys()].some((movedPath) => entry.targetKind === 'directory'
        ? movedPath.startsWith(`${entry.targetPathParts.join('/')}/`)
        : movedPath === entry.targetPathParts.join('/')));
    if (!moved.has(sourceKey) && before.equals(after) && !reviewAffectedContext) continue;
    const target = inspected.report.target.artifacts.find((entry) => entry.pathParts.join('/') === destination.join('/'));
    const stagedPathParts = ['files', `${mappings.length}${path.extname(destination.at(-1)!) || '.txt'}`];
    await writeFrameworkFixtureFile(stage, stagedPathParts, after);
    mappings.push({
      sourcePathParts: file.pathParts, targetPathParts: destination, stagedPathParts,
      expectedSourceDigest: file.digest, expectedSourceMode: file.mode, targetMode: file.mode,
      role: moved.has(sourceKey) ? 'application' : 'reference',
      targetIdentity: { kind: target ? 'generated-artifact' : 'custom-component', logicalName: target?.logicalName ?? anchor.logicalName },
      customization: before.equals(after) ? 'preserved' : 'reviewed-edit',
      references: inspected.report.references.filter((entry) => entry.sourcePathParts.join('/') === sourceKey).map((entry) => {
        const afterTargetPathParts = targetParts(entry.targetPathParts);
        return {
          referenceId: entry.id,
          disposition: afterTargetPathParts.join('/') === entry.targetPathParts.join('/') ? 'unchanged-reviewed' : 'updated',
          afterTargetPathParts
        };
      })
    });
    expected.set(destination.join('/'), after);
  }
  const command = (cwd: string, args: string[]): ApplicationVerificationCommand => ({
    executable: 'npm', args, cwdPathParts: [cwd], timeoutMs: 120_000, maxOutputBytes: 65_536, network: false
  });
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: root,
    inspectionDigest: inspected.report.inspectionDigest, targetLayoutDigest: inspected.report.target.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: { commands: [
      command('backend', ['run', 'build', '--ignore-scripts']),
      command('backend', ['test', '--ignore-scripts']),
      command('frontend', ['run', 'build', '--ignore-scripts'])
    ] }
  };
  const patchPath = path.join(stage, 'patch.json');
  await writeFile(patchPath, `${JSON.stringify(document, null, 2)}\n`);
  const protectedParts = [
    ['liftoff.manifest.json'], ['liftoff.config.json'],
    ['backend', 'package-lock.json'], ['frontend', 'package-lock.json']
  ];
  const protectedBytes = await Promise.all(protectedParts.map(async (parts) => ({
    pathParts: parts, content: await readFile(path.join(root, ...parts))
  })));
  return { parent, root, stage, home, patchPath, document, expected, protectedBytes, moved };
}
