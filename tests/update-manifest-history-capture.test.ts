import { createHash } from 'node:crypto';
import type { BigIntStats, Stats } from 'node:fs';
import { readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as boundFiles from '../src/adapters/filesystem/bound-project-files.js';
import { collectStandaloneManifestHistoryInput } from '../src/application/update/manifest-history-capture.js';
import {
  prepareStandaloneManifestHistory, standaloneManifestHistoryPathsForSource,
  type CapturedPresentFile
} from '../src/application/update/manifest-history.js';
import {
  createManifestHistoryIndex, encodeManifestHistoryIndex, manifestHistoryPaths, manifestHistoryMaximumSourceBytes
} from '../src/domain/project/manifest/history.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { parseHistoryJson } from '../src/governance-activation/history-contracts.js';
import { FileSystemError } from '../src/domain/project/errors.js';

interface IoEvent {
  operation: 'lstat' | 'realpath' | 'readdir' | 'open';
  target: string;
  bigint?: boolean;
}
interface IoControl {
  events: IoEvent[];
  before?: (event: IoEvent) => Promise<void>;
  afterStat?: (event: IoEvent, result: Stats | BigIntStats) => void;
  afterOpen?: (event: IoEvent, handle: FileHandle) => Promise<void>;
}
const io = vi.hoisted((): IoControl => ({ events: [] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  async function before(event: IoEvent) {
    io.events.push(event);
    await io.before?.(event);
  }
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const event: IoEvent = { operation: 'lstat', target: String(args[0]),
        bigint: typeof args[1] === 'object' && args[1]?.bigint === true };
      await before(event);
      const result = await actual.lstat(...args);
      io.afterStat?.(event, result);
      return result;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      await before({ operation: 'realpath', target: String(args[0]) });
      return actual.realpath(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await before({ operation: 'readdir', target: String(args[0]) });
      return actual.readdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const event: IoEvent = { operation: 'open', target: String(args[0]) };
      await before(event);
      const handle = await actual.open(...args);
      await io.afterOpen?.(event, handle);
      return handle;
    }
  };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const sourceBytes = readFileSync(new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(raw = sourceBytes, complete = false) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mhc-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const sourcePath = path.join(root, 'liftoff.manifest.json');
  await fs.writeFile(sourcePath, raw, { mode: 0o640 });
  const source: CapturedPresentFile = {
    pathParts: ['liftoff.manifest.json'], content: Buffer.from(raw), mode: (await fs.lstat(sourcePath)).mode & 0o7777
  };
  const index = createManifestHistoryIndex({
    artifactVersion: parseManifest(parseHistoryJson(raw, 'capture fixture')).artifactVersion,
    digest: digest(raw), bytes: raw.length, mode: source.mode
  });
  const encoded = encodeManifestHistoryIndex(index);
  const reference = { schemaVersion: 1, kind: 'manifest-history', snapshotId: index.snapshotId, indexDigest: encoded.indexDigest };
  const paths = manifestHistoryPaths(reference);
  const indexPath = path.join(root, ...paths.indexPathParts);
  const copyPath = path.join(root, ...paths.manifestPathParts);
  const directory = path.dirname(indexPath);
  if (complete) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(indexPath, encoded.content, { mode: 0o600 });
    await fs.writeFile(copyPath, raw, { mode: 0o444 });
  }
  return { parent, root, outside, raw, source, sourcePath, index, encoded, reference, paths, indexPath, copyPath, directory };
}

async function inventory(root: string) {
  const records: Record<string, { kind: string; mode: number; bytes?: string; target?: string }> = {};
  async function walk(parts: string[]): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, ...parts))).sort()) {
      const next = [...parts, name];
      const absolute = path.join(root, ...next);
      const details = await fs.lstat(absolute);
      records[next.join('/')] = {
        kind: details.isSymbolicLink() ? 'link' : details.isDirectory() ? 'directory' : 'file',
        mode: details.mode & 0o7777,
        ...(details.isFile() ? { bytes: (await fs.readFile(absolute)).toString('base64') } : {}),
        ...(details.isSymbolicLink() ? { target: await fs.readlink(absolute) } : {})
      };
      if (details.isDirectory() && !details.isSymbolicLink()) await walk(next);
    }
  }
  await walk([]);
  return records;
}

function opening(event: IoEvent, target: string) {
  return event.operation === 'open' && event.target === target;
}

afterEach(async () => {
  delete io.before;
  delete io.afterStat;
  delete io.afterOpen;
  io.events.length = 0;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('shared pure source-to-path derivation', () => {
  it('derives exact paths without directory observations or project I/O', async () => {
    const f = await fixture();
    io.before = async () => { throw new Error('Pure source derivation attempted project I/O'); };
    expect(standaloneManifestHistoryPathsForSource(f.source)).toEqual(f.paths);
    expect(io.events).toEqual([]);
    expect(standaloneManifestHistoryPathsForSource(f.source)).not.toBe(f.paths);
  });

  it.each(['valueOf', 'constructor', 'iterator'] as const)('preserves hook-free source capture with a %s getter', async (hook) => {
    const f = await fixture();
    const content = Buffer.from(f.raw);
    const getter = vi.fn(() => () => Buffer.concat([f.raw, Buffer.from('\n')]));
    Object.defineProperty(content, hook === 'iterator' ? Symbol.iterator : hook, { get: getter });
    expect(standaloneManifestHistoryPathsForSource({ ...f.source, content })).toEqual(f.paths);
    expect(getter).not.toHaveBeenCalled();
    expect(content.equals(f.raw)).toBe(true);
    expect(io.events).toEqual([]);
  });

  it.each([
    Buffer.from('{"artifactVersion":7,"artifactVersion":7}'),
    Buffer.from('{"password":"never-copy-private-value"}'),
    Buffer.from('{"artifactVersion":8}'),
    Buffer.from('{"project":{"workload":{"kind":"power-apps-code-app"}}}'),
    Buffer.alloc(0)
  ])('retains actual source rejection %# before any history I/O', async (content) => {
    const f = await fixture();
    await fs.writeFile(f.sourcePath, content);
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow();
    expect(io.events.filter((event) => event.operation === 'open').map((event) => event.target)).toEqual([f.sourcePath]);
    expect(io.events.some((event) => event.target.startsWith(path.join(f.root, '.liftoff')))).toBe(false);
  });
});

describe('actual read-only standalone observations', () => {
  it('independently observes both missing files twice even under an absent directory', async () => {
    const f = await fixture();
    const before = await inventory(f.parent);
    const reads = vi.spyOn(boundFiles, 'readBoundProjectFileSnapshot');
    const result = await collectStandaloneManifestHistoryInput(f.root);
    expect(reads.mock.calls.map(([, parts]) => parts.join('/'))).toEqual([
      'liftoff.manifest.json', f.paths.indexPathParts.join('/'), f.paths.manifestPathParts.join('/'),
      'liftoff.manifest.json', f.paths.indexPathParts.join('/'), f.paths.manifestPathParts.join('/')
    ]);
    for (const [selectedRoot, , options] of reads.mock.calls) {
      expect(selectedRoot).toBe(f.root);
      expect(options).toMatchObject({ linkPolicy: 'single-link', maximumBytes: 8_388_608 });
    }
    expect(result).toEqual({
      sourceManifest: f.source,
      destinations: {
        directory: { pathParts: f.paths.indexPathParts.slice(0, -1), kind: 'absent' },
        index: { pathParts: f.paths.indexPathParts },
        copy: { pathParts: f.paths.manifestPathParts }
      }
    });
    const planned = prepareStandaloneManifestHistory(result);
    expect(planned.disposition).toBe('create-standalone');
    expect(planned.preservationWrites.map((entry) => entry.pathParts)).toEqual([f.paths.manifestPathParts, f.paths.indexPathParts]);
    expect(await inventory(f.parent)).toEqual(before);
    expect(Object.keys(result).sort()).toEqual(['destinations', 'sourceManifest']);
  });

  it('captures complete CRLF history and actual physical modes without changing files', async () => {
    const f = await fixture(Buffer.from(sourceBytes.toString('utf8').replace(/\r?\n/g, '\r\n')), true);
    const before = await inventory(f.parent);
    const result = await collectStandaloneManifestHistoryInput(f.root);
    const planned = prepareStandaloneManifestHistory(result);
    expect(result.sourceManifest.content.equals(f.raw)).toBe(true);
    expect(result.destinations.copy.content?.equals(f.raw)).toBe(true);
    expect(result.destinations.index.content?.equals(Buffer.from(f.encoded.content))).toBe(true);
    expect(result.sourceManifest.mode).toBe((await fs.lstat(f.sourcePath)).mode & 0o7777);
    expect(result.destinations.copy.mode).toBe((await fs.lstat(f.copyPath)).mode & 0o7777);
    expect(result.destinations.index.mode).toBe((await fs.lstat(f.indexPath)).mode & 0o7777);
    expect(planned.disposition).toBe('reuse-standalone');
    expect(planned.preservationWrites).toEqual([]);
    expect(planned.filePreconditions.map((entry) => entry.pathParts)).toEqual([
      ['liftoff.manifest.json'], f.paths.manifestPathParts, f.paths.indexPathParts
    ]);
    expect(result.sourceManifest.content === result.destinations.copy.content).toBe(false);
    result.sourceManifest.content.fill(0);
    expect(result.destinations.copy.content?.equals(f.raw)).toBe(true);
    expect(await inventory(f.parent)).toEqual(before);
  });

  it.each(['empty-directory', 'missing-copy', 'missing-index', 'different-copy', 'malformed-index', 'noncanonical-index'] as const)(
    'returns truthful stable %s observations for the unchanged preparer to reject',
    async (kind) => {
      const f = await fixture(sourceBytes, true);
      if (kind === 'empty-directory' || kind === 'missing-copy') await fs.unlink(f.copyPath);
      if (kind === 'empty-directory' || kind === 'missing-index') await fs.unlink(f.indexPath);
      if (kind === 'different-copy') {
        await fs.chmod(f.copyPath, 0o644);
        await fs.writeFile(f.copyPath, 'different preserved bytes');
      }
      if (kind === 'malformed-index') await fs.writeFile(f.indexPath, '{malformed');
      if (kind === 'noncanonical-index') await fs.writeFile(f.indexPath, JSON.stringify(f.index, null, 2));
      const before = await inventory(f.parent);
      const result = await collectStandaloneManifestHistoryInput(f.root);
      expect(result.destinations.directory.kind).toBe('directory');
      expect(result.destinations.copy.content === undefined).toBe(kind === 'empty-directory' || kind === 'missing-copy');
      expect(result.destinations.index.content === undefined).toBe(kind === 'empty-directory' || kind === 'missing-index');
      expect(() => prepareStandaloneManifestHistory(result)).toThrow();
      expect(await inventory(f.parent)).toEqual(before);
    }
  );

  it('does not inspect active/orphan records, other snapshots or neighboring bodies', async () => {
    const f = await fixture(sourceBytes, true);
    const protectedPaths = [
      ['governance', 'activation-state.json'], ['governance', 'evidence', 'orphan.json'],
      ['governance', 'history', 'unselected', 'index.json'], ['state', 'production.tfstate'],
      ['.liftoff', 'reviewed-update-transaction.json'], ['.liftoff', 'manifest-history', 'unselected', 'manifest.json'],
      [...f.paths.indexPathParts.slice(0, -1), 'unknown-neighbor.json']
    ];
    for (const parts of protectedPaths) {
      const target = path.join(f.root, ...parts);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '{"password":"protected-unrelated-body"}\n');
    }
    const before = await inventory(f.parent);
    const result = await collectStandaloneManifestHistoryInput(f.root);
    expect(new Set(io.events.filter((event) => event.operation === 'open').map((event) => event.target)))
      .toEqual(new Set([f.sourcePath, f.indexPath, f.copyPath]));
    expect(Object.keys(result)).toEqual(['sourceManifest', 'destinations']);
    expect(await inventory(f.parent)).toEqual(before);
  });

  it('accepts an actual inclusive 8 MiB source and rejects one byte over before opening it', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(manifestHistoryMaximumSourceBytes, ' ');
    sourceBytes.copy(bytes);
    await fs.writeFile(f.sourcePath, bytes);
    const result = await collectStandaloneManifestHistoryInput(f.root);
    expect(result.sourceManifest.content.length).toBe(8_388_608);
    expect(result.sourceManifest.content.equals(bytes)).toBe(true);
    expect(result).not.toHaveProperty('budgetPassed');
    await fs.appendFile(f.sourcePath, ' ');
    io.events.length = 0;
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('bounded size limit');
    expect(io.events.some((event) => event.operation === 'open')).toBe(false);
  });
});

describe('selected canonical root and exact directory identities', () => {
  it.each([undefined, null, '', 'relative', 'project/../root', 123, {}, '\\\\?\\C:\\project', '\\\\.\\C:\\project'])(
    'rejects invalid selected root %# before I/O', async (value) => {
      await expect(Reflect.apply(collectStandaloneManifestHistoryInput, undefined, [value]))
        .rejects.toThrow('absolute canonical native path');
      expect(io.events).toEqual([]);
    });

  it.each(['trailing-separator', 'dot', 'double-separator'] as const)('rejects a %s root spelling', async (kind) => {
    const f = await fixture();
    const value = kind === 'trailing-separator' ? `${f.root}${path.sep}`
      : kind === 'dot' ? `${f.root}${path.sep}.` : `${f.parent}${path.sep}${path.sep}${path.basename(f.root)}`;
    await expect(collectStandaloneManifestHistoryInput(value)).rejects.toThrow('absolute canonical native path');
    expect(io.events).toEqual([]);
  });

  it.each(['missing', 'file', 'leaf-link', 'ancestor-link'] as const)('refuses a %s root without retargeting or fallback', async (kind) => {
    const f = await fixture();
    let requested = path.join(f.parent, 'selected');
    if (kind === 'file') await fs.writeFile(requested, 'not a project root');
    if (kind === 'leaf-link') await fs.symlink(f.root, requested, process.platform === 'win32' ? 'junction' : 'dir');
    if (kind === 'ancestor-link') {
      await fs.symlink(f.parent, requested, process.platform === 'win32' ? 'junction' : 'dir');
      requested = path.join(requested, path.basename(f.root));
    }
    const before = await inventory(f.root);
    await expect(collectStandaloneManifestHistoryInput(requested)).rejects.toThrow();
    expect(io.events.some((event) => event.operation === 'open')).toBe(false);
    expect(await inventory(f.root)).toEqual(before);
  });

  it('refuses a case-aliased root whether the host resolves it or reports it missing', async () => {
    const f = await fixture();
    await expect(collectStandaloneManifestHistoryInput(path.join(f.parent, path.basename(f.root).toUpperCase())))
      .rejects.toThrow();
    expect(io.events.some((event) => event.operation === 'open')).toBe(false);
  });

  it('keeps bigint inode identities above the safe-number limit exact across observations', async () => {
    const f = await fixture();
    let rootStats = 0;
    io.afterStat = (event, result) => {
      if (event.target === f.root && event.bigint) {
        rootStats++;
        Object.assign(result, { ino: 9_007_199_254_740_993n });
      }
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).resolves.toHaveProperty('sourceManifest');
    expect(rootStats).toBeGreaterThan(2);
    rootStats = 0;
    io.events.length = 0;
    io.afterStat = (event, result) => {
      if (event.target === f.root && event.bigint) {
        rootStats++;
        Object.assign(result, { ino: rootStats <= 2 ? 9_007_199_254_740_992n : 9_007_199_254_740_993n });
      }
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('selected root changed');
    expect(io.events.some((event) => event.operation === 'open')).toBe(false);
  });

  it.each([0n, -1n, 9_007_199_254_740_992, undefined])('rejects unavailable or unsafe inode identity %#', async (ino) => {
    const f = await fixture();
    io.afterStat = (event, details) => {
      if (event.target === f.root && event.bigint) Object.assign(details, { ino });
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('comparable exact filesystem identity');
    expect(io.events.some((event) => event.operation === 'open')).toBe(false);
  });
});

describe('strict descendants and unavailable reads', () => {
  it.each(['source', 'copy', 'index'] as const)('rejects a hard-linked %s without modifying either name', async (member) => {
    const f = await fixture(sourceBytes, true);
    const selected = member === 'source' ? f.sourcePath : member === 'copy' ? f.copyPath : f.indexPath;
    const original = await fs.readFile(selected);
    const outside = path.join(f.outside, 'linked');
    await fs.link(selected, outside);
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('hard-linked file');
    expect(io.events.some((event) => opening(event, selected))).toBe(false);
    expect((await fs.readFile(selected)).equals(original)).toBe(true);
    expect((await fs.readFile(outside)).equals(original)).toBe(true);
  });

  it.for(['namespace', 'snapshot', 'source', 'copy', 'index'] as const)(
    'rejects a linked %s before reading outside bodies',
    async (member, { skip }) => {
      const isDirectory = member === 'namespace' || member === 'snapshot';
      if (!isDirectory && process.platform === 'win32') skip('Windows file-symlink setup requires separate native qualification.');
      const f = await fixture(sourceBytes, true);
      const selected = member === 'namespace' ? path.join(f.root, '.liftoff')
        : member === 'snapshot' ? f.directory : member === 'source' ? f.sourcePath : member === 'copy' ? f.copyPath : f.indexPath;
      await fs.rename(selected, `${selected}-original`);
      if (isDirectory) {
        await fs.writeFile(path.join(f.outside, 'manifest.json'), f.raw);
        await fs.writeFile(path.join(f.outside, 'index.json'), f.encoded.content);
        await fs.symlink(f.outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        const outsideFile = path.join(f.outside, 'body');
        await fs.writeFile(outsideFile, f.raw);
        await fs.symlink(outsideFile, selected);
      }
      const outsideBefore = await inventory(f.outside);
      await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('symlink or junction');
      expect(io.events.some((event) => event.operation === 'open' && event.target.startsWith(selected))).toBe(false);
      expect(await inventory(f.outside)).toEqual(outsideBefore);
    }
  );

  it.each(['source', 'copy', 'index', 'namespace', 'snapshot'] as const)('rejects a nonregular %s', async (member) => {
    const f = await fixture(sourceBytes, true);
    const selected = member === 'source' ? f.sourcePath : member === 'copy' ? f.copyPath : member === 'index' ? f.indexPath
      : member === 'namespace' ? path.join(f.root, '.liftoff') : f.directory;
    await fs.rename(selected, `${selected}-original`);
    if (member === 'namespace' || member === 'snapshot') await fs.writeFile(selected, 'not a directory');
    else await fs.mkdir(selected);
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow(/real directory|not a regular file/);
    expect(io.events.some((event) => opening(event, selected))).toBe(false);
  });

  it.each(['source', 'namespace', 'copy', 'index'] as const)('refuses a case alias for %s', async (member) => {
    const f = await fixture(sourceBytes, true);
    const selected = member === 'source' ? f.sourcePath : member === 'namespace' ? path.join(f.root, '.liftoff')
      : member === 'copy' ? f.copyPath : f.indexPath;
    await fs.rename(selected, path.join(path.dirname(selected), path.basename(selected).toUpperCase()));
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('case or Unicode collision');
  });

  it.each(['root-lstat', 'root-realpath', 'namespace-lstat', 'source-open', 'copy-open', 'index-open', 'directory-enotdir'] as const)(
    'preserves exact %s failure rather than absence',
    async (at) => {
      const f = await fixture(sourceBytes, true);
      const error = Object.assign(new Error(`injected ${at}`), { code: at === 'directory-enotdir' ? 'ENOTDIR' : at === 'copy-open' ? 'EPERM' : 'EACCES' });
      const before = await inventory(f.parent);
      io.before = async (event) => {
        if (at === 'root-lstat' && event.operation === 'lstat' && event.target === f.root ||
          at === 'root-realpath' && event.operation === 'realpath' && event.target === f.root ||
          (at === 'namespace-lstat' || at === 'directory-enotdir') && event.operation === 'lstat' && event.bigint && event.target === f.directory ||
          at === 'source-open' && opening(event, f.sourcePath) ||
          at === 'copy-open' && opening(event, f.copyPath) ||
          at === 'index-open' && opening(event, f.indexPath)) throw error;
      };
      await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toBe(error);
      expect(await inventory(f.parent)).toEqual(before);
    }
  );

  it('treats actual required-source absence as an error even when an outer manifest exists', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.parent, 'liftoff.manifest.json'), f.raw);
    await fs.unlink(f.sourcePath);
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('required original liftoff.manifest.json is absent');
    expect(io.events.some((event) => opening(event, path.join(f.parent, 'liftoff.manifest.json')))).toBe(false);
  });
});

describe('fixed-pass consistency without retries or cleanup', () => {
  it.each([
    'source-bytes', 'source-mode', 'source-missing', 'copy-bytes', 'index-bytes',
    'copy-mode', 'index-mode', 'copy-appears', 'index-appears', 'copy-disappears', 'index-disappears'
  ] as const)(
    'rejects observed %s changes and preserves the edits',
    async (change) => {
      const f = await fixture(sourceBytes, true);
      if (change === 'copy-appears') await fs.unlink(f.copyPath);
      if (change === 'index-appears') await fs.unlink(f.indexPath);
      let sourceOpens = 0;
      io.before = async (event) => {
        if (!opening(event, f.sourcePath) || ++sourceOpens !== 2) return;
        if (change === 'source-bytes') await fs.appendFile(f.sourcePath, '\n');
        if (change === 'source-mode') await fs.chmod(f.sourcePath, 0o444);
        if (change === 'source-missing') await fs.unlink(f.sourcePath);
        if (change === 'copy-bytes') {
          await fs.chmod(f.copyPath, 0o644);
          await fs.writeFile(f.copyPath, 'later copy edit');
        }
        if (change === 'index-bytes') await fs.writeFile(f.indexPath, 'later index edit');
        if (change === 'copy-mode') await fs.chmod(f.copyPath, 0o640);
        if (change === 'index-mode') await fs.chmod(f.indexPath, 0o444);
        if (change === 'copy-appears') await fs.writeFile(f.copyPath, f.raw);
        if (change === 'index-appears') await fs.writeFile(f.indexPath, f.encoded.content);
        if (change === 'copy-disappears') await fs.unlink(f.copyPath);
        if (change === 'index-disappears') await fs.unlink(f.indexPath);
      };
      const reads = vi.spyOn(boundFiles, 'readBoundProjectFileSnapshot');
      await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('changed during collection');
      expect(reads.mock.calls.length).toBeLessThanOrEqual(6);
      expect(new Set(reads.mock.calls.map(([, parts]) => parts.join('/'))))
        .toEqual(new Set(['liftoff.manifest.json', f.paths.indexPathParts.join('/'), f.paths.manifestPathParts.join('/')]));
      if (change === 'copy-bytes') expect(await fs.readFile(f.copyPath, 'utf8')).toBe('later copy edit');
      if (change === 'index-bytes') expect(await fs.readFile(f.indexPath, 'utf8')).toBe('later index edit');
      if (change === 'source-bytes') expect((await fs.readFile(f.sourcePath)).equals(Buffer.concat([f.raw, Buffer.from('\n')]))).toBe(true);
      if (change === 'source-missing') await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('rejects after-open disappearance instead of returning an absent source', async () => {
    const f = await fixture();
    io.afterOpen = async (event) => { if (opening(event, f.sourcePath)) await fs.unlink(f.sourcePath); };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow();
    expect(io.events.filter((event) => event.operation === 'open')).toHaveLength(1);
  });

  it('rejects root replacement with equal contents rather than continuing at the new inode', async () => {
    const f = await fixture();
    let readStarted = false;
    let replaced = false;
    io.before = async (event) => {
      if (opening(event, f.sourcePath)) readStarted = true;
      if (!readStarted || replaced || event.operation !== 'lstat' || !event.bigint || event.target !== f.root) return;
      replaced = true;
      await fs.rename(f.root, path.join(f.parent, 'preserved-original-root'));
      await fs.mkdir(f.root);
      await fs.writeFile(f.sourcePath, f.raw, { mode: f.source.mode });
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('selected root changed');
    expect(replaced).toBe(true);
    expect((await fs.readFile(f.sourcePath)).equals(f.raw)).toBe(true);
    expect((await fs.readFile(path.join(f.parent, 'preserved-original-root', 'liftoff.manifest.json'))).equals(f.raw)).toBe(true);
    expect(io.events.filter((event) => event.operation === 'open')).toHaveLength(1);
  });

  it('rejects an observed root mode change without undoing it', async () => {
    const f = await fixture();
    let changed = false;
    io.before = async (event) => {
      if (!changed && opening(event, f.sourcePath)) {
        changed = true;
        await fs.chmod(f.root, 0o500);
      }
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('selected root changed');
    expect(changed).toBe(true);
    if (process.platform !== 'win32') expect((await fs.lstat(f.root)).mode & 0o777).toBe(0o500);
    await fs.chmod(f.root, 0o700);
    expect((await fs.readFile(f.sourcePath)).equals(f.raw)).toBe(true);
  });

  it.each([['.liftoff'], ['.liftoff', 'manifest-history']].map((parts) => ({ parts, name: parts.join('/') })))(
    'checks replacement of the observed namespace prefix $name',
    async ({ parts }) => {
      const f = await fixture(sourceBytes, true);
      const prefix = path.join(f.root, ...parts);
      const retained = `${prefix}-retained`;
      let observations = 0;
      io.before = async (event) => {
        if (event.operation !== 'lstat' || !event.bigint || event.target !== prefix || ++observations !== 2) return;
        await fs.rename(prefix, retained);
        await fs.mkdir(prefix);
      };
      await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('changed during collection');
      expect(observations).toBe(2);
      const relativeCopy = path.relative(prefix, f.copyPath);
      expect((await fs.readFile(path.join(retained, relativeCopy))).equals(f.raw)).toBe(true);
    }
  );

  it.each(['appears', 'replaced', 'removed', 'mode'] as const)('rejects a namespace directory that %s between passes', async (change) => {
    const f = await fixture(sourceBytes, change !== 'appears');
    let observations = 0;
    io.before = async (event) => {
      if (event.operation !== 'lstat' || !event.bigint || event.target !== f.directory || ++observations !== 2) return;
      if (change === 'appears') await fs.mkdir(f.directory, { recursive: true });
      else if (change === 'mode') await fs.chmod(f.directory, 0o500);
      else {
        await fs.rename(f.directory, `${f.directory}-retained`);
        if (change === 'replaced') await fs.mkdir(f.directory);
      }
    };
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('changed during collection');
    expect(observations).toBe(2);
    if (change === 'mode') await fs.chmod(f.directory, 0o700);
    if (change === 'removed' || change === 'replaced') {
      expect((await fs.readFile(path.join(`${f.directory}-retained`, 'manifest.json'))).equals(f.raw)).toBe(true);
    }
  });

  it('checks final directory identity even after both file passes matched', async () => {
    const f = await fixture(sourceBytes, true);
    let observations = 0;
    io.before = async (event) => {
      if (event.operation !== 'lstat' || !event.bigint || event.target !== f.directory || ++observations !== 3) return;
      await fs.rename(f.directory, `${f.directory}-retained`);
      await fs.mkdir(f.directory);
    };
    const reads = vi.spyOn(boundFiles, 'readBoundProjectFileSnapshot');
    await expect(collectStandaloneManifestHistoryInput(f.root)).rejects.toThrow('changed during collection');
    expect(reads).toHaveBeenCalledTimes(6);
    expect((await fs.readFile(path.join(`${f.directory}-retained`, 'manifest.json'))).equals(f.raw)).toBe(true);
  });

  it('does not reject unrelated sibling creation merely because directory mtime changes', async () => {
    const f = await fixture(sourceBytes, true);
    let sourceOpens = 0;
    io.before = async (event) => {
      if (!opening(event, f.sourcePath) || ++sourceOpens !== 2) return;
      await fs.writeFile(path.join(f.root, 'new-unrelated-file'), 'keep this');
      await fs.writeFile(path.join(f.directory, 'new-unrelated-history-neighbor'), 'keep this too');
    };
    const input = await collectStandaloneManifestHistoryInput(f.root);
    expect(prepareStandaloneManifestHistory(input).disposition).toBe('reuse-standalone');
    expect(await fs.readFile(path.join(f.root, 'new-unrelated-file'), 'utf8')).toBe('keep this');
    expect(io.events.some((event) => event.operation === 'open' && event.target.includes('unrelated'))).toBe(false);
  });
});
