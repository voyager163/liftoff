import { lstat, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { parseDirectReceipt } from '../../domain/distribution/direct-receipt.js';
import { parseMigrationRecord } from '../../domain/distribution/migration-record.js';
import { parseNativeUpgradeRecord, type NativeUpgradeRecord } from '../../domain/distribution/upgrade-record.js';
import type { DirectInstallReceipt, InstallationMigrationRecord } from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { uuidPattern } from '../../domain/distribution/validation.js';
import {
  createInstallationRecordStore, createInstallationTransactionApprovalStore, nodeUpdatePreviewFileSystem,
  type UpdatePreviewOptions
} from '../filesystem/update-previews.js';
import { createFileAtomically } from '../filesystem/atomic-write.js';
import { captureSkillFile } from '../skills/discovery.js';
import { withUserScopeMutationLock } from '../filesystem/project-lock.js';
import { canonicalNativeRoot, canonicalDestination, ioCode, readNativeJson } from './native-files.js';
import { environmentValue } from './launcher-observation.js';

export const DIRECT_RECEIPT_FILENAME = 'liftoff-receipt.json';

export interface ReceiptStoreOptions {
  baseDirectory?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  storage?: UpdatePreviewOptions;
}

export type InstallationOperationRecord = InstallationMigrationRecord | NativeUpgradeRecord;

function recordId(record: InstallationOperationRecord): string {
  return 'operationId' in record ? record.operationId : record.migrationId;
}

function parseOperationRecord(raw: unknown): InstallationOperationRecord {
  return isRecord(raw) && raw.operation === 'native-upgrade' ? parseNativeUpgradeRecord(raw) : parseMigrationRecord(raw);
}

export class ReceiptStore {
  readonly baseDirectory: string;
  readonly homeDirectory: string;
  readonly storageOptions: UpdatePreviewOptions;

  constructor(options: ReceiptStoreOptions = {}) {
    const env = { ...options.env ?? process.env };
    this.homeDirectory = path.resolve(options.homedir ?? environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? os.homedir());
    this.baseDirectory = path.resolve(options.baseDirectory ?? path.join(this.homeDirectory, '.liftoff', 'installation'));
    this.storageOptions = { ...options.storage, env, homedir: this.homeDirectory, platform: process.platform };
  }

  get migrationRecordsDirectory(): string { return path.join(this.baseDirectory, 'migrations'); }

  approvalStore(targetRoot: string = this.homeDirectory) {
    return createInstallationTransactionApprovalStore(this.homeDirectory, this.storageOptions);
  }

  private immutableRecords() { return createInstallationRecordStore(this.baseDirectory, this.storageOptions); }

  async ensureStorage(): Promise<void> {
    await ensureNativeDirectory(this.baseDirectory);
    await ensureNativeDirectory(this.migrationRecordsDirectory);
    await assertPrivateRecordDirectory(this.baseDirectory);
    await assertPrivateRecordDirectory(this.migrationRecordsDirectory);
  }

  async saveMigrationRecord(input: InstallationMigrationRecord): Promise<InstallationMigrationRecord> {
    return parseMigrationRecord(await this.saveOperationRecord(input));
  }

  async saveUpgradeRecord(input: NativeUpgradeRecord): Promise<NativeUpgradeRecord> {
    return parseNativeUpgradeRecord(await this.saveOperationRecord(input));
  }

  private async saveOperationRecord(input: InstallationOperationRecord): Promise<InstallationOperationRecord> {
    const id = recordId(input);
    if (!uuidPattern.test(id)) throw new DistributionError('Invalid installation operation record ID.');
    await this.ensureStorage();
    return withUserScopeMutationLock(this.baseDirectory, async (lease) => {
      const previous = await this.loadOperationRecord(id);
      if (previous && (previous.planFingerprint !== input.planFingerprint || previous.status === 'completed')) {
        throw new DistributionError('A completed or differently approved installation record cannot be replaced.', 'transaction_pending');
      }
      const record = parseOperationRecord({
        ...input, revision: previous ? (previous.revision ?? 0) + 1 : 0,
        ...(previous ? { previousDigest: canonicalSha256(previous) } : {})
      });
      const directory = path.join(this.migrationRecordsDirectory, id);
      await ensureNativeDirectory(directory);
      const filename = `${String(record.revision).padStart(6, '0')}.json`;
      await lease.assertHeld();
      await createFileAtomically(path.join(directory, filename), `${JSON.stringify(record)}\n`, 0o600);
      const file = await nodeUpdatePreviewFileSystem.openFile(path.join(directory, filename), 'read', 0o600);
      try { await file.sync(); } finally { await file.close(); }
      await nodeUpdatePreviewFileSystem.syncDirectory(directory);
      await this.approvalStore(this.baseDirectory).write(record.planFingerprint, canonicalSha256(record));
      await lease.assertHeld();
      return record;
    });
  }

  async loadMigrationRecord(id: string): Promise<InstallationMigrationRecord | null> {
    const record = await this.loadOperationRecord(id);
    if (record && 'operationId' in record) throw new DistributionError('The record belongs to owner-preserving native upgrade, not npm migration.', 'recovery_required');
    return record;
  }

  async loadOperationRecord(id: string): Promise<InstallationOperationRecord | null> {
    if (!uuidPattern.test(id)) throw new DistributionError('Installation recovery ID must be a complete registered UUID.');
    const directory = path.join(this.migrationRecordsDirectory, id);
    let names: string[];
    try {
      await canonicalNativeRoot(directory);
      await assertPrivateRecordDirectory(this.baseDirectory);
      await assertPrivateRecordDirectory(this.migrationRecordsDirectory);
      await assertPrivateRecordDirectory(directory);
      names = await readdir(directory);
    }
    catch (error) { if (ioCode(error) === 'ENOENT') return null; throw error; }
    if (!names.length || names.length > 1024 || names.some((entry) => !/^\d{6}\.json$/u.test(entry))) {
      throw new DistributionError('Installation record directory contains incomplete or unregistered evidence; it was preserved.', 'recovery_required');
    }
    let latest: InstallationOperationRecord | null = null;
    for (const [revision, name] of names.sort().entries()) {
      const details = await lstat(path.join(directory, name));
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
          process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
        throw new DistributionError('Installation records require private single-link regular files.', 'recovery_required');
      }
      const record = parseOperationRecord(await readNativeJson(directory, name));
      const captured = await captureSkillFile(directory, [name]);
      if (!captured.snapshot.content?.equals(Buffer.from(`${JSON.stringify(record)}\n`))) {
        throw new DistributionError('Installation record bytes differ from their original canonical writer; the record was preserved.', 'recovery_required');
      }
      if (name !== `${String(revision).padStart(6, '0')}.json` || recordId(record) !== id ||
          record.revision !== revision || (revision === 0 ? record.previousDigest !== undefined
            : record.previousDigest !== canonicalSha256(latest)) ||
          latest && (latest.planFingerprint !== record.planFingerprint || latest.status === 'completed') ||
          !await this.approvalStore(this.baseDirectory).verify(record.planFingerprint, canonicalSha256(record))) {
        throw new DistributionError('Installation record chain or private approval seal is missing or changed; recovery evidence was preserved.', 'recovery_required');
      }
      latest = record;
    }
    return latest;
  }

  async listMigrationRecords(): Promise<InstallationMigrationRecord[]> {
    return (await this.listInstallationRecords()).filter((record): record is InstallationMigrationRecord => !('operationId' in record));
  }

  async listInstallationRecords(): Promise<InstallationOperationRecord[]> {
    let names: string[];
    try { await canonicalNativeRoot(this.migrationRecordsDirectory); names = await readdir(this.migrationRecordsDirectory); }
    catch (error) { if (ioCode(error) === 'ENOENT') return []; throw error; }
    if (names.length > 1024 || names.some((entry) => !uuidPattern.test(entry))) {
      throw new DistributionError('Installation records contain unknown or oversized recovery evidence.', 'recovery_required');
    }
    const records: InstallationOperationRecord[] = [];
    for (const id of names.sort()) {
      const record = await this.loadOperationRecord(id);
      if (!record) throw new DistributionError('An installation record disappeared during inspection.', 'recovery_required');
      records.push(record);
    }
    return records;
  }

  async loadLatestMigrationRecord(): Promise<InstallationMigrationRecord | null> {
    const records = await this.listMigrationRecords();
    const unfinished = unresolvedInstallationRecords(records);
    if (unfinished.length > 1) throw new DistributionError('Multiple unfinished installation records require explicit investigation; none was discarded.', 'transaction_pending');
    return unfinished[0] ?? records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  async assertNoPendingRecord(allowedId?: string): Promise<void> {
    if (unresolvedInstallationRecords(await this.listInstallationRecords()).some((record) => recordId(record) !== allowedId)) {
      throw new DistributionError('An unfinished installation handover blocks new installation writers. Inspect installation migrate --recover; no record was removed.', 'transaction_pending');
    }
  }

  async recordDirectAuthority(receipt: DirectInstallReceipt): Promise<void> {
    const checked = parseDirectReceipt(receipt);
    if (!checked.authority) throw new DistributionError('An unsigned direct receipt cannot establish installation ownership.', 'ownership_unknown');
    await this.ensureStorage();
    const key = canonicalSha256({ kind: 'native-direct-owner', id: checked.authority.id });
    await this.immutableRecords().write(key, {
      schemaVersion: 1, kind: 'native-direct-owner', receiptDigest: canonicalSha256(checked)
    });
  }

  async verifyDirectAuthority(receipt: DirectInstallReceipt): Promise<boolean> {
    if (!receipt.authority) return false;
    const key = canonicalSha256({ kind: 'native-direct-owner', id: receipt.authority.id });
    const record = await this.immutableRecords().read(key);
    return !!record && isRecord(record.value) && record.value.schemaVersion === 1 &&
      record.value.kind === 'native-direct-owner' && record.value.receiptDigest === canonicalSha256(receipt);
  }

  async loadDirectReceipt(installDir: string): Promise<DirectInstallReceipt | null> {
    const root = await canonicalNativeRoot(installDir);
    try {
      const value = await readNativeJson(root, DIRECT_RECEIPT_FILENAME);
      const receipt = parseDirectReceipt(value);
      if (receipt.installRoot !== root || !await this.verifyDirectAuthority(receipt)) {
        throw new DistributionError('Direct receipt does not have matching private installation authority.', 'ownership_unknown');
      }
      return receipt;
    } catch (error) {
      if (ioCode(error) === 'ENOENT' || error instanceof DistributionError && error.message === 'Required native metadata is missing.') return null;
      throw error;
    }
  }
}

export function unresolvedInstallationRecords<T extends InstallationOperationRecord>(records: readonly T[]): T[] {
  const continued = new Set<string>();
  for (const record of records) {
    if ('operationId' in record) {
      if (!record.recovery) continue;
      const original = records.find((entry) => recordId(entry) === record.recovery?.operationId);
      if (!original || !('operationId' in original) || canonicalSha256(original) !== record.recovery.recordDigest ||
          original.owner !== record.owner || original.packageId !== record.packageId ||
          original.transactionRoot !== record.transactionRoot || original.destinationDirectory !== record.destinationDirectory ||
          original.launcherPath !== record.launcherPath || original.processSettlement !== 'settled') {
        throw new DistributionError('Native upgrade continuation differs from its settled original owner scope.', 'recovery_required');
      }
      continued.add(recordId(original));
      continue;
    }
    if (!record.plan.recovery) continue;
    const original = records.find((entry) => recordId(entry) === record.plan.recovery?.migrationId);
    if (!original || 'operationId' in original ||
        canonicalSha256(original) !== record.plan.recovery.recordDigest ||
        original.targetInstallation.owner !== record.targetInstallation.owner ||
        original.targetInstallation.targetPackage !== record.targetInstallation.targetPackage ||
        original.targetInstallation.targetVersion !== record.targetInstallation.targetVersion ||
        original.targetInstallation.destinationDirectory !== record.targetInstallation.destinationDirectory ||
        original.targetInstallation.launcherPath !== record.targetInstallation.launcherPath ||
        canonicalSha256(original.legacyInstallation) !== canonicalSha256(record.legacyInstallation)) {
      throw new DistributionError('Installation recovery lineage does not match its sealed original scope.', 'recovery_required');
    }
    continued.add(recordId(original));
  }
  return records.filter((record) => record.status !== 'completed' && !continued.has(recordId(record)));
}

async function assertPrivateRecordDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new DistributionError('Installation record directories require private owner-only access.', 'recovery_required');
  }
}

export async function ensureNativeDirectory(directory: string): Promise<void> {
  const absolute = await canonicalDestination(directory, process.cwd());
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      await canonicalNativeRoot(current);
      const ancestor = await lstat(current);
      if (process.platform !== 'win32' && (ancestor.mode & 0o022) !== 0) {
        throw new DistributionError('Native state or staging parent is writable by another filesystem owner.', 'unsafe_path');
      }
      break;
    } catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error;
      missing.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }

  }
  for (const entry of missing) {
    await mkdir(entry, { mode: 0o700 });
    await nodeUpdatePreviewFileSystem.syncDirectory(path.dirname(entry));
    await canonicalNativeRoot(entry);
  }
  const details = await lstat(absolute);
  if (!details.isDirectory() || details.isSymbolicLink() || process.platform !== 'win32' && (details.mode & 0o022) !== 0) {
    throw new DistributionError('Installation state or staging directory is not exclusively owner-writable.', 'unsafe_path');
  }
}
