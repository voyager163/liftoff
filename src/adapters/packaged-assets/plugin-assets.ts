import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import type { ContributionOwner, PackagedAssetBytes } from '../../plugins/contracts.js';
import { installedPackageRoot } from './package-root.js';
import type { PackagedTemplateAssetContext } from './template-assets.js';

/*
 * Bounded reads of declared packaged assets for registry intake. This module checks bounds,
 * locations and sizes only; the registry verifies encoding and release digests. Containment is
 * lexical within the package root, not realpath confinement: package-manager symlinks stay allowed.
 * Each file is read to the size fstat reported and then probed for one further byte, which refuses
 * the asset if observed. These checks concern observed bytes: they are not a coherent snapshot of a
 * file or the package, and growth after the probe is not detected.
 */

export interface DeclaredPackagedAsset {
  readonly owner: ContributionOwner;
  readonly id: string;
  readonly pathParts: readonly string[];
}

export interface PackagedAssetReadBounds {
  readonly maxAssetBytes: number;
  readonly maxTotalAssetBytes: number;
  readonly maxPathParts: number;
  readonly maxPartLength: number;
}

/** The synchronous file operations used for one bounded read; injectable for failure tests. */
export interface BoundedReadFs {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; readonly size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

export interface PackagedAssetReadOptions {
  readonly packageRoot?: string;
  readonly fs?: BoundedReadFs;
}

export type PackagedAssetReadReason =
  | 'invalid-path'
  | 'outside-root'
  | 'missing'
  | 'open-failed'
  | 'stat-failed'
  | 'not-regular-file'
  | 'too-large'
  | 'aggregate-too-large'
  | 'read-failed'
  | 'short-read'
  | 'grew'
  | 'close-failed';

const reasonText: Readonly<Record<PackagedAssetReadReason, string>> = {
  'invalid-path': 'the declared location is not a valid packaged asset path',
  'outside-root': 'the declared location resolves outside the package root',
  missing: 'the file does not exist',
  'open-failed': 'the file could not be opened',
  'stat-failed': 'the file could not be inspected',
  'not-regular-file': 'the location is not a regular file',
  'too-large': 'the file exceeds the per-asset byte limit',
  'aggregate-too-large': 'the declared assets exceed the total byte limit',
  'read-failed': 'the file could not be read',
  'short-read': 'fewer bytes were read than the file reported',
  grew: 'more bytes were observed than the file reported',
  'close-failed': 'the file could not be closed after reading'
};

const ownerLabel = (owner: ContributionOwner): string =>
  owner.kind === 'core' ? 'core' : `${owner.category}:${owner.id}`;

const systemCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

export class PackagedAssetReadError extends Error {
  readonly owner: ContributionOwner;
  readonly id: string;
  /** Package-relative location in portable form; never an absolute path. */
  readonly portablePath: string;
  readonly reason: PackagedAssetReadReason;
  /** Underlying system error code, when the operating system reported one. */
  readonly code?: string;
  /** Set when closing the file also failed after this primary failure. */
  readonly closeCode?: string;

  constructor(
    asset: DeclaredPackagedAsset,
    reason: PackagedAssetReadReason,
    details: { readonly code?: string; readonly closeFailed?: boolean; readonly closeCode?: string; readonly cause?: unknown } = {}
  ) {
    const portablePath = Array.isArray(asset.pathParts) ? asset.pathParts.join('/') : String(asset.pathParts);
    const closing = details.closeFailed
      ? `; closing it also failed${details.closeCode === undefined ? '' : ` (${details.closeCode})`}`
      : '';
    super(
      `Packaged asset ${ownerLabel(asset.owner)}/${asset.id} at ${JSON.stringify(portablePath)} could not be used: ` +
        `${reasonText[reason]}${details.code === undefined ? '' : ` (${details.code})`}${closing}.`,
      details.cause === undefined ? undefined : { cause: details.cause }
    );
    this.name = 'PackagedAssetReadError';
    this.owner = asset.owner.kind === 'core'
      ? Object.freeze({ kind: 'core' })
      : Object.freeze({ kind: 'plugin', category: asset.owner.category, id: asset.owner.id });
    this.id = asset.id;
    this.portablePath = portablePath;
    this.reason = reason;
    if (details.code !== undefined) this.code = details.code;
    if (details.closeFailed) this.closeCode = details.closeCode ?? 'unknown';
  }
}

const portablePart = /^[A-Za-z0-9._-]+$/;
const nodeFs: BoundedReadFs = { openSync, fstatSync, readSync, closeSync };
// Opening a FIFO or device without O_NONBLOCK can block before fstat can reject it; the flag has no
// effect on regular files. It is undefined on Windows, where the path types that block are absent.
const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const boundNames = ['maxAssetBytes', 'maxTotalAssetBytes', 'maxPathParts', 'maxPartLength'] as const;

export type PackagedAssetReadBoundsReason = 'not-an-object' | 'unknown-bound' | 'missing-bound' | 'invalid-bound';

const boundsReasonText: Readonly<Record<PackagedAssetReadBoundsReason, string>> = {
  'not-an-object': `must be an object holding ${boundNames.join(', ')}`,
  'unknown-bound': 'is not a recognized bound',
  'missing-bound': 'is missing',
  'invalid-bound': 'must be an own enumerable data property holding a positive safe integer'
};

/** Malformed read bounds are a caller error, reported before any location check, I/O or allocation. */
export class PackagedAssetReadBoundsError extends Error {
  /** The offending bound; absent when the bounds value itself is not an object. */
  readonly bound?: string;
  readonly reason: PackagedAssetReadBoundsReason;

  constructor(reason: PackagedAssetReadBoundsReason, bound?: string) {
    super(`Packaged asset read ${bound === undefined ? 'bounds' : `bound ${JSON.stringify(bound)}`} ${boundsReasonText[reason]}.`);
    this.name = 'PackagedAssetReadBoundsError';
    this.reason = reason;
    if (bound !== undefined) this.bound = bound;
  }
}

/** Exact bounds: the four own data properties, each a positive safe integer, never coerced or defaulted. */
function validatedBounds(value: unknown): PackagedAssetReadBounds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PackagedAssetReadBoundsError('not-an-object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(boundNames as readonly string[]).includes(key)) {
      throw new PackagedAssetReadBoundsError('unknown-bound', String(key));
    }
  }
  const bounds: Partial<Record<(typeof boundNames)[number], number>> = {};
  for (const name of boundNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) throw new PackagedAssetReadBoundsError('missing-bound', name);
    // Reading the descriptor never invokes an accessor; an accessor is not a data property.
    const bound: unknown = descriptor.value;
    if (!('value' in descriptor) || descriptor.enumerable !== true || typeof bound !== 'number' ||
        !Number.isSafeInteger(bound) || bound <= 0) {
      throw new PackagedAssetReadBoundsError('invalid-bound', name);
    }
    bounds[name] = bound;
  }
  return bounds as PackagedAssetReadBounds;
}

function locate(root: string, asset: DeclaredPackagedAsset, bounds: PackagedAssetReadBounds): string {
  const parts: unknown = asset.pathParts;
  const valid = Array.isArray(parts) &&
    parts.length >= 2 &&
    parts.length <= bounds.maxPathParts &&
    parts[0] === 'assets' &&
    parts.every((part) => typeof part === 'string' && part.length <= bounds.maxPartLength && portablePart.test(part));
  if (!valid) throw new PackagedAssetReadError(asset, 'invalid-path');
  try {
    validateArtifactPathParts(parts, 'Packaged asset path');
  } catch (cause) {
    throw new PackagedAssetReadError(asset, 'invalid-path', { cause });
  }
  const absolute = path.join(root, ...(parts as string[]));
  const relative = path.relative(root, absolute);
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') {
    throw new PackagedAssetReadError(asset, 'outside-root');
  }
  return absolute;
}

function readBounded(
  fs: BoundedReadFs,
  absolute: string,
  asset: DeclaredPackagedAsset,
  bounds: PackagedAssetReadBounds,
  alreadyRead: number
): Uint8Array {
  let fd: number | undefined;
  let bytes: Uint8Array | undefined;
  let primary: PackagedAssetReadError | undefined;
  const fail = (reason: PackagedAssetReadReason, cause?: unknown): PackagedAssetReadError =>
    new PackagedAssetReadError(asset, reason, { code: systemCode(cause), cause });
  try {
    try {
      fd = fs.openSync(absolute, readFlags);
    } catch (cause) {
      throw fail(systemCode(cause) === 'ENOENT' ? 'missing' : 'open-failed', cause);
    }
    let stat: ReturnType<BoundedReadFs['fstatSync']>;
    try {
      stat = fs.fstatSync(fd);
    } catch (cause) {
      throw fail('stat-failed', cause);
    }
    if (!stat.isFile()) throw fail('not-regular-file');
    const size = stat.size;
    if (!Number.isSafeInteger(size) || size < 0) throw fail('stat-failed');
    if (size > bounds.maxAssetBytes) throw fail('too-large');
    if (alreadyRead + size > bounds.maxTotalAssetBytes) throw fail('aggregate-too-large');
    const buffer = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      let count: number;
      try {
        count = fs.readSync(fd, buffer, offset, size - offset, offset);
      } catch (cause) {
        throw fail('read-failed', cause);
      }
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== size) throw fail('short-read');
    // One bounded probe at the reported size: a byte observed there means the file grew during the
    // read. This observes bytes only; it is not a snapshot, and later growth is not detected.
    let extra: number;
    try {
      extra = fs.readSync(fd, new Uint8Array(1), 0, 1, size);
    } catch (cause) {
      throw fail('read-failed', cause);
    }
    if (extra > 0) throw fail('grew');
    bytes = buffer;
  } catch (error) {
    if (!(error instanceof PackagedAssetReadError)) throw error;
    primary = error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (cause) {
        // A close failure never masks the primary failure, and after a successful read it refuses.
        primary = primary === undefined
          ? fail('close-failed', cause)
          : new PackagedAssetReadError(asset, primary.reason, {
            code: primary.code,
            closeFailed: true,
            closeCode: systemCode(cause),
            cause: primary.cause
          });
      }
    }
  }
  if (primary !== undefined) throw primary;
  return bytes as Uint8Array;
}

/**
 * Reads every declared asset, in order, after validating the bounds and then every location, all
 * before any I/O. Bounds are supplied by the caller (the registry limits), so this adapter imports
 * no plugin module at runtime; it checks their shape, while the caller owns their ceilings.
 */
export function readDeclaredAssetBytes(
  declarations: readonly DeclaredPackagedAsset[],
  bounds: PackagedAssetReadBounds,
  options: PackagedAssetReadOptions = {}
): PackagedAssetBytes[] {
  const checked = validatedBounds(bounds);
  const root = path.resolve(options.packageRoot ?? installedPackageRoot);
  const fs = options.fs ?? nodeFs;
  const located = declarations.map((asset) => ({ asset, absolute: locate(root, asset, checked) }));
  const assets: PackagedAssetBytes[] = [];
  let total = 0;
  for (const { asset, absolute } of located) {
    const bytes = readBounded(fs, absolute, asset, checked, total);
    total += bytes.length;
    assets.push({ pathParts: [...asset.pathParts], bytes });
  }
  return assets;
}

/** Resolves the verified text of one explicit (owner, asset id) identity. */
export type OwnedAssetText = (owner: ContributionOwner, id: string) => string;

const core: ContributionOwner = { kind: 'core' };
const nodeFastify: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'node-fastify' };
const goHuma: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'go-huma' };
const pythonFastapi: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'python-fastapi' };
const azure: ContributionOwner = { kind: 'plugin', category: 'cloud', id: 'azure' };

/** Pure mapping from verified asset texts to the generator's template asset context. */
export function templateAssetContextFromTexts(text: OwnedAssetText): PackagedTemplateAssetContext {
  return {
    npm: {
      'node-backend': {
        packageJson: text(nodeFastify, 'node-backend-package-manifest'),
        packageLock: text(nodeFastify, 'node-backend-package-lock')
      },
      frontend: {
        packageJson: text(core, 'frontend-package-manifest'),
        packageLock: text(core, 'frontend-package-lock')
      }
    },
    python: {
      genai: {
        pyproject: text(pythonFastapi, 'python-genai-project'),
        lock: text(pythonFastapi, 'python-genai-lock')
      },
      standard: {
        pyproject: text(pythonFastapi, 'python-standard-project'),
        lock: text(pythonFastapi, 'python-standard-lock')
      }
    },
    functionRequirements: text(pythonFastapi, 'python-genai-function-requirements'),
    go: {
      module: text(goHuma, 'go-backend-module'),
      checksum: text(goHuma, 'go-backend-checksums')
    },
    opentofu: {
      versions: text(azure, 'opentofu-azure-versions'),
      providerLock: text(azure, 'opentofu-azure-provider-lock')
    }
  };
}
