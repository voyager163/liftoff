import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import {
  RepairWorkspaceError, repairWorkspaceRoleNames,
  type RepairWorkspaceFileIdentity, type RepairWorkspaceRecord, type RepairWorkspaceStorageOptions
} from '../../application/repair/workspaces-types.js';
import { sameWorkspaceFileIdentity, workspaceDigest } from '../../application/repair/workspaces-records.js';
import { resolveUpdatePreviewLocation, getUpdatePreviewDirectory, type UpdatePreviewPathOptions } from './update-previews.js';

export const repairWorkspaceDirectoryParts = ['repair-workspaces'] as const;
export const maximumWorkspaceCleanupEntries = 250_000;
export const maximumWorkspaceCleanupDepth = 64;
export type WorkspaceDirectorySnapshot = ReadonlyMap<string, RepairWorkspaceFileIdentity>;

export interface RepairWorkspaceLocation {
  projectRoot: string;
  projectIdentity: RepairWorkspaceFileIdentity;
  projectKey: string;
  registryDirectory: string;
  root: string;
  privateRoot: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function workspaceFileIdentity(details: BigIntStats): RepairWorkspaceFileIdentity {
  if (details.ino === 0n && details.birthtimeNs === 0n) {
    throw new RepairWorkspaceError('identity-changed', 'The filesystem does not expose a stable creation identity for private cleanup.');
  }
  return { device: details.dev.toString(), inode: details.ino.toString(), birthtime: details.birthtimeNs.toString() };
}

function normalizedNativeRealpath(value: string): string {
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\?\\UNC\\')) return path.normalize(`\\\\${value.slice(8)}`);
    if (/^\\\\\?\\[a-z]:\\/iu.test(value)) return path.normalize(value.slice(4));
  }
  return path.normalize(value);
}

export function workspaceWithin(root: string, candidate: string): boolean {
  const fold = (value: string) => value.normalize('NFC').toLowerCase();
  const relative = path.relative(fold(root), fold(candidate));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertWorkspaceDisjoint(...directories: readonly string[]): void {
  for (let index = 0; index < directories.length; index++) {
    for (const other of directories.slice(index + 1)) {
      if (workspaceWithin(directories[index]!, other) || workspaceWithin(other, directories[index]!)) {
        throw new RepairWorkspaceError('scope-mismatch', 'Private workspace storage, original project and user patch staging must be disjoint.');
      }
    }
  }
}

async function detailsOrAbsent(target: string): Promise<BigIntStats | null> {
  try { return await lstat(target, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function regularDirectory(details: BigIntStats): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new RepairWorkspaceError('unsafe-path', 'Workspace boundaries must be regular directories, not links, junctions or other file types.');
  }
}

function privateDirectory(details: BigIntStats): void {
  regularDirectory(details);
  if (process.platform !== 'win32' && ((details.mode & 0o077n) !== 0n ||
    process.getuid !== undefined && details.uid !== BigInt(process.getuid()))) {
    throw new RepairWorkspaceError('permission-denied', 'Private workspace storage requires owner-only directory access.');
  }
}

async function assertExactChildName(parent: string, name: string): Promise<void> {
  const folded = name.normalize('NFC').toLowerCase();
  const aliases = (await readdir(parent)).filter((entry) => entry.normalize('NFC').toLowerCase() === folded);
  if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== name) {
    throw new RepairWorkspaceError('unsafe-path', 'A workspace path has a case or normalization alias.');
  }
}

export async function captureWorkspaceDirectoryChain(directory: string): Promise<Map<string, RepairWorkspaceFileIdentity>> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new RepairWorkspaceError('unsafe-path', 'Workspace boundaries require normalized absolute native paths.');
  }
  const root = path.parse(directory).root;
  const components = path.relative(root, directory).split(path.sep).filter(Boolean);
  validateArtifactPathParts(components.length ? components : ['root']);
  const snapshot = new Map<string, RepairWorkspaceFileIdentity>();
  let current = root;
  const rootDetails = await lstat(root, { bigint: true });
  regularDirectory(rootDetails);
  snapshot.set(root, workspaceFileIdentity(rootDetails));
  for (const component of components) {
    await assertExactChildName(current, component);
    current = path.join(current, component);
    const details = await lstat(current, { bigint: true });
    regularDirectory(details);
    if (normalizedNativeRealpath(await realpath(current)) !== current) {
      throw new RepairWorkspaceError('unsafe-path', 'A workspace ancestor resolves through an unsafe alias.');
    }
    snapshot.set(current, workspaceFileIdentity(details));
  }
  return snapshot;
}

export async function assertWorkspaceDirectorySnapshot(snapshot: WorkspaceDirectorySnapshot): Promise<void> {
  for (const [directory, identity] of snapshot) {
    const details = await lstat(directory, { bigint: true });
    regularDirectory(details);
    if (!sameWorkspaceFileIdentity(identity, workspaceFileIdentity(details)) ||
      normalizedNativeRealpath(await realpath(directory)) !== directory) {
      throw new RepairWorkspaceError('identity-changed', 'A workspace directory or ancestor changed identity; replacement paths were preserved.');
    }
  }
}

export async function canonicalWorkspaceBoundary(directory: string): Promise<{ directory: string; identity: RepairWorkspaceFileIdentity }> {
  const snapshot = await captureWorkspaceDirectoryChain(directory);
  await assertWorkspaceDirectorySnapshot(snapshot);
  return { directory, identity: snapshot.get(directory)! };
}

export function getRepairWorkspaceRoot(options: UpdatePreviewPathOptions = {}): string {
  const paths = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  return paths.join(getUpdatePreviewDirectory(options), ...repairWorkspaceDirectoryParts);
}

export async function repairWorkspaceLocation(
  projectRoot: string, options: RepairWorkspaceStorageOptions
): Promise<RepairWorkspaceLocation> {
  if (options.platform !== undefined && options.platform !== process.platform) {
    throw new RepairWorkspaceError('unsupported-record', 'Workspace effects require the native filesystem platform; simulated paths cannot authorize cleanup.');
  }
  const project = await canonicalWorkspaceBoundary(projectRoot);
  const location = await resolveUpdatePreviewLocation(projectRoot, options);
  if (location.projectRoot !== project.directory) {
    throw new RepairWorkspaceError('scope-mismatch', 'Workspace project spelling changed during boundary resolution.');
  }
  return {
    projectRoot, projectIdentity: project.identity, projectKey: location.projectKey,
    registryDirectory: location.directory,
    privateRoot: path.dirname(location.directory),
    root: path.join(location.directory, ...repairWorkspaceDirectoryParts, location.projectKey)
  };
}

export function repairWorkspaceDirectory(location: RepairWorkspaceLocation, workspaceId: string): string {
  workspaceDigest(workspaceId);
  return path.join(location.root, workspaceId);
}

export async function ensureRepairWorkspaceParents(location: RepairWorkspaceLocation): Promise<WorkspaceDirectorySnapshot> {
  const existing = await captureWorkspaceDirectoryChain(location.registryDirectory);
  let current = location.registryDirectory;
  for (const part of [...repairWorkspaceDirectoryParts, location.projectKey]) {
    await assertWorkspaceDirectorySnapshot(existing);
    await assertExactChildName(current, part);
    current = path.join(current, part);
    let details = await detailsOrAbsent(current);
    if (!details) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
      details = await lstat(current, { bigint: true });
    }
    privateDirectory(details);
    if (normalizedNativeRealpath(await realpath(current)) !== current) {
      throw new RepairWorkspaceError('unsafe-path', 'Private workspace parent resolves through an alias.');
    }
    existing.set(current, workspaceFileIdentity(details));
  }
  await assertWorkspaceDirectorySnapshot(existing);
  return existing;
}

export async function createRegisteredWorkspaceDirectory(
  directory: string, parents: WorkspaceDirectorySnapshot, options: RepairWorkspaceStorageOptions
): Promise<RepairWorkspaceFileIdentity> {
  await options.beforeWorkspaceOperation?.('mkdir', directory);
  await assertWorkspaceDirectorySnapshot(parents);
  await assertExactChildName(path.dirname(directory), path.basename(directory));
  await mkdir(directory, { mode: 0o700 });
  const details = await lstat(directory, { bigint: true });
  privateDirectory(details);
  if (normalizedNativeRealpath(await realpath(directory)) !== directory) {
    throw new RepairWorkspaceError('unsafe-path', 'Created private workspace directory resolves through an alias.');
  }
  await assertWorkspaceDirectorySnapshot(parents);
  return workspaceFileIdentity(details);
}

export async function assertRegisteredWorkspace(
  record: RepairWorkspaceRecord, location: RepairWorkspaceLocation, allowMissing: boolean
): Promise<boolean> {
  const project = await canonicalWorkspaceBoundary(record.projectRoot);
  if (!sameWorkspaceFileIdentity(project.identity, record.projectIdentity)) {
    throw new RepairWorkspaceError('scope-mismatch', 'Original project directory identity changed; workspace recovery remains blocked.');
  }
  const staging = await canonicalWorkspaceBoundary(record.patchStagingRoot);
  if (!sameWorkspaceFileIdentity(staging.identity, record.patchStagingIdentity)) {
    throw new RepairWorkspaceError('scope-mismatch', 'User patch-staging identity changed; workspace recovery remains blocked.');
  }
  assertWorkspaceDisjoint(record.projectRoot, record.patchStagingRoot, location.root);
  const parents = await captureWorkspaceDirectoryChain(location.root);
  for (const directory of parents.keys()) {
    if (workspaceWithin(location.privateRoot, directory)) privateDirectory(await lstat(directory, { bigint: true }));
  }
  const root = await detailsOrAbsent(record.directory);
  if (!root) {
    if (allowMissing) return false;
    throw new RepairWorkspaceError('workspace-missing', 'Registered workspace disappeared before cleanup authority was established.');
  }
  privateDirectory(root);
  if (!record.creationIdentity || !sameWorkspaceFileIdentity(record.creationIdentity, workspaceFileIdentity(root))) {
    throw new RepairWorkspaceError('identity-changed', 'Registered workspace creation identity changed; no replacement is owned.');
  }
  parents.set(record.directory, record.creationIdentity);
  for (const role of repairWorkspaceRoleNames) {
    const expected = record.roles[role];
    await assertExactChildName(record.directory, role);
    const actual = await detailsOrAbsent(expected.path);
    if (!actual) {
      if (allowMissing || expected.identity === null) continue;
      throw new RepairWorkspaceError('workspace-missing', 'A registered private workspace role disappeared.');
    }
    privateDirectory(actual);
    if (!expected.identity || !sameWorkspaceFileIdentity(expected.identity, workspaceFileIdentity(actual))) {
      throw new RepairWorkspaceError('identity-changed', 'A registered private workspace role changed creation identity.');
    }
    if (normalizedNativeRealpath(await realpath(expected.path)) !== expected.path) {
      throw new RepairWorkspaceError('unsafe-path', 'A registered private role resolves through an alias.');
    }
  }
  const names = await readdir(record.directory);
  if (names.some((name) => !repairWorkspaceRoleNames.some((role) => role === name))) {
    throw new RepairWorkspaceError('unsafe-path', 'Unregistered entries exist beside the fixed private workspace roles.');
  }
  await assertWorkspaceDirectorySnapshot(parents);
  return true;
}

interface CleanupEntry {
  path: string;
  identity: RepairWorkspaceFileIdentity;
  kind: 'file' | 'directory' | 'internal-file-link';
  link?: string;
  mode: bigint;
  nlink: bigint;
}

async function inspectInternalFileLink(target: string, workspace: string): Promise<string> {
  const link = await readlink(target);
  const destination = path.resolve(path.dirname(target), link);
  if (destination === workspace || workspaceWithin(destination, workspace)) {
    throw new RepairWorkspaceError('unsafe-path', 'A private output link targets the workspace or an ancestor; cleanup is blocked.');
  }
  let isDir = false;
  try {
    const details = await stat(destination);
    if (details.isDirectory()) isDir = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      try {
        const ldetails = await lstat(destination, { bigint: true });
        if (ldetails.isDirectory()) isDir = true;
      } catch { /* ignored */ }
    }
  }
  if (isDir && !workspaceWithin(workspace, destination)) {
    throw new RepairWorkspaceError('unsafe-path', 'Only private leaf file links can be unlinked without following a target; directory links/junctions are blocked.');
  }
  return link;
}

async function scanWorkspace(
  record: RepairWorkspaceRecord,
  pinnedRootIdentity: RepairWorkspaceFileIdentity,
  pinnedRoleIdentities: ReadonlyMap<string, RepairWorkspaceFileIdentity>
): Promise<{ entries: CleanupEntry[]; inodeCounts: Map<string, bigint>; peerPathsByInode: Map<string, Set<string>> }> {
  const entries: CleanupEntry[] = [];
  const inodeCounts = new Map<string, bigint>();
  const peerPathsByInode = new Map<string, Set<string>>();
  const rootDetails = await lstat(record.directory, { bigint: true });
  if (!sameWorkspaceFileIdentity(pinnedRootIdentity, workspaceFileIdentity(rootDetails))) {
    throw new RepairWorkspaceError('identity-changed', 'Private workspace root changed identity during scan; replacement was preserved.');
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maximumWorkspaceCleanupDepth) {
      throw new RepairWorkspaceError('limits-exceeded', 'Private workspace cleanup exceeded its directory-depth budget.');
    }
    const names = (await readdir(directory)).sort();
    const folded = names.map((name) => name.normalize('NFC').toLowerCase());
    if (new Set(folded).size !== names.length) {
      throw new RepairWorkspaceError('unsafe-path', 'Private outputs contain case or normalization aliases; cleanup is blocked.');
    }
    for (const name of names) {
      validateArtifactPathParts([name]);
      if (entries.length >= maximumWorkspaceCleanupEntries) {
        throw new RepairWorkspaceError('limits-exceeded', 'Private workspace cleanup exceeded its entry budget.');
      }
      const target = path.join(directory, name);
      const details = await lstat(target, { bigint: true });
      if (pinnedRoleIdentities.has(target)) {
        if (!sameWorkspaceFileIdentity(pinnedRoleIdentities.get(target)!, workspaceFileIdentity(details))) {
          throw new RepairWorkspaceError('identity-changed', 'A private workspace role changed identity during scan; replacement was preserved.');
        }
      }
      const entry: CleanupEntry = {
        path: target, identity: workspaceFileIdentity(details), kind: 'file', mode: details.mode, nlink: details.nlink
      };
      if (details.isSymbolicLink()) {
        entry.kind = 'internal-file-link';
        entry.link = await inspectInternalFileLink(target, record.directory);
      } else if (details.isDirectory()) {
        entry.kind = 'directory';
      } else if (!details.isFile()) {
        throw new RepairWorkspaceError('unsafe-path', 'Special files cannot acquire cleanup authority.');
      } else {
        const key = `${details.dev}:${details.ino}`;
        inodeCounts.set(key, (inodeCounts.get(key) ?? 0n) + 1n);
        const peers = peerPathsByInode.get(key) ?? new Set<string>();
        peers.add(target);
        peerPathsByInode.set(key, peers);
      }
      entries.push(entry);
      if (entry.kind === 'directory') await walk(target, depth + 1);
    }
  };
  await walk(record.directory, 0);
  for (const entry of entries) {
    if (entry.kind === 'file') {
      const key = `${entry.identity.device}:${entry.identity.inode}`;
      const count = inodeCounts.get(key) ?? 0n;
      if (entry.nlink !== count) {
        throw new RepairWorkspaceError('unsafe-path', 'Special files and multiply linked private outputs cannot acquire cleanup authority.');
      }
    }
  }
  return { entries, inodeCounts, peerPathsByInode };
}

async function allowPrivateDeletion(entry: CleanupEntry): Promise<void> {
  if (entry.kind === 'internal-file-link') return;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
    (entry.kind === 'directory' ? constants.O_DIRECTORY ?? 0 : 0);
  const handle = await open(entry.path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameWorkspaceFileIdentity(entry.identity, workspaceFileIdentity(opened)) || opened.isSymbolicLink()) {
      throw new RepairWorkspaceError('identity-changed', 'Private cleanup opened a changed file or directory.');
    }
    await handle.chmod(Number(entry.mode & 0o777n) | (entry.kind === 'directory' ? 0o700 : 0o200));
  } finally { await handle.close(); }
}

export async function withRepairWorkspaceCleanupLease<T>(
  location: RepairWorkspaceLocation, workspaceId: string, operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>
): Promise<T> {
  const parents = await captureWorkspaceDirectoryChain(location.registryDirectory);
  const lockPath = path.join(location.registryDirectory, `repair-workspace-cleanup-${location.projectKey}-${workspaceId}.lock`);
  let handle;
  try { handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if (errorCode(error) === 'EEXIST') throw new RepairWorkspaceError('owner-uncertain', 'An existing private cleanup owner is active or uncertain; its lock was preserved.');
    throw error;
  }
  let identity: RepairWorkspaceFileIdentity;
  try { identity = workspaceFileIdentity(await handle.stat({ bigint: true })); }
  catch (error) {
    try { await handle.close(); }
    catch (closeError) {
      throw new RepairWorkspaceError('owner-uncertain', 'Private cleanup lease identity and handle release are uncertain; its path was preserved.', { cause: closeError });
    }
    throw new RepairWorkspaceError('owner-uncertain', 'Private cleanup lease identity could not be established; its path was preserved.', { cause: error });
  }
  const token = randomBytes(32).toString('hex');
  const assertHeld = async () => {
    await assertWorkspaceDirectorySnapshot(parents);
    const current = await lstat(lockPath, { bigint: true });
    const opened = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(65);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !sameWorkspaceFileIdentity(identity, workspaceFileIdentity(current)) ||
      !sameWorkspaceFileIdentity(identity, workspaceFileIdentity(opened)) ||
      read.bytesRead !== 64 || bytes.subarray(0, read.bytesRead).toString('utf8') !== token) {
      throw new RepairWorkspaceError('owner-uncertain', 'Private cleanup owner lease changed; deletion must stop.');
    }
  };
  let actionError: unknown;
  let result: T | undefined;
  try {
    await handle.writeFile(token);
    await handle.sync();
    await assertHeld();
    result = await operation({ assertHeld });
  } catch (error) { actionError = error; }
  try {
    await assertHeld();
    await handle.close();
    await assertWorkspaceDirectorySnapshot(parents);
    const current = await lstat(lockPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !sameWorkspaceFileIdentity(identity, workspaceFileIdentity(current))) {
      throw new RepairWorkspaceError('identity-changed', 'Private cleanup lock changed; the replacement was preserved.');
    }
    await unlink(lockPath);
  } catch (error) {
    try { await handle.close(); }
    catch { /* The uncertain lease is retained rather than granting cleanup. */ }
    throw new RepairWorkspaceError('owner-uncertain', 'Private cleanup owner release could not be established; metadata remains retained.', { cause: error });
  }
  if (actionError !== undefined) throw actionError;
  return result as T;
}

export async function hasRepairWorkspaceCleanupLease(location: RepairWorkspaceLocation, workspaceId: string): Promise<boolean> {
  workspaceDigest(workspaceId);
  const parents = await captureWorkspaceDirectoryChain(location.registryDirectory);
  const lock = path.join(location.registryDirectory, `repair-workspace-cleanup-${location.projectKey}-${workspaceId}.lock`);
  const present = await detailsOrAbsent(lock);
  await assertWorkspaceDirectorySnapshot(parents);
  return present !== null;
}

export async function deleteRegisteredWorkspace(
  record: RepairWorkspaceRecord, location: RepairWorkspaceLocation,
  options: RepairWorkspaceStorageOptions, progress: (removedEntries: number) => Promise<void>
): Promise<number> {
  const exists = await assertRegisteredWorkspace(record, location, true);
  if (!exists) return 0;
  if (!record.creationIdentity) {
    throw new RepairWorkspaceError('identity-changed', 'Registered workspace has no recorded creation identity.');
  }
  const pinnedRootIdentity = record.creationIdentity;
  const pinnedRoleIdentities = new Map<string, RepairWorkspaceFileIdentity>();
  for (const role of repairWorkspaceRoleNames) {
    const roleIdentity = record.roles[role].identity;
    if (roleIdentity) pinnedRoleIdentities.set(record.roles[role].path, roleIdentity);
  }

  await options.beforeWorkspaceOperation?.('scan', record.directory);
  await assertRegisteredWorkspace(record, location, true);
  const { entries, inodeCounts, peerPathsByInode } = await scanWorkspace(record, pinnedRootIdentity, pinnedRoleIdentities);
  await assertRegisteredWorkspace(record, location, true);

  const directories = new Map(await captureWorkspaceDirectoryChain(path.dirname(record.directory)));
  directories.set(record.directory, pinnedRootIdentity);
  for (const [rolePath, roleIdentity] of pinnedRoleIdentities) {
    const roleDetails = await detailsOrAbsent(rolePath);
    if (roleDetails) {
      if (!sameWorkspaceFileIdentity(roleIdentity, workspaceFileIdentity(roleDetails))) {
        throw new RepairWorkspaceError('identity-changed', 'A private workspace role changed identity before deletion; cleanup is blocked.');
      }
      directories.set(rolePath, roleIdentity);
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'directory' && !pinnedRoleIdentities.has(entry.path) && entry.path !== record.directory) {
      directories.set(entry.path, entry.identity);
    }
  }

  const privateBoundaries = [
    location.privateRoot, location.registryDirectory, path.dirname(location.root),
    location.root, record.directory, ...repairWorkspaceRoleNames.map((role) => record.roles[role].path)
  ];
  const protectedDirectories = new Map([
    ...await captureWorkspaceDirectoryChain(record.projectRoot),
    ...await captureWorkspaceDirectoryChain(record.patchStagingRoot)
  ]);

  const remainingOwnedLinks = new Map<string, bigint>(inodeCounts);
  const remainingPeersByInode = new Map<string, Set<string>>();
  for (const [key, paths] of peerPathsByInode) {
    remainingPeersByInode.set(key, new Set(paths));
  }

  const check = async (entry: CleanupEntry) => {
    await assertWorkspaceDirectorySnapshot(protectedDirectories);
    for (const directory of privateBoundaries) {
      const details = await detailsOrAbsent(directory);
      if (details) privateDirectory(details);
    }
    const currentRoot = await lstat(record.directory, { bigint: true });
    if (!sameWorkspaceFileIdentity(pinnedRootIdentity, workspaceFileIdentity(currentRoot))) {
      throw new RepairWorkspaceError('identity-changed', 'Private workspace root changed identity before deletion; cleanup is blocked.');
    }
    for (const [rolePath, roleIdentity] of pinnedRoleIdentities) {
      const roleDetails = await detailsOrAbsent(rolePath);
      if (roleDetails && !sameWorkspaceFileIdentity(roleIdentity, workspaceFileIdentity(roleDetails))) {
        throw new RepairWorkspaceError('identity-changed', 'A private workspace role changed identity before deletion; cleanup is blocked.');
      }
    }
    const assertPathAncestors = async (targetPath: string) => {
      const ancestors = new Map([...directories].filter(([directory]) =>
        directory !== targetPath && workspaceWithin(directory, targetPath)));
      await assertWorkspaceDirectorySnapshot(ancestors);
      await assertExactChildName(path.dirname(targetPath), path.basename(targetPath));
    };
    await assertPathAncestors(entry.path);
    const current = await lstat(entry.path, { bigint: true });
    const expectedIdentity = entry.path === record.directory ? pinnedRootIdentity :
      pinnedRoleIdentities.get(entry.path) ?? entry.identity;

    if (!sameWorkspaceFileIdentity(expectedIdentity, workspaceFileIdentity(current)) ||
      entry.kind === 'directory' && (!current.isDirectory() || current.isSymbolicLink()) ||
      entry.kind === 'internal-file-link' && (!current.isSymbolicLink() ||
        await inspectInternalFileLink(entry.path, record.directory) !== entry.link)) {
      throw new RepairWorkspaceError('identity-changed', 'A private output changed before deletion; the replacement was preserved.');
    }

    if (entry.kind === 'file') {
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new RepairWorkspaceError('identity-changed', 'A private output file changed type before deletion; cleanup is blocked.');
      }
      const inodeKey = `${entry.identity.device}:${entry.identity.inode}`;
      const expectedRemaining = remainingOwnedLinks.get(inodeKey) ?? 1n;
      if (current.nlink !== expectedRemaining) {
        throw new RepairWorkspaceError('identity-changed', 'A private output changed link count or gained external links before deletion; cleanup is blocked.');
      }
      const remainingPeers = remainingPeersByInode.get(inodeKey);
      if (remainingPeers) {
        for (const peerPath of remainingPeers) {
          if (peerPath !== entry.path) {
            await assertPathAncestors(peerPath);
            const peerDetails = await lstat(peerPath, { bigint: true });
            if (!peerDetails.isFile() || peerDetails.isSymbolicLink() ||
                !sameWorkspaceFileIdentity(entry.identity, workspaceFileIdentity(peerDetails)) ||
                peerDetails.nlink !== expectedRemaining) {
              throw new RepairWorkspaceError('identity-changed', 'A peer hardlinked output changed identity or gained external links; cleanup is blocked.');
            }
          }
        }
      }
    }
  };
  for (const entry of entries.filter((entry) => entry.kind === 'directory')) {
    await options.beforeWorkspaceOperation?.('scan', entry.path);
    await check(entry);
    if (process.platform !== 'win32') await allowPrivateDeletion(entry);
  }
  const ordered = [
    ...entries.filter((entry) => entry.kind === 'internal-file-link'),
    ...entries.filter((entry) => entry.kind === 'file'),
    ...entries.filter((entry) => entry.kind === 'directory').reverse()
  ];
  let removed = 0;
  try {
    for (const entry of ordered) {
      await options.beforeWorkspaceOperation?.(entry.kind === 'directory' ? 'rmdir' : 'unlink', entry.path);
      await check(entry);
      if (entry.kind === 'directory') {
        await rmdir(entry.path);
        directories.delete(entry.path);
      } else {
        if (entry.kind === 'file') {
          if (process.platform === 'win32') await allowPrivateDeletion(entry);
          await unlink(entry.path);
          const inodeKey = `${entry.identity.device}:${entry.identity.inode}`;
          const currentExpected = remainingOwnedLinks.get(inodeKey)!;
          remainingOwnedLinks.set(inodeKey, currentExpected - 1n);
          remainingPeersByInode.get(inodeKey)?.delete(entry.path);
        } else {
          await unlink(entry.path);
        }
      }
      removed++;
      if (repairWorkspaceRoleNames.some((role) => entry.path === record.roles[role].path)) await progress(removed);
    }
    await options.beforeWorkspaceOperation?.('rmdir', record.directory);
    await assertWorkspaceDirectorySnapshot(protectedDirectories);
    for (const directory of privateBoundaries) {
      if (directories.has(directory)) privateDirectory(await lstat(directory, { bigint: true }));
    }
    await assertWorkspaceDirectorySnapshot(directories);
    const finalRoot = await lstat(record.directory, { bigint: true });
    if (!sameWorkspaceFileIdentity(pinnedRootIdentity, workspaceFileIdentity(finalRoot))) {
      throw new RepairWorkspaceError('identity-changed', 'Private workspace root changed identity before final deletion.');
    }
    await rmdir(record.directory);
    removed++;
    await progress(removed);
    return removed;
  } catch (error) {
    await progress(removed);
    throw error;
  }
}
