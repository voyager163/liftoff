import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner } from './process-runner.js';
import {
  validateArtifactPathParts,
  writeProjectFile
} from './file-system.js';
import type { GeneratedArtifact } from './types.js';

export type InitTargetMode = 'in-place' | 'named-child';
export type StagedOrigin = 'liftoff' | 'framework' | 'seed';
export type TreeEntryType = 'file' | 'directory' | 'symlink' | 'other';
export type PreflightAction = 'create' | 'identical' | 'replace' | 'merge-directory' | 'blocked';

export interface GitRootDiscovery {
  cwd: string;
  canonicalCwd: string;
  root?: string;
  exact: boolean;
}

export interface InitTarget {
  root: string;
  mode: InitTargetMode;
  gitRoot?: string;
}

export interface StagingArea {
  root: string;
  origins: Map<string, StagedOrigin>;
  frameworkAllowedRoots: Set<string>;
}

export interface TreeStateEntry {
  pathParts: string[];
  type: TreeEntryType;
  contentHash?: string;
  mode?: number;
}

export interface ValidatedStagedFile {
  pathParts: string[];
  relativePath: string;
  content: Buffer;
  contentHash: string;
  mode: number;
  origin: StagedOrigin;
}

export interface TargetRootSnapshot {
  state: 'missing' | 'directory';
  canonicalPath: string;
  parentCanonicalPath: string;
  parentDevice: number;
  parentInode: number;
  device?: number;
  inode?: number;
}

export interface PreflightEntry {
  pathParts: readonly string[];
  relativePath: string;
  stagedType: 'file' | 'directory';
  origin?: StagedOrigin;
  action: PreflightAction;
  detail: string;
  stagedHash?: string;
  stagedMode?: number;
  destination: {
    type: 'missing' | TreeEntryType;
    contentHash?: string;
    mode?: number;
  };
}

export interface MergePreflight {
  stagingRoot: string;
  targetRoot: string;
  targetRootSnapshot: TargetRootSnapshot;
  entries: readonly PreflightEntry[];
  replacements: readonly PreflightEntry[];
  blocked: readonly PreflightEntry[];
}

export interface MergeResult {
  created: string[];
  replaced: string[];
  identical: string[];
  mergedDirectories: string[];
}

export interface RollbackReport {
  restored: string[];
  removed: string[];
  failures: string[];
}

export class InitFileSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitFileSystemError';
  }
}

export class MergeApplyError extends InitFileSystemError {
  constructor(message: string, public readonly rollback: RollbackReport) {
    super(message);
    this.name = 'MergeApplyError';
  }
}

const authorizedMergePlans = new WeakSet<object>();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function portablePath(pathParts: readonly string[]): string {
  return pathParts.join('/');
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isPathWithin(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => normalizeComparisonPath(value, platform);
  const rootValue = normalize(root).replace(/\/+$/g, '');
  const candidateValue = normalize(candidate);
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}/`);
}

export function normalizeComparisonPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = (platform === 'win32' ? path.win32.resolve(value) : path.resolve(value))
    .replaceAll('\\', '/')
    .replace(/\/+$/g, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function discoverGitRoot(
  cwd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform
): Promise<GitRootDiscovery> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch (error) {
    throw new InitFileSystemError(`Unable to resolve working directory ${cwd}: ${errorMessage(error)}`);
  }
  const result = await runner.run(
    { executable: 'git', args: ['rev-parse', '--show-toplevel'] },
    { cwd: canonicalCwd, timeoutMs: 15_000 }
  );
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    if (
      !result.timedOut &&
      result.errorCode === undefined &&
      /not a git repository/i.test(stderr)
    ) {
      return { cwd, canonicalCwd, exact: false };
    }
    const detail = result.timedOut
      ? 'the command timed out'
      : (result.errorMessage ?? stderr) || `git exited with status ${result.status}`;
    throw new InitFileSystemError(`Unable to determine the Git worktree root: ${detail}`);
  }
  const reportedRoot = result.stdout.trim().split(/\r?\n/)[0];
  if (!reportedRoot) {
    return { cwd, canonicalCwd, exact: false };
  }
  let root: string;
  try {
    root = await realpath(path.resolve(canonicalCwd, reportedRoot));
  } catch (error) {
    throw new InitFileSystemError(`Git reported an unreadable worktree root ${reportedRoot}: ${errorMessage(error)}`);
  }
  return {
    cwd,
    canonicalCwd,
    root,
    exact: normalizeComparisonPath(root, platform) === normalizeComparisonPath(canonicalCwd, platform)
  };
}

export async function resolveInitTarget(
  cwd: string,
  safeProjectName: string,
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform
): Promise<InitTarget> {
  const git = await discoverGitRoot(cwd, runner, platform);
  return resolveInitTargetFromDiscovery(git, safeProjectName);
}

export function resolveInitTargetFromDiscovery(
  git: GitRootDiscovery,
  safeProjectName: string
): InitTarget {
  if (git.exact && git.root) {
    return { root: git.root, mode: 'in-place', gitRoot: git.root };
  }
  return {
    root: path.join(git.canonicalCwd, safeProjectName),
    mode: 'named-child',
    ...(git.root ? { gitRoot: git.root } : {})
  };
}

export async function assertSafeInitTarget(
  target: InitTarget,
  confinementRoot?: string
): Promise<void> {
  let canonicalTarget: string;
  try {
    const details = await lstat(target.root);
    if (details.isSymbolicLink()) {
      throw new InitFileSystemError(`Initialization target is a symlink and cannot be overwritten: ${target.root}`);
    }
    if (!details.isDirectory()) {
      throw new InitFileSystemError(`Initialization target exists and is not a directory: ${target.root}`);
    }
    try {
      await lstat(path.join(target.root, 'liftoff.manifest.json'));
      throw new InitFileSystemError(
        `A Liftoff manifest already exists at ${target.root}. Use \`liftoff update\` instead.`
      );
    } catch (error) {
      if (error instanceof InitFileSystemError) {
        throw error;
      }
      if (errorCode(error) !== 'ENOENT') {
        throw new InitFileSystemError(`Unable to inspect the Liftoff manifest guard: ${errorMessage(error)}`);
      }
    }
    canonicalTarget = await realpath(target.root);
  } catch (error) {
    if (error instanceof InitFileSystemError) {
      throw error;
    }
    if (errorCode(error) !== 'ENOENT') {
      throw new InitFileSystemError(`Unable to inspect initialization target ${target.root}: ${errorMessage(error)}`);
    }
    const parent = path.dirname(target.root);
    let details;
    try {
      details = await lstat(parent);
    } catch (parentError) {
      throw new InitFileSystemError(`Initialization target parent is unavailable: ${errorMessage(parentError)}`);
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new InitFileSystemError(`Initialization target has an unsafe parent: ${parent}`);
    }
    canonicalTarget = path.join(await realpath(parent), path.basename(target.root));
  }

  if (confinementRoot) {
    const canonicalConfinement = await realpath(confinementRoot);
    if (!isPathWithin(canonicalConfinement, canonicalTarget, process.platform)) {
      throw new InitFileSystemError(`Initialization target escapes the working directory: ${target.root}`);
    }
  }
}

export async function withStagingArea<T>(
  operation: (area: StagingArea) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-init-'));
  const area: StagingArea = {
    root,
    origins: new Map(),
    frameworkAllowedRoots: new Set()
  };
  try {
    return await operation(area);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeStagedArtifacts(
  area: StagingArea,
  artifacts: GeneratedArtifact[],
  origin: StagedOrigin
): Promise<void> {
  for (const artifact of artifacts) {
    const pathParts = validateArtifactPathParts(artifact.pathParts);
    await writeProjectFile(area.root, pathParts, artifact.content);
    area.origins.set(portablePath(pathParts), origin);
  }
}

async function walkTree(root: string): Promise<TreeStateEntry[]> {
  const entries: TreeStateEntry[] = [];
  const visit = async (pathParts: string[]): Promise<void> => {
    const current = path.join(root, ...pathParts);
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => comparePortable(left.name, right.name));
    for (const child of children) {
      const childParts = [...pathParts, child.name];
      validateArtifactPathParts(childParts, 'Staged path');
      const childPath = path.join(root, ...childParts);
      const details = await lstat(childPath);
      if (details.isSymbolicLink()) {
        entries.push({ pathParts: childParts, type: 'symlink' });
      } else if (details.isDirectory()) {
        entries.push({ pathParts: childParts, type: 'directory', mode: details.mode & 0o7777 });
        await visit(childParts);
      } else if (details.isFile()) {
        const content = await readFile(childPath);
        entries.push({
          pathParts: childParts,
          type: 'file',
          contentHash: hash(content),
          mode: details.mode & 0o7777
        });
      } else {
        entries.push({ pathParts: childParts, type: 'other' });
      }
    }
  };
  await visit([]);
  return entries;
}

export async function captureTreeState(root: string): Promise<Map<string, TreeStateEntry>> {
  const state = new Map<string, TreeStateEntry>();
  for (const entry of await walkTree(root)) {
    state.set(portablePath(entry.pathParts), entry);
  }
  return state;
}

export async function claimFrameworkChanges(
  area: StagingArea,
  before: Map<string, TreeStateEntry>,
  allowedRoots: string[]
): Promise<string[]> {
  const after = await captureTreeState(area.root);
  const changed = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(key);
    const next = after.get(key);
    if (
      previous?.type !== next?.type ||
      previous?.contentHash !== next?.contentHash ||
      previous?.mode !== next?.mode
    ) {
      changed.add(key);
    }
  }
  const sorted = [...changed].sort(comparePortable);
  for (const key of sorted) {
    const root = key.split('/')[0];
    if (!allowedRoots.includes(root)) {
      throw new InitFileSystemError(`Framework initializer wrote outside its approved roots: ${key}`);
    }
    const entry = after.get(key);
    if (entry?.type === 'file' || entry?.type === 'symlink' || entry?.type === 'other') {
      area.origins.set(key, 'framework');
    }
  }
  for (const root of allowedRoots) {
    area.frameworkAllowedRoots.add(root);
  }
  return sorted;
}

export async function validateStagedTree(area: StagingArea): Promise<ValidatedStagedFile[]> {
  let state: Map<string, TreeStateEntry>;
  try {
    state = await captureTreeState(area.root);
  } catch (error) {
    throw new InitFileSystemError(`Unable to read staged output: ${errorMessage(error)}`);
  }
  const files: ValidatedStagedFile[] = [];
  for (const [relativePath, entry] of state) {
    if (entry.type === 'symlink') {
      throw new InitFileSystemError(`Staged output contains a forbidden symlink: ${relativePath}`);
    }
    if (entry.type === 'other') {
      throw new InitFileSystemError(`Staged output contains an unsupported filesystem entry: ${relativePath}`);
    }
    if (entry.type !== 'file') {
      continue;
    }
    const origin = area.origins.get(relativePath);
    if (!origin) {
      throw new InitFileSystemError(`Staged file has no declared owner: ${relativePath}`);
    }
    if (origin === 'framework' && !area.frameworkAllowedRoots.has(entry.pathParts[0])) {
      throw new InitFileSystemError(`Framework-owned staged file is outside approved roots: ${relativePath}`);
    }
    let content: Buffer;
    try {
      content = await readFile(path.join(area.root, ...entry.pathParts));
    } catch (error) {
      throw new InitFileSystemError(`Staged file is unreadable at ${relativePath}: ${errorMessage(error)}`);
    }
    files.push({
      pathParts: entry.pathParts,
      relativePath,
      content,
      contentHash: hash(content),
      mode: entry.mode ?? 0o666,
      origin
    });
  }
  return files.sort((left, right) => comparePortable(left.relativePath, right.relativePath));
}

async function inspectDestination(
  targetRoot: string,
  pathParts: readonly string[]
): Promise<{ type: 'missing' | TreeEntryType; contentHash?: string; mode?: number; detail?: string }> {
  let current = targetRoot;
  for (const [index, part] of pathParts.entries()) {
    current = path.join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { type: 'missing' };
      }
      throw new InitFileSystemError(`Unable to inspect destination ${portablePath(pathParts)}: ${errorMessage(error)}`);
    }
    if (details.isSymbolicLink()) {
      return { type: 'symlink', detail: `symlink at ${portablePath(pathParts.slice(0, index + 1))}` };
    }
    if (index < pathParts.length - 1 && !details.isDirectory()) {
      return { type: details.isFile() ? 'file' : 'other', detail: `non-directory ancestor at ${portablePath(pathParts.slice(0, index + 1))}` };
    }
    if (index === pathParts.length - 1) {
      if (details.isDirectory()) {
        return { type: 'directory' };
      }
      if (details.isFile()) {
        const content = await readFile(current);
        return { type: 'file', contentHash: hash(content), mode: details.mode & 0o7777 };
      }
      return { type: 'other' };
    }
  }
  return { type: 'missing' };
}

async function captureTargetRootSnapshot(targetRoot: string): Promise<TargetRootSnapshot> {
  const parent = path.dirname(targetRoot);
  let parentDetails;
  try {
    parentDetails = await lstat(parent);
  } catch (error) {
    throw new InitFileSystemError(`Initialization target parent is unavailable: ${errorMessage(error)}`);
  }
  if (parentDetails.isSymbolicLink() || !parentDetails.isDirectory()) {
    throw new InitFileSystemError(`Initialization target has an unsafe parent: ${parent}`);
  }
  const parentCanonicalPath = await realpath(parent);
  const parentIdentity = {
    parentCanonicalPath,
    parentDevice: parentDetails.dev,
    parentInode: parentDetails.ino
  };

  let details;
  try {
    details = await lstat(targetRoot);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        state: 'missing',
        canonicalPath: path.join(parentCanonicalPath, path.basename(targetRoot)),
        ...parentIdentity
      };
    }
    throw new InitFileSystemError(`Unable to inspect initialization target ${targetRoot}: ${errorMessage(error)}`);
  }
  if (details.isSymbolicLink()) {
    throw new InitFileSystemError(`Initialization target is a symlink and cannot be overwritten: ${targetRoot}`);
  }
  if (!details.isDirectory()) {
    throw new InitFileSystemError(`Initialization target exists and is not a directory: ${targetRoot}`);
  }
  return {
    state: 'directory',
    canonicalPath: await realpath(targetRoot),
    device: details.dev,
    inode: details.ino,
    ...parentIdentity
  };
}

async function assertTargetRootSnapshot(expected: TargetRootSnapshot, targetRoot: string): Promise<void> {
  const current = await captureTargetRootSnapshot(targetRoot);
  if (
    current.state !== expected.state ||
    current.canonicalPath !== expected.canonicalPath ||
    current.parentCanonicalPath !== expected.parentCanonicalPath ||
    current.parentDevice !== expected.parentDevice ||
    current.parentInode !== expected.parentInode ||
    current.device !== expected.device ||
    current.inode !== expected.inode
  ) {
    throw new InitFileSystemError(`Initialization target root changed after preflight: ${targetRoot}`);
  }
}

export async function buildMergePreflight(
  area: StagingArea,
  targetRoot: string
): Promise<MergePreflight> {
  const targetRootSnapshot = await captureTargetRootSnapshot(targetRoot);
  const files = await validateStagedTree(area);
  const fileMap = new Map(files.map((file) => [file.relativePath, file]));
  const state = await captureTreeState(area.root);
  const entries: PreflightEntry[] = [];
  for (const [relativePath, staged] of state) {
    if (staged.type !== 'file' && staged.type !== 'directory') {
      continue;
    }
    const destination = await inspectDestination(targetRoot, staged.pathParts);
    const stagedFile = fileMap.get(relativePath);
    let action: PreflightAction;
    let detail: string;
    if (relativePath === 'liftoff.manifest.json' && destination.type !== 'missing') {
      action = 'blocked';
      detail = 'an existing Liftoff manifest must be handled with liftoff update';
    } else if (destination.type === 'missing') {
      action = 'create';
      detail = staged.type === 'directory' ? 'create directory' : 'create file';
    } else if (staged.type === 'directory' && destination.type === 'directory') {
      action = 'merge-directory';
      detail = 'merge with existing directory';
    } else if (staged.type === 'file' && destination.type === 'file') {
      action = stagedFile?.contentHash === destination.contentHash ? 'identical' : 'replace';
      detail = action === 'identical' ? 'identical regular file' : 'replace different regular file';
    } else {
      action = 'blocked';
      detail = destination.detail ?? `staged ${staged.type} conflicts with destination ${destination.type}`;
    }
    entries.push(Object.freeze({
      pathParts: Object.freeze([...staged.pathParts]),
      relativePath,
      stagedType: staged.type,
      ...(stagedFile
        ? {
            origin: stagedFile.origin,
            stagedHash: stagedFile.contentHash,
            stagedMode: stagedFile.mode
          }
        : {}),
      action,
      detail,
      destination: Object.freeze({
        type: destination.type,
        ...(destination.contentHash ? { contentHash: destination.contentHash } : {}),
        ...(destination.mode !== undefined ? { mode: destination.mode } : {})
      })
    }));
  }
  entries.sort((left, right) => comparePortable(left.relativePath, right.relativePath));
  await assertTargetRootSnapshot(targetRootSnapshot, targetRoot);
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    stagingRoot: area.root,
    targetRoot,
    targetRootSnapshot: Object.freeze(targetRootSnapshot),
    entries: frozenEntries,
    replacements: Object.freeze(entries.filter((entry) => entry.action === 'replace')),
    blocked: Object.freeze(entries.filter((entry) => entry.action === 'blocked'))
  });
}

export async function authorizeMergePreflight(
  preflight: MergePreflight,
  force: boolean,
  confirm?: (replacementPaths: readonly string[]) => Promise<boolean>
): Promise<MergePreflight | undefined> {
  if (preflight.blocked.length > 0) {
    throw new InitFileSystemError(
      `Initialization is blocked by structural or symlink conflicts:\n${preflight.blocked.map((entry) => `- ${entry.relativePath}: ${entry.detail}`).join('\n')}`
    );
  }
  if (preflight.replacements.length === 0 || force) {
    authorizedMergePlans.add(preflight);
    return preflight;
  }
  if (!confirm) {
    return undefined;
  }
  if (!await confirm(preflight.replacements.map((entry) => entry.relativePath))) {
    return undefined;
  }
  authorizedMergePlans.add(preflight);
  return preflight;
}

async function assertPreflightEntryCurrent(targetRoot: string, entry: PreflightEntry): Promise<void> {
  const current = await inspectDestination(targetRoot, entry.pathParts);
  if (
    current.type !== entry.destination.type ||
    current.contentHash !== entry.destination.contentHash ||
    current.mode !== entry.destination.mode
  ) {
    throw new InitFileSystemError(`Destination changed after preflight: ${entry.relativePath}`);
  }
}

type RollbackAction =
  | {
      type: 'created-file';
      pathParts: readonly string[];
      relativePath: string;
      contentHash: string;
      mode: number;
    }
  | {
      type: 'replaced-file';
      pathParts: readonly string[];
      relativePath: string;
      backupPath: string;
      originalContent: Buffer;
      originalMode: number;
      replacementHash: string;
      replacementMode: number;
    }
  | { type: 'created-directory'; pathParts: readonly string[]; relativePath: string };

interface TargetLock {
  path: string;
  handle: FileHandle;
  device: number;
  inode: number;
}

async function acquireTargetLock(targetRoot: string): Promise<TargetLock> {
  const lockPath = path.join(targetRoot, '.liftoff-init.lock');
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    throw new InitFileSystemError(
      errorCode(error) === 'EEXIST'
        ? `Another Liftoff initialization is already modifying ${targetRoot}.`
        : `Unable to lock initialization target ${targetRoot}: ${errorMessage(error)}`
    );
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    const details = await handle.stat();
    return { path: lockPath, handle, device: details.dev, inode: details.ino };
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
}

async function assertTargetLock(lock: TargetLock): Promise<void> {
  const details = await lstat(lock.path);
  if (!details.isFile() || details.dev !== lock.device || details.ino !== lock.inode) {
    throw new InitFileSystemError('Initialization target lock changed while the merge was running.');
  }
}

async function releaseTargetLock(lock: TargetLock): Promise<void> {
  await lock.handle.close();
  try {
    const details = await lstat(lock.path);
    if (details.dev === lock.device && details.ino === lock.inode) {
      await unlink(lock.path);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeBufferNoClobber(
  targetRoot: string,
  pathParts: readonly string[],
  content: Buffer,
  mode: number
): Promise<void> {
  const destination = path.join(targetRoot, ...pathParts);
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.liftoff-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function moveCurrentFileToBackup(
  targetRoot: string,
  entry: PreflightEntry
): Promise<{ backupPath: string; content: Buffer; mode: number }> {
  const destination = path.join(targetRoot, ...entry.pathParts);
  const backupPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.liftoff-${randomUUID()}.bak`
  );
  await rename(destination, backupPath);
  try {
    const details = await lstat(backupPath);
    if (!details.isFile()) {
      throw new InitFileSystemError(`Destination changed after preflight: ${entry.relativePath}`);
    }
    const content = await readFile(backupPath);
    const mode = details.mode & 0o7777;
    if (
      hash(content) !== entry.destination.contentHash ||
      mode !== entry.destination.mode
    ) {
      throw new InitFileSystemError(`Destination changed after preflight: ${entry.relativePath}`);
    }
    return { backupPath, content, mode };
  } catch (error) {
    try {
      await link(backupPath, destination);
      await unlink(backupPath);
    } catch (restoreError) {
      throw new InitFileSystemError(
        `${errorMessage(error)} Original file remains at ${backupPath}; automatic restoration failed: ${errorMessage(restoreError)}`
      );
    }
    throw error;
  }
}

async function assertOwnedFile(
  filePath: string,
  expectedHash: string,
  expectedMode: number
): Promise<void> {
  const details = await lstat(filePath);
  if (!details.isFile()) {
    throw new InitFileSystemError('Destination is no longer a regular file.');
  }
  if (
    hash(await readFile(filePath)) !== expectedHash ||
    (details.mode & 0o7777) !== expectedMode
  ) {
    throw new InitFileSystemError('Destination content or mode changed after Liftoff wrote it.');
  }
}

async function rollbackMerge(targetRoot: string, actions: RollbackAction[]): Promise<RollbackReport> {
  const report: RollbackReport = { restored: [], removed: [], failures: [] };
  for (const action of [...actions].reverse()) {
    try {
      if (action.type === 'replaced-file') {
        const destination = path.join(targetRoot, ...action.pathParts);
        try {
          await assertOwnedFile(destination, action.replacementHash, action.replacementMode);
          await unlink(destination);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            throw error;
          }
        }
        try {
          await link(action.backupPath, destination);
          await unlink(action.backupPath);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            throw error;
          }
          await writeBufferNoClobber(
            targetRoot,
            action.pathParts,
            action.originalContent,
            action.originalMode
          );
        }
        report.restored.push(action.relativePath);
      } else if (action.type === 'created-file') {
        const destination = path.join(targetRoot, ...action.pathParts);
        await assertOwnedFile(destination, action.contentHash, action.mode);
        await unlink(destination);
        report.removed.push(action.relativePath);
      } else {
        await rmdir(path.join(targetRoot, ...action.pathParts));
        report.removed.push(action.relativePath);
      }
    } catch (error) {
      report.failures.push(`${action.relativePath}: ${errorMessage(error)}`);
    }
  }
  return report;
}

async function discardReplacementBackups(actions: RollbackAction[]): Promise<void> {
  for (const action of actions) {
    if (action.type === 'replaced-file') {
      await unlink(action.backupPath);
    }
  }
}

async function assertFreshTarget(targetRoot: string, lock: TargetLock): Promise<void> {
  const entries = (await readdir(targetRoot)).filter((entry) => path.join(targetRoot, entry) !== lock.path);
  if (entries.length > 0) {
    throw new InitFileSystemError(
      `Migration target must remain new or empty; found ${entries.sort(comparePortable).join(', ')}.`
    );
  }
}

function mutationOrder(entries: readonly PreflightEntry[]): PreflightEntry[] {
  return [...entries].sort((left, right) => {
    if (left.stagedType !== right.stagedType) {
      return left.stagedType === 'directory' ? -1 : 1;
    }
    if (left.relativePath === 'liftoff.manifest.json') {
      return 1;
    }
    if (right.relativePath === 'liftoff.manifest.json') {
      return -1;
    }
    return comparePortable(left.relativePath, right.relativePath);
  });
}

export async function applyMergePreflight(
  preflight: MergePreflight,
  options: {
    onBeforeMutation?: (entry: PreflightEntry, index: number) => Promise<void>;
    requireEmptyTarget?: boolean;
  } = {}
): Promise<MergeResult> {
  if (!authorizedMergePlans.has(preflight)) {
    throw new InitFileSystemError('Merge preflight must be authorized before applying.');
  }
  const result: MergeResult = { created: [], replaced: [], identical: [], mergedDirectories: [] };
  const actions: RollbackAction[] = [];
  const entries = mutationOrder(preflight.entries);
  let createdTargetRoot = false;
  let activeTargetRootSnapshot = preflight.targetRootSnapshot;
  let targetLock: TargetLock | undefined;
  try {
    await assertTargetRootSnapshot(preflight.targetRootSnapshot, preflight.targetRoot);
    if (preflight.targetRootSnapshot.state === 'missing') {
      await mkdir(preflight.targetRoot);
      createdTargetRoot = true;
      activeTargetRootSnapshot = await captureTargetRootSnapshot(preflight.targetRoot);
      if (
        activeTargetRootSnapshot.state !== 'directory' ||
        activeTargetRootSnapshot.canonicalPath !== preflight.targetRootSnapshot.canonicalPath ||
        activeTargetRootSnapshot.parentCanonicalPath !== preflight.targetRootSnapshot.parentCanonicalPath ||
        activeTargetRootSnapshot.parentDevice !== preflight.targetRootSnapshot.parentDevice ||
        activeTargetRootSnapshot.parentInode !== preflight.targetRootSnapshot.parentInode
      ) {
        throw new InitFileSystemError(`Initialization target root changed while it was being created: ${preflight.targetRoot}`);
      }
    }
    targetLock = await acquireTargetLock(preflight.targetRoot);
    await assertTargetRootSnapshot(activeTargetRootSnapshot, preflight.targetRoot);
    await assertTargetLock(targetLock);
    if (options.requireEmptyTarget) {
      await assertFreshTarget(preflight.targetRoot, targetLock);
    }
    for (const entry of entries) {
      await assertPreflightEntryCurrent(preflight.targetRoot, entry);
    }
    for (const [index, entry] of entries.entries()) {
      await options.onBeforeMutation?.(entry, index);
      await assertTargetRootSnapshot(activeTargetRootSnapshot, preflight.targetRoot);
      await assertTargetLock(targetLock);
      await assertPreflightEntryCurrent(preflight.targetRoot, entry);
      if (entry.action === 'merge-directory') {
        result.mergedDirectories.push(entry.relativePath);
        continue;
      }
      if (entry.action === 'identical') {
        result.identical.push(entry.relativePath);
        continue;
      }
      if (entry.action === 'blocked') {
        throw new InitFileSystemError(`Blocked preflight entry reached merge: ${entry.relativePath}`);
      }
      if (entry.stagedType === 'directory') {
        await mkdir(path.join(preflight.targetRoot, ...entry.pathParts));
        actions.push({ type: 'created-directory', pathParts: entry.pathParts, relativePath: entry.relativePath });
        result.created.push(entry.relativePath);
        continue;
      }

      const stagedContent = await readFile(path.join(preflight.stagingRoot, ...entry.pathParts));
      const stagedMode = entry.stagedMode ?? 0o666;
      if (entry.action === 'replace') {
        const original = await moveCurrentFileToBackup(preflight.targetRoot, entry);
        actions.push({
          type: 'replaced-file',
          pathParts: entry.pathParts,
          relativePath: entry.relativePath,
          backupPath: original.backupPath,
          originalContent: original.content,
          originalMode: original.mode,
          replacementHash: hash(stagedContent),
          replacementMode: stagedMode
        });
        await writeBufferNoClobber(preflight.targetRoot, entry.pathParts, stagedContent, stagedMode);
        result.replaced.push(entry.relativePath);
      } else {
        await writeBufferNoClobber(preflight.targetRoot, entry.pathParts, stagedContent, stagedMode);
        actions.push({
          type: 'created-file',
          pathParts: entry.pathParts,
          relativePath: entry.relativePath,
          contentHash: hash(stagedContent),
          mode: stagedMode
        });
        result.created.push(entry.relativePath);
      }
    }
    await discardReplacementBackups(actions);
    return result;
  } catch (error) {
    let rollback: RollbackReport;
    try {
      await assertTargetRootSnapshot(activeTargetRootSnapshot, preflight.targetRoot);
      rollback = await rollbackMerge(preflight.targetRoot, actions);
    } catch (rollbackError) {
      rollback = {
        restored: [],
        removed: [],
        failures: [`.: rollback refused because the target root changed: ${errorMessage(rollbackError)}`]
      };
    }
    if (targetLock) {
      try {
        await releaseTargetLock(targetLock);
        targetLock = undefined;
      } catch (lockError) {
        rollback.failures.push(`.liftoff-init.lock: ${errorMessage(lockError)}`);
      }
    }
    if (createdTargetRoot) {
      try {
        await rmdir(preflight.targetRoot);
        rollback.removed.push('.');
      } catch (rollbackError) {
        rollback.failures.push(`.: ${errorMessage(rollbackError)}`);
      }
    }
    throw new MergeApplyError(`Initialization merge failed: ${errorMessage(error)}`, rollback);
  } finally {
    if (targetLock) {
      await releaseTargetLock(targetLock);
    }
  }
}
