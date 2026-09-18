import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashNativeFile, parseNativeJsonBytes, readNativeJson } from '../../src/adapters/distribution/native-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('bounded signed native metadata reads', () => {
  it('accepts the exact two-MiB limit and rejects the first extra byte', () => {
    const limit = 2 * 1024 * 1024;
    const exact = Buffer.from(`"${'a'.repeat(limit - 2)}"`);
    expect(exact.length).toBe(limit);
    expect(parseNativeJsonBytes(exact)).toHaveLength(limit - 2);
    expect(() => parseNativeJsonBytes(Buffer.concat([exact, Buffer.from(' ')]))).toThrow(/bounded size/);
  });

  it.each([
    Buffer.from('{"profilesDigest":"first","profilesDigest":"last"}'),
    Buffer.concat([Buffer.from('{"label":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    Buffer.from(`${'['.repeat(66)}0${']'.repeat(66)}`)
  ])('rejects duplicate, invalid UTF-8, or over-depth metadata without permissive decoding', (bytes) => {
    expect(() => parseNativeJsonBytes(bytes)).toThrow();
  });

  it('rechecks actual bytes, modes, logical path and absence against the signed observation', async () => {
    const root = path.resolve('tests', `.native-metadata-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { mode: 0o700 });
    const filename = path.join(root, 'metadata.json');
    const original = '{"value":1}';
    await writeFile(filename, original, { mode: 0o600 });
    const signed = await hashNativeFile(root, ['metadata.json']);
    await expect(readNativeJson(root, 'metadata.json', signed)).resolves.toEqual({ value: 1 });
    await writeFile(path.join(root, 'alias.json'), original, { mode: 0o600 });
    await expect(readNativeJson(root, 'alias.json', signed)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    await unlink(path.join(root, 'alias.json'));
    await writeFile(filename, '{"value":2}');
    await expect(readNativeJson(root, 'metadata.json', signed)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    await writeFile(filename, original);
    await chmod(filename, 0o400);
    await expect(readNativeJson(root, 'metadata.json', signed)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    await unlink(filename);
    await expect(readNativeJson(root, 'metadata.json', signed)).rejects.toMatchObject({ reasonCode: 'invalid_metadata' });
    expect(await readdir(root)).toEqual([]);
  });
});
