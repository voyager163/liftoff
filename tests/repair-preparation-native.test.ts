import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectApplicationLayout, inspectApplicationPatch, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { applicationVerificationFixtureContext } from './fixtures/repair-application.js';
import { createPreparationFixture } from './fixtures/repair-preparation.js';

const roots: string[] = [];
async function fixture(options: Parameters<typeof createPreparationFixture>[1]) {
  const directory = path.resolve(`.repair preparation native ${randomUUID()}`);
  roots.push(directory);
  return createPreparationFixture(directory, options);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 2 })));
});
const native = process.env.LIFTOFF_REPAIR_PREPARATION_NATIVE === '1';

describe('native locked application preparation qualification', () => {
  it.skipIf(!native)('prepares real generated Node and Vue locks, builds both, and runs existing backend plus preserved customer behavior tests', async () => {
    const f = await fixture({ frontend: true });
    const before = await inspectApplicationLayout(f.root, f.manifest);
    const manifest = await readFile(path.join(f.root, 'liftoff.manifest.json'));
    const lock = await readFile(path.join(f.root, 'backend', 'package-lock.json'));
    const frontendLock = await readFile(path.join(f.root, 'frontend', 'package-lock.json'));
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const result = await verifyApplicationPatch(f.root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }));
    expect(result.status, result.blockers.join('\n')).toBe('passed');
    expect(result.preparation.map((item) => [item.provider, item.status])).toEqual([['npm-ci', 'passed'], ['npm-ci', 'passed']]);
    expect(result.commands).toHaveLength(3);
    expect(result.commands.every((item) => item.passed && item.status === 0)).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect(result.inspectedProjectUnchanged).toBe(true);
    expect((await inspectApplicationLayout(f.root, f.manifest)).report.inspectionDigest).toBe(before.report.inspectionDigest);
    expect(await readFile(path.join(f.root, 'liftoff.manifest.json'))).toEqual(manifest);
    expect(await readFile(path.join(f.root, 'backend', 'package-lock.json'))).toEqual(lock);
    expect(await readFile(path.join(f.root, 'frontend', 'package-lock.json'))).toEqual(frontendLock);
    await expect(lstat(path.join(f.root, 'backend', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(f.root, 'frontend', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(f.root, 'backend', 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(f.root, 'backend', 'src', 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 480_000);

  it.skipIf(!native)('prepares real Python wheels with the existing private-qualified uv/interpreter and runs generated FastAPI tests', async () => {
    const f = await fixture({ stack: 'python-fastapi' });
    const before = await inspectApplicationLayout(f.root, f.manifest);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { env: process.env });
    expect(candidate.blockers).toEqual([]);
    const runner = new NodeCommandRunner(), execute = runner.run.bind(runner), failureKinds: string[] = [];
    runner.run = async (command, options) => {
      const actual = await execute(command, options);
      if (actual.status !== 0) {
        const text = `${actual.stdout}\n${actual.stderr}`;
        for (const known of ['AssertionError', 'ValidationError', 'ImportError', 'ModuleNotFoundError', 'TypeError',
          'AttributeError', 'RuntimeError', 'PermissionError', 'SyntaxError', 'test_health', 'test_ready', 'test_cors_preflight_for_local_frontend']) {
          if (text.includes(known)) failureKinds.push(known);
        }
      }
      return actual;
    };
    const result = await verifyApplicationPatch(f.root, candidate, runner,
      await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }, { env: process.env }));
    expect(result.status, `${result.blockers.join('\n')}\nKnown fixture failure kinds: ${failureKinds.join(', ')}`).toBe('passed');
    expect(result.preparation.map((item) => item.status)).toEqual(['passed']);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.passed).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect((await inspectApplicationLayout(f.root, f.manifest)).report.inspectionDigest).toBe(before.report.inspectionDigest);
    await expect(lstat(path.join(f.root, 'backend', '.venv'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 480_000);

  it.skipIf(!native)('prepares actual Go module/checksum inputs with the local toolchain and runs generated tests from private caches', async () => {
    const f = await fixture({ stack: 'go-huma' });
    const before = await inspectApplicationLayout(f.root, f.manifest);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const result = await verifyApplicationPatch(f.root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }));
    expect(result.status, result.blockers.join('\n')).toBe('passed');
    expect(result.preparation.map((item) => [item.provider, item.status])).toEqual([['go-mod-download', 'passed']]);
    expect(result.commands[0]?.passed).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect((await inspectApplicationLayout(f.root, f.manifest)).report.inspectionDigest).toBe(before.report.inspectionDigest);
  }, 480_000);

  it.skipIf(!native)('reports an actual fresh-private-cache miss without an unapproved npm network fallback', async () => {
    const f = await fixture({ network: false });
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const result = await verifyApplicationPatch(f.root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: false }));
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('private-cache-miss');
    expect(result.commands).toEqual([]);
    expect(result.preparation[0]?.status).toBe('failed');
    expect(result.cleanupComplete).toBe(true);
  }, 240_000);
});
