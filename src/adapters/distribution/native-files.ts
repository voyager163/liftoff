import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import type { NativePayloadFile } from '../../domain/distribution/native-trust.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import {
  assertSafeSkillPath, canonicalSkillRoot, captureSkillFile, isPathConfined, validateSkillPathParts
} from '../skills/discovery.js';

export { assertSafeSkillPath as assertSafeNativePath, canonicalSkillRoot as canonicalNativeRoot };

export function ioCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function nativePathParts(value: string): string[] {
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new DistributionError('Payload inventory requires portable relative paths.', 'unsafe_path');
  }
  return validateSkillPathParts(value.split('/'));
}

export interface NativeFileSnapshot {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  device: number;
  inode: number;
  uid: number;
  gid: number;
  linkTarget?: string;
}

export interface NativeDirectorySnapshot {
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  gid: number;
}

function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid;
}

export async function hashNativeFile(root: string, parts: readonly string[], maximum = 256 * 1024 * 1024): Promise<NativeFileSnapshot> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new DistributionError('Native file read limit must be a finite non-negative safe integer.', 'invalid_metadata');
  }
  const absolute = await assertSafeSkillPath(root, parts);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new DistributionError('Native payload must contain bounded single-link regular files.', 'unsafe_path');
  }
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!same(before, opened)) throw new DistributionError('Native file changed while opening.', 'stale_plan');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maximum || length > opened.size) throw new DistributionError('Native file grew while reading.', 'stale_plan');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await lstat(await assertSafeSkillPath(root, parts));
    if (!same(opened, after) || !same(opened, await file.stat()) || length !== opened.size) {
      throw new DistributionError('Native file identity changed while reading.', 'stale_plan');
    }
    return {
      path: parts.join('/'), sha256: hash.digest('hex'), size: length, mode: opened.mode & 0o7777,
      device: opened.dev, inode: opened.ino, uid: opened.uid, gid: opened.gid
    };
  } finally { await file.close(); }
}

export function parseNativeJsonBytes(bytes: Uint8Array, label = 'Native metadata'): unknown {
  if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) {
    throw new DistributionError('Native metadata is missing or exceeds its bounded size.', 'invalid_metadata');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new DistributionError('Native metadata contains invalid UTF-8.', 'invalid_metadata');
  }
  try { return parseStrictManifestJson(text, label); }
  catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    throw new DistributionError('Native metadata contains malformed JSON or duplicate fields.', 'invalid_metadata');
  }
}

export function nativePayloadMode(mode: number): number {
  return process.platform === 'win32' ? mode & 0o200 ? 0o666 : 0o444 : mode;
}

export async function readNativeJson(root: string, relativePath: string, expected?: NativePayloadFile): Promise<unknown> {
  const captured = await captureSkillFile(root, nativePathParts(relativePath));
  const content = captured.snapshot.content;
  if (!content || captured.observation.state !== 'file') throw new DistributionError('Required native metadata is missing.', 'invalid_metadata');
  if (expected && (expected.path !== relativePath || expected.size !== content.length ||
      expected.sha256 !== captured.observation.contentHash || nativePayloadMode(expected.mode) !== captured.observation.mode)) {
    throw new DistributionError('Current native metadata bytes or mode differ from signed final provenance.', 'artifact_mismatch');
  }
  return parseNativeJsonBytes(content, relativePath);
}

export async function nativeDirectorySnapshot(directory: string): Promise<NativeDirectorySnapshot> {
  const canonical = await canonicalSkillRoot(directory);
  const details = await lstat(canonical);
  return { path: canonical, device: details.dev, inode: details.ino, mode: details.mode & 0o7777, uid: details.uid, gid: details.gid };
}

export async function inventoryNativeTree(root: string, options: {
  expectedFiles?: ReadonlySet<string>;
  allowInternalLinks?: boolean;
} = {}): Promise<{
  files: readonly NativeFileSnapshot[];
  directories: readonly NativeDirectorySnapshot[];
  digest: string;
}> {
  const canonical = await canonicalSkillRoot(root);
  const files: NativeFileSnapshot[] = [];
  const directories: NativeDirectorySnapshot[] = [];
  const expectedDirectories = new Set<string>(['']);
  for (const file of options.expectedFiles ?? []) {
    const parts = nativePathParts(file);
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  let total = 0;
  const visit = async (parts: string[]): Promise<void> => {
    const directory = path.join(canonical, ...parts);
    const directoryBefore = await nativeDirectorySnapshot(directory);
    directories.push(directoryBefore);
    const names = (await readdir(directory)).sort();
    if (names.length > 16_384 || new Set(names.map((name) => name.normalize('NFC').toLowerCase())).size !== names.length) {
      throw new DistributionError('Native directory has an oversized or ambiguous inventory.', 'unsafe_path');
    }
    for (const name of names) {
      const child = [...parts, name];
      if (child.length > 64 || files.length + directories.length >= 16_384) {
        throw new DistributionError('Native payload exceeds its bounded inventory.', 'unsafe_path');
      }
      validateSkillPathParts(child);
      const target = path.join(canonical, ...child);
      const details = await lstat(target);
      const relative = child.join('/');
      if (options.expectedFiles && !(details.isDirectory() ? expectedDirectories.has(relative) : options.expectedFiles.has(relative))) {
        throw new DistributionError('Candidate contains an unregistered path; its contents were not read.', 'artifact_mismatch');
      }
      if (details.isSymbolicLink() && options.allowInternalLinks) {
        const link = await readlink(target);
        const resolved = await realpath(target);
        if (!isPathConfined(canonical, resolved) || !same(details, await lstat(target)) || await readlink(target) !== link) {
          throw new DistributionError('Legacy package link escapes its owner boundary or changed during inspection.', 'ownership_unknown');
        }
        files.push({
          path: relative, sha256: createHash('sha256').update(link).digest('hex'), size: Buffer.byteLength(link), mode: details.mode & 0o7777,
          device: details.dev, inode: details.ino, uid: details.uid, gid: details.gid, linkTarget: link
        });
      } else if (details.isDirectory()) await visit(child);
      else {
        const file = await hashNativeFile(canonical, child);
        total += file.size;
        if (total > 1024 * 1024 * 1024) throw new DistributionError('Native payload exceeds its size limit.', 'unsafe_path');
        files.push(file);
      }
    }
    if (canonicalSha256(await nativeDirectorySnapshot(directory)) !== canonicalSha256(directoryBefore)) {
      throw new DistributionError('Native directory identity changed during inventory.', 'stale_plan');
    }
  };
  await visit([]);
  return { files, directories, digest: canonicalSha256({ files, directories }) };
}

export async function canonicalDestination(value: string, cwd: string, allowFinalLink = false): Promise<string> {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new DistributionError('Invalid native destination.', 'unsafe_path');
  const absolute = path.resolve(cwd, value);
  let ancestor = path.dirname(absolute);
  const missing = [path.basename(absolute)];
  for (;;) {
    try {
      const root = await canonicalSkillRoot(ancestor);
      validateSkillPathParts(missing);
      if (!allowFinalLink) await assertSafeSkillPath(root, missing);
      else if (missing.length > 1) await assertSafeSkillPath(root, missing.slice(0, -1));
      return path.join(root, ...missing);
    } catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function resolveNativeEntrypoint(value: string, cwd: string): Promise<string> {
  const requested = path.resolve(cwd, value);
  const resolved = await realpath(requested);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new DistributionError('The Liftoff entrypoint is not a regular executable file.', 'unsafe_path');
  }
  await assertSafeSkillPath(await canonicalSkillRoot(path.dirname(resolved)), [path.basename(resolved)]);
  return resolved;
}
