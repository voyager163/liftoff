import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { NativeArtifactProvenance } from '../../domain/distribution/native-trust.js';
import { legacyNpmPackageName } from '../../domain/distribution/contracts.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import type { AdmittedNativeArtifact } from './native-admission.js';
import { canonicalDestination, canonicalNativeRoot, nativePathParts } from './native-files.js';
import { ensureNativeDirectory } from './receipt-store.js';
import { nodeUpdatePreviewFileSystem } from '../filesystem/update-previews.js';
import type { ProjectMutationLease } from '../filesystem/project-lock.js';

interface ArchiveFile { path: string; bytes: Buffer; mode: number }

const maximumExpanded = 1024 * 1024 * 1024;
const maximumEntries = 16_384;

function invalid(): never { throw new DistributionError('Native archive has an unsafe, corrupt, ambiguous, or unsupported entry.', 'artifact_mismatch'); }

function utf8(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) invalid();
  return value;
}

function checkedName(raw: string): string {
  const name = raw.startsWith('./') ? raw.slice(2) : raw;
  return nativePathParts(name).join('/');
}

function tarFiles(archive: Buffer): ArchiveFile[] {
  let expanded: Buffer;
  try { expanded = gunzipSync(archive, { maxOutputLength: maximumExpanded }); }
  catch { return invalid(); }
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let pendingPath: string | undefined;
  const octal = (bytes: Buffer): number => {
    const value = bytes.toString('ascii').replace(/\0.*$/u, '').trim();
    if (!/^[0-7]+$/u.test(value)) invalid();
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumExpanded) invalid();
    return parsed;
  };
  const field = (bytes: Buffer): string => utf8(bytes.subarray(0, bytes.indexOf(0) === -1 ? bytes.length : bytes.indexOf(0)));
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (pendingPath || !expanded.subarray(offset).every((byte) => byte === 0)) invalid();
      return files;
    }
    if (seen.size >= maximumEntries) invalid();
    const storedChecksum = octal(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== storedChecksum) invalid();
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    const type = header[156];
    const prefix = field(header.subarray(345, 500));
    const rawName = pendingPath ?? `${prefix ? `${prefix}/` : ''}${field(header.subarray(0, 100))}`;
    pendingPath = undefined;
    const start = offset + 512;
    const end = start + size;
    if (end > expanded.length || mode > 0o7777) invalid();
    const bytes = expanded.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 120) {
      let cursor = 0;
      while (cursor < bytes.length) {
        const space = bytes.indexOf(32, cursor);
        if (space < cursor || space - cursor > 8) invalid();
        const sizeText = bytes.subarray(cursor, space).toString('ascii');
        if (!/^[1-9]\d*$/u.test(sizeText)) invalid();
        const length = Number(sizeText);
        if (length > 16_384 || cursor + length > bytes.length || bytes[cursor + length - 1] !== 10) invalid();
        const entry = utf8(bytes.subarray(space + 1, cursor + length - 1));
        const equals = entry.indexOf('=');
        const key = entry.slice(0, equals);
        if (equals <= 0 || !['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) invalid();
        if (key === 'path') {
          if (pendingPath !== undefined) invalid();
          pendingPath = entry.slice(equals + 1);
        }
        cursor += length;
      }
      continue;
    }
    if (type !== 0 && type !== 48 && type !== 53) invalid();
    if (type === 53 && (rawName === './' || rawName === '.')) {
      if (size !== 0) invalid();
      continue;
    }
    const name = checkedName(type === 53 ? rawName.replace(/\/$/u, '') : rawName);
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) invalid();
    seen.add(folded);
    if (type === 53) { if (size !== 0) invalid(); continue; }
    files.push({ path: name, bytes, mode });
  }
  return invalid();
}

function zipFiles(archive: Buffer): ArchiveFile[] {
  let footer = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) { footer = index; break; }
  }
  if (footer < 0 || archive.readUInt16LE(footer + 4) !== 0 || archive.readUInt16LE(footer + 6) !== 0 ||
      footer + 22 + archive.readUInt16LE(footer + 20) !== archive.length) invalid();
  const count = archive.readUInt16LE(footer + 10);
  const centralSize = archive.readUInt32LE(footer + 12);
  const centralStart = archive.readUInt32LE(footer + 16);
  if (count === 0 || count > maximumEntries || count !== archive.readUInt16LE(footer + 8) || centralStart + centralSize !== footer) invalid();
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];
  let offset = centralStart;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > footer || archive.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const attributes = archive.readUInt32LE(offset + 38);
    const local = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > footer || flags & 1 || flags & ~0x0808 || ![0, 8].includes(method) || size > 256 * 1024 * 1024 ||
        archive.readUInt16LE(offset + 34) !== 0 || local + 30 > centralStart || archive.readUInt32LE(local) !== 0x04034b50) invalid();
    const rawName = utf8(archive.subarray(offset + 46, offset + 46 + nameLength));
    const directory = rawName.endsWith('/');
    const name = checkedName(directory ? rawName.slice(0, -1) : rawName);
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) invalid();
    seen.add(folded);
    const mode = attributes >>> 16;
    const kind = mode & 0o170000;
    if (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000)) invalid();
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > centralStart || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method ||
        utf8(archive.subarray(local + 30, local + 30 + localNameLength)) !== rawName ||
        spans.some(([left, right]) => local < right && end > left)) invalid();
    spans.push([local, end]);
    let bytes: Buffer;
    try {
      bytes = method === 0 ? archive.subarray(start, end) : inflateRawSync(archive.subarray(start, end), { maxOutputLength: Math.max(size, 1) });
    } catch { return invalid(); }
    total += bytes.length;
    if (bytes.length !== size || total > maximumExpanded || directory && size !== 0) invalid();
    if (!directory) files.push({ path: name, bytes, mode: mode ? mode & 0o7777 : 0 });
    offset = next;
  }
  if (offset !== footer) invalid();
  return files;
}

export function inspectNativeArchive(archive: Buffer, provenance: NativeArtifactProvenance, format: 'zip' | 'tar.gz'): {
  archiveRoot: string;
  files: ArchiveFile[];
} {
  const files = format === 'tar.gz' ? tarFiles(archive) : zipFiles(archive);
  const expected = new Map(provenance.files.map((file) => [file.path, file]));
  if (files.length !== expected.size || !files.length) invalid();
  let prefix = '';
  if (!expected.has(files[0].path)) {
    const component = files[0].path.split('/')[0];
    if (!component) invalid();
    prefix = `${component}/`;
  }
  const normalized = files.map((file) => {
    if (prefix && !file.path.startsWith(prefix)) invalid();
    const relative = file.path.slice(prefix.length);
    const signed = expected.get(relative);
    if (!signed || signed.size !== file.bytes.length || createHash('sha256').update(file.bytes).digest('hex') !== signed.sha256 ||
        (format === 'tar.gz' || file.mode !== 0) && file.mode !== signed.mode) invalid();
    return { path: relative, bytes: file.bytes, mode: signed.mode };
  });
  if (new Set(normalized.map((file) => file.path)).size !== expected.size) invalid();
  const runtime = normalized.find((file) => file.path === provenance.entrypoints.runtime);
  if (!runtime) invalid();
  assertNativeRuntimeTarget(runtime.bytes, provenance.target);
  if (provenance.target.startsWith('win32-')) {
    if (provenance.entrypoints.launcher !== 'bin/liftoff.exe' || provenance.entrypoints.runtime !== 'runtime/node.exe' ||
        provenance.entrypoints.cli !== 'dist/cli.js') {
      throw new DistributionError('Current Windows bundles require the canonical PE launcher, private Node executable, and CLI entrypoint.', 'artifact_mismatch');
    }
    const launcher = normalized.find((file) => file.path === provenance.entrypoints.launcher);
    if (!launcher) invalid();
    assertNativeRuntimeTarget(launcher.bytes, provenance.target);
  }
  assertRuntimeDependencyClosure(normalized, provenance.version);
  return { archiveRoot: prefix.replace(/\/$/u, ''), files: normalized };
}

export function validateNativeArchive(archive: Buffer, provenance: NativeArtifactProvenance, format: 'zip' | 'tar.gz'): ArchiveFile[] {
  return inspectNativeArchive(archive, provenance, format).files;
}

function assertRuntimeDependencyClosure(files: readonly ArchiveFile[], version: string): void {
  const inventory = new Map(files.map((file) => [file.path, file]));
  const visited = new Set<string>();
  const metadata = (file: string): Record<string, unknown> => {
    const entry = inventory.get(file);
    if (!entry || entry.bytes.length > 2 * 1024 * 1024) invalid();
    let value: unknown;
    try { value = JSON.parse(entry.bytes.toString('utf8')); }
    catch { return invalid(); }
    if (!isRecord(value)) invalid();
    return value;
  };
  const root = metadata('package.json');
  if ((root.name !== 'liftoff' && root.name !== legacyNpmPackageName) || root.version !== version || root.type !== 'module') {
    throw new DistributionError('Native runtime package identity does not match the canonical release.', 'artifact_mismatch');
  }
  const visit = (file: string, pkg: Record<string, unknown>): void => {
    if (visited.has(file)) return;
    visited.add(file);
    if (visited.size > 2048) invalid();
    if (pkg.dependencies === undefined) return;
    if (!isRecord(pkg.dependencies)) invalid();
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name) || typeof range !== 'string' || !range || range.length > 512) invalid();
      let directory = path.posix.dirname(file);
      let found: string | undefined;
      for (;;) {
        const target = path.posix.join(directory, 'node_modules', name, 'package.json');
        if (inventory.has(target)) { found = target; break; }
        if (directory === '.') break;
        directory = path.posix.dirname(directory);
      }
      if (!found) throw new DistributionError('A mandatory runtime dependency is absent from the signed bundle; ambient modules cannot satisfy native closure.', 'artifact_mismatch');
      const child = metadata(found);
      if (child.name !== name || typeof child.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(child.version)) invalid();
      visit(found, child);
    }
  };
  visit('package.json', root);
}

export function assertNativeRuntimeTarget(bytes: Buffer, target: NativeArtifactProvenance['target']): void {
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64';
  if (target.startsWith('linux-')) {
    if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) invalid();
  } else if (target.startsWith('darwin-')) {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007) || bytes.readUInt32LE(12) !== 2) invalid();
  } else {
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) invalid();
    const header = bytes.readUInt32LE(60);
    if (header > 1024 * 1024 || header + 26 > bytes.length || bytes.readUInt32LE(header) !== 0x00004550 ||
        bytes.readUInt16LE(header + 4) !== (arch === 'arm64' ? 0xaa64 : 0x8664) ||
        (bytes.readUInt16LE(header + 22) & 2) !== 2 || bytes.readUInt16LE(header + 24) !== 0x20b) invalid();
  }
}

export async function extractNativeArchive(archive: Buffer, artifact: AdmittedNativeArtifact, destination: string, lease: ProjectMutationLease): Promise<void> {
  const files = validateNativeArchive(archive, artifact.provenance, artifact.release.manifest.targets[artifact.target].archiveFormat);
  const root = await canonicalDestination(destination, process.cwd());
  await lease.assertHeld();
  await ensureNativeDirectory(path.dirname(root));
  await lease.assertHeld();
  await mkdir(root, { mode: 0o700 });
  for (const file of files) {
    await lease.assertHeld();
    const target = path.join(root, ...nativePathParts(file.path));
    await ensureNativeDirectory(path.dirname(target));
    await lease.assertHeld();
    const handle = await open(target, 'wx', file.mode);
    try {
      await handle.writeFile(file.bytes);
      await handle.chmod(file.mode);
      await handle.sync();
    } finally { await handle.close(); }
    await nodeUpdatePreviewFileSystem.syncDirectory(path.dirname(target));
  }
  await canonicalNativeRoot(root);
  await nodeUpdatePreviewFileSystem.syncDirectory(path.dirname(root));
}
