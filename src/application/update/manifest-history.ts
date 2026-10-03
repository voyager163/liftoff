import { parseManifest } from '../project/manifest.js';
import {
  createManifestHistoryIndex, validateManifestHistoryIndex, encodeManifestHistoryIndex,
  validateManifestSourceHistoryReference, manifestHistoryPaths, manifestHistoryMaximumSourceBytes
} from '../../domain/project/manifest/history.js';
import type {
  ManifestHistorySource, ManifestHistoryIndex, ManifestSourceHistoryReference, ManifestHistoryPaths
} from '../../domain/project/manifest/history.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { parseHistoryJson, rawHistoryDigest } from '../../governance-activation/history-contracts.js';
import { assertSafeHistoricalBytes } from '../../governance-activation/historical-safety.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';

export interface CapturedPresentFile {
  readonly pathParts: readonly string[];
  readonly content: Buffer;
  readonly mode: number;
}

export interface CapturedAbsentFile {
  readonly pathParts: readonly string[];
  readonly content?: never;
  readonly mode?: never;
}

export type CapturedFile = CapturedPresentFile | CapturedAbsentFile;

export interface SnapshotDirectoryObservation {
  readonly pathParts: readonly string[];
  readonly kind: 'absent' | 'directory';
}

export interface StandaloneManifestHistoryInput {
  readonly sourceManifest: CapturedPresentFile;
  readonly destinations: {
    readonly directory: SnapshotDirectoryObservation;
    readonly index: CapturedFile;
    readonly copy: CapturedFile;
  };
}

export interface PreparedStandaloneManifestHistory {
  readonly kind: 'manifest-source-preservation-preparation';
  readonly disposition: 'create-standalone' | 'reuse-standalone';
  readonly source: ManifestHistorySource;
  readonly index: ManifestHistoryIndex;
  readonly indexBytes: Buffer;
  readonly reference: ManifestSourceHistoryReference;
  readonly preservationWrites: readonly ProjectFileMutation[];
  readonly filePreconditions: readonly ProjectFileSnapshot[];
  readonly directoryObservation: SnapshotDirectoryObservation;
}

function invalid(detail: string): never {
  throw new FileSystemError(`Manifest history preparation: ${detail}`);
}

function observation(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${label} must be a plain own-data observation.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    invalid(`${label} has missing or unexpected fields.`);
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label}.${field} must be an own enumerable data field.`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function exactPath(value: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expected.length || Reflect.ownKeys(value).length !== expected.length + 1) {
    invalid(`${label} must be the exact dense captured path.`);
  }
  for (const [index, part] of expected.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== part) {
      invalid(`${label} must be the exact dense captured path.`);
    }
  }
  return [...expected];
}

function capturedFile(value: unknown, expected: readonly string[], label: string): CapturedFile {
  const present = typeof value === 'object' && value !== null && Object.hasOwn(value, 'content');
  const item = observation(value, present ? ['pathParts', 'content', 'mode'] : ['pathParts'], label);
  const pathParts = exactPath(item.pathParts, expected, `${label}.pathParts`);
  if (!present) return { pathParts };
  if (!Buffer.isBuffer(item.content) || Object.getPrototypeOf(item.content) !== Buffer.prototype ||
    Object.hasOwn(item.content, 'length') || Object.hasOwn(item.content, 'buffer') ||
    Object.hasOwn(item.content, 'byteOffset') || Object.hasOwn(item.content, 'byteLength')) {
    invalid(`${label}.content must be a plain Buffer.`);
  }
  if (item.content.length === 0 || item.content.length > manifestHistoryMaximumSourceBytes) {
    invalid(`${label}.content must contain 1 through ${manifestHistoryMaximumSourceBytes} bytes.`);
  }
  if (typeof item.mode !== 'number' || !Number.isSafeInteger(item.mode) || Object.is(item.mode, -0) ||
    item.mode < 0 || item.mode > 0o7777) {
    invalid(`${label}.mode must be an observed integer from 0 through 4095.`);
  }
  const content = Buffer.alloc(item.content.length);
  // Typed-array set copies the Buffer view without source coercion, iteration or species.
  Uint8Array.prototype.set.call(content, item.content);
  return { pathParts, content, mode: item.mode };
}

function snapshot(file: CapturedFile): ProjectFileSnapshot {
  return file.content === undefined
    ? { pathParts: [...file.pathParts] }
    : { pathParts: [...file.pathParts], content: Buffer.from(file.content), mode: file.mode };
}

function deriveStandaloneManifestHistorySource(sourceManifest: unknown) {
  const original = capturedFile(sourceManifest, ['liftoff.manifest.json'], 'sourceManifest');
  if (original.content === undefined) invalid('the original sourceManifest must be present.');
  assertSafeHistoricalBytes(original.content, 'original manifest');
  const manifest = parseManifest(parseHistoryJson(original.content, 'original manifest'));
  const index = createManifestHistoryIndex({
    artifactVersion: manifest.artifactVersion,
    digest: rawHistoryDigest(original.content),
    bytes: original.content.length,
    mode: original.mode
  });
  const encoded = encodeManifestHistoryIndex(index);
  const indexBytes = Buffer.from(encoded.content, 'utf8');
  const reference = validateManifestSourceHistoryReference({
    schemaVersion: 1, kind: 'manifest-history', snapshotId: index.snapshotId, indexDigest: encoded.indexDigest
  });
  const paths = manifestHistoryPaths(reference);
  return { original, index, indexBytes, reference, paths };
}

export function standaloneManifestHistoryPathsForSource(
  sourceManifest: CapturedPresentFile
): ManifestHistoryPaths {
  return deriveStandaloneManifestHistorySource(sourceManifest).paths;
}

// Supplied observations are data, not evidence of a completed read or authority
// to publish. Existing application composition loads packaged assets on import.
export function prepareStandaloneManifestHistory(
  input: StandaloneManifestHistoryInput
): PreparedStandaloneManifestHistory {
  const request = observation(input, ['sourceManifest', 'destinations'], 'input');
  const destinations = observation(request.destinations, ['directory', 'index', 'copy'], 'destinations');
  const { original, index, indexBytes, reference, paths } = deriveStandaloneManifestHistorySource(request.sourceManifest);
  const directory = observation(destinations.directory, ['pathParts', 'kind'], 'destinations.directory');
  const directoryPath = exactPath(directory.pathParts, paths.indexPathParts.slice(0, -1), 'destinations.directory.pathParts');
  if (directory.kind !== 'absent' && directory.kind !== 'directory') {
    invalid('destinations.directory.kind must be absent or directory.');
  }
  const indexFile = capturedFile(destinations.index, paths.indexPathParts, 'destinations.index');
  const copyFile = capturedFile(destinations.copy, paths.manifestPathParts, 'destinations.copy');
  const writes: ProjectFileMutation[] = [];
  let disposition: PreparedStandaloneManifestHistory['disposition'];
  if (directory.kind === 'absent' && indexFile.content === undefined && copyFile.content === undefined) {
    disposition = 'create-standalone';
    writes.push(
      { type: 'write', pathParts: [...paths.manifestPathParts], content: Buffer.from(original.content), mode: 0o600 },
      { type: 'write', pathParts: [...paths.indexPathParts], content: Buffer.from(indexBytes), mode: 0o600 }
    );
  } else if (directory.kind === 'directory' && indexFile.content !== undefined && copyFile.content !== undefined) {
    assertSafeHistoricalBytes(indexFile.content, 'manifest history index');
    const storedIndex = validateManifestHistoryIndex(parseHistoryJson(indexFile.content, 'manifest history index'));
    if (storedIndex.snapshotId !== index.snapshotId || !indexFile.content.equals(indexBytes)) {
      invalid('the completed index differs from the exact original source and canonical index bytes.');
    }
    if (!copyFile.content.equals(original.content)) {
      invalid('the completed manifest copy differs from the exact original bytes.');
    }
    disposition = 'reuse-standalone';
  } else {
    invalid('incomplete or inconsistent history observations cannot be repaired or reused.');
  }
  return {
    kind: 'manifest-source-preservation-preparation',
    disposition,
    source: createManifestHistoryIndex(index.source).source,
    index,
    indexBytes,
    reference,
    preservationWrites: writes,
    filePreconditions: [snapshot(original), snapshot(copyFile), snapshot(indexFile)],
    directoryObservation: { pathParts: directoryPath, kind: directory.kind }
  };
}
