import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNativeHost, atLeastVersion } from '../distribution/native/host.mjs';
import { assertLinuxRuntimeLibraries, bundleFile, bundleInventory, nativeArchiveTool, nativeRuntimeInput, readBundleFile } from '../scripts/native-bundle-contract.mjs';
import { nativeMaterials, nativePackageDefinitions, assertNativePublicationEvidence, verifyNativeEvidenceSignature, verifyNativeArchive } from '../scripts/native-release.mjs';
import { parse } from 'yaml';
import { pathToFileURL } from 'node:url';
import { installOwnedBundle, inspectOwnedInstallation, recoverOwnedInstallation } from '../scripts/native-install.mjs';
import inputs from '../distribution/native/inputs.json';
import policy from '../distribution/native/release-policy.json';
import { assertNativePackageReport, nativePackageCommonCases, nativePackagePlatformCases } from '../scripts/native-package-report.mjs';

const roots: string[] = [];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff native qualification ')));
  roots.push(root);
  return root;
}
const mac = { platform: 'darwin', architecture: 'arm64', nativeArchitecture: 'arm64',
  runtimeVersion: '24.21.0', osVersion: '13.5', appleSilicon: '1', translated: '0' };
const linux = { platform: 'linux', architecture: 'x64', nativeArchitecture: 'x86_64',
  runtimeVersion: '24.21.0', osVersion: '4.18.0', glibcVersion: '2.28' };
const windows = { platform: 'win32', architecture: 'x64', nativeArchitecture: 'AMD64',
  runtimeVersion: '24.21.0', osVersion: '10.0.14393' };

describe('native runtime floors and unsupported-host admission', () => {
  it('records upstream floors independently from unqualified public support', () => {
    for (const host of [mac, linux, windows, { ...linux, architecture: 'arm64', nativeArchitecture: 'aarch64' }]) {
      expect(assertNativeHost(host).floor.publicDistributionQualified).toBe(false);
      expect(() => assertNativeHost(host, { publicInstallation: true })).toThrow('minimum host');
    }
  });
  it.each([
    { ...mac, architecture: 'x64' }, { ...mac, translated: '1' },
    { ...mac, nativeArchitecture: 'x86_64' }, { ...mac, appleSilicon: '0' }, { ...mac, osVersion: '13.4' },
    { ...mac, translated: 'unknown' }, { ...mac, runtimeVersion: '24.20.0' },
    { ...linux, glibcVersion: null }, { ...linux, glibcVersion: '2.27' }, { ...linux, osVersion: '4.17' },
    { ...linux, nativeArchitecture: 'aarch64' }, { ...linux, architecture: 'ia32' },
    { ...windows, nativeArchitecture: 'ARM64' }, { ...windows, osVersion: '6.3.9600' }
  ])('rejects an unqualified observation before effects: %j', host => {
    expect(() => assertNativeHost(host)).toThrow();
  });
  it('compares versions numerically and refuses missing/malformed facts', () => {
    expect(atLeastVersion('13.10', '13.5')).toBe(true);
    expect(atLeastVersion('2.28', '2.28.1')).toBe(false);
    expect(atLeastVersion('6.8.0-1030-azure', '4.18')).toBe(true);
    for (const version of ['', 'unknown', 'v13.5', '13']) expect(() => atLeastVersion(version, '13.5')).toThrow();
  });
  it('selects exactly one official pinned runtime without an alternate download fallback', () => {
    for (const host of [mac, linux, windows, { ...linux, architecture: 'arm64' }]) {
      const selected = nativeRuntimeInput(inputs, host);
      expect(selected.url).toContain('https://nodejs.org/dist/v24.21.0/');
      expect(selected.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(selected.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(() => nativeRuntimeInput(inputs, { platform: 'darwin', architecture: 'x64' })).toThrow();
    expect(() => nativeRuntimeInput({ ...inputs, additionalRuntimes: [inputs.runtime] }, mac)).toThrow();
  });
  it('checks Linux ELF requirements against declared upstream floors and rejects missing/non-system libraries', () => {
    const linked = 'linux-vdso.so.1 (0xabcdef)\nlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0xabcdef)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0xabcdef)\n/lib64/ld-linux-x86-64.so.2 (0xabcdef)';
    const versions = 'Name: GLIBC_2.28 Flags: none\nName: GLIBCXX_3.4.25 Flags: none';
    const floor = { minimumGlibc: '2.28', minimumGlibcxx: '3.4.25' };
    expect(assertLinuxRuntimeLibraries(linked, versions, floor).linked).toHaveLength(3);
    for (const changed of [linked.replace('/lib/x86_64-linux-gnu/libc', '/opt/foreign/libc'),
      linked.replace('/lib/x86_64-linux-gnu/libc.so.6 (0xabcdef)', 'not found'), '']) {
      expect(() => assertLinuxRuntimeLibraries(changed, versions, floor)).toThrow();
    }
    for (const changed of ['', versions.replace('2.28', '2.29'), versions.replace('3.4.25', '3.4.26')]) {
      expect(() => assertLinuxRuntimeLibraries(linked, changed, floor)).toThrow();
    }
  });
  it('uses the native Windows archive tool rather than a PATH-selected GNU tar interpreting drive letters as remote hosts', () => {
    expect(nativeArchiveTool('win32', 'C:\\Windows')).toBe('C:\\Windows\\System32\\tar.exe');
    expect(nativeArchiveTool('linux')).toBe('/usr/bin/tar');
    for (const root of ['', 'Windows', 'C:Windows', '\\\\server\\Windows', 'C:\\Windows\\..\\foreign']) {
      expect(() => nativeArchiveTool('win32', root)).toThrow();
    }
  });
  it('parses the same bounded regular-file bytes whose digest was reviewed', async () => {
    const root = await fixture(), file = path.join(root, 'selected.json');
    const bytes = Buffer.from('{"selected":true}');
    await writeFile(file, bytes);
    expect(await readBundleFile(file)).toEqual({ identity: await bundleFile(file), content: bytes });
    await expect(readBundleFile(file, 1)).rejects.toThrow('byte limit');
    await link(file, path.join(root, 'alias.json'));
    await expect(readBundleFile(path.join(root, 'alias.json'))).rejects.toThrow('regular file');
  });
});

describe('native exact-artifact and signing gates (synthetic contract data, not qualification)', () => {
  const record = {
    repository: 'voyager163/liftoff', commit: '1'.repeat(40), version: '1.2.3', target: 'darwin-arm64',
    manifestSha256: '2'.repeat(64), inventorySha256: '3'.repeat(64),
    files: [{ filename: 'liftoff-1.2.3-darwin-arm64.tar.gz', sha256: '4'.repeat(64) }]
  };
  const approved = { ...policy, approvedSigningKeySha256: '5'.repeat(64),
    homebrew: { cask: 'synthetic/fixture/liftoff', sourceRepository: 'synthetic/fixture', developerTeamId: 'ABCDEFGHIJ' },
    winget: { packageIdentifier: 'Synthetic.Liftoff', publisher: 'Synthetic', certificateSha256: '6'.repeat(64), installerAppId: 'synthetic-fixture' },
    linux: { archiveSigningKeySha256: '7'.repeat(64) } };
  const evidence = { ...record, platformSigningIdentity: 'ABCDEFGHIJ',
    channel: { id: approved.homebrew.cask, source: approved.homebrew.sourceRepository },
    qualification: { minimumHost: true, installerOwnership: true, signing: true, notarization: true,
      packageNamespace: true, hclSourceCorrespondence: true },
    evidenceDigests: Object.fromEntries(['minimumHost', 'installerOwnership', 'signing', 'notarization',
      'packageNamespace', 'hclSourceCorrespondence'].map(name => [name, '8'.repeat(64)])) };
  it('blocks production with the real unconfigured signing policy', () => {
    expect(() => assertNativePublicationEvidence(record, evidence)).toThrow('No approved');
    expect(policy.homebrew.cask).toBeNull();
    expect(policy.winget.packageIdentifier).toBeNull();
  });
  it('imports inert shared admission without a builder checkout, global tools or release environment', async () => {
    const cwd = await fixture();
    const url = pathToFileURL(path.resolve('distribution/native/native-release-admission.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const admission = await import(${JSON.stringify(url)}); console.log(JSON.stringify(Object.keys(admission).sort()));`],
    { cwd, env: { PATH: '', NODE_OPTIONS: '', NODE_PATH: '' }, shell: false, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['assertNativePublicationEvidence', 'verifyNativeEvidenceSignature']);
  });
  it('binds synthetic evidence to exact source, version, every sidecar and approved channel', () => {
    expect(assertNativePublicationEvidence(record, evidence, approved)).toEqual(evidence);
    for (const changed of [
      { ...evidence, commit: '9'.repeat(40) }, { ...evidence, version: '9.0.0' },
      { ...evidence, files: [] }, { ...evidence, manifestSha256: '9'.repeat(64) },
      { ...evidence, channel: { ...evidence.channel, id: 'foreign/tap/cask' } },
      { ...evidence, platformSigningIdentity: 'FOREIGNKEY' }
    ]) expect(() => assertNativePublicationEvidence(record, changed, approved)).toThrow();
    for (const name of Object.keys(evidence.qualification)) {
      expect(() => assertNativePublicationEvidence(record,
        { ...evidence, qualification: { ...evidence.qualification, [name]: false } }, approved)).toThrow();
      expect(() => assertNativePublicationEvidence(record,
        { ...evidence, evidenceDigests: { ...evidence.evidenceDigests, [name]: null } }, approved)).toThrow();
    }
  });
  it('requires exact Windows/Linux signer and package identities, without fabricating IDs', () => {
    const win = { ...record, target: 'win32-x64' };
    const winEvidence = { ...evidence, target: win.target, channel: { id: approved.winget.packageIdentifier },
      platformSigningIdentity: approved.winget.certificateSha256 };
    expect(assertNativePublicationEvidence(win, winEvidence, approved)).toBe(winEvidence);
    expect(() => assertNativePublicationEvidence(win, winEvidence,
      { ...approved, winget: { ...approved.winget, packageIdentifier: null } })).toThrow('WinGet');
    const lin = { ...record, target: 'linux-arm64' };
    const linEvidence = { ...evidence, target: lin.target, platformSigningIdentity: approved.linux.archiveSigningKeySha256 };
    expect(assertNativePublicationEvidence(lin, linEvidence, approved)).toBe(linEvidence);
    expect(() => assertNativePublicationEvidence(lin, linEvidence,
      { ...approved, linux: { archiveSigningKeySha256: null } })).toThrow('Linux');
  });
  it('authenticates exact evidence bytes using a separately approved Ed25519 principal', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    const fingerprint = hash(publicKey.export({ type: 'spki', format: 'der' }));
    const bytes = Buffer.from(JSON.stringify(evidence));
    const signature = sign(null, bytes, privateKey);
    expect(verifyNativeEvidenceSignature(bytes, signature, pub, fingerprint)).toEqual(evidence);
    expect(() => verifyNativeEvidenceSignature(Buffer.from('{}'), signature, pub, fingerprint)).toThrow('signature');
    expect(() => verifyNativeEvidenceSignature(bytes, signature, pub, '0'.repeat(64))).toThrow('principal');
    expect(() => verifyNativeEvidenceSignature(bytes, Buffer.alloc(64), pub, fingerprint)).toThrow('signature');
    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(() => verifyNativeEvidenceSignature(bytes, signature, foreign, fingerprint)).toThrow('Ed25519');
  });
  it('renders channel definitions only from approved exact evidence, never the real unconfigured namespace', () => {
    const artifactUrl = `https://github.com/${record.repository}/releases/download/v${record.version}/${record.files[0].filename}`;
    const macEvidence = { ...evidence, artifactUrl };
    expect(() => nativePackageDefinitions(record, macEvidence)).toThrow('No approved');
    const cask = nativePackageDefinitions(record, macEvidence, approved)['liftoff.rb'];
    expect(cask).toContain(`sha256 "${record.files[0].sha256}"`);
    expect(cask).toContain('depends_on arch: :arm64');
    expect(cask).toContain('in_rosetta2?');
    expect(() => nativePackageDefinitions(record, { ...macEvidence, artifactUrl: 'https://foreign.example/fixture' }, approved)).toThrow('exact qualified');
    const win = { ...record, target: 'win32-x64' };
    const windowsInstaller = { filename: 'liftoff-1.2.3-win32-x64-setup.exe', sha256: '9'.repeat(64), bytes: 100,
      appId: approved.winget.installerAppId, publisher: approved.winget.publisher,
      certificateSha256: approved.winget.certificateSha256, commandVerified: true,
      url: `https://github.com/${record.repository}/releases/download/v1.2.3/liftoff-1.2.3-win32-x64-setup.exe` };
    const winEvidence = { ...evidence, target: win.target, channel: { id: approved.winget.packageIdentifier },
      platformSigningIdentity: approved.winget.certificateSha256, windowsInstaller };
    const definitions = nativePackageDefinitions(win, winEvidence, approved);
    expect(parse(definitions['Synthetic.Liftoff.installer.yaml']).Installers[0].InstallerSha256).toBe(windowsInstaller.sha256.toUpperCase());
    for (const changed of [{ ...windowsInstaller, commandVerified: false },
      { ...windowsInstaller, appId: 'foreign' }, { ...windowsInstaller, url: 'https://foreign.example/setup.exe' }]) {
      expect(() => nativePackageDefinitions(win, { ...winEvidence, windowsInstaller: changed }, approved)).toThrow();
    }
  });
  it('emits dependency notices/SBOM and unsigned provenance without erasing modified HCL disclosure', () => {
    const manifest = {
      package: { name: '@msn-control/liftoff', version: '1.2.3' },
      runtime: inputs.runtime, platform: { platform: 'darwin', architecture: 'arm64' },
      source: { repository: 'voyager163/liftoff', commit: record.commit, builderInputs: [] },
      inventory: { sha256: record.inventorySha256 }, hclSource: inputs.hcl,
      dependencies: [{ name: '@scope/fixture', path: 'node_modules/@scope/fixture', version: '1.0.0', license: 'MIT',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, notices: [{ path: 'application/node_modules/@scope/fixture/LICENSE' }] }],
      supplementalNotices: []
    };
    const materials = nativeMaterials(manifest, { filename: 'fixture.tar.gz', sha256: '1'.repeat(64), runId: null });
    expect(materials.sbom.components).toHaveLength(3);
    expect(materials.sbom.components[2].purl).toBe('pkg:npm/%40scope/fixture@1.0.0');
    expect(materials.provenance.predicate.buildDefinition.internalParameters.releaseReady).toBe(false);
    expect(materials.notices).toContain('modified source');
    expect(materials.notices).toContain('not signed release attestations');
  });
  it('rejects a changed exact artifact handoff before trusting its JSON', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'native-release.json'), '{}');
    await expect(verifyNativeArchive(root, '0'.repeat(64), record.commit)).rejects.toThrow('manifest changed');
    await expect(verifyNativeArchive(root, '', record.commit)).rejects.toThrow('qualification');
  });
});

describe('installed native report admission (synthetic report shapes)', () => {
  function report(platform: string) {
    const applicable = [...nativePackageCommonCases, ...nativePackagePlatformCases[platform]];
    return { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{
      name: '/fixture/tests/native-package-installed.test.ts',
      assertionResults: [...nativePackageCommonCases, ...Object.values(nativePackagePlatformCases).flat()]
        .map(title => ({ title, status: applicable.includes(title) ? 'passed' : 'skipped' }))
    }] };
  }
  it.each(['linux', 'darwin', 'win32'])('requires every applicable actual installed case on %s', platform => {
    expect(assertNativePackageReport(report(platform), platform).passed).toBe(
      nativePackageCommonCases.length + nativePackagePlatformCases[platform].length);
  });
  it.each(['failed', 'missing', 'duplicate', 'unrun-applicable', 'wrong-host-skip', 'missing-suite', 'duplicate-suite'])(
    'refuses incomplete native package evidence: %s', fault => {
      const selected = report('win32'), suite = selected.testResults[0];
      if (fault === 'failed') selected.numFailedTests++;
      if (fault === 'missing') suite.assertionResults.pop();
      if (fault === 'duplicate') suite.assertionResults.push(suite.assertionResults[0]);
      if (fault === 'unrun-applicable') suite.assertionResults[0].status = 'skipped';
      if (fault === 'wrong-host-skip') suite.assertionResults.find(test => test.status === 'skipped')!.status = 'passed';
      if (fault === 'missing-suite') selected.testResults = [];
      if (fault === 'duplicate-suite') selected.testResults.push(suite);
      expect(() => assertNativePackageReport(selected, 'win32')).toThrow();
    });
});

describe.skipIf(process.platform === 'win32')('user-local owned installer transactions (synthetic files)', () => {
  async function setup(version = '1.2.3') {
    const root = await fixture();
    const source = path.join(root, 'source');
    const prefix = path.join(root, 'private-prefix');
    await mkdir(prefix, { mode: 0o700 });
    for (const directory of ['bin', 'runtime']) await mkdir(path.join(source, directory), { recursive: true });
    await writeFile(path.join(source, 'bin/liftoff'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(source, 'runtime/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const manifest = {
      schemaVersion: 1, kind: 'liftoff-native-development-bundle',
      package: { name: '@msn-control/liftoff', version }, platform: { platform: 'linux', architecture: 'x64' },
      launcher: 'bin/liftoff', runtime: { executable: 'runtime/node' }, source: { commit: '1'.repeat(40) },
      releaseReady: false, inventory: await bundleInventory(source)
    };
    await writeFile(path.join(source, 'bundle.json'), JSON.stringify(manifest));
    const expectedManifestSha256 = (await bundleFile(path.join(source, 'bundle.json'))).sha256;
    return { source, prefix, expectedManifestSha256, development: true, expectedCurrent: null,
      admitHost: () => assertNativeHost(linux) };
  }
  it('admits the host before acquiring a lock or changing a prefix', async () => {
    const options = await setup(), before = await bundleInventory(options.prefix);
    await expect(installOwnedBundle({ ...options, admitHost: () => assertNativeHost({ ...linux, glibcVersion: null }) }))
      .rejects.toThrow('musl');
    expect(await bundleInventory(options.prefix)).toEqual(before);
  });
  it('refuses unsigned public installation and a changed approved manifest before writes', async () => {
    const options = await setup(), before = await bundleInventory(options.prefix);
    await expect(installOwnedBundle({ ...options, development: false })).rejects.toThrow('public installation');
    await expect(installOwnedBundle({ ...options, expectedManifestSha256: '0'.repeat(64) })).rejects.toThrow('manifest changed');
    expect(await bundleInventory(options.prefix)).toEqual(before);
  });
  it('switches a verified immutable version atomically and retains previous recoverable material', async () => {
    const options = await setup();
    const first = await installOwnedBundle(options);
    expect(await inspectOwnedInstallation(options.prefix)).toBe(first.current);
    expect(await readlink(path.join(options.prefix, 'bin/liftoff'))).toBe('../current/bin/liftoff');
    expect(first.receipt).toMatchObject({ owner: 'liftoff-native', manifestSha256: options.expectedManifestSha256, releaseReady: false });
    const next = await setup('1.2.4');
    const second = await installOwnedBundle({ ...next, prefix: options.prefix, expectedCurrent: first.current });
    expect(await inspectOwnedInstallation(options.prefix)).toBe(second.current);
    expect((await lstat(path.join(options.prefix, first.current))).isDirectory()).toBe(true);
    expect((await installOwnedBundle({ ...next, prefix: options.prefix, expectedCurrent: second.current })).status).toBe('already-installed');
  });
  it('preserves foreign launcher files, unsafe prefix links and changed existing installations', async () => {
    const options = await setup();
    await mkdir(path.join(options.prefix, 'bin'));
    await writeFile(path.join(options.prefix, 'bin/liftoff'), 'foreign');
    await expect(installOwnedBundle(options)).rejects.toThrow('attributable');
    expect(await readFile(path.join(options.prefix, 'bin/liftoff'), 'utf8')).toBe('foreign');
    const link = `${options.prefix}-alias`;
    await symlink(options.prefix, link);
    await expect(installOwnedBundle({ ...options, prefix: link })).rejects.toThrow('real directory');
    const clean = await setup();
    const first = await installOwnedBundle(clean);
    await writeFile(path.join(clean.prefix, first.current, 'bin/liftoff'), 'changed');
    const next = await setup('1.2.4');
    await expect(installOwnedBundle({ ...next, prefix: clean.prefix, expectedCurrent: first.current })).rejects.toThrow('inventory changed');
  });
  it.each(['before-switch', 'after-switch'])('retains selected recovery after interruption %s', async interruptAt => {
    const options = await setup();
    const first = await installOwnedBundle(options);
    const next = await setup('1.2.4');
    await expect(installOwnedBundle({ ...next, prefix: options.prefix, expectedCurrent: first.current, interruptAt }))
      .rejects.toThrow('Interrupted');
    const journal = path.join(options.prefix, '.native-install-transaction.json');
    const expectedJournalSha256 = (await bundleFile(journal)).sha256;
    await expect(installOwnedBundle({ ...next, prefix: options.prefix, expectedCurrent: first.current })).rejects.toThrow('recovery');
    const recovery = await recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256 });
    expect(recovery.status).toBe('recovered');
    expect(await inspectOwnedInstallation(options.prefix)).toBe(first.current);
    expect(await readFile(path.join(options.prefix, first.current, 'bin/liftoff'), 'utf8')).toContain('exit 0');
  });
  it('refuses stale recovery and concurrent edits rather than overwriting them', async () => {
    const options = await setup();
    await expect(installOwnedBundle({ ...options, interruptAt: 'after-switch' })).rejects.toThrow('Interrupted');
    const journal = path.join(options.prefix, '.native-install-transaction.json');
    const expectedJournalSha256 = (await bundleFile(journal)).sha256;
    await expect(recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256: '0'.repeat(64) })).rejects.toThrow('journal changed');
    const current = await readlink(path.join(options.prefix, 'current'));
    await writeFile(path.join(options.prefix, current, 'bin/liftoff'), 'concurrent user edit');
    await expect(recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256 })).rejects.toThrow('inventory changed');
    expect(await readFile(path.join(options.prefix, current, 'bin/liftoff'), 'utf8')).toBe('concurrent user edit');
    expect(await readFile(journal)).not.toHaveLength(0);
  });
  it('blocks non-private and concurrently locked prefixes without stealing the lock', async () => {
    const options = await setup();
    await chmod(options.prefix, 0o755);
    await expect(installOwnedBundle(options)).rejects.toThrow('private');
    await chmod(options.prefix, 0o700);
    await mkdir(path.join(options.prefix, '.native-install-lock'));
    await expect(installOwnedBundle(options)).rejects.toThrow('locked');
    expect((await lstat(path.join(options.prefix, '.native-install-lock'))).isDirectory()).toBe(true);
  });
  it.each(['before-launcher', 'after-launcher', 'after-switch'])('recovers first-install interruption %s and reuses only verified retained material', async interruptAt => {
    const options = await setup();
    await expect(installOwnedBundle({ ...options, interruptAt })).rejects.toThrow('Interrupted');
    const expectedJournalSha256 = (await bundleFile(path.join(options.prefix, '.native-install-transaction.json'))).sha256;
    const recovery = await recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256 });
    expect(await inspectOwnedInstallation(options.prefix)).toBeNull();
    expect(recovery.retained).toHaveLength(1);
    expect((await installOwnedBundle(options)).status).toBe('installed');
  });
  it('releases only an exact selected dead-process lock and never an active or unknown owner', async () => {
    const options = await setup();
    await expect(installOwnedBundle({ ...options, interruptAt: 'after-launcher' })).rejects.toThrow('Interrupted');
    const expectedJournalSha256 = (await bundleFile(path.join(options.prefix, '.native-install-transaction.json'))).sha256;
    const lock = path.join(options.prefix, '.native-install-lock');
    await mkdir(lock, { mode: 0o700 });
    const ownerPath = path.join(lock, 'owner.json');
    const owner = { schemaVersion: 1, kind: 'liftoff-native-install-lock', prefixSha256: hash(options.prefix),
      nonce: randomUUID(), pid: process.pid };
    await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    const recover = async (expectedStaleLockSha256: string) =>
      recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256, expectedStaleLockSha256 });
    await expect(recover('0'.repeat(64))).rejects.toThrow('owner changed');
    await expect(recover((await bundleFile(ownerPath)).sha256)).rejects.toThrow('active or reused');
    const exited = spawnSync(process.execPath, ['-e', ''], { shell: false });
    expect(exited.status).toBe(0);
    await writeFile(ownerPath, JSON.stringify({ ...owner, pid: exited.pid }));
    await writeFile(path.join(lock, 'unknown'), 'retain');
    await expect(recover((await bundleFile(ownerPath)).sha256)).rejects.toThrow('Unknown lock material');
    await rm(path.join(lock, 'unknown'));
    expect((await recover((await bundleFile(ownerPath)).sha256)).status).toBe('recovered');
    expect(await inspectOwnedInstallation(options.prefix)).toBeNull();
  });
  it('retains a concurrently replaced orphan launcher during selected recovery', async () => {
    const options = await setup();
    await expect(installOwnedBundle({ ...options, interruptAt: 'after-launcher' })).rejects.toThrow('Interrupted');
    const expectedJournalSha256 = (await bundleFile(path.join(options.prefix, '.native-install-transaction.json'))).sha256;
    await rm(path.join(options.prefix, 'bin/liftoff'));
    await writeFile(path.join(options.prefix, 'bin/liftoff'), 'concurrent user command');
    await expect(recoverOwnedInstallation({ prefix: options.prefix, expectedJournalSha256 })).rejects.toThrow('unrelated orphan');
    expect(await readFile(path.join(options.prefix, 'bin/liftoff'), 'utf8')).toBe('concurrent user command');
  });
});
