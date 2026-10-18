import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readlink, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readUpgradeBytes } from './upgrade-host.js';
import { assertMigrationMetadata, macMigrationHash, migrationDirectory, migrationFileIdentity, migrationNames } from './mac-npm-owner.js';
import { MacMigrationFailure, type MacMigrationBrew, type MacMigrationJournalPhase, type MacNpmOwner } from '../../domain/distribution/mac-migration.js';
import type { NativeCandidate } from '../../domain/distribution/native-upgrade.js';
import { isStableSemver } from '../../stable-release.js';
import type { CaskMigrationTargetStage } from './mac-migration-cask-stage.js';

export interface MigrationTreeEntry {
  path: string;
  kind: 'file' | 'directory' | 'link';
  mode: number;
  sha256?: string;
  target?: string;
  physical: string;
  metadata?: string;
}

export interface MigrationTree {
  entries: MigrationTreeEntry[];
  content: string;
  physical: string;
}

export async function captureMigrationTree(root: string): Promise<MigrationTree> {
  const entries: MigrationTreeEntry[] = [];
  let total = 0;
  const started = performance.now();
  const visit = async (relative: string): Promise<void> => {
    if (entries.length >= 8192 || relative.split('/').length > 32 || performance.now() - started > 30_000) {
      throw new MacMigrationFailure('old-inventory-limit');
    }
    const file = relative ? path.join(root, relative) : root;
    const stat = await lstat(file);
    if ((!stat.isSymbolicLink() && stat.mode & 0o7022) || stat.uid !== process.getuid?.() ||
      stat.gid !== process.getgid?.()) {
      throw new MacMigrationFailure('unsafe-old-material');
    }
    const physical = JSON.stringify([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (await realpath(file) !== file) throw new MacMigrationFailure('old-tree-escape');
      if ((stat.mode & 0o700) !== 0o700) throw new MacMigrationFailure('unrecoverable-old-directory');
      entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777, physical });
      for (const name of await migrationNames(file, 8192 - entries.length)) {
        if (/[/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new MacMigrationFailure('unsafe-old-path');
        await visit(relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isSymbolicLink() && relative) {
      const target = await readlink(file);
      const destination = path.resolve(path.dirname(file), target);
      if (path.isAbsolute(target) || /[\\\u0000-\u001f]/.test(target) || !destination.startsWith(`${root}/`) ||
        !(await realpath(file)).startsWith(`${root}/`)) throw new MacMigrationFailure('old-link-escape');
      entries.push({ path: relative, kind: 'link', mode: stat.mode & 0o777, target, physical });
    } else if (stat.isFile() && relative) {
      const bytes = await readUpgradeBytes(file, 8 * 1024 * 1024);
      total += bytes.length;
      if (total > 128 * 1024 * 1024) throw new MacMigrationFailure('old-inventory-byte-limit');
      entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o777, sha256: macMigrationHash(bytes), physical });
    } else throw new MacMigrationFailure('unsafe-old-entry');
  };
  await visit('');
  const metadata = await assertMigrationMetadata(entries.map(entry => path.join(root, entry.path)),
    30_000 - (performance.now() - started));
  for (const entry of entries) entry.metadata = metadata.get(path.join(root, entry.path));
  const content = macMigrationHash(JSON.stringify(entries.map(({ physical: _physical, ...entry }) => entry)));
  return { entries, content, physical: macMigrationHash(JSON.stringify(entries)) };
}

export async function copyMigrationTree(source: string, destination: string, expected: MigrationTree): Promise<void> {
  if ((await captureMigrationTree(source)).physical !== expected.physical) throw new MacMigrationFailure('old-tree-changed');
  const started = performance.now();
  for (const entry of expected.entries) {
    if (performance.now() - started > 30_000) throw new MacMigrationFailure('recovery-copy-deadline-exceeded');
    await copyEntry(source, destination, entry);
  }
  if ((await captureMigrationTree(source)).physical !== expected.physical ||
    (await captureMigrationTree(destination)).content !== expected.content) throw new MacMigrationFailure('recovery-copy-mismatch');
}

export async function syncMigrationDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function durableMigrationFile(file: string, bytes: Buffer, mode = 0o600): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  await syncMigrationDirectory(path.dirname(file));
}

async function copyEntry(source: string, destination: string, entry: MigrationTreeEntry): Promise<void> {
  const file = path.join(destination, entry.path);
  if (entry.kind === 'directory') {
    await mkdir(file, { mode: entry.mode });
    await chmod(file, entry.mode);
    await syncMigrationDirectory(path.dirname(file));
  } else if (entry.kind === 'link') {
    await symlink(entry.target!, file);
    await syncMigrationDirectory(path.dirname(file));
  } else {
    const bytes = await readUpgradeBytes(path.join(source, entry.path), 8 * 1024 * 1024);
    if (macMigrationHash(bytes) !== entry.sha256) throw new MacMigrationFailure('old-tree-changed');
    await durableMigrationFile(file, bytes, entry.mode);
  }
}

export interface MigrationJournal {
  schemaVersion: 1;
  kind: 'liftoff-mac-npm-migration-journal';
  root: string;
  rootIdentity: string;
  scratch: string;
  operationId: string;
  review: string;
  owner: MacNpmOwner;
  brew: MacMigrationBrew;
  candidate: NativeCandidate;
  channelIdentity: string;
  policyIdentity: string;
  destination: string;
  parentIdentities: string[];
  tree: MigrationTree;
  recoveryPhysical: string;
  launcher: { target: string; physical: string; metadata?: string };
  phase: MacMigrationJournalPhase;
  targetStage?: CaskMigrationTargetStage;
  restoration?: {
    completed: { path: string; identity: string }[];
    pending?: string;
    launcherPending?: boolean;
    launcher?: { target: string; physical: string; metadata?: string };
  };
}

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (bytes: Buffer, key: Buffer) => createHmac('sha256', key).update(bytes).digest();
export const migrationJournalByteLimit = 4 * 1024 * 1024;
const envelope = (journal: MigrationJournal, mac: string) => encoded({ journal, mac });

export function migrationJournalUnsettled(journal: MigrationJournal): boolean {
  return ['npm-intent', 'link-intent', 'cask-intent', 'uncertain'].includes(journal.phase) ||
    journal.restoration?.pending !== undefined || journal.restoration?.launcherPending === true;
}

export function assertMigrationRecoveryJournalBudget(journal: MigrationJournal): void {
  const numbers = (count: number) => Array<string>(count).fill('0'.repeat(64));
  const launcher = (target: string) => ({ target, physical: JSON.stringify([...numbers(7), target]), metadata: '0'.repeat(64) });
  // Reserve the full ledger, including JSON escaping and bounded numeric identity fields, before uninstall.
  const completed = journal.tree.entries.map(entry => {
    const file = path.join(journal.owner.packageRoot, entry.path);
    const identity = entry.kind === 'directory' ? JSON.stringify([file, ...numbers(6)]) :
      entry.kind === 'link' ? JSON.stringify(launcher(entry.target!)) :
        JSON.stringify([file, ...numbers(9), '0'.repeat(64)]);
    return { path: entry.path, identity };
  });
  const pending = journal.tree.entries.reduce((longest, entry) =>
    encoded(entry.path).length > encoded(longest).length ? entry.path : longest, '');
  const projected: MigrationJournal = { ...journal, phase: 'restore-intent',
    restoration: { completed, pending, launcherPending: true, launcher: launcher(journal.launcher.target) } };
  if (envelope(projected, '0'.repeat(64)).length > migrationJournalByteLimit) {
    throw new MacMigrationFailure('recovery-journal-limit');
  }
}

export class MacMigrationJournalStore {
  private key?: Buffer;
  private rootIdentity?: string;
  private lockIdentity?: string;
  private keyIdentity?: string;
  private journalSha256?: string;
  private durableUnsettled = false;
  constructor(readonly root: string) {}

  get hasUnsettledOperation(): boolean { return this.durableUnsettled; }

  async initialize(): Promise<void> {
    await migrationDirectory(path.dirname(this.root), true);
    await mkdir(this.root, { mode: 0o700 });
    await chmod(this.root, 0o700);
    this.rootIdentity = await this.privateRoot();
    this.key = randomBytes(32);
    await durableMigrationFile(path.join(this.root, 'authority.key'), this.key);
    this.keyIdentity = await migrationFileIdentity(path.join(this.root, 'authority.key'), 32);
    await this.lock();
  }

  private async privateRoot(): Promise<string> {
    const identity = await migrationDirectory(this.root, true);
    const stat = await lstat(this.root);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new MacMigrationFailure('unsafe-journal-root');
    return identity;
  }

  async lock(): Promise<void> {
    if (await this.privateRoot() !== this.rootIdentity) throw new MacMigrationFailure('migration-root-changed');
    await mkdir(path.join(this.root, 'lock'), { mode: 0o700 });
    await durableMigrationFile(path.join(this.root, 'lock/owner.json'),
      encoded({ pid: process.pid, token: randomBytes(32).toString('hex') }));
    this.lockIdentity = macMigrationHash(await readUpgradeBytes(path.join(this.root, 'lock/owner.json'), 1024));
  }

  async release(): Promise<void> {
    await this.privateMember('lock/owner.json');
    if (!this.lockIdentity || macMigrationHash(await readUpgradeBytes(path.join(this.root, 'lock/owner.json'), 1024)) !== this.lockIdentity) {
      throw new MacMigrationFailure('migration-lock-changed');
    }
    await unlink(path.join(this.root, 'lock/owner.json'));
    await rmdir(path.join(this.root, 'lock'));
    await syncMigrationDirectory(this.root);
    this.lockIdentity = undefined;
  }

  async save(journal: MigrationJournal): Promise<void> {
    if (!this.key || !this.rootIdentity || !this.lockIdentity || await this.privateRoot() !== this.rootIdentity) {
      throw new MacMigrationFailure('journal-authority-unavailable');
    }
    if (journal.root !== this.root || journal.rootIdentity !== this.rootIdentity) throw new MacMigrationFailure('foreign-journal');
    await this.privateMember('lock/owner.json');
    await this.privateMember('authority.key');
    if (macMigrationHash(await readUpgradeBytes(path.join(this.root, 'lock/owner.json'), 1024)) !== this.lockIdentity ||
      await migrationFileIdentity(path.join(this.root, 'authority.key'), 32) !== this.keyIdentity) {
      throw new MacMigrationFailure('journal-authority-changed');
    }
    const current = path.join(this.root, 'journal.json');
    if (this.journalSha256) {
      await this.privateMember('journal.json');
      if (macMigrationHash(await readUpgradeBytes(current, migrationJournalByteLimit)) !== this.journalSha256) {
        throw new MacMigrationFailure('journal-changed');
      }
    } else if (!await migrationAbsent(current)) throw new MacMigrationFailure('journal-changed');
    const bytes = encoded(journal);
    const sealed = envelope(journal, sign(bytes, this.key).toString('hex'));
    if (sealed.length > migrationJournalByteLimit) throw new MacMigrationFailure('journal-limit');
    const temporary = path.join(this.root, `journal-${randomBytes(16).toString('hex')}.tmp`);
    await durableMigrationFile(temporary, sealed);
    await rename(temporary, current);
    await syncMigrationDirectory(this.root);
    this.journalSha256 = macMigrationHash(sealed);
    this.durableUnsettled = migrationJournalUnsettled(journal);
  }

  async read(expectedSha256: string): Promise<MigrationJournal> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new MacMigrationFailure('invalid-journal-selection');
    this.rootIdentity = await this.privateRoot();
    await this.privateMember('journal.json');
    await this.privateMember('authority.key');
    const bytes = await readUpgradeBytes(path.join(this.root, 'journal.json'), migrationJournalByteLimit);
    if (macMigrationHash(bytes) !== expectedSha256) throw new MacMigrationFailure('journal-changed');
    this.journalSha256 = expectedSha256;
    this.key = await readUpgradeBytes(path.join(this.root, 'authority.key'), 32);
    this.keyIdentity = await migrationFileIdentity(path.join(this.root, 'authority.key'), 32);
    if (this.key.length !== 32) throw new MacMigrationFailure('invalid-journal-key');
    const value = JSON.parse(bytes.toString('utf8')) as { journal: MigrationJournal; mac: string };
    if (!value || Object.keys(value).sort().join() !== 'journal,mac' || typeof value.mac !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.mac) || !timingSafeEqual(Buffer.from(value.mac, 'hex'), sign(encoded(value.journal), this.key))) {
      throw new MacMigrationFailure('unauthenticated-journal');
    }
    const journal = value.journal;
    assertJournalShape(journal);
    if (journal.schemaVersion !== 1 || journal.kind !== 'liftoff-mac-npm-migration-journal' ||
      journal.root !== this.root || journal.rootIdentity !== this.rootIdentity ||
      journal.owner.packageRoot !== path.join(journal.owner.prefix, 'lib/node_modules/@msn-control/liftoff') ||
      journal.owner.launcher !== path.join(journal.owner.prefix, 'bin/liftoff') ||
      !/^[a-f0-9]{64}$/.test(journal.review)) throw new MacMigrationFailure('foreign-journal');
    this.durableUnsettled = migrationJournalUnsettled(journal);
    return journal;
  }

  async selectDeadLock(expected: string): Promise<void> {
    await this.privateMember('lock/owner.json');
    const file = path.join(this.root, 'lock/owner.json');
    const bytes = await readUpgradeBytes(file, 1024);
    if (!/^[a-f0-9]{64}$/.test(expected) || macMigrationHash(bytes) !== expected) throw new MacMigrationFailure('lock-changed');
    const owner = JSON.parse(bytes.toString('utf8')) as { pid: number; token: string };
    if (Object.keys(owner).sort().join() !== 'pid,token' || !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 || typeof owner.token !== 'string' || !/^[a-f0-9]{64}$/.test(owner.token)) {
      throw new MacMigrationFailure('invalid-lock-owner');
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new MacMigrationFailure('lock-settlement-unknown');
      if (macMigrationHash(await readUpgradeBytes(file, 1024)) !== expected) throw new MacMigrationFailure('lock-changed');
      await unlink(file); await rmdir(path.dirname(file)); await syncMigrationDirectory(this.root); return;
    }
    throw new MacMigrationFailure('migration-owner-active');
  }

  async descriptor(): Promise<{ path: string; sha256: string }> {
    await this.privateMember('journal.json');
    const file = path.join(this.root, 'journal.json');
    const sha256 = macMigrationHash(await readUpgradeBytes(file, migrationJournalByteLimit));
    if (this.journalSha256 && sha256 !== this.journalSha256) throw new MacMigrationFailure('journal-changed');
    return { path: file, sha256 };
  }

  private async privateMember(relative: string): Promise<void> {
    if (this.rootIdentity && await this.privateRoot() !== this.rootIdentity) throw new MacMigrationFailure('migration-root-changed');
    if (relative.startsWith('lock/')) {
      const directory = path.join(this.root, 'lock');
      await migrationDirectory(directory);
      const stat = await lstat(directory);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new MacMigrationFailure('unsafe-migration-lock');
    }
    const stat = await lstat(path.join(this.root, relative));
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      throw new MacMigrationFailure('unsafe-journal-member');
    }
  }
}

function assertJournalShape(journal: MigrationJournal): void {
  const closed = (value: unknown, required: string[], optional: string[] = []) =>
    !!value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => [...required, ...optional].includes(key));
  const absolute = (value: unknown) => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value &&
    !/[\u0000-\u001f]/.test(value);
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const relative = (value: unknown) => typeof value === 'string' && (value === '' ||
    !path.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..') &&
    !/[\\\u0000-\u001f]/.test(value));
  const phases = ['prepared', 'npm-intent', 'npm-removed', 'link-intent', 'link-removed', 'cask-intent',
    'cask-settled', 'verified', 'restore-intent', 'restored', 'uncertain'];
  if (!closed(journal, ['schemaVersion', 'kind', 'root', 'rootIdentity', 'scratch', 'operationId', 'review', 'owner',
    'brew', 'candidate', 'channelIdentity', 'policyIdentity', 'destination', 'parentIdentities', 'tree',
    'recoveryPhysical', 'launcher', 'phase'], ['restoration', 'targetStage']) ||
    !phases.includes(journal.phase) || !absolute(journal.root) || !absolute(journal.scratch) ||
    journal.targetStage !== undefined && (!closed(journal.targetStage, ['root', 'sha256', 'identity']) ||
      journal.targetStage.root !== path.join(journal.root, 'cask-target') ||
      !digest(journal.targetStage.sha256) || !digest(journal.targetStage.identity)) ||
    typeof journal.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(journal.operationId) ||
    typeof journal.channelIdentity !== 'string' || !journal.channelIdentity || journal.channelIdentity.length > 10000 ||
    !closed(journal.owner, ['npm', 'node', 'prefix', 'manager', 'packageRoot', 'version', 'binary', 'launcher', 'identity', 'tools'],
      ['managerRoot', 'managerExecutable']) ||
    !journal.owner || !['custom', 'nvm', 'volta', 'homebrew-node'].includes(journal.owner.manager) ||
    !isStableSemver(journal.owner.version) ||
    ![journal.owner.prefix, journal.owner.packageRoot, journal.owner.binary, journal.owner.launcher,
      journal.owner.node, journal.owner.npm, journal.brew?.executable, journal.brew?.prefix, journal.destination].every(absolute) ||
    !journal.owner.binary.startsWith(`${journal.owner.packageRoot}/`) ||
    !closed(journal.brew, ['executable', 'prefix', 'identity']) ||
    journal.destination !== path.join(journal.brew.prefix, 'bin/liftoff') ||
    !Array.isArray(journal.owner.tools) || journal.owner.tools.length < 3 || journal.owner.tools.length > 4 ||
    !journal.owner.tools.every(value => typeof value === 'string' && value.length < 10000) ||
    !closed(journal.candidate, ['version', 'target', 'sourceCommit', 'manifestSha256', 'inventorySha256', 'identity',
      'archiveSha256'], ['bundleRoot']) || journal.candidate.target !== 'darwin-arm64' || !isStableSemver(journal.candidate.version) ||
    !/^[a-f0-9]{40}$/.test(journal.candidate.sourceCommit) ||
    ![journal.review, journal.owner.identity, journal.brew.identity, journal.candidate.identity,
      journal.candidate.manifestSha256, journal.candidate.inventorySha256, journal.candidate.archiveSha256,
      journal.policyIdentity, journal.recoveryPhysical, journal.tree?.content, journal.tree?.physical].every(digest) ||
    !Array.isArray(journal.parentIdentities) || journal.parentIdentities.length > 5 ||
    !journal.parentIdentities.every(value => typeof value === 'string' && value.length < 10000) ||
    !closed(journal.launcher, ['target', 'physical'], ['metadata']) ||
    typeof journal.launcher.target !== 'string' || typeof journal.launcher.physical !== 'string' ||
    journal.launcher.metadata !== undefined && !digest(journal.launcher.metadata) ||
    path.resolve(path.dirname(journal.owner.launcher), journal.launcher.target) !== journal.owner.binary ||
    !closed(journal.tree, ['entries', 'content', 'physical']) ||
    !Array.isArray(journal.tree.entries) || !journal.tree.entries.length || journal.tree.entries.length > 8192 ||
    journal.tree.entries[0].path !== '' || journal.tree.entries[0].kind !== 'directory' ||
    new Set(journal.tree.entries.map(entry => entry.path)).size !== journal.tree.entries.length ||
    journal.tree.entries.some(entry => !closed(entry, ['path', 'kind', 'mode', 'physical'], ['sha256', 'target', 'metadata']) ||
      !relative(entry.path) || !['file', 'directory', 'link'].includes(entry.kind) ||
      !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      entry.kind === 'directory' && (entry.mode & 0o700) !== 0o700 ||
      typeof entry.physical !== 'string' || entry.kind === 'file' && !digest(entry.sha256) ||
      entry.metadata !== undefined && !digest(entry.metadata) ||
      entry.kind === 'link' && (typeof entry.target !== 'string' || path.isAbsolute(entry.target) ||
        !path.resolve(path.dirname(path.join(journal.owner.packageRoot, entry.path)), entry.target)
          .startsWith(`${journal.owner.packageRoot}/`)))) throw new MacMigrationFailure('invalid-journal-shape');
  const restoration = journal.restoration;
  if (restoration && (!closed(restoration, ['completed'], ['pending', 'launcherPending', 'launcher']) ||
    !Array.isArray(restoration.completed) || restoration.completed.length > journal.tree.entries.length ||
    restoration.completed.some((entry, index) => entry.path !== journal.tree.entries[index].path ||
      !closed(entry, ['path', 'identity']) || typeof entry.identity !== 'string') ||
    restoration.pending !== undefined && restoration.pending !== journal.tree.entries[restoration.completed.length]?.path ||
    restoration.launcher && (restoration.launcher.target !== journal.launcher.target ||
      typeof restoration.launcher.physical !== 'string'))) throw new MacMigrationFailure('invalid-restoration-ledger');
}

async function restoredEntryIdentity(file: string, entry: MigrationTreeEntry): Promise<string> {
  if ((await assertMigrationMetadata([file])).get(file) !== entry.metadata) throw new MacMigrationFailure('restored-metadata-mismatch');
  if (entry.kind === 'directory') return migrationDirectory(file);
  if (entry.kind === 'link') return JSON.stringify(await migrationLauncher(file));
  return migrationFileIdentity(file);
}

export async function migrationParentIdentities(owner: MacNpmOwner, destination: string): Promise<string[]> {
  const parents = [...new Set([owner.prefix, path.dirname(owner.launcher), path.dirname(owner.packageRoot),
    path.dirname(path.dirname(owner.packageRoot)), path.dirname(destination)])];
  return Promise.all(parents.map(item => migrationDirectory(item, true)));
}

export async function restoreMigrationTree(source: string, journal: MigrationJournal,
  store: MacMigrationJournalStore): Promise<void> {
  const started = performance.now();
  if (!journal.restoration) { journal.restoration = { completed: [] }; await store.save(journal); }
  const restoration = journal.restoration;
  if (restoration.pending !== undefined || restoration.launcherPending) throw new MacMigrationFailure('restore-settlement-unproven');
  await assertRestoredMigrationEntriesCurrent(journal);
  for (const entry of journal.tree.entries.slice(restoration.completed.length)) {
    if (performance.now() - started > 30_000) throw new MacMigrationFailure('restore-deadline-exceeded');
    restoration.pending = entry.path; await store.save(journal);
    await assertRestoredMigrationEntriesCurrent(journal);
    await copyEntry(source, journal.owner.packageRoot, entry);
    restoration.completed.push({ path: entry.path,
      identity: await restoredEntryIdentity(path.join(journal.owner.packageRoot, entry.path), entry) });
    delete restoration.pending; await store.save(journal);
  }
}

export async function assertRestoredMigrationEntriesCurrent(journal: MigrationJournal): Promise<void> {
  if (JSON.stringify(await migrationParentIdentities(journal.owner, journal.destination)) !== JSON.stringify(journal.parentIdentities)) {
    throw new MacMigrationFailure('recovery-parent-changed');
  }
  const restoration = journal.restoration;
  if (!restoration) throw new MacMigrationFailure('missing-restoration-ledger');
  for (let index = 0; index < restoration.completed.length; index++) {
    const entry = journal.tree.entries[index];
    if (await restoredEntryIdentity(path.join(journal.owner.packageRoot, entry.path), entry) !== restoration.completed[index].identity) {
      throw new MacMigrationFailure('restored-entry-changed');
    }
    if (entry.kind === 'directory') {
      const children = restoration.completed.filter(child => child.path !== entry.path &&
        path.posix.dirname(child.path) === (entry.path || '.')).map(child => path.posix.basename(child.path)).sort();
      if (JSON.stringify(await migrationNames(path.join(journal.owner.packageRoot, entry.path), 8192)) !== JSON.stringify(children)) {
        throw new MacMigrationFailure('restored-directory-changed');
      }
    }
  }
}

export async function migrationAbsent(file: string): Promise<boolean> {
  try { await lstat(file); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export async function migrationLauncher(file: string): Promise<{ target: string; physical: string; metadata: string }> {
  const stat = await lstat(file);
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.()) {
    throw new MacMigrationFailure('launcher-not-attributable');
  }
  const metadata = (await assertMigrationMetadata([file])).get(file)!;
  const target = await readlink(file);
  return { target, physical: JSON.stringify([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.ctimeMs, target, metadata]), metadata };
}
