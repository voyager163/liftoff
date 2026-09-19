import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractPrivateReportArchive, readPrivateReportArchive } from '../src/application/azure-activation/private-report-archive.js';
import { singleReportBytesZip } from './helpers/private-report-zip-fixture.js';

const filename = 'report.json';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function deflatedArchive(content: Buffer, descriptor?: 'signed' | 'unsigned', compressed: Uint8Array = deflateRawSync(content)): Buffer {
  const stored = singleReportBytesZip(content, filename);
  const footer = stored.length - 22, start = stored.readUInt32LE(footer + 16);
  const header = Buffer.from(stored.subarray(0, start - content.length));
  const central = Buffer.from(stored.subarray(start, footer)), end = Buffer.from(stored.subarray(footer));
  const trailer = Buffer.alloc(descriptor === 'signed' ? 16 : descriptor === 'unsigned' ? 12 : 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  if (descriptor) {
    header.writeUInt16LE(8, 6);
    header.fill(0, 14, 26);
    central.writeUInt16LE(8, 8);
    const offset = descriptor === 'signed' ? 4 : 0;
    if (descriptor === 'signed') trailer.writeUInt32LE(0x08074b50, 0);
    trailer.writeUInt32LE(crc32(content), offset);
    trailer.writeUInt32LE(compressed.length, offset + 4);
    trailer.writeUInt32LE(content.length, offset + 8);
  }
  end.writeUInt32LE(header.length + compressed.length + trailer.length, 16);
  return Buffer.concat([header, compressed, trailer, central, end]);
}

function paddedDeflate(content: Buffer): Buffer {
  const emptyBlocks = 104_832;
  const compressed = Buffer.alloc(emptyBlocks * 5 + 5 + content.length);
  for (let offset = 0; offset < emptyBlocks * 5; offset += 5) compressed.writeUInt16LE(0xffff, offset + 3);
  const final = emptyBlocks * 5;
  compressed[final] = 1;
  compressed.writeUInt16LE(content.length, final + 1);
  compressed.writeUInt16LE(0xffff - content.length, final + 3);
  content.copy(compressed, final + 5);
  return compressed;
}

describe('bounded exact private report byte extraction', () => {
  it('preserves the original duplicate keys, whitespace and byte digest instead of reserializing parsed JSON', () => {
    const report = Buffer.from('{"value":1,"value":2} \n');
    const archive = singleReportBytesZip(report, filename);
    const before = Buffer.from(archive);
    const bytes = extractPrivateReportArchive(archive, filename);
    expect(bytes).toEqual(report);
    expect(digest(bytes)).toBe(digest(report));
    const parsed = readPrivateReportArchive(archive, filename);
    expect(parsed).toEqual({ value: 2 });
    expect(digest(bytes)).not.toBe(digest(Buffer.from(JSON.stringify(parsed))));
    bytes.fill(0);
    expect(archive).toEqual(before);
    const again = extractPrivateReportArchive(archive, filename);
    try { expect(again).toEqual(report); } finally { again.fill(0); }
  });

  it('keeps raw extraction separate from JSON validation and preserves the existing parsed API errors', () => {
    for (const report of [Buffer.from('not-json\n'), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])]) {
      const archive = singleReportBytesZip(report, filename);
      const bytes = extractPrivateReportArchive(archive, filename);
      try { expect(bytes).toEqual(report); } finally { bytes.fill(0); }
      expect(() => readPrivateReportArchive(archive, filename)).toThrowError(/bounded regular UTF-8 JSON report/u);
    }
  });

  it('inherits shared UTF-8 admission without normalizing invalid payload bytes', () => {
    const archive = singleReportBytesZip(Buffer.from([0xff, 0x00]), filename);
    const before = Buffer.from(archive);
    expect(() => extractPrivateReportArchive(archive, filename)).toThrowError(/bounded regular UTF-8 JSON report/u);
    expect(() => readPrivateReportArchive(archive, filename)).toThrowError(/bounded regular UTF-8 JSON report/u);
    expect(archive).toEqual(before);
  });

  it('preserves the default filename and returns independently owned bytes for archive subarrays', () => {
    const report = Buffer.from('{"source":"exact"}\n');
    const archive = singleReportBytesZip(report);
    const wrapped = Buffer.concat([Buffer.from('before'), archive, Buffer.from('after')]);
    const bytes = extractPrivateReportArchive(wrapped.subarray(6, 6 + archive.length));
    expect(bytes).toEqual(report);
    wrapped.fill(0);
    expect(bytes).toEqual(report);
    bytes.fill(0);
    expect(readPrivateReportArchive(archive)).toEqual({ source: 'exact' });
  });

  it.each([undefined, 'signed', 'unsigned'] as const)('extracts exact deflated bytes with %s data descriptor', (descriptor) => {
    const report = Buffer.from(' { "sequence": [1,2,3] }\n');
    const archive = deflatedArchive(report, descriptor);
    const bytes = extractPrivateReportArchive(archive, filename);
    try { expect(bytes).toEqual(report); } finally { bytes.fill(0); }
    expect(readPrivateReportArchive(archive, filename)).toEqual({ sequence: [1, 2, 3] });
  });

  it('accepts a valid ZIP at exactly512KiB and rejects a valid encoded ZIP one byte larger', () => {
    const report = Buffer.from('{}\n'), larger = Buffer.from('{} \n');
    const atLimit = deflatedArchive(report, undefined, paddedDeflate(report));
    const overLimit = deflatedArchive(larger, undefined, paddedDeflate(larger));
    expect(atLimit.length).toBe(512 * 1024);
    expect(overLimit.length).toBe(512 * 1024 + 1);
    const bytes = extractPrivateReportArchive(atLimit, filename);
    try { expect(bytes).toEqual(report); } finally { bytes.fill(0); }
    expect(() => extractPrivateReportArchive(overLimit, filename)).toThrow();
  });

  it('preserves the128KiB expanded ceiling and leaves stricter consumer caps to the caller', () => {
    const report = Buffer.alloc(128 * 1024, 0x20);
    report.write('{}');
    const bytes = extractPrivateReportArchive(deflatedArchive(report), filename);
    try {
      expect(bytes.length).toBe(128 * 1024);
      expect(bytes.length).toBeGreaterThan(64 * 1024);
      expect(bytes).toEqual(report);
    } finally { bytes.fill(0); }
    expect(() => extractPrivateReportArchive(deflatedArchive(Buffer.alloc(128 * 1024 + 1, 0x20)), filename)).toThrow();
  });

  const corruptions: [string, (archive: Buffer, central: number) => void][] = [
    ['Unix directory', (archive, central) => { archive.writeUInt32LE(0o040755 * 0x10000, central + 38); }],
    ['Unix symbolic link', (archive, central) => { archive.writeUInt32LE(0o120777 * 0x10000, central + 38); }],
    ['DOS directory', (archive, central) => { archive.writeUInt32LE(0x10, central + 38); }],
    ['regular mode with DOS directory flag', (archive, central) => { archive.writeUInt32LE(0o100600 * 0x10000 + 0x10, central + 38); }],
    ['encrypted entry', (archive, central) => { archive.writeUInt16LE(1, 6); archive.writeUInt16LE(1, central + 8); }],
    ['extra entry', (archive) => { archive.writeUInt16LE(2, archive.length - 14); archive.writeUInt16LE(2, archive.length - 12); }],
    ['local CRC mismatch', (archive) => { archive.writeUInt32LE(0, 14); }],
    ['local size mismatch', (archive) => { archive.writeUInt32LE(0, 22); }],
    ['central size mismatch', (archive, central) => { archive.writeUInt32LE(1, central + 24); }],
    ['local name mismatch', (archive) => { archive[30] = 0x78; }],
    ['extra field', (archive) => { archive.writeUInt16LE(1, 28); }],
    ['central comment', (archive, central) => { archive.writeUInt16LE(1, central + 32); }],
    ['multidisk entry', (archive, central) => { archive.writeUInt16LE(1, central + 34); }],
    ['unexpected local offset', (archive, central) => { archive.writeUInt32LE(1, central + 42); }],
    ['corrupt payload', (archive) => { archive[30 + Buffer.byteLength(filename)] = 0x78; }]
  ];
  it.each(corruptions)('rejects %s through both extraction and the existing reader', (_label, corrupt) => {
    const archive = singleReportBytesZip(Buffer.from('{"value":42}\n'), filename);
    const central = archive.readUInt32LE(archive.length - 6);
    corrupt(archive, central);
    expect(() => extractPrivateReportArchive(archive, filename)).toThrow();
    expect(() => readPrivateReportArchive(archive, filename)).toThrow();
  });

  it('accepts an ordinary regular-file mode and rejects bytes outside the single declared ZIP', () => {
    const report = Buffer.from('{"value":42}\n');
    const archive = singleReportBytesZip(report, filename);
    const central = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt32LE(0o100600 * 0x10000 + 0x20, central + 38);
    const bytes = extractPrivateReportArchive(archive, filename);
    try { expect(bytes).toEqual(report); } finally { bytes.fill(0); }
    expect(() => extractPrivateReportArchive(Buffer.concat([Buffer.alloc(1), archive]), filename)).toThrow();
    expect(() => extractPrivateReportArchive(Buffer.concat([archive, Buffer.alloc(1)]), filename)).toThrow();
  });

  it.each(['../report.json', 'dir/report.json', '.hidden.json', 'a..json', '*.json', 'report\u0000.json', 'report.txt'])(
    'requires an exact safe JSON basename: %j', (unsafe) => {
      const archive = singleReportBytesZip(Buffer.from('{}'), unsafe);
      expect(() => extractPrivateReportArchive(archive, unsafe)).toThrow();
    }
  );

  it('rejects a different exact basename instead of selecting the first file', () => {
    expect(() => extractPrivateReportArchive(singleReportBytesZip(Buffer.from('{}'), filename), 'different.json')).toThrow();
  });
});
