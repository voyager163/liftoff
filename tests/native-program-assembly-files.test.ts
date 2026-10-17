import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleFile } from '../scripts/native-bundle-contract.mjs';

type Capture = {
  parents: Array<{ path: string; resolved: string; physical: string }>;
  entries: Array<{ path: string; resolved: string; physical: string; bytes: number; sha256: string; mode: number }>;
};
type Dependencies = { realpath: (file: string) => Promise<string>; lstat: typeof lstat; bundleFile: typeof bundleFile };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(count = 9) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-assembly-capture-')));
  roots.push(root);
  const directory = path.join(root, 'materials');
  await mkdir(directory);
  const files = Array.from({ length: count }, (_, index) => path.join(directory, `${index.toString().padStart(2, '0')}.json`));
  for (const file of files) await writeFile(file, `${JSON.stringify({ name: path.basename(file) })}\n`, { mode: 0o600, flag: 'wx' });
  return { root, directory, files };
}
async function captureWith(overrides: Partial<Dependencies> = {}) {
  const file = new URL('../scripts/native-bundle.mjs', import.meta.url);
  const source = await readFile(file, 'utf8');
  const filename = fileURLToPath(file);
  const startMarker = '\nfunction physicalStamp(', endMarker = '\nasync function assemblyOutput(';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  expect(source.indexOf(endMarker, end + endMarker.length)).toBe(-1);
  const captureSource = source.slice(start, end);
  expect([...captureSource.matchAll(/^(?:async )?function (\w+)\(/gm)].map(match => match[1])).toEqual([
    'physicalStamp', 'assemblyFile', 'assemblyDirectories', 'assemblyFiles'
  ]);
  // Exercise the exact private capture group without adding an assembly/authority export.
  const factory = compileFunction(`${captureSource}\nreturn assemblyFiles;`,
    ['assert', 'path', 'realpath', 'lstat', 'bundleFile'], { filename });
  const dependencies = { realpath, lstat, bundleFile, ...overrides };
  const capture: (files: string[]) => Promise<Capture> =
    factory(assert, path, dependencies.realpath, dependencies.lstat, dependencies.bundleFile);
  return capture;
}

describe('private original assembly closed-set file capture', () => {
  it('retains every sorted unique path, actual byte identity and physical observation', async () => {
    const { files } = await fixture(), observed: string[] = [];
    const capture = await captureWith({ async bundleFile(file, maximum) {
      observed.push(file); return bundleFile(file, maximum);
    } });
    const result = await capture([...files].reverse().concat(files[1]!, files[7]!));
    expect(result.entries.map(entry => entry.path)).toEqual(files);
    expect([...observed].sort()).toEqual(files);
    for (const entry of result.entries) {
      const bytes = await readFile(entry.path), stat = await lstat(entry.path, { bigint: true });
      expect(entry).toEqual({
        path: entry.path, resolved: await realpath(entry.path),
        physical: [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.uid, stat.gid,
          stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':'),
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: Number(stat.mode & 0o777n)
      });
    }
  });

  it('captures the closed path set before caller mutation can affect a later batch', async () => {
    const { files } = await fixture(), capture = await captureWith(), input = [...files].reverse();
    const pending = capture(input);
    input.splice(0, input.length, '/not-an-original-input');
    expect((await pending).entries.map(entry => entry.path)).toEqual(files);
  });

  it('limits independent file observations to four and drains each batch before starting another', async () => {
    const { files } = await fixture(), first = deferred(), second = deferred();
    const gates = new Map(files.map(file => [file, deferred()]));
    const completed = new Map(files.map(file => [file, deferred()]));
    const starts: string[] = [], pending = new Set<string>();
    let maximumActive = 0;
    const capture = await captureWith({ async realpath(file) {
      if (!gates.has(file)) return realpath(file);
      if (!pending.has(file)) {
        pending.add(file); starts.push(file); maximumActive = Math.max(maximumActive, pending.size);
        if (starts.length === 1) first.resolve();
        if (starts.length === 5) second.resolve();
        await gates.get(file)!.promise;
        return realpath(file);
      }
      const result = await realpath(file);
      pending.delete(file); completed.get(file)!.resolve();
      return result;
    } });
    const observation = capture([...files].reverse());
    let result: Capture | undefined;
    try {
      await first.promise;
      expect(starts).toEqual(files.slice(0, 4));
      expect(maximumActive).toBe(4);
      for (const file of files.slice(0, 3)) gates.get(file)!.resolve();
      await Promise.all(files.slice(0, 3).map(file => completed.get(file)!.promise));
      expect(starts).toEqual(files.slice(0, 4));
      gates.get(files[3]!)!.resolve();
      await second.promise;
      expect(starts).toEqual(files.slice(0, 8));
      expect(maximumActive).toBe(4);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      result = await observation;
    }
    expect(result.entries.map(entry => entry.path)).toEqual(files);
    expect(maximumActive).toBe(4);
    expect(pending.size).toBe(0);
  });

  it('preserves the first original-order native error and settles every started file before rejection', async () => {
    const { files } = await fixture(5), first = deferred(), laterError = deferred(), earlierError = deferred();
    await rm(files[0]!); await rm(files[2]!);
    const gates = new Map(files.map(file => [file, deferred()]));
    gates.get(files[2]!)!.resolve();
    const starts: string[] = [], visited = new Set<string>(), errors = new Map<string, unknown>();
    let settled = false, active = 0;
    const capture = await captureWith({ async realpath(file) {
      if (!gates.has(file) || visited.has(file)) return realpath(file);
      visited.add(file); starts.push(file); active++;
      if (starts.length === 1) first.resolve();
      try {
        await gates.get(file)!.promise;
        return await realpath(file);
      } catch (error) {
        errors.set(file, error);
        if (file === files[2]) laterError.resolve();
        if (file === files[0]) earlierError.resolve();
        throw error;
      } finally { active--; }
    } });
    const observation = capture([...files].reverse()).then(
      value => { settled = true; return { status: 'fulfilled' as const, value }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    let outcome: Awaited<typeof observation> | undefined;
    try {
      await first.promise;
      expect(starts).toEqual(files.slice(0, 4));
      await laterError.promise;
      expect(settled).toBe(false);
      gates.get(files[0]!)!.resolve();
      await earlierError.promise;
      expect(settled).toBe(false);
      expect(active).toBe(2);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      outcome = await observation;
    }
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('Missing paths must not become a successful capture.');
    expect(outcome.reason).toBe(errors.get(files[0]!));
    expect(outcome.reason).not.toBe(errors.get(files[2]!));
    expect(outcome.reason).toMatchObject({ code: 'ENOENT', path: files[0] });
    expect(starts).toEqual(files.slice(0, 4));
    expect(active).toBe(0);
  });

  it.each(['bytes', 'same-byte-replacement'] as const)('retains the original per-file %s currentness guard', async fault => {
    const { root, files } = await fixture(4);
    const capture = await captureWith({ async bundleFile(file, maximum) {
      const identity = await bundleFile(file, maximum);
      if (file === files[1]) {
        if (fault === 'bytes') await writeFile(file, 'changed-control-bytes\n');
        else {
          const bytes = await readFile(file);
          await rename(file, path.join(root, 'retained-original.json'));
          await writeFile(file, bytes, { flag: 'wx', mode: identity.mode });
        }
      }
      return identity;
    } });
    await expect(capture(files)).rejects.toThrow('Original assembly file changed during capture.');
  });

  it('retains the actual single-link regular-file guard', async () => {
    const { root, files } = await fixture(4);
    await link(files[1]!, path.join(root, 'other-link.json'));
    await expect((await captureWith())(files)).rejects.toThrow('single-link regular file');
  });

  it('retains fresh before/after parent-directory identity checks after all file reads settle', async () => {
    const { root, directory, files } = await fixture(5);
    let directoryObservations = 0, completed = 0;
    const capture = await captureWith({
      async bundleFile(file, maximum) {
        const identity = await bundleFile(file, maximum); completed++; return identity;
      },
      async realpath(file) {
        if (file === directory && ++directoryObservations === 2) {
          expect(completed).toBe(files.length);
          await rename(directory, path.join(root, 'retained-materials'));
          await mkdir(directory);
        }
        return realpath(file);
      }
    });
    await expect(capture(files)).rejects.toThrow('Original assembly parent reference changed.');
    expect(directoryObservations).toBe(2);
    expect(completed).toBe(files.length);
  });

  it.each([{ kind: 'empty', files: [] }, { kind: 'oversized', files: Array.from({ length: 32769 }, (_, index) => `not-read-${index}`) }])(
    'rejects a $kind closed inventory before any filesystem observation', async ({ files }) => {
      let observed = 0;
      const capture = await captureWith({ async realpath(file) {
        observed++; return realpath(file);
      } });
      await expect(capture(files)).rejects.toThrow('Original assembly file inventory is empty or oversized.');
      expect(observed).toBe(0);
    });
});
