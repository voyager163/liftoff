import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
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
import { errorCode, errorMessage } from './errors.js';

export type { UpdateTransactionApprovalStore } from '../../application/update/transaction-approval.js';

export type UpdatePreviewFileStat = Pick<
  Stats, 'dev' | 'ino' | 'mode' | 'nlink' | 'size' | 'mtimeMs' | 'ctimeMs' |
  'isDirectory' | 'isFile' | 'isSymbolicLink'
>;

export interface UpdatePreviewFileHandle {
  stat(): Promise<UpdatePreviewFileStat>;
  readText(maximumBytes: number): Promise<string>;
  writeText(content: string): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
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
    const flags = access === 'read'
      ? constants.O_RDONLY | noFollow
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
    const handle = await open(filePath, flags, mode);
    return {
      stat: () => handle.stat(),
      readText: async (maximumBytes) => {
        const bytes = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > maximumBytes) throw new Error('Preview receipt exceeds its size limit.');
        return bytes.subarray(0, length).toString('utf8');
      },
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

async function storageFor(projectRoot: string, options: UpdatePreviewOptions): Promise<Storage> {
  const fs = options.fileSystem ?? nodeUpdatePreviewFileSystem;
  const platform = options.platform ?? process.platform;
  if (platform !== process.platform && fs === nodeUpdatePreviewFileSystem) {
    throw storageError('A non-native preview platform requires an injected filesystem.');
  }
  const paths = nativePaths(platform);
  const requestedRoot = absoluteNativePath(projectRoot, paths, 'Project root');
  const root = normalizeUpdatePreviewProjectRoot(await canonicalDirectory(fs, paths, requestedRoot));
  const requestedRepository = options.repositoryRoot === undefined
    ? undefined : absoluteNativePath(options.repositoryRoot, paths, 'Repository root');
  const repositoryRoot = requestedRepository === undefined
    ? await discoverRepository(fs, paths, root)
    : await canonicalDirectory(fs, paths, requestedRepository);
  if (repositoryRoot !== undefined && !within(repositoryRoot, root, paths, platform)) {
    throw storageError(`The supplied repository does not contain the project: ${repositoryRoot}`);
  }
  const boundaries = [requestedRoot, root, ...repositoryRoot ? [repositoryRoot] : [],
    ...requestedRepository ? [requestedRepository] : []];
  const base = stateBase(options);
  rejectContainedStore(paths.join(base, ...updatePreviewDirectoryParts), boundaries, paths, platform);
  const directory = paths.join(await canonicalStateBase(fs, paths, base), ...updatePreviewDirectoryParts);
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

async function readText(storage: Storage, filePath: string, snapshot: DirectorySnapshot): Promise<string | undefined> {
  await assertDirectories(storage, snapshot);
  const before = await inspect(storage.fs, filePath);
  if (!before) return undefined;
  privateFile(storage, before, filePath);
  if (before.size > maximumReceiptBytes) throw storageError(`Preview receipt exceeds its size limit: ${filePath}`);
  const handle = await io('open for reading', filePath, () => storage.fs.openFile(filePath, 'read', 0o600));
  return withCleanup(async () => {
    const opened = await io('inspect opened file', filePath, () => handle.stat());
    privateFile(storage, opened, filePath);
    if (!sameFile(before, opened)) throw storageError(`Preview file changed while opening: ${filePath}`);
    const content = await io('read', filePath, () => handle.readText(maximumReceiptBytes));
    const after = await inspect(storage.fs, filePath);
    if (!after || !sameFile(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw storageError(`Preview file changed while reading: ${filePath}`);
    }
    privateFile(storage, after, filePath);
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

function missing(location: UpdatePreviewLocation): never {
  throw new UpdatePreviewError(
    'preview-missing',
    `No preview receipt exists for this project at ${location.receiptPath}. Run liftoff update --check.`
  );
}

export async function loadUpdatePreviewReceipt(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
): Promise<StoredUpdatePreview> {
  const storage = await storageFor(projectRoot, options);
  const snapshot = await directories(storage, false);
  if (!snapshot) missing(storage.location);
  const content = await readText(storage, storage.location.receiptPath, snapshot);
  if (content === undefined) missing(storage.location);
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

export function createUpdateTransactionApprovalStore(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
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
    const storage = await storageFor(projectRoot, capturedOptions);
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

export async function consumeUpdatePreviewReceipt(
  projectRoot: string,
  expectedReceipt: UpdatePreviewReceipt,
  options: UpdatePreviewOptions = {}
): Promise<void> {
  const storage = await storageFor(projectRoot, options);
  const expected = validateUpdatePreviewReceipt(expectedReceipt, { projectRoot: storage.location.projectRoot, now: storage.now() });
  const snapshot = await directories(storage, false);
  if (!snapshot) missing(storage.location);
  await withStoreLock(storage, snapshot, async () => {
    const content = await readText(storage, storage.location.receiptPath, snapshot);
    if (content === undefined) missing(storage.location);
    const current = parseReceipt(content, storage);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw new UpdatePreviewError('preview-mismatch', 'A newer or different preview receipt was found; it was preserved.');
    }
    const owned = await inspect(storage.fs, storage.location.receiptPath);
    if (!owned) missing(storage.location);
    if (await readText(storage, storage.location.receiptPath, snapshot) !== content) {
      throw storageError(`Preview receipt changed during cleanup: ${storage.location.receiptPath}`);
    }
    await assertDirectories(storage, snapshot);
    await assertOwnedFile(storage, storage.location.receiptPath, owned);
    await io('consume receipt', storage.location.receiptPath, () => storage.fs.removeFile(storage.location.receiptPath));
  });
}
