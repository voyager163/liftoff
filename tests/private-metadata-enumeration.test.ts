import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import {
  createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem, ScopedMetadataEnumerationError,
  scopedMetadataEnumerationLimits, type UpdatePreviewFileSystem
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

async function withFixture(action: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  let passed = false;
  try { await action(value); passed = true; }
  finally {
    if (passed) {
      const current = await lstat(value.root);
      if (current.dev !== value.identity.dev || current.ino !== value.identity.ino ||
        current.birthtimeMs !== value.identity.birthtimeMs || current.isSymbolicLink()) {
        throw new Error('Owned metadata fixture identity changed; preserve it.');
      }
      await rm(value.root, { recursive: true, force: true });
    }
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.resolve('tests/.private-metadata-inventory-')));
  const identity = await lstat(root);
  const project = path.join(root, 'project'), home = path.join(root, 'home');
  await mkdir(project, { mode: 0o700 });
  await mkdir(path.join(project, '.git'), { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const options = { homedir: home, env: {}, repositoryRoot: project };
  const projectStat = await lstat(project);
  const projectIdentity = { device: String(projectStat.dev), inode: String(projectStat.ino), birthtime: String(projectStat.birthtimeMs) };
  const firstKey = canonicalSha256('first'), secondKey = canonicalSha256('second');
  const store = createScopedUserLocalRecordStore(project, 'governance-operation', options);
  const first = await store.write(firstKey, { kind: 'fixture-metadata', projectRoot: project, projectIdentity, scalar: 1 });
  const select = (fileSystem: UpdatePreviewFileSystem = nodeUpdatePreviewFileSystem) =>
    createScopedUserLocalRecordStore(project, 'governance-operation', { ...options, fileSystem });
  return { root, identity, project, home, options, projectIdentity, firstKey, secondKey, first, store, select,
    directory: path.dirname(first.path) };
}

describe('exact project private metadata enumeration', () => {
  it('returns a complete sorted key inventory without opening values, then reads exact original metadata', async () => withFixture(async (f) => {
    const second = await f.store.write(f.secondKey, { kind: 'second-metadata', projectRoot: f.project, originalAction: 'untouched' });
    const before = await readFile(f.first.path);
    const opened: string[] = [];
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openFile(file, access, mode) {
      opened.push(file);
      return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
    } });
    const inventory = await selected.listKeys();
    expect(inventory.keys).toEqual([f.firstKey, f.secondKey].sort());
    expect(inventory.namespace).toBe('governance-operation');
    expect(inventory.projectRoot).toBe(f.project);
    expect(inventory.projectIdentity).toMatchObject(f.projectIdentity);
    expect(inventory.totalBytes).toBe((await lstat(f.first.path)).size + (await lstat(second.path)).size);
    expect(opened).toEqual([]);
    const values = await selected.readAll();
    expect(values.keys).toEqual(inventory.keys);
    expect(values.records.map((record) => record.path).sort()).toEqual([f.first.path, second.path].sort());
    expect(values.records.find((record) => record.path === second.path)?.value).toEqual({
      kind: 'second-metadata', projectRoot: f.project, originalAction: 'untouched'
    });
    expect(await readFile(f.first.path)).toEqual(before);
  }));

  it('only inspects other-project/namespace filenames and never opens or stats their payloads', async () => withFixture(async (f) => {
    const other = path.join(f.root, 'other');
    await mkdir(other, { mode: 0o700 });
    const foreign = await createScopedUserLocalRecordStore(other, 'governance-operation', { ...f.options, repositoryRoot: other })
      .write(f.firstKey, { ciphertext: 'SYNTHETIC_FORBIDDEN_CIPHERTEXT' });
    const backup = await createScopedUserLocalRecordStore(f.project, 'repair-backup', f.options)
      .write(f.firstKey, { state: 'SYNTHETIC_FORBIDDEN_STATE' });
    const credential = path.join(f.directory, 'credential-payload.sealed');
    await writeFile(credential, 'SYNTHETIC_FORBIDDEN_CREDENTIAL', { mode: 0o600 });
    const forbidden = [foreign.path, backup.path, credential];
    const seen: string[] = [];
    const inventory = await f.select({
      ...nodeUpdatePreviewFileSystem,
      async lstat(file) { if (forbidden.includes(file)) throw new Error('Foreign payload was inspected'); return nodeUpdatePreviewFileSystem.lstat(file); },
      async openFile(file, access, mode) {
        seen.push(file);
        if (forbidden.includes(file)) throw new Error('Foreign payload was opened');
        return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
      }
    }).readAll();
    expect(inventory.keys).toEqual([f.firstKey]);
    expect(seen).toEqual([f.first.path]);
    expect(JSON.stringify(inventory)).not.toContain('SYNTHETIC_FORBIDDEN');
    await expect(createScopedUserLocalRecordStore(f.project, 'repair-backup', f.options).readAll())
      .rejects.toMatchObject({ reason: 'unsupported' });
  }));

  it('returns empty only after a complete stable scan of an existing selected directory', async () => withFixture(async (f) => {
    const inventory = await createScopedUserLocalRecordStore(f.project, 'governance-preview', f.options).readAll();
    expect(inventory.keys).toEqual([]);
    expect(inventory.records).toEqual([]);
    expect(inventory.scannedEntries).toBeGreaterThan(0);
    const absentHome = path.join(f.root, 'uninitialized-home');
    await mkdir(absentHome, { mode: 0o700 });
    await expect(createScopedUserLocalRecordStore(f.project, 'governance-operation', { ...f.options, homedir: absentHome }).readAll())
      .rejects.toBeInstanceOf(ScopedMetadataEnumerationError);
  }));

  it('never falls back to Node when a selected custom filesystem lacks enumeration or byte-read capability', async () => withFixture(async (f) => {
    const noDirectory: UpdatePreviewFileSystem = { ...nodeUpdatePreviewFileSystem, openDirectory: undefined };
    await expect(f.select(noDirectory).listKeys()).rejects.toMatchObject({ reason: 'unsupported' });
    const noBytes: UpdatePreviewFileSystem = { ...nodeUpdatePreviewFileSystem, async openFile(file, access, mode) {
      const handle = await nodeUpdatePreviewFileSystem.openFile(file, access, mode);
      return { ...handle, readBytes: undefined };
    } };
    await expect(f.select(noBytes).readAll()).rejects.toMatchObject({ reason: 'unsupported' });
    expect((await f.select(noBytes).read(f.firstKey))?.value).toMatchObject({ scalar: 1 });
  }));

  it.each([0o644, 0o700, 0o4600, 0o2600, 0o1600, 0o200])('refuses nonordinary or nonprivate metadata mode %o', async (mode) => withFixture(async (f) => {
    await chmod(f.first.path, mode);
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'unsafe' });
  }));

  it('accepts ordinary owner-read-only metadata without changing its mode', async () => withFixture(async (f) => {
    await chmod(f.first.path, 0o400);
    expect((await f.store.readAll()).records).toHaveLength(1);
    expect((await lstat(f.first.path)).mode & 0o7777).toBe(0o400);
  }));

  it.each(['symlink', 'hardlink', 'directory'] as const)('refuses a selected %s record without reading its target', async (kind) => withFixture(async (f) => {
    const other = path.join(f.root, 'private-unrelated');
    await writeFile(other, 'SYNTHETIC_DO_NOT_READ', { mode: 0o600 });
    await unlink(f.first.path);
    if (kind === 'symlink') await symlink(other, f.first.path);
    if (kind === 'hardlink') await link(other, f.first.path);
    if (kind === 'directory') await mkdir(f.first.path, { mode: 0o700 });
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openFile(file, access, mode) {
      if (file === f.first.path || file === other) throw new Error('Invalid selected record was opened');
      return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
    } });
    await expect(selected.readAll()).rejects.toMatchObject({ reason: 'unsafe' });
  }));

  it('rejects altered project or creation binding rather than adopting old records into a recreated project', async () => withFixture(async (f) => {
    await writeFile(f.first.path, JSON.stringify({ kind: 'old-metadata', projectRoot: f.project,
      projectIdentity: { ...f.projectIdentity, birthtime: '1' } }), { mode: 0o600 });
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'binding' });
    await writeFile(f.first.path, JSON.stringify({ kind: 'other-metadata', projectRoot: path.join(f.root, 'other') }), { mode: 0o600 });
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'binding' });
  }));

  it('detects project-directory recreation during a scan', async () => withFixture(async (f) => {
    let changed = false;
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openDirectory(directory) {
      const handle = await nodeUpdatePreviewFileSystem.openDirectory!(directory);
      if (!changed) {
        changed = true;
        await rename(f.project, path.join(f.root, 'original-project'));
        await mkdir(f.project, { mode: 0o700 });
      }
      return handle;
    } });
    await expect(selected.readAll()).rejects.toMatchObject({ reason: 'binding' });
  }));

  it('detects directory additions and refuses a partial key list', async () => withFixture(async (f) => {
    let changed = false;
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openDirectory(directory) {
      const handle = await nodeUpdatePreviewFileSystem.openDirectory!(directory);
      return { ...handle, async readName() {
        const name = await handle.readName();
        if (!changed) {
          changed = true;
          await writeFile(path.join(f.directory, 'another-namespace-marker'), 'do not inspect this payload', { mode: 0o600 });
        }
        return name;
      } };
    } });
    await expect(selected.listKeys()).rejects.toMatchObject({ reason: 'changed' });
  }));

  it('rechecks the selected directory after closing its iterator', async () => withFixture(async (f) => {
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openDirectory(directory) {
      const handle = await nodeUpdatePreviewFileSystem.openDirectory!(directory);
      return { ...handle, async close() {
        await handle.close();
        await writeFile(path.join(directory, 'another-namespace-close-marker'), 'unopened payload', { mode: 0o600 });
      } };
    } });
    await expect(selected.listKeys()).rejects.toMatchObject({ reason: 'changed' });
  }));

  it('checks the opened descriptor and current path before any changed-file content can be returned', async () => withFixture(async (f) => {
    let opened = false;
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openFile(file, access, mode) {
      const handle = await nodeUpdatePreviewFileSystem.openFile(file, access, mode);
      if (file === f.first.path && access === 'read' && !opened) {
        opened = true;
        await rename(file, path.join(f.root, 'retained-original-metadata'));
        await writeFile(file, '{"kind":"replacement"}', { mode: 0o600 });
      }
      return handle;
    } });
    await expect(selected.readAll()).rejects.toBeInstanceOf(ScopedMetadataEnumerationError);
  }));

  it('rechecks earlier record stamps after reading later records', async () => withFixture(async (f) => {
    const second = await f.store.write(f.secondKey, { kind: 'second' });
    const ordered = [f.first, second].sort((a, b) => a.path.localeCompare(b.path));
    let changed = false;
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openFile(file, access, mode) {
      const handle = await nodeUpdatePreviewFileSystem.openFile(file, access, mode);
      if (file === ordered[1]!.path && access === 'read' && !changed) {
        changed = true;
        await writeFile(ordered[0]!.path, '{"kind":"changed-after-read"}', { mode: 0o600 });
      }
      return handle;
    } });
    await expect(selected.readAll()).rejects.toMatchObject({ reason: 'changed' });
  }));

  it.each(['', '{broken json', '["not","metadata"]'])('rejects invalid selected metadata %j without an empty result', async (text) => withFixture(async (f) => {
    await writeFile(f.first.path, text, { mode: 0o600 });
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'invalid-record' });
  }));

  it('rejects malformed UTF-8 instead of silently replacing report bytes', async () => withFixture(async (f) => {
    await writeFile(f.first.path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), { mode: 0o600 });
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'changed' });
  }));

  it('enforces exact entry/count/byte ceilings and cannot increase hard limits', async () => withFixture(async (f) => {
    await f.store.write(f.secondKey, { kind: 'second' });
    const inventory = await f.store.listKeys();
    await expect(f.store.readAll({ maximumEntries: inventory.scannedEntries, maximumRecords: 2, maximumBytes: inventory.totalBytes }))
      .resolves.toMatchObject({ keys: inventory.keys, totalBytes: inventory.totalBytes });
    await expect(f.store.listKeys({ maximumEntries: inventory.scannedEntries - 1 })).rejects.toMatchObject({ reason: 'limit' });
    await expect(f.store.readAll({ maximumRecords: 1 })).rejects.toMatchObject({ reason: 'limit' });
    await expect(f.store.readAll({ maximumBytes: inventory.totalBytes - 1 })).rejects.toMatchObject({ reason: 'limit' });
    await expect(f.store.listKeys({ maximumFilenameBytes: 1 })).rejects.toMatchObject({ reason: 'limit' });
    await expect(f.store.listKeys({ maximumEntries: scopedMetadataEnumerationLimits.maximumEntries + 1 })).rejects.toMatchObject({ reason: 'limit' });
  }));

  it('bounds individual record size before opening it', async () => withFixture(async (f) => {
    await writeFile(f.first.path, ' '.repeat(64 * 1024 + 1), { mode: 0o600 });
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openFile() { throw new Error('Oversized metadata was opened'); } });
    await expect(selected.readAll()).rejects.toMatchObject({ reason: 'limit' });
  }));

  it('refuses malformed or unfinished exact-namespace filenames without opening them', async () => withFixture(async (f) => {
    const invalid = f.first.path.replace(`${f.firstKey}.json`, 'not-a-key.json');
    await writeFile(invalid, 'SYNTHETIC_UNOPENED', { mode: 0o600 });
    await expect(f.store.listKeys()).rejects.toMatchObject({ reason: 'unsafe' });
    await unlink(invalid);
    await writeFile(path.join(f.directory, `.${path.basename(f.first.path)}.pending`), 'SYNTHETIC_UNOPENED', { mode: 0o600 });
    await expect(f.store.readAll()).rejects.toMatchObject({ reason: 'changed' });
  }));

  it('blocks timeout/abort and closes a delayed selected directory instead of returning an empty inventory', async () => withFixture(async (f) => {
    let closed = false;
    const selected = f.select({ ...nodeUpdatePreviewFileSystem, async openDirectory(directory) {
      const handle = await nodeUpdatePreviewFileSystem.openDirectory!(directory);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ...handle, async close() { await handle.close(); closed = true; } };
    } });
    const start = performance.now();
    await expect(selected.readAll({ timeoutMs: 20 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(performance.now() - start).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closed).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(f.store.readAll({ signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted' });
  }));

  it('rejects incomplete custom directory identity rather than using native fallback metadata', async () => withFixture(async (f) => {
    await expect(f.select({ ...nodeUpdatePreviewFileSystem, async lstat(file) {
      const info = await nodeUpdatePreviewFileSystem.lstat(file);
      return { ...info, birthtimeMs: undefined,
        isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink() };
    } }).readAll()).rejects.toMatchObject({ reason: 'unsupported' });
  }));

  it('rejects a real FIFO substituted between path check and Node open without waiting for a writer', async () => withFixture(async (f) => {
    const output = path.join(f.root, 'compiled-fifo-child');
    await build({
      configFile: false, envFile: false, root: f.root, logLevel: 'silent',
      build: {
        ssr: path.resolve('tests/fixtures/private-metadata-fifo-child.ts'), outDir: output,
        emptyOutDir: false, minify: false,
        rollupOptions: { output: { entryFileNames: 'fifo-child.mjs', format: 'es' } }
      }
    });
    const child = await promisify(execFile)(process.execPath, [path.join(output, 'fifo-child.mjs'),
      f.project, f.home, f.firstKey, f.first.path], { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
    expect(JSON.parse(child.stdout)).toMatchObject({ blocked: true, substituted: 'owned-fifo' });
    expect((await lstat(f.first.path)).isFIFO()).toBe(true);
  }));
});
