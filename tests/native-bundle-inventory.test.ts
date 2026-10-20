import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleFile, bundleInventory, bundlePath, nativeBundleLimits } from '../distribution/native/native-bundle-contract.mjs';

type Dependencies = {
  bundleFile: typeof bundleFile;
  lstat: (file: string) => Promise<Stats>;
  realpath: (file: string) => Promise<string>;
  readdir: (file: string) => Promise<string[]>;
  readlink: (file: string) => Promise<string>;
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(count = 9) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-inventory-')));
  roots.push(root);
  const files = Array.from({ length: count }, (_, index) => path.join(root, `${index.toString().padStart(2, '0')}.json`));
  for (const file of files) await writeFile(file, `${path.basename(file)}\n`, { mode: 0o600, flag: 'wx' });
  return { root, files };
}
async function inventoryWith(overrides: Partial<Dependencies> = {}) {
  const file = new URL('../distribution/native/native-bundle-contract.mjs', import.meta.url);
  const source = await readFile(file, 'utf8');
  const startMarker = '\nexport async function bundleInventory(', endMarker = '\nexport function assertSystemRuntimeLibraries(';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  const containedStart = source.indexOf('\nfunction contained('), containedEnd = source.indexOf('\nexport async function bundleFile(');
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(containedStart).toBeGreaterThan(0); expect(containedEnd).toBeGreaterThan(containedStart);
  expect(source.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  expect(source.indexOf(endMarker, end + endMarker.length)).toBe(-1);
  const factory = compileFunction(`${source.slice(containedStart, containedEnd)}\n${
    source.slice(start, end).replace('\nexport async function', '\nasync function')
  }\nreturn bundleInventory;`, ['assert', 'path', 'createHash', 'lstat', 'realpath', 'readdir', 'readlink',
    'bundleFile', 'bundlePath', 'nativeBundleLimits'],
    { filename: `${fileURLToPath(import.meta.url)}.inventory-harness.mjs` });
  const dependencies: Dependencies = { lstat, realpath, readdir, readlink, bundleFile, ...overrides };
  const inventory: typeof bundleInventory = factory(assert, path, createHash, dependencies.lstat,
    dependencies.realpath, dependencies.readdir, dependencies.readlink, dependencies.bundleFile, bundlePath, nativeBundleLimits);
  return inventory;
}

describe('complete native bundle inventory file batches', () => {
  it('keeps injected copies off the canonical packaged module coverage URL', async () => {
    const { root } = await fixture(1);
    const inventory = await inventoryWith();
    const error: unknown = await inventory(root, { ...nativeBundleLimits, entries: 0 }).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(assert.AssertionError);
    if (!(error instanceof Error)) throw new Error('The actual entry bound must refuse the fixture.');
    expect(error.stack).toContain(`${fileURLToPath(import.meta.url)}.inventory-harness.mjs`);
    expect(error.stack).not.toContain(fileURLToPath(new URL('../distribution/native/native-bundle-contract.mjs', import.meta.url)));
  });

  it('retains every original depth-first entry, mode, byte identity and digest without inventorying the root manifest', async () => {
    const { root, files } = await fixture(5);
    await writeFile(path.join(root, 'bundle.json'), 'independently parsed manifest\n');
    await mkdir(path.join(root, 'nested'));
    await mkdir(path.join(root, 'nested/empty'));
    await writeFile(path.join(root, 'nested/bundle.json'), 'nested content\n');
    await writeFile(path.join(root, 'tail'), '');
    const entries = [];
    for (const file of files) entries.push({ path: path.basename(file), kind: 'file', ...await bundleFile(file) });
    entries.push({ path: 'nested', kind: 'directory', mode: (await lstat(path.join(root, 'nested'))).mode & 0o777 });
    entries.push({ path: 'nested/bundle.json', kind: 'file', ...await bundleFile(path.join(root, 'nested/bundle.json')) });
    entries.push({ path: 'nested/empty', kind: 'directory', mode: (await lstat(path.join(root, 'nested/empty'))).mode & 0o777 });
    entries.push({ path: 'tail', kind: 'file', ...await bundleFile(path.join(root, 'tail')) });
    const expected = { entries, totalBytes: entries.reduce((sum, entry) => sum + ('bytes' in entry ? entry.bytes : 0), 0),
      sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
    expect(await (await inventoryWith())(root)).toEqual(expected);
    expect(await bundleInventory(root)).toEqual(expected);
  });

  it('caps file observations at four and waits for every member before starting another batch', async () => {
    const { root, files } = await fixture(), first = deferred(), second = deferred();
    const gates = new Map(files.map(file => [file, deferred()])), completed = new Map(files.map(file => [file, deferred()]));
    const starts: string[] = [];
    let active = 0, maximum = 0;
    const inventory = await inventoryWith({ async bundleFile(file, limit) {
      starts.push(file); active++; maximum = Math.max(maximum, active);
      if (starts.length === 1) first.resolve();
      if (starts.length === 8) second.resolve();
      try { await gates.get(file)!.promise; return await bundleFile(file, limit); }
      finally { active--; completed.get(file)!.resolve(); }
    } });
    const observation = inventory(root);
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

  it('drains reversed real ENOENT failures, preserves the original first error and starts no later batch', async () => {
    const { root, files } = await fixture(), first = deferred(), later = deferred(), earlier = deferred();
    const gates = new Map(files.map(file => [file, deferred()])), errors = new Map<string, unknown>(), starts: string[] = [];
    let active = 0, settled = false;
    const inventory = await inventoryWith({ async bundleFile(file, limit) {
      starts.push(file); active++;
      if (starts.length === 1) first.resolve();
      try { await gates.get(file)!.promise; return await bundleFile(file, limit); }
      catch (error) { errors.set(file, error); throw error; }
      finally {
        active--;
        if (file === files[0]) earlier.resolve();
        if (file === files[2]) later.resolve();
      }
    } });
    const observation = inventory(root).then(
      () => { settled = true; return { status: 'fulfilled' as const }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    let result: Awaited<typeof observation>;
    try {
      await first.promise; expect(starts).toEqual(files.slice(0, 4));
      await rm(files[0]!); await rm(files[2]!);
      gates.get(files[2]!)!.resolve(); await later.promise; expect(settled).toBe(false);
      gates.get(files[0]!)!.resolve(); await earlier.promise;
      expect(settled).toBe(false); expect(active).toBe(2);
    } finally { for (const gate of gates.values()) gate.resolve(); result = await observation; }
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Actual missing bundle files must be refused.');
    expect(result.reason).toBe(errors.get(files[0]!));
    expect(result.reason).not.toBe(errors.get(files[2]!));
    expect(result.reason).toMatchObject({ code: 'ENOENT' });
    expect(starts).toEqual(files.slice(0, 4)); expect(active).toBe(0);
  });

  it.each([false, true])('drains the earlier prefix before a later traversal error (earlier file failure: %s)', async failFile => {
    const { root, files } = await fixture(), first = deferred(), release = deferred();
    const starts: string[] = [], completed: string[] = [];
    let traversalError: unknown, fileError: unknown, settled = false;
    const inventory = await inventoryWith({
      async lstat(file) {
        if (file === files[2]) {
          try { return await lstat(path.join(root, 'actual-missing-traversal')); }
          catch (error) { traversalError = error; throw error; }
        }
        return lstat(file);
      },
      async bundleFile(file, limit) {
        starts.push(file);
        if (starts.length === 1) first.resolve();
        try {
          await release.promise;
          return await bundleFile(failFile && file === files[0] ? path.join(root, 'actual-missing-file') : file, limit);
        } catch (error) { fileError = error; throw error; }
        finally { completed.push(file); }
      }
    });
    const observation = inventory(root).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; }
    );
    let error: unknown;
    try { await first.promise; expect(starts).toEqual(files.slice(0, 2)); expect(settled).toBe(false); }
    finally { release.resolve(); error = await observation; }
    expect(error).toBe(failFile ? fileError : traversalError);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(completed.sort()).toEqual(files.slice(0, 2)); expect(starts).toEqual(files.slice(0, 2));
  });

  it.each([false, true])('enforces the entry bound before reading beyond it (earlier file failure: %s)', async failFile => {
    const { root, files } = await fixture(), starts: string[] = [], probed: string[] = [];
    let fileError: unknown;
    const inventory = await inventoryWith({
      async lstat(file) { probed.push(file); return lstat(file); },
      async bundleFile(file, limit) {
        starts.push(file);
        try { return await bundleFile(failFile && file === files[0] ? path.join(root, 'absent') : file, limit); }
        catch (error) { fileError = error; throw error; }
      }
    });
    const error = await inventory(root, { ...nativeBundleLimits, entries: 2 }).then(() => undefined, reason => reason);
    if (failFile) expect(error).toBe(fileError);
    else expect(String(error)).toContain('Bundle exceeds its entry limit.');
    expect(starts).toEqual(files.slice(0, 2)); expect(probed).toEqual([root, ...files.slice(0, 2)]);
  });

  it('settles each directory boundary before recursion or observations in a later sibling', async () => {
    const { root, files } = await fixture(2), directory = path.join(root, '02-directory');
    await mkdir(directory); await writeFile(path.join(directory, 'child'), 'child');
    const tail = path.join(root, '03-tail'); await writeFile(tail, 'tail');
    const prefix = deferred(), release = deferred(), starts: string[] = [];
    let active = 0;
    const inventory = await inventoryWith({
      async readdir(file) {
        if (file === directory) expect(active).toBe(0);
        return readdir(file);
      },
      async bundleFile(file, limit) {
        if (!files.includes(file)) expect(active).toBe(0);
        starts.push(file); active++;
        if (starts.length === 1) prefix.resolve();
        try { if (files.includes(file)) await release.promise; return await bundleFile(file, limit); }
        finally { active--; }
      }
    });
    const observation = inventory(root);
    try { await prefix.promise; expect(starts).toEqual(files); }
    finally { release.resolve(); await observation; }
    expect(starts).toEqual([...files, path.join(directory, 'child'), tail]); expect(active).toBe(0);
  });

  it.runIf(process.platform !== 'win32')('settles the preceding files before reading a relative internal link', async () => {
    const { root, files } = await fixture(2), prefix = deferred(), release = deferred(), target = path.join(root, '02-link');
    await symlink(path.basename(files[0]!), target);
    let active = 0, reads = 0;
    const inventory = await inventoryWith({
      async readlink(file) { expect(active).toBe(0); reads++; return readlink(file); },
      async bundleFile(file, limit) {
        active++;
        if (active === 1) prefix.resolve();
        try { await release.promise; return await bundleFile(file, limit); }
        finally { active--; }
      }
    });
    const observation = inventory(root);
    let result: Awaited<ReturnType<typeof inventory>>;
    try { await prefix.promise; expect(active).toBe(2); expect(reads).toBe(0); }
    finally { release.resolve(); result = await observation; }
    expect(result.entries.at(-1)).toEqual({ path: '02-link', kind: 'symlink', target: path.basename(files[0]!) });
    expect(reads).toBe(1); expect(active).toBe(0);
  });

  it('retains an earlier total-byte refusal before a later native failure and drains every started file', async () => {
    const { root, files } = await fixture(), starts: string[] = [], completed: string[] = [];
    let laterError: unknown;
    const inventory = await inventoryWith({ async bundleFile(file, limit) {
      starts.push(file);
      try { return await bundleFile(file === files[2] ? path.join(root, 'absent') : file, limit); }
      catch (error) { laterError = error; throw error; }
      finally { completed.push(file); }
    } });
    const error = await inventory(root, { ...nativeBundleLimits, totalBytes: 1 }).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(assert.AssertionError); expect(error).not.toBe(laterError);
    expect(String(error)).toContain('Bundle exceeds its total byte limit.');
    expect(starts).toEqual(files.slice(0, 4)); expect(completed.sort()).toEqual(files.slice(0, 4));
  });

  it('performs every file observation again and detects actual changed bytes in a later inventory', async () => {
    const { root, files } = await fixture(), starts: string[] = [];
    const inventory = await inventoryWith({ async bundleFile(file, limit) { starts.push(file); return bundleFile(file, limit); } });
    const first = await inventory(root);
    await writeFile(files[0]!, 'changed same selected file\n');
    const second = await inventory(root);
    expect(starts).toEqual([...files, ...files]); expect(second.sha256).not.toBe(first.sha256);
    expect(second).toEqual(await bundleInventory(root));
  });
});
