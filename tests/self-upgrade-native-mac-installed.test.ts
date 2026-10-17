import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleInventory, nativeBundleLimits } from '../distribution/native/native-bundle-contract.mjs';
import { inspectMacInstalledCandidate } from '../src/adapters/distribution/native-mac-installed.js';
import { admitNativeStableMaterial } from '../src/adapters/distribution/native-metadata.js';
import { signedMaterial } from './fixtures/native-stable-material.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(releaseReady = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf inert installed ')));
  roots.push(root);
  const bundleRoot = path.join(root, 'candidate');
  const original = signedMaterial('darwin-arm64');
  for (const directory of ['runtime', 'bin', 'application/dist', 'application/assets', 'installation']) {
    await mkdir(path.join(bundleRoot, directory), { recursive: true });
  }
  const tripwire = path.join(root, 'must remain absent');
  for (const name of ['runtime/node', 'bin/liftoff']) {
    await writeFile(path.join(bundleRoot, name), `#!/bin/sh\nprintf invoked > ${JSON.stringify(tripwire)}\nexit 91\n`, { mode: 0o755 });
  }
  await writeFile(path.join(bundleRoot, 'application/dist/cli.js'), 'throw new Error("Do not execute candidate CLI");\n');
  await writeFile(path.join(bundleRoot, 'application/assets/data.json'), '{"fixtureOnly":true}\n');
  await symlink('assets/data.json', path.join(bundleRoot, 'application/data-link'));
  for (const name of ['native-bundle-contract.mjs', 'native-install.mjs', 'native-release-admission.mjs', 'release-policy.json']) {
    await writeFile(path.join(bundleRoot, 'installation', name), 'throw new Error("Do not load candidate helper");\n');
  }
  const inventory = await bundleInventory(bundleRoot);
  const manifest = { schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady,
    package: { name: '@msn-control/liftoff', version: '0.13.0' },
    source: { repository: original.policy.repository, commit: original.record.commit },
    platform: { platform: 'darwin', architecture: 'arm64' }, launcher: 'bin/liftoff',
    runtime: { executable: 'runtime/node' }, inventory };
  const seal = async () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(bundleRoot, 'bundle.json'), bytes);
    original.record.manifestSha256 = hash(bytes);
    original.record.inventorySha256 = manifest.inventory.sha256;
    original.qualification.manifestSha256 = original.record.manifestSha256;
    original.qualification.inventorySha256 = original.record.inventorySha256;
    const sbom = JSON.parse(original.assets.get('sbom.cdx.json')!.toString());
    sbom.properties.find((item: { name: string }) => item.name === 'liftoff:inventorySha256').value = manifest.inventory.sha256;
    original.assets.set('sbom.cdx.json', Buffer.from(JSON.stringify(sbom)));
    for (const file of original.record.files) {
      file.sha256 = hash(original.assets.get(file.filename)!);
      file.bytes = original.assets.get(file.filename)!.length;
    }
    original.resign();
    return admitNativeStableMaterial(original.material, { target: 'darwin-arm64' }, original.policy);
  };
  const candidate = await seal();
  const options = { bundleRoot, material: original.material, candidate, policy: original.policy,
    signal: new AbortController().signal };
  return { root, bundleRoot, tripwire, original, manifest, seal, options };
}

describe.skipIf(process.platform === 'win32')('inert authenticated Mac installed-directory inventory', () => {
  it.each([true, false])('compares the complete directory without executing candidates at development releaseReady=%s', async releaseReady => {
    const value = await fixture(releaseReady);
    const before = await bundleInventory(value.bundleRoot);
    const observed = await inspectMacInstalledCandidate(value.options);
    expect(observed).toMatchObject({ bundleRoot: value.bundleRoot,
      packageRoot: path.join(value.bundleRoot, 'application'), target: 'darwin-arm64', version: '0.13.0',
      manifestSha256: value.options.candidate.manifestSha256, inventorySha256: before.sha256 });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed).not.toHaveProperty('owner');
    expect(observed).not.toHaveProperty('archiveMembersVerified');
    expect(observed.bundleRoot).not.toBe(value.options.candidate.bundleRoot);
    expect(await bundleInventory(value.bundleRoot)).toEqual(before);
    await expect(readFile(value.tripwire)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['signature', 'archive', 'identity', 'manifest', 'inventory', 'source', 'target', 'policy'] as const)(
    'refuses changed authenticated %s binding before invoking the inventory callback', async change => {
      const value = await fixture();
      if (change === 'signature') value.options.material.signature[0] ^= 1;
      if (change === 'archive') value.original.assets.set('liftoff-0.13.0-darwin-arm64.tar.gz', Buffer.from('different archive'));
      if (change === 'identity') value.options.candidate.identity = '0'.repeat(64);
      if (change === 'manifest') value.options.candidate.manifestSha256 = '0'.repeat(64);
      if (change === 'inventory') value.options.candidate.inventorySha256 = '0'.repeat(64);
      if (change === 'source') value.options.candidate.sourceCommit = '0'.repeat(40);
      if (change === 'target') value.options.candidate.target = 'linux-arm64';
      if (change === 'policy') value.options.policy.homebrew.developerTeamId = 'DIFFERENT1';
      const reader = vi.fn(bundleInventory);
      await expect(inspectMacInstalledCandidate(value.options, reader)).rejects.toThrow();
      expect(reader).not.toHaveBeenCalled();
      await expect(readFile(value.tripwire)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it.each(['runtime', 'helper', 'asset', 'mode', 'extra', 'missing', 'escape', 'hard-link', 'manifest'] as const)(
    'refuses changed installed %s without executing any candidate bytes', async change => {
      const value = await fixture();
      if (change === 'runtime') await writeFile(path.join(value.bundleRoot, 'runtime/node'), 'changed runtime');
      if (change === 'helper') await writeFile(path.join(value.bundleRoot, 'installation/native-bundle-contract.mjs'), 'changed helper');
      if (change === 'asset') await writeFile(path.join(value.bundleRoot, 'application/assets/data.json'), 'changed asset');
      if (change === 'mode') await chmod(path.join(value.bundleRoot, 'runtime/node'), 0o644);
      if (change === 'extra') await writeFile(path.join(value.bundleRoot, 'untracked'), 'unexpected bytes');
      if (change === 'missing') await unlink(path.join(value.bundleRoot, 'application/assets/data.json'));
      if (change === 'escape') {
        await unlink(path.join(value.bundleRoot, 'application/data-link'));
        await symlink('../../outside', path.join(value.bundleRoot, 'application/data-link'));
      }
      if (change === 'hard-link') await link(path.join(value.bundleRoot, 'runtime/node'), path.join(value.root, 'runtime alias'));
      if (change === 'manifest') await writeFile(path.join(value.bundleRoot, 'bundle.json'), '{}');
      await expect(inspectMacInstalledCandidate(value.options)).rejects.toThrow();
      await expect(readFile(value.tripwire)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('refuses a symlinked root rather than following a candidate path hint', async () => {
    const value = await fixture();
    const alias = path.join(value.root, 'alias');
    await symlink(value.bundleRoot, alias);
    await expect(inspectMacInstalledCandidate({ ...value.options, bundleRoot: alias })).rejects.toThrow();
  });

  it.each(['runtime', 'directory', 'extra', 'manifest'] as const)(
    'detects %s changes after the trusted inventory callback observed the original bytes', async change => {
      const value = await fixture();
      await expect(inspectMacInstalledCandidate(value.options, async (...args) => {
        const observed = await bundleInventory(...args);
        if (change === 'runtime') {
          const file = path.join(value.bundleRoot, 'runtime/node');
          const bytes = await readFile(file);
          await unlink(file); await writeFile(file, bytes, { mode: 0o755 });
        }
        if (change === 'directory') {
          const file = path.join(value.bundleRoot, 'application/assets');
          await rename(file, `${file}-moved`); await mkdir(file);
        }
        if (change === 'extra') await writeFile(path.join(value.bundleRoot, 'new child'), 'intervening bytes');
        if (change === 'manifest') await writeFile(path.join(value.bundleRoot, 'bundle.json'), JSON.stringify(value.manifest));
        return observed;
      })).rejects.toThrow();
    });

  it('retains the exact trusted callback failure instead of returning empty or successful inventory', async () => {
    const value = await fixture();
    const failure = new Error('retained callback observation failure');
    await expect(inspectMacInstalledCandidate(value.options, async () => { throw failure; })).rejects.toBe(failure);
  });

  it.each([9_999, 10_000, 10_001])('enforces the exact 10000ms elapsed inventory budget at %sms', async elapsed => {
    const value = await fixture();
    const start = performance.now();
    let clock = start;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const result = inspectMacInstalledCandidate(value.options, async (...args) => {
      const inventory = await bundleInventory(...args);
      clock += elapsed;
      return inventory;
    });
    if (elapsed < 10_000) await expect(result).resolves.toMatchObject({ target: 'darwin-arm64' });
    else await expect(result).rejects.toMatchObject({ reasonCode: 'native_timeout' });
  });

  it('refuses an already aborted observation without starting its inventory callback', async () => {
    const value = await fixture();
    const controller = new AbortController(); controller.abort();
    const reader = vi.fn(bundleInventory);
    await expect(inspectMacInstalledCandidate({ ...value.options, signal: controller.signal }, reader))
      .rejects.toMatchObject({ reasonCode: 'native_timeout' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('refuses an in-flight abort without pretending to forcibly settle the non-abortable inventory callback', async () => {
    const value = await fixture();
    const controller = new AbortController();
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let settled = false;
    const result = inspectMacInstalledCandidate({ ...value.options, signal: controller.signal }, async (...args) => {
      started(); await pending;
      const inventory = await bundleInventory(...args);
      settled = true;
      return inventory;
    });
    const refusal = expect(result).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await entered;
    controller.abort();
    await refusal;
    expect(settled).toBe(false);
    finish();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it('rejects signed inventories above the exact entry budget before any inventory callback', async () => {
    const value = await fixture();
    value.manifest.inventory.entries = Array.from({ length: nativeBundleLimits.entries + 1 }, (_, index) =>
      ({ path: `entry-${index}`, kind: 'directory', mode: 0o755 }));
    value.manifest.inventory.sha256 = hash(JSON.stringify(value.manifest.inventory.entries));
    value.options.candidate = await value.seal();
    const reader = vi.fn(bundleInventory);
    await expect(inspectMacInstalledCandidate(value.options, reader)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(['file-bytes', 'total-bytes', 'depth', 'alias', 'path', 'runtime-mode'] as const)(
    'rejects the signed %s bound before a potentially expensive callback', async change => {
      const value = await fixture();
      if (change === 'file-bytes') {
        const entry = value.manifest.inventory.entries.find(entry => entry.path === 'runtime/node');
        if (!entry || entry.kind !== 'file') throw new Error('Missing test runtime');
        entry.bytes = nativeBundleLimits.fileBytes + 1;
      }
      if (change === 'total-bytes') value.manifest.inventory.totalBytes = nativeBundleLimits.totalBytes + 1;
      if (change === 'depth') value.manifest.inventory.entries[0].path = Array(nativeBundleLimits.depth + 1).fill('entry').join('/');
      if (change === 'alias') value.manifest.inventory.entries.push({ ...value.manifest.inventory.entries[0],
        path: value.manifest.inventory.entries[0].path.toUpperCase() });
      if (change === 'path') value.manifest.inventory.entries[0].path = '../escape';
      if (change === 'runtime-mode') {
        const entry = value.manifest.inventory.entries.find(entry => entry.path === 'runtime/node');
        if (!entry || entry.kind !== 'file') throw new Error('Missing test runtime');
        entry.mode = 0o644;
      }
      value.manifest.inventory.sha256 = hash(JSON.stringify(value.manifest.inventory.entries));
      value.options.candidate = await value.seal();
      const reader = vi.fn(bundleInventory);
      await expect(inspectMacInstalledCandidate(value.options, reader)).rejects.toThrow();
      expect(reader).not.toHaveBeenCalled();
    });

  it('snapshots caller-owned admission inputs rather than adopting mutations during inventory', async () => {
    const value = await fixture();
    const observed = await inspectMacInstalledCandidate(value.options, async (...args) => {
      value.options.candidate.version = '9.9.9';
      value.options.policy.homebrew.cask = 'different/tools/liftoff';
      value.options.material.record.fill(0);
      return bundleInventory(...args);
    });
    expect(observed.version).toBe('0.13.0');
  });

  it('does not substitute detached Linux archive keys for Mac release approval', async () => {
    const value = await fixture();
    value.options.material.archiveSignature = Buffer.from('irrelevant Linux signature');
    value.options.material.archivePublicKey = Buffer.from('irrelevant Linux key');
    await expect(inspectMacInstalledCandidate(value.options)).resolves.toMatchObject({ target: 'darwin-arm64' });
    value.options.policy.approvedSigningKeySha256 = null;
    await expect(inspectMacInstalledCandidate(value.options)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  });
});
