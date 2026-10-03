import { createHash } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Native path capabilities and owned temporary roots for host-dependent path tests. Capabilities are
 * probed once, in a recorded probe root. A capability counts as unavailable only for the expected
 * errno codes below; any other probe error fails loudly instead of skipping. Only roots created and
 * recorded here are ever removed, after re-checking their identity. Nothing here decides product path
 * safety: the product functions under test and the native filesystem are the only oracles.
 */

export type NativeCapability =
  | { readonly available: true }
  | { readonly available: false; readonly code: string };

const unavailableCodes: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/** Directory links are junctions on Windows and directory symlinks elsewhere. */
export const directoryLinkKind: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function present(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

interface OwnedRecord {
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly links: string[];
}

const ownedRoots = new Map<string, OwnedRecord>();

/** Creates and records a fresh directory below the temporary directory. */
export function createOwnedRoot(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `liftoff-native-${label}-`));
  const details = lstatSync(root, { bigint: true });
  ownedRoots.set(root, { root, dev: details.dev, ino: details.ino, links: [] });
  return root;
}

function recordOwning(candidate: string, allowRoot = false): OwnedRecord {
  const resolved = path.resolve(candidate);
  for (const record of ownedRoots.values()) {
    const relative = path.relative(record.root, resolved);
    if (relative === '' ? allowRoot : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return record;
    }
  }
  throw new Error(`${candidate} is not inside a recorded owned root.`);
}

/** Creates a directory link strictly inside a recorded root, targeting a recorded root or a path inside one. */
export function createDirectoryLink(target: string, link: string): void {
  const record = recordOwning(link);
  recordOwning(target, true);
  symlinkSync(target, link, directoryLinkKind);
  record.links.push(link);
}

/** Removes one recorded root: its recorded links first, then the directory tree. */
export function removeOwnedRoot(root: string): void {
  const record = ownedRoots.get(root);
  if (record === undefined) throw new Error(`Refusing to remove ${root}: it is not a recorded owned root.`);
  const details = lstatSync(root, { bigint: true });
  if (!details.isDirectory() || details.dev !== record.dev || details.ino !== record.ino) {
    throw new Error(`Refusing to remove ${root}: it no longer matches the recorded owned root.`);
  }
  for (const link of [...record.links].reverse()) {
    if (!present(link)) continue;
    try {
      unlinkSync(link);
    } catch (error) {
      const code = errorCode(error);
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EISDIR')) throw error;
      rmdirSync(link);
    }
  }
  rmSync(root, { recursive: true });
  if (present(root)) throw new Error(`The recorded owned root ${root} was not removed.`);
  ownedRoots.delete(root);
}

/** Removes every root still recorded, newest first. */
export function removeAllOwnedRoots(): void {
  for (const root of [...ownedRoots.keys()].reverse()) removeOwnedRoot(root);
}

function probeCapability(action: () => void): NativeCapability {
  try {
    action();
    return { available: true };
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && unavailableCodes.has(code)) return { available: false, code };
    throw error;
  }
}

export interface NativeCapabilities {
  readonly platform: NodeJS.Platform;
  /** Whether the probed temporary directory resolves a name that differs only by case. */
  readonly caseInsensitive: boolean;
  /** Whether the probed temporary directory resolves a name that differs only by NFC/NFD form. */
  readonly normalizationInsensitive: boolean;
  readonly directoryLinks: NativeCapability;
  readonly hardLinks: NativeCapability;
}

export const nativeCapabilities: NativeCapabilities = (() => {
  const root = createOwnedRoot('probe');
  try {
    writeFileSync(path.join(root, 'probe-AbC'), '', { flag: 'wx' });
    const caseInsensitive = present(path.join(root, 'probe-abc'));
    writeFileSync(path.join(root, 'probe-\u00e9'), '', { flag: 'wx' });
    const normalizationInsensitive = present(path.join(root, 'probe-e\u0301'));
    const linkTarget = path.join(root, 'link-target');
    mkdirSync(linkTarget);
    const directoryLinks = probeCapability(() => createDirectoryLink(linkTarget, path.join(root, 'link')));
    if (directoryLinks.available && !lstatSync(path.join(root, 'link')).isSymbolicLink()) {
      throw new Error('A created directory link is not reported as a link by lstat.');
    }
    writeFileSync(path.join(root, 'hard-source'), 'probe', { flag: 'wx' });
    const hardLinks = probeCapability(() => linkSync(path.join(root, 'hard-source'), path.join(root, 'hard-link')));
    if (hardLinks.available && lstatSync(path.join(root, 'hard-source')).nlink < 2) {
      throw new Error('A created hard link is not reflected in the link count.');
    }
    return Object.freeze({ platform: process.platform, caseInsensitive, normalizationInsensitive, directoryLinks, hardLinks });
  } finally {
    removeOwnedRoot(root);
  }
})();

export const caseClass = nativeCapabilities.caseInsensitive ? 'case-insensitive' : 'case-sensitive';
export const normalizationClass = nativeCapabilities.normalizationInsensitive
  ? 'normalization-insensitive'
  : 'normalization-sensitive';

/** Fixed skip-title suffixes naming exactly what did not run and why. */
export function windowsOnlyLabel(): string {
  return process.platform === 'win32' ? '(native Windows only)' : `(native Windows only; unrun on ${process.platform})`;
}

export function capabilityLabel(requirement: 'directory links' | 'hard links', capability: NativeCapability): string {
  return capability.available ? `(requires ${requirement})` : `(requires ${requirement}; unrun: ${capability.code})`;
}

export function describeNativeCapabilities(): string {
  const state = (capability: NativeCapability): string => (capability.available ? 'available' : `unavailable (${capability.code})`);
  return `native path capabilities: platform ${nativeCapabilities.platform}; probed directory ${caseClass}, ${normalizationClass}; ` +
    `directory links (${directoryLinkKind}) ${state(nativeCapabilities.directoryLinks)}; hard links ${state(nativeCapabilities.hardLinks)}`;
}

export type NativeEntryKind = 'file' | 'directory';

export interface MaterializedGroup {
  /** Entries whose exclusive creation failed, with the errno code. */
  readonly errors: readonly { readonly name: string; readonly code: string }[];
  /** The directory listing afterwards, sorted by UTF-16 code units. */
  readonly listing: readonly string[];
  readonly kinds: Readonly<Record<string, string>>;
}

function kindOf(details: Stats): string {
  if (details.isSymbolicLink()) return 'link';
  if (details.isDirectory()) return 'directory';
  if (details.isFile()) return 'file';
  return 'other';
}

/** Creates every entry exclusively in an empty owned directory, then lists the result exactly. */
export function materializeGroup(
  directory: string,
  entries: readonly { readonly name: string; readonly kind: NativeEntryKind }[]
): MaterializedGroup {
  recordOwning(directory);
  if (readdirSync(directory).length !== 0) throw new Error(`${directory} is not empty.`);
  const errors: { name: string; code: string }[] = [];
  for (const entry of entries) {
    // Only single components are created, so nothing can be written outside the owned directory.
    if (path.basename(entry.name) !== entry.name || entry.name === '.' || entry.name === '..') {
      throw new Error(`Refusing to create ${JSON.stringify(entry.name)}: it is not a single path component.`);
    }
    const target = path.join(directory, entry.name);
    try {
      if (entry.kind === 'directory') mkdirSync(target);
      else writeFileSync(target, '', { flag: 'wx' });
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined) throw error;
      errors.push({ name: entry.name, code });
    }
  }
  const listing = readdirSync(directory).sort();
  const kinds = Object.fromEntries(listing.map((name) => [name, kindOf(lstatSync(path.join(directory, name)))]));
  return { errors, listing, kinds };
}

/** A no-follow snapshot of names, types, modes, sizes, content digests and link targets. */
export function lstatWalk(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const key = prefix === '' ? name : `${prefix}/${name}`;
      const details = lstatSync(full);
      const mode = (details.mode & 0o7777).toString(8);
      if (details.isSymbolicLink()) {
        entries[key] = `link:${readlinkSync(full)}`;
      } else if (details.isDirectory()) {
        entries[key] = `directory:${mode}`;
        visit(full, key);
      } else if (details.isFile()) {
        entries[key] = `file:${mode}:${details.size}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
      } else {
        entries[key] = 'other';
      }
    }
  };
  visit(root, '');
  return entries;
}
