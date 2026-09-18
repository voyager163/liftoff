import * as fs from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBoundedPackagedFile, validatePackagedPathParts } from '../src/adapters/packaged-assets/resource-file.js';

vi.mock('node:fs', { spy: true });

describe('Shared bounded packaged resource reads', () => {
  let root: string;
  const parts = ['assets', 'example.txt'];
  beforeEach(async () => {
    root = path.resolve(`tests/.resource-read-${process.pid}-${randomUUID()}`);
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, ...parts), 'data');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('reads the exact maximum and refuses a single byte beyond it', async () => {
    expect(readBoundedPackagedFile(root, parts, { maximumBytes: 4, expectedSize: 4 }).toString()).toBe('data');
    await writeFile(path.join(root, ...parts), 'data5');
    expect(() => readBoundedPackagedFile(root, parts, { maximumBytes: 4 })).toThrow(/size|bound/i);
  });

  it('streams only the bounded directory inventory instead of allocating every entry', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    const parent = path.join(root, 'assets');
    for (let index = 1; index < 16_384; index++) {
      original.writeFileSync(path.join(parent, `entry-${index}`), '');
    }
    expect(readBoundedPackagedFile(root, parts).toString()).toBe('data');
    for (let index = 16_384; index < 16_400; index++) {
      original.writeFileSync(path.join(parent, `entry-${index}`), '');
    }
    const rootDirectory = original.opendirSync(root);
    const directory = original.opendirSync(parent);
    const read = directory.readSync.bind(directory);
    let reads = 0;
    Object.defineProperty(directory, 'readSync', {
      value: () => {
        reads++;
        return read();
      }
    });
    vi.mocked(fs.opendirSync).mockReturnValueOnce(rootDirectory).mockReturnValueOnce(directory);
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/bounded directory inventory/);
    expect(reads).toBe(16_385);
  }, 30_000);

  it.each([['..'], ['a/b'], ['a\\b'], ['C:'], ['NUL'], ['x.'], ['x '], ['\u0000x'], ['a\u0001'], ['e\u0301']])(
    'rejects an ambiguous or nonportable resource component: %j', (parts) => {
      expect(() => validatePackagedPathParts(parts)).toThrow();
    }
  );

  it('rejects root and parent links without returning external bytes', async () => {
    const original = path.join(root, 'assets-original');
    await rename(path.join(root, 'assets'), original);
    await symlink(original, path.join(root, 'assets'), 'dir');
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/link|alias|identity/);
    expect(await readFile(path.join(original, 'example.txt'), 'utf8')).toBe('data');
    const alias = path.join(root, 'root-alias');
    await symlink(root, alias, 'dir');
    expect(() => readBoundedPackagedFile(alias, parts)).toThrow(/root|identity/);
  });

  it('does not turn failed reads into missing resources or trusted empty content', async () => {
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/permission denied/);
    expect(await readFile(path.join(root, ...parts), 'utf8')).toBe('data');
  });

  it('detects a same-byte file replacement during the bounded read', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.readSync).mockImplementationOnce((descriptor, buffer, offset, length, position) => {
      const result = original.readSync(descriptor, buffer, offset, length, position);
      original.renameSync(path.join(root, ...parts), path.join(root, 'previous.txt'));
      original.writeFileSync(path.join(root, ...parts), 'data');
      return result;
    });
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/changed/);
    expect(await readFile(path.join(root, ...parts), 'utf8')).toBe('data');
    expect(await readFile(path.join(root, 'previous.txt'), 'utf8')).toBe('data');
  });

  it('detects parent replacement even when the original file inode is moved back', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.readSync).mockImplementationOnce((descriptor, buffer, offset, length, position) => {
      const result = original.readSync(descriptor, buffer, offset, length, position);
      original.renameSync(path.join(root, 'assets'), path.join(root, 'old-assets'));
      original.mkdirSync(path.join(root, 'assets'));
      original.renameSync(path.join(root, 'old-assets', 'example.txt'), path.join(root, ...parts));
      return result;
    });
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/changed/);
    expect(await readFile(path.join(root, ...parts), 'utf8')).toBe('data');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO swapped in before open without blocking', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockImplementationOnce((file, flags, mode) => {
      original.renameSync(String(file), path.join(root, 'previous.txt'));
      execFileSync('mkfifo', [String(file)]);
      return original.openSync(file, flags, mode);
    });
    expect(() => readBoundedPackagedFile(root, parts)).toThrow(/changed while opening/);
    expect(await readFile(path.join(root, 'previous.txt'), 'utf8')).toBe('data');
  });
});
