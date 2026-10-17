import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contract from '../scripts/native-bundle-contract.mjs';
import { stageAuthenticatedNativeArchive } from '../src/adapters/distribution/native-archive.js';
import { defaultSelfUpgradeDependencies } from '../src/adapters/distribution/upgrade-host.js';
import type { NativeCandidate } from '../src/domain/distribution/native-upgrade.js';
import { NodeCommandRunner } from '../src/process-runner.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface TarMember { name: string; kind: string; content?: Buffer; target?: string; mode?: number }
function header(member: TarMember): Buffer {
  const bytes = Buffer.alloc(512);
  if (Buffer.byteLength(member.name) > 100) throw new Error('Use a GNU or PAX fixture for long paths.');
  bytes.write(member.name, 0, 100);
  const octal = (value: number, offset: number, length: number) =>
    bytes.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  octal(member.mode ?? 0o755, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8);
  octal(member.content?.length ?? 0, 124, 12); octal(0, 136, 12);
  bytes.fill(32, 148, 156);
  bytes.write(member.kind, 156, 1);
  bytes.write(member.target ?? '', 157, 100);
  bytes.write('ustar\0', 257, 6); bytes.write('00', 263, 2);
  octal(bytes.reduce((sum, byte) => sum + byte, 0), 148, 8);
  return bytes;
}
function tar(members: TarMember[]): Buffer {
  return Buffer.concat([...members.flatMap(member => {
    const content = member.content ?? Buffer.alloc(0);
    return [header(member), content, Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length)];
  }), Buffer.alloc(1024)]);
}
function paxRecord(name: string, value: string) {
  const body = `${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const next = Buffer.byteLength(body) + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${body}`);
    length = next;
  }
}

async function fixture() {
  const host = defaultSelfUpgradeDependencies();
  const source = await host.makeNeutralDirectory();
  directories.push(source);
  for (const name of ['bin', 'runtime', 'application']) await mkdir(path.join(source, name), { mode: 0o755 });
  for (const [name, content] of [
    ['bin/liftoff', '# fixture launcher, never executed\n'],
    ['runtime/node', '# fixture runtime, never executed\n'],
    ['application/cli.js', 'throw new Error("must not execute extracted fixture code");\n']
  ]) {
    await writeFile(path.join(source, name), content, { mode: 0o755 });
    await chmod(path.join(source, name), 0o755);
  }
  await symlink('liftoff', path.join(source, 'bin/alias'));
  const manifest = {
    schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: true,
    package: { name: '@msn-control/liftoff', version: '0.13.0' },
    source: { repository: 'voyager163/liftoff', commit: 'a'.repeat(40) },
    platform: { platform: 'linux', architecture: 'x64' }, launcher: 'bin/liftoff',
    runtime: { executable: 'runtime/node' }, inventory: await contract.bundleInventory(source)
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(source, 'bundle.json'), manifestBytes, { mode: 0o644 });
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
  const key = generateKeyPairSync('ed25519');
  const candidate: NativeCandidate = {
    version: '0.13.0', target: 'linux-x64', sourceCommit: 'a'.repeat(40),
    manifestSha256: hash(manifestBytes), inventorySha256: manifest.inventory.sha256, identity: 'fixture-authenticated-candidate'
  };
  const makeNeutralDirectory = vi.fn(async () => {
    const directory = await host.makeNeutralDirectory();
    directories.push(directory);
    return directory;
  });
  const storage = { ...host, makeNeutralDirectory };
  const signArchive = (bytes = tar(members)) => {
    const archive = gzipSync(bytes);
    return { archive, signature: sign(null, archive, key.privateKey),
      publicKey: Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' })),
      expectedKeySha256: hash(key.publicKey.export({ type: 'spki', format: 'der' })),
      candidate: { ...candidate, archiveSha256: hash(archive) }, contract, storage,
      signal: new AbortController().signal };
  };
  return { source, members, manifest, candidate, storage, signArchive };
}

describe.skipIf(process.platform === 'win32')('inert authenticated Linux archive staging', () => {
  it('matches the shared inventory before and after extraction without executing bundled code', async () => {
    const world = await fixture();
    const material = world.signArchive();
    const stage = await stageAuthenticatedNativeArchive(material);
    expect(await contract.bundleInventory(stage.bundleRoot)).toEqual(world.manifest.inventory);
    expect(await readFile(path.join(path.dirname(stage.bundleRoot), 'archive.tar.gz'))).toEqual(material.archive);
    expect(await readlink(path.join(stage.bundleRoot, 'bin/alias'))).toBe('liftoff');
    expect((await lstat(stage.bundleRoot)).mode & 0o077).toBe(0);
    await stage.dispose();
    await expect(lstat(stage.bundleRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(world.source)).isDirectory()).toBe(true);
  });

  it('accepts the real host TAR long-path layout under the shared inventory contract', async () => {
    const world = await fixture();
    const name = 'long-portable-path-'.repeat(7);
    await mkdir(path.join(world.source, 'application', name));
    await writeFile(path.join(world.source, 'application', name, 'module.js'), '# inert long-path fixture\n', { mode: 0o644 });
    world.manifest.inventory = await contract.bundleInventory(world.source);
    const manifest = Buffer.from(JSON.stringify(world.manifest));
    await writeFile(path.join(world.source, 'bundle.json'), manifest);
    world.candidate.manifestSha256 = hash(manifest);
    world.candidate.inventorySha256 = world.manifest.inventory.sha256;
    const output = await defaultSelfUpgradeDependencies().makeNeutralDirectory();
    directories.push(output);
    const archive = path.join(output, 'fixture.tar.gz');
    const result = await new NodeCommandRunner().run({
      executable: contract.nativeArchiveTool(), args: ['--no-xattrs', '-czf', archive, '-C', world.source, '.']
    }, { cwd: output, env: { PATH: '/usr/bin:/bin', HOME: output, COPYFILE_DISABLE: '1', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
      inheritEnvironment: false, ensureProcessTreeSettled: true, timeoutMs: 15_000, maxOutputBytes: 8192 });
    expect(result).toMatchObject({ status: 0, timedOut: false, signal: null });
    const stage = await stageAuthenticatedNativeArchive(world.signArchive(gunzipSync(await readFile(archive))));
    expect(await contract.bundleInventory(stage.bundleRoot)).toEqual(world.manifest.inventory);
    await stage.dispose();
  });

  it.each(['entries', 'depth', 'fileBytes', 'totalBytes'] as const)(
    'enforces the exact shared %s threshold without changing production limits', async kind => {
      const world = await fixture();
      const boundary = kind === 'entries' ? world.manifest.inventory.entries.length
        : kind === 'depth' ? 2 : kind === 'totalBytes' ? world.manifest.inventory.totalBytes
        : Math.max(...world.members.map(member => member.content?.length ?? 0));
      const material = world.signArchive();
      const limits = { ...contract.nativeBundleLimits, [kind]: boundary };
      const stage = await stageAuthenticatedNativeArchive({ ...material, contract: { ...contract, nativeBundleLimits: limits } });
      await stage.dispose();
      await expect(stageAuthenticatedNativeArchive({
        ...material, contract: { ...contract, nativeBundleLimits: { ...limits, [kind]: boundary - 1 } }
      })).rejects.toMatchObject({ reasonCode: 'native_invalid' });
      expect(world.storage.makeNeutralDirectory).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds actual gzip expansion at the last complete permitted TAR block', async () => {
    const world = await fixture();
    const limits = { ...contract.nativeBundleLimits, entries: world.manifest.inventory.entries.length,
      totalBytes: world.manifest.inventory.totalBytes };
    const maximum = limits.totalBytes + limits.entries * 16_384 + 8 * 1024 * 1024;
    const length = Math.floor(maximum / 512) * 512;
    const bytes = Buffer.alloc(length);
    tar(world.members).copy(bytes);
    const stage = await stageAuthenticatedNativeArchive({
      ...world.signArchive(bytes), contract: { ...contract, nativeBundleLimits: limits }
    });
    await stage.dispose();
    await expect(stageAuthenticatedNativeArchive({
      ...world.signArchive(Buffer.concat([bytes, Buffer.alloc(512)])),
      contract: { ...contract, nativeBundleLimits: limits }
    })).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(world.storage.makeNeutralDirectory).toHaveBeenCalledTimes(1);
  });

  it('stages only private snapshots when caller buffers and candidate mutate during decompression', async () => {
    const world = await fixture();
    const material = world.signArchive();
    const expected = Buffer.from(material.archive);
    const pending = stageAuthenticatedNativeArchive(material);
    material.archive.fill(0);
    material.signature.fill(0);
    material.publicKey.fill(0);
    material.candidate.manifestSha256 = '0'.repeat(64);
    const stage = await pending;
    expect(await readFile(path.join(path.dirname(stage.bundleRoot), 'archive.tar.gz'))).toEqual(expected);
    expect(await contract.bundleInventory(stage.bundleRoot)).toEqual(world.manifest.inventory);
    await stage.dispose();
  });

  it.each(['digest', 'signature', 'principal', 'manifest', 'inventory', 'target', 'aborted'] as const)(
    'refuses mismatched %s before creating a stage', async kind => {
      const world = await fixture();
      const material = world.signArchive();
      if (kind === 'digest') material.candidate.archiveSha256 = '0'.repeat(64);
      if (kind === 'signature') material.signature[0] ^= 1;
      if (kind === 'principal') material.expectedKeySha256 = '0'.repeat(64);
      if (kind === 'manifest') material.candidate.manifestSha256 = '0'.repeat(64);
      if (kind === 'inventory') material.candidate.inventorySha256 = '0'.repeat(64);
      if (kind === 'target') material.candidate.target = 'darwin-arm64';
      if (kind === 'aborted') material.signal = AbortSignal.abort();
      await expect(stageAuthenticatedNativeArchive(material)).rejects.toMatchObject({
        reasonCode: kind === 'aborted' ? 'native_install_timeout' : 'native_invalid'
      });
      expect(world.storage.makeNeutralDirectory).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: 'traversal', member: { name: '../outside', kind: '0', content: Buffer.from('escape') } },
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
    { name: 'self link', member: { name: './cycle', kind: '2', target: 'cycle' } },
    { name: 'sparse extension', member: { name: './pax', kind: 'x', content: paxRecord('GNU.sparse.map', '0,1') } },
    { name: 'global path override', member: { name: './pax', kind: 'g', content: paxRecord('path', 'bundle.json') } }
  ])('rejects signed $name without trusting archive extraction side effects', async ({ member }) => {
    const world = await fixture();
    world.members.push(member);
    await expect(stageAuthenticatedNativeArchive(world.signArchive())).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(world.storage.makeNeutralDirectory).not.toHaveBeenCalled();
  });

  it.each(['checksum', 'footer', 'trailing archive', 'truncated body', 'unclaimed member', 'changed file'] as const)(
    'rejects signed %s before staging', async kind => {
      const world = await fixture();
      let bytes = tar(world.members);
      if (kind === 'checksum') bytes[0] ^= 1;
      if (kind === 'footer') bytes = bytes.subarray(0, bytes.length - 512);
      if (kind === 'trailing archive') bytes = Buffer.concat([bytes, tar([{ name: 'foreign', kind: '0' }])]);
      if (kind === 'truncated body') bytes = bytes.subarray(0, bytes.length - 1400);
      if (kind === 'unclaimed member') bytes = tar([...world.members, { name: 'foreign', kind: '0' }]);
      if (kind === 'changed file') bytes = tar(world.members.map(member => member.name === './runtime/node'
        ? { ...member, content: Buffer.from('changed') } : member));
      await expect(stageAuthenticatedNativeArchive(world.signArchive(bytes))).rejects.toMatchObject({ reasonCode: 'native_invalid' });
      expect(world.storage.makeNeutralDirectory).not.toHaveBeenCalled();
    }
  );

  it.each(['x', 'L'] as const)('supports an exact %s path extension without evaluating it', async kind => {
    const world = await fixture();
    const index = world.members.findIndex(member => member.name === './bundle.json');
    world.members.splice(index, 0, { name: './extended', kind,
      content: kind === 'x' ? paxRecord('path', './bundle.json') : Buffer.from('./bundle.json\0') });
    world.members[index + 1] = { ...world.members[index + 1], name: './header-placeholder' };
    const stage = await stageAuthenticatedNativeArchive(world.signArchive());
    expect(await contract.bundleInventory(stage.bundleRoot)).toEqual(world.manifest.inventory);
    await stage.dispose();
  });

  it('retains the private authenticated stage when post-write verification fails', async () => {
    const world = await fixture();
    const material = world.signArchive();
    const readBytes = vi.fn(material.storage.readBytes!);
    readBytes.mockImplementation(async (filename, maximum) => filename.endsWith('bundle.json')
      ? Buffer.from('changed') : material.storage.readBytes!(filename, maximum));
    await expect(stageAuthenticatedNativeArchive({ ...material, storage: { ...material.storage, readBytes } }))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
    const directory = await world.storage.makeNeutralDirectory.mock.results[0].value;
    expect(await readFile(path.join(directory, 'archive.tar.gz'))).toEqual(material.archive);
    expect((await lstat(path.join(directory, 'bundle'))).isDirectory()).toBe(true);
  });
});
