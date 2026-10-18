#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFile, bundleInventory, bundlePath, readBundleFile } from './native-bundle-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse((await readBundleFile(file)).content.toString('utf8'));
const transactionName = '.native-install-transaction.json';

async function absent(file) {
  try { await lstat(file); return false; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
}

async function ownedDirectory(directory) {
  assert.ok(path.isAbsolute(directory) && path.resolve(directory) === directory, 'Native paths must be absolute and canonical.');
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Native prefix must be an existing real directory.');
  assert.equal(stat.uid, process.getuid(), 'Native prefix must belong to the invoking user.');
  assert.equal(stat.mode & 0o077, 0, 'Native prefix must have private user-only permissions.');
  assert.equal(stat.mode & 0o7000, 0, 'Native prefix cannot have special permission bits.');
  assert.equal(await realpath(directory), path.resolve(directory), 'Native prefix cannot have linked ancestors.');
  return { dev: stat.dev, ino: stat.ino };
}

async function unchangedDirectory(directory, identity) {
  assert.deepEqual(await ownedDirectory(directory), identity, 'Native prefix ownership changed.');
}

async function verifiedBundle(root, expectedDigest) {
  assert.match(expectedDigest ?? '', /^[a-f0-9]{64}$/, 'An independently reviewed bundle manifest digest is required.');
  assert.ok((await lstat(root)).isDirectory(), 'Installation source cannot be a link.');
  const inspected = await readBundleFile(path.join(root, 'bundle.json'));
  assert.equal(inspected.identity.sha256, expectedDigest,
    'Reviewed bundle manifest changed.');
  const manifest = JSON.parse(inspected.content.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'liftoff-native-development-bundle', 'Unknown native bundle format.');
  assert.equal(manifest.package.name, '@msn-control/liftoff');
  assert.match(manifest.package.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.platform.platform, 'linux', 'The owned archive installer is Linux-only.');
  assert.ok(['x64', 'arm64'].includes(manifest.platform.architecture), 'Unsupported Linux architecture.');
  assert.equal(manifest.launcher, 'bin/liftoff');
  assert.equal(manifest.runtime.executable, 'runtime/node');
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/, 'Native bundle source identity is malformed.');
  assert.equal(typeof manifest.releaseReady, 'boolean');
  assert.deepEqual(await bundleInventory(root), manifest.inventory, 'Install source inventory changed.');
  for (const file of [manifest.launcher, manifest.runtime.executable]) {
    assert.equal((await bundleFile(path.join(root, file))).mode, 0o755, 'Install entrypoint is not executable.');
  }
  return manifest;
}

function receipt(manifest, prefix, manifestSha256) {
  return {
    schemaVersion: 1, kind: 'liftoff-native-install-receipt', owner: 'liftoff-native',
    prefixSha256: hash(prefix), manifestSha256, inventorySha256: manifest.inventory.sha256,
    package: manifest.package.name, version: manifest.package.version, sourceCommit: manifest.source.commit,
    target: `${manifest.platform.platform}-${manifest.platform.architecture}`,
    releaseReady: manifest.releaseReady,
    launcher: 'bin/liftoff', runtime: 'runtime/node'
  };
}

async function inspect(prefix) {
  const current = path.join(prefix, 'current');
  const launcher = path.join(prefix, 'bin/liftoff');
  if (await absent(current)) {
    assert.ok(await absent(launcher), 'An existing launcher has no attributable installation.');
    return null;
  }
  for (const directory of ['versions', 'receipts', 'bin']) await ownedDirectory(path.join(prefix, directory));
  assert.ok((await lstat(current)).isSymbolicLink(), 'Current installation is not an owned version link.');
  const target = bundlePath(await readlink(current));
  assert.match(target, /^versions\/[0-9A-Za-z.-]+-[a-f0-9]{64}$/, 'Current version link is not attributable.');
  assert.equal(await realpath(current), path.join(prefix, target), 'Current installation escapes its prefix.');
  assert.ok((await lstat(launcher)).isSymbolicLink(), 'An unrelated launcher occupies the native destination.');
  assert.equal(await readlink(launcher), '../current/bin/liftoff', 'Native launcher ownership differs.');
  const saved = await json(path.join(prefix, 'receipts', `${path.basename(target)}.json`));
  const manifest = await verifiedBundle(path.join(prefix, target), saved.manifestSha256);
  assert.deepEqual(saved, receipt(manifest, prefix, saved.manifestSha256), 'Native installation receipt differs.');
  return target;
}

export async function inspectOwnedInstallation(prefix) {
  await ownedDirectory(prefix);
  return inspect(prefix);
}

async function releaseStaleLock(prefix, lock, expectedDigest) {
  assert.match(expectedDigest ?? '', /^[a-f0-9]{64}$/, 'A stale lock requires its explicitly selected owner digest.');
  const identity = await ownedDirectory(lock);
  assert.deepEqual(await readdir(lock), ['owner.json'], 'Unknown lock material must be retained.');
  const ownerPath = path.join(lock, 'owner.json');
  const inspected = await readBundleFile(ownerPath, 4096);
  const ownerIdentity = inspected.identity;
  assert.equal(ownerIdentity.sha256, expectedDigest, 'Selected stale lock owner changed.');
  const owner = JSON.parse(inspected.content.toString('utf8'));
  assert.equal(owner.schemaVersion, 1);
  assert.equal(owner.kind, 'liftoff-native-install-lock');
  assert.equal(owner.prefixSha256, hash(prefix), 'The selected lock belongs to another prefix.');
  assert.match(owner.nonce, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Lock process identity is unavailable.');
  let dead = false;
  try { process.kill(owner.pid, 0); } catch (error) {
    assert.equal(error.code, 'ESRCH', 'Lock process liveness is unknown; retain the lock.');
    dead = true;
  }
  assert.ok(dead, 'An active or reused lock process must not be displaced.');
  await unchangedDirectory(lock, identity);
  assert.deepEqual(await bundleFile(ownerPath, 4096), ownerIdentity, 'Stale lock changed before release.');
  await rm(ownerPath);
  await rmdir(lock);
}

async function withLock(prefix, operation, expectedStaleLockSha256) {
  const identity = await ownedDirectory(prefix);
  const lock = path.join(prefix, '.native-install-lock');
  if (!await absent(lock)) {
    if (expectedStaleLockSha256 === undefined) {
      throw new Error('Native installation is locked; explicit selected stale-owner recovery is required.');
    }
    await releaseStaleLock(prefix, lock, expectedStaleLockSha256);
  } else assert.equal(expectedStaleLockSha256, undefined, 'The selected stale lock no longer exists.');
  await unchangedDirectory(prefix, identity);
  await mkdir(lock, { mode: 0o700 });
  const lockIdentity = await lstat(lock);
  const ownerPath = path.join(lock, 'owner.json');
  const ownerBytes = `${JSON.stringify({ schemaVersion: 1, kind: 'liftoff-native-install-lock',
    prefixSha256: hash(prefix), pid: process.pid, nonce: randomUUID() })}\n`;
  await writeFile(ownerPath, ownerBytes, { flag: 'wx', mode: 0o600 });
  try {
    return await operation(identity);
  } finally {
    await unchangedDirectory(prefix, identity);
    const current = await lstat(lock);
    assert.ok(current.isDirectory() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino,
      'Native installation lock changed; it is retained.');
    assert.equal((await bundleFile(ownerPath, 4096)).sha256, hash(ownerBytes), 'Lock owner changed; it is retained.');
    await rm(ownerPath);
    await rmdir(lock);
  }
}

/**
 * @param {{ source: string, prefix: string, expectedManifestSha256: string,
 *   expectedCurrent: string | null, development?: boolean,
 *   admitHost: () => unknown | Promise<unknown>, interruptAt?: string }} options
 */
export async function installOwnedBundle({
  source, prefix, expectedManifestSha256, expectedCurrent, development = false,
  admitHost, interruptAt
}) {
  assert.equal(typeof admitHost, 'function', 'Native host admission must run before installation changes.');
  await admitHost();
  assert.ok(expectedCurrent === null || typeof expectedCurrent === 'string', 'Explicit reviewed current ownership is required.');
  const manifest = await verifiedBundle(source, expectedManifestSha256);
  assert.ok(development || manifest.releaseReady === true,
    'Unsigned development bundles are not public installation artifacts.');
  return withLock(prefix, async identity => {
    assert.ok(await absent(path.join(prefix, transactionName)), 'Pending installation requires explicit recovery.');
    const previous = await inspect(prefix);
    assert.equal(previous, expectedCurrent, 'Reviewed current installation changed.');
    const name = `${manifest.package.version}-${expectedManifestSha256}`;
    const target = `versions/${name}`;
    const stage = `versions/.pending-${randomUUID()}`;
    const final = path.join(prefix, target);
    for (const directory of ['versions', 'receipts', 'bin']) {
      const destination = path.join(prefix, directory);
      if (await absent(destination)) await mkdir(destination, { mode: 0o700 });
      await ownedDirectory(destination);
    }
    const savedReceipt = receipt(manifest, prefix, expectedManifestSha256);
    const receiptPath = path.join(prefix, 'receipts', `${name}.json`);
    const retained = !await absent(final);
    if (retained) {
      await verifiedBundle(final, expectedManifestSha256);
      assert.deepEqual(await json(receiptPath), savedReceipt, 'Retained immutable version is not attributable.');
    } else assert.ok(await absent(receiptPath), 'An unrelated receipt occupies the immutable version destination.');
    if (previous === target) return { status: 'already-installed', current: target, receipt: savedReceipt };
    const journal = { schemaVersion: 1, kind: 'liftoff-native-install-transaction',
      prefixSha256: hash(prefix), previous, target, stage, next: `.native-next-${randomUUID()}`,
      manifestSha256: expectedManifestSha256, receipt: savedReceipt };
    const journalBytes = `${JSON.stringify(journal, null, 2)}\n`;
    await writeFile(path.join(prefix, transactionName), journalBytes, { flag: 'wx', mode: 0o600 });
    if (!retained) {
      await cp(source, path.join(prefix, stage), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await verifiedBundle(source, expectedManifestSha256);
      await verifiedBundle(path.join(prefix, stage), expectedManifestSha256);
    }
    await unchangedDirectory(prefix, identity);
    assert.equal(await inspect(prefix), previous, 'Installation changed while preparing its replacement.');
    if (!retained) {
      await rename(path.join(prefix, stage), final);
      await writeFile(receiptPath, `${JSON.stringify(journal.receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (interruptAt === 'before-switch') throw new Error('Interrupted before the owned version switch.');
    const next = path.join(prefix, journal.next);
    await symlink(target, next);
    if (interruptAt === 'before-launcher') throw new Error('Interrupted before creating the first launcher.');
    if (previous === null) await symlink('../current/bin/liftoff', path.join(prefix, 'bin/liftoff'));
    if (interruptAt === 'after-launcher') throw new Error('Interrupted after creating the first launcher.');
    await unchangedDirectory(prefix, identity);
    if (previous !== null) assert.equal(await inspect(prefix), previous, 'Current version changed before switching.');
    else assert.ok(await absent(path.join(prefix, 'current')), 'Current version appeared before switching.');
    assert.equal((await bundleFile(path.join(prefix, transactionName))).sha256, hash(journalBytes), 'Installation journal changed.');
    await rename(next, path.join(prefix, 'current'));
    if (interruptAt === 'after-switch') throw new Error('Interrupted after the owned version switch.');
    assert.equal(await inspect(prefix), target, 'Replacement ownership did not verify.');
    await rm(path.join(prefix, transactionName));
    return { status: 'installed', current: target, receipt: journal.receipt };
  });
}

/** @param {{ prefix: string, expectedJournalSha256: string, expectedStaleLockSha256?: string }} options */
export async function recoverOwnedInstallation({ prefix, expectedJournalSha256, expectedStaleLockSha256 }) {
  assert.match(expectedJournalSha256 ?? '', /^[a-f0-9]{64}$/, 'Recovery requires the exact selected journal digest.');
  assert.equal((await bundleFile(path.join(prefix, transactionName))).sha256, expectedJournalSha256,
    'Selected recovery journal changed.');
  return withLock(prefix, async identity => {
    const journalPath = path.join(prefix, transactionName);
    assert.equal((await bundleFile(journalPath)).sha256, expectedJournalSha256, 'Selected recovery journal changed.');
    const journal = await json(journalPath);
    assert.equal(journal.schemaVersion, 1);
    assert.equal(journal.kind, 'liftoff-native-install-transaction');
    assert.equal(journal.prefixSha256, hash(prefix), 'Recovery belongs to another prefix.');
    assert.match(journal.stage, /^versions\/\.pending-[a-f0-9-]{36}$/);
    assert.match(journal.next, /^\.native-next-[a-f0-9-]{36}$/);
    assert.equal(journal.target, `versions/${journal.receipt.version}-${journal.manifestSha256}`);
    bundlePath(journal.target);
    if (journal.previous !== null) {
      assert.match(journal.previous, /^versions\/[0-9A-Za-z.-]+-[a-f0-9]{64}$/);
      const old = await json(path.join(prefix, 'receipts', `${path.basename(journal.previous)}.json`));
      const oldManifest = await verifiedBundle(path.join(prefix, journal.previous), old.manifestSha256);
      assert.deepEqual(old, receipt(oldManifest, prefix, old.manifestSha256), 'Previous installation is no longer recoverable.');
    }
    const currentPath = path.join(prefix, 'current');
    const current = await absent(currentPath) ? null : await inspect(prefix);
    assert.ok(current === journal.previous || current === journal.target,
      'Recovery refuses a newer or unrelated installation owner.');
    for (const candidate of [journal.stage, journal.target]) {
      if (!await absent(path.join(prefix, candidate))) {
        const manifest = await verifiedBundle(path.join(prefix, candidate), journal.manifestSha256);
        assert.deepEqual(journal.receipt, receipt(manifest, prefix, journal.manifestSha256), 'Recovery material changed.');
      }
    }
    await unchangedDirectory(prefix, identity);
    const launcherPath = path.join(prefix, 'bin/liftoff');
    if (current === null && !await absent(launcherPath)) {
      assert.equal(journal.previous, null, 'An unrelated orphan launcher must be retained.');
      assert.ok((await lstat(launcherPath)).isSymbolicLink(), 'An unrelated orphan launcher must be retained.');
      assert.equal(await readlink(launcherPath), '../current/bin/liftoff', 'Orphan launcher attribution changed.');
      await rm(launcherPath);
    }
    const nextPath = path.join(prefix, journal.next);
    if (!await absent(nextPath)) {
      assert.ok((await lstat(nextPath)).isSymbolicLink(), 'Pending version pointer attribution changed.');
      assert.equal(await readlink(nextPath), journal.target, 'Pending version pointer changed.');
      await rm(nextPath);
    }
    if (current === journal.target) {
      if (journal.previous === null) {
        await rm(currentPath);
        await rm(path.join(prefix, 'bin/liftoff'));
      } else {
        const recovered = path.join(prefix, `.native-recovered-${randomUUID()}`);
        await symlink(journal.previous, recovered);
        assert.equal(await inspect(prefix), journal.target, 'Current ownership changed during recovery.');
        await rename(recovered, currentPath);
      }
    }
    // Keep verified immutable versions for diagnosis/offline recovery; never sweep a prefix.
    assert.equal((await bundleFile(journalPath)).sha256, expectedJournalSha256, 'Recovery journal changed.');
    await rm(journalPath);
    const retained = [];
    for (const candidate of [journal.stage, journal.target]) {
      if (!await absent(path.join(prefix, candidate))) retained.push(candidate);
    }
    return { status: 'recovered', current: journal.previous, retained };
  }, expectedStaleLockSha256);
}

async function main() {
  const [operation, prefix, digest, expectedCurrent, ...extra] = process.argv.slice(2);
  assert.equal(process.platform, 'linux', 'This owned installer is Linux-only.');
  assert.ok(prefix && path.isAbsolute(prefix) && extra.length === 0, 'An explicit existing private prefix is required.');
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { assertNativeHost, observeNativeHost } = await import(pathToFileURL(path.join(source, 'installation/host.mjs')).href);
  if (operation === 'recover') {
    assertNativeHost(observeNativeHost());
    console.log(JSON.stringify(await recoverOwnedInstallation({ prefix, expectedJournalSha256: digest,
      expectedStaleLockSha256: expectedCurrent })));
  } else {
    assert.equal(operation, 'install', 'Usage: native-install.mjs install <prefix> <reviewed-manifest-sha256> <none|current-target> | recover <prefix> <journal-sha256> [selected-stale-owner-sha256]');
    console.log(JSON.stringify(await installOwnedBundle({ source, prefix, expectedManifestSha256: digest,
      expectedCurrent: expectedCurrent === 'none' ? null : expectedCurrent,
      admitHost: () => assertNativeHost(observeNativeHost(), { publicInstallation: true }) })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Native installation incomplete; any recorded recovery material is retained: ${error.message}`);
    process.exitCode = 1;
  });
}
