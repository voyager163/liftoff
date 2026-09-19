import { isUtf8 } from 'node:buffer';
import { crc32, inflateRawSync } from 'node:zlib';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { GitHubActivationError } from './activation-rest.js';

export interface WorkflowReportExtractionOptions {
  filename: string;
  maxBytes: number;
}

export const workflowReportArchiveErrorCode = 'workflow-report-archive' as const;

/** Invalid archive bytes only; options and unexpected inflater failures remain distinct. */
export class WorkflowReportArchiveError extends GitHubActivationError {
  constructor() {
    super(workflowReportArchiveErrorCode,
      'The verified workflow archive must contain exactly one bounded regular UTF-8 report with consistent ZIP metadata, size and CRC; extra files, links, traversal and ambiguous payloads are forbidden.');
    this.name = 'WorkflowReportArchiveError';
  }
}

const maximumArchiveBytes = 4 * 1024 * 1024;
const sentinel32 = 0xffffffff;

function invalidArchive(): never {
  throw new WorkflowReportArchiveError();
}

function invalidOptions(): never {
  throw new GitHubActivationError('workflow-report-options', 'Report extraction requires an exact safe relative filename and a positive byte bound of at most 4 MiB.');
}

/** Extracts bytes only after source/run/provider-digest admission; it does not establish report semantics or execution authority. */
export function extractWorkflowReport(archive: Uint8Array, options: WorkflowReportExtractionOptions): Buffer {
  if (!(archive instanceof Uint8Array) ||
    !isRecord(options) || Object.keys(options).length !== 2 || !Object.hasOwn(options, 'filename') || !Object.hasOwn(options, 'maxBytes') ||
    !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > maximumArchiveBytes ||
    typeof options.filename !== 'string' || Buffer.byteLength(options.filename) < 1 || Buffer.byteLength(options.filename) > 512 ||
    /[\\:\u0000-\u001f\u007f]/u.test(options.filename) ||
    options.filename.split('/').some((part) => !part || part === '.' || part === '..')) {
    invalidOptions();
  }
  if (archive.byteLength < 22 || archive.byteLength > maximumArchiveBytes) invalidArchive();
  const expectedName = Buffer.from(options.filename);
  if (expectedName.toString('utf8') !== options.filename) invalidOptions();
  const bytes = Buffer.from(archive);
  const span = (start: number, length: number): Buffer => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      start < 0 || length < 0 || start + length > bytes.length) invalidArchive();
    return bytes.subarray(start, start + length);
  };
  const u16 = (at: number) => span(at, 2).readUInt16LE();
  const u32 = (at: number) => span(at, 4).readUInt32LE();
  const u64 = (at: number): number => {
    const value = span(at, 8).readBigUInt64LE();
    if (value > BigInt(maximumArchiveBytes)) invalidArchive();
    return Number(value);
  };
  const zip64Values = (start: number, length: number, raw: readonly number[]): number[] => {
    const values = [...raw];
    const end = start + length;
    span(start, length);
    let cursor = start;
    let found = false;
    while (cursor < end) {
      if (cursor + 4 > end) invalidArchive();
      const id = u16(cursor), size = u16(cursor + 2), next = cursor + 4 + size;
      if (id !== 1 || found || next > end) invalidArchive();
      found = true;
      let field = cursor + 4;
      for (let index = 0; index < values.length; index++) {
        if (raw[index] !== sentinel32) continue;
        if (field + 8 > next) invalidArchive();
        values[index] = u64(field);
        field += 8;
      }
      if (field !== next || field === cursor + 4) invalidArchive();
      cursor = next;
    }
    if (values.some((value) => value === sentinel32)) invalidArchive();
    return values;
  };
  let content: Buffer | undefined;
  let complete = false;
  try {
    const footer = bytes.length - 22;
    if (u32(footer) !== 0x06054b50 || u16(footer + 4) !== 0 || u16(footer + 6) !== 0 ||
      u16(footer + 20) !== 0) invalidArchive();
    const diskCount = u16(footer + 8), totalCount = u16(footer + 10);
    const rawCentralSize = u32(footer + 12), rawCentral = u32(footer + 16);
    let centralSize = rawCentralSize, central = rawCentral, centralEnd = footer;
    if (footer >= 20 && u32(footer - 20) === 0x07064b50) {
      const locator = footer - 20, zip64 = u64(locator + 8);
      if (u32(locator + 4) !== 0 || u32(locator + 16) !== 1 ||
        u32(zip64) !== 0x06064b50 || u64(zip64 + 4) !== 44 || zip64 + 56 !== locator ||
        u16(zip64 + 14) !== 45 || u32(zip64 + 16) !== 0 || u32(zip64 + 20) !== 0 ||
        u64(zip64 + 24) !== 1 || u64(zip64 + 32) !== 1 ||
        ![1, 0xffff].includes(diskCount) || ![1, 0xffff].includes(totalCount)) invalidArchive();
      centralSize = u64(zip64 + 40);
      central = u64(zip64 + 48);
      centralEnd = zip64;
      if (rawCentralSize !== sentinel32 && rawCentralSize !== centralSize ||
        rawCentral !== sentinel32 && rawCentral !== central) invalidArchive();
    } else if (diskCount !== 1 || totalCount !== 1) invalidArchive();
    if (centralSize < 46 || central + centralSize !== centralEnd || u32(central) !== 0x02014b50) invalidArchive();

    const version = u16(central + 6), flags = u16(central + 8), method = u16(central + 10);
    const crc = u32(central + 16), nameLength = u16(central + 28), extraLength = u16(central + 30);
    const attributes = u32(central + 38);
    if (![10, 20, 45].includes(version) || flags & ~0x0808 || ![0, 8].includes(method) ||
      method === 8 && version < 20 || u16(central + 32) !== 0 || u16(central + 34) !== 0 ||
      attributes & 0x10 || ![0, 0o100000].includes((attributes >>> 16) & 0o170000) ||
      centralSize !== 46 + nameLength + extraLength ||
      !expectedName.equals(span(central + 46, nameLength)) ||
      !(flags & 0x0800) && expectedName.some((byte) => byte > 127)) invalidArchive();
    const rawSizes = [u32(central + 24), u32(central + 20), u32(central + 42)];
    const [expanded, packed, local] = zip64Values(central + 46 + nameLength, extraLength, rawSizes);
    if (expanded === undefined || packed === undefined || local !== 0 ||
      expanded < 1 || expanded > options.maxBytes || packed < 1 || packed > maximumArchiveBytes ||
      rawSizes.includes(sentinel32) && version !== 45 ||
      u32(0) !== 0x04034b50 || u16(4) !== version || u16(6) !== flags || u16(8) !== method ||
      u32(10) !== u32(central + 12)) invalidArchive();

    const localNameLength = u16(26), localExtraLength = u16(28);
    if (!expectedName.equals(span(30, localNameLength))) invalidArchive();
    const localRaw = [u32(22), u32(18)];
    const [localExpanded, localPacked] = zip64Values(30 + localNameLength, localExtraLength, localRaw);
    if (localRaw.includes(sentinel32) && version !== 45) invalidArchive();
    const start = 30 + localNameLength + localExtraLength, bodyEnd = start + packed;
    if (bodyEnd > central) invalidArchive();
    if (flags & 8) {
      if (u32(14) !== 0 && u32(14) !== crc ||
        localExpanded !== 0 && localExpanded !== expanded || localPacked !== 0 && localPacked !== packed) invalidArchive();
      const length = central - bodyEnd;
      const wide = length === 20 || length === 24;
      const signed = length === 16 || length === 24;
      if (![12, 16, 20, 24].includes(length) || wide && version !== 45 ||
        signed && u32(bodyEnd) !== 0x08074b50) invalidArchive();
      const descriptor = bodyEnd + (signed ? 4 : 0);
      if (u32(descriptor) !== crc ||
        (wide ? u64(descriptor + 4) : u32(descriptor + 4)) !== packed ||
        (wide ? u64(descriptor + 12) : u32(descriptor + 8)) !== expanded) invalidArchive();
    } else if (bodyEnd !== central || u32(14) !== crc || localPacked !== packed || localExpanded !== expanded) invalidArchive();

    const compressed = span(start, packed);
    if (method === 0) content = Buffer.from(compressed);
    else {
      let inflated: unknown;
      try { inflated = inflateRawSync(compressed, { info: true, maxOutputLength: options.maxBytes }); }
      catch (error) {
        if (isRecord(error) && ['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_BUFFER_TOO_LARGE'].includes(String(error.code))) invalidArchive();
        throw error;
      }
      if (!isRecord(inflated) || !Buffer.isBuffer(inflated.buffer)) invalidArchive();
      content = inflated.buffer;
      if (!isRecord(inflated.engine) || inflated.engine.bytesWritten !== packed) invalidArchive();
    }
    if (content.length !== expanded || crc32(content) !== crc || !isUtf8(content)) invalidArchive();
    complete = true;
    return content;
  } finally {
    if (!complete) content?.fill(0);
    bytes.fill(0);
  }
}
