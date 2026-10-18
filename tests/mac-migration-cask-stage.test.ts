import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCaskStageWritePlan } from '../distribution/native/cask-stage-worker.mjs';
import { nativeBundleLimits } from '../distribution/native/native-bundle-contract.mjs';
import { prepareCaskMigrationTarget, readCaskMigrationTarget, stageCaskMigrationTarget } from '../src/adapters/distribution/mac-migration-cask-stage.js';
import { MacMigrationJournalStore, type MigrationJournal } from '../src/adapters/distribution/mac-migration-state.js';
import * as state from '../src/adapters/distribution/mac-migration-state.js';
import { migrationDirectory } from '../src/adapters/distribution/mac-npm-owner.js';
import { admitNativeStableMaterial, snapshotNativeStableMaterial } from '../src/adapters/distribution/native-metadata.js';
import * as archive from '../src/adapters/distribution/native-archive.js';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { selfUpgradeInstallTimeoutMs } from '../src/domain/distribution/liftoff-upgrade.js';
import { MacMigrationFailure } from '../src/domain/distribution/mac-migration.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import { signedMaterial } from './fixtures/native-stable-material.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
const worker = fileURLToPath(new URL('../distribution/native/cask-stage-worker.mjs', import.meta.url));
const files = ['release.json', 'qualification.json', 'qualification.sig', 'qualification.pub',
  'archive.tar.gz', 'sbom.cdx.json', 'provenance.json', 'NOTICE', 'definition.rb'];
const fixtures: Awaited<ReturnType<typeof macMigrationFixture>>[] = [];
const directoryPhysical = async (root: string) => {
  const stat = await lstat(root, { bigint: true });
  return JSON.stringify((['dev', 'ino', 'uid', 'gid', 'mode'] as const).map(key => String(stat[key])));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function plan(root: string, directoryIdentity = 'unselected', mode: 'create' | 'manifest' = 'create') {
  return { schemaVersion: 1, kind: 'liftoff-cask-stage-write', mode, root, directoryIdentity,
    files: (mode === 'create' ? files : ['snapshot.json']).map(name => ({ name, bytes: 1, sha256: hash('x') })) };
}

function request(value: ReturnType<typeof plan>, body = Buffer.from('x'.repeat(value.files.length))) {
  const header = Buffer.from(JSON.stringify(value)), length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return { header: Buffer.concat([length, header]), body, all: Buffer.concat([length, header, body]) };
}

async function fixture() {
  const value = await macMigrationFixture();
  fixtures.push(value);
  const candidate = await admitNativeStableMaterial(value.material, { target: 'darwin-arm64' }, value.policy);
  const root = path.join(value.root, 'private target journal');
  const store = new MacMigrationJournalStore(root);
  await store.initialize();
  const journal = { root, rootIdentity: await migrationDirectory(root) };
  const prepare = () => prepareCaskMigrationTarget({ material: value.material, candidate, policy: value.policy, signal: signal() });
  const stage = async () => stageCaskMigrationTarget(await prepare(), journal, signal());
  return { ...value, candidate, journal, store, prepare, stage };
}

describe('private cask stage transport has a closed, bounded non-executable plan', () => {
  it.each(['create', 'manifest'] as const)('admits the exact %s transport shape only', mode => {
    const value = plan(path.resolve('private-fixture'), 'unselected', mode);
    expect(parseCaskStageWritePlan(value)).toBe(value);
  });

  it.each(['schema', 'kind', 'mode', 'relative-root', 'normalized-root', 'control-root', 'identity',
    'extra', 'empty', 'duplicate', 'escape', 'foreign', 'zero', 'fractional', 'oversized', 'digest', 'file-extra',
    'missing-required', 'unexpected-manifest', 'multiple-manifests'] as const)('refuses %s', change => {
    const value = plan(path.resolve('private-fixture'));
    if (change === 'schema') value.schemaVersion = 2;
    if (change === 'kind') value.kind = 'installer-authority';
    if (change === 'mode') Object.assign(value, { mode: 'publish' });
    if (change === 'relative-root') value.root = 'relative';
    if (change === 'normalized-root') value.root = `${value.root}/.`;
    if (change === 'control-root') value.root += '\n';
    if (change === 'identity') value.directoryIdentity = 'x'.repeat(1025);
    if (change === 'extra') Object.assign(value, { executable: 'unapproved' });
    if (change === 'empty') value.files = [];
    if (change === 'duplicate') value.files.push({ ...value.files[0] });
    if (change === 'escape') value.files[0].name = '../foreign';
    if (change === 'foreign') value.files[0].name = 'foreign';
    if (change === 'zero') value.files[0].bytes = 0;
    if (change === 'fractional') value.files[0].bytes = 1.5;
    if (change === 'oversized') value.files[0].bytes = 8 * 1024 * 1024 + 1;
    if (change === 'digest') value.files[0].sha256 = 'foreign';
    if (change === 'file-extra') Object.assign(value.files[0], { target: 'foreign' });
    if (change === 'missing-required') value.files.pop();
    if (change === 'unexpected-manifest') value.files.push({ name: 'snapshot.json', bytes: 1, sha256: hash('x') });
    if (change === 'multiple-manifests') Object.assign(value, { ...plan(value.root, 'unselected', 'manifest'),
      files: [{ name: 'snapshot.json', bytes: 1, sha256: hash('x') }, { name: 'snapshot.json', bytes: 1, sha256: hash('x') }] });
    expect(() => parseCaskStageWritePlan(value)).toThrow();
  });

  it.each([['archive.tar.gz', 256 * 1024 * 1024], ['qualification.sig', 64], ['qualification.pub', 4096],
    ['release.json', 8 * 1024 * 1024], ['snapshot.json', 64 * 1024]] as const)(
    'enforces the exact %s declared byte limit before allocation', (name, limit) => {
      const value = plan(path.resolve('private-fixture'), 'unselected', name === 'snapshot.json' ? 'manifest' : 'create');
      const file = value.files.find(file => file.name === name)!;
      file.bytes = limit;
      expect(parseCaskStageWritePlan(value)).toBe(value);
      file.bytes += 1;
      expect(() => parseCaskStageWritePlan(value)).toThrow();
    });

  it('admits all 41 subjects at their per-file limits but refuses an additional evidence subject', () => {
    const value = plan(path.resolve('private-fixture'));
    for (let index = 0; index < 32; index++) {
      value.files.push({ name: `evidence-${index}.bin`, bytes: 8 * 1024 * 1024, sha256: hash('inert') });
    }
    for (const file of value.files) {
      file.bytes = file.name === 'archive.tar.gz' ? 256 * 1024 * 1024 : file.name === 'qualification.sig' ? 64
        : file.name === 'qualification.pub' ? 4096 : 8 * 1024 * 1024;
    }
    expect(value.files.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(nativeBundleLimits.totalBytes);
    expect(parseCaskStageWritePlan(value)).toBe(value);
    value.files.push({ name: 'evidence-32.bin', bytes: 1, sha256: hash('x') });
    expect(() => parseCaskStageWritePlan(value)).toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('authenticated inert offline cask target custody', () => {
  it('writes exact multi-chunk binary payloads and attests the actual creation-held files', async () => {
    const world = await fixture(), value = plan(world.journal.root, await directoryPhysical(world.journal.root));
    const payload = value.files.map((file, index) => {
      const bytes = file.name === 'archive.tar.gz' ? Buffer.alloc(2 * 64 * 1024 + 17) : Buffer.from([index, 0, 255]);
      if (file.name === 'archive.tar.gz') for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 251;
      file.bytes = bytes.length;
      file.sha256 = hash(bytes);
      return bytes;
    });
    const result = await new NodeCommandRunner().run({ executable: process.execPath, args: [worker] }, {
      cwd: world.journal.root, env: { DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: '' },
      inheritEnvironment: false, stdin: request(value, Buffer.concat(payload)).all, ensureProcessTreeSettled: true,
      timeoutMs: 10_000, maxOutputBytes: 64 * 1024
    });
    expect(result).toMatchObject({ status: 0, stderr: '', processSpawned: true, processTreeSettled: true });
    const receipt = JSON.parse(result.stdout);
    expect(receipt.files.map((file: { name: string }) => file.name)).toEqual(files);
    for (const [index, file] of value.files.entries()) {
      expect(await readFile(path.join(world.journal.root, 'cask-target', file.name))).toEqual(payload[index]);
    }
  });

  it.each(['truncated-length', 'oversized-header', 'truncated-header', 'invalid-utf8', 'truncated-payload',
    'wrong-digest', 'trailing-input', 'wrong-identity', 'wrong-cwd', 'non-private-cwd', 'unexpected-argument'] as const)(
    'refuses actual %s input with a fixed redacted worker failure', async change => {
      const world = await fixture(), value = plan(world.journal.root, await directoryPhysical(world.journal.root));
      if (change === 'wrong-digest') value.files[0].sha256 = '0'.repeat(64);
      if (change === 'wrong-identity') value.directoryIdentity = 'foreign';
      if (change === 'wrong-cwd') value.root = path.join(world.root, 'unselected');
      if (change === 'non-private-cwd') await chmod(world.journal.root, 0o755);
      let input = request(value).all;
      if (change === 'truncated-length') input = Buffer.from([0, 0]);
      if (change === 'oversized-header' || change === 'truncated-header') {
        input = Buffer.alloc(4);
        input.writeUInt32BE(change === 'oversized-header' ? 64 * 1024 + 1 : 100);
      }
      if (change === 'invalid-utf8') input = Buffer.from([0, 0, 0, 1, 255]);
      if (change === 'truncated-payload') input = request(value, Buffer.from('x'.repeat(files.length - 1))).all;
      if (change === 'trailing-input') input = Buffer.concat([input, Buffer.from('foreign')]);
      const result = await new NodeCommandRunner().run({ executable: process.execPath,
        args: [worker, ...(change === 'unexpected-argument' ? ['unselected'] : [])] }, {
        cwd: world.journal.root, env: { DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', NODE_OPTIONS: '', NODE_PATH: '' },
        inheritEnvironment: false, stdin: input, ensureProcessTreeSettled: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024
      });
      expect(result).toMatchObject({ status: 1, stdout: '', stderr: 'liftoff-cask-target-stage:refused\n',
        processSpawned: true, processTreeSettled: true });
      expect(await readFile(path.join(world.oldPackage, 'dist/cli.js'), 'utf8')).toContain('Liftoff 0.12.3');
      await expect(lstat(path.join(world.journal.root, 'cask-target', 'snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('persists every exact authenticated byte before removal without extracting or executing the archive', async () => {
    const world = await fixture(), beforeCwd = process.cwd();
    const stage = await world.stage();
    const material = await readCaskMigrationTarget({ stage, candidate: world.candidate, policy: world.policy, signal: signal() });
    expect(Object.isFrozen(stage)).toBe(true);
    expect(stage.root).toBe(path.join(world.journal.root, 'cask-target'));
    expect(material.record).toEqual(world.material.record);
    expect(material.qualification).toEqual(world.material.qualification);
    expect(material.signature).toEqual(world.material.signature);
    expect(material.publicKey).toEqual(world.material.publicKey);
    expect(material.assets).toEqual(world.material.assets);
    expect(material.platformEvidence).toEqual(world.material.platformEvidence);
    expect(material).not.toHaveProperty('bundleRoot');
    expect(material).not.toHaveProperty('archiveSignature');
    const manifest = JSON.parse(await readFile(path.join(stage.root, 'snapshot.json'), 'utf8'));
    expect(manifest.files).toHaveLength(15);
    expect(manifest.evidence).toHaveLength(6);
    expect((await readdir(stage.root)).sort()).toEqual([...manifest.files.map((file: { name: string }) => file.name), 'snapshot.json'].sort());
    expect(await readFile(path.join(stage.root, 'definition.rb'), 'utf8')).toContain('cask "liftoff"');
    expect((await lstat(stage.root)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(stage.root)) {
      const stat = await lstat(path.join(stage.root, name));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    expect(process.cwd()).toBe(beforeCwd);
    expect(await readFile(path.join(world.oldPackage, 'dist/cli.js'), 'utf8')).toContain('Liftoff 0.12.3');
  });

  it('snapshots preparation inputs before asynchronous admission and does not retain borrowed Linux signatures', async () => {
    const world = await fixture(), original = snapshotNativeStableMaterial(world.material);
    world.material.archiveSignature = Buffer.from('unrelated');
    world.material.archivePublicKey = Buffer.from('unrelated');
    const pending = world.prepare();
    world.material.signature.fill(0);
    world.material.assets.get('NOTICE')!.fill(0);
    const stage = await stageCaskMigrationTarget(await pending, world.journal, signal());
    const material = await readCaskMigrationTarget({ stage, candidate: world.candidate, policy: world.policy, signal: signal() });
    expect(material.signature).toEqual(original.signature);
    expect(material.assets.get('NOTICE')).toEqual(original.assets.get('NOTICE'));
    expect(material).not.toHaveProperty('archiveSignature');
    expect(material).not.toHaveProperty('archivePublicKey');
  });

  it('refuses a cryptographically signed assertion whose supposed archive is not the actual package inventory', async () => {
    const world = signedMaterial('darwin-arm64');
    const candidate = await admitNativeStableMaterial(world.material, { target: 'darwin-arm64' }, world.policy);
    await expect(prepareCaskMigrationTarget({ material: world.material, candidate, policy: world.policy, signal: signal() }))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it.each(['signature', 'archive', 'evidence', 'candidate', 'policy'] as const)('refuses changed %s before staging', async change => {
    const world = await fixture();
    if (change === 'signature') world.material.signature.fill(0);
    if (change === 'archive') world.material.assets.get(`liftoff-${world.candidate.version}-darwin-arm64.tar.gz`)![0] ^= 1;
    if (change === 'evidence') world.material.platformEvidence.values().next().value![0] ^= 1;
    if (change === 'candidate') world.candidate.manifestSha256 = '0'.repeat(64);
    if (change === 'policy') world.policy.homebrew.cask = null;
    await expect(world.prepare()).rejects.toThrow();
    await expect(lstat(path.join(world.journal.root, 'cask-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['bytes', 'same-byte-rewrite', 'same-byte-inode', 'manifest-inode', 'hardlink', 'symlink',
    'permissions', 'directory', 'extra-member', 'candidate', 'policy'] as const)('refuses retained %s drift', async change => {
    const world = await fixture(), stage = await world.stage(), selected = path.join(stage.root, 'NOTICE');
    if (change === 'bytes') await writeFile(selected, 'changed target material');
    if (change === 'same-byte-rewrite') await writeFile(selected, await readFile(selected));
    if (change === 'same-byte-inode' || change === 'manifest-inode') {
      const file = change === 'manifest-inode' ? path.join(stage.root, 'snapshot.json') : selected;
      const bytes = await readFile(file);
      await rename(file, path.join(world.root, 'original-retained'));
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    }
    if (change === 'hardlink') await link(selected, path.join(world.root, 'retained-hardlink'));
    if (change === 'symlink') { await unlink(selected); await symlink(path.join(world.root, 'foreign-target'), selected); }
    if (change === 'permissions') await chmod(selected, 0o644);
    if (change === 'directory') await chmod(stage.root, 0o755);
    if (change === 'extra-member') await writeFile(path.join(stage.root, 'foreign'), 'retain me', { mode: 0o600 });
    if (change === 'candidate') world.candidate.sourceCommit = '0'.repeat(40);
    if (change === 'policy') world.policy.homebrew.developerTeamId = 'FOREIGN123';
    await expect(readCaskMigrationTarget({ stage, candidate: world.candidate, policy: world.policy, signal: signal() }))
      .rejects.toThrow();
    if (change === 'extra-member') expect(await readFile(path.join(stage.root, 'foreign'), 'utf8')).toBe('retain me');
  });

  it('does not let mutation of a returned material snapshot modify the retained stage', async () => {
    const world = await fixture(), stage = await world.stage();
    const input = { stage, candidate: world.candidate, policy: world.policy, signal: signal() };
    const first = await readCaskMigrationTarget(input);
    first.assets.get('NOTICE')!.fill(0);
    first.signature.fill(0);
    const second = await readCaskMigrationTarget(input);
    expect(second.assets.get('NOTICE')).toEqual(world.material.assets.get('NOTICE'));
    expect(second.signature).toEqual(world.material.signature);
  });

  it('rechecks every retained payload after asynchronous archive authentication', async () => {
    const world = await fixture(), stage = await world.stage(), original = archive.verifyNativeArchiveInventory;
    vi.spyOn(archive, 'verifyNativeArchiveInventory').mockImplementation(async options => {
      const value = await original(options);
      await writeFile(path.join(stage.root, 'NOTICE'), 'retain concurrent target change');
      return value;
    });
    await expect(readCaskMigrationTarget({ stage, candidate: world.candidate, policy: world.policy, signal: signal() }))
      .rejects.toMatchObject({ code: 'cask-target-stage-changed' });
    expect(await readFile(path.join(stage.root, 'NOTICE'), 'utf8')).toBe('retain concurrent target change');
  });

  it.each(['file', 'directory', 'symlink'] as const)('never replaces an occupied %s destination', async kind => {
    const world = await fixture(), root = path.join(world.journal.root, 'cask-target');
    if (kind === 'directory') { await mkdir(root, { mode: 0o700 }); await writeFile(path.join(root, 'foreign'), 'retain'); }
    if (kind === 'file') await writeFile(root, 'retain', { mode: 0o600 });
    if (kind === 'symlink') await symlink(path.join(world.root, 'unrelated'), root);
    const before = await lstat(root, { bigint: true });
    await expect(world.stage()).rejects.toMatchObject({ code: 'cask-target-stage-write-failed' });
    const after = await lstat(root, { bigint: true });
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const) {
      expect(after[key]).toBe(before[key]);
    }
    if (kind === 'file') expect(await readFile(root, 'utf8')).toBe('retain');
    if (kind === 'directory') expect(await readFile(path.join(root, 'foreign'), 'utf8')).toBe('retain');
  });

  it('refuses cloned preparation handles and stale journal ownership without starting a writer', async () => {
    const world = await fixture(), prepared = await world.prepare(), runner = { run: vi.fn() };
    await expect(stageCaskMigrationTarget({ ...prepared }, world.journal, signal(), runner)).rejects.toThrow();
    await expect(stageCaskMigrationTarget(prepared, { ...world.journal, rootIdentity: 'changed' }, signal(), runner))
      .rejects.toMatchObject({ code: 'cask-target-stage-changed' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('honors pre-abort without preparation, filesystem writes or child dispatch', async () => {
    const world = await fixture(), prepared = await world.prepare(), abort = new AbortController();
    abort.abort();
    const runner = { run: vi.fn() };
    await expect(prepareCaskMigrationTarget({ material: world.material, candidate: world.candidate,
      policy: world.policy, signal: abort.signal })).rejects.toMatchObject({ code: 'cask-target-stage-aborted' });
    await expect(stageCaskMigrationTarget(prepared, world.journal, abort.signal, runner))
      .rejects.toMatchObject({ code: 'cask-target-stage-aborted' });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(lstat(path.join(world.journal.root, 'cask-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform !== 'darwin').each(['acl', 'attribute', 'flags'] as const)(
    'refuses unpreservable journal %s before starting the private payload writer', async kind => {
      const world = await fixture(), prepared = await world.prepare(), runner = { run: vi.fn() }, actual = new NodeCommandRunner();
      const root = world.journal.root, attribute = 'org.liftoff.cask-stage-fixture';
      const execute = async (executable: string, args: string[]) => {
        const result = await actual.run({ executable, args }, {
          cwd: '/', env: { PATH: '/usr/bin:/bin', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
          inheritEnvironment: false, timeoutMs: 10_000, ensureProcessTreeSettled: true
        });
        expect(result).toMatchObject({ status: 0, stderr: '', processTreeSettled: true });
      };
      try {
        if (kind === 'acl') await execute('/bin/chmod', ['+a', `user:${userInfo().username} allow read`, root]);
        if (kind === 'attribute') await execute('/usr/bin/xattr', ['-w', attribute, 'retain exact fixture', root]);
        if (kind === 'flags') await execute('/usr/bin/chflags', ['hidden', root]);
        await expect(stageCaskMigrationTarget(prepared, world.journal, signal(), runner))
          .rejects.toMatchObject({ code: 'unrecoverable-mac-metadata' });
        expect(runner.run).not.toHaveBeenCalled();
        await expect(lstat(path.join(root, 'cask-target'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (kind === 'acl') await execute('/bin/chmod', ['-N', root]);
        if (kind === 'attribute') await execute('/usr/bin/xattr', ['-d', attribute, root]);
        if (kind === 'flags') await execute('/usr/bin/chflags', ['nohidden', root]);
      }
    });

  it.each(['abort', 'timeout'] as const)('invalidates a delayed writer on %s and drains it without late spawn or descriptor', async how => {
    const world = await fixture(), prepared = await world.prepare(), abort = new AbortController(), actual = new NodeCommandRunner();
    const entered = deferred<void>(), release = deferred<void>(), settled = deferred<CommandResult>();
    const runner: CommandRunner = { run: vi.fn(async (command, options) => {
      entered.resolve();
      await release.promise;
      const result = await actual.run(command, options);
      settled.resolve(result);
      return result;
    }) };
    if (how === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = stageCaskMigrationTarget(prepared, world.journal, abort.signal, runner);
    const failed = expect(pending).rejects.toMatchObject({
      code: how === 'abort' ? 'cask-target-stage-aborted' : 'cask-target-stage-timeout'
    });
    try {
      await entered.promise;
      if (how === 'abort') abort.abort();
      else await vi.advanceTimersByTimeAsync(selfUpgradeInstallTimeoutMs);
      await failed;
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
    const result = await settled.promise;
    expect(result).toMatchObject({ status: null, aborted: true, errorCode: 'ABORT_ERR',
      errorMessage: 'Command was cancelled before it started.' });
    expect(result.processSpawned).not.toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
    await expect(lstat(path.join(world.journal.root, 'cask-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['failed', 'unspawned', 'unsettled', 'timeout', 'aborted', 'truncated', 'stderr', 'invalid-json',
    'success-summary', 'oversized-output', 'unknown-field', 'missing-files', 'duplicate-file', 'foreign-file'] as const)(
    'refuses a success-shaped writer result with %s', async change => {
      const world = await fixture(), prepared = await world.prepare();
      const runner: CommandRunner = { run: vi.fn(async (command, options) => {
        const bytes = Buffer.from(options!.stdin!);
        const value = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE()).toString('utf8'));
        const receipt = { schemaVersion: 1, kind: 'liftoff-cask-stage-written', directoryIdentity: 'unselected',
          files: value.files.map((file: { name: string }) => ({ name: file.name, physical: 'unselected' })) };
        if (change === 'unknown-field') Object.assign(receipt, { installAuthority: true });
        if (change === 'missing-files') receipt.files.pop();
        if (change === 'duplicate-file') receipt.files[1] = receipt.files[0];
        if (change === 'foreign-file') receipt.files[0].name = 'foreign';
        const result: CommandResult = { command, displayCommand: 'inert fixture', status: 0, signal: null,
          stdout: JSON.stringify(receipt), stderr: '', timedOut: false, processSpawned: true, processTreeSettled: true };
        if (change === 'failed') result.status = 1;
        if (change === 'unspawned') result.processSpawned = false;
        if (change === 'unsettled') result.processTreeSettled = false;
        if (change === 'timeout') result.timedOut = true;
        if (change === 'aborted') result.aborted = true;
        if (change === 'truncated') result.outputLimitExceeded = true;
        if (change === 'stderr') result.stderr = 'unselected warning';
        if (change === 'invalid-json') result.stdout = '{';
        if (change === 'success-summary') result.stdout = '{"success":true}';
        if (change === 'oversized-output') result.stdout = ' '.repeat(64 * 1024 + 1);
        return result;
      }) };
      await expect(stageCaskMigrationTarget(prepared, world.journal, signal(), runner)).rejects.toThrow();
      expect(runner.run).toHaveBeenCalledTimes(1);
      await expect(lstat(path.join(world.journal.root, 'cask-target'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('bounds pure archive preparation without publishing late preparation authority', async () => {
    const world = await fixture();
    vi.useFakeTimers();
    vi.spyOn(archive, 'verifyNativeArchiveInventory').mockReturnValue(new Promise(() => {}));
    const failed = expect(world.prepare()).rejects.toMatchObject({ code: 'cask-target-stage-timeout' });
    await vi.advanceTimersByTimeAsync(selfUpgradeInstallTimeoutMs);
    await failed;
  });

  it('refuses a canonical journal replacement before writer spawn and leaves every foreign byte untouched', async () => {
    const world = await fixture(), prepared = await world.prepare(), actual = new NodeCommandRunner();
    const runner: CommandRunner = { run: async (command, options) => {
      await rename(world.journal.root, path.join(world.root, 'original journal retained'));
      await mkdir(world.journal.root, { mode: 0o700 });
      await writeFile(path.join(world.journal.root, 'foreign'), 'untouched', { mode: 0o600 });
      return actual.run(command, options);
    } };
    await expect(stageCaskMigrationTarget(prepared, world.journal, signal(), runner))
      .rejects.toMatchObject({ code: 'cask-target-stage-write-failed' });
    expect(await readdir(world.journal.root)).toEqual(['foreign']);
    expect(await readFile(path.join(world.journal.root, 'foreign'), 'utf8')).toBe('untouched');
  });

  it.each(['create', 'manifest'] as const)(
    'anchors actual %s writes to the child cwd when its canonical parent is replaced after open',
    { timeout: 30_000 }, async mode => {
      const world = await fixture();
      const selected = mode === 'create' ? world.journal.root : path.join(world.journal.root, 'cask-target');
      if (mode === 'manifest') await mkdir(selected, { mode: 0o700 });
      const encoded = request(plan(selected, await directoryPhysical(selected), mode));
      const child = spawn(process.execPath, [worker], {
        cwd: selected, env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 20_000);
      try {
        child.stdin.write(encoded.header);
        const firstFile = mode === 'create' ? path.join(selected, 'cask-target', 'release.json') : path.join(selected, 'snapshot.json');
        const deadline = performance.now() + 10_000;
        for (;;) {
          try { expect((await lstat(firstFile)).size).toBe(0); break; }
          catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || performance.now() >= deadline) throw error;
            await setTimeout(5);
          }
        }
        const retained = path.join(world.root, `original ${mode} directory retained`);
        await rename(selected, retained);
        await mkdir(selected, { mode: 0o700 });
        await writeFile(path.join(selected, 'foreign'), 'untouched', { mode: 0o600 });
        child.stdin.end(encoded.body);
        expect(await closed).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe('liftoff-cask-target-stage:refused\n');
        expect(await readdir(selected)).toEqual(['foreign']);
        expect(await readFile(path.join(selected, 'foreign'), 'utf8')).toBe('untouched');
        const originalFile = mode === 'create' ? path.join(retained, 'cask-target', 'release.json') : path.join(retained, 'snapshot.json');
        expect(await readFile(originalFile, 'utf8')).toBe('x');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
    }
  );

  it('uses retained exact target material for installation verification and later inspection after stable changes', async () => {
    const world = await fixture(), cask = world.dependencies.cask!, originalInstall = cask.installExact;
    const preview = await runMacMigration(world.request, world.dependencies);
    expect(preview.status).toBe('ready');
    cask.installExact = async (...args) => {
      const retained = await readCaskMigrationTarget({ stage: args[4].targetStage, candidate: args[1],
        policy: world.policy, signal: args[4].signal });
      expect(retained.record).toEqual(world.material.record);
      const result = await originalInstall(...args);
      cask.target = async () => { throw new Error('Stable moved after this exact installation.'); };
      return result;
    };
    const installed = await runMacMigration({ ...world.request, apply: { review: preview.review!, journalRoot: world.journal.root + '-apply' } },
      world.dependencies);
    expect(installed.blockers).toEqual([]);
    expect(installed.status).toBe('installed');
    const inspected = await runMacMigration({ inspect: { journalRoot: path.dirname(installed.journal!.path),
      journalSha256: installed.journal!.sha256 } }, world.dependencies);
    expect(inspected.blockers).toEqual([]);
    expect(inspected.status).toBe('installed');
  }, 30_000);

  it('reserves recovery ledger capacity again with the persisted target descriptor before npm removal', async () => {
    const world = await fixture(), preview = await runMacMigration(world.request, world.dependencies);
    expect(preview.status).toBe('ready');
    const original = state.assertMigrationRecoveryJournalBudget;
    const observed: boolean[] = [];
    const budget = vi.spyOn(state, 'assertMigrationRecoveryJournalBudget').mockImplementation(journal => {
      original(journal);
      observed.push(journal.targetStage !== undefined);
      if (journal.targetStage) throw new MacMigrationFailure('recovery-journal-limit');
    });
    const run = vi.spyOn(world.dependencies.upgrade.runner, 'run'), install = vi.spyOn(world.dependencies.cask!, 'installExact');
    const outcome = await runMacMigration({ ...world.request,
      apply: { review: preview.review!, journalRoot: world.journal.root + '-apply' } }, world.dependencies);
    expect(outcome).toMatchObject({ status: 'blocked', effects: 'none', blockers: ['recovery-journal-limit'] });
    expect(budget).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([false, true]);
    expect(install).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
    expect(await readFile(path.join(world.oldPackage, 'dist/cli.js'), 'utf8')).toContain('Liftoff 0.12.3');
  });

  it.each(['before-npm', 'before-cask'] as const)('refuses target drift %s and preserves bounded old recovery', async when => {
    const world = await fixture(), cask = world.dependencies.cask!;
    const root = world.journal.root + '-apply', originalPreflight = cask.preflight;
    let calls = 0;
    cask.preflight = async (...args) => {
      calls += 1;
      if (calls === (when === 'before-npm' ? 3 : 4)) {
        await writeFile(path.join(root, 'cask-target', 'NOTICE'), 'concurrent target change');
      }
      return originalPreflight(...args);
    };
    const install = vi.spyOn(cask, 'installExact');
    const run = vi.spyOn(world.dependencies.upgrade.runner, 'run');
    const preview = await runMacMigration(world.request, world.dependencies);
    expect(preview.status).toBe('ready');
    const outcome = await runMacMigration({ ...world.request, apply: { review: preview.review!, journalRoot: root } }, world.dependencies);
    expect(outcome.blockers).toContain('cask-target-stage-changed');
    expect(install).not.toHaveBeenCalled();
    const uninstalls = run.mock.calls.filter(([command]) => command.args.includes('uninstall'));
    expect(uninstalls).toHaveLength(when === 'before-npm' ? 0 : 1);
    const journal = JSON.parse(await readFile(outcome.journal!.path, 'utf8')).journal as MigrationJournal;
    expect(journal.targetStage).toBeDefined();
    if (when === 'before-cask') {
      const restored = await runMacMigration({ recover: { journalRoot: root, journalSha256: outcome.journal!.sha256 } }, world.dependencies);
      expect(restored.blockers).toEqual([]);
      expect(restored.status).toBe('restored');
    }
    expect(await readFile(path.join(world.oldPackage, 'dist/cli.js'), 'utf8')).toContain('Liftoff 0.12.3');
    expect(await readFile(path.join(root, 'cask-target', 'NOTICE'), 'utf8')).toBe('concurrent target change');
  }, 30_000);
});
