import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../../domain/project/errors.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { errorCode } from './errors.js';
import type { ProjectFileSnapshot } from './project-transaction.js';

export interface BoundPathDiagnostics {
  readonly pathLabel: string;
  invalid(detail: string): never;
}

export interface BoundFileReadOptions {
  readonly maximumBytes: number;
  readonly linkPolicy: 'transaction-compatible' | 'single-link';
  readonly diagnostics: BoundPathDiagnostics;
}

const maximumReadBytes = 32 * 1024 * 1024;
const maximumDigestBytes = 512 * 1024 * 1024;
const digestReadChunkBytes = 1024 * 1024;

export interface BoundFileDigestSnapshot {
  readonly pathParts: readonly string[];
  readonly bytes: number;
  readonly mode: number;
  readonly digest: string;
  readonly header: string;
  readonly physical: string;
}

function digestPhysical(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.uid, stat.gid,
    stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

function closedRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === fields.length && fields.every((field) =>
    descriptors[field]?.enumerable === true && Object.hasOwn(descriptors[field], 'value'));
}

function checkedDiagnostics(value: unknown): BoundPathDiagnostics {
  if (!closedRecord(value, ['pathLabel', 'invalid']) || typeof value.pathLabel !== 'string' ||
    !value.pathLabel.trim() || /[\u0000-\u001f\u007f]/u.test(value.pathLabel) || typeof value.invalid !== 'function') {
    throw new FileSystemError('Bound project file diagnostics must provide only a path label and a rejecting handler.');
  }
  const { pathLabel, invalid } = value;
  return {
    pathLabel,
    invalid(detail) {
      invalid.call(value, detail);
      throw new FileSystemError('Bound project file diagnostic handler returned without rejecting the operation.');
    }
  };
}

function checkedRoot(value: string, diagnostics: BoundPathDiagnostics): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value ||
    value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
    diagnostics.invalid('project root must be an absolute canonical path.');
  }
  return value;
}

function checkedParts(value: readonly string[], diagnostics: BoundPathDiagnostics): string[] {
  if (Array.isArray(value) && value.length > 64) {
    diagnostics.invalid('a path is too long or contains non-portable characters.');
  }
  if (Array.isArray(value) && value.length > 0) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => descriptors[index])
        .some((descriptor) => !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))) {
      diagnostics.invalid('path parts must be a dense plain array without extra properties or accessors.');
    }
  }
  const parts = validateArtifactPathParts(value, diagnostics.pathLabel);
  if (parts.join('/').length > 2048 ||
    parts.some((part) => part.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part))) {
    diagnostics.invalid('a path is too long or contains non-portable characters.');
  }
  return parts;
}

async function checkedPath(root: string, parts: readonly string[], diagnostics: BoundPathDiagnostics): Promise<string> {
  let current = root;
  for (const [index, part] of parts.entries()) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
    const folded = part.normalize('NFC').toLowerCase();
    const aliases = names.filter((name) => name.normalize('NFC').toLowerCase() === folded);
    if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== part) {
      diagnostics.invalid(`case or Unicode collision at ${parts.slice(0, index + 1).join('/')}.`);
    }
    current = path.join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
    if (details.isSymbolicLink()) {
      diagnostics.invalid(`symlink or junction at ${parts.slice(0, index + 1).join('/')}.`);
    }
    if (index < parts.length - 1 && !details.isDirectory()) {
      diagnostics.invalid(`path parent is not a directory: ${parts.slice(0, index + 1).join('/')}.`);
    }
  }
  return current;
}

// The caller establishes the selected canonical root. These observations are not
// persistent path authority or atomic confinement against ancestor replacement.
export async function assertBoundProjectPath(
  canonicalProjectRoot: string,
  pathParts: readonly string[],
  diagnostics: BoundPathDiagnostics
): Promise<void> {
  const errors = checkedDiagnostics(diagnostics);
  const root = checkedRoot(canonicalProjectRoot, errors);
  const parts = checkedParts(pathParts, errors);
  await checkedPath(root, parts, errors);
}

export async function readBoundProjectFileSnapshot(
  canonicalProjectRoot: string,
  pathParts: readonly string[],
  options: BoundFileReadOptions
): Promise<ProjectFileSnapshot> {
  if (!closedRecord(options, ['maximumBytes', 'linkPolicy', 'diagnostics'])) {
    throw new FileSystemError('Bound project file read options must contain only maximumBytes, linkPolicy and diagnostics.');
  }
  const errors = checkedDiagnostics(options.diagnostics);
  const { maximumBytes, linkPolicy } = options;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > maximumReadBytes) {
    errors.invalid('maximumBytes must be a positive safe integer no greater than 33554432.');
  }
  if (linkPolicy !== 'transaction-compatible' && linkPolicy !== 'single-link') {
    errors.invalid('unsupported bound file link policy.');
  }
  const root = checkedRoot(canonicalProjectRoot, errors);
  const parts = checkedParts(pathParts, errors);
  const target = await checkedPath(root, parts, errors);
  const label = parts.join('/');
  const singleLink = linkPolicy === 'single-link';
  let before;
  try {
    before = await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { pathParts: parts };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) errors.invalid(`not a regular file: ${label}.`);
  if (singleLink && before.nlink !== 1) errors.invalid(`hard-linked file is not permitted: ${label}.`);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
    errors.invalid(`snapshot exceeds the bounded size limit: ${label}.`);
  }
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
      (singleLink ? constants.O_NONBLOCK ?? 0 : 0));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { pathParts: parts };
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino ||
      !Number.isSafeInteger(details.size) || details.size < 0 || details.size > maximumBytes ||
      singleLink && details.nlink !== 1) {
      errors.invalid(`file changed while reading: ${label}.`);
    }
    const buffer = Buffer.alloc(details.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = buffer.subarray(0, length);
    const after = await lstat(target);
    if (content.length > maximumBytes || content.length !== details.size ||
      after.dev !== details.dev || after.ino !== details.ino ||
      after.size !== content.length || after.mtimeMs !== details.mtimeMs ||
      after.mode !== details.mode || singleLink && after.nlink !== 1) {
      errors.invalid(`file changed while reading: ${label}.`);
    }
    return { pathParts: parts, content, mode: details.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

// Streams a present single-link file without widening the buffered snapshot limit.
// As with the snapshot reader, observed paths are not atomic filesystem confinement.
export async function readBoundProjectFileDigest(
  canonicalProjectRoot: string, pathParts: readonly string[],
  options: Omit<BoundFileReadOptions, 'linkPolicy'> & { readonly linkPolicy: 'single-link' }
): Promise<BoundFileDigestSnapshot> {
  if (!closedRecord(options, ['maximumBytes', 'linkPolicy', 'diagnostics'])) {
    throw new FileSystemError('Bound digest options must contain only maximumBytes, linkPolicy and diagnostics.');
  }
  const errors = checkedDiagnostics(options.diagnostics);
  const maximumBytes = options.maximumBytes;
  if (options.linkPolicy !== 'single-link' || !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0 || maximumBytes > maximumDigestBytes) {
    errors.invalid('a streamed digest requires single-link reads and a positive byte limit no greater than 536870912.');
  }
  const root = checkedRoot(canonicalProjectRoot, errors), parts = checkedParts(pathParts, errors);
  const target = await checkedPath(root, parts, errors);
  const parents: { path: string; physical: string }[] = [];
  for (let length = 0; length < parts.length; length++) {
    const parent = path.join(root, ...parts.slice(0, length)), stat = await lstat(parent, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) errors.invalid('streamed digest has an unsafe parent.');
    parents.push({ path: parent, physical: digestPhysical(stat) });
  }
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 0n || before.size > BigInt(maximumBytes)) errors.invalid('streamed digest requires a bounded regular single-link file.');
  const physical = digestPhysical(before), size = Number(before.size);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (digestPhysical(await handle.stat({ bigint: true })) !== physical) errors.invalid('file changed before streamed digest reading.');
    const buffer = Buffer.alloc(Math.min(digestReadChunkBytes, Math.max(1, size)));
    const hash = createHash('sha256');
    let offset = 0, header = '';
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) errors.invalid('file was truncated during streamed digest reading.');
      if (offset < 8) header += buffer.subarray(0, Math.min(bytesRead, 8 - offset)).toString('hex');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if ((await handle.read(buffer, 0, 1, size)).bytesRead !== 0 ||
        digestPhysical(await handle.stat({ bigint: true })) !== physical ||
        digestPhysical(await lstat(target, { bigint: true })) !== physical) {
      errors.invalid('file bytes or identity changed during streamed digest reading.');
    }
    await checkedPath(root, parts, errors);
    for (const parent of parents) {
      if (digestPhysical(await lstat(parent.path, { bigint: true })) !== parent.physical) {
        errors.invalid('file ancestor changed during streamed digest reading.');
      }
    }
    return { pathParts: parts, bytes: size, mode: Number(before.mode & 0o7777n), digest: hash.digest('hex'), header, physical };
  } finally {
    await handle.close();
  }
}
