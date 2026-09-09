import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createUpdatePreviewDescriptor,
  createUpdatePreviewReceipt,
  matchUpdatePreviewReceipt,
  updatePreviewProjectKey,
  validateUpdatePreviewReceipt
} from '../src/application/update/preview.js';
import type { UpdatePreviewInput, UpdatePreviewReceipt } from '../src/application/update/preview.js';
import {
  consumeUpdatePreviewReceipt,
  createUpdateTransactionApprovalStore,
  getUpdatePreviewDirectory,
  issueUpdatePreviewReceipt,
  loadUpdatePreviewReceipt,
  resolveUpdatePreviewLocation
} from '../src/adapters/filesystem/update-previews.js';
import {
  createUpdateTransactionApprovalSeal,
  updateTransactionApprovalKey,
  validateUpdateTransactionApprovalSeal
} from '../src/application/update/transaction-approval.js';
import type {
  UpdatePreviewFileHandle,
  UpdatePreviewFileStat,
  UpdatePreviewFileSystem,
  UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';

type EntryKind = 'directory' | 'file' | 'symlink' | 'other';
interface Entry {
  path: string;
  kind: EntryKind;
  content: string;
  target: string;
  mode: number;
  ino: number;
  nlink: number;
  modified: number;
}

class FixtureError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

// Native paths are simulated in memory; no test touches a real project, home, or temporary directory.
class MemoryFileSystem implements UpdatePreviewFileSystem {
  readonly entries = new Map<string, Entry>();
  readonly events: { operation: string; path: string; mode?: number }[] = [];
  readonly faults: { operation: string; pattern: RegExp; code: string }[] = [];
  onOperation?: (operation: string, filePath: string) => void;
  private sequence = 0;
  readonly paths: typeof path.posix;

  constructor(readonly platform: NodeJS.Platform = 'linux') {
    this.paths = platform === 'win32' ? path.win32 : path.posix;
  }

  private normalize(filePath: string): string {
    const normalized = this.paths.normalize(filePath);
    return normalized === this.paths.parse(normalized).root
      ? normalized : normalized.endsWith(this.paths.sep) ? normalized.slice(0, -1) : normalized;
  }

  private key(filePath: string): string {
    const normalized = this.normalize(filePath);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private event(operation: string, filePath: string, mode?: number): void {
    this.events.push({ operation, path: filePath, mode });
    this.onOperation?.(operation, filePath);
    const index = this.faults.findIndex((fault) => fault.operation === operation && fault.pattern.test(filePath));
    if (index >= 0) {
      const [fault] = this.faults.splice(index, 1);
      throw new FixtureError(fault.code, `injected ${operation} failure`);
    }
  }

  fail(operation: string, pattern = /./u, code = 'EIO'): void {
    this.faults.push({ operation, pattern, code });
  }

  private seed(filePath: string, kind: EntryKind, mode: number, content = '', target = ''): Entry {
    const entry: Entry = {
      path: this.normalize(filePath), kind, mode, content, target,
      ino: ++this.sequence, nlink: 1, modified: this.sequence
    };
    this.entries.set(this.key(filePath), entry);
    return entry;
  }

  directory(filePath: string, mode = 0o755): void {
    const normalized = this.normalize(filePath);
    const parent = this.paths.dirname(normalized);
    if (parent !== normalized && !this.entries.has(this.key(parent))) this.directory(parent);
    this.seed(normalized, 'directory', mode);
  }

  file(filePath: string, content: string, mode = 0o600): Entry {
    const parent = this.paths.dirname(filePath);
    if (!this.entries.has(this.key(parent))) this.directory(parent);
    return this.seed(filePath, 'file', mode, content);
  }

  link(filePath: string, target: string): void {
    this.seed(filePath, 'symlink', 0o777, '', target);
  }

  other(filePath: string): void { this.seed(filePath, 'other', 0o600); }

  private resolve(filePath: string, followLast: boolean, depth = 0): Entry {
    if (depth > 20) throw new FixtureError('ELOOP');
    const normalized = this.normalize(filePath);
    const root = this.paths.parse(normalized).root;
    let current = this.entries.get(this.key(root));
    if (!current) throw new FixtureError('ENOENT');
    const parts = normalized.slice(root.length).split(this.paths.sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      if (current.kind !== 'directory') throw new FixtureError('ENOTDIR');
      const entry = this.entries.get(this.key(this.paths.join(current.path, part)));
      if (!entry) throw new FixtureError('ENOENT');
      current = entry.kind === 'symlink' && (followLast || index < parts.length - 1)
        ? this.resolve(entry.target, true, depth + 1) : entry;
    }
    return current;
  }

  get(filePath: string): Entry { return this.resolve(filePath, false); }
  contents(filePath: string): string { return this.get(filePath).content; }
  has(filePath: string): boolean {
    try { this.get(filePath); return true; }
    catch (error) { if (error instanceof FixtureError && error.code === 'ENOENT') return false; throw error; }
  }

  private statFor(entry: Entry): UpdatePreviewFileStat {
    const kind = entry.kind;
    return {
      dev: 1, ino: entry.ino, mode: entry.mode, nlink: entry.nlink,
      size: Buffer.byteLength(entry.content), mtimeMs: entry.modified, ctimeMs: entry.modified,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'directory',
      isSymbolicLink: () => kind === 'symlink'
    };
  }

  async lstat(filePath: string): Promise<UpdatePreviewFileStat> {
    this.event('lstat', filePath);
    return this.statFor(this.resolve(filePath, false));
  }

  async realpath(filePath: string): Promise<string> {
    this.event('realpath', filePath);
    return this.resolve(filePath, true).path;
  }

  async makeDirectory(directoryPath: string, mode: number): Promise<void> {
    this.event('mkdir', directoryPath, mode);
    const parent = this.resolve(this.paths.dirname(directoryPath), true);
    if (parent.kind !== 'directory') throw new FixtureError('ENOTDIR');
    const target = this.paths.join(parent.path, this.paths.basename(directoryPath));
    if (this.entries.has(this.key(target))) throw new FixtureError('EEXIST');
    this.seed(target, 'directory', mode);
  }

  async openFile(filePath: string, access: 'read' | 'create-exclusive', mode: number): Promise<UpdatePreviewFileHandle> {
    this.event(access === 'read' ? 'open-read' : 'open-create', filePath, mode);
    let entry: Entry;
    if (access === 'create-exclusive') {
      const parent = this.resolve(this.paths.dirname(filePath), true);
      if (parent.kind !== 'directory') throw new FixtureError('ENOTDIR');
      const target = this.paths.join(parent.path, this.paths.basename(filePath));
      if (this.entries.has(this.key(target))) throw new FixtureError('EEXIST');
      entry = this.seed(target, 'file', mode);
    } else {
      entry = this.resolve(filePath, false);
      if (entry.kind !== 'file') throw new FixtureError('ELOOP');
    }
    let closed = false;
    const opened = (operation: string): void => {
      this.event(operation, filePath);
      if (closed) throw new FixtureError('EBADF');
    };
    return {
      stat: async () => { opened('fstat'); return this.statFor(entry); },
      readText: async (maximumBytes) => {
        opened('read');
        if (Buffer.byteLength(entry.content) > maximumBytes) throw new FixtureError('EFBIG');
        return entry.content;
      },
      writeText: async (content) => {
        opened('write');
        entry.content = content;
        entry.modified = ++this.sequence;
      },
      chmod: async (nextMode) => {
        opened('chmod');
        entry.mode = nextMode;
        entry.modified = ++this.sequence;
      },
      sync: async () => { opened('sync'); },
      close: async () => {
        this.event('close', filePath);
        closed = true;
      }
    };
  }

  async replaceFile(sourcePath: string, targetPath: string): Promise<void> {
    this.event('rename', targetPath);
    const entry = this.resolve(sourcePath, false);
    const parent = this.resolve(this.paths.dirname(targetPath), true);
    if (parent.kind !== 'directory') throw new FixtureError('ENOTDIR');
    const target = this.paths.join(parent.path, this.paths.basename(targetPath));
    this.entries.delete(this.key(entry.path));
    entry.path = target;
    this.entries.set(this.key(target), entry);
  }

  async removeFile(filePath: string): Promise<void> {
    this.event('unlink', filePath);
    const entry = this.resolve(filePath, false);
    if (entry.kind === 'directory') throw new FixtureError('EISDIR');
    this.entries.delete(this.key(entry.path));
  }

  async syncDirectory(directoryPath: string): Promise<void> {
    this.event('sync-directory', directoryPath);
    if (this.resolve(directoryPath, false).kind !== 'directory') throw new FixtureError('ENOTDIR');
  }

  mutations(): string[] {
    return this.events.filter(({ operation }) =>
      ['mkdir', 'open-create', 'write', 'chmod', 'rename', 'unlink'].includes(operation)
    ).map(({ path: filePath }) => filePath);
  }
}

const issuedAt = '2026-09-09T07:00:00.000Z';
const receiptId = '11111111-1111-4111-8111-111111111111';
const sourceBody = 'private source-file body, credentials must never be cached';
const renderedBody = 'new managed file body not for persistence in a receipt';

function input(projectRoot = '/fixture/repos/example/app'): UpdatePreviewInput {
  return {
    projectRoot, cliVersion: '0.11.1', mode: 'normal',
    source: { manifest: { version: 7 }, config: { profile: 'api' }, privateBody: sourceBody },
    target: { renderer: 'packaged-release', contract: { activation: 2 }, renderedBody },
    operations: [
      { path: ['.liftoff', 'managed.md'], expected: { kind: 'file', hash: 'old-bytes', mode: 0o644 }, renderedBody },
      { command: ['npm', 'run', 'validate'], cwd: ['backend'], protectedInputs: ['package.json'], outputs: [] }
    ]
  };
}

function fixture(platform: NodeJS.Platform = 'linux') {
  const fs = new MemoryFileSystem(platform);
  const paths = fs.paths;
  const root = platform === 'win32' ? 'C:\\Fixture With Spaces' : '/fixture';
  const repositoryRoot = paths.join(root, 'repos', 'example');
  const projectRoot = paths.join(repositoryRoot, 'app');
  const home = paths.join(root, 'home');
  const state = paths.join(root, 'state');
  fs.directory(projectRoot);
  fs.file(paths.join(repositoryRoot, '.git'), 'gitdir: external-worktree-metadata');
  fs.file(paths.join(projectRoot, 'source.txt'), sourceBody);
  fs.directory(home);
  const env: NodeJS.ProcessEnv = platform === 'linux' ? { XDG_STATE_HOME: state }
    : platform === 'win32' ? { LOCALAPPDATA: state } : {};
  const options: UpdatePreviewOptions = {
    platform, fileSystem: fs, homedir: home, env, repositoryRoot, clock: () => new Date(issuedAt)
  };
  return { fs, paths, root, repositoryRoot, projectRoot, home, state, options };
}

function makeReceipt(overrides: Partial<UpdatePreviewInput> = {}): UpdatePreviewReceipt {
  return createUpdatePreviewReceipt([createUpdatePreviewDescriptor({ ...input(), ...overrides })], { receiptId, issuedAt });
}

describe('semantic update fingerprints', () => {
  it('hashes structured semantics deterministically with full lowercase digests', () => {
    const left = createUpdatePreviewDescriptor({
      ...input(), source: { z: { b: 2, a: 1 }, a: ['one', 'two'] }
    });
    const right = createUpdatePreviewDescriptor({
      ...input(), source: { a: ['one', 'two'], z: { a: 1, b: 2 } }
    });
    expect(right).toEqual(left);
    for (const value of [left.fingerprint, left.sourceDigest, left.targetDigest, left.operationsDigest]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it.each([
    { source: { manifest: { version: 6 } } },
    { source: { expected: { kind: 'absent' } } },
    { source: { expected: { kind: 'file', mode: 0o600 } } },
    { source: { history: [{ path: ['governance', 'state.json'], rawHash: 'changed' }] } },
    { target: { renderer: 'different packaged bytes' } },
    { target: { activation: 3 } },
    { operations: [{ command: ['npm', 'run', 'different'], cwd: ['backend'] }] },
    { operations: [{ path: ['different'], expected: null }] },
    { projectRoot: '/fixture/repos/copied/app' },
    { projectRoot: '/fixture/worktrees/example/app' },
    { cliVersion: '0.12.0' },
    { mode: 'force' }
  ])('invalidates the complete fingerprint for changed input %j', (changes) => {
    const original = input();
    const modified: UpdatePreviewInput = {
      ...original, ...changes, mode: changes.mode === 'force' ? 'force' : original.mode
    };
    expect(createUpdatePreviewDescriptor(modified).fingerprint).not.toBe(createUpdatePreviewDescriptor(original).fingerprint);
  });

  it('does not canonicalize away executable array order', () => {
    expect(createUpdatePreviewDescriptor({ ...input(), operations: ['write', 'retire'] }).fingerprint)
      .not.toBe(createUpdatePreviewDescriptor({ ...input(), operations: ['retire', 'write'] }).fingerprint);
  });

  it('keeps issuance time and receipt ids out of semantic fingerprints', () => {
    const descriptor = createUpdatePreviewDescriptor(input());
    const first = createUpdatePreviewReceipt([descriptor], { issuedAt, receiptId });
    const second = createUpdatePreviewReceipt([descriptor], {
      issuedAt: '2026-10-01T12:00:00.000Z', receiptId: '22222222-2222-4222-8222-222222222222'
    });
    expect(first.variants).toEqual(second.variants);
    expect(first.receiptId).not.toBe(second.receiptId);
    expect(first.issuedAt).not.toBe(second.issuedAt);
  });

  it('separates the normal and force modes even when other semantics are equal', () => {
    const normal = createUpdatePreviewDescriptor(input());
    const force = createUpdatePreviewDescriptor({ ...input(), mode: 'force' });
    expect(force.operationsDigest).toBe(normal.operationsDigest);
    expect(force.fingerprint).not.toBe(normal.fingerprint);
    expect(() => matchUpdatePreviewReceipt(makeReceipt(), force)).toThrow(/force preview is missing or stale/u);
  });

  it.each([undefined, NaN, Infinity, 1n, Symbol('key'), () => 1, new Date(), new Map(), [, 1]])(
    'rejects semantics canonical JSON cannot represent faithfully (%s)', (source) => {
      expect(() => createUpdatePreviewDescriptor({ ...input(), source })).toThrow(/semantics/u);
    }
  );

  it('rejects cycles, undefined fields, getters, hidden fields and symbol keys without invoking accessors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let invoked = false;
    const getter = { get body() { invoked = true; return 'secret'; } };
    for (const source of [cyclic, { absent: undefined }, getter, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('key')]: 1 }]) {
      expect(() => createUpdatePreviewDescriptor({ ...input(), source })).toThrow(/semantics/u);
    }
    expect(invoked).toBe(false);
  });

  it('rejects custom array behavior at the unknown semantic boundary', () => {
    class RuntimeArray extends Array<unknown> {}
    expect(() => createUpdatePreviewDescriptor({ ...input(), source: new RuntimeArray() })).toThrow(/plain JSON arrays/u);
  });

  it('retains distinct POSIX case and legal trailing backslashes in canonical identities', () => {
    expect(updatePreviewProjectKey('/Projects/App')).not.toBe(updatePreviewProjectKey('/Projects/app'));
    expect(updatePreviewProjectKey('/projects/app\\')).not.toBe(updatePreviewProjectKey('/projects/app'));
  });

  it('requires an absolute root and validates descriptor digests rather than trusting cached fingerprints', () => {
    expect(() => createUpdatePreviewDescriptor({ ...input(), projectRoot: './project' })).toThrow(/absolute/u);
    const receipt = makeReceipt();
    expect(() => matchUpdatePreviewReceipt(receipt, { ...receipt.variants[0], sourceDigest: '0'.repeat(64) })).toThrow(/inconsistent/u);
    expect(() => matchUpdatePreviewReceipt(receipt, { ...receipt.variants[0], fingerprint: receipt.variants[0].fingerprint.slice(0, 12) }))
      .toThrow(/inconsistent/u);
  });
});

describe('schema-1 receipt validation', () => {
  it('retains both eligible variants, but no source bodies, commands or approval claims', () => {
    const normal = createUpdatePreviewDescriptor(input());
    const force = createUpdatePreviewDescriptor({ ...input(), mode: 'force' });
    const receipt = createUpdatePreviewReceipt([force, normal], { receiptId, issuedAt });
    expect(receipt.variants.map((variant) => variant.mode)).toEqual(['normal', 'force']);
    expect(matchUpdatePreviewReceipt(receipt, normal)).toEqual(normal);
    expect(matchUpdatePreviewReceipt(receipt, force)).toEqual(force);
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [sourceBody, renderedBody, 'privateBody', 'command', 'protectedInputs', 'approved', 'npm']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(receipt).toMatchObject({ schemaVersion: 1, kind: 'liftoff-update-preview' });
  });

  it('does not issue receipts for empty, duplicate, mixed-project, or mixed-CLI variants', () => {
    const normal = createUpdatePreviewDescriptor(input());
    const otherProject = createUpdatePreviewDescriptor({ ...input(), mode: 'force', projectRoot: '/another-project' });
    const otherCli = createUpdatePreviewDescriptor({ ...input(), mode: 'force', cliVersion: '1.0.0' });
    for (const variants of [[], [normal, normal], [normal, otherProject], [normal, otherCli]]) {
      expect(() => createUpdatePreviewReceipt(variants, { issuedAt, receiptId })).toThrow();
    }
  });

  it.each([undefined, null, [], {}, { schemaVersion: 2 }, { schemaVersion: 0 }])('rejects missing or unsupported schema (%j)', (value) => {
    expect(() => validateUpdatePreviewReceipt(value)).toThrow();
  });

  it('rejects unknown fields, altered digests, forged identity, invalid issuance, and future dates', () => {
    const receipt = makeReceipt();
    const values: unknown[] = [
      { ...receipt, approved: true },
      { ...receipt, source: sourceBody },
      { ...receipt, kind: 'liftoff-update-approval' },
      { ...receipt, projectKey: 'a'.repeat(64) },
      { ...receipt, projectRoot: '/different' },
      { ...receipt, receiptId: '../escape' },
      { ...receipt, issuedAt: 'not a date' },
      { ...receipt, issuedAt: '2026-02-30T07:00:00.000Z' },
      { ...receipt, issuedAt: '2126-09-09T07:00:00.000Z' },
      { ...receipt, variants: [{ ...receipt.variants[0], operationsDigest: 'f'.repeat(64) }] },
      { ...receipt, variants: [{ ...receipt.variants[0], commands: ['do-not-execute'] }] }
    ];
    for (const value of values) expect(() => validateUpdatePreviewReceipt(value, { now: new Date(issuedAt) })).toThrow();
  });

  it('matches fresh semantics, not just installed versions, cached roots, or mode labels', () => {
    const receipt = makeReceipt();
    expect(matchUpdatePreviewReceipt(receipt, createUpdatePreviewDescriptor(input())).fingerprint).toBe(receipt.variants[0].fingerprint);
    for (const overrides of [
      { source: { changed: true } }, { target: { changed: true } }, { operations: [] },
      { projectRoot: '/another-worktree' }, { cliVersion: '0.11.2' }
    ]) {
      expect(() => matchUpdatePreviewReceipt(receipt, createUpdatePreviewDescriptor({ ...input(), ...overrides })))
        .toThrow(/liftoff update --check/u);
    }
  });
});

describe('native user-local preview locations', () => {
  it.each([
    { platform: 'linux', env: { XDG_STATE_HOME: '/state with spaces' }, homedir: '/home/person', expected: '/state with spaces/liftoff/update-previews' },
    { platform: 'linux', env: {}, homedir: '/home/person', expected: '/home/person/.local/state/liftoff/update-previews' },
    { platform: 'darwin', env: { XDG_STATE_HOME: 'ignored' }, homedir: '/Users/person', expected: '/Users/person/Library/Application Support/liftoff/update-previews' },
    { platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local Data' }, homedir: 'C:\\Users\\Person', expected: 'D:\\Local Data\\liftoff\\update-previews' },
    { platform: 'win32', env: {}, homedir: 'C:\\Users\\Person', expected: 'C:\\Users\\Person\\AppData\\Local\\liftoff\\update-previews' },
    { platform: 'win32', env: { LOCALAPPDATA: '\\\\server\\share\\user-state' }, homedir: 'C:\\Users\\Person', expected: '\\\\server\\share\\user-state\\liftoff\\update-previews' }
  ])('uses the native state location: $expected', ({ platform, env, homedir, expected }) => {
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') throw new Error('Invalid fixture platform.');
    expect(getUpdatePreviewDirectory({ platform, env, homedir })).toBe(expected);
  });

  it.each(['relative', './relative', '', 'C:\\non-native'])('rejects nonabsolute Linux overrides %j', (override) => {
    expect(() => getUpdatePreviewDirectory({ platform: 'linux', env: { XDG_STATE_HOME: override }, homedir: '/home/person' }))
      .toThrow(/absolute native/u);
  });

  it.each(['relative', 'C:relative', '\\rooted', '/rooted', '\\\\server', 'C:\\state.\\cache', 'C:\\state \\cache', 'C:\\NUL\\cache', 'C:\\state:alternate', '\\\\?\\C:\\state'])(
    'rejects ambiguous or unsafe Windows overrides %j', (override) => {
      expect(() => getUpdatePreviewDirectory({ platform: 'win32', env: { LOCALAPPDATA: override }, homedir: 'C:\\Users\\Person' }))
        .toThrow(/absolute|unsafe/u);
    }
  );

  it('requires an absolute fallback home and ignores telemetry config variables', () => {
    expect(() => getUpdatePreviewDirectory({ platform: 'linux', env: {}, homedir: 'relative' })).toThrow(/absolute/u);
    expect(getUpdatePreviewDirectory({
      platform: 'linux', env: { XDG_CONFIG_HOME: '/other', APPDATA: '/other' }, homedir: '/home/person'
    })).toBe('/home/person/.local/state/liftoff/update-previews');
  });

  it('cannot interpret simulated native paths through the real host filesystem', async () => {
    const platform = process.platform === 'win32' ? 'linux' : 'win32';
    await expect(resolveUpdatePreviewLocation('/never-read', { platform, env: {}, homedir: '/never-read' }))
      .rejects.toThrow(/requires an injected filesystem/u);
  });

  it.each(['linux', 'darwin', 'win32'])('persists and loads with an injected native %s filesystem', async (platform) => {
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') throw new Error('Invalid fixture platform.');
    const f = fixture(platform);
    const location = await resolveUpdatePreviewLocation(f.projectRoot, f.options);
    const descriptor = createUpdatePreviewDescriptor(input(location.projectRoot));
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options);
    expect(issued.location).toEqual(location);
    expect((await loadUpdatePreviewReceipt(f.projectRoot, f.options)).receipt).toEqual(issued.receipt);
    expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
    expect(f.fs.mutations().every((filePath) => !filePath.startsWith(f.repositoryRoot))).toBe(true);
  });

  it.each(['project', 'repository', 'repository-sibling'])('refuses storage inside the %s boundary before writes', async (boundary) => {
    const f = fixture();
    const state = boundary === 'project' ? f.projectRoot : boundary === 'repository'
      ? f.repositoryRoot : f.paths.join(f.repositoryRoot, 'sibling');
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], {
      ...f.options, env: { XDG_STATE_HOME: state }
    })).rejects.toThrow(/outside both/u);
    expect(f.fs.mutations()).toEqual([]);
  });

  it('discovers both ordinary Git directories and worktree marker files without invoking Git', async () => {
    for (const marker of ['file', 'directory']) {
      const f = fixture();
      if (marker === 'directory') f.fs.directory(f.paths.join(f.repositoryRoot, '.git'));
      await expect(resolveUpdatePreviewLocation(f.projectRoot, {
        ...f.options, repositoryRoot: undefined, env: { XDG_STATE_HOME: f.paths.join(f.repositoryRoot, 'state') }
      })).rejects.toThrow(/outside both/u);
      expect(f.fs.mutations()).toEqual([]);
    }
  });

  it('rejects a supplied repository that does not contain the project', async () => {
    const f = fixture();
    await expect(resolveUpdatePreviewLocation(f.projectRoot, { ...f.options, repositoryRoot: f.home }))
      .rejects.toThrow(/does not contain/u);
  });

  it('checks Windows containment without case or sibling-prefix bypasses', async () => {
    const f = fixture('win32');
    await expect(resolveUpdatePreviewLocation(f.projectRoot, {
      ...f.options, env: { LOCALAPPDATA: f.paths.join(f.repositoryRoot.toUpperCase(), 'state') }
    })).rejects.toThrow(/outside both/u);
    const location = await resolveUpdatePreviewLocation(f.projectRoot, {
      ...f.options, env: { LOCALAPPDATA: `${f.repositoryRoot}-separate` }
    });
    expect(location.directory.startsWith(`${f.repositoryRoot}-separate`)).toBe(true);
  });

  it('uses real Windows project spelling for equivalent aliases but different worktree keys', async () => {
    const f = fixture('win32');
    const first = await resolveUpdatePreviewLocation(f.projectRoot, f.options);
    const alias = await resolveUpdatePreviewLocation(f.projectRoot.toUpperCase(), f.options);
    expect(alias).toEqual(first);
    const otherRoot = f.paths.join(f.repositoryRoot, 'another worktree');
    f.fs.directory(otherRoot);
    const other = await resolveUpdatePreviewLocation(otherRoot, f.options);
    expect(other.projectKey).not.toBe(first.projectKey);
  });

  it('refuses a project boundary replaced during realpath resolution', async () => {
    const f = fixture();
    f.fs.onOperation = (operation, filePath) => {
      if (operation === 'realpath' && filePath === f.projectRoot) {
        f.fs.link(f.projectRoot, f.home);
      }
    };
    await expect(resolveUpdatePreviewLocation(f.projectRoot, f.options)).rejects.toThrow(/changed while resolving/u);
    expect(f.fs.mutations()).toEqual([]);
  });

  it('resolves safe native ancestor aliases and rejects aliases that enter the repository', async () => {
    const f = fixture();
    const alias = '/native-alias';
    f.fs.link(alias, f.root);
    const safe = await resolveUpdatePreviewLocation(f.projectRoot, {
      ...f.options, env: { XDG_STATE_HOME: `${alias}/state` }
    });
    expect(safe.directory).toBe('/fixture/state/liftoff/update-previews');
    await expect(resolveUpdatePreviewLocation(f.projectRoot, {
      ...f.options, env: { XDG_STATE_HOME: `${alias}/repos/example/state` }
    })).rejects.toThrow(/outside both/u);
    expect(f.fs.mutations()).toEqual([]);
  });

  it.each(['base', 'liftoff', 'update-previews', 'project'])('rejects a symlink or junction at the %s endpoint', async (endpoint) => {
    const f = fixture();
    f.fs.directory(f.state);
    f.fs.directory(f.paths.join(f.state, 'liftoff'), 0o700);
    const linkPath = endpoint === 'base' ? f.state : endpoint === 'project' ? f.projectRoot
      : f.paths.join(f.state, 'liftoff', ...endpoint === 'update-previews' ? ['update-previews'] : []);
    f.fs.link(linkPath, f.home);
    await expect(resolveUpdatePreviewLocation(f.projectRoot, f.options)).rejects.toThrow(/symlink|junction/u);
    expect(f.fs.mutations()).toEqual([]);
  });

  it.each(['file', 'other', 'world-readable'])('rejects unsafe existing directory state: %s', async (kind) => {
    const f = fixture();
    f.fs.directory(f.state);
    const liftoff = f.paths.join(f.state, 'liftoff');
    if (kind === 'file') f.fs.file(liftoff, 'not a directory');
    else if (kind === 'other') f.fs.other(liftoff);
    else f.fs.directory(liftoff, 0o755);
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options)).rejects.toThrow(/directory|permissions/u);
    expect(f.fs.mutations()).toEqual([]);
  });
});

describe('external preview persistence and replay guards', () => {
  it('reports missing receipts explicitly without creating metadata', async () => {
    const f = fixture();
    await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toMatchObject({ code: 'preview-missing' });
    expect(f.fs.mutations()).toEqual([]);
  });

  it('creates private directories/files and performs flushed same-directory atomic replacement', async () => {
    const f = fixture();
    const descriptor = createUpdatePreviewDescriptor(input());
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options);
    const content = f.fs.contents(issued.location.receiptPath);
    expect(content).not.toContain(sourceBody);
    expect(content).not.toContain(renderedBody);
    expect(f.fs.get(issued.location.receiptPath).mode).toBe(0o600);
    expect(f.fs.events.filter((event) => event.operation === 'mkdir').every((event) => event.mode === 0o700)).toBe(true);
    const exclusive = f.fs.events.filter((event) => event.operation === 'open-create');
    expect(exclusive.every((event) => event.mode === 0o600 && f.paths.dirname(event.path) === issued.location.directory)).toBe(true);
    const flush = f.fs.events.findIndex((event) => event.operation === 'sync' && event.path.endsWith('.tmp'));
    const rename = f.fs.events.findIndex((event) => event.operation === 'rename');
    expect(flush).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(flush);
    expect([...f.fs.entries.values()].filter((entry) => /\.tmp$|\.lock$/u.test(entry.path))).toEqual([]);
  });

  it('refreshes issuance without changing semantic fingerprints, then consumes only that exact issuance', async () => {
    const f = fixture();
    const descriptor = createUpdatePreviewDescriptor(input());
    const first = await issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options);
    const second = await issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options);
    expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
    expect(second.receipt.variants).toEqual(first.receipt.variants);
    await expect(consumeUpdatePreviewReceipt(f.projectRoot, first.receipt, f.options)).rejects.toMatchObject({ code: 'preview-mismatch' });
    expect((await loadUpdatePreviewReceipt(f.projectRoot, f.options)).receipt).toEqual(second.receipt);
    await consumeUpdatePreviewReceipt(f.projectRoot, second.receipt, f.options);
    await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toMatchObject({ code: 'preview-missing' });
    await expect(consumeUpdatePreviewReceipt(f.projectRoot, second.receipt, f.options)).rejects.toMatchObject({ code: 'preview-missing' });
    expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
  });

  it('rejects a receipt copied to another root or worktree even at the expected new filename', async () => {
    const f = fixture();
    const first = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    const copiedRoot = f.paths.join(f.repositoryRoot, 'copied project');
    f.fs.directory(copiedRoot);
    const target = await resolveUpdatePreviewLocation(copiedRoot, f.options);
    await expect(loadUpdatePreviewReceipt(copiedRoot, f.options)).rejects.toMatchObject({ code: 'preview-missing' });
    f.fs.file(target.receiptPath, f.fs.contents(first.location.receiptPath));
    await expect(loadUpdatePreviewReceipt(copiedRoot, f.options)).rejects.toMatchObject({ code: 'preview-mismatch' });
  });

  it.each(['{ malformed', 'null', '[]', '{"schemaVersion":2}', '{"schemaVersion":1}'])(
    'rejects malformed or unsupported receipt data without overwriting it (%s)', async (content) => {
      const f = fixture();
      const first = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
      f.fs.file(first.location.receiptPath, content);
      await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toThrow(/receipt|schema/u);
      await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options)).rejects.toThrow(/receipt|schema/u);
      expect(f.fs.contents(first.location.receiptPath)).toBe(content);
    }
  );

  it('rejects future issuance and clocks without silently treating corrupt receipts as missing', async () => {
    const f = fixture();
    const first = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    f.fs.file(first.location.receiptPath, JSON.stringify({ ...first.receipt, issuedAt: '2126-09-09T07:00:00.000Z' }));
    await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toMatchObject({ code: 'preview-invalid' });
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], {
      ...f.options, clock: () => new Date(NaN)
    })).rejects.toThrow(/clock/u);
  });

  it.each(['symlink', 'directory', 'other', 'hardlink', 'public', 'oversized'])(
    'rejects an unsafe receipt %s', async (kind) => {
      const f = fixture();
      const first = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
      if (kind === 'symlink') f.fs.link(first.location.receiptPath, f.paths.join(f.projectRoot, 'source.txt'));
      else if (kind === 'directory') f.fs.directory(first.location.receiptPath);
      else if (kind === 'other') f.fs.other(first.location.receiptPath);
      else if (kind === 'hardlink') f.fs.get(first.location.receiptPath).nlink = 2;
      else if (kind === 'public') f.fs.get(first.location.receiptPath).mode = 0o644;
      else f.fs.get(first.location.receiptPath).content = 'x'.repeat(65537);
      await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toThrow(/regular file|permissions|size limit/u);
      expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
    }
  );

  it('never creates storage for descriptors from a different project', async () => {
    const f = fixture();
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input('/different'))], f.options))
      .rejects.toMatchObject({ code: 'preview-mismatch' });
    expect(f.fs.mutations()).toEqual([]);
  });
});

describe('preview storage failure and concurrency handling', () => {
  it.each(['mkdir', 'lstat', 'realpath'])('surfaces %s failures rather than assuming paths are absent', async (operation) => {
    const f = fixture();
    f.fs.fail(operation, operation === 'mkdir' ? /state/u : /example/u, 'EACCES');
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options)).rejects.toThrow(/injected/u);
    expect(f.fs.mutations().filter((filePath) => /\.json$/u.test(filePath))).toEqual([]);
  });

  it.each(['open-create', 'fstat', 'chmod', 'write', 'sync', 'close', 'rename'])(
    'surfaces atomic %s failures and preserves the previous receipt', async (operation) => {
      const f = fixture();
      const first = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
      const original = f.fs.contents(first.location.receiptPath);
      f.fs.fail(operation, operation === 'rename' ? /\.json$/u : /\.tmp$/u);
      const changed = createUpdatePreviewDescriptor({ ...input(), source: { changed: true } });
      await expect(issueUpdatePreviewReceipt(f.projectRoot, [changed], f.options)).rejects.toThrow(/injected/u);
      expect(f.fs.contents(first.location.receiptPath)).toBe(original);
      expect([...f.fs.entries.values()].some((entry) => entry.path.endsWith('.lock'))).toBe(false);
      const temporaries = [...f.fs.entries.values()].filter((entry) => entry.path.endsWith('.tmp'));
      expect(temporaries.length).toBe(operation === 'fstat' ? 1 : 0);
    }
  );

  it('reports read and read-close failures explicitly without consuming the receipt', async () => {
    for (const operation of ['open-read', 'read', 'close']) {
      const f = fixture();
      const issued = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
      f.fs.fail(operation, /\.json$/u);
      await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toThrow(/injected/u);
      expect(f.fs.has(issued.location.receiptPath)).toBe(true);
    }
  });

  it('does not mistake a temporary-path collision for a held project receipt lock', async () => {
    const f = fixture();
    f.fs.fail('open-create', /\.tmp$/u, 'EEXIST');
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options))
      .rejects.toMatchObject({ code: 'preview-storage' });
    expect([...f.fs.entries.values()].some((entry) => entry.path.endsWith('.lock'))).toBe(false);
  });

  it('reports failed exact-entry consumption and leaves the receipt and project intact', async () => {
    const f = fixture();
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    f.fs.fail('unlink', /\.json$/u);
    await expect(consumeUpdatePreviewReceipt(f.projectRoot, issued.receipt, f.options)).rejects.toThrow(/consume receipt/u);
    expect((await loadUpdatePreviewReceipt(f.projectRoot, f.options)).receipt).toEqual(issued.receipt);
    expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
  });

  it('reports temporary cleanup failures without deleting unrelated files', async () => {
    const f = fixture();
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    const neighbor = f.paths.join(issued.location.directory, 'unrelated.tmp');
    f.fs.file(neighbor, 'preserve');
    f.fs.fail('rename', /\.json$/u);
    f.fs.fail('unlink', /\.tmp$/u);
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options))
      .rejects.toThrow(/Cleanup also failed/u);
    expect(f.fs.contents(neighbor)).toBe('preserve');
    expect((await loadUpdatePreviewReceipt(f.projectRoot, f.options)).receipt).toEqual(issued.receipt);
  });

  it('preserves replaced temporaries instead of cleaning another writer’s file', async () => {
    const f = fixture();
    let replaced = '';
    f.fs.onOperation = (operation, filePath) => {
      if (operation === 'sync' && filePath.endsWith('.tmp')) {
        replaced = filePath;
        f.fs.file(filePath, 'concurrent writer content');
      }
    };
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options))
      .rejects.toThrow(/replacement preserved/u);
    expect(f.fs.contents(replaced)).toBe('concurrent writer content');
  });

  it('refuses state directory substitution before writing receipt bytes', async () => {
    const f = fixture();
    let changed = false;
    f.fs.onOperation = (operation) => {
      if (operation === 'chmod' && !changed) {
        changed = true;
        f.fs.link(f.paths.join(f.state, 'liftoff', 'update-previews'), f.projectRoot);
      }
    };
    await expect(issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options))
      .rejects.toThrow(/directory changed/u);
    expect(f.fs.events.some((event) => event.operation === 'write')).toBe(false);
    expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
  });

  it('detects a file changed during read and does not return a successful match', async () => {
    const f = fixture();
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    f.fs.onOperation = (operation, filePath) => {
      if (operation === 'read' && filePath === issued.location.receiptPath) {
        f.fs.get(filePath).modified += 1;
      }
    };
    await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toThrow(/changed while reading/u);
  });

  it('refuses an existing cooperating lock and never removes it', async () => {
    const f = fixture();
    const issued = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    const lock = f.paths.join(issued.location.directory, `${issued.location.projectKey}.lock`);
    f.fs.file(lock, 'another writer');
    await expect(consumeUpdatePreviewReceipt(f.projectRoot, issued.receipt, f.options)).rejects.toMatchObject({ code: 'preview-busy' });
    expect(f.fs.contents(lock)).toBe('another writer');
    expect(f.fs.has(issued.location.receiptPath)).toBe(true);
  });

  it('serializes concurrent receipt issuance without publishing partial data', async () => {
    const f = fixture();
    const descriptor = createUpdatePreviewDescriptor(input());
    const results = await Promise.allSettled([
      issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options),
      issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options)
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const loaded = await loadUpdatePreviewReceipt(f.projectRoot, f.options);
    expect(matchUpdatePreviewReceipt(loaded.receipt, descriptor)).toEqual(descriptor);
    expect([...f.fs.entries.values()].some((entry) => /\.tmp$|\.lock$/u.test(entry.path))).toBe(false);
  });
});

describe('separate user-local transaction approval seals', () => {
  const planFingerprint = createUpdatePreviewDescriptor(input()).fingerprint;
  const transactionDigest = 'a'.repeat(64);
  const checkpointDigest = 'b'.repeat(64);
  const commitDigest = 'c'.repeat(64);
  const differentPlan = 'd'.repeat(64);

  function sealPath(f: ReturnType<typeof fixture>, digest = transactionDigest, fingerprint = planFingerprint): string {
    return f.paths.join(getUpdatePreviewDirectory(f.options), `approval-${updateTransactionApprovalKey({
      projectRoot: f.projectRoot, planFingerprint: fingerprint, transactionDigest: digest
    })}.json`);
  }

  it('does not create an approval when checking, loading, matching, or consuming a preview', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    expect(f.fs.events).toEqual([]);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);
    expect(f.fs.mutations()).toEqual([]);
    const descriptor = createUpdatePreviewDescriptor(input());
    const preview = await issueUpdatePreviewReceipt(f.projectRoot, [descriptor], f.options);
    const loaded = await loadUpdatePreviewReceipt(f.projectRoot, f.options);
    matchUpdatePreviewReceipt(loaded.receipt, descriptor);
    await consumeUpdatePreviewReceipt(f.projectRoot, preview.receipt, f.options);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);
    expect([...f.fs.entries.values()].some((entry) => f.paths.basename(entry.path).startsWith('approval-'))).toBe(false);
  });

  it('writes only a separate schema-1 digest-bound seal after an explicit call', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, {
      ...f.options, env: { ...f.options.env, SECRET_TOKEN: sourceBody }
    });
    await store.write(planFingerprint, transactionDigest);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
    const filePath = sealPath(f);
    const content = f.fs.contents(filePath);
    const value: unknown = JSON.parse(content);
    const seal = validateUpdateTransactionApprovalSeal(value, {
      projectRoot: f.projectRoot, planFingerprint, transactionDigest
    }, new Date(issuedAt));
    expect(seal).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-update-transaction-approval',
      projectRoot: f.projectRoot, planFingerprint, transactionDigest, approvedAt: issuedAt
    });
    expect(f.fs.get(filePath).mode).toBe(0o600);
    for (const forbidden of [sourceBody, renderedBody, 'SECRET_TOKEN', 'mutations', 'variants', 'original', 'target']) {
      expect(content).not.toContain(forbidden);
    }
    expect(f.fs.mutations().every((file) => !file.startsWith(f.repositoryRoot))).toBe(true);
    await expect(loadUpdatePreviewReceipt(f.projectRoot, f.options)).rejects.toMatchObject({ code: 'preview-missing' });
  });

  it('verifies read-only and rejects unsealed project-journal claims and different exact bindings', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    f.fs.file(f.paths.join(f.projectRoot, 'journal.json'), JSON.stringify({ approved: true, planFingerprint, transactionDigest }));
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);
    expect(f.fs.mutations()).toEqual([]);
    await store.write(planFingerprint, transactionDigest);
    f.fs.events.length = 0;
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
    expect(await store.verify(planFingerprint, checkpointDigest)).toBe(false);
    expect(await store.verify(differentPlan, transactionDigest)).toBe(false);
    expect(f.fs.mutations()).toEqual([]);
  });

  it('keeps independent transaction, checkpoint, and commit bindings and removes only the exact entry', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    const preview = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    for (const digest of [transactionDigest, checkpointDigest, commitDigest]) await store.write(planFingerprint, digest);
    await store.write(differentPlan, transactionDigest);
    await store.remove(planFingerprint, checkpointDigest);
    expect(await store.verify(planFingerprint, checkpointDigest)).toBe(false);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
    expect(await store.verify(planFingerprint, commitDigest)).toBe(true);
    expect(await store.verify(differentPlan, transactionDigest)).toBe(true);
    expect((await loadUpdatePreviewReceipt(f.projectRoot, f.options)).receipt).toEqual(preview.receipt);
    await store.remove(planFingerprint, checkpointDigest);
    expect(await store.verify(planFingerprint, commitDigest)).toBe(true);
  });

  it('idempotently preserves original approval metadata instead of reissuing it', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    const original = f.fs.contents(sealPath(f));
    const later = createUpdateTransactionApprovalStore(f.projectRoot, {
      ...f.options, clock: () => new Date('2026-10-01T00:00:00.000Z')
    });
    await later.write(planFingerprint, transactionDigest);
    expect(f.fs.contents(sealPath(f))).toBe(original);
    expect(await later.verify(planFingerprint, transactionDigest)).toBe(true);
    const preview = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    await consumeUpdatePreviewReceipt(f.projectRoot, preview.receipt, f.options);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
  });

  it('does not confuse a schema-1 preview receipt with a schema-1 transaction approval', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    const preview = await issueUpdatePreviewReceipt(f.projectRoot, [createUpdatePreviewDescriptor(input())], f.options);
    const content = f.fs.contents(preview.location.receiptPath);
    f.fs.file(sealPath(f), content);
    await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow(/approval seal/u);
    await expect(store.write(planFingerprint, transactionDigest)).rejects.toThrow(/approval seal/u);
    await expect(store.remove(planFingerprint, transactionDigest)).rejects.toThrow(/approval seal/u);
    expect(f.fs.contents(sealPath(f))).toBe(content);
  });

  it.each(['malformed', 'future-schema', 'future-time', 'extra-data', 'different-plan', 'different-digest', 'wrong-project'])(
    'rejects and preserves a %s seal rather than treating it as missing or approved', async (corruption) => {
      const f = fixture();
      const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
      const good = createUpdateTransactionApprovalSeal({
        projectRoot: f.projectRoot, planFingerprint, transactionDigest
      }, { approvedAt: issuedAt, approvalId: receiptId });
      let value: unknown = good;
      if (corruption === 'future-schema') value = { ...good, schemaVersion: 2 };
      if (corruption === 'future-time') value = { ...good, approvedAt: '2126-09-09T07:00:00.000Z' };
      if (corruption === 'extra-data') value = { ...good, mutations: [sourceBody] };
      if (corruption === 'different-plan') value = { ...good, planFingerprint: differentPlan };
      if (corruption === 'different-digest') value = { ...good, transactionDigest: checkpointDigest };
      if (corruption === 'wrong-project') value = { ...good, projectRoot: '/different' };
      const directory = getUpdatePreviewDirectory(f.options);
      f.fs.directory(f.paths.dirname(directory), 0o700);
      f.fs.directory(directory, 0o700);
      const content = corruption === 'malformed' ? '{ broken' : JSON.stringify(value);
      f.fs.file(sealPath(f), content);
      await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow();
      await expect(store.write(planFingerprint, transactionDigest)).rejects.toThrow();
      await expect(store.remove(planFingerprint, transactionDigest)).rejects.toThrow();
      expect(f.fs.contents(sealPath(f))).toBe(content);
    }
  );

  it('does not verify a seal copied into a different project or worktree key', async () => {
    const f = fixture();
    const source = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await source.write(planFingerprint, transactionDigest);
    const copiedRoot = f.paths.join(f.repositoryRoot, 'copied-worktree');
    f.fs.directory(copiedRoot);
    const copied = createUpdateTransactionApprovalStore(copiedRoot, f.options);
    expect(await copied.verify(planFingerprint, transactionDigest)).toBe(false);
    const destination = f.paths.join(getUpdatePreviewDirectory(f.options), `approval-${updateTransactionApprovalKey({
      projectRoot: copiedRoot, planFingerprint, transactionDigest
    })}.json`);
    f.fs.file(destination, f.fs.contents(sealPath(f)));
    await expect(copied.verify(planFingerprint, transactionDigest)).rejects.toThrow(/does not match/u);
  });

  it.each(['linux', 'darwin', 'win32'])('applies the same isolated native storage guarantees to %s seals', async (platform) => {
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') throw new Error('Invalid fixture platform.');
    const f = fixture(platform);
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
    expect(f.fs.has(sealPath(f))).toBe(true);
    expect(f.fs.mutations().every((file) => !file.startsWith(f.repositoryRoot))).toBe(true);
    await store.remove(planFingerprint, transactionDigest);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);
  });

  it('rejects relative and project-contained seal storage without writing', async () => {
    for (const state of ['relative', '/fixture/repos/example/state']) {
      const f = fixture();
      const store = createUpdateTransactionApprovalStore(f.projectRoot, { ...f.options, env: { XDG_STATE_HOME: state } });
      await expect(store.write(planFingerprint, transactionDigest)).rejects.toThrow(/absolute|outside both/u);
      await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow(/absolute|outside both/u);
      expect(f.fs.mutations()).toEqual([]);
    }
  });

  it.each(['symlink', 'hardlink', 'directory', 'public'])('rejects unsafe %s seal files', async (kind) => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    const filePath = sealPath(f);
    if (kind === 'symlink') f.fs.link(filePath, f.paths.join(f.projectRoot, 'source.txt'));
    else if (kind === 'hardlink') f.fs.get(filePath).nlink = 2;
    else if (kind === 'directory') f.fs.directory(filePath);
    else f.fs.get(filePath).mode = 0o644;
    await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow(/regular file|permissions/u);
    await expect(store.remove(planFingerprint, transactionDigest)).rejects.toThrow(/regular file|permissions/u);
    expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
  });

  it('rejects abbreviated, uppercase, and path-shaped digest arguments before filesystem access', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    for (const value of ['a'.repeat(12), 'A'.repeat(64), '../seal.json', `sha256:${transactionDigest}`]) {
      await expect(store.write(value, transactionDigest)).rejects.toThrow(/complete lowercase/u);
      await expect(store.verify(planFingerprint, value)).rejects.toThrow(/complete lowercase/u);
      await expect(store.remove(value, transactionDigest)).rejects.toThrow(/complete lowercase/u);
    }
    expect(f.fs.events).toEqual([]);
  });

  it('pins configuration and refuses canonical directory retargeting for an existing factory', async () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: f.state };
    const store = createUpdateTransactionApprovalStore(f.projectRoot, { ...f.options, env });
    await store.write(planFingerprint, transactionDigest);
    env.XDG_STATE_HOME = f.projectRoot;
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
    const alias = '/state-alias';
    f.fs.link(alias, f.root);
    const throughAlias = createUpdateTransactionApprovalStore(f.projectRoot, {
      ...f.options, env: { XDG_STATE_HOME: `${alias}/state` }
    });
    expect(await throughAlias.verify(planFingerprint, transactionDigest)).toBe(true);
    const other = '/other-user-state';
    f.fs.directory(other);
    f.fs.link(alias, other);
    await expect(throughAlias.verify(planFingerprint, transactionDigest)).rejects.toThrow(/boundary changed/u);
  });

  it('flushes seal creation and deletion before reporting success', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    const rename = f.fs.events.findIndex((event) => event.operation === 'rename');
    expect(f.fs.events.slice(rename + 1).some((event) =>
      event.operation === 'sync-directory' && event.path === getUpdatePreviewDirectory(f.options)
    )).toBe(true);
    expect(f.fs.events[f.fs.events.length - 1]).toMatchObject({
      operation: 'sync-directory', path: getUpdatePreviewDirectory(f.options)
    });
    f.fs.events.length = 0;
    await store.remove(planFingerprint, transactionDigest);
    const remove = f.fs.events.findIndex((event) => event.operation === 'unlink' && event.path === sealPath(f));
    expect(f.fs.events.slice(remove + 1).some((event) =>
      event.operation === 'sync-directory' && event.path === getUpdatePreviewDirectory(f.options)
    )).toBe(true);
    expect(f.fs.events[f.fs.events.length - 1]).toMatchObject({
      operation: 'sync-directory', path: getUpdatePreviewDirectory(f.options)
    });
  });

  it.each(['write', 'sync', 'rename'])('surfaces atomic seal %s failures without issuing the new binding', async (operation) => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    f.fs.fail(operation, operation === 'rename' ? /approval-.*\.json$/u : /\.tmp$/u);
    await expect(store.write(planFingerprint, checkpointDigest)).rejects.toThrow(/injected/u);
    expect(await store.verify(planFingerprint, checkpointDigest)).toBe(false);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
  });

  it('surfaces directory flush failures and can explicitly retry the same already-written seal', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    f.fs.fail('sync-directory', /update-previews$/u);
    await expect(store.write(planFingerprint, checkpointDigest)).rejects.toThrow(/flush approval seal directory/u);
    const original = f.fs.contents(sealPath(f, checkpointDigest));
    await store.write(planFingerprint, checkpointDigest);
    expect(f.fs.contents(sealPath(f, checkpointDigest))).toBe(original);
    expect(await store.verify(planFingerprint, checkpointDigest)).toBe(true);
  });

  it('does not hide directory flush or unlink failures while removing a seal', async () => {
    for (const operation of ['sync-directory', 'unlink']) {
      const f = fixture();
      const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
      await store.write(planFingerprint, transactionDigest);
      f.fs.fail(operation, operation === 'unlink' ? /approval-.*\.json$/u : /update-previews$/u);
      await expect(store.remove(planFingerprint, transactionDigest)).rejects.toThrow(/injected/u);
      expect(await store.verify(planFingerprint, transactionDigest)).toBe(operation === 'unlink');
      expect(f.fs.contents(f.paths.join(f.projectRoot, 'source.txt'))).toBe(sourceBody);
    }
  });

  it('returns false only for confirmed missing records, not filesystem read failures', async () => {
    const f = fixture();
    const store = createUpdateTransactionApprovalStore(f.projectRoot, f.options);
    await store.write(planFingerprint, transactionDigest);
    f.fs.fail('lstat', /approval-.*\.json$/u, 'EACCES');
    await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow(/injected/u);
    f.fs.fail('read', /approval-.*\.json$/u, 'EIO');
    await expect(store.verify(planFingerprint, transactionDigest)).rejects.toThrow(/injected/u);
    expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);
  });
});
