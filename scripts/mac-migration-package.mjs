#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { bundleFile, bundleInventory, bundlePath } from './native-bundle-contract.mjs';
import { verifyNativeBundle } from './native-bundle.mjs';

const source = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function macMigrationPackageArguments(args) {
  assert.equal(args.length, 4, 'Use --bundle <verified-development-bundle> --output <new-independent-directory>.');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--bundle', '--output'].includes(args[index]) && !options[args[index]], 'Unknown or duplicate package option.');
    assert.ok(path.isAbsolute(args[index + 1]), 'Standalone package paths must be absolute.');
    options[args[index]] = path.resolve(args[index + 1]);
  }
  return { bundle: options['--bundle'], output: options['--output'] };
}

export async function packageMacMigration({ bundle, output }) {
  assert.ok(process.platform === 'darwin' && process.arch === 'arm64', 'Standalone migration packaging requires native Apple Silicon.');
  const manifest = await verifyNativeBundle(bundle);
  assert.equal(manifest.platform.platform, 'darwin');
  assert.equal(manifest.platform.architecture, 'arm64');
  const nativeRoot = await realpath(bundle);
  const root = path.join(await realpath(path.dirname(output)), path.basename(output));
  assert.ok(root !== source && !root.startsWith(`${source}${path.sep}`) && root !== nativeRoot &&
    !root.startsWith(`${nativeRoot}${path.sep}`), 'Standalone output must be independent of the checkout and original bundle.');
  try { await lstat(root); assert.fail('Standalone output already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = await bundleInventory(nativeRoot);
  const nativeManifest = await bundleFile(path.join(nativeRoot, 'bundle.json'));
  assert.ok(before.entries.some(entry => entry.path === 'application/dist/cli/mac-migration.js'),
    'The verified bundle does not contain this migration source.');
  await mkdir(root, { mode: 0o755 });
  await mkdir(path.join(root, 'core'));
  for (const entry of before.entries) {
    const relative = bundlePath(entry.path);
    const destination = path.join(root, 'core', relative);
    if (entry.kind === 'directory') await mkdir(destination, { mode: entry.mode });
    else if (entry.kind === 'file') {
      await copyFile(path.join(nativeRoot, relative), destination, constants.COPYFILE_EXCL);
      await chmod(destination, entry.mode);
    } else await symlink(entry.target, destination);
  }
  await copyFile(path.join(nativeRoot, 'bundle.json'), path.join(root, 'core/bundle.json'), constants.COPYFILE_EXCL);
  assert.deepEqual(await bundleInventory(nativeRoot), before, 'Original bundle changed during standalone packaging.');
  assert.deepEqual(await bundleInventory(path.join(root, 'core')), before, 'Standalone runtime/assets/notices differ.');
  assert.deepEqual(await bundleFile(path.join(nativeRoot, 'bundle.json')), nativeManifest, 'Original manifest changed.');
  assert.deepEqual(await bundleFile(path.join(root, 'core/bundle.json')), nativeManifest, 'Copied manifest differs.');
  await mkdir(path.join(root, 'bin'));
  const launcher = path.join(source, 'distribution/mac-migration/launcher.sh');
  const launcherBefore = await bundleFile(launcher);
  await copyFile(launcher, path.join(root, 'bin/liftoff-migrate-npm'), constants.COPYFILE_EXCL);
  await chmod(path.join(root, 'bin/liftoff-migrate-npm'), 0o755);
  assert.deepEqual(await bundleFile(launcher), launcherBefore);
  const inventory = await bundleInventory(root);
  const result = {
    schemaVersion: 1, kind: 'liftoff-standalone-mac-npm-migration-development-package',
    source: manifest.source, version: manifest.package.version, releaseReady: false,
    publicMigrationQualified: false, nativeManifestSha256: nativeManifest.sha256,
    launcherSha256: (await bundleFile(path.join(root, 'bin/liftoff-migrate-npm'))).sha256,
    inventory, licenseInventory: manifest.dependencies, supplementalNotices: manifest.supplementalNotices
  };
  await writeFile(path.join(root, 'migration.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return { output: root, sha256: hash(Buffer.from(JSON.stringify(result))), releaseReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await packageMacMigration(macMigrationPackageArguments(process.argv.slice(2))))); }
  catch (error) { console.error(`Standalone migration packaging refused: ${error.message}`); process.exitCode = 1; }
}
