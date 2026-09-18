import path from 'node:path';
import { createHash } from 'node:crypto';
import { getPackageRoot } from './package-root.js';
import { liftoffVersion } from '../../version.js';
import { PackagedResourceIntegrityError, PackagedResourceMissingError, readBoundedPackagedFile } from './resource-file.js';
import { allNativeTargets } from '../../domain/distribution/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import {
  assertStrictKeys, assertStrictObject, protocolChoice, protocolReleaseVersion, protocolString,
  ProtocolValidationError
} from '../../protocol/schema.js';

export const BUILD_INFO_SCHEMA_VERSION = 1 as const;

export type SupportedNativeOs = 'darwin' | 'win32' | 'linux';
export type SupportedNativeArch = 'x64' | 'arm64';
export type SupportedNativePlatform = `${SupportedNativeOs}-${SupportedNativeArch}`;

export interface NativeBuildInfoTarget {
  os: SupportedNativeOs;
  arch: SupportedNativeArch;
  platform: SupportedNativePlatform;
}

export interface NativeBuildInfoRuntime {
  name: 'node';
  version: string;
}

export interface NativeBuildInfo {
  schemaVersion: 1;
  kind: 'native-release' | 'native';
  product: 'liftoff';
  version: string;
  commit: string;
  target: NativeBuildInfoTarget;
  runtime: NativeBuildInfoRuntime;
  resourcesDigest: string;
  profilesDigest: string;
  buildDate: string;
}

export interface DevelopmentBuildInfo {
  schemaVersion: 1;
  kind: 'development';
  product: 'liftoff';
  version: string;
  commit: 'uncommitted';
  target: {
    os: string;
    arch: string;
    platform: string;
  };
  runtime: {
    name: 'node';
    version: string;
  };
  resourcesDigest: 'unqualified';
  profilesDigest: 'unqualified';
  buildDate: 'unqualified';
}

export type BuildInfo = NativeBuildInfo | DevelopmentBuildInfo;

export class BuildInfoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildInfoValidationError';
  }
}

function freezeBuildInfo<T extends BuildInfo>(info: T): T {
  Object.freeze(info.target);
  Object.freeze(info.runtime);
  return Object.freeze(info);
}

function metadataDigest(value: unknown, field: string): string {
  const text = protocolString(value, field, 71);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(text)) {
    throw new BuildInfoValidationError(`${field} must be an exact lowercase SHA-256 digest.`);
  }
  return text.startsWith('sha256:') ? text : `sha256:${text}`;
}

export function validateNativeBuildInfo(raw: unknown): NativeBuildInfo {
  try {
    const record = assertStrictObject(raw, 'Native build-info');
    assertStrictKeys(record, [
      'schemaVersion', 'kind', 'product', 'version', 'commit', 'target', 'runtime',
      'resourcesDigest', 'profilesDigest', 'buildDate'
    ], 'Native build-info');
    if (record.schemaVersion !== BUILD_INFO_SCHEMA_VERSION) throw new BuildInfoValidationError('Native build-info schemaVersion must be 1.');
    const kind = protocolChoice(record.kind, ['native-release', 'native'] as const, 'Native build-info kind');
    const product = protocolChoice(record.product, ['liftoff'] as const, 'Native build-info product');
    const version = protocolReleaseVersion(record.version, 'Native build-info version (SemVer)');
    const commit = protocolString(record.commit, 'Native build-info commit (40-character lowercase hex Git SHA)', 40);
    if (!/^[a-f0-9]{40}$/u.test(commit)) throw new BuildInfoValidationError('Native build-info commit must be a 40-character lowercase hex Git SHA.');
    const target = assertStrictObject(record.target, 'Native build-info target');
    assertStrictKeys(target, ['os', 'arch', 'platform'], 'Native build-info target');
    const os = protocolChoice(target.os, ['darwin', 'win32', 'linux'] as const, 'Native build-info target.os');
    const arch = protocolChoice(target.arch, ['x64', 'arm64'] as const, 'Native build-info target.arch');
    const platform = protocolChoice(target.platform, allNativeTargets, 'Native build-info target.platform');
    if (platform !== `${os}-${arch}`) throw new BuildInfoValidationError('Native build-info target.platform differs from its OS/architecture.');
    const runtime = assertStrictObject(record.runtime, 'Native build-info runtime');
    assertStrictKeys(runtime, ['name', 'version'], 'Native build-info runtime');
    const name = protocolChoice(runtime.name, ['node'] as const, 'Native build-info runtime.name');
    const runtimeVersion = protocolReleaseVersion(runtime.version, 'Native build-info runtime.version (SemVer)');
    const resourcesDigest = metadataDigest(record.resourcesDigest, 'Native build-info resourcesDigest');
    const profilesDigest = metadataDigest(record.profilesDigest, 'Native build-info profilesDigest');
    const buildDate = protocolString(record.buildDate, 'Native build-info buildDate', 32);
    if (!Number.isFinite(Date.parse(buildDate)) || new Date(buildDate).toISOString() !== buildDate) {
      throw new BuildInfoValidationError('Native build-info buildDate must be a canonical UTC ISO timestamp.');
    }
    return freezeBuildInfo({
      schemaVersion: 1, kind, product, version, commit, target: { os, arch, platform },
      runtime: { name, version: runtimeVersion }, resourcesDigest, profilesDigest, buildDate
    });
  } catch (error) {
    if (!(error instanceof ProtocolValidationError)) throw error;
    throw new BuildInfoValidationError(error.message);
  }
}

let cachedBuildInfo: BuildInfo | undefined;
let cachedBuildInfoRoot: string | undefined;
let cachedBuildInfoSource: string | undefined;

function readMetadata(root: string, filename: string): Buffer | undefined {
  try {
    return readBoundedPackagedFile(root, [filename], { maximumBytes: 256 * 1024 });
  } catch (error) {
    if (error instanceof PackagedResourceMissingError) return undefined;
    if (!(error instanceof PackagedResourceIntegrityError)) throw error;
    throw new BuildInfoValidationError(`Corrupted or unsafe ${filename} at ${root}: ${error.message}`);
  }
}

function decodeMetadata(bytes: Buffer, filename: string): NativeBuildInfo {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new BuildInfoValidationError(`Invalid UTF-8 build-info at ${filename}.`);
  }
  let value: unknown;
  try {
    value = parseStrictManifestJson(text, 'Native build-info');
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    throw new BuildInfoValidationError(`Corrupted build-info JSON at ${filename}; duplicate or malformed fields are not admitted.`);
  }
  return validateNativeBuildInfo(value);
}

export function loadBuildInfo(customFilePath?: string, reload = false): BuildInfo {
  const currentRoot = getPackageRoot();
  if (customFilePath !== undefined) {
    if (typeof customFilePath !== 'string' || !customFilePath.trim() || /[\u0000-\u001f\u007f]/u.test(customFilePath)) {
      throw new BuildInfoValidationError('An explicit build-info path must be a nonempty native path without controls.');
    }
    const resolvedPath = path.resolve(customFilePath);
    const buffer = readMetadata(path.dirname(resolvedPath), path.basename(resolvedPath));
    if (buffer === undefined) throw new BuildInfoValidationError(`Explicit build-info file not found: ${resolvedPath}.`);
    return decodeMetadata(buffer, resolvedPath);
  }

  const buffer = readMetadata(currentRoot, 'build-info.json');
  if (buffer !== undefined) {
    const source = createHash('sha256').update(buffer).digest('hex');
    if (!reload && cachedBuildInfo && cachedBuildInfoRoot === currentRoot && cachedBuildInfoSource === source) return cachedBuildInfo;
    const info = decodeMetadata(buffer, path.join(currentRoot, 'build-info.json'));
    cachedBuildInfo = info;
    cachedBuildInfoRoot = currentRoot;
    cachedBuildInfoSource = source;
    return info;
  }

  if (readMetadata(currentRoot, 'liftoff-build-manifest.json') !== undefined ||
      cachedBuildInfoRoot === currentRoot && cachedBuildInfo !== undefined && cachedBuildInfo.kind !== 'development') {
    throw new BuildInfoValidationError('Native build-info.json is missing; an installed native identity cannot fall back to development.');
  }
  const devFallback = freezeBuildInfo<DevelopmentBuildInfo>({
    schemaVersion: 1,
    kind: 'development',
    product: 'liftoff',
    version: liftoffVersion,
    commit: 'uncommitted',
    target: {
      os: process.platform,
      arch: process.arch,
      platform: `${process.platform}-${process.arch}`
    },
    runtime: {
      name: 'node',
      version: process.versions.node
    },
    resourcesDigest: 'unqualified',
    profilesDigest: 'unqualified',
    buildDate: 'unqualified'
  });

  cachedBuildInfo = devFallback;
  cachedBuildInfoRoot = currentRoot;
  cachedBuildInfoSource = undefined;
  return devFallback;
}

export function getBuildInfo(): BuildInfo {
  return loadBuildInfo();
}

export function resetBuildInfoCache(): void {
  cachedBuildInfo = undefined;
  cachedBuildInfoRoot = undefined;
  cachedBuildInfoSource = undefined;
}
