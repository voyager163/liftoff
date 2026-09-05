import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyReleaseIdentity } from '../src/release-identity.js';

const packageName = '@msn-control/liftoff';
const packageVersion = '0.4.0';

interface IdentityOverrides {
  packageName?: string;
  packageVersion?: string;
  lockName?: string;
  lockVersion?: string;
  lockRootName?: string;
  lockRootVersion?: string;
}

async function withReleaseRoot<T>(
  overrides: IdentityOverrides,
  callback: (packageRoot: string) => Promise<T>
): Promise<T> {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-release-identity-'));
  const observedName = overrides.packageName ?? packageName;
  const observedVersion = overrides.packageVersion ?? packageVersion;
  await Promise.all([
    writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: observedName,
      version: observedVersion
    })),
    writeFile(path.join(packageRoot, 'package-lock.json'), JSON.stringify({
      name: overrides.lockName ?? observedName,
      version: overrides.lockVersion ?? observedVersion,
      lockfileVersion: 3,
      packages: {
        '': {
          name: overrides.lockRootName ?? observedName,
          version: overrides.lockRootVersion ?? observedVersion
        }
      }
    }))
  ]);

  try {
    return await callback(packageRoot);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

describe('release identity verifier', () => {
  it('accepts matching package and lockfile metadata', async () => {
    await withReleaseRoot({}, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot })).resolves.toEqual({
        name: packageName,
        version: packageVersion,
        expectedTag: `v${packageVersion}`
      });
    });
  });

  it('rejects a package-name mismatch with expected and observed values', async () => {
    await withReleaseRoot({ lockName: '@other/liftoff' }, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot })).rejects.toThrow(
        'Release identity mismatch for package-lock.json name: expected "@msn-control/liftoff", observed "@other/liftoff".'
      );
    });
  });

  it('rejects a consistently renamed non-canonical package', async () => {
    await withReleaseRoot({ packageName: '@other/liftoff' }, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot })).rejects.toThrow(
        'Release identity mismatch for package.json name: expected "@msn-control/liftoff", observed "@other/liftoff".'
      );
    });
  });

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    'v1.2.3',
    '1.2.3\n',
    '999999999999999999999.0.0',
    '1.9007199254740992.0',
    '1.0.9007199254740992',
    `1.2.3+${'a'.repeat(251)}`,
    'not-a-version'
  ])('rejects invalid npm SemVer %s', async (packageVersion) => {
    await withReleaseRoot({ packageVersion }, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot })).rejects.toThrow(
        `expected valid npm SemVer, observed ${JSON.stringify(packageVersion)}`
      );
    });
  });

  it.each(['1.2.3-beta.1', '1.2.3+build.7', '1.2.3-rc.1+build.7', '9007199254740991.0.0'])(
    'accepts valid npm SemVer %s',
    async (packageVersion) => {
      await withReleaseRoot({ packageVersion }, async (packageRoot) => {
        await expect(verifyReleaseIdentity({ packageRoot })).resolves.toMatchObject({
          name: packageName,
          version: packageVersion
        });
      });
    }
  );

  it('rejects a lockfile-version mismatch with expected and observed values', async () => {
    await withReleaseRoot({ lockVersion: '0.3.4' }, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot })).rejects.toThrow(
        'Release identity mismatch for package-lock.json version: expected "0.4.0", observed "0.3.4".'
      );
    });
  });

  it('accepts a matching release tag', async () => {
    await withReleaseRoot({}, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot, releaseTag: 'v0.4.0' })).resolves.toMatchObject({
        expectedTag: 'v0.4.0',
        releaseTag: 'v0.4.0'
      });
    });
  });

  it('rejects a mismatched release tag with expected and observed values', async () => {
    await withReleaseRoot({}, async (packageRoot) => {
      await expect(verifyReleaseIdentity({ packageRoot, releaseTag: 'v0.3.4' })).rejects.toThrow(
        'Release identity mismatch for Git release tag: expected "v0.4.0", observed "v0.3.4".'
      );
    });
  });

  it('supports a tag-optional local dry run', async () => {
    await withReleaseRoot({}, async (packageRoot) => {
      const result = await verifyReleaseIdentity({ packageRoot });
      expect(result.releaseTag).toBeUndefined();
      expect(result.expectedTag).toBe('v0.4.0');
    });
  });
});