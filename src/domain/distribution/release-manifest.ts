import {
  allNativeTargets, canonicalProductName, canonicalRepository, nativeTargetFloors,
  type NativeReleaseManifest, type NativeTarget, type NativeTargetPayload,
  type NativeTargetResources, type NativeTargetRuntimeConstraints
} from './contracts.js';
import { DistributionError, ReleaseManifestValidationError, TargetNotSupportedError } from './errors.js';
import { digest, freeze, integer, object, publicHttpsUrl, sourceCommit, stableVersion, timestamp } from './validation.js';

export function parseNativeTarget(value: unknown): NativeTarget {
  for (const target of allNativeTargets) if (value === target) return target;
  throw new ReleaseManifestValidationError('Unsupported native operating system or architecture.');
}

function numericVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/u.test(value) ||
      value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new ReleaseManifestValidationError(`${label} must be a canonical numeric version.`);
  }
  return value;
}

export function parseRuntimeConstraints(raw: unknown, target?: NativeTarget): NativeTargetRuntimeConstraints {
  const value = object(raw, [
    'nodeVersion', 'minimumGlibc', 'minimumKernelVersion', 'minimumHostVersion', 'minimumDarwinRelease', 'minimumBuild'
  ], 'Native runtime');
  const runtime: NativeTargetRuntimeConstraints = {
    nodeVersion: stableVersion(value.nodeVersion),
    ...(value.minimumGlibc !== undefined ? { minimumGlibc: numericVersion(value.minimumGlibc, 'glibc floor') } : {}),
    ...(value.minimumKernelVersion !== undefined ? { minimumKernelVersion: numericVersion(value.minimumKernelVersion, 'kernel floor') } : {}),
    ...(value.minimumHostVersion !== undefined ? { minimumHostVersion: numericVersion(value.minimumHostVersion, 'OS floor') } : {}),
    ...(value.minimumDarwinRelease !== undefined ? { minimumDarwinRelease: numericVersion(value.minimumDarwinRelease, 'Darwin floor') } : {}),
    ...(value.minimumBuild !== undefined ? { minimumBuild: integer(value.minimumBuild, 'Windows build floor', nativeTargetFloors.win32.minimumBuild, 999999) } : {})
  };
  if (compareNumericVersions(runtime.nodeVersion, '24.20.0') < 0 ||
      target?.startsWith('linux-') && (!runtime.minimumGlibc ||
        compareNumericVersions(runtime.minimumGlibc, nativeTargetFloors.linux.minimumGlibc) < 0 ||
        runtime.minimumKernelVersion !== undefined && compareNumericVersions(runtime.minimumKernelVersion, nativeTargetFloors.linux.minimumKernelVersion) < 0) ||
      target?.startsWith('darwin-') && (!runtime.minimumDarwinRelease || !runtime.minimumHostVersion ||
        compareNumericVersions(runtime.minimumDarwinRelease, nativeTargetFloors.darwin.minimumDarwinRelease) < 0 ||
        compareNumericVersions(runtime.minimumHostVersion, nativeTargetFloors.darwin.minimumHostVersion) < 0) ||
      target?.startsWith('win32-') && (!runtime.minimumHostVersion || compareNumericVersions(runtime.minimumHostVersion, nativeTargetFloors.win32.minimumHostVersion) < 0)) {
    throw new ReleaseManifestValidationError('Native runtime metadata omits or weakens the registered host floor.');
  }
  return runtime;
}

export function parseNativeResources(raw: unknown): NativeTargetResources {
  const value = object(raw, ['inventoryHash', 'count'], 'Native resources');
  return {
    inventoryHash: digest(value.inventoryHash, 'Resource inventory digest'),
    count: integer(value.count, 'Resource inventory count', 1, 16_384)
  };
}

export function parseNativeReleaseManifest(raw: unknown): NativeReleaseManifest {
  try {
    const value = object(raw, ['$schema', 'schemaVersion', 'product', 'version', 'sourceCommit', 'publishedAt', 'targets'], 'Native release manifest');
    if (value.schemaVersion !== 1 || value.product !== canonicalProductName) {
      throw new ReleaseManifestValidationError('Native manifest requires schema 1 and the canonical Liftoff product.');
    }
    const version = stableVersion(value.version);
    const commit = sourceCommit(value.sourceCommit);
    const publishedAt = timestamp(value.publishedAt, 'Publication time');
    const targets = object(value.targets, allNativeTargets, 'Native targets');
    const parsePayload = (target: NativeTarget): NativeTargetPayload => {
      const payload = object(targets[target], [
        'os', 'arch', 'archiveUrl', 'archiveFormat', 'checksumSha256', 'signatureUrl', 'provenanceUrl', 'runtime', 'resources'
      ], `Native target ${target}`);
      const os = payload.os;
      const arch = payload.arch;
      if ((os !== 'darwin' && os !== 'win32' && os !== 'linux') || (arch !== 'x64' && arch !== 'arm64') ||
          `${os}-${arch}` !== target || payload.archiveFormat !== (os === 'win32' ? 'zip' : 'tar.gz')) {
        throw new ReleaseManifestValidationError(`Native target ${target} has an inconsistent payload identity.`);
      }
      const prefix = `https://github.com/${canonicalRepository}/releases/download/v${version}/`;
      const url = (input: unknown, label: string): string => {
        const parsed = publicHttpsUrl(input, label);
        if (!parsed.startsWith(prefix) || parsed === prefix) {
          throw new ReleaseManifestValidationError('Native artifacts must identify the same immutable canonical source release.');
        }
        return parsed;
      };
      return {
        os, arch, archiveFormat: os === 'win32' ? 'zip' : 'tar.gz',
        archiveUrl: url(payload.archiveUrl, 'Archive URL'),
        checksumSha256: digest(payload.checksumSha256, 'Final signed archive digest'),
        signatureUrl: url(payload.signatureUrl, 'Artifact signature URL'),
        provenanceUrl: url(payload.provenanceUrl, 'Artifact provenance URL'),
        runtime: parseRuntimeConstraints(payload.runtime, target),
        resources: parseNativeResources(payload.resources)
      };
    };
    const manifest: NativeReleaseManifest = {
      schemaVersion: 1, product: canonicalProductName, version, sourceCommit: commit, publishedAt,
      ...(value.$schema !== undefined ? { $schema: publicHttpsUrl(value.$schema, 'Schema URL') } : {}),
      targets: {
        'darwin-x64': parsePayload('darwin-x64'), 'darwin-arm64': parsePayload('darwin-arm64'),
        'win32-x64': parsePayload('win32-x64'), 'win32-arm64': parsePayload('win32-arm64'),
        'linux-x64': parsePayload('linux-x64'), 'linux-arm64': parsePayload('linux-arm64')
      }
    };
    return freeze(manifest);
  } catch (error) {
    if (error instanceof ReleaseManifestValidationError) throw error;
    if (error instanceof DistributionError) throw new ReleaseManifestValidationError(error.message);
    throw error;
  }
}

export function compareNumericVersions(a: string, b: string): number {
  const left = numericVersion(a, 'Observed version').split('.').map(Number);
  const right = numericVersion(b, 'Required version').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0) ? -1 : 1;
  }
  return 0;
}

export interface HostEnvironmentInfo {
  glibcVersion?: string;
  kernelRelease?: string;
  darwinRelease?: string;
  windowsBuild?: number;
  hostVersion?: string;
}

export function verifyTargetFloor(target: NativeTarget, host: HostEnvironmentInfo, runtime?: NativeTargetRuntimeConstraints): void {
  parseNativeTarget(target);
  if (runtime) runtime = parseRuntimeConstraints(runtime, target);
  const requireVersion = (observed: string | undefined, required: string, label: string): void => {
    if (!observed || compareNumericVersions(observed, required) < 0) {
      throw new TargetNotSupportedError(target, observed ? `${label} ${observed}` : `unobserved ${label}`, `${label} ${required}`);
    }
  };
  if (target.startsWith('linux-')) {
    requireVersion(host.glibcVersion, runtime?.minimumGlibc ?? nativeTargetFloors.linux.minimumGlibc, 'glibc');
    if (runtime) requireVersion(host.kernelRelease?.split('-')[0], runtime.minimumKernelVersion ?? nativeTargetFloors.linux.minimumKernelVersion, 'Linux kernel');
  } else if (target.startsWith('darwin-')) {
    requireVersion(host.darwinRelease, runtime?.minimumDarwinRelease ?? nativeTargetFloors.darwin.minimumDarwinRelease, 'Darwin');
    requireVersion(host.hostVersion, runtime?.minimumHostVersion ?? nativeTargetFloors.darwin.minimumHostVersion, 'macOS');
  } else {
    if (runtime?.minimumHostVersion) requireVersion(host.kernelRelease, runtime.minimumHostVersion, 'Windows');
    const floor = runtime?.minimumBuild ?? Number(runtime?.minimumHostVersion?.split('.')[2] ?? nativeTargetFloors.win32.minimumBuild);
    if (!Number.isSafeInteger(host.windowsBuild) || host.windowsBuild === undefined || host.windowsBuild < floor) {
      throw new TargetNotSupportedError(target, `Windows build ${host.windowsBuild ?? 'unobserved'}`, `Windows build ${floor}`);
    }
  }
}
