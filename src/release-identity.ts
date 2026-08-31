import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface PackageIdentity {
  name: string;
  version: string;
}

export interface ReleaseIdentityOptions {
  packageRoot: string;
  releaseTag?: string;
}

export interface ReleaseIdentityResult extends PackageIdentity {
  expectedTag: string;
  releaseTag?: string;
}

export interface ReleaseIdentityDependencies {
  readJson(filePath: string): Promise<unknown>;
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function packageIdentity(value: unknown, source: string): PackageIdentity {
  const packageRecord = record(value, source);
  if (typeof packageRecord.name !== 'string' || !packageRecord.name) {
    throw new Error(`${source} must contain a non-empty name field.`);
  }
  if (typeof packageRecord.version !== 'string' || !packageRecord.version) {
    throw new Error(`${source} must contain a non-empty version field.`);
  }
  return { name: packageRecord.name, version: packageRecord.version };
}

function assertIdentity(label: string, expected: string, observed: string): void {
  if (observed !== expected) {
    throw new Error(
      `Release identity mismatch for ${label}: expected ${JSON.stringify(expected)}, ` +
      `observed ${JSON.stringify(observed)}.`
    );
  }
}

export async function verifyReleaseIdentity(
  options: ReleaseIdentityOptions,
  dependencies: ReleaseIdentityDependencies = defaultDependencies
): Promise<ReleaseIdentityResult> {
  const packageJsonPath = path.join(options.packageRoot, 'package.json');
  const packageLockPath = path.join(options.packageRoot, 'package-lock.json');
  const packageJson = packageIdentity(await dependencies.readJson(packageJsonPath), packageJsonPath);
  const packageLockValue = await dependencies.readJson(packageLockPath);
  const packageLock = packageIdentity(packageLockValue, packageLockPath);
  const packageLockRecord = record(packageLockValue, packageLockPath);
  const lockPackages = record(packageLockRecord.packages, `${packageLockPath} packages`);
  const lockRoot = packageIdentity(lockPackages[''], `${packageLockPath} packages[""]`);

  assertIdentity('package-lock.json name', packageJson.name, packageLock.name);
  assertIdentity('package-lock.json version', packageJson.version, packageLock.version);
  assertIdentity('package-lock.json root package name', packageJson.name, lockRoot.name);
  assertIdentity('package-lock.json root package version', packageJson.version, lockRoot.version);

  const expectedTag = `v${packageJson.version}`;
  if (options.releaseTag !== undefined) {
    assertIdentity('Git release tag', expectedTag, options.releaseTag);
  }

  return {
    ...packageJson,
    expectedTag,
    ...(options.releaseTag === undefined ? {} : { releaseTag: options.releaseTag })
  };
}

const defaultDependencies: ReleaseIdentityDependencies = {
  readJson: async (filePath) => JSON.parse(await readFile(filePath, 'utf8')) as unknown
};