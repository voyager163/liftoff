import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import { defaultSelfUpgradeDependencies } from '../src/adapters/distribution/upgrade-host.js';
import { bundleInventory } from '../scripts/native-bundle-contract.mjs';
import { inspectOwnedInstallation, installOwnedBundle } from '../scripts/native-install.mjs';
import { runSelfUpgrade } from '../src/application/upgrade/self-upgrade.js';
import { cliInstallationLayer } from '../src/application/diagnose/doctor.js';
import { admitNativeStableMaterial, authenticateNativeStableMetadata, lookupNativeStableCandidate } from '../src/adapters/distribution/native-metadata.js';
import { assertCaskOwnership, assertWinGetOwnership, createNativeUpgradePort, nativePolicy } from '../src/adapters/distribution/native.js';
import { SelfUpgradeFailure, selfUpgradeExitCode, selfUpgradeRemedy } from '../src/domain/distribution/liftoff-upgrade.js';
import type { NativeCandidate, NativeInstallation, NativeUpgradePort } from '../src/domain/distribution/native-upgrade.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';
import { nativeInstallation as installation, signedMaterial } from './fixtures/native-stable-material.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function managerObservationFixture(platform: 'darwin' | 'win32') {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\virtual\\fixture-native' : '/virtual/fixture-native';
  const runtime = platform === 'win32' ? 'runtime/node.exe' : 'runtime/node';
  const launcher = platform === 'win32' ? 'bin/liftoff.exe' : 'bin/liftoff';
  const names = [runtime, launcher, 'application/dist/cli.js', 'installation/native-bundle-contract.mjs',
    'installation/native-install.mjs', 'installation/native-release-admission.mjs', 'installation/release-policy.json'];
  const files = new Map(names.map(name => [api.join(root, ...name.split('/')), Buffer.from(`synthetic process-port fixture ${name}`)]));
  const inventory = { sha256: '1'.repeat(64), entries: names.map(name => {
    const content = files.get(api.join(root, ...name.split('/')))!;
    return { path: name, kind: 'file', bytes: content.length, sha256: hash(content), mode: 0o755 };
  }) };
  const manifest = { schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: false,
    package: { name: '@msn-control/liftoff', version: '0.12.3' },
    source: { repository: 'voyager163/liftoff', commit: 'c'.repeat(40) },
    platform: { platform, architecture: platform === 'win32' ? 'x64' : 'arm64' },
    launcher, runtime: { executable: runtime }, inventory };
  files.set(api.join(root, 'bundle.json'), json(manifest));
  const policy = signedMaterial().policy;
  const homebrewPolicy = { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools', developerTeamId: 'ABCDEFGHIJ' };
  const wingetPolicy = { packageIdentifier: 'Fixture.Liftoff', publisher: 'Fixture Publisher',
    certificateSha256: '0'.repeat(64), installerAppId: 'fixture-app' };
  policy.homebrew = homebrewPolicy;
  policy.winget = wingetPolicy;
  const dependencies = { ...defaultSelfUpgradeDependencies(), platform, architecture: manifest.platform.architecture,
    execPath: api.join(root, ...runtime.split('/')), runningExecutable: api.join(root, 'application', 'dist', 'cli.js'),
    resolveLiftoff: async () => api.join(root, ...launcher.split('/')), realpath: async (file: string) => file,
    readJson: async () => policy, readBytes: async (file: string) => {
      const content = files.get(file);
      if (!content) throw new Error('Unknown synthetic fixture file');
      return content;
    },
    runner: { run: async command => ({ command, displayCommand: 'synthetic native inventory port',
      stdout: JSON.stringify(inventory), stderr: '', status: 0, signal: null, timedOut: false }) } satisfies CommandRunner };
  const packageRoot = api.join(root, 'application');
  const cask = { fullToken: homebrewPolicy.cask, sourceRepository: homebrewPolicy.sourceRepository,
    bundleRoot: root, launcher: api.join(root, ...launcher.split('/')), installedVersion: '0.12.3' };
  const winget = { packageIdentifier: wingetPolicy.packageIdentifier, source: 'fixture-source', publisher: wingetPolicy.publisher,
    certificateSha256: wingetPolicy.certificateSha256, appId: wingetPolicy.installerAppId, scope: 'user' as const,
    installLocation: root, launcher: cask.launcher, installedVersion: '0.12.3' };
  return { dependencies, packageRoot, policy, cask, winget };
}

describe('independently signed native candidate admission', () => {
  it('binds an approved signer, source, inventory, qualification, provenance and every deployed asset', async () => {
    const fixture = signedMaterial();
    expect(fixture.policy.approvedSigningKeySha256).not.toBe(fixture.policy.linux.archiveSigningKeySha256);
    expect(await admitNativeStableMaterial(fixture.material, installation, fixture.policy)).toEqual({
      version: '0.13.0', target: 'linux-x64', sourceCommit: 'd'.repeat(40), manifestSha256: 'f'.repeat(64),
      inventorySha256: 'e'.repeat(64), identity: expect.stringMatching(/^[a-f0-9]{64}$/), bundleRoot: fixture.material.bundleRoot,
      archiveSha256: hash(fixture.assets.get('liftoff-0.13.0-linux-x64.tar.gz')!)
    });
  });

  it.each([
    { name: 'missing signature', change: (f: ReturnType<typeof signedMaterial>) => { delete f.material.archiveSignature; } },
    { name: 'missing public key', change: (f: ReturnType<typeof signedMaterial>) => { delete f.material.archivePublicKey; } },
    { name: 'oversized signature', change: (f: ReturnType<typeof signedMaterial>) => { f.material.archiveSignature = Buffer.alloc(65); } },
    { name: 'oversized public key', change: (f: ReturnType<typeof signedMaterial>) => { f.material.archivePublicKey = Buffer.alloc(4097); } },
    { name: 'tampered signature', change: (f: ReturnType<typeof signedMaterial>) => { f.material.archiveSignature![0] ^= 1; } },
    { name: 'qualification key substituted for archive key', change: (f: ReturnType<typeof signedMaterial>) => {
      f.material.archivePublicKey = f.material.publicKey;
    } },
    { name: 'different algorithm even with approved SPKI', change: (f: ReturnType<typeof signedMaterial>) => {
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
      f.policy.linux.archiveSigningKeySha256 = hash(key.export({ type: 'spki', format: 'der' }));
      f.qualification.platformSigningIdentity = f.policy.linux.archiveSigningKeySha256;
      f.material.archivePublicKey = Buffer.from(key.export({ type: 'spki', format: 'pem' }));
      f.resign();
    } }
  ])('refuses $name independently of valid qualification evidence', async ({ change }) => {
    const fixture = signedMaterial();
    change(fixture);
    await expect(authenticateNativeStableMetadata(fixture.material, installation, fixture.policy))
      .resolves.toMatchObject({ record: { target: 'linux-x64' } });
    await expect(admitNativeStableMaterial(fixture.material, installation, fixture.policy))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it('requires the separately qualified Windows installer to be deployed with exact source/publisher/AppId/certificate binding', async () => {
    const fixture = signedMaterial();
    const old = fixture.record.files[0].filename;
    fixture.record.target = 'win32-x64';
    for (const file of fixture.record.files) file.mode = 0o666;
    fixture.record.files[0].filename = 'liftoff-0.13.0-win32-x64.tar.gz';
    fixture.assets.set(fixture.record.files[0].filename, fixture.assets.get(old)!);
    fixture.assets.delete(old);
    const provenance = JSON.parse(fixture.assets.get('provenance.json')!.toString());
    provenance.subject[0].name = fixture.record.files[0].filename;
    provenance.predicate.buildDefinition.externalParameters.target = { platform: 'win32', architecture: 'x64' };
    fixture.assets.set('provenance.json', json(provenance));
    fixture.record.files[2].bytes = fixture.assets.get('provenance.json')!.length;
    fixture.record.files[2].sha256 = hash(fixture.assets.get('provenance.json')!);
    fixture.policy.winget = { packageIdentifier: 'Fixture.Liftoff', publisher: 'Fixture Publisher',
      installerAppId: 'fixture-app', certificateSha256: '0'.repeat(64) };
    const filename = 'liftoff-0.13.0-win32-x64-setup.exe';
    const content = Buffer.from('fixture-only installer evidence, not an executable or Windows qualification');
    fixture.assets.set(filename, content);
    Object.assign(fixture.qualification, fixture.record, { channel: { id: 'Fixture.Liftoff' },
      platformSigningIdentity: fixture.policy.winget.certificateSha256,
      windowsInstaller: { filename, sha256: hash(content), bytes: content.length, appId: 'fixture-app',
        publisher: 'Fixture Publisher', certificateSha256: '0'.repeat(64), commandVerified: true,
        url: `https://github.com/voyager163/liftoff/releases/download/v0.13.0/${filename}` } });
    fixture.resign();
    const owner = { ...installation, target: 'win32-x64', owner: 'winget' as const };
    expect(await admitNativeStableMaterial(fixture.material, owner, fixture.policy)).toMatchObject({
      windowsInstaller: { filename, sha256: hash(content), bytes: content.length }
    });
    fixture.assets.delete(filename);
    await expect(admitNativeStableMaterial(fixture.material, owner, fixture.policy)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    fixture.assets.set(filename, content);
    fixture.record.files[0].mode = 0o644;
    fixture.resign();
    await expect(admitNativeStableMaterial(fixture.material, owner, fixture.policy)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });
});

const ownedRoots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real private receipt/link transactions with synthetic admission/signing and
// an explicit host-Node process port; this is not native host qualification.
async function ownedBundle(version = '0.12.3') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf owner adapter ')));
  ownedRoots.push(root);
  const source = path.join(root, 'source');
  const prefix = path.join(root, 'private-prefix');
  const directory = path.join(root, 'neutral');
  await mkdir(prefix, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  for (const item of ['bin', 'runtime', 'application/dist', 'installation']) await mkdir(path.join(source, item), { recursive: true, mode: 0o700 });
  await writeFile(path.join(source, 'runtime/node'), '# fixture-only runtime process port\n', { mode: 0o755 });
  await writeFile(path.join(source, 'bin/liftoff'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(source, 'application/dist/cli.js'), `console.log("Liftoff ${version}");\n`);
  for (const name of ['native-install.mjs', 'native-bundle-contract.mjs']) await copyFile(`scripts/${name}`, path.join(source, 'installation', name));
  for (const name of ['native-release-admission.mjs', 'release-policy.json', 'platforms.json']) {
    await copyFile(`distribution/native/${name}`, path.join(source, 'installation', name));
  }
  await writeFile(path.join(source, 'installation/host.mjs'),
    'export function assertNativeHost(){return {fixtureOnly:true}};export function observeNativeHost(){return {fixtureOnly:true}};\n');
  const manifest = {
    schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: true,
    package: { name: '@msn-control/liftoff', version }, source: { repository: 'voyager163/liftoff', commit: 'd'.repeat(40) },
    platform: { platform: 'linux', architecture: 'x64' }, launcher: 'bin/liftoff',
    runtime: { executable: 'runtime/node' }, inventory: await bundleInventory(source)
  };
  const manifestBytes = json(manifest);
  await writeFile(path.join(source, 'bundle.json'), manifestBytes);
  const expectedManifestSha256 = hash(manifestBytes);
  const installed = await installOwnedBundle({ source, prefix, expectedManifestSha256, expectedCurrent: null,
    admitHost: () => {}, interruptAt: undefined });
  const bundleRoot = path.join(prefix, installed.current);
  const dependencies = {
    ...defaultSelfUpgradeDependencies(), platform: 'linux' as const, architecture: 'x64',
    runner: { run: (command, options) => new NodeCommandRunner().run({ ...command, executable: process.execPath }, options) } satisfies CommandRunner,
    execPath: path.join(bundleRoot, 'runtime/node'), runningExecutable: path.join(bundleRoot, 'application/dist/cli.js'),
    resolveLiftoff: async () => path.join(prefix, 'bin/liftoff'),
    environment: { PATH: path.dirname(process.execPath), HOME: root, NODE_OPTIONS: '--require=foreign-fixture' }
  };
  return { root, source, prefix, directory, manifest, expectedManifestSha256, bundleRoot, dependencies,
    packageRoot: path.join(bundleRoot, 'application'), installed };
}

describe.skipIf(process.platform === 'win32')('native adapter on explicit private receipt-owned fixtures', () => {
  it('proves the supplied native verification environment reaches actual children without ambient reinheritance', async () => {
    const fixture = await ownedBundle();
    vi.stubEnv('LIFTOFF_NATIVE_PARENT_ONLY_FIXTURE', 'fixture-parent-only');
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://parent-registry.invalid');
    const inspector = { executable: process.execPath, args: ['-e',
      'console.log(JSON.stringify({parent:process.env.LIFTOFF_NATIVE_PARENT_ONLY_FIXTURE ?? null,' +
      'registry:process.env.NPM_CONFIG_REGISTRY ?? null,telemetry:process.env.LIFTOFF_TELEMETRY,' +
      'tracking:process.env.DO_NOT_TRACK,nodeOptions:process.env.NODE_OPTIONS,home:process.env.HOME}))'] };
    const runner = new NodeCommandRunner();
    const original = fixture.dependencies.runner;
    let children = 0;
    const port = createNativeUpgradePort({ ...fixture.dependencies, runner: { run: async (command, options) => {
      expect(options?.inheritEnvironment).toBe(false);
      if (children === 0) {
        const inherited = await runner.run(inspector, { ...options, inheritEnvironment: undefined });
        expect(inherited.status).toBe(0);
        expect(JSON.parse(inherited.stdout)).toMatchObject({ parent: 'fixture-parent-only', registry: 'https://parent-registry.invalid' });
      }
      const observed = await runner.run(inspector, options);
      expect(observed.status).toBe(0);
      expect(JSON.parse(observed.stdout)).toEqual({ parent: null, registry: null, telemetry: '0',
        tracking: '1', nodeOptions: '', home: fixture.root });
      children++;
      return original.run(command, options);
    } } });
    expect(await port.inspect(fixture.packageRoot, '0.12.3', fixture.directory)).toMatchObject({ owner: 'liftoff-native' });
    expect(children).toBeGreaterThan(0);
  });

  it('classifies only exact receipt/inventory/runtime attribution and refuses the real unqualified publisher policy', async () => {
    const fixture = await ownedBundle();
    const port = createNativeUpgradePort(fixture.dependencies);
    const observed = await port.inspect(fixture.packageRoot, '0.12.3', fixture.directory);
    expect(observed).toMatchObject({ owner: 'liftoff-native', prefix: fixture.prefix, current: fixture.installed.current,
      manifestSha256: fixture.expectedManifestSha256, inventorySha256: fixture.manifest.inventory.sha256 });
    expect(await port.inspect('/fixture/npm/@msn-control/liftoff', '0.12.3', fixture.directory)).toBeNull();
    await expect(port.stable(observed!, fixture.directory)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    await expect(port.channel(observed!, { version: '0.13.0' } as NativeCandidate, fixture.directory))
      .rejects.toMatchObject({ reasonCode: 'channel_unavailable' });
    await expect(port.recover!(observed!, { journalSha256: '0'.repeat(64) }, fixture.directory))
      .rejects.toMatchObject({ reasonCode: 'recovery_required' });
    expect(await inspectOwnedInstallation(fixture.prefix)).toBe(fixture.installed.current);
  });

  it('applies an admitted exact candidate with the existing installer and postverifies through its replacement runtime', async () => {
    const original = await ownedBundle();
    const candidateBundle = await ownedBundle('0.13.0');
    const signed = signedMaterial();
    signed.material.bundleRoot = candidateBundle.source;
    signed.record.manifestSha256 = candidateBundle.expectedManifestSha256;
    signed.record.inventorySha256 = candidateBundle.manifest.inventory.sha256;
    const sbom = JSON.parse(signed.assets.get('sbom.cdx.json')!.toString());
    sbom.properties[1].value = signed.record.inventorySha256;
    signed.assets.set('sbom.cdx.json', json(sbom));
    signed.record.files[1].bytes = signed.assets.get('sbom.cdx.json')!.length;
    signed.record.files[1].sha256 = hash(signed.assets.get('sbom.cdx.json')!);
    Object.assign(signed.qualification, signed.record);
    signed.resign();
    const calls: Array<{ executable: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const port = createNativeUpgradePort({
      ...original.dependencies,
      readJson: async file => file.endsWith('release-policy.json') ? signed.policy : JSON.parse(await readFile(file, 'utf8')),
      runner: { run: async (command, options) => {
        calls.push({ executable: command.executable, env: options?.env });
        return original.dependencies.runner.run(command, options);
      } }
    }, { stable: { readStable: async () => signed.material } });
    const observed = await port.inspect(original.packageRoot, '0.12.3', original.directory);
    const candidate = await port.stable(observed!, original.directory);
    expect(await port.apply(observed!, candidate, original.directory)).toEqual({ effects: 'installed' });
    await port.verify(observed!, candidate, original.directory);
    expect(await inspectOwnedInstallation(original.prefix)).toBe(`versions/0.13.0-${candidateBundle.expectedManifestSha256}`);
    expect((await lstat(original.bundleRoot)).isDirectory()).toBe(true);
    expect(calls.every(call => call.executable.startsWith(original.prefix) &&
      call.env?.DO_NOT_TRACK === '1' && call.env?.LIFTOFF_TELEMETRY === '0' && call.env?.NODE_OPTIONS === '')).toBe(true);
  }, 30_000);

  it('selects exact interrupted journal recovery and refuses changed selection without cleaning unrelated paths', async () => {
    const original = await ownedBundle();
    const next = await ownedBundle('0.13.0');
    await expect(installOwnedBundle({ source: next.source, prefix: original.prefix,
      expectedManifestSha256: next.expectedManifestSha256, expectedCurrent: original.installed.current,
      admitHost: () => {}, interruptAt: 'before-switch' })).rejects.toThrow('Interrupted');
    const port = createNativeUpgradePort(original.dependencies);
    const observed = await port.inspect(original.packageRoot, '0.12.3', original.directory);
    expect(observed?.recovery?.journalSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(port.recover!(observed!, { journalSha256: '0'.repeat(64) }, original.directory))
      .rejects.toMatchObject({ reasonCode: 'recovery_required' });
    const foreign = path.join(original.prefix, 'foreign.txt');
    await writeFile(foreign, 'retain');
    await port.recover!(observed!, observed!.recovery!, original.directory);
    expect(await readFile(foreign, 'utf8')).toBe('retain');
    expect(await inspectOwnedInstallation(original.prefix)).toBe(original.installed.current);
    expect((await port.inspect(original.packageRoot, '0.12.3', original.directory))?.recovery).toBeUndefined();
  }, 30_000);

  it('rejects runtime/manifest/helper corruption and reports unsettled child work without an install', async () => {
    const fixture = await ownedBundle();
    const originalPort = createNativeUpgradePort({ ...fixture.dependencies, execPath: process.execPath });
    await expect(originalPort.inspect(fixture.packageRoot, '0.12.3', fixture.directory)).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    const timeoutPort = createNativeUpgradePort({ ...fixture.dependencies, runner: { run: async command => ({
      command, displayCommand: '', status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true
    }) } });
    await expect(timeoutPort.inspect(fixture.packageRoot, '0.12.3', fixture.directory)).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await writeFile(path.join(fixture.bundleRoot, 'installation/native-install.mjs'), 'changed');
    await expect(createNativeUpgradePort(fixture.dependencies).inspect(fixture.packageRoot, '0.12.3', fixture.directory))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it('rejects architecture, running-executable and selected-launcher mismatches before helper execution', async () => {
    const fixture = await ownedBundle();
    const run = vi.fn(fixture.dependencies.runner.run);
    for (const [override, reasonCode] of [
      [{ architecture: 'arm64' }, 'native_invalid'],
      [{ runningExecutable: path.join(fixture.source, 'application/dist/cli.js') }, 'executable_selection'],
      [{ runningExecutable: path.join(fixture.root, 'missing.js') }, 'executable_selection'],
      [{ resolveLiftoff: async () => path.join(fixture.source, 'bin/liftoff') }, 'executable_selection']
    ] as const) {
      await expect(createNativeUpgradePort({ ...fixture.dependencies, ...override, runner: { run } })
        .inspect(fixture.packageRoot, '0.12.3', fixture.directory)).rejects.toMatchObject({ reasonCode });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('retains an active selected lock and a changed journal without sweeping unrelated material', async () => {
    const original = await ownedBundle();
    const next = await ownedBundle('0.13.0');
    await expect(installOwnedBundle({ source: next.source, prefix: original.prefix,
      expectedManifestSha256: next.expectedManifestSha256, expectedCurrent: original.installed.current,
      admitHost: () => {}, interruptAt: 'before-switch' })).rejects.toThrow('Interrupted');
    const lock = path.join(original.prefix, '.native-install-lock');
    await mkdir(lock, { mode: 0o700 });
    const ownerBytes = json({ schemaVersion: 1, kind: 'liftoff-native-install-lock',
      prefixSha256: hash(Buffer.from(original.prefix)), pid: process.pid,
      nonce: '11111111-1111-1111-1111-111111111111' });
    await writeFile(path.join(lock, 'owner.json'), ownerBytes, { mode: 0o600 });
    const port = createNativeUpgradePort(original.dependencies);
    const observed = await port.inspect(original.packageRoot, '0.12.3', original.directory);
    expect(observed).toMatchObject({ locked: true, recovery: { staleLockOwnerSha256: hash(ownerBytes) } });
    await expect(port.recover!(observed!, observed!.recovery!, original.directory))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(await readFile(path.join(lock, 'owner.json'))).toEqual(ownerBytes);
    const journal = path.join(original.prefix, '.native-install-transaction.json');
    const changed = Buffer.concat([await readFile(journal), Buffer.from('\n')]);
    await writeFile(journal, changed);
    await expect(port.recover!(observed!, observed!.recovery!, original.directory))
      .rejects.toMatchObject({ reasonCode: 'owner_changed' });
    expect(await readFile(journal)).toEqual(changed);
    expect(await inspectOwnedInstallation(original.prefix)).toBe(original.installed.current);
  }, 30_000);

  it('refuses ownerless lock material instead of clearing or ignoring it', async () => {
    const fixture = await ownedBundle();
    const lock = path.join(fixture.prefix, '.native-install-lock');
    await mkdir(lock, { mode: 0o700 });
    await expect(createNativeUpgradePort(fixture.dependencies).inspect(fixture.packageRoot, '0.12.3', fixture.directory))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect((await lstat(lock)).isDirectory()).toBe(true);
  });
});

describe('native metadata rejection without qualification claims', () => {
  it.each([
    ['foreign signer', (f: ReturnType<typeof signedMaterial>) => { f.policy.approvedSigningKeySha256 = '0'.repeat(64); }],
    ['wrong signature', (f: ReturnType<typeof signedMaterial>) => { f.material.signature[0] ^= 1; }],
    ['source mismatch', (f: ReturnType<typeof signedMaterial>) => { f.qualification.commit = '0'.repeat(40); f.resign(); }],
    ['inventory mismatch', (f: ReturnType<typeof signedMaterial>) => { f.qualification.inventorySha256 = '0'.repeat(64); f.resign(); }],
    ['unqualified minimum host', (f: ReturnType<typeof signedMaterial>) => { f.qualification.qualification.minimumHost = false; f.resign(); }],
    ['missing HCL correspondence', (f: ReturnType<typeof signedMaterial>) => { delete f.qualification.evidenceDigests.hclSourceCorrespondence; f.resign(); }],
    ['absent deployed archive', (f: ReturnType<typeof signedMaterial>) => { f.assets.delete(f.record.files[0].filename); }],
    ['changed deployed archive', (f: ReturnType<typeof signedMaterial>) => { f.assets.set(f.record.files[0].filename, Buffer.from('changed')); }],
    ['changed evidence file', (f: ReturnType<typeof signedMaterial>) => { f.platformEvidence.set('minimumHost', json({ modified: true })); }],
    ['unbound stable tag', (f: ReturnType<typeof signedMaterial>) => { f.material.stableTag = 'v0.14.0'; }],
    ['draft', (f: ReturnType<typeof signedMaterial>) => { f.material.draft = true; }],
    ['prerelease', (f: ReturnType<typeof signedMaterial>) => { f.material.prerelease = true; }],
    ['escaping candidate', (f: ReturnType<typeof signedMaterial>) => { f.material.bundleRoot = '/fixture/../elsewhere'; }],
    ['foreign provenance', (f: ReturnType<typeof signedMaterial>) => {
      f.assets.set('provenance.json', json({ _type: 'foreign' }));
      const file = f.record.files[2]; file.bytes = f.assets.get('provenance.json')!.length; file.sha256 = hash(f.assets.get('provenance.json')!);
      f.resign();
    }]
  ])('refuses %s, even if local ownership exists', async (_name, mutate) => {
    const fixture = signedMaterial(); mutate(fixture);
    await expect(admitNativeStableMaterial(fixture.material, installation, fixture.policy))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it('blocks unqualified policy before any source read and distinguishes unavailable from deadline exhaustion', async () => {
    const fixture = signedMaterial();
    const read = vi.fn(async () => fixture.material);
    await expect(lookupNativeStableCandidate(installation, { ...fixture.policy, approvedSigningKeySha256: null }, { readStable: read }))
      .rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(read).not.toHaveBeenCalled();
    await expect(lookupNativeStableCandidate(installation, fixture.policy, { readStable: async () => { throw new Error('offline'); } }))
      .rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    let signal: AbortSignal | undefined;
    await expect(lookupNativeStableCandidate(installation, fixture.policy, { readStable: async (_owner, observed) => {
      signal = observed; return new Promise(() => {});
    } }, 10)).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('rejects admission that exhausts the deadline while synchronous asset verification prevents the timer from firing', async () => {
    const fixture = signedMaterial();
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(11);
    try {
      await expect(lookupNativeStableCandidate(installation, fixture.policy, {
        readStable: async () => fixture.material
      }, 10)).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    } finally {
      clock.mockRestore();
    }
  });
});

function nativeWorld(owner: NativeInstallation['owner'] = 'liftoff-native') {
  const fixture = upgradeWorld({ mode: 'apply' });
  const selected: NativeInstallation = { ...installation, owner,
    ...(owner === 'winget' ? { managerId: 'Fixture.Liftoff', managerSource: 'fixture-source', managerScope: 'user' as const } : {}) };
  const candidate: NativeCandidate = {
    version: '0.13.0', target: selected.target, sourceCommit: 'd'.repeat(40), manifestSha256: 'e'.repeat(64),
    inventorySha256: 'f'.repeat(64), identity: 'fixture-authenticated-candidate'
  };
  const port: NativeUpgradePort = {
    inspect: vi.fn(async () => selected), stable: vi.fn(async () => candidate),
    channel: vi.fn<NativeUpgradePort['channel']>(async () => ({ status: 'available', version: candidate.version, identity: 'fixture-channel', exactApply: true })),
    apply: vi.fn<NativeUpgradePort['apply']>(async () => ({ effects: 'installed' })), verify: vi.fn(async () => {})
  };
  fixture.dependencies.nativeUpgrade = port;
  return { ...fixture, selected, candidate, port };
}

describe('owner-aware orchestration and read-only doctor', () => {
  it.each(['file', 'directory'] as const)('refuses a source checkout with a %s Git marker before any manager or metadata probe', async kind => {
    const fixture = upgradeWorld({ mode: 'apply' });
    fixture.world.nodes.set(path.posix.join(fixture.world.packageRoot, '.git'), { kind });
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      status: 'blocked', reasonCode: 'unsupported_installation', installationOwner: 'unknown', effects: 'none'
    });
    expect(fixture.world.trace.filter(event => 'run' in event || 'lookup' in event)).toEqual([]);
  });
  it.each(['darwin', 'win32'] as const)('classifies %s only after bounded explicit manager observations, never from a prefix alone', async platform => {
    const fixture = managerObservationFixture(platform);
    const port = createNativeUpgradePort(fixture.dependencies, {
      cask: async () => fixture.cask, winget: async () => fixture.winget
    });
    expect(await port.inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral')).toMatchObject({
      owner: platform === 'darwin' ? 'homebrew-cask' : 'winget',
      ...(platform === 'win32' ? { managerScope: 'user' } : {})
    });
    await expect(createNativeUpgradePort(fixture.dependencies, { cask: undefined }).inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral'))
      .rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    if (platform === 'darwin') {
      await expect(createNativeUpgradePort(fixture.dependencies, { stable: { readStable: async () => signedMaterial().material } })
        .inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral'))
        .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    }
    fixture.policy.homebrew.cask = null;
    fixture.policy.winget.packageIdentifier = null;
    await expect(port.inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral'))
      .rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  });
  it('requires authenticated source/inventory identity, not just version equality, before reporting native current', async () => {
    const fixture = nativeWorld();
    fixture.candidate.version = fixture.selected.version;
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      status: 'blocked', reasonCode: 'native_identity_mismatch', effects: 'none'
    });
    Object.assign(fixture.candidate, { manifestSha256: fixture.selected.manifestSha256,
      inventorySha256: fixture.selected.inventorySha256, sourceCommit: fixture.selected.sourceCommit });
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      status: 'current', reasonCode: 'current', effects: 'none', verification: 'not-run'
    });
    expect(fixture.port.apply).not.toHaveBeenCalled();
  });

  it('binds selected owning-channel availability to the exact admitted archive or Windows installer bytes', async () => {
    const fixture = nativeWorld();
    fixture.candidate.archiveSha256 = '1'.repeat(64);
    const available = { status: 'available' as const, version: fixture.candidate.version,
      identity: 'fixture-owner-channel', exactApply: true, artifactSha256: fixture.candidate.archiveSha256 };
    const port = createNativeUpgradePort(fixture.dependencies, { channel: async () => available });
    expect(await port.channel(fixture.selected, fixture.candidate, fixture.world.neutralDirectory)).toEqual(available);
    available.artifactSha256 = '2'.repeat(64);
    await expect(port.channel(fixture.selected, fixture.candidate, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'channel_invalid' });
  });
  it.each(['liftoff-native', 'homebrew-cask', 'winget'] as const)('checks %s without invoking npm or installing', async owner => {
    const fixture = nativeWorld(owner); fixture.request.mode = 'check';
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toEqual({
      schemaVersion: 2, mode: 'check', status: 'update-available', currentVersion: '0.12.3', reasonCode: 'update_available',
      targetVersion: '0.13.0', installationOwner: owner, upstream: { status: 'available', version: '0.13.0' },
      channel: { status: 'available', version: '0.13.0' }, effects: 'none', verification: 'not-run',
      ...(owner === 'winget' ? { handoff: { executable: 'winget', args: ['upgrade', '--id', 'Fixture.Liftoff', '--exact',
        '--version', '0.13.0', '--source', 'fixture-source', '--scope', 'user', '--disable-interactivity'] } } : {})
    });
    expect(selfUpgradeExitCode(result)).toBe(2);
    expect(fixture.port.apply).not.toHaveBeenCalled();
    expect(fixture.world.trace.filter(event => 'run' in event)).toEqual([]);
    expect(cliInstallationLayer(result).checks).toContainEqual(expect.objectContaining({ label: 'installation owner', detail: owner }));
  });

  it.each(['homebrew-cask', 'winget'] as const)('hands off %s without claiming an upgrade or running an unbound manager command', async owner => {
    const fixture = nativeWorld(owner);
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({ status: 'handoff-required', installationOwner: owner, effects: 'none', verification: 'not-run' });
    expect(result.restartRequired).toBe(owner === 'winget' ? true : undefined);
    expect(selfUpgradeExitCode(result)).toBe(1);
    expect(fixture.port.apply).not.toHaveBeenCalled();
    expect(selfUpgradeRemedy(result)).not.toMatch(/npm install|run brew upgrade/);
  });

  it('requires exact same owner, release and channel immediately before bounded apply, then verifies completion', async () => {
    const fixture = nativeWorld();
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      status: 'upgraded', effects: 'installed', verification: 'verified', installationOwner: 'liftoff-native'
    });
    expect(fixture.port.inspect).toHaveBeenCalledTimes(3);
    expect(fixture.port.stable).toHaveBeenCalledTimes(2);
    expect(fixture.port.channel).toHaveBeenCalledTimes(2);
    expect(fixture.port.apply).toHaveBeenCalledExactlyOnceWith(fixture.selected, fixture.candidate, fixture.world.neutralDirectory);
    expect(fixture.port.verify).toHaveBeenCalledExactlyOnceWith(fixture.selected, fixture.candidate, fixture.world.neutralDirectory);
  });

  it.each(['owner', 'release', 'channel'] as const)('refuses a changed %s without effects', async kind => {
    const fixture = nativeWorld();
    if (kind === 'owner') vi.mocked(fixture.port.inspect).mockResolvedValueOnce(fixture.selected).mockResolvedValue({ ...fixture.selected, identity: 'changed' });
    if (kind === 'release') vi.mocked(fixture.port.stable).mockResolvedValueOnce(fixture.candidate).mockResolvedValue({ ...fixture.candidate, identity: 'changed' });
    if (kind === 'channel') vi.mocked(fixture.port.channel).mockResolvedValueOnce({ status: 'available', version: '0.13.0', identity: 'old', exactApply: true })
      .mockResolvedValue({ status: 'available', version: '0.13.0', identity: 'changed', exactApply: true });
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({ status: 'blocked',
      reasonCode: kind === 'owner' ? 'owner_changed' : 'channel_changed', effects: 'none' });
    expect(fixture.port.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', { status: 'absent' }, 'channel_absent'],
    ['lagging', { status: 'lagging', version: '0.12.3' }, 'channel_lag']
  ] as const)('distinguishes %s channel from current or unknown', async (_name, observation, reasonCode) => {
    const fixture = nativeWorld(); vi.mocked(fixture.port.channel).mockResolvedValue(observation);
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({ status: 'blocked', reasonCode, upstream: { status: 'available' }, channel: observation, effects: 'none' });
    expect(cliInstallationLayer(result).checks.find(check => check.label === 'cli freshness')?.severity).toBe('warn');
  });

  it('never treats a newer local version, prerelease, indeterminate channel or interrupted effects as current', async () => {
    const downgrade = nativeWorld(); downgrade.candidate.version = '0.12.0';
    expect(await runSelfUpgrade(downgrade.request, downgrade.dependencies)).toMatchObject({ reasonCode: 'downgrade_refused' });
    const prerelease = nativeWorld(); prerelease.candidate.version = '0.14.0-rc.1';
    expect(await runSelfUpgrade(prerelease.request, prerelease.dependencies)).toMatchObject({ reasonCode: 'native_invalid' });
    const offline = nativeWorld(); vi.mocked(offline.port.channel).mockRejectedValue(new SelfUpgradeFailure('failed', 'channel_timeout'));
    expect(await runSelfUpgrade(offline.request, offline.dependencies)).toMatchObject({ reasonCode: 'channel_timeout', channel: { status: 'unknown' } });
    const interrupted = nativeWorld(); vi.mocked(interrupted.port.apply).mockRejectedValue(new SelfUpgradeFailure('failed', 'native_install_timeout'));
    expect(await runSelfUpgrade(interrupted.request, interrupted.dependencies)).toMatchObject({
      status: 'failed', effects: 'possible', verification: 'not-run', reasonCode: 'native_install_timeout'
    });
    const unverified = nativeWorld(); vi.mocked(unverified.port.verify).mockRejectedValue(new SelfUpgradeFailure('failed', 'verification_failed'));
    const result = await runSelfUpgrade(unverified.request, unverified.dependencies);
    expect(result).toMatchObject({ status: 'failed', effects: 'installed', verification: 'failed' });
    expect(selfUpgradeRemedy(result)).not.toContain('npm');
  });

  it('retains journal and active lock effects instead of retrying or sweeping directories', async () => {
    const fixture = nativeWorld(); fixture.selected.recovery = { journalSha256: '0'.repeat(64) };
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({ reasonCode: 'recovery_required', effects: 'possible' });
    expect(fixture.port.stable).not.toHaveBeenCalled();
    expect(fixture.port.apply).not.toHaveBeenCalled();
  });

  it.each(['before-apply', 'after-install', 'after-verification'] as const)('preserves effects when scratch cleanup fails %s', async stage => {
    const fixture = nativeWorld();
    fixture.dependencies.removeNeutralDirectory = async () => { throw new Error('fixture cleanup refused'); };
    if (stage === 'before-apply') fixture.request.mode = 'check';
    if (stage === 'after-install') vi.mocked(fixture.port.verify).mockRejectedValue(new SelfUpgradeFailure('failed', 'verification_failed'));
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      status: 'failed', reasonCode: 'cleanup_failed', installationOwner: 'liftoff-native',
      effects: stage === 'before-apply' ? 'none' : 'installed',
      verification: stage === 'before-apply' ? 'not-run' : stage === 'after-install' ? 'failed' : 'verified'
    });
  });

  it('bounds owning-channel observations, aborts a hanging reader and reports unknown rather than current', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fixture = nativeWorld();
      const port = createNativeUpgradePort(fixture.dependencies, { channel: async (_owner, _candidate, _directory, observed) => {
        signal = observed; return new Promise(() => {});
      } });
      const pending = expect(port.channel(fixture.selected, fixture.candidate, fixture.world.neutralDirectory))
        .rejects.toMatchObject({ reasonCode: 'channel_timeout' });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the selected doctor probe deadline for native stable metadata rather than the ordinary upgrade deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let outcome: unknown;
    const fixture = signedMaterial();
    const dependencies = { ...defaultSelfUpgradeDependencies(), probeTimeoutMs: 2_000, readJson: async () => fixture.policy };
    const pending = createNativeUpgradePort(dependencies, {
      stable: { readStable: async (_installation, observed) => {
        signal = observed;
        return new Promise(() => {});
      } }
    }).stable(installation, '/virtual/neutral').then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(outcome).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ reasonCode: 'native_timeout' });
      expect(signal?.aborted).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      await pending;
      vi.useRealTimers();
    }
  });

  it.each([
    { kind: 'owner', elapsed: 10 }, { kind: 'owner', elapsed: 11 },
    { kind: 'channel', elapsed: 10 }, { kind: 'channel', elapsed: 11 }
  ])('rejects a late $kind observation at $elapsed ms even when synchronous work delays the timeout callback', async ({ kind, elapsed }) => {
    const fixture = managerObservationFixture('darwin');
    fixture.dependencies.probeTimeoutMs = 10;
    const world = nativeWorld();
    const ownerRead = vi.fn(async () => fixture.cask);
    const channelRead = vi.fn(async () => ({
      status: 'available' as const, version: world.candidate.version, identity: 'fixture-channel',
      exactApply: false, artifactSha256: '1'.repeat(64)
    }));
    world.candidate.archiveSha256 = '1'.repeat(64);
    let ownerSignal: AbortSignal | undefined;
    let channelSignal: AbortSignal | undefined;
    const port = createNativeUpgradePort(fixture.dependencies, {
      cask: async (...args) => {
        ownerSignal = args[3];
        return ownerRead();
      },
      channel: async (...args) => {
        channelSignal = args[3];
        return channelRead();
      }
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(elapsed);
    try {
      await expect(kind === 'owner'
        ? port.inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral')
        : port.channel(world.selected, world.candidate, '/virtual/neutral'))
        .rejects.toMatchObject({ reasonCode: kind === 'owner' ? 'native_timeout' : 'channel_timeout' });
      expect(kind === 'owner' ? ownerSignal?.aborted : channelSignal?.aborted).toBe(true);
      expect(kind === 'owner' ? ownerRead : channelRead).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects an invalid native observation deadline %s before reading a provider', async probeTimeoutMs => {
    const fixture = managerObservationFixture('darwin');
    const read = vi.fn(async () => fixture.cask);
    await expect(createNativeUpgradePort({ ...fixture.dependencies, probeTimeoutMs }, { cask: read })
      .inspect(fixture.packageRoot, '0.12.3', '/virtual/neutral'))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'foreign product', metadata: { name: 'foreign', version: '0.13.0' } },
    { name: 'missing identity', metadata: { version: '0.13.0' } },
    { name: 'missing version', metadata: { name: '@msn-control/liftoff' } },
    { name: 'malformed version', metadata: { name: '@msn-control/liftoff', version: 'stable' } },
    { name: 'prerelease version', metadata: { name: '@msn-control/liftoff', version: '0.13.0-rc.1' } },
    { name: 'newer mismatched version', metadata: { name: '@msn-control/liftoff', version: '0.14.0' } }
  ])('reports exact npm target metadata with $name as invalid, not mirror lag', async ({ metadata }) => {
    const fixture = upgradeWorld({ mode: 'apply' });
    fixture.world.viewResult = { stdout: JSON.stringify(metadata) };
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({
      status: 'failed', reasonCode: 'registry_invalid', installationOwner: 'npm',
      upstream: { status: 'available', version: '0.13.0' }, channel: { status: 'unknown' }, effects: 'none'
    });
    expect(fixture.world.trace.some(event => 'run' in event && event.run.args[0] === 'install')).toBe(false);
    expect(cliInstallationLayer(result).checks).toContainEqual(expect.objectContaining({
      label: 'channel availability', detail: 'unknown'
    }));
  });

  it('binds exact manager identities to approved namespace, publisher, certificate and installed bundle facts', () => {
    const policy = signedMaterial().policy;
    policy.homebrew = { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools', developerTeamId: 'ABCDEFGHIJ' };
    policy.winget = { packageIdentifier: 'Fixture.Liftoff', publisher: 'Fixture Publisher',
      certificateSha256: '0'.repeat(64), installerAppId: 'fixture-app' };
    expect(nativePolicy(policy)).toEqual(policy);
    const cask = { fullToken: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools', installedVersion: '0.12.3',
      bundleRoot: installation.bundleRoot, launcher: installation.launcher };
    expect(() => assertCaskOwnership(cask, installation, policy)).not.toThrow();
    for (const mutation of [{ fullToken: 'foreign/tools/liftoff' }, { sourceRepository: 'foreign/tools' },
      { installedVersion: '0.13.0' }, { launcher: '/foreign/launcher' }, { bundleRoot: '/foreign/root' }]) {
      expect(() => assertCaskOwnership({ ...cask, ...mutation }, installation, policy)).toThrow('unsupported_installation');
    }
    const winget = { packageIdentifier: 'Fixture.Liftoff', source: 'fixture-source', publisher: 'Fixture Publisher', scope: 'user' as const,
      appId: 'fixture-app', certificateSha256: '0'.repeat(64), installedVersion: '0.12.3',
      installLocation: installation.bundleRoot, launcher: installation.launcher };
    expect(() => assertWinGetOwnership(winget, installation, policy)).not.toThrow();
    for (const mutation of [{ packageIdentifier: 'Foreign.Liftoff' }, { publisher: 'Foreign Publisher' },
      { appId: 'foreign-app' }, { certificateSha256: '1'.repeat(64) }, { source: 'unsafe source' },
      { installedVersion: '0.13.0' }, { installLocation: '/foreign/root' }, { launcher: '/foreign/launcher' }]) {
      expect(() => assertWinGetOwnership({ ...winget, ...mutation }, installation, policy)).toThrow('unsupported_installation');
    }
    expect(() => assertWinGetOwnership({ ...winget, scope: 'machine' }, installation, policy)).toThrow('unsupported_installation');
  });

  it.each([
    ['lagging', { stdout: JSON.stringify({ name: '@msn-control/liftoff', version: '0.12.3' }) }, 'registry_stale', 'lagging'],
    ['absent', { status: 1, stderr: 'E404 package not found' }, 'registry_absent', 'absent'],
    ['offline', { status: 1, stderr: 'network unavailable' }, 'registry_unavailable', 'unknown'],
    ['deadline', { status: null, timedOut: true }, 'registry_timeout', 'unknown'],
    ['indeterminate', { stdout: JSON.stringify({ name: '@msn-control/liftoff', version: '0.13.0' }) }, 'registry_invalid', 'unknown'],
    ['foreign', { stdout: JSON.stringify({ name: 'foreign', version: '0.12.3' }) }, 'registry_invalid', 'unknown']
  ] as const)('distinguishes selected npm channel %s with bounded same-registry probes and no install', async (_name, observation, reasonCode, status) => {
    const fixture = upgradeWorld({ mode: 'apply' });
    fixture.world.scopedRegistry = 'https://fixture-mirror.test/npm';
    fixture.world.viewResult = { status: 1, stderr: 'E404 exact target not found' };
    fixture.world.packageViewResult = observation;
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies)).toMatchObject({
      reasonCode, installationOwner: 'npm', upstream: { status: 'available', version: '0.13.0' },
      channel: { status }, effects: 'none'
    });
    const commands = fixture.world.trace.flatMap(event => 'run' in event ? [event.run] : []);
    expect(commands.filter(command => command.args[0] === 'view').map(command => command.args[1]))
      .toEqual(['@msn-control/liftoff@0.13.0', '@msn-control/liftoff']);
    expect(commands.every(command => command.cwd === '<neutral>' && command.timeoutMs === 30_000)).toBe(true);
    expect(commands.some(command => command.args[0] === 'install')).toBe(false);
  });

  it('refuses direct native apply without authenticated admission and accepts no permissive policy defaults', async () => {
    const fixture = nativeWorld();
    await expect(createNativeUpgradePort(fixture.dependencies).apply(fixture.selected, fixture.candidate, fixture.world.neutralDirectory))
      .rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(() => nativePolicy({ schemaVersion: 1 })).toThrow('native_invalid');
    const policy = signedMaterial().policy;
    expect(() => assertCaskOwnership({ fullToken: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools',
      installedVersion: '0.12.3', bundleRoot: installation.bundleRoot, launcher: installation.launcher }, installation, policy)).toThrow('native_unqualified');
    expect(() => assertWinGetOwnership({ packageIdentifier: 'Fixture.Liftoff', source: 'fixture', publisher: 'fixture',
      appId: 'fixture', certificateSha256: '0'.repeat(64), installedVersion: '0.12.3', scope: 'user',
      installLocation: installation.bundleRoot, launcher: installation.launcher }, installation, policy)).toThrow('native_unqualified');
  });
});
