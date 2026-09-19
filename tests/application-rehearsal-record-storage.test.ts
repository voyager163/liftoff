import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { applicationRehearsalRecordStorage } from '../src/application/azure-activation/application-rehearsal-record-storage.js';

function fixture() {
  const values = new Map<string, unknown>(), writes: string[] = [];
  const projectRoot = '/isolated-rehearsal-fixture';
  const base = {
    async read(key: string) {
      return values.has(key) ? { projectRoot, path: `${projectRoot}/${key}`, value: structuredClone(values.get(key)) } : null;
    },
    async write(key: string, value: unknown) {
      expect(Buffer.byteLength(canonicalJson(value))).toBeLessThanOrEqual(64 * 1024);
      if (values.has(key) && canonicalSha256(values.get(key)) !== canonicalSha256(value)) throw new Error('immutable fixture conflict');
      writes.push(key);
      values.set(key, structuredClone(value));
      return { projectRoot, path: `${projectRoot}/${key}`, value };
    }
  };
  const key = canonicalSha256('exact retained rehearsal');
  const body = { originalPlan: { source: 'bounded-source-and-approval-'.repeat(4000) } };
  return { base, values, writes, key, body, store: applicationRehearsalRecordStorage(base) };
}

describe('bounded private rehearsal record storage', () => {
  it('retains an oversized original plan losslessly under the unchanged per-record limit', async () => {
    const f = fixture();
    const original = canonicalSha256(f.body);
    await f.store.write(f.key, f.body);
    expect((await f.store.read(f.key))?.value).toEqual(f.body);
    expect(canonicalSha256((await f.store.read(f.key))?.value)).toBe(original);
    expect(f.writes.at(-1)).toBe(f.key);
    const count = f.writes.length;
    await f.store.write(f.key, f.body);
    expect(f.writes).toHaveLength(count);
    await expect(f.store.write(f.key, { ...f.body, changed: true })).rejects.toThrow(/rehearsal-record-conflict/u);
  });

  it('keeps existing unchunked records byte-identical, including records above the new chunk threshold', async () => {
    const f = fixture();
    const old = { plan: 'x'.repeat(55 * 1024) };
    await f.base.write(f.key, old);
    const writes = [...f.writes];
    expect((await f.store.write(f.key, old)).value).toEqual(old);
    expect(f.writes).toEqual(writes);
    const smallKey = canonicalSha256('small original');
    await f.store.write(smallKey, { plan: 'small' });
    expect(f.values.get(smallKey)).toEqual({ plan: 'small' });
    expect(await f.store.read(canonicalSha256('absent'))).toBeNull();
  });

  it('refuses unbounded records before writing any chunk or root', async () => {
    const f = fixture();
    await expect(f.store.write(f.key, { source: 'x'.repeat(512 * 1024) })).rejects.toThrow(/rehearsal-record-size/u);
    expect(f.writes).toEqual([]);
  });

  it('accepts the exact byte ceiling and preserves UTF-8 split across chunk boundaries', async () => {
    const f = fixture();
    const overhead = Buffer.byteLength(canonicalJson({ source: '' }));
    const maximum = { source: 'x'.repeat(512 * 1024 - overhead) };
    expect(Buffer.byteLength(canonicalJson(maximum))).toBe(512 * 1024);
    await f.store.write(f.key, maximum);
    expect((await f.store.read(f.key))?.value).toEqual(maximum);
    const unicode = { source: '\u2603'.repeat(20_000) };
    const key = canonicalSha256('UTF-8 metadata');
    await f.store.write(key, unicode);
    expect((await f.store.read(key))?.value).toEqual(unicode);
  });

  it.each(['missing', 'fields', 'schema', 'kind', 'key', 'digest', 'index', 'base64', 'size', 'bytes'] as const)(
    'fails closed for a %s chunk instead of inventing or replacing the original plan', async (fault) => {
      const f = fixture();
      await f.store.write(f.key, f.body);
      const chunkKey = f.writes[0]!;
      const chunk = f.values.get(chunkKey) as Record<string, unknown>;
      if (fault === 'missing') f.values.delete(chunkKey);
      if (fault === 'fields') chunk.unregistered = true;
      if (fault === 'schema') chunk.schemaVersion = 2;
      if (fault === 'kind') chunk.kind = 'unregistered';
      if (fault === 'key') chunk.recordKey = canonicalSha256('other root');
      if (fault === 'digest') chunk.digest = '0'.repeat(64);
      if (fault === 'index') chunk.index = 1;
      if (fault === 'base64') chunk.data = '*';
      if (fault === 'size') chunk.data = Buffer.from('short').toString('base64');
      if (fault === 'bytes') chunk.data = Buffer.alloc(16 * 1024, 42).toString('base64');
      const before = f.writes.length;
      await expect(f.store.read(f.key)).rejects.toThrow(/rehearsal-record-/u);
      expect(f.writes).toHaveLength(before);
    }
  );

  it.each(['schemaVersion', 'recordKey', 'digest', 'byteLength', 'unknown'] as const)(
    'rejects malformed manifest %s without reading substitute records', async (field) => {
      const f = fixture();
      await f.store.write(f.key, f.body);
      const manifest = f.values.get(f.key) as Record<string, unknown>;
      manifest[field] = field === 'byteLength' ? 1024 * 1024 : 'invalid';
      await expect(f.store.read(f.key)).rejects.toThrow(/rehearsal-record-manifest/u);
    }
  );

  it('never publishes the root after interrupted chunk persistence and retries only identical metadata', async () => {
    const f = fixture();
    let reject = true;
    const store = applicationRehearsalRecordStorage({
      ...f.base, async write(key, value) {
        if (reject && f.writes.length === 1) throw new Error('bounded persistence rejection');
        return f.base.write(key, value);
      }
    });
    await expect(store.write(f.key, f.body)).rejects.toThrow(/bounded persistence rejection/u);
    expect(f.values.has(f.key)).toBe(false);
    reject = false;
    await store.write(f.key, f.body);
    expect((await store.read(f.key))?.value).toEqual(f.body);
  });

  it('rejects chunks copied from a different private project binding', async () => {
    const f = fixture();
    await f.store.write(f.key, f.body);
    const store = applicationRehearsalRecordStorage({
      ...f.base, async read(key) {
        const value = await f.base.read(key);
        return value && key !== f.key ? { ...value, projectRoot: '/different-fixture' } : value;
      }
    });
    await expect(store.read(f.key)).rejects.toThrow(/rehearsal-record-chunk/u);
  });

  it.each(['invalid-json', 'noncanonical', 'invalid-utf8'] as const)('refuses %s even with matching raw byte commitments', async (kind) => {
    const f = fixture();
    const bytes = kind === 'invalid-utf8' ? Buffer.alloc(60 * 1024, 255) :
      Buffer.from(kind === 'invalid-json' ? 'x'.repeat(60 * 1024) : JSON.stringify({ text: 'x'.repeat(60 * 1024) }));
    const digest = createHash('sha256').update(bytes).digest('hex');
    for (let index = 0; index < Math.ceil(bytes.length / (16 * 1024)); index++) {
      const chunk = { schemaVersion: 1, kind: 'application-rehearsal-chunk.v1', recordKey: f.key, digest, index,
        data: bytes.subarray(index * 16 * 1024, (index + 1) * 16 * 1024).toString('base64') };
      f.values.set(canonicalSha256({ kind: chunk.kind, recordKey: f.key, digest, index }), chunk);
    }
    f.values.set(f.key, { schemaVersion: 1, kind: 'application-rehearsal-chunked.v1', recordKey: f.key, digest, byteLength: bytes.length });
    await expect(f.store.read(f.key)).rejects.toThrow(/rehearsal-record-(?:json|canonical|integrity)/u);
  });
});
