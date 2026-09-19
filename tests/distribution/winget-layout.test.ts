import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWinGetPortableLayout } from '../../src/adapters/distribution/winget-adapter.js';
import { inspectNativeArchive } from '../../src/adapters/distribution/native-archive.js';
import { readTree, signedFixture, tarArchive, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

const archiveRoot = 'liftoff-v0.13.0-win32-x64';
const entrypoint = 'bin/liftoff.exe';
const layout = {
  InstallerType: 'zip', NestedInstallerType: 'portable',
  NestedInstallerFiles: [{ RelativeFilePath: `${archiveRoot}/${entrypoint}`, PortableCommandAlias: 'liftoff' }],
  InstallLocation: 'C:\\Users\\Developer\\WinGet\\Packages\\Liftoff',
  LauncherPath: 'C:\\Users\\Developer\\WinGet\\Links\\liftoff.exe'
};

describe('exact WinGet ZIP portable layout', () => {
  it('keeps the manager install location separate from the signed archive bundle root', () => {
    const parsed = resolveWinGetPortableLayout(layout, archiveRoot, entrypoint);
    expect(parsed).toEqual({
      installLocation: layout.InstallLocation,
      bundleRoot: path.win32.join(layout.InstallLocation, archiveRoot),
      launcherPath: layout.LauncherPath
    });
  });

  it('supports a rootless ZIP and literal Windows nested separators without guessing another bundle', () => {
    expect(resolveWinGetPortableLayout({
      ...layout, NestedInstallerFiles: [{ RelativeFilePath: 'bin\\liftoff.exe' }]
    }, '', entrypoint).bundleRoot).toBe(layout.InstallLocation);
  });

  it.each([
    { InstallerType: 'portable' },
    { NestedInstallerType: 'exe' },
    { NestedInstallerFiles: [] },
    { NestedInstallerFiles: [{ RelativeFilePath: `${archiveRoot}/${entrypoint}` }, { RelativeFilePath: 'other.exe' }] },
    { NestedInstallerFiles: [{ RelativeFilePath: `other-bundle/${entrypoint}` }] },
    { NestedInstallerFiles: [{ RelativeFilePath: `../${archiveRoot}/${entrypoint}` }] },
    { NestedInstallerFiles: [{ RelativeFilePath: `${archiveRoot}/bin/liftoff.cmd` }] },
    { NestedInstallerFiles: [{ RelativeFilePath: `${archiveRoot}/${entrypoint}`, PortableCommandAlias: 'another-command' }] },
    { LauncherPath: 'C:\\Users\\Developer\\WinGet\\Links\\liftoff.cmd' },
    { InstallLocation: 'relative\\installation' },
    { InstallLocation: 'C:\\Users\\Developer\\..\\another-installation' },
    { InstallLocation: '\\\\?\\C:\\installation' }
  ])('rejects an unbound, unsafe, or old-wrapper layout %#', (patch) => {
    expect(() => resolveWinGetPortableLayout({ ...layout, ...patch }, archiveRoot, entrypoint)).toThrow();
  });

  it('derives archiveRoot from actual final archive entries rather than a manager path claim', async () => {
    const value = await signedFixture('archive-root');
    fixtures.push(value);
    const files = await readTree(value.candidate);
    const prefixed = tarArchive(files.map((file) => ({ ...file, path: `actual-bundle/${file.path}` })));
    const inspected = inspectNativeArchive(prefixed, value.provenance, 'tar.gz');
    expect(inspected.archiveRoot).toBe('actual-bundle');
    expect(inspected.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(() => resolveWinGetPortableLayout(layout, inspected.archiveRoot, entrypoint)).toThrow(/signed archive root/);
  });
});
