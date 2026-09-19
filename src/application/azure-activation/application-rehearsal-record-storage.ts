import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { applicationPrivateAssert as must } from './application-private-contracts.js';

const chunkBytes = 16 * 1024;
const maximumBytes = 512 * 1024;
const chunkedKind = 'application-rehearsal-chunked.v1';
const chunkKind = 'application-rehearsal-chunk.v1';
type Store = Pick<ReturnType<typeof createScopedUserLocalRecordStore>, 'read' | 'write'>;

function chunkKey(recordKey: string, digest: string, index: number): string {
  return canonicalSha256({ kind: chunkKind, recordKey, digest, index });
}

/** Only rehearsal metadata is chunked; original plans and historical record bytes retain their identities. */
export function applicationRehearsalRecordStorage(store: Store): Store {
  const read: Store['read'] = async (key) => {
    const record = await store.read(key);
    if (!record || !isRecord(record.value) || record.value.kind !== chunkedKind) return record;
    const manifest = record.value;
    must(Object.keys(manifest).sort().join(',') === 'byteLength,digest,kind,recordKey,schemaVersion' &&
      manifest.schemaVersion === 1 && manifest.recordKey === key &&
      typeof manifest.digest === 'string' && /^[a-f0-9]{64}$/u.test(manifest.digest) &&
      typeof manifest.byteLength === 'number' && Number.isSafeInteger(manifest.byteLength) &&
      manifest.byteLength > 48 * 1024 && manifest.byteLength <= maximumBytes, 'rehearsal-record-manifest');
    const chunks: Buffer[] = [];
    try {
      for (let index = 0; index < Math.ceil(manifest.byteLength / chunkBytes); index++) {
        const stored = await store.read(chunkKey(key, manifest.digest, index));
        const chunk = stored?.value;
        must(stored && stored.projectRoot === record.projectRoot && isRecord(chunk) &&
          Object.keys(chunk).sort().join(',') === 'data,digest,index,kind,recordKey,schemaVersion' &&
          chunk.schemaVersion === 1 && chunk.kind === chunkKind && chunk.recordKey === key &&
          chunk.digest === manifest.digest && chunk.index === index &&
          typeof chunk.data === 'string' && chunk.data.length <= Math.ceil(chunkBytes / 3) * 4 &&
          /^[A-Za-z0-9+/]*={0,2}$/u.test(chunk.data), 'rehearsal-record-chunk');
        const bytes = Buffer.from(chunk.data, 'base64');
        chunks.push(bytes);
        must(bytes.toString('base64') === chunk.data &&
          bytes.length === Math.min(chunkBytes, manifest.byteLength - index * chunkBytes), 'rehearsal-record-chunk-size');
      }
      const bytes = Buffer.concat(chunks);
      try {
        must(bytes.length === manifest.byteLength && isUtf8(bytes) &&
          createHash('sha256').update(bytes).digest('hex') === manifest.digest, 'rehearsal-record-integrity');
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch { must(false, 'rehearsal-record-json'); }
        must(canonicalJson(value) === bytes.toString('utf8'), 'rehearsal-record-canonical');
        return { ...record, value };
      } finally { bytes.fill(0); }
    } finally { for (const chunk of chunks) chunk.fill(0); }
  };
  return {
    read,
    async write(key, value) {
      const bytes = Buffer.from(canonicalJson(value));
      try {
        must(bytes.length <= maximumBytes, 'rehearsal-record-size');
        const existing = await read(key);
        if (existing) {
          must(canonicalSha256(existing.value) === canonicalSha256(value), 'rehearsal-record-conflict');
          return existing;
        }
        if (bytes.length <= 48 * 1024) return await store.write(key, value);
        const digest = createHash('sha256').update(bytes).digest('hex');
        for (let index = 0; index < Math.ceil(bytes.length / chunkBytes); index++) {
          const data = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64');
          await store.write(chunkKey(key, digest, index), {
            schemaVersion: 1, kind: chunkKind, recordKey: key, digest, index, data
          });
        }
        // Publish the root only after every exact chunk has been durably retained.
        const stored = await store.write(key, { schemaVersion: 1, kind: chunkedKind, recordKey: key, digest, byteLength: bytes.length });
        const observed = await read(key);
        must(observed && canonicalSha256(observed.value) === canonicalSha256(value), 'rehearsal-record-readback');
        return { ...stored, value: observed.value };
      } finally { bytes.fill(0); }
    }
  };
}
