import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleFile, bundleInventory, readBundleFile } from '../scripts/native-bundle-contract.mjs';

type Capture = {
  parents: Array<{ path: string; resolved: string; physical: string }>;
  entries: Array<{ path: string; resolved: string; physical: string; bytes: number; sha256: string; mode: number }>;
};
type Dependencies = { realpath: (file: string) => Promise<string>; lstat: typeof lstat; bundleFile: typeof bundleFile };
type OutputCapture = {
  parents: Capture['parents'];
  inventory: Awaited<ReturnType<typeof bundleInventory>>;
  physical: Array<{ path: string; physical: string; resolved: string }>;
  manifest: Awaited<ReturnType<typeof readBundleFile>>['identity'];
};
type OutputDependencies = Omit<Dependencies, 'lstat'> & {
  lstat: (file: string, options: { bigint: true }) => Promise<BigIntStats>;
  bundleInventory: typeof bundleInventory;
  readBundleFile: typeof readBundleFile;
};
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
async function outputFixture() {
  const value = await fixture();
  await writeFile(path.join(value.directory, 'bundle.json'), '{}\n', { mode: 0o600, flag: 'wx' });
  const names = ['', 'bundle.json', ...value.files.map(file => path.basename(file))];
  return { ...value, names, paths: names.map(name => path.join(value.directory, name)) };
}
async function outputWith(overrides: Partial<OutputDependencies> = {}) {
  const file = new URL('../scripts/native-bundle.mjs', import.meta.url), source = await readFile(file, 'utf8');
  const startMarker = '\nfunction physicalStamp(', endMarker = '\nasync function captureProgramAssembly(';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  expect(source.indexOf(endMarker, end + endMarker.length)).toBe(-1);
  const captureSource = source.slice(start, end);
  expect([...captureSource.matchAll(/^(?:async )?function (\w+)\(/gm)].map(match => match[1])).toEqual([
    'physicalStamp', 'assemblyFile', 'assemblyDirectories', 'assemblyFiles', 'assemblyOutput'
  ]);
  const factory = compileFunction(`${captureSource}\nreturn assemblyOutput;`,
    ['assert', 'path', 'realpath', 'lstat', 'bundleFile', 'bundleInventory', 'readBundleFile'],
    { filename: fileURLToPath(file) });
  const dependencies = { realpath, lstat, bundleFile, bundleInventory, readBundleFile, ...overrides };
  const capture: (directory: string, beforeFinalPass?: Promise<unknown>) => Promise<OutputCapture> = factory(assert, path,
    dependencies.realpath, dependencies.lstat, dependencies.bundleFile,
    dependencies.bundleInventory, dependencies.readBundleFile);
  return capture;
}

async function packedWith(root: string, files: string[], read: typeof bundleFile = bundleFile) {
  const source = await readFile(new URL('../scripts/native-bundle.mjs', import.meta.url), 'utf8');
  const startMarker = '\n  assert.deepEqual(packagedAssetIssues({ packedPaths: packagePaths, declaredFiles: pkg.files }), []);';
  const endMarker = '\n  await assertHclInputs(path.join(root, \'application\'), lock, inputs);';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  expect(source.indexOf(endMarker, end + endMarker.length)).toBe(-1);
  const records = [];
  await mkdir(path.join(root, 'application'));
  for (const file of files) {
    const identity = await bundleFile(file);
    await writeFile(path.join(root, 'application', path.basename(file)), await readFile(file), { flag: 'wx', mode: identity.mode });
    records.push({ path: path.basename(file), ...identity });
  }
  const factory = compileFunction(`return async () => {${source.slice(start + startMarker.length, end)}\n};`,
    ['assert', 'path', 'root', 'manifest', 'bundleFile']);
  const verify: () => Promise<void> = factory(assert, path, root, { package: { sourceFiles: records } }, read);
  return { verify, files: records.map(record => path.join(root, 'application', record.path)) };
}

describe('private complete installed packed-source verification', () => {
  it('retains original manifest order, caps observations at four and waits for the entire batch', async () => {
    const value = await fixture(), first = deferred(), second = deferred(), gates = new Map<string, ReturnType<typeof deferred>>();
    const completed = new Map<string, ReturnType<typeof deferred>>(), starts: string[] = [];
    let active = 0, maximum = 0;
    const { verify, files } = await packedWith(value.root, [...value.files].reverse(), async (file, maximumBytes) => {
      starts.push(file); active++; maximum = Math.max(maximum, active);
      if (starts.length === 1) first.resolve();
      if (starts.length === 5) second.resolve();
      try { await gates.get(file)!.promise; return await bundleFile(file, maximumBytes); }
      finally { active--; completed.get(file)!.resolve(); }
    });
    for (const file of files) { gates.set(file, deferred()); completed.set(file, deferred()); }
    const observation = verify();
    try {
      await first.promise; expect(starts).toEqual(files.slice(0, 4)); expect(maximum).toBe(4);
      for (const file of files.slice(0, 3)) gates.get(file)!.resolve();
      await Promise.all(files.slice(0, 3).map(file => completed.get(file)!.promise));
      expect(starts).toEqual(files.slice(0, 4));
      gates.get(files[3]!)!.resolve();
      await second.promise; expect(starts).toEqual(files.slice(0, 8));
    } finally { for (const gate of gates.values()) gate.resolve(); await observation; }
    expect(starts).toEqual(files); expect(active).toBe(0); expect(maximum).toBe(4);
  });

  it.each(['native', 'semantic'] as const)('drains reversed actual errors and preserves the earlier %s refusal before a later native error', async kind => {
    const value = await fixture(), first = deferred(), later = deferred(), earlier = deferred();
    const gates = new Map<string, ReturnType<typeof deferred>>(), errors = new Map<string, unknown>(), starts: string[] = [];
    let active = 0, settled = false;
    const { verify, files } = await packedWith(value.root, value.files, async (file, maximumBytes) => {
      starts.push(file); active++;
      if (starts.length === 1) first.resolve();
      try { await gates.get(file)!.promise; return await bundleFile(file, maximumBytes); }
      catch (error) { errors.set(file, error); throw error; }
      finally {
        active--;
        if (file === files[2]) later.resolve();
        if (file === files[0]) earlier.resolve();
      }
    });
    for (const file of files) gates.set(file, deferred());
    if (kind === 'native') await rm(files[0]!);
    else {
      const bytes = await readFile(files[0]!); bytes[0] = bytes[0]! ^ 1; await writeFile(files[0]!, bytes);
    }
    await rm(files[2]!); gates.get(files[2]!)!.resolve();
    const observation = verify().then(
      () => { settled = true; return { status: 'fulfilled' as const }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    let result: Awaited<typeof observation> | undefined;
    try {
      await first.promise; expect(starts).toEqual(files.slice(0, 4));
      await later.promise; expect(settled).toBe(false);
      gates.get(files[0]!)!.resolve(); await earlier.promise;
      expect(settled).toBe(false); expect(active).toBe(2);
    } finally { for (const gate of gates.values()) gate.resolve(); result = await observation; }
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Changed actual packed content must be refused.');
    if (kind === 'native') expect(result.reason).toBe(errors.get(files[0]!));
    else { expect(result.reason).toBeInstanceOf(assert.AssertionError); expect(String(result.reason)).toContain('Packed source bytes differ:'); }
    expect(result.reason).not.toBe(errors.get(files[2]!));
    expect(starts).toEqual(files.slice(0, 4)); expect(active).toBe(0);
  });
});

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

  describe('private original assembly complete output capture', () => {
    it('defers final complete inventory and physical observations until native settlement, then refuses actual same-byte replacement', async () => {
      const value = await outputFixture(), manifestRead = deferred(), nativeSettled = deferred();
      let inventories = 0;
      const capture = await outputWith({
        async bundleInventory(directory, limits) {
          inventories++; return bundleInventory(directory, limits);
        },
        async readBundleFile(file, maximum) {
          const captured = await readBundleFile(file, maximum);
          manifestRead.resolve(); return captured;
        }
      });
      const observation = capture(value.directory, nativeSettled.promise).then(
        result => ({ status: 'fulfilled' as const, result }),
        reason => ({ status: 'rejected' as const, reason })
      );
      try {
        await manifestRead.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(inventories).toBe(1);
        const file = value.files[0]!, before = await lstat(file, { bigint: true });
        const replacement = path.join(value.root, 'replacement.json');
        await writeFile(replacement, await readFile(file), { flag: 'wx', mode: Number(before.mode & 0o777n) });
        await rename(replacement, file);
        expect((await lstat(file, { bigint: true })).ino).not.toBe(before.ino);
      } finally { nativeSettled.resolve(); await observation; }
      const result = await observation;
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('The final physical readset must reject same-byte replacement.');
      expect(String(result.reason)).toContain('Original assembly output physical references changed.');
      expect(inventories).toBe(2);
    });

    it('retains the complete inventory, manifest and original physical entry order', async () => {
      const { directory, names } = await outputFixture(), result = await (await outputWith())(directory);
      expect(result.inventory).toEqual(await bundleInventory(directory));
      expect(result.manifest).toEqual((await readBundleFile(path.join(directory, 'bundle.json'))).identity);
      expect(result.physical.map(entry => entry.path)).toEqual(names);
      for (const entry of result.physical) {
        const file = path.join(directory, entry.path), stat = await lstat(file, { bigint: true });
        expect(entry).toEqual({
          path: entry.path, resolved: await realpath(file),
          physical: [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.uid, stat.gid,
            stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':')
        });
      }
    });

    it('limits each complete physical capture to four and drains the batch before advancing', async () => {
      const { directory, paths } = await outputFixture(), first = deferred(), second = deferred();
      const gates = new Map(paths.map(file => [file, deferred()]));
      const completed = new Map(paths.map(file => [file, deferred()]));
      const starts: string[] = [], pending = new Set<string>();
      let inventories = 0, maximumActive = 0;
      const capture = await outputWith({
        async bundleInventory(file, limits) {
          const result = await bundleInventory(file, limits); inventories++; return result;
        },
        async lstat(file, options) {
          if (inventories === 1 && gates.has(file) && !starts.includes(file)) {
            starts.push(file); pending.add(file); maximumActive = Math.max(maximumActive, pending.size);
            if (starts.length === 1) first.resolve();
            if (starts.length === 5) second.resolve();
            await gates.get(file)!.promise;
          }
          return lstat(file, options);
        },
        async realpath(file) {
          const resolved = await realpath(file);
          if (pending.delete(file)) completed.get(file)!.resolve();
          return resolved;
        }
      });
      const observation = capture(directory);
      let result: OutputCapture | undefined;
      try {
        await first.promise;
        expect(starts).toEqual(paths.slice(0, 4)); expect(maximumActive).toBe(4);
        for (const file of paths.slice(0, 3)) gates.get(file)!.resolve();
        await Promise.all(paths.slice(0, 3).map(file => completed.get(file)!.promise));
        expect(starts).toEqual(paths.slice(0, 4));
        gates.get(paths[3]!)!.resolve();
        await second.promise;
        expect(starts).toEqual(paths.slice(0, 8)); expect(maximumActive).toBe(4);
      } finally {
        for (const gate of gates.values()) gate.resolve();
        result = await observation;
      }
      expect(result.physical).toHaveLength(paths.length);
      expect(pending.size).toBe(0); expect(inventories).toBe(2);
    });

    it('drains actual reversed native errors and preserves the first original-order refusal without another batch', async () => {
      const { directory, paths } = await outputFixture(), first = deferred(), later = deferred(), earlier = deferred();
      const gates = new Map(paths.map(file => [file, deferred()]));
      gates.get(paths[3]!)!.resolve();
      const starts: string[] = [], pending = new Set<string>(), errors = new Map<string, unknown>();
      let inventories = 0, settled = false;
      const capture = await outputWith({
        async bundleInventory(file, limits) {
          const result = await bundleInventory(file, limits);
          if (++inventories === 1) { await rm(paths[1]!); await rm(paths[3]!); }
          return result;
        },
        async lstat(file, options) {
          if (inventories !== 1 || !gates.has(file) || starts.includes(file)) return lstat(file, options);
          starts.push(file); pending.add(file);
          if (starts.length === 1) first.resolve();
          await gates.get(file)!.promise;
          try { return await lstat(file, options); }
          catch (error) {
            pending.delete(file); errors.set(file, error);
            if (file === paths[3]) later.resolve();
            if (file === paths[1]) earlier.resolve();
            throw error;
          }
        },
        async realpath(file) {
          const resolved = await realpath(file); pending.delete(file); return resolved;
        }
      });
      const observation = capture(directory).then(
        value => { settled = true; return { status: 'fulfilled' as const, value }; },
        reason => { settled = true; return { status: 'rejected' as const, reason }; }
      );
      let outcome: Awaited<typeof observation> | undefined;
      try {
        await first.promise; expect(starts).toEqual(paths.slice(0, 4));
        await later.promise; expect(settled).toBe(false);
        gates.get(paths[1]!)!.resolve();
        await earlier.promise; expect(settled).toBe(false); expect(pending.size).toBe(2);
      } finally {
        for (const gate of gates.values()) gate.resolve();
        outcome = await observation;
      }
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') throw new Error('Missing physical output must not become a successful capture.');
      expect(outcome.reason).toBe(errors.get(paths[1]!));
      expect(outcome.reason).not.toBe(errors.get(paths[3]!));
      expect(outcome.reason).toMatchObject({ code: 'ENOENT', path: paths[1] });
      expect(starts).toEqual(paths.slice(0, 4)); expect(pending.size).toBe(0); expect(inventories).toBe(1);
    });

    it('still refuses actual same-byte physical replacement between the two complete captures', async () => {
      const { root, directory, files } = await outputFixture();
      let inventories = 0;
      const capture = await outputWith({ async bundleInventory(file, limits) {
        const result = await bundleInventory(file, limits);
        if (++inventories === 2) {
          const bytes = await readFile(files[0]!), mode = Number((await lstat(files[0]!)).mode & 0o777);
          await rename(files[0]!, path.join(root, 'retained-original'));
          await writeFile(files[0]!, bytes, { flag: 'wx', mode });
        }
        return result;
      } });
      await expect(capture(directory)).rejects.toThrow('Original assembly output physical references changed.');
      expect(inventories).toBe(2);
    });

    it('still rechecks the original output parent after both complete physical captures', async () => {
      const { root, directory } = await outputFixture();
      let references = 0;
      const capture = await outputWith({ async realpath(file) {
        if (file === directory && ++references === 4) {
          await rename(directory, path.join(root, 'retained-output'));
          await mkdir(directory);
        }
        return realpath(file);
      } });
      await expect(capture(directory)).rejects.toThrow('Original assembly output parent reference changed.');
      expect(references).toBe(4);
    });
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
