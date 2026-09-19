import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureRetainedInputTree } from '../src/adapters/filesystem/retained-inputs.js';
import { AssessmentSnapshot } from '../src/adapters/filesystem/standards-assessment/snapshot.js';
import * as observedFiles from '../src/adapters/filesystem/observed-file.js';
import {
  boundedSourceObservationLimits, sourceObservationLimitKeys, sourceObservationLimits
} from '../src/adapters/filesystem/source-observation-limits.js';
import { captureRetainedProjectInputs } from '../src/application/update/protected-source.js';
import { captureMigrationRetainedProjectInputs } from '../src/governance-activation/historical-inputs.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'liftoff-retained-inputs-')));
  roots.push(root);
  const project = path.join(root, 'project');
  await fs.mkdir(project, { mode: 0o700 });
  return { root, project };
}

const collectors = [
  { name: 'general retained source', capture: captureRetainedProjectInputs },
  { name: 'migration retained source', capture: captureMigrationRetainedProjectInputs }
];

describe('bounded retained-source read scheduling', () => {
  it('clears an owned read buffer if the final snapshot check fails before returning it', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project, 'a.txt'), 'NONSECRET fixture');
    const snapshot = await AssessmentSnapshot.create(f.project);
    const pinned = await snapshot.inspect(['a.txt']);
    if (!pinned) throw new Error('Expected the source fixture.');
    const content = Buffer.from('NONSECRET fixture');
    vi.spyOn(observedFiles, 'readObservedFile').mockResolvedValue({ content, metadata: pinned });
    vi.spyOn(snapshot, 'inspect').mockRejectedValueOnce(new Error('Changed at final snapshot check'));
    await expect(snapshot.read(['a.txt'], 100, pinned)).rejects.toThrow('Changed at final snapshot check');
    expect(content.every((byte) => byte === 0)).toBe(true);
  });

  it('accepts only the exact pinned observation from the current snapshot and still detects byte changes', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project, 'a.txt'), 'original');
    const snapshot = await AssessmentSnapshot.create(f.project);
    const pinned = await snapshot.inspect(['a.txt']);
    if (!pinned) throw new Error('Expected the source fixture.');
    const copied = Object.assign(Object.create(Object.getPrototypeOf(pinned)), pinned);
    await expect(snapshot.read(['a.txt'], 100, copied)).rejects.toThrow('exact observation');
    const other = await AssessmentSnapshot.create(f.project);
    const foreign = await other.inspect(['a.txt']);
    await expect(snapshot.read(['a.txt'], 100, foreign!)).rejects.toThrow('exact observation');
    const observed = await snapshot.read(['a.txt'], 100, pinned);
    expect(observed.content.toString()).toBe('original');
    observed.content.fill(0);
    const current = await snapshot.inspect(['a.txt']);
    await fs.writeFile(path.join(f.project, 'a.txt'), 'changed bytes');
    await expect(snapshot.read(['a.txt'], 100, current!)).rejects.toThrow(/changed/);
  });

  it('overlaps at most three guarded reads while retaining exact bytes, modes and order', async () => {
    const f = await fixture();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await fs.writeFile(path.join(f.project, `${name}.txt`), name);
    const original = AssessmentSnapshot.prototype.read;
    let active = 0, peak = 0, entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(AssessmentSnapshot.prototype, 'read').mockImplementation(async function (this: AssessmentSnapshot, ...args) {
      active++; peak = Math.max(peak, active); entered++;
      if (entered === 3) release();
      try { await barrier; return await original.apply(this, args); }
      finally { active--; }
    });
    const result = await captureRetainedInputTree(f.project, () => true);
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(result.map((file) => file.pathParts.join('/'))).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);
    for (const file of result) {
      expect(file.digest).toBe(createHash('sha256').update(file.pathParts[0][0]).digest('hex'));
      expect(file.mode).toBe((await fs.lstat(path.join(f.project, ...file.pathParts))).mode & 0o7777);
    }
  });

  it('settles and clears every in-flight read before reporting a failure, without launching the remaining files', async () => {
    const f = await fixture();
    for (const name of ['a', 'b', 'c', 'd', 'e']) await fs.writeFile(path.join(f.project, `${name}.txt`), 'NONSECRET source');
    const original = AssessmentSnapshot.prototype.read;
    let active = 0, entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const buffers: Buffer[] = [];
    vi.spyOn(AssessmentSnapshot.prototype, 'read').mockImplementation(async function (this: AssessmentSnapshot, ...args) {
      active++; entered++;
      try {
        if (entered === 3) { release(); throw new Error('Injected guarded read failure'); }
        await barrier;
        const result = await original.apply(this, args);
        buffers.push(result.content);
        return result;
      } finally { active--; }
    });
    await expect(captureRetainedInputTree(f.project, () => true)).rejects.toThrow('Injected guarded read failure');
    expect(entered).toBe(3);
    expect(active).toBe(0);
    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
});

describe.each(collectors)('$name guarded snapshots', ({ capture }) => {
  it('keeps the original byte digest, mode and ordering without pathname reads', async () => {
    const f = await fixture();
    const content = Buffer.from('unchanged bytes\r\n');
    await fs.writeFile(path.join(f.project, 'b.txt'), content, { mode: 0o640 });
    await fs.writeFile(path.join(f.project, 'a.txt'), '');
    const before = await fs.lstat(path.join(f.project, 'b.txt'));
    const reads = vi.spyOn(fs, 'readFile');
    syncBuiltinESMExports();
    const result = await capture(f.project);
    expect(result).toEqual([
      { pathParts: ['a.txt'], digest: createHash('sha256').update('').digest('hex'),
        mode: (await fs.lstat(path.join(f.project, 'a.txt'))).mode & 0o7777 },
      { pathParts: ['b.txt'], digest: createHash('sha256').update(content).digest('hex'), mode: before.mode & 0o7777 }
    ]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('rejects a hard-linked retained input', async () => {
    const f = await fixture();
    const file = path.join(f.project, 'source.txt');
    await fs.writeFile(file, 'retained source');
    await fs.link(file, path.join(f.root, 'linked-source.txt'));
    await expect(capture(f.project)).rejects.toThrow(/singly linked/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO substituted at open without blocking', async () => {
    const f = await fixture();
    const file = path.join(f.project, 'source.txt');
    const preserved = path.join(f.root, 'original.txt');
    await fs.writeFile(file, 'original retained bytes');
    const open = fs.open;
    let moved = false;
    let substituted = false;
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === file && !moved) {
        if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK)) {
          throw new Error('Nonblocking open is required before creating the FIFO race fixture.');
        }
        await fs.rename(file, preserved);
        moved = true;
        const made = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 });
        if (made.status !== 0) throw new Error(`FIFO fixture creation failed: ${made.error?.message ?? made.stderr}`);
        substituted = true;
      }
      return open(filename, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      await expect(capture(f.project)).rejects.toThrow(/changed/);
      expect(substituted).toBe(true);
      expect((await fs.lstat(file)).isFIFO()).toBe(true);
      expect(await fs.readFile(preserved, 'utf8')).toBe('original retained bytes');
    } finally {
      if (moved) {
        if (substituted) await fs.unlink(file);
        await fs.rename(preserved, file);
      }
    }
  });

  it.each(['bytes', 'replacement'])('rejects a late %s change to an already captured file', async (change) => {
    const f = await fixture();
    const first = path.join(f.project, 'a.txt');
    const last = path.join(f.project, 'b.txt');
    await fs.writeFile(first, 'original');
    await fs.writeFile(last, 'last');
    const open = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === last && !changed) {
        changed = true;
        if (change === 'replacement') await fs.rename(first, path.join(f.root, 'preserved.txt'));
        await fs.writeFile(first, 'concurrent user change');
      }
      return open(filename, flags, mode);
    });
    syncBuiltinESMExports();
    await expect(capture(f.project)).rejects.toThrow(/changed/);
    expect(changed).toBe(true);
    expect(await fs.readFile(first, 'utf8')).toBe('concurrent user change');
    if (change === 'replacement') expect(await fs.readFile(path.join(f.root, 'preserved.txt'), 'utf8')).toBe('original');
  });

  it('rejects parent replacement even when the original leaf is moved into the new directory', async () => {
    const f = await fixture();
    const directory = path.join(f.project, 'src');
    const preserved = path.join(f.root, 'original-src');
    await fs.mkdir(directory);
    const file = path.join(directory, 'source.txt');
    await fs.writeFile(file, 'original');
    const open = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === file && !changed) {
        changed = true;
        await fs.rename(directory, preserved);
        await fs.mkdir(directory);
        await fs.rename(path.join(preserved, 'source.txt'), file);
      }
      return open(filename, flags, mode);
    });
    syncBuiltinESMExports();
    await expect(capture(f.project)).rejects.toThrow(/changed/);
    expect(changed).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('refuses an oversized file under the actual default whole-project ceiling before opening it', async () => {
    const f = await fixture();
    const file = path.join(f.project, 'large.bin');
    await fs.writeFile(file, Buffer.alloc(sourceObservationLimits.maxFileSize + 1));
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(capture(f.project)).rejects.toThrow(/bounded read limit/);
    expect(open.mock.calls.some(([filename]) => String(filename) === file)).toBe(false);
  });
});

describe('retained source traversal and protected payload budgets', () => {
  it('uses the existing whole-project observation limits, not application preparation limits', () => {
    expect(sourceObservationLimits).toEqual({
      maxFiles: 5000, maxFileSize: 2 * 1024 * 1024, maxDepth: 15,
      maxScanBytes: 50 * 1024 * 1024, scanTimeoutMs: 15_000, maxEntries: 10_000
    });
    expect(Object.isFrozen(sourceObservationLimits)).toBe(true);
  });

  it.each(sourceObservationLimitKeys)('never permits the %s limit to be widened', async (key) => {
    const f = await fixture();
    const inspect = vi.spyOn(fs, 'lstat');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => true, {
      [key]: sourceObservationLimits[key] + 1
    })).rejects.toThrow(/cannot be widened/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])('rejects an invalid observation limit %s', (maxFiles) => {
    expect(() => boundedSourceObservationLimits({ maxFiles })).toThrow(/must be an integer/);
  });

  it('rejects unknown limit names instead of silently applying a default', () => {
    // @ts-expect-error Exercise runtime rejection of an unsupported limit field.
    expect(() => boundedSourceObservationLimits({ unbounded: true })).toThrow(/Unknown/);
  });

  it('rejects an exhausted time budget before filesystem observation', async () => {
    const f = await fixture();
    const inspect = vi.spyOn(fs, 'lstat');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => true, { scanTimeoutMs: 0 })).rejects.toThrow(/time budget/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('admits the exact file-count ceiling and refuses the next file before opening it', async () => {
    const f = await fixture();
    for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(f.project, name), 'data');
    expect(await captureRetainedInputTree(f.project, () => true, { maxFiles: 2 })).toHaveLength(2);
    const extra = path.join(f.project, 'c.txt');
    await fs.writeFile(extra, 'data');
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => true, { maxFiles: 2 })).rejects.toThrow(/file-count/);
    expect(open.mock.calls.some(([filename]) => String(filename) === extra)).toBe(false);
  });

  it('enforces remaining aggregate bytes before opening another file', async () => {
    const f = await fixture();
    for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(f.project, name), 'ab');
    expect(await captureRetainedInputTree(f.project, () => true, { maxScanBytes: 4 })).toHaveLength(2);
    const extra = path.join(f.project, 'c.txt');
    await fs.writeFile(extra, 'x');
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => true, { maxScanBytes: 4 })).rejects.toThrow(/bounded read limit/);
    expect(open.mock.calls.some(([filename]) => String(filename) === extra)).toBe(false);
  });

  it('counts excluded directory entries without traversing their contents', async () => {
    const f = await fixture();
    for (const name of ['.git', '.venv', 'node_modules']) await fs.mkdir(path.join(f.project, name));
    const openDirectory = vi.spyOn(fs, 'opendir');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => false, { maxEntries: 2 })).rejects.toMatchObject({
      reason: 'count_limit_exceeded'
    });
    expect(openDirectory.mock.calls.every(([filename]) => String(filename) === f.project)).toBe(true);
  });

  it('rejects excessive depth without opening the next directory', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.project, 'nested'));
    const openDirectory = vi.spyOn(fs, 'opendir');
    syncBuiltinESMExports();
    await expect(captureRetainedInputTree(f.project, () => true, { maxDepth: 0 })).rejects.toThrow(/directory-depth/);
    expect(openDirectory.mock.calls.every(([filename]) => String(filename) === f.project)).toBe(true);
  });

  it('excludes exact historical private references and conventional payloads before opening or traversing them', async () => {
    const f = await fixture();
    const privateDirectory = path.join(f.root, 'private-values');
    await fs.mkdir(privateDirectory);
    await fs.writeFile(path.join(privateDirectory, 'do-not-read.txt'), 'protected fixture payload');
    await fs.symlink(privateDirectory, path.join(f.project, 'custom-private'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(f.project, 'terraform.tfstate'));
    await fs.writeFile(path.join(f.project, 'terraform.tfstate', 'do-not-read.txt'), 'protected fixture state');
    await fs.writeFile(path.join(f.project, '.env.production'), 'protected fixture environment');
    await fs.writeFile(path.join(f.project, 'README.md'), 'public');
    const open = vi.spyOn(fs, 'open');
    const openDirectory = vi.spyOn(fs, 'opendir');
    syncBuiltinESMExports();
    expect(await captureMigrationRetainedProjectInputs(f.project, [['custom-private']])).toEqual([
      expect.objectContaining({ pathParts: ['README.md'] })
    ]);
    expect(open.mock.calls.every(([filename]) => String(filename) === path.join(f.project, 'README.md'))).toBe(true);
    expect(openDirectory.mock.calls.every(([filename]) => String(filename) === f.project)).toBe(true);
  });
});
