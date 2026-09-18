import { describe, expect, it } from 'vitest';
import {
  inspectControlledGnomeBinary, maximumControlledGnomeStoreBytes
} from '../src/adapters/state/gnome-persisted-format.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function text(value: string | null): Buffer {
  if (value === null) return u32(0xffffffff);
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}
function fixture(options: {
  flags?: number; iterations?: number; itemCount?: number; itemType?: number;
  label?: string | null; version?: Buffer; reserved?: number; attrs?: Buffer; ciphertext?: Buffer
} = {}) {
  return Buffer.concat([
    Buffer.from('GnomeKeyring\n\r\0\n\0', 'ascii'), options.version ?? Buffer.alloc(4),
    text(options.label === undefined ? 'PRIVATE_COLLECTION_LABEL' : options.label),
    Buffer.alloc(16), u32(options.flags ?? 0), u32(0), u32(options.iterations ?? 2048),
    Buffer.alloc(8, 0x32), u32(options.reserved ?? 0), Buffer.alloc(12),
    u32(options.itemCount ?? 1), u32(42), u32(options.itemType ?? 0),
    options.attrs ?? Buffer.concat([u32(1), text('PRIVATE_ATTRIBUTE'), u32(0), text('PRIVATE_HASH')]),
    u32((options.ciphertext ?? Buffer.alloc(32, 0xa5)).length),
    options.ciphertext ?? Buffer.alloc(32, 0xa5)
  ]);
}

describe('pinned GNOME binary structural admission, synthetic bytes only', () => {
  it('binds the complete bytes while withholding labels and hashed attributes', () => {
    const bytes = fixture();
    const original = Buffer.from(bytes);
    const observed = inspectControlledGnomeBinary(bytes);
    expect(observed).toMatchObject({
      sha256: stateDigest(bytes), bytes: bytes.length, itemId: 42, encryptedBytes: 32, iterations: 2048,
      cipher: 'aes-128-cbc', contentChecksum: 'md5-not-authentication',
      evidence: 'structural-only', authenticated: false, persistenceVerified: false, readiness: false
    });
    expect(JSON.stringify(observed)).not.toContain('PRIVATE');
    expect(bytes).toEqual(original);
    expect(Object.isFrozen(observed)).toBe(true);
    bytes[bytes.length - 1] ^= 1;
    expect(inspectControlledGnomeBinary(bytes).sha256).not.toBe(observed.sha256);
  });

  it.each([0, 1, 2])('accepts known lock flags %i without treating them as custody observations', (flags) => {
    expect(inspectControlledGnomeBinary(fixture({ flags, label: null })).readiness).toBe(false);
  });

  it('accepts bounded legacy integer hashed attributes without copying them to evidence', () => {
    const attrs = Buffer.concat([u32(2), text('one'), u32(1), u32(99), text('two'), u32(0), text(null)]);
    expect(inspectControlledGnomeBinary(fixture({ attrs })).evidence).toBe('structural-only');
  });

  it('rejects every truncation boundary and any trailing payload', () => {
    const bytes = fixture();
    for (let length = 0; length < bytes.length; length++) {
      expect(() => inspectControlledGnomeBinary(bytes.subarray(0, length))).toThrow('artifact-integrity');
    }
    expect(() => inspectControlledGnomeBinary(Buffer.concat([bytes, Buffer.from('trailing')]))).toThrow('artifact-integrity');
  });

  it.each([
    { flags: 3 }, { flags: 4 }, { iterations: 999 }, { iterations: 4096 },
    { itemCount: 0 }, { itemCount: 2 }, { reserved: 1 },
    { version: Buffer.from([0, 0, 1, 0]) }, { ciphertext: Buffer.alloc(0) },
    { ciphertext: Buffer.alloc(17) }, { label: 'x'.repeat(1025) }, { label: 'unsafe\0label' }
  ])('rejects structure outside the reviewed writer contract %#', (change) => {
    expect(() => inspectControlledGnomeBinary(fixture(change))).toThrow('artifact-integrity');
  });

  it.each([
    Buffer.concat([u32(17)]),
    Buffer.concat([u32(1), text(null), u32(0), text('ignored')]),
    Buffer.concat([u32(1), text(''), u32(0), text('ignored')]),
    Buffer.concat([u32(1), text('name'), u32(2), u32(0)]),
    Buffer.concat([u32(2), text('same'), u32(0), text('a'), text('same'), u32(0), text('b')]),
    Buffer.concat([u32(1), u32(1), Buffer.from([0xff]), u32(0), text('value')])
  ])('rejects malformed or duplicate hashed attributes %#', (attrs) => {
    expect(() => inspectControlledGnomeBinary(fixture({ attrs }))).toThrow('artifact-integrity');
  });

  it('rejects plaintext files, future formats and unbounded input without echoing contents', () => {
    for (const bytes of [
      Buffer.from('[keyring]\nPRIVATE_PASSWORD=value\n'),
      Buffer.alloc(maximumControlledGnomeStoreBytes + 1),
      Buffer.concat([Buffer.from('wrong magic header'), fixture()])
    ]) {
      expect(() => inspectControlledGnomeBinary(bytes)).toThrow('artifact-integrity');
      expect(() => inspectControlledGnomeBinary(bytes)).not.toThrow('PRIVATE');
    }
  });
});
