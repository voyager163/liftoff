import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createUpdatePreviewReceipt,
  normalizeUpdatePreviewProjectRoot,
  updatePreviewDirectoryParts,
  updatePreviewProjectKey,
  UpdatePreviewError,
  validateUpdatePreviewReceipt
} from '../../application/update/preview.js';
import type { UpdatePreviewDescriptor, UpdatePreviewReceipt } from '../../application/update/preview.js';
import {
  createUpdateTransactionApprovalSeal,
  updateTransactionApprovalKey,
  UpdateTransactionApprovalError,
  validateUpdateTransactionApprovalDigests,
  validateUpdateTransactionApprovalSeal
} from '../../application/update/transaction-approval.js';
import type {
  UpdateTransactionApprovalBinding,
  UpdateTransactionApprovalSeal,
  UpdateTransactionApprovalStore
} from '../../application/update/transaction-approval.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import type { SkillScope } from '../../domain/skills/contracts.js';
import { errorCode, errorMessage } from './errors.js';

export type { UpdateTransactionApprovalStore } from '../../application/update/transaction-approval.js';

export type UpdatePreviewFileStat = Pick<
  Stats, 'dev' | 'ino' | 'mode' | 'nlink' | 'size' | 'mtimeMs' | 'ctimeMs' |
  'isDirectory' | 'isFile' | 'isSymbolicLink'
> & Partial<Pick<Stats, 'birthtimeMs' | 'uid'>>;

export interface UpdatePreviewFileHandle {
  stat(): Promise<UpdatePreviewFileStat>;
  readText(maximumBytes: number): Promise<string>;
  readBytes?(maximumBytes: number): Promise<Uint8Array>;
  writeText(content: string): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdatePreviewDirectoryHandle {
  stat(): Promise<UpdatePreviewFileStat>;
  readName(): Promise<string | null>;
  close(): Promise<void>;
}

export interface UpdatePreviewFileSystem {
  lstat(filePath: string): Promise<UpdatePreviewFileStat>;
  realpath(filePath: string): Promise<string>;
  makeDirectory(directoryPath: string, mode: number): Promise<void>;
  openFile(filePath: string, access: 'read' | 'create-exclusive', mode: number): Promise<UpdatePreviewFileHandle>;
  replaceFile(sourcePath: string, targetPath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  syncDirectory(directoryPath: string): Promise<void>;
  /** Optional complete name iterator; metadata enumeration refuses an unsupported filesystem. */
  openDirectory?(directoryPath: string): Promise<UpdatePreviewDirectoryHandle>;
}

export interface UpdatePreviewPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  repositoryRoot?: string;
}

export interface UpdatePreviewOptions extends UpdatePreviewPathOptions {
  fileSystem?: UpdatePreviewFileSystem;
  clock?: () => Date;
}

export interface UpdatePreviewLocation {
  readonly projectRoot: string;
  readonly projectKey: string;
  readonly repositoryRoot?: string;
  readonly directory: string;
  readonly receiptPath: string;
}

export interface StoredUpdatePreview {
  readonly location: UpdatePreviewLocation;
  readonly receipt: UpdatePreviewReceipt;
}

export const nodeUpdatePreviewFileSystem: UpdatePreviewFileSystem = {
  lstat,
  realpath,
  makeDirectory: async (directoryPath, mode) => { await mkdir(directoryPath, { mode }); },
  openFile: async (filePath, access, mode) => {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    if (access === 'read' && process.platform !== 'win32' && constants.O_NONBLOCK === undefined) {
      throw storageError('Nonblocking private file reads are unsupported on this native filesystem.');
    }
    const flags = access === 'read'
      ? constants.O_RDONLY | noFollow | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
    const handle = await open(filePath, flags, mode);
    const readBytes = async (maximumBytes: number): Promise<Uint8Array> => {
      const bytes = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      try {
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > maximumBytes) throw new Error('Preview receipt exceeds its size limit.');
        return bytes.subarray(0, length);
      } catch (error) { bytes.fill(0); throw error; }
    };
    return {
      stat: () => handle.stat(),
      readText: async (maximumBytes) => {
        const bytes = await readBytes(maximumBytes);
        try { return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'); }
        finally { bytes.fill(0); }
      },
      readBytes,
      writeText: (content) => handle.writeFile(content, 'utf8'),
      chmod: (mode) => handle.chmod(mode),
      sync: () => handle.sync(),
      close: () => handle.close()
    };
  },
  replaceFile: rename,
  removeFile: unlink,
  syncDirectory: async (directoryPath) => {
    try {
      const handle = await open(directoryPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      await withCleanup(async () => {
        if (!(await handle.stat()).isDirectory()) throw new Error('Only a regular directory can be flushed.');
        await handle.sync();
      }, () => handle.close());
    } catch (error) {
      // Node does not support flushing directory handles on every Windows filesystem.
      if (process.platform !== 'win32' ||
          !['EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error) ?? '')) throw error;
    }
  },
  openDirectory: async (directoryPath) => {
    if (process.platform === 'win32' || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined ||
      constants.O_NONBLOCK === undefined) throw storageError('Descriptor-bound private metadata enumeration is unsupported on this native filesystem.');
    const handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let directory: Awaited<ReturnType<typeof opendir>> | null = null;
    try {
      const before = await handle.stat();
      if (!before.isDirectory()) throw storageError('Private metadata enumeration requires a directory.');
      directory = await opendir(directoryPath, { bufferSize: 1 });
      const current = await lstat(directoryPath), opened = await handle.stat();
      if (!sameMetadataStamp(before, current) || !sameMetadataStamp(before, opened) ||
        await realpath(directoryPath) !== directoryPath) {
        throw storageError('Private metadata directory changed while opening its name iterator.');
      }
      const names = directory;
      return {
        stat: () => handle.stat(),
        readName: async () => (await names.read())?.name ?? null,
        close: () => withCleanup(() => names.close(), () => handle.close())
      };
    } catch (error) {
      await withCleanup(async () => { if (directory) await directory.close(); }, () => handle.close());
      throw error;
    }
  }
};

type NativePath = typeof path.posix;
type DirectorySnapshot = ReadonlyMap<string, UpdatePreviewFileStat>;

interface Storage {
  location: UpdatePreviewLocation;
  fs: UpdatePreviewFileSystem;
  paths: NativePath;
  platform: NodeJS.Platform;
  now: () => Date;
}

const maximumReceiptBytes = 64 * 1024;

function storageError(message: string, cause?: unknown): UpdatePreviewError {
  return new UpdatePreviewError('preview-storage', message, { cause });
}

async function io<T>(operation: string, filePath: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof UpdatePreviewError) throw error;
    throw storageError(`Unable to ${operation} preview storage at ${filePath}: ${errorMessage(error)}`, error);
  }
}

function nativePaths(platform: NodeJS.Platform): NativePath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function absoluteNativePath(value: string, paths: NativePath, label: string, fromRealpath = false): string {
  let candidate = value;
  if (fromRealpath && paths === path.win32) {
    if (candidate.startsWith('\\\\?\\UNC\\')) candidate = `\\\\${candidate.slice(8)}`;
    else if (/^\\\\\?\\[a-z]:\\/iu.test(candidate)) candidate = candidate.slice(4);
  }
  if (!candidate || /[\u0000-\u001f]/u.test(candidate) || !paths.isAbsolute(candidate)) {
    throw storageError(`${label} must be an absolute native path.`);
  }
  const normalized = paths.normalize(candidate);
  const root = paths.parse(normalized).root;
  if (paths === path.win32) {
    if (!/^[a-z]:\\$/iu.test(root) && !/^\\\\[^\\]+\\[^\\]+\\$/u.test(root)) {
      throw storageError(`${label} must include an absolute Windows drive or UNC share.`);
    }
    const parts = normalized.slice(/^[a-z]:\\/iu.test(normalized) ? 3 : 2).split('\\').filter(Boolean);
    if (parts.some((part) => /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
      throw storageError(`${label} contains an unsafe Windows path component.`);
    }
  }
  return normalized === root ? root : normalized.endsWith(paths.sep) ? normalized.slice(0, -1) : normalized;
}

function stateBase(options: UpdatePreviewPathOptions): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = nativePaths(platform);
  if (platform === 'linux' && env.XDG_STATE_HOME !== undefined) {
    return absoluteNativePath(env.XDG_STATE_HOME, paths, 'XDG_STATE_HOME');
  }
  if (platform === 'win32' && env.LOCALAPPDATA !== undefined) {
    return absoluteNativePath(env.LOCALAPPDATA, paths, 'LOCALAPPDATA');
  }
  const home = absoluteNativePath(options.homedir ?? os.homedir(), paths, 'Home directory');
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return paths.join(home, 'AppData', 'Local');
  if (platform === 'linux') return paths.join(home, '.local', 'state');
  throw storageError(`Update preview storage does not support platform ${platform}.`);
}

export function getUpdatePreviewDirectory(options: UpdatePreviewPathOptions = {}): string {
  return nativePaths(options.platform ?? process.platform).join(stateBase(options), ...updatePreviewDirectoryParts);
}

function comparable(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value;
}

function within(root: string, candidate: string, paths: NativePath, platform: NodeJS.Platform): boolean {
  const relative = paths.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

function rejectContainedStore(directory: string, boundaries: readonly string[], paths: NativePath, platform: NodeJS.Platform): void {
  if (boundaries.some((boundary) => within(boundary, directory, paths, platform))) {
    throw storageError(`Preview storage must be outside both the project and its containing repository: ${directory}`);
  }
}

async function inspect(fs: UpdatePreviewFileSystem, filePath: string): Promise<UpdatePreviewFileStat | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw storageError(`Unable to inspect preview storage path ${filePath}: ${errorMessage(error)}`, error);
  }
}

function regularDirectory(details: UpdatePreviewFileStat, filePath: string): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw storageError(`Preview path must be a regular directory, not a symlink, junction, or other path type: ${filePath}`);
  }
}

async function canonicalDirectory(fs: UpdatePreviewFileSystem, paths: NativePath, directory: string): Promise<string> {
  const details = await inspect(fs, directory);
  if (!details) throw storageError(`Project or repository directory is missing: ${directory}`);
  regularDirectory(details, directory);
  const resolved = absoluteNativePath(
    await io('resolve', directory, () => fs.realpath(directory)), paths, 'Canonical directory', true
  );
  const current = await inspect(fs, directory);
  const canonical = await inspect(fs, resolved);
  if (!current || !canonical || !sameFile(details, current) || !sameFile(details, canonical)) {
    throw storageError(`Project or repository directory changed while resolving: ${directory}`);
  }
  regularDirectory(current, directory);
  regularDirectory(canonical, resolved);
  return resolved;
}

async function discoverRepository(fs: UpdatePreviewFileSystem, paths: NativePath, root: string): Promise<string | undefined> {
  let candidate = root;
  while (true) {
    const marker = paths.join(candidate, '.git');
    const details = await inspect(fs, marker);
    if (details) {
      if (details.isSymbolicLink() || !details.isDirectory() && !details.isFile()) {
        throw storageError(`Repository marker has an unsafe path type: ${marker}`);
      }
      return candidate;
    }
    const parent = paths.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function canonicalStateBase(fs: UpdatePreviewFileSystem, paths: NativePath, base: string): Promise<string> {
  let existing = base;
  const missing: string[] = [];
  while (true) {
    const details = await inspect(fs, existing);
    if (details) {
      if (existing === base || !details.isSymbolicLink()) regularDirectory(details, existing);
      // Native ancestor aliases (for example macOS /var) are resolved before using the private subtree.
      const real = absoluteNativePath(await io('resolve', existing, () => fs.realpath(existing)), paths, 'Canonical state base', true);
      const realDetails = await inspect(fs, real);
      if (!realDetails) throw storageError(`Canonical state ancestor disappeared: ${real}`);
      regularDirectory(realDetails, real);
      return paths.join(real, ...missing);
    }
    const parent = paths.dirname(existing);
    if (parent === existing) throw storageError(`No existing native ancestor for preview state base: ${base}`);
    missing.unshift(paths.basename(existing));
    existing = parent;
  }
}

async function installationStorageFor(targetRoot: string, options: UpdatePreviewOptions): Promise<Storage> {
  const home = options.homedir ?? os.homedir();
  const storage = await storageFor(home, options, true);
  const requested = absoluteNativePath(targetRoot, storage.paths, 'Installation transaction root');
  const canonical = await canonicalDirectory(storage.fs, storage.paths, requested);
  if (requested !== canonical || within(storage.location.directory, canonical, storage.paths, storage.platform)) {
    throw storageError('Installation authority requires an exact canonical target outside its private approval store.');
  }
  const projectKey = updatePreviewProjectKey(canonical);
  return {
    ...storage,
    location: Object.freeze({
      ...storage.location, projectRoot: canonical, projectKey,
      receiptPath: storage.paths.join(storage.location.directory, `${projectKey}.json`)
    })
  };
}

async function storageFor(projectRoot: string, options: UpdatePreviewOptions, userSkillScope = false): Promise<Storage> {
  const fs = options.fileSystem ?? nodeUpdatePreviewFileSystem;
  const platform = options.platform ?? process.platform;
  if (platform !== process.platform && fs === nodeUpdatePreviewFileSystem) {
    throw storageError('A non-native preview platform requires an injected filesystem.');
  }
  const paths = nativePaths(platform);
  const requestedRoot = absoluteNativePath(projectRoot, paths, 'Project root');
  const root = normalizeUpdatePreviewProjectRoot(await canonicalDirectory(fs, paths, requestedRoot));
  const requestedRepository = userSkillScope || options.repositoryRoot === undefined
    ? undefined : absoluteNativePath(options.repositoryRoot, paths, 'Repository root');
  const repositoryRoot = requestedRepository === undefined
    ? userSkillScope ? undefined : await discoverRepository(fs, paths, root)
    : await canonicalDirectory(fs, paths, requestedRepository);
  if (repositoryRoot !== undefined && !within(repositoryRoot, root, paths, platform)) {
    throw storageError(`The supplied repository does not contain the project: ${repositoryRoot}`);
  }
  if (userSkillScope) {
    const home = absoluteNativePath(options.homedir ?? os.homedir(), paths, 'Skills user home');
    if (await canonicalDirectory(fs, paths, home) !== root || requestedRoot !== root) {
      throw storageError('User-scope skills approval must bind the independently selected canonical user home.');
    }
  }
  const boundaries = userSkillScope
    ? ['.agents', '.claude', '.github', '.liftoff'].map((part) => paths.join(root, part))
    : [requestedRoot, root, ...repositoryRoot ? [repositoryRoot] : [], ...requestedRepository ? [requestedRepository] : []];
  const base = stateBase(options);
  rejectContainedStore(paths.join(base, ...updatePreviewDirectoryParts), boundaries, paths, platform);
  const canonicalBase = await canonicalStateBase(fs, paths, base);
  if (userSkillScope && (canonicalBase !== base || !within(root, canonicalBase, paths, platform))) {
    throw storageError('User-scope skills private state must remain in its canonical home boundary without linked or redirected ancestors.');
  }
  const directory = paths.join(canonicalBase, ...updatePreviewDirectoryParts);
  if (userSkillScope && comparable(directory, platform) === comparable(root, platform)) {
    throw storageError('Skills approval storage cannot be the user target directory itself.');
  }
  rejectContainedStore(directory, boundaries, paths, platform);
  const projectKey = updatePreviewProjectKey(root);
  return {
    location: Object.freeze({
      projectRoot: root,
      projectKey,
      ...repositoryRoot === undefined ? {} : { repositoryRoot },
      directory,
      receiptPath: paths.join(directory, `${projectKey}.json`)
    }),
    fs,
    paths,
    platform,
    now: options.clock ?? (() => new Date())
  };
}

function sameFile(left: UpdatePreviewFileStat, right: UpdatePreviewFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertDirectories(storage: Storage, snapshot: DirectorySnapshot): Promise<void> {
  const privateRoot = storage.paths.dirname(storage.location.directory);
  for (const [directory, before] of snapshot) {
    const current = await inspect(storage.fs, directory);
    if (!current || current.isSymbolicLink() || !current.isDirectory() || !sameFile(before, current)) {
      throw storageError(`Preview storage directory changed during the operation: ${directory}`);
    }
    if (storage.platform !== 'win32' && within(privateRoot, directory, storage.paths, storage.platform) &&
        (current.mode & 0o077) !== 0) {
      throw storageError(`Preview directory permissions changed during the operation: ${directory}`);
    }
  }
}

async function directories(storage: Storage, create: boolean): Promise<DirectorySnapshot | undefined> {
  const chain: string[] = [];
  let candidate = storage.location.directory;
  while (true) {
    chain.unshift(candidate);
    const parent = storage.paths.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const snapshot = new Map<string, UpdatePreviewFileStat>();
  const privateRoot = storage.paths.dirname(storage.location.directory);
  for (const directory of chain) {
    let details = await inspect(storage.fs, directory);
    if (!details) {
      if (!create) return undefined;
      await assertDirectories(storage, snapshot);
      try {
        await storage.fs.makeDirectory(directory, 0o700);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw storageError(`Unable to create preview directory ${directory}: ${errorMessage(error)}`, error);
        }
      }
      details = await inspect(storage.fs, directory);
      if (!details) throw storageError(`Created preview directory is missing: ${directory}`);
      await assertDirectories(storage, snapshot);
      const parent = storage.paths.dirname(directory);
      await io('flush created state directory parent', parent, () => storage.fs.syncDirectory(parent));
    }
    regularDirectory(details, directory);
    if (storage.platform !== 'win32' && within(privateRoot, directory, storage.paths, storage.platform) &&
        (details.mode & 0o077) !== 0) {
      throw storageError(`Preview directories require private permissions (0700): ${directory}`);
    }
    const real = absoluteNativePath(
      await io('resolve', directory, () => storage.fs.realpath(directory)), storage.paths, 'Preview directory', true
    );
    if (comparable(real, storage.platform) !== comparable(directory, storage.platform)) {
      throw storageError(`Preview directory resolves through an unsafe alias: ${directory}`);
    }
    snapshot.set(directory, details);
  }
  return snapshot;
}

export async function resolveUpdatePreviewLocation(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
): Promise<UpdatePreviewLocation> {
  const storage = await storageFor(projectRoot, options);
  await directories(storage, false);
  return storage.location;
}

function privateFile(storage: Storage, details: UpdatePreviewFileStat, filePath: string): void {
  if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
    throw storageError(`Preview storage requires a singly linked regular file, not a symlink, junction, or hard link: ${filePath}`);
  }
  if (storage.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw storageError(`Preview files require private permissions (0600): ${filePath}`);
  }
}

async function withCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await action();
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      throw storageError(`${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`, error);
    }
    throw error;
  }
  await cleanup();
  return result;
}

interface MetadataReadGuard {
  check(): Promise<void>;
  file(details: UpdatePreviewFileStat): void;
}

async function readText(
  storage: Storage, filePath: string, snapshot: DirectorySnapshot, metadata?: MetadataReadGuard
): Promise<string | undefined> {
  await metadata?.check();
  await assertDirectories(storage, snapshot);
  const before = await inspect(storage.fs, filePath);
  if (!before) return undefined;
  privateFile(storage, before, filePath);
  metadata?.file(before);
  if (before.size > maximumReceiptBytes) throw storageError(`Preview receipt exceeds its size limit: ${filePath}`);
  const handle = await io('open for reading', filePath, () => storage.fs.openFile(filePath, 'read', 0o600));
  return withCleanup(async () => {
    const opened = await io('inspect opened file', filePath, () => handle.stat());
    privateFile(storage, opened, filePath);
    metadata?.file(opened);
    if (!sameFile(before, opened)) throw storageError(`Preview file changed while opening: ${filePath}`);
    if (metadata && !sameMetadataStamp(before, opened)) throw storageError('Private metadata changed while opening.');
    await metadata?.check();
    let content: string;
    if (metadata) {
      if (!handle.readBytes) throw new ScopedMetadataEnumerationError('unsupported');
      const readBytes = handle.readBytes.bind(handle);
      const bytes = await io('read private metadata', filePath, () => readBytes(maximumReceiptBytes));
      try {
        if (bytes.byteLength !== before.size || !isUtf8(bytes)) throw new ScopedMetadataEnumerationError('changed');
        content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
      } finally { bytes.fill(0); }
    } else content = await io('read', filePath, () => handle.readText(maximumReceiptBytes));
    const after = await inspect(storage.fs, filePath);
    if (!after || !sameFile(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw storageError(`Preview file changed while reading: ${filePath}`);
    }
    privateFile(storage, after, filePath);
    if (metadata) {
      const retained = await handle.stat();
      metadata.file(retained);
      metadata.file(after);
      if (!sameMetadataStamp(before, retained) || !sameMetadataStamp(before, after)) throw new ScopedMetadataEnumerationError('changed');
      await metadata.check();
    }
    await assertDirectories(storage, snapshot);
    return content;
  }, () => io('close', filePath, () => handle.close()));
}

function parseReceipt(content: string, storage: Storage): UpdatePreviewReceipt {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) {
    throw new UpdatePreviewError('preview-invalid', `Malformed preview receipt JSON: ${storage.location.receiptPath}`, { cause: error });
  }
  return validateUpdatePreviewReceipt(value, { projectRoot: storage.location.projectRoot, now: storage.now() });
}

function missing(storage: Storage): never {
  const { location } = storage;
  throw new UpdatePreviewError(
    'preview-missing',
    `No saved update preview was found for project ${location.projectRoot}. Expected receipt: ${location.receiptPath}.`,
    { projectRoot: location.projectRoot, platform: storage.platform }
  );
}

export async function loadUpdatePreviewReceipt(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
): Promise<StoredUpdatePreview> {
  const storage = await storageFor(projectRoot, options);
  const snapshot = await directories(storage, false);
  if (!snapshot) missing(storage);
  const content = await readText(storage, storage.location.receiptPath, snapshot);
  if (content === undefined) missing(storage);
  return { location: storage.location, receipt: parseReceipt(content, storage) };
}

async function assertOwnedFile(storage: Storage, filePath: string, owned: UpdatePreviewFileStat): Promise<void> {
  const current = await inspect(storage.fs, filePath);
  if (!current || !sameFile(owned, current)) throw storageError(`Preview storage file was replaced; replacement preserved: ${filePath}`);
  privateFile(storage, current, filePath);
}

async function exclusiveFile<T>(
  storage: Storage,
  filePath: string,
  snapshot: DirectorySnapshot,
  action: (handle: UpdatePreviewFileHandle, owned: UpdatePreviewFileStat, close: () => Promise<void>) => Promise<T>,
  isLock = false
): Promise<T> {
  await assertDirectories(storage, snapshot);
  let handle: UpdatePreviewFileHandle;
  try {
    handle = await io('create exclusive file', filePath, () => storage.fs.openFile(filePath, 'create-exclusive', 0o600));
  } catch (error) {
    if (isLock && error instanceof UpdatePreviewError && errorCode(error.cause) === 'EEXIST') {
      throw new UpdatePreviewError('preview-busy', `Another preview write or cleanup is in progress: ${filePath}`, { cause: error });
    }
    throw error;
  }
  let owned: UpdatePreviewFileStat | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      await io('close', filePath, () => handle.close());
      closed = true;
    }
  };
  return withCleanup(async () => {
    owned = await io('establish file ownership', filePath, () => handle.stat());
    await io('set private permissions', filePath, () => handle.chmod(0o600));
    return action(handle, owned, close);
  }, async () => {
    const failures: string[] = [];
    try { await close(); }
    catch (error) { failures.push(errorMessage(error)); }
    try {
      await assertDirectories(storage, snapshot);
      const current = await inspect(storage.fs, filePath);
      if (current) {
        if (!owned) throw storageError(`Unable to establish ownership; preview storage file was preserved: ${filePath}`);
        await assertOwnedFile(storage, filePath, owned);
        await io('remove owned file', filePath, () => storage.fs.removeFile(filePath));
      }
      if (isLock) {
        await assertDirectories(storage, snapshot);
        await io('flush metadata lock cleanup', storage.location.directory,
          () => storage.fs.syncDirectory(storage.location.directory));
      }
    } catch (error) { failures.push(errorMessage(error)); }
    if (failures.length) throw storageError(failures.join('; '));
  });
}

async function withStoreLock<T>(storage: Storage, snapshot: DirectorySnapshot, operation: () => Promise<T>): Promise<T> {
  const lockPath = storage.paths.join(storage.location.directory, `${storage.location.projectKey}.lock`);
  const existing = await inspect(storage.fs, lockPath);
  if (existing) {
    privateFile(storage, existing, lockPath);
    throw new UpdatePreviewError('preview-busy', `Another preview write or cleanup is in progress: ${lockPath}`);
  }
  return exclusiveFile(storage, lockPath, snapshot, async (_handle, owned) => {
    await assertOwnedFile(storage, lockPath, owned);
    const result = await operation();
    await assertOwnedFile(storage, lockPath, owned);
    return result;
  }, true);
}

async function writeAtomicMetadata(
  storage: Storage,
  snapshot: DirectorySnapshot,
  filePath: string,
  content: string,
  before: string | undefined,
  durable = false
): Promise<void> {
  if (Buffer.byteLength(content) > maximumReceiptBytes) throw storageError('User-local update metadata exceeds its size limit.');
  const temporaryPath = storage.paths.join(storage.location.directory, `.${storage.paths.basename(filePath)}.${randomUUID()}.tmp`);
  await exclusiveFile(storage, temporaryPath, snapshot, async (handle, owned, close) => {
    await io('write', temporaryPath, () => handle.writeText(content));
    await io('flush', temporaryPath, () => handle.sync());
    await close();
    await assertOwnedFile(storage, temporaryPath, owned);
    if (await readText(storage, temporaryPath, snapshot) !== content) {
      throw storageError(`User-local update temporary contents changed before replacement: ${temporaryPath}`);
    }
    if (await readText(storage, filePath, snapshot) !== before) {
      throw storageError(`User-local update metadata changed before replacement: ${filePath}`);
    }
    await assertDirectories(storage, snapshot);
    await io('atomically replace receipt or seal', filePath, () => storage.fs.replaceFile(temporaryPath, filePath));
    if (durable) {
      await assertDirectories(storage, snapshot);
      await io('flush approval seal directory', storage.location.directory, () => storage.fs.syncDirectory(storage.location.directory));
    }
  });
}

export async function issueUpdatePreviewReceipt(
  projectRoot: string,
  descriptors: readonly UpdatePreviewDescriptor[],
  options: UpdatePreviewOptions = {}
): Promise<StoredUpdatePreview> {
  const storage = await storageFor(projectRoot, options);
  const now = storage.now();
  if (!Number.isFinite(now.getTime())) throw new UpdatePreviewError('preview-invalid', 'The preview clock is invalid.');
  const receipt = validateUpdatePreviewReceipt(createUpdatePreviewReceipt(descriptors, {
    receiptId: randomUUID(),
    issuedAt: now.toISOString()
  }), { projectRoot: storage.location.projectRoot, now });
  const snapshot = await directories(storage, true);
  if (!snapshot) throw storageError(`Unable to create preview storage: ${storage.location.directory}`);
  return withStoreLock(storage, snapshot, async () => {
    const before = await readText(storage, storage.location.receiptPath, snapshot);
    if (before !== undefined) parseReceipt(before, storage);
    await writeAtomicMetadata(storage, snapshot, storage.location.receiptPath, canonicalJson(receipt), before);
    return { location: storage.location, receipt };
  });
}

function approvalPath(storage: Storage, binding: UpdateTransactionApprovalBinding): string {
  return storage.paths.join(storage.location.directory, `approval-${updateTransactionApprovalKey(binding)}.json`);
}

function parseApproval(
  content: string,
  storage: Storage,
  binding: UpdateTransactionApprovalBinding,
  filePath: string
): UpdateTransactionApprovalSeal {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) {
    throw new UpdateTransactionApprovalError(`Malformed transaction approval seal JSON: ${filePath}`, { cause: error });
  }
  return validateUpdateTransactionApprovalSeal(value, binding, storage.now());
}

function createTransactionApprovalStore(
  projectRoot: string,
  options: UpdatePreviewOptions,
  userSkillScope: boolean | 'installation' = false
): UpdateTransactionApprovalStore {
  const env = options.env ?? process.env;
  const capturedOptions: UpdatePreviewOptions = {
    ...options,
    env: { XDG_STATE_HOME: env.XDG_STATE_HOME, LOCALAPPDATA: env.LOCALAPPDATA },
    platform: options.platform ?? process.platform,
    homedir: options.homedir ?? os.homedir()
  };
  let boundLocation: UpdatePreviewLocation | undefined;
  const resolveBinding = async (planFingerprint: string, transactionDigest: string) => {
    validateUpdateTransactionApprovalDigests(planFingerprint, transactionDigest);
    const storage = userSkillScope === 'installation'
      ? await installationStorageFor(projectRoot, capturedOptions) : await storageFor(projectRoot, capturedOptions, userSkillScope);
    if (boundLocation && canonicalJson(boundLocation) !== canonicalJson(storage.location)) {
      throw new UpdateTransactionApprovalError('The transaction approval project or user-local storage boundary changed.');
    }
    boundLocation = storage.location;
    const binding: UpdateTransactionApprovalBinding = { projectRoot: storage.location.projectRoot, planFingerprint, transactionDigest };
    return { storage, binding, filePath: approvalPath(storage, binding) };
  };
  return {
    write: async (planFingerprint, transactionDigest) => {
      const { storage, binding, filePath } = await resolveBinding(planFingerprint, transactionDigest);
      const now = storage.now();
      if (!Number.isFinite(now.getTime())) throw new UpdateTransactionApprovalError('The transaction approval clock is invalid.');
      const seal = createUpdateTransactionApprovalSeal(binding, { approvalId: randomUUID(), approvedAt: now.toISOString() });
      const snapshot = await directories(storage, true);
      if (!snapshot) throw storageError(`Unable to create transaction approval storage: ${storage.location.directory}`);
      await withStoreLock(storage, snapshot, async () => {
        const before = await readText(storage, filePath, snapshot);
        if (before !== undefined) {
          parseApproval(before, storage, binding, filePath);
          await io('flush existing approval seal directory', storage.location.directory,
            () => storage.fs.syncDirectory(storage.location.directory));
          return;
        }
        await writeAtomicMetadata(storage, snapshot, filePath, canonicalJson(seal), undefined, true);
      });
    },
    verify: async (planFingerprint, transactionDigest) => {
      const { storage, binding, filePath } = await resolveBinding(planFingerprint, transactionDigest);
      const snapshot = await directories(storage, false);
      if (!snapshot) return false;
      const content = await readText(storage, filePath, snapshot);
      if (content === undefined) return false;
      parseApproval(content, storage, binding, filePath);
      return true;
    },
    remove: async (planFingerprint, transactionDigest) => {
      const { storage, binding, filePath } = await resolveBinding(planFingerprint, transactionDigest);
      const snapshot = await directories(storage, false);
      if (!snapshot) return;
      await withStoreLock(storage, snapshot, async () => {
        const content = await readText(storage, filePath, snapshot);
        if (content !== undefined) {
          parseApproval(content, storage, binding, filePath);
          const owned = await inspect(storage.fs, filePath);
          if (!owned || await readText(storage, filePath, snapshot) !== content) {
            throw storageError(`Transaction approval seal changed during removal: ${filePath}`);
          }
          await assertDirectories(storage, snapshot);
          await assertOwnedFile(storage, filePath, owned);
          await io('remove transaction approval seal', filePath, () => storage.fs.removeFile(filePath));
        }
        await assertDirectories(storage, snapshot);
        await io('flush removed approval seal directory', storage.location.directory,
          () => storage.fs.syncDirectory(storage.location.directory));
      });
    }
  };
}

export function createUpdateTransactionApprovalStore(
  projectRoot: string, options: UpdatePreviewOptions = {}
): UpdateTransactionApprovalStore {
  return createTransactionApprovalStore(projectRoot, options);
}

export function createSkillsTransactionApprovalStore(
  targetRoot: string, scope: SkillScope, options: UpdatePreviewOptions = {}
): UpdateTransactionApprovalStore {
  if (scope !== 'user' && scope !== 'project') throw storageError('Unknown skills approval scope.');
  return createTransactionApprovalStore(targetRoot, options, scope === 'user');
}

export function createInstallationTransactionApprovalStore(
  targetRoot: string, options: UpdatePreviewOptions = {}
): UpdateTransactionApprovalStore {
  return createTransactionApprovalStore(targetRoot, options, 'installation');
}

export async function consumeUpdatePreviewReceipt(
  projectRoot: string,
  expectedReceipt: UpdatePreviewReceipt,
  options: UpdatePreviewOptions = {}
): Promise<void> {
  const storage = await storageFor(projectRoot, options);
  const expected = validateUpdatePreviewReceipt(expectedReceipt, { projectRoot: storage.location.projectRoot, now: storage.now() });
  const snapshot = await directories(storage, false);
  if (!snapshot) missing(storage);
  await withStoreLock(storage, snapshot, async () => {
    const content = await readText(storage, storage.location.receiptPath, snapshot);
    if (content === undefined) missing(storage);
    const current = parseReceipt(content, storage);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw new UpdatePreviewError('preview-mismatch', 'A newer or different preview receipt was found; it was preserved.');
    }
    const owned = await inspect(storage.fs, storage.location.receiptPath);
    if (!owned) missing(storage);
    if (await readText(storage, storage.location.receiptPath, snapshot) !== content) {
      throw storageError(`Preview receipt changed during cleanup: ${storage.location.receiptPath}`);
    }
    await assertDirectories(storage, snapshot);
    await assertOwnedFile(storage, storage.location.receiptPath, owned);
    await io('consume receipt', storage.location.receiptPath, () => storage.fs.removeFile(storage.location.receiptPath));
  });
}

export interface ScopedUserLocalRecord {
  projectRoot: string;
  path: string;
  value: unknown;
}

type ScopedRecordNamespace = 'governance-preview' | 'governance-approval' | 'governance-operation' | 'workstation-remediation' |
    'repair-preview' | 'repair-approval' | 'repair-verification' | 'repair-backup' |
    'repair-workspace-authority' | 'adoption-preview' | 'adoption-approval' |
    'adoption-verification' | 'adoption-backup' | 'adoption-framework' | 'adoption-checkpoint' |
    'skills-ownership' | 'installation-record';

export type ScopedMetadataNamespace = 'governance-preview' | 'governance-approval' | 'governance-operation';
export const scopedMetadataEnumerationLimits = Object.freeze({
  maximumEntries: 8192,
  maximumRecords: 1024,
  maximumBytes: 8 * 1024 * 1024,
  maximumFilenameBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000
});

export interface ScopedMetadataEnumerationOptions {
  maximumEntries?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  maximumFilenameBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScopedMetadataInventory {
  namespace: ScopedMetadataNamespace;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string; ownerUid: number };
  keys: readonly string[];
  scannedEntries: number;
  totalBytes: number;
}

export interface ScopedMetadataRecordInventory extends ScopedMetadataInventory {
  records: readonly ScopedUserLocalRecord[];
}

export class ScopedMetadataEnumerationError extends UpdatePreviewError {
  constructor(readonly reason: 'unsupported' | 'unavailable' | 'limit' | 'timeout' | 'aborted' | 'changed' | 'unsafe' | 'binding' | 'invalid-record') {
    super('preview-storage', `Private metadata enumeration is blocked (${reason}); incomplete inventory is not absence or dispatch authority.`);
    this.name = 'ScopedMetadataEnumerationError';
  }
}

function sameMetadataStamp(left: UpdatePreviewFileStat, right: UpdatePreviewFileStat): boolean {
  return sameFile(left, right) && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs && left.uid === right.uid;
}

function metadataCreation(details: UpdatePreviewFileStat): ScopedMetadataInventory['projectIdentity'] {
  if (!Number.isFinite(details.dev) || !Number.isFinite(details.ino) ||
    typeof details.birthtimeMs !== 'number' || !Number.isFinite(details.birthtimeMs) || details.birthtimeMs <= 0 ||
    typeof details.uid !== 'number' || !Number.isSafeInteger(details.uid) || details.uid < 0) {
    throw new ScopedMetadataEnumerationError('unsupported');
  }
  return { device: String(details.dev), inode: String(details.ino), birthtime: String(details.birthtimeMs), ownerUid: details.uid };
}

function ordinaryMetadata(
  details: UpdatePreviewFileStat, directory: boolean, ownerUid: number
): void {
  metadataCreation(details);
  if (details.isSymbolicLink() || (directory ? !details.isDirectory() : !details.isFile() || details.nlink !== 1) ||
    details.uid !== ownerUid || !Number.isSafeInteger(details.size) || details.size < 0 ||
    !Number.isFinite(details.mtimeMs) || !Number.isFinite(details.ctimeMs) ||
    (directory ? ![0o500, 0o700].includes(details.mode & 0o7777) : ![0o400, 0o600].includes(details.mode & 0o7777))) {
    throw new ScopedMetadataEnumerationError('unsafe');
  }
}

async function enumerateScopedMetadata(
  selectStorage: () => Promise<Storage>, namespace: ScopedRecordNamespace,
  options: ScopedMetadataEnumerationOptions, readValues: boolean
): Promise<ScopedMetadataRecordInventory> {
  if (namespace !== 'governance-preview' && namespace !== 'governance-approval' && namespace !== 'governance-operation') {
    throw new ScopedMetadataEnumerationError('unsupported');
  }
  const limits: { -readonly [K in keyof typeof scopedMetadataEnumerationLimits]: number } = { ...scopedMetadataEnumerationLimits };
  for (const key of Object.keys(options)) {
    if (key !== 'signal' && !Object.hasOwn(limits, key)) throw new ScopedMetadataEnumerationError('limit');
  }
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new ScopedMetadataEnumerationError('limit');
      limits[key] = value;
    }
  }
  const deadline = performance.now() + limits.timeoutMs;
  let stopped = false;
  const checkTime = () => {
    if (options.signal?.aborted) throw new ScopedMetadataEnumerationError('aborted');
    if (stopped || performance.now() >= deadline) throw new ScopedMetadataEnumerationError('timeout');
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { stopped = true; reject(new ScopedMetadataEnumerationError('timeout')); }, limits.timeoutMs);
    rejectAbort = () => { stopped = true; reject(new ScopedMetadataEnumerationError('aborted')); };
    options.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  const work = (async (): Promise<ScopedMetadataRecordInventory> => {
    checkTime();
    const storage = await selectStorage();
    checkTime();
    if (!storage.fs.openDirectory || storage.platform === 'win32') throw new ScopedMetadataEnumerationError('unsupported');
    const project = await storage.fs.lstat(storage.location.projectRoot);
    regularDirectory(project, storage.location.projectRoot);
    const projectIdentity = metadataCreation(project);
    if (storage.platform === process.platform && process.getuid && projectIdentity.ownerUid !== process.getuid()) {
      throw new ScopedMetadataEnumerationError('binding');
    }
    const snapshot = await directories(storage, false);
    if (!snapshot) throw new ScopedMetadataEnumerationError('unavailable');
    const directoryBefore = snapshot.get(storage.location.directory);
    if (!directoryBefore) throw new ScopedMetadataEnumerationError('unavailable');
    const privateRoot = storage.paths.dirname(storage.location.directory);
    for (const [name, details] of snapshot) {
      if (within(privateRoot, name, storage.paths, storage.platform)) ordinaryMetadata(details, true, projectIdentity.ownerUid);
    }
    const checkBinding = async () => {
      checkTime();
      const current = await storage.fs.lstat(storage.location.projectRoot);
      regularDirectory(current, storage.location.projectRoot);
      if (JSON.stringify(metadataCreation(current)) !== JSON.stringify(projectIdentity) ||
        await storage.fs.realpath(storage.location.projectRoot) !== storage.location.projectRoot) {
        throw new ScopedMetadataEnumerationError('binding');
      }
      await assertDirectories(storage, snapshot);
      for (const [name, details] of snapshot) {
        if (!within(privateRoot, name, storage.paths, storage.platform)) continue;
        const current = await storage.fs.lstat(name);
        ordinaryMetadata(current, true, projectIdentity.ownerUid);
        if (!sameMetadataStamp(details, current)) throw new ScopedMetadataEnumerationError('changed');
      }
      if (await storage.fs.realpath(storage.location.directory) !== storage.location.directory) {
        throw new ScopedMetadataEnumerationError('changed');
      }
      checkTime();
    };
    await checkBinding();
    const directory = await storage.fs.openDirectory(storage.location.directory);
    const selected = new Map<string, { path: string; stat: UpdatePreviewFileStat }>();
    let complete = false;
    return withCleanup(async () => {
      await checkBinding();
      ordinaryMetadata(await directory.stat(), true, projectIdentity.ownerUid);
      if (!sameMetadataStamp(directoryBefore, await directory.stat())) throw new ScopedMetadataEnumerationError('changed');
      const prefix = `${namespace}-${storage.location.projectKey}-`;
      const names = new Set<string>();
      let scannedEntries = 0, filenameBytes = 0, totalBytes = 0;
      while (true) {
        checkTime();
        const name = await directory.readName();
        checkTime();
        if (name === null) break;
        if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || names.has(name)) {
          throw new ScopedMetadataEnumerationError('changed');
        }
        names.add(name);
        if (++scannedEntries > limits.maximumEntries || (filenameBytes += Buffer.byteLength(name)) > limits.maximumFilenameBytes) {
          throw new ScopedMetadataEnumerationError('limit');
        }
        const compared = comparable(name, storage.platform);
        if (compared.startsWith(`.${prefix}`)) throw new ScopedMetadataEnumerationError('changed');
        if (!compared.startsWith(prefix)) continue;
        if (!name.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/u.test(name.slice(prefix.length))) {
          throw new ScopedMetadataEnumerationError('unsafe');
        }
        if (selected.size >= limits.maximumRecords) throw new ScopedMetadataEnumerationError('limit');
        const key = name.slice(prefix.length, -5), file = storage.paths.join(storage.location.directory, name);
        const details = await storage.fs.lstat(file);
        ordinaryMetadata(details, false, projectIdentity.ownerUid);
        if (details.size < 1) throw new ScopedMetadataEnumerationError('invalid-record');
        if (details.size > maximumReceiptBytes || (totalBytes += details.size) > limits.maximumBytes) {
          throw new ScopedMetadataEnumerationError('limit');
        }
        selected.set(key, { path: file, stat: details });
      }
      await checkBinding();
      if (!sameMetadataStamp(directoryBefore, await directory.stat())) throw new ScopedMetadataEnumerationError('changed');
      const records: ScopedUserLocalRecord[] = [], keys = [...selected.keys()].sort();
      for (const key of keys) {
        const entry = selected.get(key)!;
        await checkBinding();
        const current = await storage.fs.lstat(entry.path);
        ordinaryMetadata(current, false, projectIdentity.ownerUid);
        if (!sameMetadataStamp(entry.stat, current)) throw new ScopedMetadataEnumerationError('changed');
        if (!readValues) continue;
        const content = await readText(storage, entry.path, snapshot, {
          check: checkBinding,
          file: (details) => {
            checkTime();
            ordinaryMetadata(details, false, projectIdentity.ownerUid);
            if (!sameMetadataStamp(details, entry.stat)) throw new ScopedMetadataEnumerationError('changed');
          }
        });
        if (content === undefined) throw new ScopedMetadataEnumerationError('changed');
        let value: unknown;
        try { value = JSON.parse(content); } catch { throw new ScopedMetadataEnumerationError('invalid-record'); }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ScopedMetadataEnumerationError('invalid-record');
        if ('projectRoot' in value && value.projectRoot !== storage.location.projectRoot) throw new ScopedMetadataEnumerationError('binding');
        if ('projectIdentity' in value) {
          const identity = value.projectIdentity;
          if (identity === null || typeof identity !== 'object' || Array.isArray(identity) ||
            !('device' in identity) || identity.device !== projectIdentity.device ||
            !('inode' in identity) || identity.inode !== projectIdentity.inode ||
            !('birthtime' in identity) || identity.birthtime !== projectIdentity.birthtime ||
            'uid' in identity && identity.uid !== projectIdentity.ownerUid) {
            throw new ScopedMetadataEnumerationError('binding');
          }
        }
        records.push({ projectRoot: storage.location.projectRoot, path: entry.path, value });
      }
      for (const entry of selected.values()) {
        checkTime();
        const current = await storage.fs.lstat(entry.path);
        ordinaryMetadata(current, false, projectIdentity.ownerUid);
        if (!sameMetadataStamp(entry.stat, current)) throw new ScopedMetadataEnumerationError('changed');
      }
      await checkBinding();
      if (!sameMetadataStamp(directoryBefore, await directory.stat())) throw new ScopedMetadataEnumerationError('changed');
      complete = true;
      return { namespace, projectRoot: storage.location.projectRoot, projectIdentity, keys, scannedEntries, totalBytes, records };
    }, async () => {
      await directory.close();
      if (!complete) return;
      await checkBinding();
      for (const entry of selected.values()) {
        checkTime();
        const current = await storage.fs.lstat(entry.path);
        ordinaryMetadata(current, false, projectIdentity.ownerUid);
        if (!sameMetadataStamp(entry.stat, current)) throw new ScopedMetadataEnumerationError('changed');
      }
    });
  })();
  try {
    const result = await Promise.race([work, timeout]);
    checkTime();
    return result;
  } catch (error) {
    if (error instanceof ScopedMetadataEnumerationError) throw error;
    throw new ScopedMetadataEnumerationError('unsafe');
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (rejectAbort) options.signal?.removeEventListener('abort', rejectAbort);
  }
}

function createScopedRecordStore(
  projectRoot: string,
  namespace: ScopedRecordNamespace,
  options: UpdatePreviewOptions,
  userSkillScope: boolean | 'installation' = false
): {
  read(key: string): Promise<ScopedUserLocalRecord | null>;
  write(key: string, value: unknown): Promise<ScopedUserLocalRecord>;
  listKeys(options?: ScopedMetadataEnumerationOptions): Promise<ScopedMetadataInventory>;
  readAll(options?: ScopedMetadataEnumerationOptions): Promise<ScopedMetadataRecordInventory>;
} {
  const selectStorage = () => userSkillScope === 'installation'
    ? installationStorageFor(projectRoot, options) : storageFor(projectRoot, options, userSkillScope);
  const location = async (key: string) => {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw storageError('A scoped metadata key must be a complete lowercase SHA-256 digest.');
    const storage = await selectStorage();
    const filePath = storage.paths.join(storage.location.directory, `${namespace}-${storage.location.projectKey}-${key}.json`);
    return { storage, filePath };
  };
  return {
    listKeys: async (limits = {}) => {
      const { records: _records, ...inventory } = await enumerateScopedMetadata(selectStorage, namespace, limits, false);
      return inventory;
    },
    readAll: (limits = {}) => enumerateScopedMetadata(selectStorage, namespace, limits, true),
    read: async (key) => {
      const { storage, filePath } = await location(key);
      const snapshot = await directories(storage, false);
      if (!snapshot) return null;
      const content = await readText(storage, filePath, snapshot);
      if (content === undefined) return null;
      let value: unknown;
      try { value = JSON.parse(content); }
      catch (error) { throw storageError(`Malformed ${namespace} record at ${filePath}.`, error); }
      return { projectRoot: storage.location.projectRoot, path: filePath, value };
    },
    write: async (key, value) => {
      const { storage, filePath } = await location(key);
      const content = canonicalJson(value);
      const snapshot = await directories(storage, true);
      if (!snapshot) throw storageError(`Unable to create ${namespace} storage.`);
      return withStoreLock(storage, snapshot, async () => {
        const before = await readText(storage, filePath, snapshot);
        if (before !== undefined && before !== content) {
          throw storageError(`Refusing to replace different ${namespace} metadata at ${filePath}.`);
        }
        if (before === undefined) await writeAtomicMetadata(storage, snapshot, filePath, content, undefined, true);
        return { projectRoot: storage.location.projectRoot, path: filePath, value };
      });
    }
  };
}

export function createScopedUserLocalRecordStore(
  projectRoot: string, namespace: Exclude<ScopedRecordNamespace, 'skills-ownership' | 'installation-record'>,
  options: UpdatePreviewOptions = {}
): ReturnType<typeof createScopedRecordStore> {
  return createScopedRecordStore(projectRoot, namespace, options);
}

export function createSkillsOwnershipAuthorityStore(
  targetRoot: string, scope: SkillScope, options: UpdatePreviewOptions = {}
): ReturnType<typeof createScopedRecordStore> {
  if (scope !== 'user' && scope !== 'project') throw storageError('Unknown skills ownership authority scope.');
  const env = options.env ?? process.env;
  return createScopedRecordStore(targetRoot, 'skills-ownership', {
    ...options,
    env: { XDG_STATE_HOME: env.XDG_STATE_HOME, LOCALAPPDATA: env.LOCALAPPDATA },
    homedir: options.homedir ?? os.homedir(), platform: options.platform ?? process.platform
  }, scope === 'user');
}

export function createInstallationRecordStore(
  targetRoot: string, options: UpdatePreviewOptions = {}
): ReturnType<typeof createScopedRecordStore> {
  return createScopedRecordStore(targetRoot, 'installation-record', options, 'installation');
}

export interface RepairWorkspaceRegistryValue extends ScopedUserLocalRecord {
  digest: string;
}

/** Only the private workspace registry is mutable; preview/approval stores remain immutable. */
export function createRepairWorkspaceRegistryStore(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
): {
  read(key: string): Promise<RepairWorkspaceRegistryValue | null>;
  compareExchange(key: string, expectedDigest: string | null, value: unknown): Promise<RepairWorkspaceRegistryValue>;
} {
  const digest = (content: string) => createHash('sha256').update(content).digest('hex');
  const location = async (key: string) => {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw storageError('A workspace registry key must be a complete lowercase SHA-256 digest.');
    const storage = await storageFor(projectRoot, options);
    const filePath = storage.paths.join(storage.location.directory,
      `repair-workspace-registry-${storage.location.projectKey}-${key}.json`);
    return { storage, filePath };
  };
  const parse = (content: string): unknown => {
    let value: unknown;
    try { value = JSON.parse(content); }
    catch (error) { throw storageError('Malformed private workspace registry JSON.', error); }
    if (canonicalJson(value) !== content) throw storageError('Private workspace registry must retain its canonical bytes.');
    return value;
  };
  return {
    read: async (key) => {
      const { storage, filePath } = await location(key);
      const snapshot = await directories(storage, false);
      if (!snapshot) return null;
      const content = await readText(storage, filePath, snapshot);
      return content === undefined ? null : {
        projectRoot: storage.location.projectRoot, path: filePath, value: parse(content), digest: digest(content)
      };
    },
    compareExchange: async (key, expectedDigest, value) => {
      if (expectedDigest !== null && !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
        throw storageError('A workspace registry precondition must be a complete digest or absence.');
      }
      const { storage, filePath } = await location(key);
      const content = canonicalJson(value);
      if (Buffer.byteLength(content) > maximumReceiptBytes) throw storageError('Private workspace registry exceeds its size limit.');
      const snapshot = await directories(storage, true);
      if (!snapshot) throw storageError('Unable to create private workspace registry storage.');
      return withStoreLock(storage, snapshot, async () => {
        const before = await readText(storage, filePath, snapshot);
        if (before !== undefined) parse(before);
        if ((before === undefined ? null : digest(before)) !== expectedDigest) {
          throw storageError('Private workspace registry changed; compare-and-exchange refused.');
        }
        await writeAtomicMetadata(storage, snapshot, filePath, content, before, true);
        return { projectRoot: storage.location.projectRoot, path: filePath, value, digest: digest(content) };
      });
    }
  };
}
