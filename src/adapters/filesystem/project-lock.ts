import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export class ProjectMutationLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectMutationLockError';
  }
}

export interface ProjectMutationLease {
  assertHeld(): Promise<void>;
}

export interface HeldProjectMutationLease extends ProjectMutationLease {
  readonly path: string;
}

interface HeldLock {
  root: string;
  path: string;
  handle: FileHandle;
  device: number;
  inode: number;
  mode: number;
  linkCount: number;
  uid: number;
  gid: number;
  content: string;
  active: boolean;
}

const activeLocks = new AsyncLocalStorage<ReadonlyMap<string, HeldLock>>();

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  try {
    const details = await lstat(root);
    if (details.isSymbolicLink()) {
      throw new ProjectMutationLockError(`Project mutation target is a symlink or junction: ${root}`);
    }
    if (!details.isDirectory()) {
      throw new ProjectMutationLockError(`Project mutation target must be a regular directory: ${root}`);
    }
    return await realpath(root);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return path.join(await realpath(path.dirname(root)), path.basename(root));
  }
}

function lockPathForRoot(root: string, userScope = false): string {
  // Missing paths have no canonical spelling yet; fold aliases conservatively on every filesystem.
  const identity = root.normalize('NFC').toLowerCase();
  const digest = createHash('sha256').update(identity).digest('hex');
  // A sibling reservation also protects a new target before its directory exists.
  return path.join(userScope ? root : path.dirname(root), `.liftoff-mutation-${digest}.lock`);
}

export async function projectMutationLockPath(projectRoot: string): Promise<string> {
  return lockPathForRoot(await canonicalProjectRoot(projectRoot));
}

export async function userScopeMutationLockPath(userRoot: string): Promise<string> {
  return lockPathForRoot(await canonicalProjectRoot(userRoot), true);
}

export async function currentProjectMutationLease(projectRoot: string): Promise<HeldProjectMutationLease | undefined> {
  const held = activeLocks.getStore();
  if (!held?.size) return undefined;
  const root = await canonicalProjectRoot(projectRoot);
  const lock = held.get(lockPathForRoot(root));
  if (!lock) return undefined;
  await assertHeld(lock);
  return Object.freeze({ path: lock.path, assertHeld: () => assertHeld(lock) });
}

async function assertNoOtherScopeLock(lockPath: string): Promise<void> {
  try {
    await lstat(lockPath);
    throw new ProjectMutationLockError(`Another cooperating Liftoff target-scope mutation blocks new work. Lock: ${lockPath}. The existing entry was preserved.`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function assertLockIdentity(lock: HeldLock, allowPartialContent = false): Promise<void> {
  const details = await lstat(lock.path);
  if (!details.isFile() || details.dev !== lock.device || details.ino !== lock.inode ||
      details.mode !== lock.mode || details.nlink !== lock.linkCount || details.uid !== lock.uid || details.gid !== lock.gid) {
    throw new ProjectMutationLockError(`Project mutation lock changed: ${lock.path}. The replacement was preserved.`);
  }
  const content = await readFile(lock.path, 'utf8');
  if (allowPartialContent ? !lock.content.startsWith(content) : content !== lock.content) {
    throw new ProjectMutationLockError(`Project mutation lock contents changed: ${lock.path}. The changed file was preserved.`);
  }
}

async function assertHeld(lock: HeldLock): Promise<void> {
  if (!lock.active) {
    throw new ProjectMutationLockError(`Project mutation lock is no longer held for ${lock.root}.`);
  }
  try {
    await assertLockIdentity(lock);
  } catch (error) {
    throw new ProjectMutationLockError(
      `Unable to confirm project mutation lock for ${lock.root}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

async function releaseLock(lock: HeldLock, allowPartialContent = false): Promise<void> {
  lock.active = false;
  const failures: string[] = [];
  try {
    await lock.handle.close();
  } catch (error) {
    failures.push(`close: ${errorMessage(error)}`);
  }
  try {
    await assertLockIdentity(lock, allowPartialContent);
    await unlink(lock.path);
  } catch (error) {
    failures.push(`release: ${errorMessage(error)}`);
  }
  if (failures.length) {
    throw new ProjectMutationLockError(
      `Unable to release project mutation lock ${lock.path}: ${failures.join('; ')}`
    );
  }
}

async function acquireLock(root: string, lockPath: string): Promise<HeldLock> {
  try {
    await lstat(path.join(root, '.liftoff-init.lock'));
    throw new ProjectMutationLockError(
      `A legacy Liftoff initialization lock exists in ${root}. Verify its owner has stopped before reviewing the lock; it was not removed.`
    );
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    throw new ProjectMutationLockError(
      errorCode(error) === 'EEXIST'
        ? `Another cooperating Liftoff mutation is already in progress for ${root}. Lock: ${lockPath}. Verify the owner has stopped before reviewing a stale lock; Liftoff never removes an unowned lock.`
        : `Unable to acquire project mutation lock ${lockPath}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  let lock: HeldLock;
  try {
    const details = await handle.stat();
    lock = {
      root,
      path: lockPath,
      handle,
      device: details.dev,
      inode: details.ino,
      mode: details.mode,
      linkCount: details.nlink,
      uid: details.uid,
      gid: details.gid,
      content: `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() })}\n`,
      active: true
    };
  } catch (error) {
    await handle.close();
    throw new ProjectMutationLockError(
      `Unable to establish ownership of project mutation lock ${lockPath}; the file was preserved: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  try {
    await handle.writeFile(lock.content, 'utf8');
    await assertHeld(lock);
    return lock;
  } catch (error) {
    try {
      await releaseLock(lock, true);
    } catch (cleanupError) {
      throw new ProjectMutationLockError(
        `${errorMessage(error)} Lock cleanup also failed: ${errorMessage(cleanupError)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function withMutationLock<T>(
  projectRoot: string,
  operation: (lease: ProjectMutationLease) => Promise<T>,
  userScope: boolean
): Promise<T> {
  const root = await canonicalProjectRoot(projectRoot);
  const lockKey = lockPathForRoot(root);
  const lockPath = lockPathForRoot(root, userScope);
  const conflictingPath = lockPathForRoot(root, !userScope);
  const inherited = activeLocks.getStore()?.get(lockKey);
  if (inherited) {
    await assertHeld(inherited);
    return operation({ assertHeld: () => assertHeld(inherited) });
  }
  await assertNoOtherScopeLock(conflictingPath);
  const lock = await acquireLock(root, lockPath);
  const scope = new Map(activeLocks.getStore());
  scope.set(lockKey, lock);
  let result: T;
  try {
    await assertNoOtherScopeLock(conflictingPath);
    result = await activeLocks.run(scope, () => operation({ assertHeld: () => assertHeld(lock) }));
  } catch (error) {
    try {
      await releaseLock(lock);
    } catch (cleanupError) {
      throw new ProjectMutationLockError(
        `${errorMessage(error)} Lock cleanup also failed: ${errorMessage(cleanupError)}`,
        { cause: error }
      );
    }
    throw error;
  }
  await releaseLock(lock);
  return result;
}

export function withProjectMutationLock<T>(
  projectRoot: string, operation: (lease: ProjectMutationLease) => Promise<T>
): Promise<T> {
  return withMutationLock(projectRoot, operation, false);
}

export function withUserScopeMutationLock<T>(
  userRoot: string, operation: (lease: ProjectMutationLease) => Promise<T>
): Promise<T> {
  return withMutationLock(userRoot, operation, true);
}
