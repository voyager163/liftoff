#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { collectInputs, coveragePackage } from './coverage-gate.mjs';
import {
  assertUnpackedPackageSize, installedAssetByteIssues, packagedAssetIssues, requiredPackagedAssets
} from './package-smoke-contract.mjs';
import {
  assertDependencyClosure, assertNativeBundleReport, assertNativeRuntimeArchitectures,
  assertNativeRuntimeBuildVersion, assertPortableProductionDependencies, assertSystemRuntimeLibraries,
  bundleFile, bundleInventory, bundlePath, minimumNativeMacosVersion, nativeBundleHost
} from './native-bundle-contract.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const inputsPath = path.join(repositoryRoot, 'distribution/native/inputs.json');
const builderPaths = [
  'distribution/native/inputs.json', 'distribution/native/launcher.sh',
  'scripts/native-bundle.mjs', 'scripts/native-bundle-contract.mjs',
  'scripts/package-smoke-contract.mjs', 'scripts/coverage-gate.mjs', 'scripts/clean-build.mjs'
];
const boundaries = Object.freeze({
  signed: false, notarized: false, installerOwnershipQualified: false, minimumOsQualified: true,
  upstreamHclReproducibilityQualified: false, publicNativeDistributionAdvertised: false
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const noticeName = /^(?:license|licence|copying|notice|copyright|patents)(?:[._-].*)?$/i;

async function sourceFiles(names) {
  const records = [];
  for (const name of [...names].sort()) {
    records.push({ path: bundlePath(name), ...await bundleFile(path.join(repositoryRoot, name), 12 * 1024 * 1024) });
  }
  return records;
}

function supplementalNotices(inputs) {
  return inputs.notices.flatMap(input => input.files.map(file => ({
    path: `license-notices/${input.id}/${file.path}`,
    sourceUrl: input.url, sourceMember: file.member ?? null, sha256: file.sha256
  })));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot, env: process.env, encoding: 'utf8', shell: false,
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024, ...options
  });
  assert.equal(result.status, 0,
    `${command} failed: ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout;
}

export function nativeBundleArguments(args) {
  const [operation, ...rest] = args;
  assert.ok(['build', 'verify', 'verify-report'].includes(operation),
    'Usage: native-bundle.mjs build --runtime-archive <file> --output <new-directory> | verify <bundle-directory> | verify-report <test-report>');
  if (operation === 'verify' || operation === 'verify-report') {
    assert.ok(rest.length === 1 && rest[0] && !rest[0].startsWith('-'), `${operation} needs exactly one path.`);
    return { operation, output: path.resolve(rest[0]) };
  }
  const options = {};
  assert.equal(rest.length, 4, 'build needs --runtime-archive and --output.');
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    assert.ok(['--runtime-archive', '--output'].includes(name) && !options[name],
      'Unknown or repeated native build option.');
    assert.ok(rest[i + 1] && !rest[i + 1].startsWith('-'), 'Native build option needs an explicit path.');
    options[name] = path.resolve(rest[i + 1]);
  }
  assert.ok(options['--output'] && options['--runtime-archive'], 'Native build inputs are incomplete.');
  return { operation, output: options['--output'], runtimeArchive: options['--runtime-archive'] };
}

export async function fetchNativeInput(input, maximum = 20 * 1024 * 1024) {
  assert.match(input.sha256, /^[a-f0-9]{64}$/);
  const url = new URL(input.url);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password, 'Native inputs require credential-free HTTPS.');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok && response.body && new URL(response.url).protocol === 'https:',
    `Native input retrieval failed: ${input.url} (${response.status})`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= maximum, `Native input exceeds its byte limit: ${input.url}`);
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks);
  assert.equal(digest(result), input.sha256, `Native input checksum mismatch: ${input.url}`);
  return result;
}

async function installNotices(bundle, scratch, inputs) {
  const records = [];
  const identifiers = new Set();
  for (const input of inputs.notices) {
    assert.match(input.id, /^[a-z0-9-]+$/);
    assert.ok(!identifiers.has(input.id), 'Duplicate native notice input.');
    identifiers.add(input.id);
    const bytes = await fetchNativeInput(input);
    const source = path.join(scratch, `${input.id}.input`);
    await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
    const destination = path.join(bundle, 'license-notices', input.id);
    await mkdir(destination, { recursive: true });
    for (const file of input.files) {
      assert.ok(bundlePath(file.path).split('/').length === 1, 'Notice output must be one filename.');
      const content = file.member
        ? run('/usr/bin/tar', ['-xOf', source, bundlePath(file.member)], { encoding: 'buffer', maxBuffer: 65_536 })
        : bytes;
      assert.ok(content.length > 0 && content.length <= 65_536, 'Notice text is empty or oversized.');
      assert.equal(digest(content), file.sha256, `Original notice checksum differs: ${input.id}/${file.path}`);
      const relative = `license-notices/${input.id}/${file.path}`;
      await writeFile(path.join(bundle, relative), content, { flag: 'wx', mode: 0o644 });
      records.push({ path: relative, sourceUrl: input.url, sourceMember: file.member ?? null, sha256: file.sha256 });
    }
  }
  return records;
}

async function dependencyNotices(application, dependencies) {
  const records = [];
  for (const dependency of dependencies) {
    const directory = path.join(application, dependency.path);
    const pkg = await json(path.join(directory, 'package.json'));
    assert.equal(pkg.version, dependency.version, 'Dependency manifest version differs from its lock.');
    assert.equal(typeof pkg.license, 'string', `Dependency has no declared license: ${dependency.path}`);
    const notices = [];
    for (const name of (await readdir(directory)).sort().filter(name => noticeName.test(name))) {
      const file = await bundleFile(path.join(directory, name), 65_536);
      assert.ok(file.bytes > 0, 'Dependency notice is empty.');
      notices.push({ path: `application/${dependency.path}/${name}`, sha256: file.sha256 });
    }
    assert.ok(notices.length > 0 || pkg.name === '@cdktf/hcl2json',
      `Dependency has no original notice text: ${pkg.name}`);
    records.push({ ...dependency, name: pkg.name, license: pkg.license,
      notices: notices.length ? notices : [{ path: 'license-notices/hcl2json/LICENSE' }] });
  }
  return records;
}

async function portableProductionDependencies(root, inventory) {
  const files = [];
  for (const entry of inventory.entries.filter(candidate => candidate.kind === 'file')) {
    const file = path.join(root, entry.path);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      files.push({ path: entry.path, header: header.subarray(0, bytesRead).toString('hex') });
    } finally {
      await handle.close();
    }
  }
  return assertPortableProductionDependencies(files);
}

async function assertHclInputs(application, lock, inputs) {
  const hcl = lock.packages['node_modules/@cdktf/hcl2json'];
  assert.equal(hcl.version, inputs.hcl.version);
  assert.equal(hcl.integrity, inputs.hcl.integrity);
  const wasm = gunzipSync(await readFile(path.join(application, 'node_modules/@cdktf/hcl2json/main.wasm.gz')),
    { maxOutputLength: 16 * 1024 * 1024 });
  assert.equal(wasm.subarray(0, 8).toString('hex'), '0061736d01000000', 'Installed HCL payload is not the expected WASM format.');
  const start = wasm.indexOf('path\tgithub.com/hashicorp/terraform-cdk/hcl2json\n');
  const end = wasm.indexOf('build\tvcs.modified=true\n', start);
  assert.ok(start >= 0 && end > start && end - start < 8192, 'Pinned HCL build metadata is missing.');
  const metadata = wasm.subarray(start, end).toString('utf8');
  assert.ok(metadata.includes(`build\tvcs.revision=${inputs.hcl.sourceRevision}\n`), 'HCL source revision differs.');
  const actual = metadata.split('\n').filter(line => line.startsWith('dep\t')).sort();
  const expected = inputs.notices.filter(input => input.module)
    .map(input => `dep\t${input.module}\t${input.version}\t${input.h1}`).sort();
  assert.deepEqual(actual, expected, 'HCL embedded dependency inventory differs from its notice inventory.');
}

export async function buildNativeBundle({ output, runtimeArchive, npmCli = process.env.npm_execpath }) {
  const host = nativeBundleHost();
  assert.ok(npmCli && path.isAbsolute(npmCli), 'Run the development build through npm; npm_execpath is required.');
  const requested = path.resolve(output);
  const bundle = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  const sourceRoot = await realpath(repositoryRoot);
  assert.ok(bundle !== sourceRoot && !bundle.startsWith(`${sourceRoot}${path.sep}`),
    'Native output must be a new directory outside the source checkout.');
  try {
    await lstat(bundle);
    assert.fail('Native output already exists; choose a new directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const builderInputs = await sourceFiles(builderPaths);
  const inputs = await json(inputsPath);
  assert.equal(inputs.schemaVersion, 1);
  assert.equal(inputs.runtime.platform, host.platform);
  assert.equal(inputs.runtime.architecture, host.architecture);
  assert.equal(inputs.runtime.minimumMacosVersion, minimumNativeMacosVersion);
  assert.equal(inputs.runtime.minimumMacosVersion, host.minimumOperatingSystemVersion);
  assert.equal(inputs.runtime.archiveRoot, `node-v${inputs.runtime.version}-darwin-arm64`);
  const archiveIdentity = await bundleFile(runtimeArchive);
  assert.equal(archiveIdentity.sha256, inputs.runtime.sha256, 'Official Node archive checksum differs.');
  const pkg = await json(path.join(repositoryRoot, 'package.json'));
  const lockBytes = await readFile(path.join(repositoryRoot, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  assert.equal(pkg.name, '@msn-control/liftoff');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const before = collectInputs(coveragePackage('cli'));
  const dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  run(process.execPath, [npmCli, 'run', 'build']);

  await mkdir(bundle, { mode: 0o755 });
  const scratch = await mkdtemp(path.join(path.dirname(bundle), '.liftoff-native-build-'));
  const scratchIdentity = await lstat(scratch);
  console.log(`Native development output: ${bundle}\nOwned build scratch: ${scratch}`);
  const application = path.join(bundle, 'application');
  await mkdir(application);
  const pack = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  const packs = Array.isArray(pack) ? pack : Object.values(pack);
  assert.equal(packs.length, 1, 'Native build requires exactly one packed CLI.');
  const packed = packs[0];
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  assert.equal(packed.filename, `msn-control-liftoff-${pkg.version}.tgz`);
  assertUnpackedPackageSize(packed.unpackedSize);
  const packedPaths = packed.files.map(file => bundlePath(file.path));
  const packageSources = await sourceFiles(packedPaths);
  assert.deepEqual(packagedAssetIssues({ packedPaths, declaredFiles: pkg.files }), []);
  assert.equal(new Set(packedPaths.map(name => name.normalize('NFC').toLowerCase())).size, packedPaths.length);
  const tarball = path.join(scratch, bundlePath(packed.filename));
  const packageIdentity = await bundleFile(tarball, 12 * 1024 * 1024);
  const members = run('/usr/bin/tar', ['-tzf', tarball]).trim().split('\n').sort();
  assert.deepEqual(members, packedPaths.map(name => `package/${name}`).sort(), 'Packed archive contains unexpected members.');
  run('/usr/bin/tar', ['-xzf', tarball, '-C', application, '--strip-components', '1']);
  for (const source of packageSources) {
    const installed = await bundleFile(path.join(application, source.path), 12 * 1024 * 1024);
    assert.equal(installed.sha256, source.sha256, `Packed source bytes differ: ${source.path}`);
  }
  await writeFile(path.join(application, 'package-lock.json'), lockBytes, { flag: 'wx', mode: 0o644 });
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.join(scratch, 'npm-cache')], { cwd: application });
  assert.equal(digest(await readFile(path.join(application, 'package-lock.json'))), digest(lockBytes));
  const dependencies = assertDependencyClosure(await json(path.join(application, 'node_modules/.package-lock.json')), lock);
  const productionDependencyInventory = await bundleInventory(path.join(application, 'node_modules'));
  const productionDependencies = await portableProductionDependencies(
    path.join(application, 'node_modules'), productionDependencyInventory);
  await assertHclInputs(application, lock, inputs);
  const notices = await installNotices(bundle, scratch, inputs);
  const licenses = await dependencyNotices(application, dependencies);
  assert.deepEqual(await installedAssetByteIssues({ installedRoot: application, sourceRoot: repositoryRoot }), []);

  const ownedArchive = path.join(scratch, 'node-runtime.tgz');
  await copyFile(runtimeArchive, ownedArchive, constants.COPYFILE_EXCL);
  assert.equal((await bundleFile(ownedArchive)).sha256, inputs.runtime.sha256);
  run('/usr/bin/tar', ['-xzf', ownedArchive, '-C', scratch,
    `${inputs.runtime.archiveRoot}/bin/node`, `${inputs.runtime.archiveRoot}/LICENSE`]);
  const runtime = path.join(bundle, 'runtime');
  await mkdir(runtime);
  await copyFile(path.join(scratch, inputs.runtime.archiveRoot, 'bin/node'), path.join(runtime, 'node'), constants.COPYFILE_EXCL);
  await copyFile(path.join(scratch, inputs.runtime.archiveRoot, 'LICENSE'), path.join(runtime, 'LICENSE'), constants.COPYFILE_EXCL);
  await chmod(path.join(runtime, 'node'), 0o755);
  assert.equal((await bundleFile(path.join(runtime, 'node'))).sha256, inputs.runtime.executableSha256);
  assert.equal((await bundleFile(path.join(runtime, 'LICENSE'))).sha256, inputs.runtime.licenseSha256);
  const architectures = assertNativeRuntimeArchitectures(run('/usr/bin/lipo', ['-archs', path.join(runtime, 'node')]));
  const machO = assertNativeRuntimeBuildVersion(run('/usr/bin/otool', ['-l', path.join(runtime, 'node')]),
    inputs.runtime.minimumMacosVersion);
  const libraries = assertSystemRuntimeLibraries(run('/usr/bin/otool', ['-L', path.join(runtime, 'node')]));
  const emptyPath = path.join(scratch, 'empty-path');
  await mkdir(emptyPath);
  const runtimeEnvironment = { PATH: emptyPath, NODE_OPTIONS: '', NODE_PATH: '', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' };
  const observed = JSON.parse(run(path.join(runtime, 'node'), ['-p',
    'JSON.stringify({version:process.versions.node,platform:process.platform,architecture:process.arch})'],
  { cwd: scratch, env: runtimeEnvironment }));
  assert.deepEqual(observed, {
    version: inputs.runtime.version,
    platform: host.platform,
    architecture: host.architecture
  });
  await mkdir(path.join(bundle, 'bin'));
  await copyFile(path.join(repositoryRoot, 'distribution/native/launcher.sh'), path.join(bundle, 'bin/liftoff'), constants.COPYFILE_EXCL);
  await chmod(path.join(bundle, 'bin/liftoff'), 0o755);

  const after = collectInputs(coveragePackage('cli'));
  assert.deepEqual(after, before, 'Source, test, dependency or configuration inputs changed during packaging.');
  assert.deepEqual(await sourceFiles(builderPaths), builderInputs, 'Native builder inputs changed during packaging.');
  assert.deepEqual(await sourceFiles(packedPaths), packageSources, 'Packaged source files changed during packaging.');
  assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all']), dirty, 'Checkout changed during packaging.');
  const inventory = await bundleInventory(bundle);
  const manifest = {
    schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: false,
    platform: { platform: host.platform, architecture: host.architecture },
    source: { repository: 'voyager163/liftoff', commit: before.revision.commit, dirty: Boolean(dirty),
      sourceDigest: before.source.digest, configurationDigest: before.configuration.digest, builderInputs },
    hostQualification: host,
    package: { name: pkg.name, version: pkg.version, archive: packageIdentity,
      lockSha256: digest(lockBytes), sourceFiles: packageSources },
    runtime: { ...inputs.runtime, executable: 'runtime/node', machO: { ...machO, architectures },
      libraries, productionDependencies, observed },
    launcher: 'bin/liftoff', assets: requiredPackagedAssets,
    dependencies: licenses, supplementalNotices: notices, hclSource: inputs.hcl,
    inputSha256: digest(await readFile(inputsPath)), inventory,
    boundaries
  };
  await writeFile(path.join(bundle, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  await verifyNativeBundle(bundle);
  const currentScratch = await lstat(scratch);
  assert.ok(currentScratch.isDirectory() && currentScratch.dev === scratchIdentity.dev &&
    currentScratch.ino === scratchIdentity.ino, 'Build scratch ownership changed; it was retained.');
  await rm(scratch, { recursive: true });
  return manifest;
}

export async function verifyNativeBundle(directory) {
  const root = await realpath(directory);
  await bundleFile(path.join(root, 'bundle.json'), 8 * 1024 * 1024);
  const manifest = await json(path.join(root, 'bundle.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'liftoff-native-development-bundle');
  assert.equal(manifest.releaseReady, false, 'This verifier cannot qualify a public native release.');
  assert.deepEqual(manifest.boundaries, boundaries, 'Development qualification boundaries changed.');
  assert.equal(manifest.source.repository, 'voyager163/liftoff');
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof manifest.source.dirty, 'boolean');
  for (const value of [manifest.source.sourceDigest, manifest.source.configurationDigest]) {
    assert.match(value, /^sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(manifest.source.builderInputs, await sourceFiles(builderPaths), 'Native builder input inventory differs.');
  const inputs = await json(inputsPath);
  assert.equal(inputs.runtime.minimumMacosVersion, minimumNativeMacosVersion);
  nativeBundleHost(undefined, inputs.runtime.minimumMacosVersion);
  assert.deepEqual(nativeBundleHost(manifest.hostQualification, inputs.runtime.minimumMacosVersion),
    manifest.hostQualification, 'Native build host qualification differs.');
  assert.equal(manifest.inputSha256, digest(await readFile(inputsPath)), 'Native build input policy differs.');
  const { executable, machO, libraries, productionDependencies, observed, ...runtimeInput } = manifest.runtime;
  assert.deepEqual(runtimeInput, inputs.runtime, 'Runtime input differs from the pinned archive.');
  assert.deepEqual(observed, { version: inputs.runtime.version, platform: 'darwin', architecture: 'arm64' });
  assert.deepEqual(manifest.assets, requiredPackagedAssets, 'Required asset inventory differs.');
  assert.deepEqual(manifest.hclSource, inputs.hcl, 'HCL provenance differs.');
  assert.deepEqual(manifest.supplementalNotices, supplementalNotices(inputs), 'Supplemental notice inventory differs.');
  assert.deepEqual(manifest.platform, { platform: 'darwin', architecture: 'arm64' });
  assert.deepEqual(await bundleInventory(root), manifest.inventory, 'Native bundle inventory changed.');
  assert.equal(manifest.launcher, 'bin/liftoff');
  assert.equal(executable, 'runtime/node');
  for (const name of ['bin/liftoff', 'runtime/node']) {
    assert.equal((await bundleFile(path.join(root, name))).mode, 0o755, 'Native entrypoint is not executable.');
  }
  assert.equal((await bundleFile(path.join(root, 'runtime/node'))).sha256, inputs.runtime.executableSha256,
    'Private runtime bytes differ from the official input.');
  assert.equal((await bundleFile(path.join(root, 'runtime/LICENSE'))).sha256, inputs.runtime.licenseSha256);
  const runtimePath = path.join(root, 'runtime/node');
  const inspectedArchitectures = assertNativeRuntimeArchitectures(run('/usr/bin/lipo', ['-archs', runtimePath]));
  assert.deepEqual(machO, {
    ...assertNativeRuntimeBuildVersion(run('/usr/bin/otool', ['-l', runtimePath]), inputs.runtime.minimumMacosVersion),
    architectures: inspectedArchitectures
  }, 'Private runtime Mach-O qualification differs.');
  assert.deepEqual(libraries, assertSystemRuntimeLibraries(run('/usr/bin/otool', ['-L', runtimePath])),
    'Private runtime system-library qualification differs.');
  assert.equal((await bundleFile(path.join(root, 'bin/liftoff'))).sha256,
    (await bundleFile(path.join(repositoryRoot, 'distribution/native/launcher.sh'))).sha256, 'Launcher bytes differ.');
  const paths = new Set(manifest.inventory.entries.filter(entry => entry.kind === 'file').map(entry => entry.path));
  for (const name of ['bin/liftoff', 'runtime/node', 'runtime/LICENSE', 'application/LICENSE',
    'application/package.json', 'application/package-lock.json', 'application/dist/cli.js',
    'application/node_modules/@cdktf/hcl2json/main.wasm.gz', ...requiredPackagedAssets.map(asset => `application/${asset}`)]) {
    assert.ok(paths.has(name), `Native bundle is missing required material: ${name}`);
  }
  const pkg = await json(path.join(root, 'application/package.json'));
  assert.equal(pkg.name, '@msn-control/liftoff');
  assert.equal(manifest.package.name, pkg.name);
  assert.equal(pkg.version, manifest.package.version);
  assert.equal((await bundleFile(path.join(root, 'application/package-lock.json'))).sha256, manifest.package.lockSha256);
  const lock = await json(path.join(root, 'application/package-lock.json'));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const dependencies = assertDependencyClosure(await json(path.join(root, 'application/node_modules/.package-lock.json')), lock);
  const productionDependencyInventory = await bundleInventory(path.join(root, 'application/node_modules'));
  assert.deepEqual(productionDependencies, await portableProductionDependencies(
    path.join(root, 'application/node_modules'), productionDependencyInventory),
  'Production native dependency qualification differs.');
  assert.deepEqual(await dependencyNotices(path.join(root, 'application'), dependencies), manifest.dependencies,
    'Dependency license inventory differs from installed packages.');
  assert.ok(Array.isArray(manifest.package.sourceFiles) && manifest.package.sourceFiles.length > 0,
    'Packed source inventory is empty.');
  const packagePaths = manifest.package.sourceFiles.map(file => bundlePath(file.path));
  assert.equal(new Set(packagePaths).size, packagePaths.length, 'Packed source inventory has duplicate paths.');
  assert.deepEqual(packagedAssetIssues({ packedPaths: packagePaths, declaredFiles: pkg.files }), []);
  for (const source of manifest.package.sourceFiles) {
    const installed = await bundleFile(path.join(root, 'application', source.path), 12 * 1024 * 1024);
    assert.equal(installed.sha256, source.sha256, `Packed source bytes differ: ${source.path}`);
    assert.equal(installed.bytes, source.bytes, `Packed source length differs: ${source.path}`);
  }
  await assertHclInputs(path.join(root, 'application'), lock, inputs);
  for (const dependency of manifest.dependencies) {
    assert.ok(dependency.notices.length > 0, 'Native dependency notice inventory is empty.');
    for (const notice of dependency.notices) assert.ok(paths.has(bundlePath(notice.path)), 'Native dependency notice is missing.');
  }
  for (const notice of manifest.supplementalNotices) {
    assert.equal((await bundleFile(path.join(root, bundlePath(notice.path)), 65_536)).sha256, notice.sha256);
  }
  return manifest;
}

async function main() {
  const args = nativeBundleArguments(process.argv.slice(2));
  if (args.operation === 'verify-report') {
    await bundleFile(args.output, 8 * 1024 * 1024);
    console.log(JSON.stringify({ result: 'verified-native-qualification',
      ...assertNativeBundleReport(await json(args.output)), releaseReady: false }, null, 2));
    return;
  }
  const result = args.operation === 'build' ? await buildNativeBundle(args) : await verifyNativeBundle(args.output);
  console.log(JSON.stringify({ result: 'verified-development-bundle', releaseReady: false,
    output: args.output, package: result.package.name, version: result.package.version,
    inventorySha256: result.inventory.sha256, entries: result.inventory.entries.length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Native development bundle failed; any reported output/scratch is retained: ${error.message}`);
    process.exitCode = 1;
  });
}
