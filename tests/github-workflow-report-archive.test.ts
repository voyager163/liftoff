import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  extractWorkflowReport as publicExtractor, WorkflowReportArchiveError as PublicArchiveError,
  workflowReportArchiveErrorCode as publicArchiveErrorCode
} from '../src/adapters/github/production-checks.js';
import {
  extractWorkflowReport, WorkflowReportArchiveError, workflowReportArchiveErrorCode
} from '../src/adapters/github/workflow-report-archive.js';
import { GitHubActivationError } from '../src/adapters/github/activation-rest.js';

const inflater = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    inflateRawSync: (...args: Parameters<typeof actual.inflateRawSync>) => {
      if (inflater.error) throw inflater.error;
      return actual.inflateRawSync(...args);
    }
  };
});

const filename = 'workflow-report.json';
const report = Buffer.from('{"kind":"bounded-workflow-test","ok":true}\n');

function reportZip(content = report, options: {
  filename?: string;
  deflated?: boolean;
  zip64?: boolean;
  centralZip64Only?: boolean;
  localZip64Only?: boolean;
  descriptor?: 'signed' | 'unsigned';
  compressedSuffix?: Buffer;
} = {}) {
  const name = Buffer.from(options.filename ?? filename);
  const zip64 = options.zip64 === true || options.centralZip64Only === true;
  const localWide = zip64 && !options.centralZip64Only || options.localZip64Only === true;
  const descriptorWide = zip64 || localWide;
  const version = descriptorWide ? 45 : 20;
  const method = options.deflated ? 8 : 0;
  const packed = Buffer.concat([options.deflated ? deflateRawSync(content) : content, options.compressedSuffix ?? Buffer.alloc(0)]);
  const checksum = crc32(content);
  const flags = 0x0800 | (options.descriptor ? 8 : 0);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(version, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(options.descriptor ? 0 : checksum, 14);
  local.writeUInt32LE(localWide ? 0xffffffff : options.descriptor ? 0 : packed.length, 18);
  local.writeUInt32LE(localWide ? 0xffffffff : options.descriptor ? 0 : content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localExtra = Buffer.alloc(localWide ? 20 : 0);
  if (localWide) {
    localExtra.writeUInt16LE(1, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(options.descriptor ? 0 : content.length), 4);
    localExtra.writeBigUInt64LE(BigInt(options.descriptor ? 0 : packed.length), 12);
  }
  local.writeUInt16LE(localExtra.length, 28);
  const descriptor = Buffer.alloc(options.descriptor ? (descriptorWide ? 20 : 12) + (options.descriptor === 'signed' ? 4 : 0) : 0);
  if (options.descriptor) {
    const at = options.descriptor === 'signed' ? 4 : 0;
    if (at) descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, at);
    if (descriptorWide) {
      descriptor.writeBigUInt64LE(BigInt(packed.length), at + 4);
      descriptor.writeBigUInt64LE(BigInt(content.length), at + 12);
    } else {
      descriptor.writeUInt32LE(packed.length, at + 4);
      descriptor.writeUInt32LE(content.length, at + 8);
    }
  }
  const dataStart = local.length + name.length + localExtra.length;
  const centralOffset = dataStart + packed.length + descriptor.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | version, 4);
  central.writeUInt16LE(version, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
  central.writeUInt32LE(zip64 ? 0xffffffff : content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  central.writeUInt32LE(zip64 ? 0xffffffff : 0, 42);
  const centralExtra = Buffer.alloc(zip64 ? 28 : 0);
  if (zip64) {
    centralExtra.writeUInt16LE(1, 0);
    centralExtra.writeUInt16LE(24, 2);
    centralExtra.writeBigUInt64LE(BigInt(content.length), 4);
    centralExtra.writeBigUInt64LE(BigInt(packed.length), 12);
    centralExtra.writeBigUInt64LE(0n, 20);
  }
  central.writeUInt16LE(centralExtra.length, 30);
  const centralSize = central.length + name.length + centralExtra.length;
  const end64 = Buffer.alloc(zip64 ? 56 : 0), locator = Buffer.alloc(zip64 ? 20 : 0);
  if (zip64) {
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(1n, 24);
    end64.writeBigUInt64LE(1n, 32);
    end64.writeBigUInt64LE(BigInt(centralSize), 40);
    end64.writeBigUInt64LE(BigInt(centralOffset), 48);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
  }
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(zip64 ? 0xffff : 1, 8);
  footer.writeUInt16LE(zip64 ? 0xffff : 1, 10);
  footer.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12);
  footer.writeUInt32LE(zip64 ? 0xffffffff : centralOffset, 16);
  const archive = Buffer.concat([local, name, localExtra, packed, descriptor, central, name, centralExtra, end64, locator, footer]);
  return {
    archive, dataStart, central: centralOffset, footer: archive.length - 22,
    descriptor: dataStart + packed.length, localExtra: local.length + name.length,
    centralExtra: centralOffset + central.length + name.length,
    end64: centralOffset + centralSize, locator: archive.length - 42
  };
}

describe('bounded shared workflow report extraction', () => {
  it('exports one specific archive error type/code without absorbing extraction-option errors', () => {
    expect(PublicArchiveError).toBe(WorkflowReportArchiveError);
    expect(publicArchiveErrorCode).toBe(workflowReportArchiveErrorCode);
    expect(workflowReportArchiveErrorCode).toBe('workflow-report-archive');
    const invalid = Buffer.alloc(22);
    expect(() => publicExtractor(invalid, { filename, maxBytes: 256 })).toThrow(WorkflowReportArchiveError);
    expect(() => publicExtractor(invalid, { filename, maxBytes: 256 })).toThrow(GitHubActivationError);
    expect(() => publicExtractor(invalid, { filename, maxBytes: 256 }))
      .toThrow(expect.objectContaining({ code: workflowReportArchiveErrorCode }));
    expect(() => publicExtractor(reportZip().archive, { filename, maxBytes: 0 }))
      .toThrow(expect.objectContaining({ code: 'workflow-report-options' }));
    expect(() => publicExtractor(reportZip().archive, { filename, maxBytes: 0 })).not.toThrow(WorkflowReportArchiveError);
  });

  it.each([0, 21, 4 * 1024 * 1024 + 1])('classifies invalid archive length %s as an archive error, not an option error', (size) => {
    expect(() => extractWorkflowReport(Buffer.alloc(size), { filename, maxBytes: 64 * 1024 })).toThrow(WorkflowReportArchiveError);
  });

  it.each(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_BUFFER_TOO_LARGE'])('classifies the known inflater error %s without leaking its diagnostics', (code) => {
    inflater.error = Object.assign(new Error('untrusted inflater diagnostics'), { code });
    try {
      expect(() => extractWorkflowReport(reportZip(report, { deflated: true }).archive, { filename, maxBytes: 256 }))
        .toThrow(WorkflowReportArchiveError);
      expect(() => extractWorkflowReport(reportZip(report, { deflated: true }).archive, { filename, maxBytes: 256 }))
        .not.toThrow(/untrusted inflater diagnostics/);
    } finally {
      inflater.error = undefined;
    }
  });

  it('propagates an unexpected inflater failure unchanged and preserves caller-owned archive bytes', () => {
    const unexpected = Object.assign(new Error('unexpected inflater failure'), { code: 'Z_MEM_ERROR' });
    const archive = reportZip(report, { deflated: true }).archive;
    const original = Buffer.from(archive);
    inflater.error = unexpected;
    let caught: unknown;
    try {
      extractWorkflowReport(archive, { filename, maxBytes: 256 });
    } catch (error) {
      caught = error;
    } finally {
      inflater.error = undefined;
    }
    expect(caught).toBe(unexpected);
    expect(caught).not.toBeInstanceOf(WorkflowReportArchiveError);
    expect(archive).toEqual(original);
  });

  it.each([
    {}, { deflated: true }, { descriptor: 'signed' }, { descriptor: 'unsigned' },
    { deflated: true, descriptor: 'signed' }, { deflated: true, descriptor: 'unsigned' },
    { zip64: true }, { zip64: true, deflated: true },
    { zip64: true, descriptor: 'signed' }, { zip64: true, descriptor: 'unsigned' },
    { zip64: true, deflated: true, descriptor: 'signed' }, { zip64: true, deflated: true, descriptor: 'unsigned' },
    { centralZip64Only: true, descriptor: 'signed' }, { centralZip64Only: true, deflated: true, descriptor: 'signed' },
    { localZip64Only: true }, { localZip64Only: true, deflated: true, descriptor: 'signed' },
    { localZip64Only: true, descriptor: 'unsigned' }
  ] as const)('extracts one exact report with %j and preserves caller bytes', (options) => {
    const { archive } = reportZip(report, options);
    const original = Buffer.from(archive);
    const extracted = extractWorkflowReport(archive, { filename, maxBytes: report.length });
    expect(extracted).toEqual(report);
    expect(archive).toEqual(original);
    extracted.fill(0);
    expect(archive).toEqual(original);
    expect(publicExtractor).toBe(extractWorkflowReport);
  });

  it('accepts one exact nested relative filename but rejects a different requested file', () => {
    const nested = 'reports/workflow-report.json';
    const { archive } = reportZip(report, { filename: nested });
    expect(extractWorkflowReport(archive, { filename: nested, maxBytes: 256 })).toEqual(report);
    expect(() => extractWorkflowReport(archive, { filename, maxBytes: 256 })).toThrow(/exactly one/);
  });

  it.each(['../workflow-report.json', '/workflow-report.json', 'a/../workflow-report.json', 'a//workflow-report.json', 'a\\workflow-report.json', 'C:workflow-report.json'])(
    'rejects unsafe requested filename %s', (name) => {
      expect(() => extractWorkflowReport(reportZip(report, { filename: name }).archive, { filename: name, maxBytes: 256 })).toThrow(/safe relative filename/);
    });

  it.each([0, -1, 1.5, NaN, Infinity, 4 * 1024 * 1024 + 1])('rejects an invalid report bound %s', (maxBytes) => {
    expect(() => extractWorkflowReport(reportZip().archive, { filename, maxBytes })).toThrow(/positive byte bound/);
  });

  it('enforces declared and actual expansion bounds, CRC and UTF-8', () => {
    const exact = reportZip();
    expect(() => extractWorkflowReport(exact.archive, { filename, maxBytes: report.length - 1 })).toThrow(/bounded regular UTF-8/);
    const invalidUtf8 = reportZip(Buffer.from([0xff, 0xfe]));
    expect(() => extractWorkflowReport(invalidUtf8.archive, { filename, maxBytes: 256 })).toThrow(/UTF-8/);
    exact.archive[exact.dataStart] ^= 1;
    expect(() => extractWorkflowReport(exact.archive, { filename, maxBytes: 256 })).toThrow(/CRC/);
    const bomb = reportZip(Buffer.alloc(16 * 1024, 'a'), { deflated: true });
    bomb.archive.writeUInt32LE(32, 22);
    bomb.archive.writeUInt32LE(32, bomb.central + 24);
    expect(() => extractWorkflowReport(bomb.archive, { filename, maxBytes: 128 })).toThrow(/bounded/);
  });

  it('rejects hidden bytes after the compressed stream even when report size and CRC match', () => {
    const { archive } = reportZip(report, { deflated: true, compressedSuffix: Buffer.from('unaccounted payload') });
    expect(() => extractWorkflowReport(archive, { filename, maxBytes: 256 })).toThrow(/ambiguous payloads/);
  });

  it.each([
    'multiple-entries', 'multi-disk', 'symlink', 'directory', 'encryption', 'unsupported-compression',
    'local-name', 'local-flags', 'local-size', 'local-time', 'central-size', 'local-offset', 'central-comment'
  ])('rejects %s metadata without returning bytes', (change) => {
    const f = reportZip();
    if (change === 'multiple-entries') f.archive.writeUInt16LE(2, f.footer + 10);
    if (change === 'multi-disk') f.archive.writeUInt16LE(1, f.footer + 4);
    if (change === 'symlink') f.archive.writeUInt32LE((0o120777 << 16) >>> 0, f.central + 38);
    if (change === 'directory') f.archive.writeUInt32LE(0x10, f.central + 38);
    if (change === 'encryption') f.archive.writeUInt16LE(0x0801, f.central + 8);
    if (change === 'unsupported-compression') f.archive.writeUInt16LE(9, f.central + 10);
    if (change === 'local-name') f.archive[30] ^= 1;
    if (change === 'local-flags') f.archive.writeUInt16LE(0, 6);
    if (change === 'local-size') f.archive.writeUInt32LE(report.length - 1, 22);
    if (change === 'local-time') f.archive.writeUInt32LE(1, 10);
    if (change === 'central-size') f.archive.writeUInt32LE(46, f.footer + 12);
    if (change === 'local-offset') f.archive.writeUInt32LE(1, f.central + 42);
    if (change === 'central-comment') f.archive.writeUInt16LE(1, f.central + 32);
    expect(() => extractWorkflowReport(f.archive, { filename, maxBytes: 256 })).toThrow(/workflow archive/);
  });

  it.each(['locator-disk', 'large-integer', 'inconsistent-classic-count', 'inconsistent-classic-offset', 'unknown-extra', 'local-zip64-size', 'descriptor-size'])(
    'rejects inconsistent ZIP64 %s', (change) => {
      const f = reportZip(report, { zip64: true, descriptor: 'signed' });
      if (change === 'locator-disk') f.archive.writeUInt32LE(2, f.locator + 16);
      if (change === 'large-integer') f.archive.writeBigUInt64LE(2n ** 60n, f.centralExtra + 4);
      if (change === 'inconsistent-classic-count') f.archive.writeUInt16LE(2, f.footer + 10);
      if (change === 'inconsistent-classic-offset') f.archive.writeUInt32LE(1, f.footer + 16);
      if (change === 'unknown-extra') f.archive.writeUInt16LE(0x7075, f.centralExtra);
      if (change === 'local-zip64-size') f.archive.writeBigUInt64LE(2n, f.localExtra + 4);
      if (change === 'descriptor-size') f.archive.writeBigUInt64LE(2n, f.descriptor + 16);
      expect(() => extractWorkflowReport(f.archive, { filename, maxBytes: 256 })).toThrow(/workflow archive/);
    });

  it('rejects truncated or suffixed archives and unexpected extraction options', () => {
    const { archive } = reportZip();
    for (const length of [0, 1, 21, 31, archive.length - 1]) {
      expect(() => extractWorkflowReport(archive.subarray(0, length), { filename, maxBytes: 256 })).toThrow();
    }
    expect(() => extractWorkflowReport(Buffer.concat([archive, Buffer.from('extra')]), { filename, maxBytes: 256 })).toThrow();
    const unexpected = { filename, maxBytes: 256, providerVerified: true };
    expect(() => extractWorkflowReport(archive, unexpected)).toThrow(/safe relative filename/);
  });
});
