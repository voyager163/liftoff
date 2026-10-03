import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PackagedAssetReadBoundsError,
  PackagedAssetReadError,
  readDeclaredAssetBytes,
  type BoundedReadFs,
  type DeclaredPackagedAsset,
  type PackagedAssetReadBounds
} from '../src/adapters/packaged-assets/plugin-assets.js';
import { installedPackageRoot } from '../src/adapters/packaged-assets/package-root.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { CaptureStream } from './helpers.js';

// Pass-through observation of every path the process opens or reads, including the eager compat
// loader, so read counts cover the whole CLI import graph. Behavior is unchanged.
const observed = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = (file: unknown) => observed.paths.push(file instanceof URL ? decodeURIComponent(file.pathname) : String(file));
  const openSync = ((file: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
    record(file);
    return (actual.openSync as (...args: unknown[]) => number)(file, ...rest);
  }) as typeof actual.openSync;
  const readFileSync = ((file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    record(file);
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  const wrapped = { ...actual, openSync, readFileSync };
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const record = (file: unknown) => observed.paths.push(file instanceof URL ? decodeURIComponent(file.pathname) : String(file));
  const readFile = ((file: unknown, ...rest: unknown[]) => {
    record(file);
    return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFile;
  const open = ((file: unknown, ...rest: unknown[]) => {
    record(file);
    return (actual.open as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.open;
  const wrapped = { ...actual, readFile, open };
  return { ...wrapped, default: wrapped };
});

const bounds: PackagedAssetReadBounds = { maxAssetBytes: 64, maxTotalAssetBytes: 128, maxPathParts: 8, maxPartLength: 32 };
const owner = { kind: 'plugin', category: 'stack', id: 'fixture-stack' } as const;
const asset = (pathParts: readonly string[], id = 'fixture-asset'): DeclaredPackagedAsset => ({ owner, id, pathParts });

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liftoff-plugin-assets-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function readFailure(action: () => unknown): PackagedAssetReadError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PackagedAssetReadError);
    return error as PackagedAssetReadError;
  }
  throw new Error('expected a packaged asset read failure');
}

/** Delegates to the real file system and records every operation. */
function recordingFs(overrides: Partial<BoundedReadFs> = {}) {
  const calls: string[] = [];
  const fs: BoundedReadFs = {
    openSync: (file, flags) => {
      calls.push(`open ${path.basename(file)}`);
      return overrides.openSync ? overrides.openSync(file, flags) : nodeFs.openSync(file, flags);
    },
    fstatSync: (fd) => {
      calls.push('fstat');
      return overrides.fstatSync ? overrides.fstatSync(fd) : nodeFs.fstatSync(fd);
    },
    readSync: (fd, buffer, offset, length, position) => {
      calls.push(`read ${length}@${position}`);
      return overrides.readSync ? overrides.readSync(fd, buffer, offset, length, position) : nodeFs.readSync(fd, buffer, offset, length, position);
    },
    closeSync: (fd) => {
      calls.push('close');
      if (overrides.closeSync) {
        try {
          overrides.closeSync(fd);
        } finally {
          nodeFs.closeSync(fd);
        }
      } else {
        nodeFs.closeSync(fd);
      }
    }
  };
  return { fs, calls };
}

const nodeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const systemError = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe('bounded packaged asset reader', () => {
  it('reads every declared asset in order with its exact bytes', () => {
    const root = temporaryRoot({ 'assets/a/one.txt': 'one\n', 'assets/b/two.txt': 'two\n' });
    const result = readDeclaredAssetBytes([asset(['assets', 'a', 'one.txt']), asset(['assets', 'b', 'two.txt'], 'second')], bounds, { packageRoot: root });
    expect(result.map((entry) => [entry.pathParts.join('/'), Buffer.from(entry.bytes).toString('utf8')])).toEqual([
      ['assets/a/one.txt', 'one\n'], ['assets/b/two.txt', 'two\n']
    ]);
  });

  it('validates every location before any file is opened', () => {
    const root = temporaryRoot({ 'assets/a/one.txt': 'one\n' });
    const invalid: unknown[] = [
      ['assets'],
      ['other', 'one.txt'],
      ['assets', '..', 'one.txt'],
      ['assets', 'a/b'],
      ['assets', 'a\\b'],
      ['assets', 'Read Me.txt'],
      ['assets', 'x'.repeat(33)],
      ['assets', ...Array(8).fill('a')],
      ['assets', 'CON'],
      ['assets', 'trailing.'],
      ['assets', ''],
      'assets/a/one.txt'
    ];
    for (const pathParts of invalid) {
      const { fs, calls } = recordingFs();
      const failure = readFailure(() => readDeclaredAssetBytes(
        [asset(['assets', 'a', 'one.txt']), asset(pathParts as string[], 'bad')], bounds, { packageRoot: root, fs }));
      expect([failure.reason, failure.id, failure.owner], JSON.stringify(pathParts)).toEqual(['invalid-path', 'bad', owner]);
      expect(calls, JSON.stringify(pathParts)).toEqual([]);
    }
  });

  it('reports a missing file as missing and other open failures as open failures', () => {
    const root = temporaryRoot();
    const missing = readFailure(() => readDeclaredAssetBytes([asset(['assets', 'a', 'absent.txt'])], bounds, { packageRoot: root }));
    expect([missing.reason, missing.code, missing.portablePath]).toEqual(['missing', 'ENOENT', 'assets/a/absent.txt']);
    expect(missing.message).toBe('Packaged asset stack:fixture-stack/fixture-asset at "assets/a/absent.txt" could not be used: the file does not exist (ENOENT).');
    expect(missing.message).not.toContain(root);
    const { fs, calls } = recordingFs({ openSync: () => { throw systemError('EACCES'); } });
    const denied = readFailure(() => readDeclaredAssetBytes([asset(['assets', 'a', 'absent.txt'])], bounds, { packageRoot: root, fs }));
    expect([denied.reason, denied.code]).toEqual(['open-failed', 'EACCES']);
    expect(calls).toEqual(['open absent.txt']);
  });

  it('rejects a directory as not a regular file and closes it', (context) => {
    if (process.platform === 'win32') context.skip('Windows opens directories differently; native Windows is not qualified here');
    const root = temporaryRoot({ 'assets/a/dir/inner.txt': 'x\n' });
    const { fs, calls } = recordingFs();
    const failure = readFailure(() => readDeclaredAssetBytes([asset(['assets', 'a', 'dir'])], bounds, { packageRoot: root, fs }));
    expect(failure.reason).toBe('not-regular-file');
    expect(calls).toEqual(['open dir', 'fstat', 'close']);
  });

  it('never blocks opening a FIFO: an independent process would release a blocked open after a deadline', async (context) => {
    if (process.platform === 'win32') context.skip('POSIX FIFOs are unavailable on Windows; native Windows is not qualified here');
    const root = temporaryRoot();
    const fifo = path.join(root, 'assets', 'pipe', 'lock.json');
    mkdirSync(path.dirname(fifo), { recursive: true });
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    // Skip only when the tool itself is unavailable; any other mkfifo failure is unexpected and fails.
    if ((made.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') context.skip('mkfifo is not installed on this host');
    expect(made.error).toBeUndefined();
    expect([made.status, made.signal], made.stderr).toEqual([0, null]);
    // An in-process timer cannot interrupt a blocked open(2). This separate process opens the writer
    // end only after the delay, so a blocking reader fails on elapsed time instead of hanging.
    const release = [
      "const fs = require('node:fs');",
      'const [fifo, delay, deadline] = process.argv.slice(1).map((value, index) => index === 0 ? value : Number(value));',
      'const started = Date.now();',
      'const attempt = () => {',
      '  if (Date.now() - started > deadline) process.exit(0);',
      '  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); process.exit(0); }',
      '  catch { setTimeout(attempt, 25); }',
      '};',
      'setTimeout(attempt, delay);'
    ].join('\n');
    const releaser = spawn(process.execPath, ['-e', release, fifo, '1500', '20000'], { stdio: 'ignore' });
    // Settlement is observed from spawn onward, so the root is never removed under a live releaser.
    const settled = new Promise<void>((resolve, reject) => {
      releaser.once('error', reject);
      releaser.once('close', () => resolve());
    });
    try {
      const started = performance.now();
      const failure = readFailure(() => readDeclaredAssetBytes([asset(['assets', 'pipe', 'lock.json'])], bounds, { packageRoot: root }));
      const elapsed = performance.now() - started;
      expect(failure.reason).toBe('not-regular-file');
      expect(elapsed).toBeLessThan(1000);
    } finally {
      releaser.kill();
      await settled;
    }
  });

  it('checks the per-asset and aggregate bounds before allocating or reading', () => {
    const root = temporaryRoot({
      'assets/a/big.txt': 'x'.repeat(65),
      'assets/a/first.txt': 'y'.repeat(64),
      'assets/a/second.txt': 'z'.repeat(64)
    });
    const large = recordingFs();
    const tooLarge = readFailure(() => readDeclaredAssetBytes([asset(['assets', 'a', 'big.txt'])], bounds, { packageRoot: root, fs: large.fs }));
    expect(tooLarge.reason).toBe('too-large');
    expect(large.calls).toEqual(['open big.txt', 'fstat', 'close']);
    const aggregate = recordingFs();
    const tooMuch = readFailure(() => readDeclaredAssetBytes(
      [asset(['assets', 'a', 'first.txt']), asset(['assets', 'a', 'second.txt'], 'second')],
      { ...bounds, maxTotalAssetBytes: 127 },
      { packageRoot: root, fs: aggregate.fs }));
    expect([tooMuch.reason, tooMuch.id]).toEqual(['aggregate-too-large', 'second']);
    expect(aggregate.calls).toEqual(['open first.txt', 'fstat', 'read 64@0', 'read 1@64', 'close', 'open second.txt', 'fstat', 'close']);
  });

  it('rejects short reads and reports read and stat failures with their system codes', () => {
    const root = temporaryRoot({ 'assets/a/file.txt': '0123456789' });
    const declared = [asset(['assets', 'a', 'file.txt'])];
    let served = false;
    const short = recordingFs({
      readSync: (fd, buffer, offset, length, position) => {
        if (served) return 0;
        served = true;
        return nodeFs.readSync(fd, buffer, offset, Math.min(length, 4), position);
      }
    });
    expect(readFailure(() => readDeclaredAssetBytes(declared, bounds, { packageRoot: root, fs: short.fs })).reason).toBe('short-read');
    expect(short.calls).toEqual(['open file.txt', 'fstat', 'read 10@0', 'read 6@4', 'close']);
    const read = recordingFs({ readSync: () => { throw systemError('EIO'); } });
    const readError = readFailure(() => readDeclaredAssetBytes(declared, bounds, { packageRoot: root, fs: read.fs }));
    expect([readError.reason, readError.code, readError.closeCode]).toEqual(['read-failed', 'EIO', undefined]);
    expect(read.calls).toEqual(['open file.txt', 'fstat', 'read 10@0', 'close']);
    const stat = recordingFs({ fstatSync: () => { throw systemError('EOVERFLOW'); } });
    const statError = readFailure(() => readDeclaredAssetBytes(declared, bounds, { packageRoot: root, fs: stat.fs }));
    expect([statError.reason, statError.code]).toEqual(['stat-failed', 'EOVERFLOW']);
    expect(stat.calls).toEqual(['open file.txt', 'fstat', 'close']);
  });

  it('refuses a close failure after a successful read and never lets it mask a primary failure', () => {
    const root = temporaryRoot({ 'assets/a/file.txt': 'content\n' });
    const declared = [asset(['assets', 'a', 'file.txt'])];
    const closing = recordingFs({ closeSync: () => { throw systemError('EBADF'); } });
    const closeError = readFailure(() => readDeclaredAssetBytes(declared, bounds, { packageRoot: root, fs: closing.fs }));
    expect([closeError.reason, closeError.code]).toEqual(['close-failed', 'EBADF']);
    const both = recordingFs({ readSync: () => { throw systemError('EIO'); }, closeSync: () => { throw systemError('EBADF'); } });
    const primary = readFailure(() => readDeclaredAssetBytes(declared, bounds, { packageRoot: root, fs: both.fs }));
    expect([primary.reason, primary.code, primary.closeCode]).toEqual(['read-failed', 'EIO', 'EBADF']);
    expect(primary.message).toBe('Packaged asset stack:fixture-stack/fixture-asset at "assets/a/file.txt" could not be used: the file could not be read (EIO); closing it also failed (EBADF).');
  });

  it('follows package-manager symlinks: containment is lexical, not realpath confinement', (context) => {
    const outside = temporaryRoot({ 'store/lock.json': '{}\n' });
    const root = temporaryRoot();
    mkdirSync(path.join(root, 'assets', 'a'), { recursive: true });
    try {
      symlinkSync(path.join(outside, 'store', 'lock.json'), path.join(root, 'assets', 'a', 'lock.json'));
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('creating symlinks requires elevation or developer mode on this Windows host');
      }
      throw error;
    }
    const [entry] = readDeclaredAssetBytes([asset(['assets', 'a', 'lock.json'])], bounds, { packageRoot: root });
    expect(Buffer.from(entry.bytes).toString('utf8')).toBe('{}\n');
  });
});

/** An in-memory descriptor whose fstat size may lag the bytes a read can already observe. */
function memoryFs(content: string, reportedSize: number, options: { probeError?: string; closeError?: string; growOnClose?: string } = {}) {
  const calls: string[] = [];
  let available = Buffer.from(content, 'utf8');
  const fs: BoundedReadFs = {
    openSync: () => {
      calls.push('open');
      return 42;
    },
    fstatSync: () => {
      calls.push(`fstat:${reportedSize}`);
      return { isFile: () => true, size: reportedSize };
    },
    readSync: (_fd, buffer, offset, length, position) => {
      calls.push(`read ${length}@${position}`);
      if (options.probeError !== undefined && position === reportedSize) throw systemError(options.probeError);
      const chunk = available.subarray(position, position + length);
      buffer.set(chunk, offset);
      return chunk.length;
    },
    closeSync: () => {
      calls.push('close');
      if (options.growOnClose !== undefined) available = Buffer.concat([available, Buffer.from(options.growOnClose, 'utf8')]);
      if (options.closeError !== undefined) throw systemError(options.closeError);
    }
  };
  return { fs, calls, available: () => available.toString('utf8') };
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

describe('one-byte observed-growth probe', () => {
  const probeBounds: PackagedAssetReadBounds = { maxAssetBytes: 8, maxTotalAssetBytes: 8, maxPathParts: 4, maxPartLength: 32 };
  const fixture = asset(['assets', 'fixture.txt'], 'fixture');
  const readMemory = (fs: BoundedReadFs) => readDeclaredAssetBytes([fixture], probeBounds, { packageRoot: temporaryRoot(), fs });

  it('accepts a stable end of file after a nonzero or a zero reported size', () => {
    const filled = memoryFs('abc', 3);
    expect(text(readMemory(filled.fs)[0].bytes)).toBe('abc');
    expect(filled.calls).toEqual(['open', 'fstat:3', 'read 3@0', 'read 1@3', 'close']);
    const empty = memoryFs('', 0);
    expect(readMemory(empty.fs)[0].bytes).toHaveLength(0);
    expect(empty.calls).toEqual(['open', 'fstat:0', 'read 1@0', 'close']);
  });

  it('probes real files at their reported size, including an empty file', () => {
    const root = temporaryRoot({ 'assets/a/abc.txt': 'abc', 'assets/a/empty.txt': '' });
    const { fs, calls } = recordingFs();
    const [abc, empty] = readDeclaredAssetBytes(
      [asset(['assets', 'a', 'abc.txt']), asset(['assets', 'a', 'empty.txt'], 'empty')], bounds, { packageRoot: root, fs });
    expect([text(abc.bytes), empty.bytes.length]).toEqual(['abc', 0]);
    expect(calls).toEqual(['open abc.txt', 'fstat', 'read 3@0', 'read 1@3', 'close', 'open empty.txt', 'fstat', 'read 1@0', 'close']);
  });

  it('refuses a byte already observable past a nonzero or a zero reported size', () => {
    // The reviewed reproduction: fstat reports 3 bytes while abcd is readable.
    const grown = memoryFs('abcd', 3);
    const failure = readFailure(() => readMemory(grown.fs));
    expect([failure.reason, failure.code, failure.closeCode]).toEqual(['grew', undefined, undefined]);
    expect(failure.message).toBe('Packaged asset stack:fixture-stack/fixture at "assets/fixture.txt" could not be used: more bytes were observed than the file reported.');
    expect(grown.calls).toEqual(['open', 'fstat:3', 'read 3@0', 'read 1@3', 'close']);
    const fromEmpty = memoryFs('d', 0);
    expect(readFailure(() => readMemory(fromEmpty.fs)).reason).toBe('grew');
    expect(fromEmpty.calls).toEqual(['open', 'fstat:0', 'read 1@0', 'close']);
  });

  it('reports a failing probe as a read failure, always closes, and keeps the primary failure primary', () => {
    const probeFails = memoryFs('abc', 3, { probeError: 'EIO' });
    const failure = readFailure(() => readMemory(probeFails.fs));
    expect([failure.reason, failure.code, failure.closeCode]).toEqual(['read-failed', 'EIO', undefined]);
    expect(probeFails.calls).toEqual(['open', 'fstat:3', 'read 3@0', 'read 1@3', 'close']);
    const bothFail = memoryFs('abc', 3, { probeError: 'EIO', closeError: 'EBADF' });
    const primary = readFailure(() => readMemory(bothFail.fs));
    expect([primary.reason, primary.code, primary.closeCode]).toEqual(['read-failed', 'EIO', 'EBADF']);
    expect(bothFail.calls).toEqual(['open', 'fstat:3', 'read 3@0', 'read 1@3', 'close']);
    const grewThenCloseFails = memoryFs('abcd', 3, { closeError: 'EBADF' });
    const grew = readFailure(() => readMemory(grewThenCloseFails.fs));
    expect([grew.reason, grew.code, grew.closeCode]).toEqual(['grew', undefined, 'EBADF']);
    expect(grew.message).toBe('Packaged asset stack:fixture-stack/fixture at "assets/fixture.txt" could not be used: more bytes were observed than the file reported; closing it also failed (EBADF).');
    const stableThenCloseFails = memoryFs('abc', 3, { closeError: 'EBADF' });
    expect(readFailure(() => readMemory(stableThenCloseFails.fs)).reason).toBe('close-failed');
  });

  it('claims no coherent snapshot: bytes that appear only after the probe are not observed', () => {
    // Growth after the probe (here, while closing) is outside the observation; the reported-size bytes
    // are returned, and registry intake still checks declared bytes against the release digests.
    const later = memoryFs('abc', 3, { growOnClose: 'z' });
    expect(text(readMemory(later.fs)[0].bytes)).toBe('abc');
    expect(later.available()).toBe('abcz');
    expect(later.calls).toEqual(['open', 'fstat:3', 'read 3@0', 'read 1@3', 'close']);
  });
});

describe('reader bounds', () => {
  const valid: PackagedAssetReadBounds = { maxAssetBytes: 64, maxTotalAssetBytes: 128, maxPathParts: 8, maxPartLength: 32 };
  const names = Object.keys(valid) as (keyof PackagedAssetReadBounds)[];

  function boundsFailure(action: () => unknown): PackagedAssetReadBoundsError {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedAssetReadBoundsError);
      return error as PackagedAssetReadBoundsError;
    }
    throw new Error('expected a packaged asset read bounds failure');
  }

  it('refuses malformed bounds before any location check, I/O or allocation, even without declarations', () => {
    const root = temporaryRoot({ 'assets/a/one.txt': 'one\n' });
    let accessorInvoked = false;
    const without = (name: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== name));
    const invalidValues: [string, unknown][] = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['explicit undefined', undefined],
      ['zero', 0],
      ['negative', -1],
      ['fraction', 1.5],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['numeric string', '64'],
      ['bigint', 64n],
      ['boolean', true],
      ['null', null]
    ];
    const cases: [string, unknown, string, string | undefined][] = [];
    for (const name of names) {
      for (const [label, value] of invalidValues) cases.push([`${name} ${label}`, { ...valid, [name]: value }, 'invalid-bound', name]);
      cases.push([`${name} missing`, without(name), 'missing-bound', name]);
      cases.push([`${name} accessor`, Object.defineProperty(without(name), name, {
        enumerable: true,
        get: () => {
          accessorInvoked = true;
          return 64;
        }
      }), 'invalid-bound', name]);
      cases.push([`${name} non-enumerable`, Object.defineProperty(without(name), name, { enumerable: false, value: 64 }), 'invalid-bound', name]);
    }
    cases.push(['unknown bound', { ...valid, maxFiles: 1 }, 'unknown-bound', 'maxFiles']);
    cases.push(['symbol-keyed bound', { ...valid, [Symbol('extra')]: 1 }, 'unknown-bound', 'Symbol(extra)']);
    for (const value of [undefined, null, 64, 'bounds', [64, 128, 8, 32]]) {
      cases.push([`bounds ${JSON.stringify(value) ?? 'undefined'}`, value, 'not-an-object', undefined]);
    }
    for (const [label, candidate, reason, bound] of cases) {
      for (const declarations of [[], [asset(['assets', 'a', 'one.txt'])]]) {
        const { fs, calls } = recordingFs();
        const failure = boundsFailure(() =>
          readDeclaredAssetBytes(declarations, candidate as PackagedAssetReadBounds, { packageRoot: root, fs }));
        expect([failure.reason, failure.bound], label).toEqual([reason, bound]);
        expect(calls, label).toEqual([]);
      }
    }
    expect(accessorInvoked).toBe(false);
    expect(boundsFailure(() => readDeclaredAssetBytes([], { ...valid, maxAssetBytes: Number.NaN })).message)
      .toBe('Packaged asset read bound "maxAssetBytes" must be an own enumerable data property holding a positive safe integer.');
    expect(boundsFailure(() => readDeclaredAssetBytes([], null as unknown as PackagedAssetReadBounds)).message)
      .toBe('Packaged asset read bounds must be an object holding maxAssetBytes, maxTotalAssetBytes, maxPathParts, maxPartLength.');
  });

  it('refuses the reviewed NaN reproduction before opening, inspecting or reading anything', () => {
    // NaN per-file and total bounds over a fake 16-byte file previously read and allocated 16 bytes.
    const calls: string[] = [];
    const fake: BoundedReadFs = {
      openSync: () => {
        calls.push('open');
        return 43;
      },
      fstatSync: () => {
        calls.push('fstat');
        return { isFile: () => true, size: 16 };
      },
      readSync: (_fd, buffer, _offset, length) => {
        calls.push(`read ${length}`);
        buffer.fill(97);
        return length;
      },
      closeSync: () => {
        calls.push('close');
      }
    };
    const failure = boundsFailure(() => readDeclaredAssetBytes([asset(['assets', 'fixture.txt'])],
      { ...valid, maxAssetBytes: Number.NaN, maxTotalAssetBytes: Number.NaN }, { packageRoot: temporaryRoot(), fs: fake }));
    expect([failure.reason, failure.bound]).toEqual(['invalid-bound', 'maxAssetBytes']);
    expect(calls).toEqual([]);
  });

  it('accepts exact positive safe integer bounds: the reader checks their shape and callers own the ceilings', () => {
    const root = temporaryRoot({ 'assets/a/abc.txt': 'abc' });
    const declared = [asset(['assets', 'a', 'abc.txt'])];
    const tight: PackagedAssetReadBounds = { maxAssetBytes: 3, maxTotalAssetBytes: 3, maxPathParts: 3, maxPartLength: 7 };
    expect(text(readDeclaredAssetBytes(declared, tight, { packageRoot: root })[0].bytes)).toBe('abc');
    expect(readFailure(() => readDeclaredAssetBytes(declared, { ...tight, maxAssetBytes: 2 }, { packageRoot: root })).reason).toBe('too-large');
    expect(readFailure(() => readDeclaredAssetBytes(declared, { ...tight, maxTotalAssetBytes: 2 }, { packageRoot: root })).reason)
      .toBe('aggregate-too-large');
    expect(readFailure(() => readDeclaredAssetBytes(declared, { ...tight, maxPathParts: 2 }, { packageRoot: root })).reason).toBe('invalid-path');
    expect(readFailure(() => readDeclaredAssetBytes(declared, { ...tight, maxPartLength: 6 }, { packageRoot: root })).reason).toBe('invalid-path');
    const widest = Number.MAX_SAFE_INTEGER;
    // Buffers are sized by the observed file, never by the bound.
    expect(text(readDeclaredAssetBytes(declared,
      { maxAssetBytes: widest, maxTotalAssetBytes: widest, maxPathParts: widest, maxPartLength: widest }, { packageRoot: root })[0].bytes))
      .toBe('abc');
  });
});

describe('lazy built-in template assets (N4)', () => {
  const assetPaths = new Set(builtinAssets.map((declared) => path.join(installedPackageRoot, ...declared.pathParts)));
  const assetReads = () => observed.paths.filter((file) => assetPaths.has(path.resolve(file)));
  const quietTelemetry = { beforeCommand: async () => false, afterCommand: async () => undefined };

  it('reads none of the 13 template assets for startup, help or version, all 13 on first render and none after', async () => {
    vi.resetModules();
    observed.paths.length = 0;
    const { runCli } = await import('../src/cli.js');
    expect(assetReads()).toEqual([]);
    for (const argv of [['help'], ['--help'], ['--version']]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCli({ argv, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' }, telemetry: quietTelemetry }), argv.join(' ')).toBe(0);
    }
    expect(assetReads()).toEqual([]);
    const { buildProjectPlan } = await import('../src/planner.js');
    const { buildArtifacts } = await import('../src/templates.js');
    const plan = (options: Record<string, unknown>) => buildProjectPlan({ projectName: 'Lazy Assets', cloud: 'azure', region: 'eastus', ...options }, { requireProjectName: true });
    buildArtifacts(plan({ projectType: 'standard', apiStack: 'node', includeFrontend: true }));
    expect(assetReads().length).toBe(13);
    expect(new Set(assetReads().map((file) => path.resolve(file)))).toEqual(assetPaths);
    buildArtifacts(plan({ pattern: 'rag', specWorkflow: 'spec-kit' }));
    buildArtifacts(plan({ projectType: 'standard', apiStack: 'go' }));
    expect(assetReads().length).toBe(13);
  });

  it('keeps the eager compat loader equal to the registry-verified template context', async () => {
    vi.resetModules();
    const { builtinTemplateAssets } = await import('../src/application/project/plugins.js');
    const { loadPackagedTemplateAssetContext } = await import('../src/adapters/packaged-assets/template-assets.js');
    expect(builtinTemplateAssets()).toEqual(loadPackagedTemplateAssetContext());
    expect(builtinTemplateAssets()).toBe(builtinTemplateAssets());
  });
});
