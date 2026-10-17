import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, lstat, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzip, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contract from '../scripts/native-bundle-contract.mjs';
import { verifyAuthenticatedMacCandidateArchive } from '../src/adapters/distribution/native-mac-archive.js';
import { admitNativeStableMaterial } from '../src/adapters/distribution/native-metadata.js';
import { defaultSelfUpgradeDependencies } from '../src/adapters/distribution/upgrade-host.js';
import { selfUpgradeInstallTimeoutMs } from '../src/domain/distribution/liftoff-upgrade.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { signedMaterial } from './fixtures/native-stable-material.js';
import { paxRecord, tar, type TarMember } from './fixtures/native-archive.js';

vi.mock('node:zlib', async importOriginal => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return { ...actual, gunzip: vi.fn(actual.gunzip) };
});

const directories: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const signed = signedMaterial('darwin-arm64');
  delete signed.material.bundleRoot;
  delete signed.material.archiveSignature;
  delete signed.material.archivePublicKey;
  signed.policy.linux.archiveSigningKeySha256 = null;
  const source = await defaultSelfUpgradeDependencies().makeNeutralDirectory();
  directories.push(source);
  for (const name of ['bin', 'runtime', 'application']) await mkdir(path.join(source, name), { mode: 0o755 });
  for (const name of ['bin/liftoff', 'runtime/node', 'application/cli.js']) {
    await writeFile(path.join(source, name), 'throw new Error("inert fixture must never execute");\n');
    await chmod(path.join(source, name), 0o755);
  }
  await symlink('liftoff', path.join(source, 'bin/alias'));
  const manifest = {
    schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: true,
    package: { name: '@msn-control/liftoff', version: '0.13.0' },
    source: { repository: signed.policy.repository, commit: signed.record.commit },
    platform: { platform: 'darwin', architecture: 'arm64' }, launcher: 'bin/liftoff',
    runtime: { executable: 'runtime/node' }, inventory: await contract.bundleInventory(source)
  };
  const members: TarMember[] = [{ name: './', kind: '5' }];
  const visit = async (parent: string) => {
    for (const name of (await readdir(path.join(source, parent))).sort()) {
      const relative = path.posix.join(parent, name), filename = path.join(source, relative);
      const stat = await lstat(filename);
      const base = { name: `./${relative}`, mode: stat.mode & 0o777 };
      if (stat.isDirectory()) { members.push({ ...base, name: `${base.name}/`, kind: '5' }); await visit(relative); }
      else if (stat.isSymbolicLink()) members.push({ ...base, kind: '2', target: await readlink(filename) });
      else members.push({ ...base, kind: '0', content: await readFile(filename) });
    }
  };
  await visit('');
  const publish = (bytes?: Buffer) => {
    const manifestBytes = json(manifest);
    const index = members.findIndex(member => member.name === './bundle.json');
    const manifestMember = { name: './bundle.json', kind: '0', mode: 0o644, content: manifestBytes };
    if (index === -1) members.push(manifestMember);
    else members[index] = manifestMember;
    const archive = gzipSync(bytes ?? tar(members));
    signed.assets.set(signed.record.files[0].filename, archive);
    signed.record.manifestSha256 = hash(manifestBytes);
    signed.record.inventorySha256 = manifest.inventory.sha256;
    signed.qualification.manifestSha256 = signed.record.manifestSha256;
    signed.qualification.inventorySha256 = signed.record.inventorySha256;
    const sbom = JSON.parse(signed.assets.get('sbom.cdx.json')!.toString('utf8'));
    sbom.properties.find((entry: { name: string }) => entry.name === 'liftoff:inventorySha256').value = manifest.inventory.sha256;
    signed.assets.set('sbom.cdx.json', json(sbom));
    const provenance = JSON.parse(signed.assets.get('provenance.json')!.toString('utf8'));
    provenance.subject[0].digest.sha256 = hash(archive);
    signed.assets.set('provenance.json', json(provenance));
    for (const asset of signed.record.files) {
      const content = signed.assets.get(asset.filename)!;
      asset.bytes = content.length;
      asset.sha256 = hash(content);
    }
    signed.resign();
  };
  publish();
  const input = async () => ({
    material: signed.material,
    candidate: await admitNativeStableMaterial(signed.material, { target: 'darwin-arm64' }, signed.policy),
    policy: signed.policy, contract, signal: new AbortController().signal
  });
  return { ...signed, source, members, manifest, publish, input };
}

describe.skipIf(process.platform === 'win32')('inert authenticated Mac candidate archive verification', () => {
  it('checks the canonical full inventory without executing a runtime, extracting files or borrowing Linux signature authority', async () => {
    const world = await fixture();
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const bundleInventory = vi.fn(contract.bundleInventory);
    const observedContract = { ...contract, bundleInventory };
    const observed = await verifyAuthenticatedMacCandidateArchive({ ...await world.input(), contract: observedContract });
    expect(observed.inventory).toEqual(world.manifest.inventory);
    expect(observed.candidate).toMatchObject({ target: 'darwin-arm64', version: '0.13.0', sourceCommit: world.record.commit });
    expect(observed.candidate).not.toHaveProperty('owner');
    expect(observed.candidate).not.toHaveProperty('bundleRoot');
    expect(observed).not.toHaveProperty('installed');
    expect(observed).not.toHaveProperty('authenticated');
    expect(run).not.toHaveBeenCalled();
    expect(bundleInventory).not.toHaveBeenCalled();
    expect((await readdir(world.source)).sort()).toEqual(['application', 'bin', 'runtime']);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.candidate)).toBe(true);
    expect(Object.isFrozen(observed.inventory.entries[0])).toBe(true);
  });

  it.each(['version', 'target', 'sourceCommit', 'manifestSha256', 'inventorySha256', 'archiveSha256', 'identity'] as const)(
    'refuses a foreign caller candidate %s', async field => {
      const world = await fixture(), input = await world.input();
      Reflect.set(input.candidate, field, 'foreign');
      await expect(verifyAuthenticatedMacCandidateArchive(input)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it.each(['signer', 'namespace', 'repository', 'team'] as const)('refuses missing approved %s authority', async field => {
    const world = await fixture(), input = await world.input();
    if (field === 'signer') input.policy.approvedSigningKeySha256 = null;
    if (field === 'namespace') input.policy.homebrew.cask = null;
    if (field === 'repository') input.policy.homebrew.sourceRepository = null;
    if (field === 'team') input.policy.homebrew.developerTeamId = null;
    await expect(verifyAuthenticatedMacCandidateArchive(input)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  });

  it('does not use a supplied Linux archive principal or signature as Mac authority', async () => {
    const world = await fixture(), input = await world.input();
    input.material.archivePublicKey = Buffer.from('not a Mac signing authority');
    input.material.archiveSignature = Buffer.from('not a Mac archive signature');
    input.policy.linux.archiveSigningKeySha256 = '0'.repeat(64);
    expect((await verifyAuthenticatedMacCandidateArchive(input)).inventory).toEqual(world.manifest.inventory);
    input.policy.approvedSigningKeySha256 = null;
    await expect(verifyAuthenticatedMacCandidateArchive(input)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  });

  it.each(['archive URL', 'channel id', 'channel repository', 'signing team'] as const)(
    'refuses independently signed foreign %s binding', async field => {
      const world = await fixture(), input = await world.input();
      if (field === 'archive URL') world.qualification.artifactUrl = 'https://example.invalid/foreign.tar.gz';
      if (field === 'channel id') world.qualification.channel!.id = 'foreign/tools/liftoff';
      if (field === 'channel repository') world.qualification.channel!.source = 'foreign/homebrew-tools';
      if (field === 'signing team') world.qualification.platformSigningIdentity = 'FOREIGN123';
      world.resign();
      await expect(verifyAuthenticatedMacCandidateArchive(input)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it.each(['record', 'signature', 'publicKey', 'archive', 'provenance', 'evidence', 'stableTag', 'draft', 'prerelease'] as const)(
    'independently refuses changed %s after candidate admission', async field => {
      const world = await fixture(), input = await world.input();
      if (field === 'record') input.material.record[0] ^= 1;
      if (field === 'signature') input.material.signature[0] ^= 1;
      if (field === 'publicKey') input.material.publicKey[0] ^= 1;
      if (field === 'archive') world.assets.get(world.record.files[0].filename)![0] ^= 1;
      if (field === 'provenance') world.assets.get('provenance.json')![0] ^= 1;
      if (field === 'evidence') input.material.platformEvidence.values().next().value![0] ^= 1;
      if (field === 'stableTag') input.material.stableTag = 'v0.13.1';
      if (field === 'draft') input.material.draft = true;
      if (field === 'prerelease') input.material.prerelease = true;
      await expect(verifyAuthenticatedMacCandidateArchive(input)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it.each([
    { name: 'traversal', member: { name: '../outside', kind: '0' } },
    { name: 'absolute path', member: { name: '/outside', kind: '0' } },
    { name: 'case alias', member: { name: './BUNDLE.json', kind: '0' } },
    { name: 'duplicate', member: { name: './bundle.json', kind: '0' } },
    { name: 'hard link', member: { name: './hard', kind: '1', target: 'bundle.json' } },
    { name: 'FIFO', member: { name: './fifo', kind: '6' } },
    { name: 'device', member: { name: './device', kind: '3' } },
    { name: 'special permissions', member: { name: './special', kind: '0', mode: 0o4755 } },
    { name: 'missing parent', member: { name: './missing/file', kind: '0' } },
    { name: 'symlink parent', member: { name: './bin/alias/file', kind: '0' } },
    { name: 'escaping symlink', member: { name: './escape', kind: '2', target: '../outside' } },
    { name: 'absolute symlink', member: { name: './escape', kind: '2', target: '/outside' } },
    { name: 'dangling symlink', member: { name: './dangling', kind: '2', target: 'missing' } },
    { name: 'cyclic symlink', member: { name: './cycle', kind: '2', target: 'cycle' } },
    { name: 'sparse extension', member: { name: './pax', kind: 'x', content: paxRecord('GNU.sparse.map', '0,1') } },
    { name: 'global path override', member: { name: './pax', kind: 'g', content: paxRecord('path', 'bundle.json') } }
  ])('refuses publisher-signed $name', async ({ member }) => {
    const world = await fixture();
    world.publish(tar([...world.members, member]));
    await expect(verifyAuthenticatedMacCandidateArchive(await world.input())).rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it.each(['source', 'version', 'target', 'runtime', 'launcher', 'releaseReady', 'inventory', 'changed file', 'unclaimed file'] as const)(
    'refuses a signed archive with invalid %s subject or inventory', async field => {
      const world = await fixture();
      if (field === 'source') world.manifest.source.commit = '0'.repeat(40);
      if (field === 'version') world.manifest.package.version = '0.13.1';
      if (field === 'target') world.manifest.platform.architecture = 'x64';
      if (field === 'runtime') world.manifest.runtime.executable = 'application/cli.js';
      if (field === 'launcher') world.manifest.launcher = 'runtime/node';
      if (field === 'releaseReady') world.manifest.releaseReady = false;
      if (field === 'inventory') world.manifest.inventory.entries.pop();
      if (field === 'changed file') world.members.find(member => member.name === './runtime/node')!.content = Buffer.from('changed');
      if (field === 'unclaimed file') world.members.push({ name: './foreign', kind: '0' });
      world.publish();
      await expect(verifyAuthenticatedMacCandidateArchive(await world.input())).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it('uses private material, policy and candidate snapshots across asynchronous admission/inflation', async () => {
    const world = await fixture(), input = await world.input();
    const limits = { ...contract.nativeBundleLimits };
    const pending = verifyAuthenticatedMacCandidateArchive({ ...input, contract: { ...contract, nativeBundleLimits: limits } });
    input.material.signature.fill(0);
    world.assets.get(world.record.files[0].filename)!.fill(0);
    input.candidate.manifestSha256 = '0'.repeat(64);
    input.policy.homebrew.developerTeamId = null;
    limits.entries = 0;
    expect((await pending).inventory).toEqual(world.manifest.inventory);
  });

  it('does not promote a caller-provided local bundle locator to installed identity', async () => {
    const world = await fixture(), input = await world.input();
    input.material.bundleRoot = world.source;
    input.candidate.bundleRoot = world.source;
    const observed = await verifyAuthenticatedMacCandidateArchive(input);
    expect(observed.candidate).not.toHaveProperty('bundleRoot');
    expect(observed).not.toHaveProperty('installation');
    expect(observed.inventory).toEqual(world.manifest.inventory);
  });

  it.each(['entries', 'depth', 'fileBytes', 'totalBytes'] as const)(
    'preserves the canonical %s threshold through Mac verification', async kind => {
      const world = await fixture(), input = await world.input();
      const boundary = kind === 'entries' ? world.manifest.inventory.entries.length
        : kind === 'depth' ? 2 : kind === 'totalBytes' ? world.manifest.inventory.totalBytes
        : Math.max(...world.members.map(member => member.content?.length ?? 0));
      const limits = { ...contract.nativeBundleLimits, [kind]: boundary };
      const observed = await verifyAuthenticatedMacCandidateArchive({
        ...input, contract: { ...contract, nativeBundleLimits: limits }
      });
      expect(observed.inventory).toEqual(world.manifest.inventory);
      await expect(verifyAuthenticatedMacCandidateArchive({
        ...input, contract: { ...contract, nativeBundleLimits: { ...limits, [kind]: boundary - 1 } }
      })).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it('honors an already aborted caller without inflation', async () => {
    const world = await fixture(), input = await world.input();
    const before = vi.mocked(gunzip).mock.calls.length;
    await expect(verifyAuthenticatedMacCandidateArchive({ ...input, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ reasonCode: 'native_timeout' });
    expect(vi.mocked(gunzip).mock.calls.length).toBe(before);
  });

  it('cancels actual mid-inflation work instead of waiting for full expansion', async () => {
    const world = await fixture();
    const padded = Buffer.alloc(32 * 1024 * 1024);
    tar(world.members).copy(padded);
    world.publish(padded);
    const input = await world.input(), controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
    const completions: string[] = [];
    vi.mocked(gunzip).mockImplementationOnce((bytes, options, callback) =>
      actual.gunzip(bytes, options, (error, output) => {
        completions.push(error?.name ?? 'completed');
        callback(error, output);
      }));
    const pending = verifyAuthenticatedMacCandidateArchive({ ...input, signal: controller.signal });
    const refusal = expect(pending).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await new Promise<void>(resolve => setImmediate(() => { controller.abort(); resolve(); }));
    await refusal;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completions).toEqual(['AbortError']);
  });

  it('enforces the overall deadline during real asynchronous inflation', async () => {
    const world = await fixture(), input = await world.input();
    vi.useFakeTimers();
    const inflate = vi.mocked(gunzip).mockImplementationOnce((_bytes, options, callback) => {
      if (!('signal' in options) || !(options.signal instanceof AbortSignal)) throw new Error('Missing inflation signal');
      options.signal.addEventListener('abort', () => callback(new Error('Fixture interrupted'), Buffer.alloc(0)), { once: true });
      return undefined;
    });
    const before = inflate.mock.calls.length;
    const pending = verifyAuthenticatedMacCandidateArchive(input);
    const refusal = expect(pending).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await vi.advanceTimersByTimeAsync(0);
    expect(inflate.mock.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(selfUpgradeInstallTimeoutMs);
    await refusal;
  });
});
