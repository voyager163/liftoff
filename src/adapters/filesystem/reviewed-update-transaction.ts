import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { reviewedUpdateTransactionPathParts } from '../../domain/project/reviewed-update-artifacts.js';
import { errorCode, errorMessage } from './errors.js';
import { withProjectMutationLock } from './project-lock.js';
import type { ProjectMutationLease } from './project-lock.js';
import { ProjectFileTransactionError } from './project-transaction.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from './project-transaction.js';

export {
  reviewedUpdateTransactionPathParts, reviewedUpdateTransactionSchemaVersion
} from '../../domain/project/reviewed-update-artifacts.js';

// The store is user-local, outside the repository, and keeps separate entries for each digest.
export interface ReviewedUpdateApprovalStore {
  write(planFingerprint: string, transactionDigest: string): Promise<void>;
  verify(planFingerprint: string, transactionDigest: string): Promise<boolean>;
  remove(planFingerprint: string, transactionDigest: string): Promise<void>;
}

export interface ReviewedUpdateTransactionCheckpoint {
  phase: 'prepared' | 'before-mutation' | 'staged' | 'after-mutation' | 'before-commit' | 'committed';
  index?: number;
}

export interface ReviewedUpdateTransactionOptions {
  planFingerprint: string;
  approvalStore: ReviewedUpdateApprovalStore;
  preconditions?: readonly ProjectFileSnapshot[];
  validatePlan?: () => Promise<void>;
  onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface ReviewedUpdateRecoveryOptions {
  approvalStore?: ReviewedUpdateApprovalStore;
}

export interface ReviewedUpdateTransactionDestination {
  pathParts: string[];
  attempted: boolean;
  disposition: 'original' | 'target' | 'changed';
}

export interface ReviewedUpdateTransactionInspection {
  status: 'absent' | 'interrupted' | 'committed' | 'blocked';
  committed: boolean;
  journalPath: string;
  planFingerprint?: string;
  transactionDigest?: string;
  reason?: string;
  destinations: ReviewedUpdateTransactionDestination[];
}

export interface ReviewedUpdateTransactionOutcome {
  status: 'absent' | 'rolled-back' | 'committed' | 'blocked';
  committed: boolean;
  planFingerprint?: string;
  transactionDigest?: string;
  rollbackFailures: string[];
  cleanupFailures: string[];
}

export class ReviewedUpdateTransactionError extends ProjectFileTransactionError {
  readonly committed = false;

  constructor(message: string, rollbackFailures: readonly string[] = []) {
    super(message, rollbackFailures);
    this.name = 'ReviewedUpdateTransactionError';
  }
}

type StoredSnapshot =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: string; sha256: string; mode: number };

interface StoredMutation {
  type: 'write' | 'delete';
  pathParts: string[];
  original: StoredSnapshot;
  target: StoredSnapshot;
  mode?: number;
}

interface JournalBody {
  schemaVersion: 1;
  projectRoot: string;
  planFingerprint: string;
  nonce: string;
  mutations: StoredMutation[];
  missingDirectories: string[][];
}

interface JournalHeader extends JournalBody {
  transactionDigest: string;
}

type JournalFrame =
  | { phase: 'mutation'; index: number }
  | { phase: 'committed' };

interface LoadedJournal {
  header: JournalHeader;
  snapshot: ProjectFileSnapshot;
  pendingIndex: number;
  committed: boolean;
  rollbackComplete?: boolean;
}

const MAX_MUTATIONS = 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const privateFileMode = process.platform === 'win32' ? 0o666 : 0o600;

function fail(message: string): never {
  throw new FileSystemError(`Reviewed update transaction: ${message}`);
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function key(parts: readonly string[]): string {
  return parts.join('/');
}

function folded(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function validParts(value: unknown): string[] {
  const parts = validateArtifactPathParts(value, 'Reviewed update path');
  if (parts.length > 64 || key(parts).length > 2048 ||
      parts.some((part) => part.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part))) {
    fail('a path is too long or contains non-portable characters.');
  }
  return parts;
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      keys.some((entry) => !Object.hasOwn(value, entry))) fail('malformed recovery journal fields.');
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('expected a full lowercase SHA-256 digest.');
}

function assertMode(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o7777) {
    fail('invalid snapshot mode.');
  }
}

function targetMode(mode: number | undefined, original: StoredSnapshot): number {
  return reviewedUpdateTargetMode(mode, original.kind === 'file' ? original.mode : undefined);
}

export function reviewedUpdateTargetMode(mode: number | undefined, originalMode?: number): number {
  if (mode === undefined) return originalMode ?? privateFileMode;
  return process.platform === 'win32' ? (mode & 0o200 ? 0o666 : 0o444) : mode;
}

async function canonicalRoot(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) fail('project root must be a directory, not a symlink or junction.');
  return realpath(root);
}

async function safePath(root: string, parts: readonly string[]): Promise<string> {
  validParts(parts);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
    const aliases = names.filter((name) => folded(name) === folded(part));
    if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== part) {
      fail(`case or Unicode collision at ${key(parts.slice(0, index + 1))}.`);
    }
    current = path.join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) fail(`symlink or junction at ${key(parts.slice(0, index + 1))}.`);
      if (index < parts.length - 1 && !details.isDirectory()) {
        fail(`path parent is not a directory: ${key(parts.slice(0, index + 1))}.`);
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
  }
  return current;
}

async function readSnapshot(
  root: string, parts: readonly string[], maximum = MAX_FILE_BYTES
): Promise<ProjectFileSnapshot> {
  const target = await safePath(root, parts);
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) fail(`not a regular file: ${key(parts)}.`);
    if (before.size > maximum) fail(`snapshot exceeds the bounded size limit: ${key(parts)}.`);
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino || details.size > maximum) {
      fail(`file changed while reading: ${key(parts)}.`);
    }
    const buffer = Buffer.alloc(details.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = buffer.subarray(0, length);
    const after = await lstat(target);
    if (content.length > maximum || content.length !== details.size ||
        after.dev !== details.dev || after.ino !== details.ino ||
        after.size !== content.length || after.mtimeMs !== details.mtimeMs ||
        after.mode !== details.mode) fail(`file changed while reading: ${key(parts)}.`);
    return { pathParts: [...parts], content, mode: details.mode & 0o7777 };
  } catch (error) {
    if (!handle && errorCode(error) === 'ENOENT') return { pathParts: [...parts] };
    throw error;
  } finally {
    await handle?.close();
  }
}

function storeSnapshot(snapshot: ProjectFileSnapshot): StoredSnapshot {
  if (snapshot.content === undefined) {
    if (snapshot.mode !== undefined) fail('a missing snapshot cannot have a mode.');
    return { kind: 'missing' };
  }
  if (!Buffer.isBuffer(snapshot.content) || snapshot.content.length > MAX_FILE_BYTES) {
    fail('invalid or oversized snapshot bytes.');
  }
  assertMode(snapshot.mode);
  return { kind: 'file', bytes: snapshot.content.toString('base64'), sha256: hash(snapshot.content), mode: snapshot.mode };
}

function matches(snapshot: ProjectFileSnapshot, stored: StoredSnapshot): boolean {
  return stored.kind === 'missing'
    ? snapshot.content === undefined
    : snapshot.content !== undefined && snapshot.mode === stored.mode && hash(snapshot.content) === stored.sha256;
}

async function assertSnapshot(root: string, parts: readonly string[], stored: StoredSnapshot): Promise<void> {
  if (!matches(await readSnapshot(root, parts), stored)) fail(`target changed after review: ${key(parts)}.`);
}

function parseSnapshot(value: unknown): StoredSnapshot {
  if (isRecord(value) && value.kind === 'missing') {
    exactKeys(value, ['kind']);
    return { kind: 'missing' };
  }
  exactKeys(value, ['kind', 'bytes', 'sha256', 'mode']);
  assertMode(value.mode);
  assertDigest(value.sha256);
  if (value.kind !== 'file' || typeof value.bytes !== 'string' ||
      value.bytes.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('invalid stored file snapshot.');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== value.bytes || hash(bytes) !== value.sha256) {
    fail('stored snapshot digest or encoding does not match its exact bytes.');
  }
  return { kind: 'file', bytes: value.bytes, sha256: value.sha256, mode: value.mode };
}

function validatePaths(paths: readonly string[][]): void {
  const files = new Set<string>();
  const spelling = new Map<string, string>();
  for (const parts of [...paths, [...reviewedUpdateTransactionPathParts]]) {
    for (let count = 1; count <= parts.length; count += 1) {
      const prefix = key(parts.slice(0, count));
      const identity = folded(prefix);
      const prior = spelling.get(identity);
      if (prior !== undefined && prior !== prefix) fail(`case-colliding inventory path: ${prefix}.`);
      if (count < parts.length && files.has(identity)) fail(`file/directory inventory collision: ${prefix}.`);
      spelling.set(identity, prefix);
    }
    const identity = folded(key(parts));
    if (files.has(identity) || [...spelling.keys()].some((name) => name.startsWith(`${identity}/`))) {
      fail(`duplicate or overlapping mutation: ${key(parts)}.`);
    }
    files.add(identity);
  }
}

function validateInventory(mutations: readonly StoredMutation[]): void {
  validatePaths(mutations.map((entry) => entry.pathParts));
  const size = mutations.reduce((sum, mutation) => sum +
    (mutation.original.kind === 'file' ? Buffer.byteLength(mutation.original.bytes, 'base64') : 0) +
    (mutation.target.kind === 'file' ? Buffer.byteLength(mutation.target.bytes, 'base64') : 0), 0);
  if (size > MAX_SNAPSHOT_BYTES) fail('transaction snapshots exceed the bounded size limit.');
}

function bodyOf(header: JournalHeader): JournalBody {
  const { transactionDigest: _digest, ...body } = header;
  return body;
}

function parseHeader(value: unknown, root: string): JournalHeader {
  exactKeys(value, ['schemaVersion', 'projectRoot', 'planFingerprint', 'nonce', 'mutations', 'missingDirectories', 'transactionDigest']);
  assertDigest(value.planFingerprint);
  assertDigest(value.transactionDigest);
  if (value.schemaVersion !== 1 || value.projectRoot !== root ||
      typeof value.nonce !== 'string' || !UUID.test(value.nonce) ||
      !Array.isArray(value.mutations) || value.mutations.length === 0 || value.mutations.length > MAX_MUTATIONS ||
      !Array.isArray(value.missingDirectories) || value.missingDirectories.length > MAX_MUTATIONS * 64 + 1) {
    fail('unsupported, wrong-project, or oversized recovery journal.');
  }
  const mutations: StoredMutation[] = value.mutations.map((entry) => {
    const hasMode = isRecord(entry) && Object.hasOwn(entry, 'mode');
    exactKeys(entry, ['type', 'pathParts', 'original', 'target', ...(hasMode ? ['mode'] : [])]);
    if (hasMode) assertMode(entry.mode);
    const original = parseSnapshot(entry.original);
    const target = parseSnapshot(entry.target);
    if (entry.type !== 'write' && entry.type !== 'delete' ||
        entry.type === 'write' && target.kind !== 'file' ||
        entry.type === 'delete' && target.kind !== 'missing') fail('invalid serialized mutation type or target.');
    if (entry.type === 'delete' && hasMode ||
        target.kind === 'file' && target.mode !== targetMode(entry.mode as number | undefined, original)) {
      fail('stored target mode does not match its approved mutation.');
    }
    return {
      type: entry.type, pathParts: validParts(entry.pathParts), original, target,
      ...(hasMode ? { mode: entry.mode as number } : {})
    };
  });
  validateInventory(mutations);
  const missingDirectories: string[][] = value.missingDirectories.map(validParts);
  const seen = new Set<string>();
  for (const parts of missingDirectories) {
    const name = key(parts);
    if (seen.has(folded(name)) ||
        name !== '.liftoff' && !mutations.some((entry) =>
          entry.type === 'write' && key(entry.pathParts).startsWith(`${name}/`))) {
      fail('invalid or duplicate directory cleanup inventory.');
    }
    if (mutations.some((entry) => entry.original.kind === 'file' && key(entry.pathParts).startsWith(`${name}/`))) {
      fail('an original file cannot have an originally missing parent.');
    }
    seen.add(folded(name));
  }
  const header: JournalHeader = {
    schemaVersion: 1, projectRoot: root, planFingerprint: value.planFingerprint, nonce: value.nonce,
    mutations, missingDirectories, transactionDigest: value.transactionDigest
  };
  if (canonicalSha256(bodyOf(header)) !== header.transactionDigest) fail('transaction digest does not match the journal.');
  return header;
}

function frameDigest(header: JournalHeader, frame: JournalFrame): string {
  return canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, ...frame });
}

function rollbackCleanupDigest(header: JournalHeader): string {
  return canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'rollback-cleanup-only' });
}

function parseCanonicalLine(line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail('malformed recovery journal JSON.');
  }
  if (canonicalJson(value) !== `${line}\n`) fail('recovery journal is not strict canonical JSON.');
  return value;
}

async function loadJournal(root: string, store?: ReviewedUpdateApprovalStore): Promise<LoadedJournal | undefined> {
  const snapshot = await readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES);
  if (!snapshot.content) return undefined;
  if (snapshot.mode !== privateFileMode) fail('recovery journal must have restrictive permissions.');
  const text = snapshot.content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(snapshot.content)) fail('recovery journal is not UTF-8.');
  const lines = text.split('\n');
  const tail = lines.pop()!;
  if (!lines.length) fail('incomplete recovery journal header.');
  const header = parseHeader(parseCanonicalLine(lines[0]), root);
  let pendingIndex = -1;
  let committed = false;
  let lastFrame: JournalFrame | undefined;
  for (const line of lines.slice(1)) {
    const frame = parseCanonicalLine(line);
    if (committed || !isRecord(frame)) fail('invalid recovery phase sequence.');
    if (frame.phase === 'mutation') {
      exactKeys(frame, ['phase', 'index']);
      if (frame.index !== pendingIndex + 1 || pendingIndex + 1 >= header.mutations.length) fail('invalid mutation checkpoint.');
      pendingIndex += 1;
      lastFrame = { phase: 'mutation', index: pendingIndex };
    } else {
      exactKeys(frame, ['phase']);
      if (frame.phase !== 'committed' || pendingIndex !== header.mutations.length - 1) fail('invalid commit checkpoint.');
      committed = true;
      lastFrame = { phase: 'committed' };
    }
  }
  if (tail) {
    const next: JournalFrame = pendingIndex + 1 < header.mutations.length
      ? { phase: 'mutation', index: pendingIndex + 1 } : { phase: 'committed' };
    // An interrupted append is accepted only as an exact prefix of the one possible next record.
    if (committed || !canonicalJson(next).startsWith(tail)) fail('malformed trailing recovery checkpoint.');
  }
  if (!store) {
    fail('missing or invalid user-local transaction approval; the project journal cannot authorize recovery.');
  }
  const approved = await store.verify(header.planFingerprint, header.transactionDigest) === true;
  const cleanupOnly = !approved && await store.verify(header.planFingerprint, rollbackCleanupDigest(header)) === true;
  if (!approved && !cleanupOnly) {
    fail('missing or invalid user-local transaction approval; the project journal cannot authorize recovery.');
  }
  if (approved && lastFrame && await store.verify(header.planFingerprint, frameDigest(header, lastFrame)) !== true) {
    fail('recovery checkpoint has no matching user-local approval seal.');
  }
  // A durable external commit seal wins even if the local commit append was interrupted or truncated.
  const sealedCommit = await store.verify(header.planFingerprint, frameDigest(header, { phase: 'committed' }));
  if (committed && sealedCommit !== true) fail('committed journal has no matching external commit seal.');
  if (cleanupOnly && !sealedCommit) {
    // This separately sealed capability cannot restore files: every original must already be intact.
    for (const mutation of header.mutations) await assertSnapshot(root, mutation.pathParts, mutation.original);
  }
  return { header, snapshot, pendingIndex, committed: sealedCommit === true, rollbackComplete: cleanupOnly && !sealedCommit };
}

function temporaryParts(header: JournalHeader, index: number, restore: boolean): string[] {
  return [
    ...header.mutations[index].pathParts.slice(0, -1),
    `.liftoff-reviewed-${header.transactionDigest}-${index}-${restore ? 'original' : 'target'}.tmp`
  ];
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' ||
        !['EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(String(errorCode(error)))) throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureParents(root: string, parts: readonly string[], permitted: readonly string[][]): Promise<void> {
  for (let count = 1; count < parts.length; count += 1) {
    const parent = parts.slice(0, count);
    const native = await safePath(root, parent);
    try {
      if (!(await lstat(native)).isDirectory()) fail(`not a directory: ${key(parent)}.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (!permitted.some((allowed) => key(allowed) === key(parent))) fail(`parent changed after review: ${key(parent)}.`);
      await mkdir(native, { mode: 0o700 });
      await chmod(await safePath(root, parent), 0o700);
      await syncDirectory(path.dirname(native));
    }
  }
}

async function assertJournalCurrent(root: string, snapshot: ProjectFileSnapshot): Promise<void> {
  const current = await readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES);
  if (!current.content?.equals(snapshot.content!) || current.mode !== snapshot.mode) {
    fail('recovery journal changed; the changed file was preserved.');
  }
}

async function createJournal(root: string, header: JournalHeader, lease: ProjectMutationLease): Promise<ProjectFileSnapshot> {
  await ensureParents(root, reviewedUpdateTransactionPathParts, header.missingDirectories);
  const native = await safePath(root, reviewedUpdateTransactionPathParts);
  await lease.assertHeld();
  const handle = await open(native, 'wx', 0o600);
  let identity: { dev: number; ino: number } | undefined;
  let closed = false;
  const bytes = Buffer.from(canonicalJson(header));
  try {
    identity = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    const failures: string[] = [];
    try {
      await handle.close();
      closed = true;
      await lease.assertHeld();
      const current = await readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES);
      const details = await lstat(native);
      if (!identity || details.dev !== identity.dev || details.ino !== identity.ino ||
          current.mode !== privateFileMode || !current.content ||
          !bytes.subarray(0, current.content.length).equals(current.content)) {
        fail('partially created recovery journal changed; it was preserved.');
      }
      await unlink(native);
      await syncDirectory(path.dirname(native));
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError));
    }
    throw new FileSystemError(
      `Unable to create ${key(reviewedUpdateTransactionPathParts)}: ${errorMessage(error)}` +
      (failures.length ? ` Cleanup failed: ${failures.join('; ')}` : '')
    );
  } finally {
    if (!closed) await handle.close();
  }
  await syncDirectory(path.dirname(native));
  return readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES);
}

async function appendFrame(
  root: string, snapshot: ProjectFileSnapshot, frame: JournalFrame, lease: ProjectMutationLease
): Promise<ProjectFileSnapshot> {
  await lease.assertHeld();
  await assertJournalCurrent(root, snapshot);
  const native = await safePath(root, reviewedUpdateTransactionPathParts);
  const handle = await open(native, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(canonicalJson(frame));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES);
}

async function durableMutation(
  root: string, header: JournalHeader, index: number, restore: boolean, lease: ProjectMutationLease,
  onStaged?: () => Promise<void>
): Promise<void> {
  const mutation = header.mutations[index];
  const before = restore ? mutation.target : mutation.original;
  const after = restore ? mutation.original : mutation.target;
  await lease.assertHeld();
  await assertSnapshot(root, mutation.pathParts, before);
  if (after.kind === 'missing') {
    if (before.kind === 'missing') return;
    await unlink(await safePath(root, mutation.pathParts));
    await syncDirectory(path.dirname(path.join(root, ...mutation.pathParts)));
  } else {
    await ensureParents(root, mutation.pathParts, header.missingDirectories);
    const temporary = await safePath(root, temporaryParts(header, index, restore));
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(Buffer.from(after.bytes, 'base64'));
      await handle.chmod(after.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await onStaged?.();
    await lease.assertHeld();
    await assertSnapshot(root, mutation.pathParts, before);
    await assertSnapshot(root, temporaryParts(header, index, restore), after);
    await rename(temporary, await safePath(root, mutation.pathParts));
    await syncDirectory(path.dirname(temporary));
  }
  await assertSnapshot(root, mutation.pathParts, after);
}

async function cleanupTemporary(
  root: string, header: JournalHeader, index: number, restore: boolean, lease: ProjectMutationLease
): Promise<void> {
  const parts = temporaryParts(header, index, restore);
  const snapshot = await readSnapshot(root, parts);
  if (snapshot.content === undefined) return;
  const intended = restore ? header.mutations[index].original : header.mutations[index].target;
  if (intended.kind !== 'file' || !Buffer.from(intended.bytes, 'base64').subarray(0, snapshot.content.length).equals(snapshot.content) ||
      snapshot.mode !== privateFileMode && snapshot.mode !== intended.mode) {
    fail(`temporary changed; it was preserved: ${key(parts)}.`);
  }
  await lease.assertHeld();
  const current = await readSnapshot(root, parts);
  if (!current.content?.equals(snapshot.content) || current.mode !== snapshot.mode) fail(`temporary changed: ${key(parts)}.`);
  await unlink(await safePath(root, parts));
  await syncDirectory(path.dirname(path.join(root, ...parts)));
}

async function cleanupJournal(
  root: string, loaded: LoadedJournal, store: ReviewedUpdateApprovalStore, lease: ProjectMutationLease
): Promise<string[]> {
  const failures: string[] = [];
  const removeApproval = async (digest: string): Promise<boolean> => {
    try {
      await store.remove(loaded.header.planFingerprint, digest);
      return true;
    } catch (error) {
      failures.push(`user-local approval ${digest}: ${errorMessage(error)}`);
      return false;
    }
  };
  if (!loaded.committed) {
    await lease.assertHeld();
    await assertJournalCurrent(root, loaded.snapshot);
    // A failed revocation must leave the journal blocking new work after rollback.
    if (!await removeApproval(loaded.header.transactionDigest)) return failures;
  }
  try {
    await lease.assertHeld();
    await assertJournalCurrent(root, loaded.snapshot);
    await unlink(await safePath(root, reviewedUpdateTransactionPathParts));
    await syncDirectory(path.join(root, '.liftoff'));
  } catch (error) {
    return [`${key(reviewedUpdateTransactionPathParts)}: ${errorMessage(error)}`];
  }
  // Never discard the commit seal while an approval capable of authorizing rollback remains.
  if (loaded.committed && !await removeApproval(loaded.header.transactionDigest)) return failures;
  const digests = [
    ...loaded.header.mutations.map((_entry, index) => frameDigest(loaded.header, { phase: 'mutation', index })),
    frameDigest(loaded.header, { phase: 'committed' }),
    rollbackCleanupDigest(loaded.header)
  ];
  for (const digest of digests) await removeApproval(digest);
  if (!loaded.committed && loaded.header.missingDirectories.some((parts) => key(parts) === '.liftoff')) {
    try {
      await lease.assertHeld();
      await rmdir(await safePath(root, ['.liftoff']));
      await syncDirectory(root);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') failures.push(`.liftoff: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function destinations(root: string, loaded: LoadedJournal): Promise<ReviewedUpdateTransactionDestination[]> {
  const result: ReviewedUpdateTransactionDestination[] = [];
  for (const [index, mutation] of loaded.header.mutations.entries()) {
    const current = await readSnapshot(root, mutation.pathParts);
    result.push({
      pathParts: [...mutation.pathParts], attempted: index <= loaded.pendingIndex,
      disposition: matches(current, mutation.original) ? 'original'
        : index <= loaded.pendingIndex && matches(current, mutation.target) ? 'target' : 'changed'
    });
  }
  return result;
}

function outcome(status: ReviewedUpdateTransactionOutcome['status'], loaded?: LoadedJournal): ReviewedUpdateTransactionOutcome {
  return {
    status, committed: loaded?.committed ?? false,
    ...(loaded ? { planFingerprint: loaded.header.planFingerprint, transactionDigest: loaded.header.transactionDigest } : {}),
    rollbackFailures: [], cleanupFailures: []
  };
}

async function recoverLocked(
  root: string, loaded: LoadedJournal, store: ReviewedUpdateApprovalStore, lease: ProjectMutationLease
): Promise<ReviewedUpdateTransactionOutcome> {
  if (loaded.committed) {
    return { ...outcome('committed', loaded), cleanupFailures: await cleanupJournal(root, loaded, store, lease) };
  }
  if (loaded.rollbackComplete) {
    for (const mutation of loaded.header.mutations) await assertSnapshot(root, mutation.pathParts, mutation.original);
    const cleanupFailures = await cleanupJournal(root, loaded, store, lease);
    return { ...outcome(cleanupFailures.length ? 'blocked' : 'rolled-back', loaded), cleanupFailures };
  }
  const result = outcome('rolled-back', loaded);
  const entries = await destinations(root, loaded);
  for (const [index, mutation] of [...loaded.header.mutations.entries()].reverse()) {
    try {
      await lease.assertHeld();
      await assertJournalCurrent(root, loaded.snapshot);
      const current = entries[index];
      if (current.disposition === 'changed') fail(`target changed before rollback; it was preserved: ${key(mutation.pathParts)}.`);
      if (current.attempted) {
        await cleanupTemporary(root, loaded.header, index, false, lease);
        await cleanupTemporary(root, loaded.header, index, true, lease);
      }
      if (current.disposition === 'target') await durableMutation(root, loaded.header, index, true, lease);
    } catch (error) {
      result.rollbackFailures.push(`${key(mutation.pathParts)}: ${errorMessage(error)}`);
    }
  }
  for (const parts of [...loaded.header.missingDirectories].sort((left, right) => right.length - left.length)) {
    if (key(parts) === '.liftoff') continue;
    if (!loaded.header.mutations.some((mutation, index) => index <= loaded.pendingIndex &&
        mutation.type === 'write' && key(mutation.pathParts).startsWith(`${key(parts)}/`))) continue;
    try {
      await lease.assertHeld();
      await assertJournalCurrent(root, loaded.snapshot);
      await rmdir(await safePath(root, parts));
      await syncDirectory(path.dirname(path.join(root, ...parts)));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') result.rollbackFailures.push(`${key(parts)}: ${errorMessage(error)}`);
    }
  }
  if (result.rollbackFailures.length) result.status = 'blocked';
  else result.cleanupFailures = await cleanupJournal(root, loaded, store, lease);
  if (result.cleanupFailures.length) result.status = 'blocked';
  return result;
}

async function withReviewedMutationLock(
  root: string, operation: (lease: ProjectMutationLease) => Promise<ReviewedUpdateTransactionOutcome>
): Promise<ReviewedUpdateTransactionOutcome> {
  let result: ReviewedUpdateTransactionOutcome | undefined;
  try {
    return await withProjectMutationLock(root, async (lease) => {
      result = await operation(lease);
      return result;
    });
  } catch (error) {
    if (result?.committed) {
      return { ...result, cleanupFailures: [...result.cleanupFailures, `Project mutation lock cleanup: ${errorMessage(error)}`] };
    }
    throw error;
  }
}

export async function inspectReviewedUpdateTransaction(
  projectRoot: string, options: ReviewedUpdateRecoveryOptions = {}
): Promise<ReviewedUpdateTransactionInspection> {
  const journalPath = path.join(path.resolve(projectRoot), ...reviewedUpdateTransactionPathParts);
  try {
    const root = await canonicalRoot(projectRoot);
    const loaded = await loadJournal(root, options.approvalStore);
    if (!loaded) return { status: 'absent', committed: false, journalPath, destinations: [] };
    return {
      status: loaded.committed ? 'committed' : 'interrupted', committed: loaded.committed, journalPath,
      planFingerprint: loaded.header.planFingerprint, transactionDigest: loaded.header.transactionDigest,
      destinations: loaded.committed ? [] : await destinations(root, loaded)
    };
  } catch (error) {
    return { status: 'blocked', committed: false, journalPath, reason: errorMessage(error), destinations: [] };
  }
}

export async function recoverReviewedUpdateTransaction(
  projectRoot: string, options: ReviewedUpdateRecoveryOptions = {}
): Promise<ReviewedUpdateTransactionOutcome> {
  return withReviewedMutationLock(projectRoot, async (lease) => {
    try {
      const root = await canonicalRoot(projectRoot);
      const loaded = await loadJournal(root, options.approvalStore);
      if (!loaded) return outcome('absent');
      return await recoverLocked(root, loaded, options.approvalStore!, lease);
    } catch (error) {
      return { ...outcome('blocked'), rollbackFailures: [errorMessage(error)] };
    }
  });
}

export async function applyReviewedUpdateTransaction(
  projectRoot: string, mutations: readonly ProjectFileMutation[], options: ReviewedUpdateTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  assertDigest(options.planFingerprint);
  const planFingerprint = options.planFingerprint;
  if (!options.approvalStore) fail('a user-local transaction approval store is required.');
  if (!Array.isArray(mutations) || mutations.length > MAX_MUTATIONS) fail('invalid or oversized mutation inventory.');
  const selected: ProjectFileMutation[] = mutations.map((mutation) => {
    exactKeys(mutation, mutation.type === 'write'
      ? ['type', 'pathParts', 'content', ...(Object.hasOwn(mutation, 'mode') ? ['mode'] : [])]
      : ['type', 'pathParts']);
    const pathParts = validParts(mutation.pathParts);
    if (mutation.type === 'delete') return { type: 'delete', pathParts };
    if (mutation.type !== 'write' || typeof mutation.content !== 'string' && !Buffer.isBuffer(mutation.content)) {
      fail('invalid mutation type or bytes.');
    }
    if (mutation.mode !== undefined) assertMode(mutation.mode);
    return { type: 'write', pathParts, content: typeof mutation.content === 'string'
      ? Buffer.from(mutation.content, 'utf8') : Buffer.from(mutation.content),
    ...(mutation.mode === undefined ? {} : { mode: mutation.mode }) };
  });
  const conditions = new Map<string, { pathParts: string[]; stored: StoredSnapshot }>();
  if ((options.preconditions?.length ?? 0) > MAX_MUTATIONS * 4) fail('too many preconditions.');
  for (const snapshot of options.preconditions ?? []) {
    const parts = validParts(snapshot.pathParts);
    const identity = folded(key(parts));
    if (conditions.has(identity)) fail(`duplicate or case-colliding preconditions: ${key(parts)}.`);
    conditions.set(identity, { pathParts: parts, stored: storeSnapshot(snapshot) });
  }
  return withReviewedMutationLock(projectRoot, async (lease) => {
    const root = await canonicalRoot(projectRoot);
    if ((await readSnapshot(root, reviewedUpdateTransactionPathParts, MAX_JOURNAL_BYTES)).content !== undefined) {
      fail('an existing recovery journal blocks new work; recover it, then run liftoff update --check.');
    }
    await options.validatePlan?.();
    await lease.assertHeld();
    const stored: StoredMutation[] = [];
    const missing = new Map<string, string[]>();
    for (const mutation of selected) {
      const expected = conditions.get(folded(key(mutation.pathParts)));
      if (expected && key(expected.pathParts) !== key(mutation.pathParts)) fail('case-colliding source and destination.');
      const original = expected?.stored ?? storeSnapshot(await readSnapshot(root, mutation.pathParts));
      const target: StoredSnapshot = mutation.type === 'delete' ? { kind: 'missing' }
        : { kind: 'file', bytes: (mutation.content as Buffer).toString('base64'),
          sha256: hash(mutation.content as Buffer),
          mode: targetMode(mutation.mode, original) };
      if (mutation.type === 'write' && (mutation.content as Buffer).length > MAX_FILE_BYTES) fail(`oversized target: ${key(mutation.pathParts)}.`);
      stored.push({
        type: mutation.type, pathParts: mutation.pathParts, original, target,
        ...(mutation.type === 'write' && mutation.mode !== undefined ? { mode: mutation.mode } : {})
      });
      conditions.set(folded(key(mutation.pathParts)), { pathParts: mutation.pathParts, stored: original });
    }
    validateInventory(stored);
    validatePaths([...conditions.values()].map((entry) => entry.pathParts));
    const assertConditions = async () => {
      for (const condition of conditions.values()) await assertSnapshot(root, condition.pathParts, condition.stored);
    };
    await assertConditions();
    if (!stored.length) return outcome('absent');
    for (const parts of [...stored.filter((entry) => entry.type === 'write').map((entry) => entry.pathParts),
      [...reviewedUpdateTransactionPathParts]]) {
      for (let count = 1; count < parts.length; count += 1) {
        const parent = parts.slice(0, count);
        try {
          if (!(await lstat(await safePath(root, parent))).isDirectory()) fail(`not a directory: ${key(parent)}.`);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          missing.set(key(parent), parent);
        }
      }
    }
    const body: JournalBody = {
      schemaVersion: 1, projectRoot: root, planFingerprint, nonce: randomUUID(),
      mutations: stored, missingDirectories: [...missing.values()]
    };
    const header: JournalHeader = { ...body, transactionDigest: canonicalSha256(body) };
    for (const [index] of stored.entries()) {
      for (const restore of [false, true]) {
        if ((await readSnapshot(root, temporaryParts(header, index, restore))).content !== undefined) {
          fail(`reserved temporary already exists: ${key(temporaryParts(header, index, restore))}.`);
        }
      }
    }
    let loaded: LoadedJournal | undefined;
    let committed = false;
    let operation = 'persist user-local transaction approval';
    try {
      await options.approvalStore.write(header.planFingerprint, header.transactionDigest);
      await options.approvalStore.write(header.planFingerprint, rollbackCleanupDigest(header));
      if (await options.approvalStore.verify(header.planFingerprint, header.transactionDigest) !== true ||
          await options.approvalStore.verify(header.planFingerprint, rollbackCleanupDigest(header)) !== true) {
        fail('the user-local approval store did not persist its transaction seal.');
      }
      await lease.assertHeld();
      await assertConditions();
      operation = `create ${key(reviewedUpdateTransactionPathParts)}`;
      loaded = { header, snapshot: await createJournal(root, header, lease), pendingIndex: -1, committed: false };
      await options.onCheckpoint?.({ phase: 'prepared' });
      for (const [index, mutation] of selected.entries()) {
        operation = `${mutation.type} ${key(mutation.pathParts)}`;
        const callbackMutation: ProjectFileMutation = mutation.type === 'write'
          ? { ...mutation, pathParts: [...mutation.pathParts], content: Buffer.from(mutation.content as Buffer) }
          : { ...mutation, pathParts: [...mutation.pathParts] };
        await options.onBeforeMutation?.(callbackMutation, index);
        await lease.assertHeld();
        await assertConditions();
        const frame: JournalFrame = { phase: 'mutation', index };
        await options.approvalStore.write(header.planFingerprint, frameDigest(header, frame));
        loaded.snapshot = await appendFrame(root, loaded.snapshot, frame, lease);
        loaded.pendingIndex = index;
        await options.onCheckpoint?.({ phase: 'before-mutation', index });
        await assertConditions();
        await durableMutation(root, header, index, false, lease,
          () => options.onCheckpoint?.({ phase: 'staged', index }) ?? Promise.resolve());
        conditions.set(folded(key(mutation.pathParts)), { pathParts: mutation.pathParts, stored: stored[index].target });
        await options.onCheckpoint?.({ phase: 'after-mutation', index });
      }
      operation = 'commit reviewed update';
      await options.onCheckpoint?.({ phase: 'before-commit' });
      await lease.assertHeld();
      await assertConditions();
      await assertJournalCurrent(root, loaded.snapshot);
      await options.approvalStore.write(header.planFingerprint, frameDigest(header, { phase: 'committed' }));
      committed = true;
      loaded.committed = true;
      loaded.snapshot = await appendFrame(root, loaded.snapshot, { phase: 'committed' }, lease);
      await options.onCheckpoint?.({ phase: 'committed' });
      return { ...outcome('committed', loaded), cleanupFailures: await cleanupJournal(root, loaded, options.approvalStore, lease) };
    } catch (error) {
      if (committed) {
        return {
          ...outcome('committed', loaded),
          committed: true, cleanupFailures: [`Committed transaction finalization: ${errorMessage(error)}`]
        };
      }
      let recovered: ReviewedUpdateTransactionOutcome | undefined;
      try {
        const current = await loadJournal(root, options.approvalStore);
        if (current) {
          recovered = await recoverLocked(root, current, options.approvalStore, lease);
          if (recovered.committed) {
            recovered.cleanupFailures.unshift(`Committed transaction finalization: ${errorMessage(error)}`);
            return recovered;
          }
        } else {
          await options.approvalStore.remove(header.planFingerprint, header.transactionDigest);
          await options.approvalStore.remove(header.planFingerprint, rollbackCleanupDigest(header));
          if (header.missingDirectories.some((parts) => key(parts) === '.liftoff')) {
            try {
              await lease.assertHeld();
              await rmdir(await safePath(root, ['.liftoff']));
              await syncDirectory(root);
            } catch (cleanupError) {
              if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError;
            }
          }
        }
      } catch (recoveryError) {
        throw new ReviewedUpdateTransactionError(
          `Project update failed to ${operation}: ${errorMessage(error)} Recovery blocked: ${errorMessage(recoveryError)}`,
          [errorMessage(recoveryError)]
        );
      }
      const failures = [...recovered?.rollbackFailures ?? [], ...recovered?.cleanupFailures ?? []];
      throw new ReviewedUpdateTransactionError(
        `Project update failed to ${operation}: ${errorMessage(error)} ${failures.length
          ? `Recovery incomplete: ${failures.join('; ')}` : 'All attributable changes were rolled back.'}`,
        failures
      );
    }
  });
}
