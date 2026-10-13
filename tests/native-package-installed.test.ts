import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleFile, bundleInventory } from '../scripts/native-bundle-contract.mjs';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { archiveNativeBundle, verifyNativeArchive } from '../scripts/native-release.mjs';
import { inspectOwnedInstallation, installOwnedBundle, recoverOwnedInstallation } from '../scripts/native-install.mjs';
import { assertNativeHost, observeNativeHost } from '../distribution/native/host.mjs';
import { installedPlanCases, planContractIssues } from '../scripts/package-smoke-contract.mjs';

const supplied = process.env.LIFTOFF_NATIVE_PACKAGE_ROOT;
const windows = process.platform === 'win32';
let bundle: string, runtime: string, cli: string, fixture: string, outside: string, manifest: Awaited<ReturnType<typeof verifyNativeBundle>>;
let env: NodeJS.ProcessEnv;
let failed = false;

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
  afterEach(({ task }) => { if (task.result?.state === 'fail') failed = true; });
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
      import { verifyWindowsJobControllerAsset } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js'))};
      const admission = await import(${JSON.stringify(pathToFileURL(path.join(bundle, 'installation/native-release-admission.mjs')).href)});
      console.log(JSON.stringify({ controller: await verifyWindowsJobControllerAsset(), runtime: process.execPath,
        admissionExports: Object.keys(admission).sort() }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      controller: path.join(bundle, 'application/assets/repair/windows-job-controller.ps1'), runtime,
      admissionExports: ['assertNativePublicationEvidence', 'verifyNativeEvidenceSignature']
    });
  });
  it('refuses missing template, controller, HCL and host-policy material without checkout fallback', async () => {
    const damaged = await copy('missing asset package');
    for (const relative of ['application/assets/plugins/go-huma/go-backend/go.mod',
      'application/assets/repair/windows-job-controller.ps1',
      'application/node_modules/@cdktf/hcl2json/main.wasm.gz', 'installation/platforms.json',
      'installation/release-policy.json', 'installation/native-release-admission.mjs']) {
      const file = path.join(damaged, relative), bytes = await readFile(file), mode = (await lstat(file)).mode & 0o777;
      await rm(file);
      try {
        await expect(verifyNativeBundle(damaged)).rejects.toThrow();
        const result = relative.endsWith('go.mod')
          ? execute(path.join(damaged, manifest.launcher), ['plan', ...installedPlanCases.find(plan => plan.id === 'manual-cli-only')!.args])
          : relative.endsWith('.ps1')
            ? installed(`import { verifyWindowsJobControllerAsset } from ${JSON.stringify(moduleUrl('adapters/process/windows-job-runner.js', damaged))}; await verifyWindowsJobControllerAsset();`, damaged)
            : relative.endsWith('platforms.json')
              ? execute(path.join(damaged, manifest.launcher), ['--version'])
              : relative.startsWith('installation/')
                ? installed(`await import(${JSON.stringify(pathToFileURL(path.join(damaged, 'installation/native-release-admission.mjs')).href)});`, damaged)
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
  it.runIf(process.platform === 'darwin')('refuses public macOS installation while minimum-host and signing qualification remain absent', () => {
    expect(() => assertNativeHost(observeNativeHost(), { publicInstallation: true })).toThrow('minimum host');
  });
  it.runIf(windows)('refuses replacement of a running Windows image and retains the original bytes', async () => {
    const locked = await copy('locked Windows version');
    const executable = path.join(locked, manifest.runtime.executable);
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
      const before = await bundleFile(executable);
      await expect(copyFile(runtime, executable)).rejects.toThrow();
      expect((await bundleFile(executable)).sha256).toBe(before.sha256);
    } finally { child.kill(); await exited; }
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
