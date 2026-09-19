import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashNativeFile } from '../../src/adapters/distribution/native-files.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(size: number) {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('tests', '.native-streaming-')));
  roots.push(root);
  const file = path.join(root, 'runtime.bin');
  const bytes = Buffer.alloc(size, 0x81);
  if (bytes.length) bytes[bytes.length - 1] = 0xff;
  await fs.writeFile(file, bytes);
  return { root, file, bytes };
}
async function observeReads(file: string, afterFirst?: () => Promise<void>) {
  const reads: Array<{ requested: number; position: number; read: number }> = [];
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file && typeof args[1] === 'number') {
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        reads.push({ requested: length, position, read: result.bytesRead });
        if (reads.length === 1) await afterFirst?.();
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  syncBuiltinESMExports();
  return reads;
}

describe('bounded full-byte native streaming hashes', () => {
  it('hashes every byte with bounded MiB reads rather than thousands of small asynchronous reads', async () => {
    const value = await fixture(5 * 1024 * 1024 + 3);
    const reads = await observeReads(value.file);
    const result = await hashNativeFile(value.root, ['runtime.bin'], value.bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(value.bytes).digest('hex'));
    expect(result.size).toBe(value.bytes.length);
    expect(reads).toHaveLength(7);
    expect(reads.every((read) => read.requested <= 1024 * 1024)).toBe(true);
    expect(reads.reduce((total, read) => total + read.read, 0)).toBe(value.bytes.length);
    expect(reads.at(-1)).toEqual({ requested: 1, position: value.bytes.length, read: 0 });
  });

  it('refuses growth after observing at most one byte beyond the captured bound', async () => {
    const value = await fixture(2 * 1024 * 1024);
    const reads = await observeReads(value.file, () => fs.appendFile(value.file, Buffer.alloc(4096, 7)));
    await expect(hashNativeFile(value.root, ['runtime.bin'], value.bytes.length)).rejects.toMatchObject({ reasonCode: 'stale_plan' });
    expect(reads.reduce((total, read) => total + read.read, 0)).toBe(value.bytes.length + 1);
    expect(reads.at(-1)?.requested).toBe(1);
  });

  it('retains empty-file identity at an exact zero-byte ceiling', async () => {
    const value = await fixture(0);
    expect(await hashNativeFile(value.root, ['runtime.bin'], 0)).toMatchObject({
      size: 0, sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    });
  });
});
