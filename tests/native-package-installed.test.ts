import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleFile, bundleInventory, nativeArchiveTool } from '../scripts/native-bundle-contract.mjs';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { archiveNativeBundle, prepareNativeWindowsInstaller, nativeWindowsInstallerInputs, verifyNativeArchive } from '../scripts/native-release.mjs';
import policy from '../distribution/native/release-policy.json' with { type: 'json' };
import { inspectOwnedInstallation, installOwnedBundle, recoverOwnedInstallation } from '../scripts/native-install.mjs';
import { assertNativeHost, observeNativeHost } from '../distribution/native/host.mjs';
import { installedPlanCases, planContractIssues } from '../scripts/package-smoke-contract.mjs';
import { nativeLinuxUserspaceImages } from '../scripts/native-package-report.mjs';

const supplied = process.env.LIFTOFF_NATIVE_PACKAGE_ROOT;
const windows = process.platform === 'win32';
let bundle: string, runtime: string, cli: string, fixture: string, outside: string, manifest: Awaited<ReturnType<typeof verifyNativeBundle>>;
let env: NodeJS.ProcessEnv;
let failed = false;
const copiedBundles: string[] = [];

function execute(command: string, args: string[], cwd = outside) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
function installed(code: string, root = bundle) {
  return execute(path.join(root, windows ? 'runtime/node.exe' : 'runtime/node'), ['--input-type=module', '-e', code]);
}
function moduleUrl(relative: string, root = bundle) {
  return pathToFileURL(path.join(root, 'application/dist', relative)).href;
}
async function copy(name: string) {
  const result = path.join(fixture, name);
  await cp(bundle, result, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  copiedBundles.push(result);
  return result;
}

describe.skipIf(!supplied)('actual cross-platform native package', () => {
  beforeAll(async () => {
    expect(supplied && path.isAbsolute(supplied)).toBeTruthy();
    bundle = await realpath(supplied!);
    manifest = await verifyNativeBundle(bundle);
    expect(manifest.platform).toEqual({ platform: process.platform, architecture: process.arch });
    assertNativeHost(observeNativeHost());
    fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff installed native package ')));
    console.info(`Native package qualification fixture: ${fixture}`);
    outside = path.join(fixture, "foreign cwd with spaces & apostrophe's");
    const home = path.join(fixture, 'home'), empty = path.join(fixture, 'no global tools');
    for (const directory of [outside, home, empty]) await mkdir(directory);
    env = {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
      TMPDIR: fixture, TEMP: fixture, TMP: fixture, PATH: empty,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      CI: 'true', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1'
    };
    cli = path.join(bundle, manifest.launcher);
    runtime = path.join(bundle, manifest.runtime.executable);
  }, 60_000);
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') failed = true;
    if (failed) return;
    try {
      await Promise.all(copiedBundles.splice(0).map(directory => rm(directory, { recursive: true })));
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  afterAll(async () => {
    if (!fixture || failed) return;
    await verifyNativeBundle(bundle);
    await rm(fixture, { recursive: true });
  });

  it('starts the pinned runtime and installed CLI from a foreign cwd with no global tools', async () => {
    const before = await bundleInventory(outside);
    expect(execute(runtime, ['--version']).stdout.trim()).toBe('v24.21.0');
    const version = execute(cli, ['--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`Liftoff ${manifest.package.version}`);
    const help = execute(cli, ['--help']);
    expect(help.status, help.stderr).toBe(0);
    const capabilities = execute(cli, ['capabilities', '--json']);
    expect(capabilities.status, capabilities.stderr).toBe(0);
    expect(JSON.parse(capabilities.stdout).runtime.nativeDistribution).toBe(false);
    expect(await bundleInventory(outside)).toEqual(before);
  });
  it('runs every installed plan and preserves literal arguments without ambient startup code', async () => {
    const before = await bundleInventory(outside);
    env.NODE_OPTIONS = '--require=/unselected-startup.cjs';
    env.NODE_PATH = '/unselected-modules';
    try {
      for (const plan of installedPlanCases) {
        const result = execute(cli, ['plan', ...plan.args]);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(planContractIssues(result.stdout, plan)).toEqual([]);
      }
      const rejected = execute(cli, ['--help', ';not-a-shell-command']);
      expect(rejected.status).not.toBeNull();
    } finally { delete env.NODE_OPTIONS; delete env.NODE_PATH; }
    expect(await bundleInventory(outside)).toEqual(before);
  });
  it('resolves packaged templates and the exact controller from the installed boundary', () => {
    const result = installed(`
      import assert from 'node:assert/strict';
      import { createHash, generateKeyPairSync, sign } from 'node:crypto';
      import { gzipSync } from 'node:zlib';
      import { verifyWindowsJobControllerAsset, captureWindowsJobInteropAssembly } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js'))};
      const admission = await import(${JSON.stringify(pathToFileURL(path.join(bundle, 'installation/native-release-admission.mjs')).href)});
      const catalog = await import(${JSON.stringify(pathToFileURL(path.join(bundle, 'installation/native-release-catalog.mjs')).href)});
      const key = generateKeyPairSync('ed25519'), bytes = gzipSync(Buffer.from('Installed synthetic signature specimen.'));
      const signature = sign(null, bytes, key.privateKey), publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
      const fingerprint = createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      assert.equal(admission.verifyNativeBytesSignature(bytes, signature, publicKey, fingerprint), undefined);
      assert.throws(() => admission.verifyNativeBytesSignature(Buffer.from('changed'), signature, publicKey, fingerprint), /signature/);
      assert.throws(() => admission.verifyNativeEvidenceSignature(bytes, signature, publicKey, fingerprint), SyntaxError);
      const interop = await captureWindowsJobInteropAssembly(${JSON.stringify(path.join(bundle, 'application/assets/repair/Liftoff.WindowsJob.Interop.dll'))});
      console.log(JSON.stringify({ controller: await verifyWindowsJobControllerAsset(), runtime: process.execPath,
        interopSha256: createHash('sha256').update(interop).digest('hex'),
        admissionExports: Object.keys(admission).sort(), catalogFilename: catalog.nativeReleaseCatalogFilename,
        catalogTargets: catalog.nativeReleaseTargets, rawSignatureVerified: true }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      controller: path.join(bundle, 'application/assets/repair/windows-job-controller.ps1'), runtime,
      interopSha256: '9639b54c1e91d77184d36d8d4e3498a3deb69a9c9e863fa4ff756264329d9a25',
      admissionExports: ['assertNativePublicationEvidence', 'verifyNativeBytesSignature', 'verifyNativeEvidenceSignature'],
      catalogFilename: 'liftoff-native-release.json', catalogTargets: ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'],
      rawSignatureVerified: true
    });
  });
  it('admits packaged private cask staging only on POSIX hosts without ambient tools', async ({ task }) => {
    const root = path.join(fixture, 'private cask transport');
    await mkdir(root, { mode: 0o700 });
    const stat = await lstat(root, { bigint: true });
    const directoryIdentity = JSON.stringify(
      (['dev', 'ino', 'uid', 'gid', 'mode'] as const).map(key => String(stat[key]))
    );
    const worker = path.join(bundle, 'application/distribution/native/cask-stage-worker.mjs');
    const names = ['release.json', 'qualification.json', 'qualification.sig', 'qualification.pub',
      'archive.tar.gz', 'sbom.cdx.json', 'provenance.json', 'NOTICE', 'definition.rb'];
    const payload = new Map(names.map(name => [name, Buffer.from(`inert transport specimen: ${name}\n`)]));
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const header = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'liftoff-cask-stage-write', mode: 'create',
      root, directoryIdentity, files: [...payload].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) })) }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const before = await bundleInventory(outside);
    const result = spawnSync(runtime, [worker], { cwd: root, env, input: Buffer.concat([length, header, ...payload.values()]),
      encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (windows) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('liftoff-cask-target-stage:refused\n');
      expect((await bundleInventory(root)).entries).toEqual([]);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      const receipt = JSON.parse(result.stdout);
      expect(receipt).toMatchObject({ schemaVersion: 1, kind: 'liftoff-cask-stage-written' });
      expect(receipt.files.map((file: { name: string }) => file.name)).toEqual(names);
      for (const [name, bytes] of payload) {
        const file = path.join(root, 'cask-target', name), value = await lstat(file, { bigint: true });
        expect(await readFile(file)).toEqual(bytes);
        expect(value.mode & 0o777n).toBe(0o600n);
        expect(value.nlink).toBe(1n);
        expect(receipt.files.find((entry: { name: string }) => entry.name === name).physical)
          .toBe(JSON.stringify((['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
            .map(key => String(value[key]))));
      }
    }
    Object.assign(task.meta, { caskStageTransport: { runtime, worker,
      workerSha256: (await bundleFile(worker)).sha256, outcome: windows ? 'refused-windows' : 'private-posix-write',
      inertTransportOnlyNotCaskInstallationOrPublication: true } });
    expect(await bundleInventory(outside)).toEqual(before);
  });
  it('refuses missing template, controller, HCL and host-policy material without checkout fallback', async () => {
    const damaged = await copy('missing asset package');
    for (const relative of ['application/assets/plugins/go-huma/go-backend/go.mod',
      'application/assets/repair/windows-job-controller.ps1',
      'application/assets/repair/Liftoff.WindowsJob.Interop.dll',
      'application/node_modules/@cdktf/hcl2json/main.wasm.gz', 'installation/platforms.json',
      'installation/release-policy.json', 'installation/native-release-admission.mjs', 'installation/native-release-catalog.mjs',
      'application/distribution/native/cask-stage-worker.mjs']) {
      const file = path.join(damaged, relative), bytes = await readFile(file), mode = (await lstat(file)).mode & 0o777;
      await rm(file);
      try {
        await expect(verifyNativeBundle(damaged)).rejects.toThrow();
        const result = relative.endsWith('go.mod')
          ? execute(path.join(damaged, manifest.launcher), ['plan', ...installedPlanCases.find(plan => plan.id === 'manual-cli-only')!.args])
          : relative.endsWith('cask-stage-worker.mjs')
            ? execute(path.join(damaged, windows ? 'runtime/node.exe' : 'runtime/node'), [path.join(damaged, relative)])
          : relative.endsWith('.dll')
            ? installed(`import { captureWindowsJobInteropAssembly } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js', damaged))}; await captureWindowsJobInteropAssembly(${JSON.stringify(file)});`, damaged)
          : relative.endsWith('.ps1')
            ? installed(`import { verifyWindowsJobControllerAsset } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js', damaged))}; await verifyWindowsJobControllerAsset();`, damaged)
            : relative.endsWith('platforms.json')
              ? execute(path.join(damaged, manifest.launcher), ['--version'])
              : relative.startsWith('installation/')
                ? installed(`await import(${JSON.stringify(pathToFileURL(path.join(damaged,
                  relative.endsWith('native-release-catalog.mjs') ? relative : 'installation/native-release-admission.mjs')).href)});`, damaged)
                : installed(`import { parseIsolatedHcl } from ${JSON.stringify(moduleUrl('adapters/hcl/isolated-parser.js', damaged))}; await parseIsolatedHcl(['locals { enabled = true }\\n']);`, damaged);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
      } finally { await writeFile(file, bytes, { mode }); if (!windows) await chmod(file, mode); }
    }
    await verifyNativeBundle(damaged);
  }, 120_000);
  it('rejects changed runtime and installer bytes even with a recomputed local inventory', async () => {
    const damaged = await copy('changed native package');
    const file = path.join(damaged, 'installation/native-install.mjs');
    await writeFile(file, '// changed installer\n');
    const bundleJson = path.join(damaged, 'bundle.json');
    await writeFile(bundleJson, JSON.stringify({ ...manifest, inventory: await bundleInventory(damaged) }));
    await expect(verifyNativeBundle(damaged)).rejects.toThrow('ownership contract differs');
    await copyFile(path.join(bundle, 'installation/native-install.mjs'), file);
    const executable = path.join(damaged, manifest.runtime.executable);
    await writeFile(executable, 'changed private runtime');
    if (!windows) await chmod(executable, 0o755);
    await writeFile(bundleJson, JSON.stringify({ ...manifest, inventory: await bundleInventory(damaged) }));
    await expect(verifyNativeBundle(damaged)).rejects.toThrow('runtime bytes differ');
  }, 120_000);
  it('binds archived bytes, SBOM, notices and provenance to the exact clean source', async () => {
    const output = path.join(fixture, 'artifact handoff');
    if (manifest.source.dirty) {
      await expect(archiveNativeBundle({ bundle, output })).rejects.toThrow('clean committed source');
      return;
    }
    const record = await archiveNativeBundle({ bundle, output });
    const digest = (await bundleFile(path.join(output, 'native-release.json'))).sha256;
    expect(await verifyNativeArchive(output, digest, manifest.source.commit)).toEqual(record);
    expect(record.releaseReady).toBe(false);
    const sbom = JSON.parse(await readFile(path.join(output, 'sbom.cdx.json'), 'utf8'));
    expect(sbom.components.length).toBe(manifest.dependencies.length + 2);
    expect(record.version).toBe(manifest.package.version);
    await writeFile(path.join(output, 'NOTICE'), 'changed notice');
    await expect(verifyNativeArchive(output, digest, record.commit)).rejects.toThrow('changed');
  }, 120_000);
  it('extracts the exact native archive and reverifies every filesystem entry without mode normalization', async () => {
    expect(manifest.source.dirty).toBe(false);
    const suppliedArchive = process.env.LIFTOFF_NATIVE_ARCHIVE_ROOT;
    const output = suppliedArchive ?? path.join(fixture, 'roundtrip artifact handoff');
    if (suppliedArchive !== undefined) expect(path.isAbsolute(suppliedArchive)).toBe(true);
    else await archiveNativeBundle({ bundle, output });
    const digest = (await bundleFile(path.join(output, 'native-release.json'))).sha256;
    const record = await verifyNativeArchive(output, digest, manifest.source.commit);
    const originalManifest = await bundleFile(path.join(bundle, 'bundle.json'));
    expect(record.manifestSha256).toBe(originalManifest.sha256);
    expect(record.inventorySha256).toBe(manifest.inventory.sha256);
    const extracted = path.join(fixture, "extracted archive with spaces & apostrophe's");
    await mkdir(extracted, { mode: 0o700 });
    const extraction = execute(nativeArchiveTool(), [
      '-xpf', path.join(output, record.files[0].filename), '-C', extracted,
      ...(process.platform === 'linux' ? ['--use-compress-program=/usr/bin/gzip'] : ['-z'])
    ]);
    expect(extraction.status, extraction.stdout + extraction.stderr).toBe(0);
    expect(await bundleFile(path.join(extracted, 'bundle.json'))).toEqual(originalManifest);
    const extractedManifest = await verifyNativeBundle(extracted);
    expect(extractedManifest).toEqual(manifest);
    expect(await bundleInventory(extracted)).toEqual(manifest.inventory);
    const before = await bundleInventory(outside);
    const version = execute(path.join(extracted, manifest.launcher), ['--version']);
    expect(version.status, version.stdout + version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`Liftoff ${manifest.package.version}`);
    expect(await bundleInventory(outside)).toEqual(before);
    const file = path.join(extracted, 'installation/platforms.json');
    const mode = (await bundleFile(file)).mode;
    expect(mode & 0o200).not.toBe(0);
    await chmod(file, mode & ~0o222);
    try { await expect(verifyNativeBundle(extracted)).rejects.toThrow('inventory changed'); }
    finally { await chmod(file, mode); }
    await verifyNativeBundle(extracted);
    expect(await verifyNativeArchive(output, digest, manifest.source.commit)).toEqual(record);
    const filesystemModes: Record<string, number> = {};
    for (const entry of extractedManifest.inventory.entries) {
      if (entry.kind === 'file' || entry.kind === 'directory') {
        const key = `${entry.kind}:${entry.mode.toString(8).padStart(4, '0')}`;
        filesystemModes[key] = (filesystemModes[key] ?? 0) + 1;
      }
    }
    console.log(JSON.stringify({
      kind: 'liftoff-native-archive-roundtrip', commit: record.commit, target: record.target,
      runId: record.runId, archiveSha256: record.files[0].sha256, manifestSha256: record.manifestSha256,
      inventorySha256: record.inventorySha256, entries: extractedManifest.inventory.entries.length,
      filesystemModes, permissionEvidence: 'exact Node lstat inventory, not Windows ACL qualification',
      releaseReady: false
    }));
  }, 120_000);
  it.runIf(process.platform === 'linux')('installs and recovers the actual Linux bundle within an isolated private prefix', async () => {
    const prefix = path.join(fixture, 'private local prefix');
    await mkdir(prefix, { mode: 0o700 });
    const expectedManifestSha256 = (await bundleFile(path.join(bundle, 'bundle.json'))).sha256;
    const args = { source: bundle, prefix, expectedManifestSha256, expectedCurrent: null, development: true,
      admitHost: () => assertNativeHost(observeNativeHost()) };
    await expect(installOwnedBundle({ ...args, interruptAt: 'after-switch' })).rejects.toThrow('Interrupted');
    const current = await inspectOwnedInstallation(prefix);
    expect(current).toContain(`versions/${manifest.package.version}-`);
    const installedVersion = execute(path.join(prefix, 'bin/liftoff'), ['--version']);
    expect(installedVersion.status, installedVersion.stderr).toBe(0);
    expect(installedVersion.stdout.trim()).toBe(`Liftoff ${manifest.package.version}`);
    const expectedJournalSha256 = (await bundleFile(path.join(prefix, '.native-install-transaction.json'))).sha256;
    await recoverOwnedInstallation({ prefix, expectedJournalSha256 });
    expect(await inspectOwnedInstallation(prefix)).toBeNull();
    await verifyNativeBundle(bundle);
  }, 120_000);
  it.runIf(process.platform === 'linux')('authenticates Linux bootstrap input and still refuses unqualified public installation before prefix writes', async () => {
    expect(manifest.source.dirty).toBe(false);
    const output = path.join(fixture, 'signed test-only Linux archive');
    const record = await archiveNativeBundle({ bundle, output });
    const archive = path.join(output, record.files[0].filename);
    const bytes = await readFile(archive);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicFile = path.join(fixture, 'test-only-key.pub'), signatureFile = path.join(fixture, 'test-only.sig');
    await writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
    await writeFile(signatureFile, sign(null, bytes, privateKey));
    const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const prefix = path.join(fixture, 'bootstrap private prefix');
    await mkdir(prefix, { mode: 0o700 });
    const before = await bundleInventory(prefix);
    const args = [path.resolve('distribution/linux/install.sh'), archive, signatureFile, publicFile,
      record.files[0].sha256, fingerprint, prefix, record.manifestSha256, 'none'];
    const bootstrap = (selected = args) => spawnSync('/bin/sh', selected, {
      cwd: outside, shell: false, encoding: 'utf8', timeout: 60_000, env: { ...env, PATH: '/usr/bin:/bin' }
    });
    const refused = bootstrap();
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).toContain('Signature Verified Successfully');
    expect(refused.stderr).toContain('minimum host has not been qualified');
    expect(await bundleInventory(prefix)).toEqual(before);
    const wrongKey = [...args]; wrongKey[5] = '0'.repeat(64);
    expect(bootstrap(wrongKey).stderr).toContain('signing identity differs');
    await writeFile(signatureFile, Buffer.alloc(64));
    expect(bootstrap().status).not.toBe(0);
    expect(await bundleInventory(prefix)).toEqual(before);
  }, 120_000);
  it.runIf(process.platform === 'linux')('runs the actual Linux bundle and owned recovery in pinned glibc 2.28 userspace without public or minimum-kernel credit', async () => {
    const architecture: unknown = manifest.platform.architecture;
    expect(architecture === 'x64' || architecture === 'arm64').toBe(true);
    if (architecture !== 'x64' && architecture !== 'arm64') throw new Error('Unsupported Linux userspace architecture.');
    const image = nativeLinuxUserspaceImages[architecture];
    const docker = process.env.LIFTOFF_NATIVE_DOCKER_EXECUTABLE ?? '/usr/bin/docker';
    expect(path.isAbsolute(docker)).toBe(true);
    const daemon = execute(docker, ['info', '--format', '{{json .Architecture}}']);
    expect(daemon.status, daemon.stderr).toBe(0);
    expect(JSON.parse(daemon.stdout)).toBe(architecture === 'x64' ? 'x86_64' : 'aarch64');
    const inspected = execute(docker, ['image', 'inspect', image, '--format', '{{json .}}']);
    expect(inspected.status, inspected.stderr).toBe(0);
    const imageIdentity = JSON.parse(inspected.stdout);
    expect(imageIdentity.Os).toBe('linux');
    expect(imageIdentity.Architecture).toBe(architecture === 'x64' ? 'amd64' : 'arm64');
    expect(imageIdentity.RepoDigests).toContain(image.replace('docker.io/', ''));
    const manifestSha256 = (await bundleFile(path.join(bundle, 'bundle.json'))).sha256;
    const code = `
      import assert from 'node:assert/strict';
      import os from 'node:os';
      import { mkdir, readFile } from 'node:fs/promises';
      import { spawnSync } from 'node:child_process';
      import { createHash } from 'node:crypto';
      import { assertNativeHost, observeNativeHost } from '/liftoff/installation/host.mjs';
      import { bundleFile, bundleInventory } from '/liftoff/installation/native-bundle-contract.mjs';
      import { installOwnedBundle, inspectOwnedInstallation, recoverOwnedInstallation } from '/liftoff/installation/native-install.mjs';
      import { parseIsolatedHcl } from '/liftoff/application/dist/adapters/hcl/isolated-parser.js';
      import { verifyWindowsJobControllerAsset } from '/liftoff/application/dist/adapters/process/windows-job-runner.js';
      const digest = bytes => createHash('sha256').update(bytes).digest('hex');
      const original = await readFile('/liftoff/bundle.json');
      assert.equal(digest(original), ${JSON.stringify(manifestSha256)});
      const manifest = JSON.parse(original.toString('utf8'));
      const observed = observeNativeHost();
      assert.equal(observed.platform, 'linux');
      assert.equal(observed.architecture, ${JSON.stringify(architecture)});
      assert.equal(observed.glibcVersion, '2.28');
      assertNativeHost(observed);
      assert.throws(() => assertNativeHost(observed, { publicInstallation: true }), /minimum host/);
      const tmpfs = (await readFile('/proc/mounts', 'utf8')).split('\\n').map(row => row.split(' '))
        .find(row => row[1] === '/tmp');
      assert.ok(tmpfs);
      assert.equal(tmpfs[2], 'tmpfs');
      const tmpfsMountOptions = tmpfs[3].split(',');
      for (const option of ['rw', 'nosuid', 'nodev']) assert.ok(tmpfsMountOptions.includes(option));
      assert.ok(!tmpfsMountOptions.includes('noexec'));
      await mkdir('/tmp/home');
      await mkdir('/tmp/foreign cwd');
      const invoke = (command, args) => {
        const result = spawnSync(command, args, { cwd: '/tmp/foreign cwd', env: process.env,
          shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
      };
      const version = invoke('/liftoff/bin/liftoff', ['--version']).trim();
      assert.equal(version, 'Liftoff ' + manifest.package.version);
      const libraries = invoke('/usr/bin/rpm', ['-q', '--qf', '%{NAME}:%{VERSION}-%{RELEASE}.%{ARCH}\\n',
        'glibc', 'libstdc++']).trim().split('\\n');
      assert.ok(libraries.some(value => value.startsWith('glibc:2.28-')));
      assert.ok(libraries.some(value => value.startsWith('libstdc++:8.5.0-')));
      assert.ok(invoke('/liftoff/bin/liftoff', ['--help']).includes('liftoff'));
      const capabilities = JSON.parse(invoke('/liftoff/bin/liftoff', ['capabilities', '--json']));
      assert.equal(capabilities.runtime.nativeDistribution, false);
      const plans = ${JSON.stringify(installedPlanCases)}.map(plan => ({
        id: plan.id, stdout: invoke('/liftoff/bin/liftoff', ['plan', ...plan.args])
      }));
      await assert.rejects(parseIsolatedHcl(['locals { enabled = true }\\n']),
        /Isolated HCL computation is unavailable: this runtime is not the qualified darwin/);
      assert.equal(await verifyWindowsJobControllerAsset(),
        '/liftoff/application/assets/repair/windows-job-controller.ps1');
      const prefix = '/tmp/private-prefix';
      await mkdir(prefix, { mode: 0o700 });
      const args = { source: '/liftoff', prefix, expectedManifestSha256: ${JSON.stringify(manifestSha256)},
        expectedCurrent: null, development: true, admitHost: () => assertNativeHost(observeNativeHost()) };
      await assert.rejects(installOwnedBundle({ ...args, interruptAt: 'after-switch' }), /Interrupted/);
      assert.ok((await inspectOwnedInstallation(prefix)).startsWith('versions/' + manifest.package.version + '-'));
      assert.equal(invoke(prefix + '/bin/liftoff', ['--version']).trim(), version);
      const expectedJournalSha256 = (await bundleFile(prefix + '/.native-install-transaction.json')).sha256;
      await recoverOwnedInstallation({ prefix, expectedJournalSha256 });
      assert.equal(await inspectOwnedInstallation(prefix), null);
      assert.deepEqual(await bundleInventory('/liftoff'), manifest.inventory);
      assert.equal(digest(await readFile('/liftoff/bundle.json')), ${JSON.stringify(manifestSha256)});
      console.log(JSON.stringify({ observed, version, libraries, plans, tmpfsMountOptions, controllerResolved: true,
        hclExecuted: false, hclQualifiedRuntimeRefused: true,
        developmentInstallRecovered: true, actualKernel: os.release(), minimumKernelQualified: false,
        minimumHostQualified: false, publicDistributionQualified: false }));
    `;
    const result = execute(docker, ['run', '--rm', '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1g', '--cpus=2',
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=536870912,mode=1777',
      '--mount', `type=bind,source=${bundle},target=/liftoff,readonly`,
      '--env', 'HOME=/tmp/home', '--env', 'XDG_CONFIG_HOME=/tmp/home', '--env', 'PATH=/empty',
      '--env', 'CI=true', '--env', 'LIFTOFF_TELEMETRY=0', '--env', 'DO_NOT_TRACK=1',
      '--env', 'NO_COLOR=1', '--workdir', '/tmp', '--entrypoint', '/liftoff/runtime/node',
      image, '--input-type=module', '-e', code]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.plans).toHaveLength(installedPlanCases.length);
    for (const plan of installedPlanCases) {
      expect(planContractIssues(proof.plans.find((entry: { id: string }) => entry.id === plan.id).stdout, plan)).toEqual([]);
    }
    expect(proof).toMatchObject({
      observed: { platform: 'linux', architecture, runtimeVersion: '24.21.0', glibcVersion: '2.28' },
      version: `Liftoff ${manifest.package.version}`, controllerResolved: true,
      hclExecuted: false, hclQualifiedRuntimeRefused: true,
      developmentInstallRecovered: true, minimumKernelQualified: false, minimumHostQualified: false,
      publicDistributionQualified: false
    });
    console.log(JSON.stringify({ kind: 'liftoff-native-linux-userspace', commit: manifest.source.commit,
      target: `linux-${architecture}`, manifestSha256, inventorySha256: manifest.inventory.sha256,
      image, imageId: imageIdentity.Id, ...proof, plans: proof.plans.map((entry: { id: string }) => entry.id),
      releaseReady: false }));
    await verifyNativeBundle(bundle);
  }, 120_000);
  it.runIf(process.platform === 'darwin')('refuses public macOS installation while minimum-host and signing qualification remain absent', () => {
    expect(() => assertNativeHost(observeNativeHost(), { publicInstallation: true })).toThrow('minimum host');
  });
  it.runIf(windows)('runs the actual stable Windows launcher and refuses unsafe immutable version pointers', async () => {
    const manifestSha256 = (await bundleFile(path.join(bundle, 'bundle.json'))).sha256;
    const approvedPolicy = { ...policy, approvedSigningKeySha256: '5'.repeat(64),
      winget: { packageIdentifier: 'Synthetic.Liftoff', publisher: "Synthetic fixture's publisher",
        certificateSha256: '6'.repeat(64), installerAppId: '{00000000-0000-0000-0000-000000000000}' } };
    const unapproved = path.join(fixture, 'unapproved installer inputs');
    await expect(prepareNativeWindowsInstaller({ bundle, output: unapproved })).rejects.toThrow('No approved');
    await expect(lstat(unapproved)).rejects.toMatchObject({ code: 'ENOENT' });
    const output = path.join(fixture, 'synthetic approved installer inputs');
    const prepared = await prepareNativeWindowsInstaller({ bundle, output, approvedPolicy });
    expect(prepared).toMatchObject({
      manifestSha256, compiled: false, signed: false, installerOwnershipQualified: false, published: false
    });
    const inputs = nativeWindowsInstallerInputs(manifest, manifestSha256, approvedPolicy);
    expect(JSON.parse(await readFile(path.join(output, 'native-install.json'), 'utf8'))).toEqual(inputs.receipt);
    expect(await readFile(path.join(output, 'current.txt'), 'utf8')).toBe(inputs.pointer);
    const script = await readFile(path.join(output, 'installer.iss'), 'utf8');
    expect(script).toContain('#define ApprovedAppId "{{00000000-0000-0000-0000-000000000000}"');
    expect(script).toContain("Synthetic fixture''s publisher");
    expect(script).toContain(`#define StableLauncherSha256 "${inputs.receipt.stableLauncherSha256}"`);
    const inventoriedFiles = manifest.inventory.entries.filter((entry: { kind: string }) => entry.kind === 'file').length;
    const inventory = await readFile(path.join(output, 'inventory.iss'), 'utf8');
    expect(inventory.match(/^Source: /gm)?.length).toBe(1 + inventoriedFiles);
    expect(inventory).not.toContain('recursesubdirs');
    expect(inventory).not.toContain('\\*');
    const hashes = await readFile(path.join(output, 'hashes.iss'), 'utf8');
    expect(hashes.match(/^#if LowerCase\(GetSHA256OfFile/gm)?.length).toBe(3 + inventoriedFiles);
    await expect(prepareNativeWindowsInstaller({ bundle, output, approvedPolicy })).rejects.toThrow('EEXIST');
    const installation = path.join(fixture, "stable Windows install with spaces & apostrophe's");
    const selected = path.join(installation, inputs.receipt.versionDirectory);
    copiedBundles.push(installation);
    await mkdir(path.dirname(selected), { recursive: true });
    await cp(bundle, selected, { recursive: true, verbatimSymlinks: true });
    await mkdir(path.join(installation, 'bin'));
    const stable = path.join(installation, 'bin/liftoff.exe'), pointer = path.join(installation, 'current.txt');
    await copyFile(cli, stable);
    await copyFile(path.join(output, 'native-install.json'), path.join(installation, 'native-install.json'));
    await writeFile(pointer, inputs.pointer);
    const before = await bundleInventory(outside);
    const version = execute(stable, ['--version']);
    expect(version.status, version.stdout + version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`Liftoff ${manifest.package.version}`);
    env.NODE_OPTIONS = '--require=/unselected-startup.cjs';
    env.NODE_PATH = '/unselected-modules';
    try {
      const plan = installedPlanCases.find(plan => plan.id === 'manual-cli-only')!;
      const result = execute(stable, ['plan', ...plan.args]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(planContractIssues(result.stdout, plan)).toEqual([]);
    } finally { delete env.NODE_OPTIONS; delete env.NODE_PATH; }
    const refused = () => {
      const result = execute(stable, ['--version']);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain('installed version pointer');
    };
    for (const value of ['', '../outside\r\n', `${inputs.versionName}\n`, `${inputs.pointer}extra`,
      inputs.pointer.replace(manifestSha256, '0'.repeat(64)), 'x'.repeat(256), `${'1'.repeat(64)}\0\r\n`]) {
      await writeFile(pointer, value);
      refused();
    }
    await writeFile(pointer, inputs.pointer);
    const alias = path.join(installation, 'current-alias.txt');
    await link(pointer, alias);
    refused();
    await rm(alias);
    await rm(pointer);
    refused();
    await writeFile(pointer, inputs.pointer);
    const junctionDigest = manifestSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const junctionName = `${manifest.package.version}-${junctionDigest}`;
    const junction = path.join(installation, 'versions', junctionName);
    await symlink(selected, junction, 'junction');
    await writeFile(pointer, `${junctionName}\r\n`);
    refused();
    await writeFile(pointer, inputs.pointer);
    await rm(junction);
    expect(execute(stable, ['--version']).status).toBe(0);
    expect(await bundleInventory(outside)).toEqual(before);
    await verifyNativeBundle(selected);
    console.log(JSON.stringify({
      kind: 'liftoff-windows-stable-launcher', sourceCommit: manifest.source.commit, manifestSha256,
      inventorySha256: manifest.inventory.sha256, stableLauncherSha256: inputs.receipt.stableLauncherSha256,
      syntheticPolicy: true, compiledInstaller: false, signed: false, installerOwnershipQualified: false,
      minimumHostQualified: false, published: false
    }));
  }, 120_000);
  it.runIf(windows)('refuses replacement of a running Windows image and retains the original bytes', async () => {
    const locked = await copy('locked Windows version');
    const executable = path.join(locked, manifest.runtime.executable);
    const replacement = path.join(fixture, 'writable replacement node.exe');
    await copyFile(runtime, replacement);
    await chmod(replacement, 0o600);
    await chmod(executable, 0o600);
    await copyFile(replacement, executable);
    const before = await bundleFile(executable);
    const child = spawn(executable, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      cwd: outside, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Locked-image fixture did not start.')), 10_000);
        child.stdout!.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('ready') ? resolve() : reject(new Error('No image-lock readiness.')); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await expect(copyFile(replacement, executable)).rejects.toThrow();
      expect((await bundleFile(executable)).sha256).toBe(before.sha256);
    } finally { child.kill(); await exited; }
    await copyFile(replacement, executable);
    expect((await bundleFile(executable)).sha256).toBe(before.sha256);
  }, 60_000);
  it.runIf(windows)('settles an actual installed Windows controller job without changing execution policy', () => {
    const result = installed(`
      import { runWindowsJobCommand } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js'))};
      const result = await runWindowsJobCommand(
        { executable: process.execPath, args: ['-e', 'process.stdout.write("installed controller ready")'] },
        { cwd: ${JSON.stringify(outside)}, timeoutMs: 10000,
          env: { SystemRoot: process.env.SystemRoot, PATH: '', TEMP: process.env.TEMP, TMP: process.env.TMP } });
      console.log(JSON.stringify(result));
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 0, processSpawned: true, processTreeSettled: true, timedOut: false, stdout: 'installed controller ready'
    });
  }, 60_000);
});
