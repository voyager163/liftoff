import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TransformOptions } from 'node:stream';
import { promisify } from 'node:util';
import { gunzip, type ZlibOptions } from 'node:zlib';
import type { NativeCandidate } from '../../domain/distribution/native-upgrade.js';
import { SelfUpgradeFailure, selfUpgradeInstallTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';
import { verifyNativeBytesSignature } from '../../../distribution/native/native-release-admission.mjs';

type InventoryEntry =
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'file'; mode: number; bytes: number; sha256: string }
  | { path: string; kind: 'symlink'; target: string };

export interface NativeArchiveContract {
  bundlePath(value: string): string;
  nativeBundleLimits: Readonly<{ entries: number; depth: number; fileBytes: number; totalBytes: number }>;
  bundleInventory(directory: string): Promise<{ entries: InventoryEntry[]; totalBytes: number; sha256: string }>;
}

type ArchiveValidationContract = Pick<NativeArchiveContract, 'bundlePath' | 'nativeBundleLimits'>;

export interface NativeArchiveInventory {
  readonly manifestSha256: string;
  readonly inventory: Readonly<{
    entries: readonly Readonly<InventoryEntry>[];
    totalBytes: number;
    sha256: string;
  }>;
}

type Member =
  | { name: string; kind: 'directory'; mode: number }
  | { name: string; kind: 'file'; mode: number; content: Buffer }
  | { name: string; kind: 'symlink'; target: string };

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('failed', 'native_invalid');
const decoder = new TextDecoder('utf-8', { fatal: true });
const decompress = promisify(gunzip);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function text(field: Buffer): string {
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some(byte => byte !== 0)) throw invalid();
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(field: Buffer): number {
  const value = decoder.decode(field).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(value)) throw invalid();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw invalid();
  return number;
}

function pax(bytes: Buffer): Map<string, string> {
  const attributes = new Map<string, string>();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space === -1 || space - offset > 8) throw invalid();
    const lengthText = decoder.decode(bytes.subarray(offset, space));
    if (!/^[1-9]\d*$/.test(lengthText)) throw invalid();
    const length = Number(lengthText);
    if (offset + length > bytes.length || offset + length <= space + 2 || bytes[offset + length - 1] !== 10) throw invalid();
    const attribute = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equal = attribute.indexOf('=');
    const name = attribute.slice(0, equal);
    if (equal <= 0 || attributes.has(name) ||
      !['path', 'linkpath', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset'].includes(name)) {
      throw invalid();
    }
    attributes.set(name, attribute.slice(equal + 1));
    offset += length;
  }
  return attributes;
}

function parseArchive(bytes: Buffer, contract: ArchiveValidationContract, check: () => void): Map<string, Member> {
  if (bytes.length % 512 !== 0) throw invalid();
  const { nativeBundleLimits: limits } = contract;
  const members = new Map<string, Member>();
  const aliases = new Set<string>();
  let attributes = new Map<string, string>();
  let longName: string | undefined, longLink: string | undefined;
  let root = false, headers = 0, totalBytes = 0;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    check();
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (attributes.size || longName !== undefined || longLink !== undefined ||
        offset + 1024 > bytes.length || bytes.subarray(offset).some(byte => byte !== 0)) throw invalid();
      return members;
    }
    if (++headers > limits.entries * 3 + 1) throw invalid();
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) throw invalid();
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    const kind = header[156];
    const end = offset + 512 + size;
    const padded = offset + 512 + Math.ceil(size / 512) * 512;
    if (end > bytes.length || padded > bytes.length || mode > 0o777) throw invalid();
    const content = bytes.subarray(offset + 512, end);
    if (bytes.subarray(end, padded).some(byte => byte !== 0)) throw invalid();
    offset = padded;
    if ([120, 103, 76, 75].includes(kind)) {
      if (size === 0 || size > 8192) throw invalid();
      if (kind === 120 || kind === 103) {
        if (attributes.size) throw invalid();
        const next = pax(content);
        // Global path/link overrides make subsequent member identity ambiguous.
        if (kind === 103) {
          if (next.has('path') || next.has('linkpath')) throw invalid();
        } else attributes = next;
      } else if (kind === 76) {
        if (longName !== undefined) throw invalid();
        longName = text(content);
      } else {
        if (longLink !== undefined) throw invalid();
        longLink = text(content);
      }
      continue;
    }
    const magic = text(header.subarray(257, 263)).trimEnd();
    if (magic !== '' && magic !== 'ustar') throw invalid();
    const prefix = magic === 'ustar' && header[263] === 48 ? text(header.subarray(345, 500)) : '';
    if (attributes.has('path') && longName !== undefined || attributes.has('linkpath') && longLink !== undefined) throw invalid();
    let name = attributes.get('path') ?? longName ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join('/');
    const target = attributes.get('linkpath') ?? longLink ?? text(header.subarray(157, 257));
    attributes = new Map();
    longName = longLink = undefined;
    if ((name === '.' || name === './') && kind === 53 && size === 0 && !root) { root = true; continue; }
    if (name.startsWith('./')) name = name.slice(2);
    if (kind === 53 && name.endsWith('/')) name = name.slice(0, -1);
    contract.bundlePath(name);
    const alias = name.normalize('NFC').toLowerCase();
    if (aliases.has(alias) || name.split('/').length > limits.depth || members.size >= limits.entries + 1) throw invalid();
    aliases.add(alias);
    if ((kind === 0 || kind === 48) && !target) {
      if (size > limits.fileBytes || (totalBytes += size) > limits.totalBytes + 8 * 1024 * 1024) throw invalid();
      members.set(name, { name, kind: 'file', mode, content });
    } else if (kind === 53 && size === 0 && !target) {
      members.set(name, { name, kind: 'directory', mode });
    } else if (kind === 50 && size === 0 && target && target.length <= 1024 &&
      !path.posix.isAbsolute(target) && !/[\\\u0000-\u001f]/.test(target)) {
      members.set(name, { name, kind: 'symlink', target });
    } else throw invalid();
  }
  throw invalid();
}

function validateMembers(members: Map<string, Member>, contract: ArchiveValidationContract): void {
  for (const member of members.values()) {
    const parent = path.posix.dirname(member.name);
    if (parent !== '.' && members.get(parent)?.kind !== 'directory') throw invalid();
    if (member.kind !== 'symlink') continue;
    let selected = path.posix.join(path.posix.dirname(member.name), member.target);
    const visited = new Set<string>();
    for (;;) {
      contract.bundlePath(selected);
      const parts = selected.split('/');
      let resolved = true;
      for (let index = 0; index < parts.length; index++) {
        const name = parts.slice(0, index + 1).join('/');
        const entry = members.get(name);
        if (!entry) throw invalid();
        if (entry.kind === 'symlink') {
          if (visited.has(name) || visited.size >= contract.nativeBundleLimits.depth) throw invalid();
          visited.add(name);
          selected = path.posix.join(path.posix.dirname(name), entry.target, ...parts.slice(index + 1));
          resolved = false;
          break;
        }
        if (index < parts.length - 1 && entry.kind !== 'directory') throw invalid();
      }
      if (resolved) break;
    }
  }
}

function inventory(members: Map<string, Member>) {
  const entries: InventoryEntry[] = [];
  let totalBytes = 0;
  const children = new Map<string, Member[]>();
  for (const member of members.values()) {
    if (member.name === 'bundle.json') continue;
    const parent = path.posix.dirname(member.name);
    const siblings = children.get(parent) ?? [];
    siblings.push(member);
    children.set(parent, siblings);
  }
  const visit = (parent: string) => {
    const siblings = children.get(parent) ?? [];
    siblings.sort((left, right) => path.posix.basename(left.name) < path.posix.basename(right.name) ? -1 : 1);
    for (const member of siblings) {
      if (member.kind === 'directory') {
        entries.push({ path: member.name, kind: 'directory', mode: member.mode });
        visit(member.name);
      } else if (member.kind === 'symlink') entries.push({ path: member.name, kind: 'symlink', target: member.target });
      else {
        totalBytes += member.content.length;
        entries.push({ path: member.name, kind: 'file', bytes: member.content.length, sha256: hash(member.content), mode: member.mode });
      }
    }
  };
  visit('.');
  return { entries, totalBytes, sha256: hash(JSON.stringify(entries)) };
}

async function inspectArchive(
  archive: Buffer, candidate: NativeCandidate, contract: ArchiveValidationContract,
  signal: AbortSignal, check: () => void
) {
  check();
  if (!/^(?:linux-(?:x64|arm64)|darwin-arm64)$/.test(candidate.target) || !candidate.archiveSha256 ||
    archive.length === 0 || archive.length > 256 * 1024 * 1024 || hash(archive) !== candidate.archiveSha256) throw invalid();
  const maximum = contract.nativeBundleLimits.totalBytes + contract.nativeBundleLimits.entries * 16_384 + 8 * 1024 * 1024;
  const inflateOptions: ZlibOptions & Pick<TransformOptions, 'signal'> = { maxOutputLength: maximum, signal };
  const members = parseArchive(await decompress(archive, inflateOptions), contract, check);
  validateMembers(members, contract);
  const manifestMember = members.get('bundle.json');
  if (manifestMember?.kind !== 'file' || manifestMember.content.length > 8 * 1024 * 1024 ||
    hash(manifestMember.content) !== candidate.manifestSha256) throw invalid();
  const manifest = record(JSON.parse(manifestMember.content.toString('utf8')));
  const pkg = record(manifest.package), source = record(manifest.source), platform = record(manifest.platform);
  const expected = inventory(members);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'liftoff-native-development-bundle' ||
    manifest.releaseReady !== true || pkg.name !== '@msn-control/liftoff' || pkg.version !== candidate.version ||
    source.repository !== 'voyager163/liftoff' || source.commit !== candidate.sourceCommit ||
    `${platform.platform}-${platform.architecture}` !== candidate.target || manifest.launcher !== 'bin/liftoff' ||
    record(manifest.runtime).executable !== 'runtime/node' || expected.sha256 !== candidate.inventorySha256 ||
    expected.totalBytes > contract.nativeBundleLimits.totalBytes || expected.entries.length > contract.nativeBundleLimits.entries) throw invalid();
  deepStrictEqual(manifest.inventory, expected);
  for (const name of ['runtime/node', 'bin/liftoff']) {
    const entry = members.get(name);
    if (entry?.kind !== 'file' || entry.mode !== 0o755) throw invalid();
  }
  check();
  return { members, expected, manifestMember };
}

/** Inert byte/inventory comparison only; the caller must independently authenticate the candidate. */
export async function verifyNativeArchiveInventory(options: {
  archive: Buffer;
  candidate: NativeCandidate;
  contract: ArchiveValidationContract;
  signal: AbortSignal;
}): Promise<NativeArchiveInventory> {
  const started = performance.now();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(selfUpgradeInstallTimeoutMs)]);
  const check = () => {
    if (signal.aborted || performance.now() - started >= selfUpgradeInstallTimeoutMs) {
      throw new SelfUpgradeFailure('failed', 'native_timeout');
    }
  };
  try {
    check();
    if (options.archive.length === 0 || options.archive.length > 256 * 1024 * 1024) throw invalid();
    const archive = Buffer.from(options.archive), candidate = { ...options.candidate };
    const contract = { bundlePath: options.contract.bundlePath,
      nativeBundleLimits: Object.freeze({ ...options.contract.nativeBundleLimits }) };
    const { expected, manifestMember } = await inspectArchive(archive, candidate, contract, signal, check);
    const observed = Object.freeze({
      manifestSha256: hash(manifestMember.content),
      inventory: Object.freeze({ ...expected, entries: Object.freeze(expected.entries.map(entry => Object.freeze(entry))) })
    });
    check();
    return observed;
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) throw error;
    check();
    throw invalid();
  }
}

export async function stageAuthenticatedNativeArchive(options: {
  archive: Buffer;
  signature: Buffer;
  publicKey: Buffer;
  expectedKeySha256: string;
  candidate: NativeCandidate;
  contract: NativeArchiveContract;
  storage: Pick<SelfUpgradeDependencies, 'makeNeutralDirectory' | 'removeNeutralDirectory' | 'readBytes'>;
  signal: AbortSignal;
}): Promise<{ bundleRoot: string; dispose(): Promise<void> }> {
  const { expectedKeySha256, contract, storage, signal } = options;
  const archive = Buffer.from(options.archive), signature = Buffer.from(options.signature), publicKey = Buffer.from(options.publicKey);
  const candidate = { ...options.candidate };
  const started = performance.now();
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(selfUpgradeInstallTimeoutMs)]);
  const check = () => {
    if (operationSignal.aborted || performance.now() - started >= selfUpgradeInstallTimeoutMs) {
      throw new SelfUpgradeFailure('failed', 'native_install_timeout');
    }
  };
  let writing = false;
  try {
    check();
    if (!/^linux-(?:x64|arm64)$/.test(candidate.target) || !candidate.archiveSha256 ||
      archive.length === 0 || archive.length > 256 * 1024 * 1024 || hash(archive) !== candidate.archiveSha256 ||
      signature.length !== 64 || publicKey.length === 0 || publicKey.length > 4096) throw invalid();
    verifyNativeBytesSignature(archive, signature, publicKey, expectedKeySha256);
    const { members, expected, manifestMember } = await inspectArchive(archive, candidate, contract, operationSignal, check);
    const directory = await storage.makeNeutralDirectory();
    writing = true;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      stat.mode & 0o7077 || await realpath(directory) !== directory || !storage.readBytes) throw invalid();
    const bundleRoot = path.join(directory, 'bundle');
    await mkdir(bundleRoot, { mode: 0o700 });
    for (const [name, bytes] of [['archive.tar.gz', archive], ['archive.sig', signature], ['archive.pub', publicKey]] as const) {
      check();
      const filename = path.join(directory, name);
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      if (!(await storage.readBytes(filename, bytes.length)).equals(bytes)) throw invalid();
    }
    const directories = [...members.values()].filter(member => member.kind === 'directory');
    directories.sort((left, right) => left.name.split('/').length - right.name.split('/').length);
    for (const member of directories) {
      check();
      await mkdir(path.join(bundleRoot, member.name), { mode: 0o700 });
    }
    for (const member of members.values()) {
      check();
      const filename = path.join(bundleRoot, member.name);
      if (member.kind === 'file') {
        await writeFile(filename, member.content, { flag: 'wx', mode: 0o600 });
        await chmod(filename, member.mode);
      } else if (member.kind === 'symlink') await symlink(member.target, filename);
    }
    for (const member of directories.reverse()) {
      if (member.kind === 'directory') await chmod(path.join(bundleRoot, member.name), member.mode);
    }
    check();
    deepStrictEqual(await contract.bundleInventory(bundleRoot), expected);
    if (!(await storage.readBytes(path.join(bundleRoot, 'bundle.json'), 8 * 1024 * 1024)).equals(manifestMember.content)) throw invalid();
    check();
    return { bundleRoot, dispose: () => storage.removeNeutralDirectory(directory) };
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) throw error;
    check();
    throw new SelfUpgradeFailure('failed', writing ? 'native_install_failed' : 'native_invalid');
  }
}
