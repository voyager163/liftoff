import { crc32 } from 'node:zlib';
import { privateRunnerReportFilename } from '../../src/application/azure-activation/private-report-archive.js';

export function singleReportZip(value: unknown, filename = privateRunnerReportFilename): Buffer {
  return singleReportBytesZip(Buffer.from(JSON.stringify(value)), filename);
}

export function singleReportBytesZip(content: Uint8Array, filename = privateRunnerReportFilename): Buffer {
  const name = Buffer.from(filename);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}
