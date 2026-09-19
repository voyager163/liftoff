import {
  constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync,
  type Stats
} from 'node:fs';
import path from 'node:path';

export class PackagedResourceIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PackagedResourceIntegrityError';
  }
}

export class PackagedResourceMissingError extends PackagedResourceIntegrityError {
  constructor(pathParts: readonly string[]) {
    super(`Packaged resource does not exist: ${pathParts.join('/')}`);
    this.name = 'PackagedResourceMissingError';
  }
}

export interface PackagedFileReadOptions {
  maximumBytes?: number;
  expectedSize?: number;
}

const maximumResourceBytes = 10 * 1024 * 1024;
const folded = (value: string) => value.normalize('NFC').toLowerCase();
const usable = (stat: Stats) => Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
  Number.isSafeInteger(stat.ino) && stat.ino > 0;
const identityMatches = (left: Stats, right: Stats) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;

export function validatePackagedPathParts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 ||
      Array.from(value).some((part) => typeof part !== 'string' || !part || part.length > 255 ||
        part !== part.normalize('NFC') || part === '.' || part === '..' ||
        /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(part) || /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new PackagedResourceIntegrityError('Resource path has an unregistered, nonportable, or ambiguous component.');
  }
  const parts = value as string[];
  if (parts.join('/').length > 4096) throw new PackagedResourceIntegrityError('Resource path exceeds its bounded length.');
  return [...parts];
}

export function packagedPathParts(value: unknown): string[] {
  if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\')) {
    throw new PackagedResourceIntegrityError('Resource path must use exact relative portable path parts, not native aliases.');
  }
  return validatePackagedPathParts(value.split('/'));
}

function canonicalRoot(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root ||
      /[\u0000-\u001f\u007f]/u.test(root) || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) {
    throw new PackagedResourceIntegrityError('Package root must be an absolute canonical native directory.');
  }
  const before = lstatSync(root);
  if (!before.isDirectory() || before.isSymbolicLink() || !usable(before) || realpathSync(root) !== root) {
    throw new PackagedResourceIntegrityError('Package root has an unsafe or unresolvable directory identity.');
  }
  if (!identityMatches(before, lstatSync(root))) throw new PackagedResourceIntegrityError('Package root changed during inspection.');
  return root;
}

function safeNames(parent: string, expected: string): boolean {
  const directory = opendirSync(parent, { bufferSize: 32 });
  let count = 0;
  let matched = false;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++count > 16_384) throw new PackagedResourceIntegrityError('Packaged resource parent exceeds the bounded directory inventory.');
      if (folded(entry.name) !== folded(expected)) continue;
      if (matched || entry.name !== expected) {
        throw new PackagedResourceIntegrityError(`Packaged resource has a case/normalization alias: ${expected}`);
      }
      matched = true;
    }
  } finally {
    directory.closeSync();
  }
  return matched;
}

function inspectPath(root: string, parts: readonly string[]): {
  fullPath: string;
  file: Stats;
  directories: ReadonlyMap<string, Stats>;
} {
  canonicalRoot(root);
  const fullPath = path.join(root, ...parts);
  const relative = path.relative(root, fullPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PackagedResourceIntegrityError('Resource path escapes its canonical package boundary.');
  }
  const directories = new Map<string, Stats>([[root, lstatSync(root)]]);
  let current = root;
  for (const [index, part] of parts.entries()) {
    const present = safeNames(current, part);
    if (!present && index === parts.length - 1) {
      assertDirectories(directories);
      if (safeNames(current, part)) throw new PackagedResourceIntegrityError('Packaged resource appeared during its absence observation.');
      assertDirectories(directories);
      throw new PackagedResourceMissingError(parts);
    }
    current = path.join(current, part);
    const details = lstatSync(current);
    if (details.isSymbolicLink() || !usable(details) || realpathSync(current) !== current) {
      throw new PackagedResourceIntegrityError(`Packaged resource traverses an unsafe linked/aliased identity: ${parts.slice(0, index + 1).join('/')}`);
    }
    if (index < parts.length - 1) {
      if (!details.isDirectory()) throw new PackagedResourceIntegrityError('Packaged resource parent is not a directory.');
      directories.set(current, details);
    } else {
      if (!details.isFile() || details.nlink !== 1) {
        throw new PackagedResourceIntegrityError('Packaged resource must be a singly linked regular file, never a FIFO/device/directory.');
      }
      return { fullPath, file: details, directories };
    }
  }
  throw new PackagedResourceIntegrityError('Packaged resource path is empty.');
}

function assertDirectories(directories: ReadonlyMap<string, Stats>): void {
  for (const [directory, original] of directories) {
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || !identityMatches(original, current) ||
        realpathSync(directory) !== directory) {
      throw new PackagedResourceIntegrityError('Packaged resource parent changed during its bounded read.');
    }
  }
}

export function readBoundedPackagedFile(
  root: string, pathParts: readonly string[], options: PackagedFileReadOptions = {}
): Buffer {
  const parts = validatePackagedPathParts(pathParts);
  const maximum = options.maximumBytes ?? maximumResourceBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumResourceBytes ||
      options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) ||
        options.expectedSize < 0 || options.expectedSize > maximum)) {
    throw new PackagedResourceIntegrityError('Resource read has invalid size bounds.');
  }
  let descriptor: number | undefined;
  try {
    const snapshot = inspectPath(root, parts);
    if (snapshot.file.size > maximum || options.expectedSize !== undefined && snapshot.file.size !== options.expectedSize) {
      throw new PackagedResourceIntegrityError(`Resource size mismatch or bound exceeded: ${parts.join('/')}`);
    }
    descriptor = openSync(snapshot.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !identityMatches(opened, snapshot.file) ||
        opened.size !== snapshot.file.size || opened.size > maximum ||
        opened.mtimeMs !== snapshot.file.mtimeMs || opened.ctimeMs !== snapshot.file.ctimeMs) {
      throw new PackagedResourceIntegrityError('Packaged resource changed while opening.');
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (bytes === 0) break;
      length += bytes;
    }
    const after = fstatSync(descriptor);
    const current = inspectPath(root, parts);
    if (length !== opened.size || length > maximum || !identityMatches(opened, after) ||
        !identityMatches(opened, current.file) || after.nlink !== 1 || current.file.nlink !== 1 ||
        after.size !== length || current.file.size !== length ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        opened.mtimeMs !== current.file.mtimeMs || opened.ctimeMs !== current.file.ctimeMs) {
      throw new PackagedResourceIntegrityError('Packaged resource changed during its bounded read.');
    }
    assertDirectories(snapshot.directories);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof PackagedResourceIntegrityError) throw error;
    throw new PackagedResourceIntegrityError(`Unable to read packaged resource ${parts.join('/')}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
