import { createHash } from 'node:crypto';
import { constants, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservedFileError, readObservedFile } from '../src/adapters/filesystem/observed-file.js';
import { captureInputsFile, recheckCapturedInputs } from '../src/adapters/filesystem/standards-assessment/inputs.js';
import { scanInventory, scanInventorySnapshot } from '../src/adapters/filesystem/standards-assessment/scanner.js';
import { assessProject } from '../src/application/standards-assessment/runner.js';
import * as evidence from '../src/adapters/filesystem/standards-assessment/evidence.js';
import { containsSourceCredentials } from '../src/domain/standards-assessment/sanitizer.js';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/application/project/planning.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lfa-')));
  roots.push(root);
  return root;
}

describe('bounded assessment filesystem snapshots', () => {
  it('rejects inputs through a linked parent before opening their contents', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'original'));
    await fs.writeFile(path.join(root, 'original', 'inputs.json'), '{"public":true}');
    await fs.symlink(path.join(root, 'original'), path.join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(captureInputsFile('alias/inputs.json', root)).rejects.toThrow(/link|canonical/);
    expect(open.mock.calls.length).toBe(0);
  });

  it('binds exact UTF-8 bytes and rejects invalid decoding rather than hashing replacement characters', async () => {
    const root = await fixture();
    const bytes = Buffer.from('{"label":"\\u00e9"}\r\n');
    await fs.writeFile(path.join(root, 'inputs.json'), bytes);
    const captured = await captureInputsFile('inputs.json', root);
    expect(captured.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    await fs.writeFile(path.join(root, 'invalid.json'), Buffer.from([0xc3, 0x28]));
    await expect(captureInputsFile('invalid.json', root)).rejects.toThrow(/UTF-8/);
  });

  it('invalidates renamed input directories even when the new file has identical bytes', async () => {
    const root = await fixture();
    const directory = path.join(root, 'inputs');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'public.json'), '{}');
    const captured = await captureInputsFile(path.join(directory, 'public.json'), root);
    await fs.rename(directory, path.join(root, 'old-inputs'));
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'public.json'), '{}');
    await expect(recheckCapturedInputs(captured.reference, captured.metadata)).rejects.toThrow(/changed/);
  });

  it('detects an already-read nested file changing without any project-root mtime change', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    const captured = await scanInventorySnapshot(root);
    const before = await fs.lstat(root);
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 2;\n');
    expect((await fs.lstat(root)).mtimeMs).toBe(before.mtimeMs);
    await expect(captured.assertCurrent()).rejects.toThrow(/changed/);
  });

  it('invalidates dependent comparisons when source changes after collection', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'src'));
    const source = path.join(root, 'src', 'app.ts');
    await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"fastify":"^5.0.0"}}');
    await fs.writeFile(source, "import fastify from 'fastify';\nconst app = fastify();\n");
    const extract = evidence.extractEvidence;
    vi.spyOn(evidence, 'extractEvidence').mockImplementationOnce((target, inventory) => {
      const result = extract(target, inventory);
      writeFileSync(source, 'export const newerUserWork = true;\n');
      return result;
    });
    const result = await assessProject({ targetPath: root });
    expect(result).toMatchObject({ schemaVersion: 1, outcome: 'error', exitCode: 1, recommendations: [] });
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes('changed'))).toBe(true);
    expect(result.findings.some((finding) => finding.classification === 'aligned')).toBe(false);
    expect(await fs.readFile(source, 'utf8')).toBe('export const newerUserWork = true;\n');
  });

  it('captures supported text above 512 KiB rather than silently omitting it from evidence', async () => {
    const root = await fixture();
    const text = `${' '.repeat(512 * 1024 + 1)}export const value = 1;\n`;
    await fs.writeFile(path.join(root, 'large.ts'), text);
    const inventory = await scanInventory(root);
    expect(inventory.unobserved).toEqual([]);
    expect(inventory.contentMap?.get('large.ts')).toBe(text);
    const report = await assessProject({ targetPath: root });
    expect(report.inventory).not.toHaveProperty('contentMap');
  });

  it('withholds credential-bearing names and source payloads instead of retaining them in a report', async () => {
    const root = await fixture();
    const token = `ghp_${'a'.repeat(32)}`;
    await fs.writeFile(path.join(root, `${token}.txt`), 'do not open this named payload');
    await fs.writeFile(path.join(root, 'example.ts'), `export const credential = "${token}";\n`);
    const report = await assessProject({ targetPath: root });
    expect(JSON.stringify(report)).not.toContain(token);
    expect(report.inventory.files).toEqual([]);
    expect(report.inventory.unobserved.some((entry) => entry.message.includes('withheld'))).toBe(true);
    const unsafeTarget = await assessProject({ targetPath: path.join(root, token) });
    expect(unsafeTarget.exitCode).toBe(1);
    expect(JSON.stringify(unsafeTarget)).not.toContain(token);
  });

  it('keeps actual generated model configuration with empty defaults and variable references observable', async () => {
    const root = await fixture();
    const artifact = buildArtifacts(buildProjectPlan({
      projectName: 'source-observation', pattern: 'generic', governanceProfile: 'none'
    }, { requireProjectName: true })).find((entry) => entry.logicalName === 'backend-model-config');
    if (!artifact) throw new Error('Expected the actual generated model configuration.');
    expect(containsSourceCredentials(artifact.content)).toBe(false);
    await fs.writeFile(path.join(root, 'model_config.py'), artifact.content);
    const inventory = await scanInventory(root);
    expect(inventory.unobserved).toEqual([]);
    expect(inventory.contentMap?.get('model_config.py')).toBe(artifact.content);
  });

  it('distinguishes source declarations from nonempty credential literals', () => {
    for (const source of [
      'api_key: str = ""', 'api_key=resolved.openai_api_key', 'provider = Client(api_key=config.api_key)',
      'api_key: str = Field(default="")', 'const api_key = settings.api_key;'
    ]) expect(containsSourceCredentials(source), source).toBe(false);
    for (const source of [
      'api_key = "a-private-value"', 'api_key: str = Field(default="a-private-value")',
      'const client_secret = "a-private-value";', '{"api_key": "a-private-value"}'
    ]) expect(containsSourceCredentials(source)).toBe(true);
  });

  it('rejects an invalid supplied observation clock with a versioned diagnostic', async () => {
    const root = await fixture();
    const result = await assessProject({ targetPath: root, capturedClock: 'not-a-clock' });
    expect(result).toMatchObject({ schemaVersion: 1, exitCode: 1, outcome: 'error' });
    expect(result.diagnostics[0]?.code).toBe('INVALID_OBSERVATION_CLOCK');
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  });

  it('uses the nearest manifest boundary only when no target was explicitly selected', async () => {
    const root = await fixture();
    const nested = path.join(root, 'backend', 'src');
    await fs.mkdir(nested, { recursive: true });
    const manifest = await fs.readFile(new URL('./fixtures/manifest-v7-standard-released.json', import.meta.url));
    await fs.writeFile(path.join(root, 'liftoff.manifest.json'), manifest);
    await fs.writeFile(path.join(nested, 'app.ts'), 'export const value = 1;\n');
    const implicit = await assessProject({ invocationCwd: nested });
    expect(implicit.target).toMatchObject({ projectRoot: root, scanRoot: root, hasManifest: true, manifestVersion: 7 });
    const explicit = await assessProject({ targetPath: nested, invocationCwd: root });
    expect(explicit.target).toMatchObject({ projectRoot: nested, scanRoot: nested, hasManifest: false });
    expect(explicit.inventory.files.map((file) => file.path)).toEqual(['app.ts']);
    expect(await fs.readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(manifest);
  });

  it('discloses the repository boundary for an implicit target without a manifest', async () => {
    const root = await fixture();
    const nested = path.join(root, 'backend', 'src');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(nested, 'app.ts'), 'export const value = 1;\n');
    const result = await assessProject({ invocationCwd: nested });
    expect(result.target).toMatchObject({ projectRoot: root, repositoryRoot: root, scanRoot: root, hasManifest: false });
  });

  it('rejects an inner component manifest before treating that boundary as ordinary source', async () => {
    const root = await fixture();
    const component = path.join(root, 'component');
    await fs.mkdir(component);
    await fs.writeFile(path.join(component, 'liftoff.manifest.json'), '{"artifactVersion":999}');
    const result = await assessProject({ projectRoot: root, componentPath: 'component' });
    expect(result).toMatchObject({ schemaVersion: 1, exitCode: 1, outcome: 'error' });
    expect(result.inventory.files).toEqual([]);
  });

  it('rejects an explicit root escape before filesystem inspection', async () => {
    const root = await fixture();
    const inspect = vi.spyOn(fs, 'lstat');
    const openDirectory = vi.spyOn(fs, 'opendir');
    syncBuiltinESMExports();
    const result = await assessProject({ projectRoot: root, targetPath: path.dirname(root) });
    expect(result).toMatchObject({ exitCode: 1, outcome: 'error' });
    expect(inspect.mock.calls.length).toBe(0);
    expect(openDirectory.mock.calls.length).toBe(0);
  });

  it('rejects a file that grows after stat before allocating its content buffer', async () => {
    const root = await fixture();
    const filename = path.join(root, 'changing.txt');
    await fs.writeFile(filename, 'old');
    const expected = await fs.lstat(filename);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
      await fs.writeFile(filename, 'x'.repeat(2 * 1024 * 1024));
      return open(file, flags, mode);
    });
    syncBuiltinESMExports();
    await expect(readObservedFile(filename, {
      maximumBytes: 16, expected, assertPathCurrent: async () => filename
    })).rejects.toMatchObject({ failure: 'changed-file' });
  });

  it.skipIf(process.platform === 'win32')('refuses a POSIX FIFO substituted before open without blocking or reading it', async () => {
    const root = await fixture();
    const filename = path.join(root, 'pipe');
    await fs.writeFile(filename, 'old');
    const expected = await fs.lstat(filename);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
      if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK)) {
        throw new Error('The file must be opened nonblocking before exercising a FIFO race.');
      }
      await fs.unlink(filename);
      const made = spawnSync('mkfifo', [filename], { encoding: 'utf8', timeout: 5000 });
      if (made.status !== 0) throw new Error(`Unable to create the POSIX FIFO fixture: ${made.error?.message ?? made.stderr}`);
      return open(file, flags, mode);
    });
    syncBuiltinESMExports();
    await expect(readObservedFile(filename, {
      maximumBytes: 16, expected, assertPathCurrent: async () => filename
    })).rejects.toBeInstanceOf(ObservedFileError);
    expect((await fs.lstat(filename)).isFIFO()).toBe(true);
  });
});
