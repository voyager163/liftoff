import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { HomebrewAdapter } from '../../src/adapters/distribution/homebrew-adapter.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { nativeTargetFloors } from '../../src/domain/distribution/contracts.js';
import { sha, quote, signedFixture, writeFixtureFile, type SignedFixture, type SignedFixtureOptions } from './native-fixture.js';

export function signedHomebrewFixture(name: string, options: Omit<SignedFixtureOptions, 'host'> = {}) {
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Unsupported source-fixture architecture.');
  return signedFixture(name, {
    ...options,
    host: {
      os: 'darwin', arch: process.arch, kernelRelease: nativeTargetFloors.darwin.minimumDarwinRelease,
      darwinRelease: nativeTargetFloors.darwin.minimumDarwinRelease, hostVersion: nativeTargetFloors.darwin.minimumHostVersion
    }
  });
}

export async function homebrewFixture(value: SignedFixture, installEffects = true, prefix = value.prefix) {
  const packageId = 'voyager163/liftoff/liftoff';
  const sourceId = 'voyager163/liftoff';
  const sourceUrl = 'https://github.com/voyager163/homebrew-liftoff';
  const launcherPath = path.join(prefix, 'bin', 'liftoff');
  const tool = path.join(prefix, 'bin', 'brew');
  const sourceRoot = path.join(prefix, 'registered tap');
  const caskRoot = path.join(prefix, 'Caskroom', 'liftoff');
  const bundleName = `liftoff-v0.13.0-${value.provenance.target}`;
  const binary = `${bundleName}/bin/liftoff`;
  const targetRoot = path.join(caskRoot, '0.13.0', bundleName);
  const metadata = path.join(caskRoot, '.metadata', '0.13.0', '20260915000000', 'Casks', 'liftoff.json');
  const payload = value.manifest.targets[value.provenance.target];
  const definition = `cask "liftoff" do\n  version "0.13.0"\n  sha256 "${payload.checksumSha256}"\n  url "${payload.archiveUrl}"\n  binary "${binary}"\nend\n`;
  await writeFixtureFile(path.join(sourceRoot, '.git', 'config'), `[remote "origin"]\n  url = ${sourceUrl}\n`);
  const definitionPath = path.join(sourceRoot, 'Casks', 'liftoff.rb');
  await writeFixtureFile(definitionPath, definition);
  const cask = {
    token: 'liftoff', full_token: packageId, tap: sourceId, version: '0.13.0', installed: null,
    url: payload.archiveUrl, sha256: payload.checksumSha256, artifacts: [{ binary: [binary] }], depends_on: {}
  };
  const infoPath = path.join(value.home, 'manager observations', 'cask-info.json');
  const installedInfo = path.join(value.home, 'manager observations', 'installed-info.json');
  const installedRecord = path.join(value.home, 'manager observations', 'installed-cask.json');
  const tapPath = path.join(value.home, 'manager observations', 'tap.json');
  await writeFixtureFile(infoPath, JSON.stringify({ casks: [cask], formulae: [] }));
  await writeFixtureFile(installedInfo, JSON.stringify({ casks: [{ ...cask, installed: '0.13.0' }], formulae: [] }));
  await writeFixtureFile(installedRecord, JSON.stringify({ ...cask, installed: '0.13.0' }));
  await writeFixtureFile(tapPath, JSON.stringify([{ name: sourceId, path: sourceRoot, remote: sourceUrl, installed: true }]));
  await writeFixtureFile(tool, `#!/bin/sh
case "$1" in
  --prefix) printf '%s\\n' ${quote(prefix)};;
  --caskroom) printf '%s\\n' ${quote(caskRoot)};;
  info) /bin/cat ${quote(infoPath)};;
  tap-info) /bin/cat ${quote(tapPath)};;
  install|upgrade)
    ${installEffects ? `/bin/test ! -e ${quote(targetRoot)} || exit 73
    /bin/mkdir -p ${quote(path.dirname(targetRoot))} ${quote(path.dirname(metadata))}
    /bin/cp -R ${quote(value.candidate)} ${quote(targetRoot)} || exit 74
    /bin/cp ${quote(installedRecord)} ${quote(metadata)}
    /bin/cp ${quote(installedInfo)} ${quote(infoPath)}
    /bin/ln -s ${quote(path.join(targetRoot, 'bin', 'liftoff'))} ${quote(launcherPath)}` : 'exit 0'}
    ;;
  *) exit 64;;
esac
`, 0o755);
  const provenance = {
    ...value.provenance, channelDefinitions: [{ owner: 'homebrew-cask' as const, packageId, sourceId, sha256: sha(definition) }]
  };
  await value.resignProvenance(provenance);
  const trust = {
    ...value.trust, channels: [...value.trust.channels, { owner: 'homebrew-cask' as const, packageId, sourceId, sourceUrl }]
  };
  const admission = new NativeAdmission({
    releaseClient: new NativeReleaseClient({ trust, source: value.source }),
    runner: value.runner, env: value.env, cwd: value.project, host: value.admission.host
  });
  const adapter = new HomebrewAdapter({ admission, runner: value.runner, env: value.env, cwd: value.project, executable: tool });
  const detector = new InstallationDetector({
    admission, runner: value.runner, env: value.env, cwd: value.project, entrypoint: path.join(value.candidate, 'dist', 'cli.js'),
    npmAdapter: value.npmAdapter, receiptStore: value.store, ownerAdapters: [adapter]
  });
  return { adapter, detector, admission, definitionPath, infoPath, tapPath, targetRoot, launcherPath, packageId, sourceId, sourceUrl,
    rewriteCask: (patch: object) => writeFile(infoPath, JSON.stringify({ casks: [{ ...cask, ...patch }], formulae: [] })) };
}
