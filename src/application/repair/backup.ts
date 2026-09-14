import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { repairSchemaVersions } from '../../domain/repair/identity.js';
import { byteDigest, type RepairPreview } from './preview.js';

const backupChunkBytes = 24 * 1024;

export async function preserveRepairOriginals(
  preview: RepairPreview, snapshots: readonly ProjectFileSnapshot[], storage?: UpdatePreviewOptions
): Promise<{ indexKey: string; path: string }> {
  const store = createScopedUserLocalRecordStore(preview.projectRoot, 'repair-backup', storage);
  const files: { pathParts: string[]; digest: string | null; mode: number | null; fileKey: string; chunks: number }[] = [];
  for (const snapshot of snapshots) {
    const digest = snapshot.content === undefined ? null : byteDigest(snapshot.content);
    const fileKey = canonicalSha256({ kind: 'repair-original-file', fingerprint: preview.fingerprint, pathParts: snapshot.pathParts, digest });
    const chunks = snapshot.content === undefined ? 0 : Math.ceil(snapshot.content.length / backupChunkBytes);
    for (let index = 0; index < chunks; index++) {
      const key = canonicalSha256({ fileKey, index });
      await store.write(key, {
        schemaVersion: repairSchemaVersions.applicationBackup, kind: 'liftoff-repair-original-chunk',
        fingerprint: preview.fingerprint, fileKey, index,
        bytes: snapshot.content!.subarray(index * backupChunkBytes, (index + 1) * backupChunkBytes).toString('base64')
      });
    }
    files.push({ pathParts: snapshot.pathParts, digest, mode: snapshot.mode ?? null, fileKey, chunks });
  }
  const indexKey = canonicalSha256({ kind: 'repair-original-index', fingerprint: preview.fingerprint });
  const record = await store.write(indexKey, {
    schemaVersion: repairSchemaVersions.applicationBackup, kind: 'liftoff-repair-original-index',
    fingerprint: preview.fingerprint, projectRoot: preview.projectRoot, chunkBytes: backupChunkBytes, files
  });
  return { indexKey, path: record.path };
}
