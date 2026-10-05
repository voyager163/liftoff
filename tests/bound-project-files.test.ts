import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertBoundProjectPath, readBoundProjectFileSnapshot, readBoundProjectFileDigest,
  type BoundFileReadOptions, type BoundPathDiagnostics
} from '../src/adapters/filesystem/bound-project-files.js';
import { FileSystemError } from '../src/domain/project/errors.js';

interface BoundaryIo {
  calls: Array<{ operation: 'readdir' | 'lstat' | 'open'; target: string }>;
  failure?: { operation: 'readdir' | 'lstat' | 'open'; target: string; error: Error };
  names?: { directory: string; entries: string[] };
  beforeOpen?: (target: string) => Promise<void>;
  afterOpen?: (handle: FileHandle, target: string, flags: string | number | undefined) => Promise<void>;
}

const io = vi.hoisted((): BoundaryIo => ({ calls: [] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  function observe(operation: BoundaryIo['calls'][number]['operation'], target: string) {
    io.calls.push({ operation, target });
    if (io.failure?.operation === operation && io.failure.target === target) throw io.failure.error;
  }
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const target = String(args[0]);
      observe('readdir', target);
      if (io.names?.directory === target) return [...io.names.entries];
      return actual.readdir(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      observe('lstat', String(args[0]));
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      observe('open', target);
      await io.beforeOpen?.(target);
      const handle = await actual.open(...args);
      await io.afterOpen?.(handle, target, args[1]);
      return handle;
    }
  };
});

const roots: string[] = [];
const raw = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0xff, 0x00, 0x7d, 0x0d, 0x0a]);
const diagnostics: BoundPathDiagnostics = {
  pathLabel: 'Fixture path',
  invalid(detail) { throw new FileSystemError(`Bound fixture: ${detail}`); }
};
const options: BoundFileReadOptions = { maximumBytes: 1024, linkPolicy: 'single-link', diagnostics };
const policies = ['transaction-compatible', 'single-link'] as const;
const digestOptions = { ...options, linkPolicy: 'single-link' as const };

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bpf-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces');
  const outside = path.join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

function uncheckedRead(root: unknown, parts: unknown, input: unknown): unknown {
  return Reflect.apply(readBoundProjectFileSnapshot, undefined, [root, parts, input]);
}

afterEach(async () => {
  delete io.failure;
  delete io.names;
  delete io.beforeOpen;
  delete io.afterOpen;
  io.calls.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('bound file API input admission before filesystem access', () => {
  const unobservedRoot = path.resolve('never-access-this-fixture');

  it.each([
    0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, 32 * 1024 * 1024 + 1, '1024'
  ])('rejects invalid maximumBytes %s before I/O', async (maximumBytes) => {
    await expect(uncheckedRead(unobservedRoot, ['source'], { ...options, maximumBytes }))
      .rejects.toThrow('maximumBytes must be a positive safe integer no greater than 33554432');
    expect(io.calls).toEqual([]);
  });

  it.each([
    undefined, null, [], {}, { ...options, extra: true },
    { maximumBytes: 1, diagnostics },
    { ...options, linkPolicy: 'follow-links' },
    { ...options, diagnostics: { pathLabel: 'fixture' } },
    { ...options, diagnostics: { ...diagnostics, invalid: 'not a function' } },
    { ...options, diagnostics: { ...diagnostics, extra: true } },
    { ...options, diagnostics: { ...diagnostics, pathLabel: '' } },
    { ...options, diagnostics: { ...diagnostics, pathLabel: 'unsafe\nlabel' } }
  ])('rejects malformed or expanded options %# without accessing the root', async (input) => {
    await expect(uncheckedRead(unobservedRoot, ['source'], input)).rejects.toBeInstanceOf(FileSystemError);
    expect(io.calls).toEqual([]);
  });

  it('does not invoke accessor options or diagnostics and rejects hidden/symbol fields', async () => {
    const getter = vi.fn(() => 1024);
    const maximumAccessor = Object.defineProperty({ ...options }, 'maximumBytes', { get: getter });
    const diagnosticAccessor = Object.defineProperty({ ...diagnostics }, 'invalid', { get: getter });
    const hidden = Object.defineProperty({ ...options }, 'hidden', { value: true });
    const symbol = { ...options, [Symbol('unreviewed')]: true };
    for (const input of [maximumAccessor, { ...options, diagnostics: diagnosticAccessor }, hidden, symbol]) {
      await expect(uncheckedRead(unobservedRoot, ['source'], input)).rejects.toBeInstanceOf(FileSystemError);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(io.calls).toEqual([]);
  });

  it.each([
    undefined, '', 'relative-project', `${unobservedRoot}${path.sep}`,
    path.join(unobservedRoot, 'nested') + `${path.sep}..`,
    `${unobservedRoot}${path.sep}${path.sep}nested`, `${unobservedRoot}\0`,
    '\\\\?\\C:\\project', '\\\\.\\C:\\project'
  ])('rejects noncanonical selected root %# without resolving or retargeting it', async (root) => {
    await expect(uncheckedRead(root, ['source'], options)).rejects.toThrow('project root must be an absolute canonical path');
    expect(io.calls).toEqual([]);
  });

  it.each([
    undefined, 'source', [], [''], [' '], ['..'], ['.'], ['a/b'], ['a\\b'], ['C:'],
    ['CON'], ['name.'], ['name '], ['stream:name'], ['wild?card'], ['name\u007f'],
    ['x'.repeat(256)], Array<string>(65).fill('part'), Array<string>(9).fill('x'.repeat(250)),
    Array<string>(2), Object.assign(['source'], { extra: 'unreviewed' })
  ])('rejects unsafe, sparse, expanded or oversized path parts %# before I/O', async (parts) => {
    await expect(uncheckedRead(unobservedRoot, parts, options)).rejects.toBeInstanceOf(FileSystemError);
    expect(io.calls).toEqual([]);
  });

  it('rejects inherited path entries and getters without evaluating them', async () => {
    const getter = vi.fn(() => 'source');
    const accessor = Object.defineProperty(['source'], '0', { get: getter });
    const inherited = Object.setPrototypeOf(Array<string>(1), Object.assign([], { 0: 'source' }));
    const symbol = Object.assign(['source'], { [Symbol('extra')]: true });
    for (const parts of [accessor, inherited, symbol]) {
      await expect(uncheckedRead(unobservedRoot, parts, options)).rejects.toBeInstanceOf(FileSystemError);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(io.calls).toEqual([]);
  });

  it('rejects a diagnostic handler that returns instead of refusing an invalid operation', async () => {
    await expect(uncheckedRead(unobservedRoot, ['source'], {
      ...options, maximumBytes: 0, diagnostics: { pathLabel: 'Fixture path', invalid() {} }
    })).rejects.toThrow('diagnostic handler returned without rejecting');
    expect(io.calls).toEqual([]);
  });

  it('checks assertion inputs without granting access or returning a pathname', async () => {
    await expect(Reflect.apply(assertBoundProjectPath, undefined, ['relative', ['source'], diagnostics]))
      .rejects.toThrow('absolute canonical path');
    await expect(assertBoundProjectPath(unobservedRoot, Array<string>(1), diagnostics))
      .rejects.toThrow('dense plain array');
    expect(io.calls).toEqual([]);
    const { root } = await fixture();
    expect(await assertBoundProjectPath(root, ['missing', 'source'], diagnostics)).toBeUndefined();
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    await expect(lstat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('exact bounded file observations', () => {
  it.each(policies)('preserves raw bytes, exact path parts and actual modes under %s', async (linkPolicy) => {
    const { root } = await fixture();
    const parts = ['raw file.bin'];
    const file = path.join(root, ...parts);
    await writeFile(file, raw, { mode: 0o640 });
    const mode = (await lstat(file)).mode & 0o7777;
    const snapshot = await readBoundProjectFileSnapshot(root, Object.freeze(parts), {
      ...options, maximumBytes: raw.length, linkPolicy
    });
    expect(snapshot).toEqual({ pathParts: ['raw file.bin'], content: raw, mode });
    expect(snapshot.pathParts).not.toBe(parts);
    expect(await readFile(file)).toEqual(raw);
  });

  it.each(policies)('reports only confirmed missing files/parents as absent under %s', async (linkPolicy) => {
    const { root } = await fixture();
    for (const parts of [['missing'], ['missing', 'nested']]) {
      expect(await readBoundProjectFileSnapshot(root, parts, { ...options, linkPolicy }))
        .toEqual({ pathParts: parts });
    }
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    await expect(lstat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(policies)('distinguishes an empty regular file from a missing one under %s', async (linkPolicy) => {
    const { root } = await fixture();
    const file = path.join(root, 'empty');
    await writeFile(file, '');
    expect(await readBoundProjectFileSnapshot(root, ['empty'], { ...options, maximumBytes: 1, linkPolicy }))
      .toEqual({ pathParts: ['empty'], content: Buffer.alloc(0), mode: (await lstat(file)).mode & 0o7777 });
  });

  it('accepts the existing 32 MiB ceiling without allocating to that ceiling for a small file', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'small');
    await writeFile(file, raw);
    let opened: FileHandle | undefined;
    io.afterOpen = async (handle) => {
      opened = handle;
      vi.spyOn(handle, 'read');
    };
    expect((await readBoundProjectFileSnapshot(root, ['small'], { ...options, maximumBytes: 32 * 1024 * 1024 })).content)
      .toEqual(raw);
    if (!opened) throw new Error('Expected a bounded open.');
    expect(vi.mocked(opened.read).mock.calls[0]?.[0]).toHaveLength(raw.length + 1);
  });

  it('rejects an oversized file before opening it', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'oversized'), raw);
    await expect(readBoundProjectFileSnapshot(root, ['oversized'], { ...options, maximumBytes: raw.length - 1 }))
      .rejects.toThrow('snapshot exceeds the bounded size limit: oversized');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
  });

  it('rejects a directory leaf and a nondirectory parent without opening either', async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, 'directory'));
    await writeFile(path.join(root, 'file'), raw);
    await expect(readBoundProjectFileSnapshot(root, ['directory'], options))
      .rejects.toThrow('not a regular file: directory');
    await expect(readBoundProjectFileSnapshot(root, ['file', 'child'], options))
      .rejects.toThrow('path parent is not a directory: file');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect(await readFile(path.join(root, 'file'))).toEqual(raw);
  });

  it('rejects real case and Unicode aliases instead of reading a matching spelling', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'Upper'), raw);
    await expect(readBoundProjectFileSnapshot(root, ['upper'], options)).rejects.toThrow('case or Unicode collision');
    const unicodeDirectory = path.join(root, 'unicode');
    await mkdir(unicodeDirectory);
    await writeFile(path.join(unicodeDirectory, 'caf\u00e9'), raw);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const [stored] = await actual.readdir(unicodeDirectory);
    const alias = stored.normalize('NFC') === stored ? stored.normalize('NFD') : stored.normalize('NFC');
    expect(alias).not.toBe(stored);
    await expect(readBoundProjectFileSnapshot(root, ['unicode', alias], options))
      .rejects.toThrow('case or Unicode collision');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
  });

  it('rejects ambiguous on-disk alias inventories before choosing an entry', async () => {
    const { root } = await fixture();
    io.names = { directory: root, entries: ['Name', 'name'] };
    await expect(readBoundProjectFileSnapshot(root, ['Name'], options)).rejects.toThrow('case or Unicode collision');
    expect(io.calls).toEqual([{ operation: 'readdir', target: root }]);
  });

  it('rejects a linked parent without reading or changing its outside destination', async () => {
    const { root, outside } = await fixture();
    await writeFile(path.join(outside, 'source'), raw);
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readBoundProjectFileSnapshot(root, ['linked', 'source'], options))
      .rejects.toThrow('symlink or junction at linked');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect(await readFile(path.join(outside, 'source'))).toEqual(raw);
  });

  it.runIf(process.platform !== 'win32')('rejects a leaf symlink without following it', async () => {
    const { root, outside } = await fixture();
    const source = path.join(outside, 'source');
    await writeFile(source, raw);
    await symlink(source, path.join(root, 'linked'));
    await expect(readBoundProjectFileSnapshot(root, ['linked'], options)).rejects.toThrow('symlink or junction at linked');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect(await readFile(source)).toEqual(raw);
  });
});

describe('link policies and changed reads', () => {
  it('rejects a pre-existing hard link only in the explicitly selected single-link policy', async () => {
    const { root, outside } = await fixture();
    const file = path.join(root, 'source');
    const alias = path.join(outside, 'alias');
    await writeFile(file, raw);
    await link(file, alias);
    await expect(readBoundProjectFileSnapshot(root, ['source'], options)).rejects.toThrow('hard-linked file is not permitted');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect((await readBoundProjectFileSnapshot(root, ['source'], { ...options, linkPolicy: 'transaction-compatible' })).content)
      .toEqual(raw);
    expect(await readFile(alias)).toEqual(raw);
  });

  it.each(['before-open', 'after-opened-stat'] as const)('rejects a new hard link at %s', async (phase) => {
    const { root, outside } = await fixture();
    const file = path.join(root, 'source');
    const alias = path.join(outside, 'alias');
    await writeFile(file, raw);
    if (phase === 'before-open') {
      io.beforeOpen = async () => { await link(file, alias); };
    } else {
      io.afterOpen = async (handle) => {
        const observed = await handle.stat();
        await link(file, alias);
        vi.spyOn(handle, 'stat').mockResolvedValueOnce(observed);
      };
    }
    await expect(readBoundProjectFileSnapshot(root, ['source'], options)).rejects.toThrow('file changed while reading');
    expect(await readFile(file)).toEqual(raw);
    expect(await readFile(alias)).toEqual(raw);
  });

  it.each(policies)('uses the original no-follow flags with the declared %s nonblocking policy', async (linkPolicy) => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'source'), raw);
    let observedFlags: string | number | undefined;
    io.afterOpen = async (_handle, _target, flags) => { observedFlags = flags; };
    await readBoundProjectFileSnapshot(root, ['source'], { ...options, linkPolicy });
    expect(observedFlags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
      (linkPolicy === 'single-link' ? constants.O_NONBLOCK ?? 0 : 0));
  });

  it.each(policies)('bounds growth after the opened size observation and closes the %s handle', async (linkPolicy) => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw);
    let opened: FileHandle | undefined;
    io.afterOpen = async (handle) => {
      opened = handle;
      const observed = await handle.stat();
      await appendFile(file, Buffer.alloc(4096, 'x'));
      vi.spyOn(handle, 'stat').mockResolvedValueOnce(observed);
      vi.spyOn(handle, 'read');
      vi.spyOn(handle, 'close');
    };
    await expect(readBoundProjectFileSnapshot(root, ['source'], { ...options, maximumBytes: raw.length, linkPolicy }))
      .rejects.toThrow('file changed while reading');
    if (!opened) throw new Error('Expected an opened file.');
    expect(vi.mocked(opened.read).mock.calls[0]?.[0]).toHaveLength(raw.length + 1);
    expect(opened.close).toHaveBeenCalledOnce();
    expect((await readFile(file)).subarray(0, raw.length)).toEqual(raw);
    expect((await lstat(file)).size).toBe(raw.length + 4096);
  });

  it('rejects a replacement leaf after open and preserves both original and concurrent bytes', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    const original = path.join(root, 'original');
    await writeFile(file, raw);
    io.afterOpen = async () => {
      await rename(file, original);
      await writeFile(file, 'concurrent replacement');
    };
    await expect(readBoundProjectFileSnapshot(root, ['source'], options)).rejects.toThrow('file changed while reading');
    expect(await readFile(original)).toEqual(raw);
    expect(await readFile(file, 'utf8')).toBe('concurrent replacement');
  });

  it.runIf(process.platform !== 'win32')('rejects a concurrent mode change without undoing it', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw, { mode: 0o600 });
    io.afterOpen = async (handle) => {
      const observed = await handle.stat();
      await chmod(file, 0o640);
      vi.spyOn(handle, 'stat').mockResolvedValueOnce(observed);
    };
    await expect(readBoundProjectFileSnapshot(root, ['source'], options)).rejects.toThrow('file changed while reading');
    expect((await lstat(file)).mode & 0o777).toBe(0o640);
    expect(await readFile(file)).toEqual(raw);
  });

  it('snapshots caller options and path parts before awaiting I/O', async () => {
    const { root, outside } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw);
    const parts = ['source'];
    const selected: BoundFileReadOptions = { ...options };
    io.beforeOpen = async () => {
      parts[0] = 'unreviewed';
      Object.assign(selected, { linkPolicy: 'transaction-compatible' });
      await link(file, path.join(outside, 'alias'));
    };
    await expect(readBoundProjectFileSnapshot(root, parts, selected)).rejects.toThrow('file changed while reading: source');
    expect(io.calls.some((call) => call.target.includes('unreviewed'))).toBe(false);
  });
});

describe('caller structural rejections are not filesystem absence', () => {
  function rejection() {
    const error = Object.assign(new Error('Caller rejected this structural path'), { code: 'ENOENT' });
    const invalid = vi.fn((_detail: string): never => { throw error; });
    return { error, diagnostics: { pathLabel: 'Fixture path', invalid } };
  }

  it('preserves an ENOENT-tagged rejection when asserting a linked parent', async () => {
    const { root, outside } = await fixture();
    const source = path.join(outside, 'source');
    await writeFile(source, raw, { mode: 0o640 });
    const mode = (await lstat(source)).mode & 0o7777;
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const rejected = rejection();

    await expect(assertBoundProjectPath(root, ['linked', 'source'], rejected.diagnostics))
      .rejects.toBe(rejected.error);
    expect(rejected.diagnostics.invalid).toHaveBeenCalledExactlyOnceWith('symlink or junction at linked.');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect(await readFile(source)).toEqual(raw);
    expect((await lstat(source)).mode & 0o7777).toBe(mode);
  });

  describe.each(policies)('%s reads', (linkPolicy) => {
    it.each(['linked-parent', 'directory-leaf', 'oversized-leaf'] as const)(
      'preserves an ENOENT-tagged %s rejection before any open',
      async (kind) => {
        const { root, outside } = await fixture();
        const source = path.join(outside, 'source');
        await writeFile(source, raw, { mode: 0o640 });
        const mode = (await lstat(source)).mode & 0o7777;
        let parts: string[];
        let detail: string;
        if (kind === 'linked-parent') {
          await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
          parts = ['linked', 'source'];
          detail = 'symlink or junction at linked.';
        } else if (kind === 'directory-leaf') {
          await mkdir(path.join(root, 'directory'));
          parts = ['directory'];
          detail = 'not a regular file: directory.';
        } else {
          await writeFile(path.join(root, 'oversized'), raw);
          parts = ['oversized'];
          detail = 'snapshot exceeds the bounded size limit: oversized.';
        }
        const rejected = rejection();

        await expect(readBoundProjectFileSnapshot(root, parts, {
          ...options, maximumBytes: kind === 'oversized-leaf' ? raw.length - 1 : options.maximumBytes,
          linkPolicy, diagnostics: rejected.diagnostics
        })).rejects.toBe(rejected.error);
        expect(rejected.diagnostics.invalid).toHaveBeenCalledExactlyOnceWith(detail);
        expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
        expect(await readFile(source)).toEqual(raw);
        expect((await lstat(source)).mode & 0o7777).toBe(mode);
        if (kind === 'directory-leaf') expect((await lstat(path.join(root, 'directory'))).isDirectory()).toBe(true);
        if (kind === 'oversized-leaf') expect(await readFile(path.join(root, 'oversized'))).toEqual(raw);
      }
    );
  });

  it('preserves an ENOENT-tagged single-link rejection without opening the hard-linked file', async () => {
    const { root, outside } = await fixture();
    const source = path.join(outside, 'source');
    const alias = path.join(root, 'alias');
    await writeFile(source, raw, { mode: 0o640 });
    await link(source, alias);
    const mode = (await lstat(source)).mode & 0o7777;
    const rejected = rejection();

    await expect(readBoundProjectFileSnapshot(root, ['alias'], { ...options, diagnostics: rejected.diagnostics }))
      .rejects.toBe(rejected.error);
    expect(rejected.diagnostics.invalid).toHaveBeenCalledExactlyOnceWith('hard-linked file is not permitted: alias.');
    expect(io.calls.some((call) => call.operation === 'open')).toBe(false);
    expect(await readFile(source)).toEqual(raw);
    expect(await readFile(alias)).toEqual(raw);
    expect((await lstat(source)).mode & 0o7777).toBe(mode);
    expect((await lstat(alias)).nlink).toBe(2);
  });
});

describe('separate streamed single-link file digests', () => {
  it('streams a file above 32 MiB with bounded reads without changing the buffered snapshot limit', async () => {
    const { root } = await fixture(), bytes = Buffer.alloc(33 * 1024 * 1024, 'a');
    await writeFile(path.join(root, 'large-provider'), bytes);
    let opened: FileHandle | undefined;
    io.afterOpen = async handle => { opened = handle; vi.spyOn(handle, 'read'); vi.spyOn(handle, 'close'); };
    const result = await readBoundProjectFileDigest(root, ['large-provider'], { ...digestOptions, maximumBytes: bytes.length });
    expect(result).toMatchObject({
      pathParts: ['large-provider'], bytes: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'), header: bytes.subarray(0, 8).toString('hex')
    });
    expect(result.physical).toMatch(/^\d+(?::\d+){9}$/u);
    if (!opened) throw new Error('Expected a streamed file handle.');
    for (const [buffer] of vi.mocked(opened.read).mock.calls) {
      expect(Buffer.isBuffer(buffer)).toBe(true);
      if (Buffer.isBuffer(buffer)) expect(buffer.length).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(vi.mocked(opened.read).mock.calls).toHaveLength(34);
    expect(opened.close).toHaveBeenCalledOnce();
    await expect(readBoundProjectFileSnapshot(root, ['large-provider'], { ...options, maximumBytes: bytes.length }))
      .rejects.toThrow(/33554432/);
  });

  it.each([0, -1, 1.5, 512 * 1024 * 1024 + 1])('rejects invalid digest bound %s before filesystem access', async maximumBytes => {
    await expect(readBoundProjectFileDigest(path.resolve('never-read-digest-root'), ['file'], { ...digestOptions, maximumBytes }))
      .rejects.toThrow(/536870912/);
    expect(io.calls).toEqual([]);
  });

  it('rejects expanded options and a weaker link policy before filesystem access', async () => {
    for (const value of [{ ...digestOptions, extra: true }, { ...digestOptions, linkPolicy: 'transaction-compatible' }]) {
      await expect(Reflect.apply(readBoundProjectFileDigest, undefined, [path.resolve('never-read-digest-root'), ['file'], value]))
        .rejects.toBeInstanceOf(FileSystemError);
    }
    expect(io.calls).toEqual([]);
  });

  it('distinguishes an empty file from missing and refuses an oversized or hard-linked file before opening', async () => {
    const { root, outside } = await fixture();
    await writeFile(path.join(root, 'empty'), '');
    expect(await readBoundProjectFileDigest(root, ['empty'], digestOptions)).toMatchObject({
      bytes: 0, header: '', digest: createHash('sha256').digest('hex')
    });
    await expect(readBoundProjectFileDigest(root, ['missing'], digestOptions)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(root, 'source'), raw);
    const opened = io.calls.filter(call => call.operation === 'open').length;
    await expect(readBoundProjectFileDigest(root, ['source'], { ...digestOptions, maximumBytes: raw.length - 1 }))
      .rejects.toThrow(/bounded regular single-link/);
    await link(path.join(root, 'source'), path.join(outside, 'alias'));
    await expect(readBoundProjectFileDigest(root, ['source'], digestOptions)).rejects.toThrow(/single-link/);
    expect(io.calls.filter(call => call.operation === 'open')).toHaveLength(opened);
    expect(await readFile(path.join(outside, 'alias'))).toEqual(raw);
  });

  it('rejects an identity change before streamed reading and closes its opened handle', async () => {
    const { root } = await fixture(), target = path.join(root, 'source');
    await writeFile(target, raw);
    let opened: FileHandle | undefined;
    io.afterOpen = async handle => {
      opened = handle; vi.spyOn(handle, 'close');
      await appendFile(target, 'changed');
    };
    await expect(readBoundProjectFileDigest(root, ['source'], digestOptions)).rejects.toThrow(/before streamed/);
    expect(opened?.close).toHaveBeenCalledOnce();
    expect(await readFile(target)).toEqual(Buffer.concat([raw, Buffer.from('changed')]));
  });

  it.each(['truncate', 'grow'] as const)('detects %s after the opened identity observation and preserves the concurrent effect', async operation => {
    const { root } = await fixture(), target = path.join(root, 'source');
    await writeFile(target, raw);
    let opened: FileHandle | undefined;
    io.afterOpen = async handle => {
      opened = handle;
      const before = await handle.stat({ bigint: true });
      if (operation === 'truncate') await writeFile(target, raw.subarray(0, 4));
      else await appendFile(target, 'x');
      vi.spyOn(handle, 'stat').mockResolvedValueOnce(before);
      vi.spyOn(handle, 'close');
    };
    await expect(readBoundProjectFileDigest(root, ['source'], digestOptions))
      .rejects.toThrow(operation === 'truncate' ? /truncated/ : /bytes or identity changed/);
    expect(opened?.close).toHaveBeenCalledOnce();
    expect(await readFile(target)).toEqual(operation === 'truncate' ? raw.subarray(0, 4) : Buffer.concat([raw, Buffer.from('x')]));
  });

  it('refuses a changed parent even when leaf bytes and identity stay unchanged', async () => {
    const { root } = await fixture(), target = path.join(root, 'source');
    await writeFile(target, raw);
    io.afterOpen = async () => { await mkdir(path.join(root, 'concurrent-directory')); };
    await expect(readBoundProjectFileDigest(root, ['source'], digestOptions)).rejects.toThrow(/ancestor changed/);
    expect(await readFile(target)).toEqual(raw);
    expect((await lstat(path.join(root, 'concurrent-directory'))).isDirectory()).toBe(true);
  });
});

describe('missing versus unavailable observations', () => {
  it.each(['readdir', 'lstat', 'open'] as const)('propagates a denied %s without treating it as missing', async (operation) => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw);
    const target = operation === 'readdir' ? root : file;
    const error = Object.assign(new Error('injected native read denial'), { code: operation === 'open' ? 'EPERM' : 'EACCES', path: target });
    io.failure = { operation, target, error };
    await expect(readBoundProjectFileSnapshot(root, ['source'], options)).rejects.toBe(error);
    expect(await readFile(file)).toEqual(raw);
  });

  it('treats confirmed disappearance before open as absent, not as an acquired file', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw);
    io.beforeOpen = async () => { await unlink(file); };
    expect(await readBoundProjectFileSnapshot(root, ['source'], options)).toEqual({ pathParts: ['source'] });
  });

  it('propagates disappearance after an opened handle rather than returning missing', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'source');
    await writeFile(file, raw);
    let opened: FileHandle | undefined;
    io.afterOpen = async (handle) => {
      opened = handle;
      vi.spyOn(handle, 'close');
      await unlink(file);
    };
    await expect(readBoundProjectFileSnapshot(root, ['source'], { ...options, linkPolicy: 'transaction-compatible' }))
      .rejects.toMatchObject({ code: 'ENOENT', path: file });
    expect(opened?.close).toHaveBeenCalledOnce();
  });

  it('preserves caller path labels and exact structural failure formatting', async () => {
    const { root } = await fixture();
    const transactionDiagnostics: BoundPathDiagnostics = {
      pathLabel: 'Reviewed update path',
      invalid(detail) { throw new FileSystemError(`Reviewed update transaction: ${detail}`); }
    };
    await expect(assertBoundProjectPath(root, ['..'], transactionDiagnostics))
      .rejects.toThrow('Reviewed update path contains unsafe path part "..".');
    await mkdir(path.join(root, 'directory'));
    await expect(readBoundProjectFileSnapshot(root, ['directory'], { ...options, diagnostics: transactionDiagnostics }))
      .rejects.toThrow('Reviewed update transaction: not a regular file: directory.');
  });
});
