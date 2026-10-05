import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceInventory, configurationInventory, coveragePackage } from '../scripts/coverage-gate.mjs';
import { bundleInventory, nativeBundleHost } from '../scripts/native-bundle-contract.mjs';
import { verifyNativeBundle } from '../scripts/native-bundle.mjs';
import { installedPlanCases, planContractIssues } from '../scripts/package-smoke-contract.mjs';

const suppliedBundle = process.env.LIFTOFF_NATIVE_BUNDLE_ROOT;
const suppliedGo = process.env.LIFTOFF_NATIVE_GO_EXECUTABLE;
const forbidden = ['node', 'npm', 'npm.cmd', 'npx', 'openspec', 'specify', 'copilot', 'claude', 'codex'];
let fixtureRoot: string;
let fixtureIdentity: { dev: number; ino: number };
let bundle: string;
let bundleVersion: string;
let cli: string;
let runtime: string;
let outside: string;
let emptyPath: string;
let tools: string;
let probeLog: string;
let failed = false;
let setupComplete = false;
let probeSequence = 0;
let environment: NodeJS.ProcessEnv;

function execute(executable: string, args: string[], cwd = outside, env = environment) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `Native qualification process was signalled: ${result.signal}`);
  assert.notEqual(result.status, null, 'Native qualification process did not settle normally.');
  return result;
}

function installedScript(code: string, root = bundle) {
  return execute(path.join(root, 'runtime/node'), ['--input-type=module', '-e', code]);
}

function installedModule(relative: string, root = bundle) {
  return pathToFileURL(path.join(root, 'application', 'dist', relative)).href;
}

function manual(api = 'go', agents = 'none') {
  return ['--spec', 'manual', '--agents', agents, '--type', 'standard', '--api', api,
    '--no-frontend', '--environments', 'dev', '--governance', 'none', '--yes'];
}

async function probeNames() {
  try {
    return (await readFile(probeLog, 'utf8')).trim().split('\n').map(file => path.basename(file)).filter(Boolean);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

describe.skipIf(!suppliedBundle)('actual runtime-inclusive installed bundle', () => {
  beforeAll(async () => {
    nativeBundleHost();
    assert.ok(suppliedBundle && path.isAbsolute(suppliedBundle), 'An explicit native bundle path is required.');
    assert.ok(suppliedGo && path.isAbsolute(suppliedGo), 'An explicit actual external Go executable is required.');
    bundle = await realpath(suppliedBundle);
    const manifest = await verifyNativeBundle(bundle);
    bundleVersion = manifest.package.version;
    expect(manifest.source.sourceDigest).toBe(sourceInventory(coveragePackage('cli')).digest);
    expect(manifest.source.configurationDigest).toBe(configurationInventory(coveragePackage('cli')).digest);
    expect(manifest.runtime.observed).toEqual({ version: '24.21.0', platform: 'darwin', architecture: 'arm64' });
    fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff native installed ')));
    fixtureIdentity = await lstat(fixtureRoot);
    console.info(`Native installed qualification fixture: ${fixtureRoot}`);
    outside = path.join(fixtureRoot, 'outside with spaces');
    emptyPath = path.join(fixtureRoot, 'empty path');
    tools = path.join(fixtureRoot, 'selected tools');
    probeLog = path.join(fixtureRoot, 'probe-attempts');
    const home = path.join(fixtureRoot, 'home');
    const goTelemetry = path.join(home, 'Library/Application Support/go/telemetry');
    for (const directory of [outside, emptyPath, tools, home, goTelemetry,
      path.join(home, '.config/openspec'), path.join(fixtureRoot, 'tmp')]) {
      await mkdir(directory, { recursive: true });
    }
    // Go can start a telemetry sidecar for probes; opt out in this fixture only.
    await writeFile(path.join(goTelemetry, 'mode'), 'off\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(home, '.config/openspec/config.json'), '{unselected invalid global profile\n');
    await symlink(await realpath(suppliedGo), path.join(tools, 'go'));
    await symlink('/usr/bin/git', path.join(tools, 'git'));
    for (const name of forbidden) {
      await writeFile(path.join(tools, name),
        '#!/bin/sh\nprintf "%s\\n" "$0" >> "$LIFTOFF_NATIVE_PROBE_LOG"\nexit 69\n', { mode: 0o755 });
    }
    environment = {
      PATH: emptyPath, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      TMPDIR: path.join(fixtureRoot, 'tmp'), TMP: path.join(fixtureRoot, 'tmp'), TEMP: path.join(fixtureRoot, 'tmp'),
      CI: 'true', NO_COLOR: '1', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1', CHECKPOINT_DISABLE: '1',
      LIFTOFF_NATIVE_PROBE_LOG: probeLog
    };
    cli = path.join(bundle, 'bin/liftoff');
    runtime = path.join(bundle, 'runtime/node');
    const telemetry = execute(path.join(tools, 'go'), ['env', 'GOTELEMETRY']);
    expect(telemetry.status, telemetry.stderr).toBe(0);
    expect(telemetry.stdout.trim()).toBe('off');
    setupComplete = true;
  }, 60_000);

  beforeEach(() => {
    if (!setupComplete) return;
    probeLog = path.join(fixtureRoot, `probe-attempts-${probeSequence++}`);
    environment = { ...environment, LIFTOFF_NATIVE_PROBE_LOG: probeLog };
  });

  afterEach(({ task }) => { if (task.result?.state !== 'pass') failed = true; });

  afterAll(async () => {
    if (!setupComplete || failed) return;
    const current = await lstat(fixtureRoot);
    expect(current.isDirectory()).toBe(true);
    expect({ dev: current.dev, ino: current.ino }).toEqual({ dev: fixtureIdentity.dev, ino: fixtureIdentity.ino });
    await verifyNativeBundle(bundle);
    await rm(fixtureRoot, { recursive: true });
  });

  it('runs actual help, version and capabilities through direct and linked launchers with an empty PATH', async () => {
    const before = await bundleInventory(outside);
    const homeBefore = await bundleInventory(environment.HOME!);
    const help = execute(cli, ['--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('liftoff');
    const version = execute(cli, ['--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`Liftoff ${bundleVersion}`);
    const linked = path.join(fixtureRoot, 'linked liftoff');
    await symlink(cli, linked);
    const capabilities = execute(linked, ['capabilities', '--json'], outside, {
      ...environment, NODE_OPTIONS: '--require=/unselected-startup.js', NODE_PATH: '/unselected-modules'
    });
    expect(capabilities.status, capabilities.stderr).toBe(0);
    expect(JSON.parse(capabilities.stdout)).toMatchObject({
      schemaVersion: 1, runtime: { distribution: 'node/npm', nativeDistribution: false }
    });
    expect(await bundleInventory(outside)).toEqual(before);
    expect(await bundleInventory(environment.HOME!)).toEqual(homeBefore);
    expect(await probeNames()).toEqual([]);
  });

  it('runs every existing installed planning contract without global Node/npm or framework tools', async () => {
    const before = await bundleInventory(outside);
    for (const plan of installedPlanCases) {
      const result = execute(cli, ['plan', ...plan.args]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(planContractIssues(result.stdout, plan)).toEqual([]);
    }
    expect(await bundleInventory(outside)).toEqual(before);
    expect(await probeNames()).toEqual([]);
  });

  it('keeps installed live assessment help project-independent and tool-free', async () => {
    const before = await bundleInventory(outside);
    const homeBefore = await bundleInventory(environment.HOME!);
    for (const argv of [
      ['assess', '--live', '--help'],
      ['assess', '--live', '--help', '--json'],
      ['help', 'assess']
    ]) {
      const result = execute(cli, argv);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('--live');
      expect(result.stdout).toContain('GitHub');
    }
    expect(await bundleInventory(outside)).toEqual(before);
    expect(await bundleInventory(environment.HOME!)).toEqual(homeBefore);
    expect(await probeNames()).toEqual([]);
  });

  it('assesses explicit local and unbound live projects without global tools or project/user-state changes', async () => {
    const before = await bundleInventory(outside);
    const homeBefore = await bundleInventory(environment.HOME!);
    for (const profile of ['none', 'single-maintainer-gitflow']) {
      for (const live of [false, true]) {
        const result = execute(cli, [
          'assess', '--project', outside, '--governance', profile, '--json', ...(live ? ['--live'] : [])
        ]);
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(result.stderr).toBe('');
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({
          schemaVersion: 1, readOnly: true, mode: live ? 'live' : 'local', outcome: 'partial',
          snapshot: { inputsStable: !live || profile === 'none' },
          project: { root: outside, kind: 'non-git' }, target: { profile, profileSelection: 'explicit' }
        });
        expect(report.coverage.notObserved).toBeGreaterThan(0);
        if (live) {
          const findings = report.findings.filter((finding: { id: string }) => finding.id.startsWith('live.'));
          expect(findings.length).toBeGreaterThan(0);
          expect(findings.every((finding: { supported: boolean; classification: string; observed: { availability: string; source: unknown } }) =>
            !finding.supported && finding.classification === 'not-observed' &&
            finding.observed.availability === 'not-observed' && finding.observed.source === null)).toBe(true);
        }
      }
    }
    expect(await bundleInventory(outside)).toEqual(before);
    expect(await bundleInventory(environment.HOME!)).toEqual(homeBefore);
    expect(await probeNames()).toEqual([]);
  });

  it('initializes and validates real Manual/no-agent Go output using external Go, never private Node as a toolchain', async () => {
    const profile = path.join(environment.HOME!, '.config/openspec/config.json');
    const before = await readFile(profile);
    const result = execute(cli, ['init', 'manual-go', ...manual()], outside, { ...environment, PATH: tools });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Running Liftoff runtime: Node.js 24.21.0');
    expect(await probeNames()).toEqual([]);
    const project = path.join(outside, 'manual-go');
    const manifest = JSON.parse(await readFile(path.join(project, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      artifactVersion: 8, framework: { state: 'not-required' },
      project: { specWorkflow: 'manual', agents: [] }, governance: { profile: 'none' }
    });
    for (const name of ['openspec', '.specify', '.claude', '.agents']) {
      await expect(lstat(path.join(project, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const validation = execute(cli, ['validate', project]);
    expect(validation.status, validation.stdout + validation.stderr).toBe(0);
    expect(await readFile(profile)).toEqual(before);
  });

  it('still probes and requires external Node/npm for a selected Node workload before writing a project', async () => {
    const result = execute(cli, ['init', 'blocked-node', ...manual('node')], outside, { ...environment, PATH: tools });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(new Set(await probeNames())).toEqual(new Set(['node', 'npm']));
    await expect(lstat(path.join(outside, 'blocked-node'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires an explicitly selected Manual agent without adding a framework or external Node requirement', async () => {
    const result = execute(cli, ['init', 'blocked-agent', ...manual('go', 'claude')], outside, { ...environment, PATH: tools });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(new Set(await probeNames())).toEqual(new Set(['claude']));
    await expect(lstat(path.join(outside, 'blocked-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes the installed isolated HCL parser and resolves the controller from the installed boundary', () => {
    const result = installedScript(`
      import { parseIsolatedHcl } from ${JSON.stringify(installedModule('adapters/hcl/isolated-parser.js'))};
      import { verifyWindowsJobControllerAsset } from ${JSON.stringify(installedModule('adapters/process/windows-job-runner.js'))};
      const parsed = await parseIsolatedHcl(['locals { enabled = true }\\n']);
      console.log(JSON.stringify({ parsed: parsed[0].parsed, controller: await verifyWindowsJobControllerAsset(), runtime: process.execPath }));
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      parsed: { locals: [{ enabled: true }] },
      controller: path.join(bundle, 'application/assets/repair/windows-job-controller.ps1'),
      runtime
    });
  });

  it('refuses missing template, controller and HCL material without borrowing checkout or global assets', async () => {
    const damaged = path.join(fixtureRoot, 'damaged bundle');
    await cp(bundle, damaged, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await verifyNativeBundle(damaged);
    for (const missing of [
      'assets/plugins/go-huma/go-backend/go.mod',
      'assets/repair/windows-job-controller.ps1',
      'node_modules/@cdktf/hcl2json/main.wasm.gz'
    ]) {
      const file = path.join(damaged, 'application', missing);
      const bytes = await readFile(file);
      const mode = (await lstat(file)).mode & 0o777;
      await rm(file);
      try {
        await expect(verifyNativeBundle(damaged)).rejects.toThrow();
        const result = missing.endsWith('go.mod')
          ? execute(path.join(damaged, 'bin/liftoff'), ['plan', ...installedPlanCases.find(plan => plan.id === 'manual-cli-only')!.args])
          : installedScript(missing.endsWith('.ps1')
            ? `import { verifyWindowsJobControllerAsset } from ${JSON.stringify(installedModule('adapters/process/windows-job-runner.js', damaged))}; await verifyWindowsJobControllerAsset();`
            : `import { parseIsolatedHcl } from ${JSON.stringify(installedModule('adapters/hcl/isolated-parser.js', damaged))}; await parseIsolatedHcl(['locals { enabled = true }\\n']);`, damaged);
        expect(result.status, result.stdout + result.stderr).toBe(1);
      } finally {
        await writeFile(file, bytes, { flag: 'wx', mode });
        await chmod(file, mode);
      }
      await verifyNativeBundle(damaged);
    }
  }, 120_000);

  it('rejects edited release claims, runtime pins, package identity and license inventories', async () => {
    const damaged = path.join(fixtureRoot, 'edited manifest bundle');
    await cp(bundle, damaged, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const file = path.join(damaged, 'bundle.json');
    const bytes = await readFile(file);
    const original = await verifyNativeBundle(damaged);
    for (const changed of [
      { ...original, releaseReady: true },
      { ...original, boundaries: { ...original.boundaries, signed: true } },
      { ...original, source: { ...original.source, builderInputs: [] } },
      { ...original, source: { ...original.source, sourceDigest: '0'.repeat(64) } },
      { ...original, runtime: { ...original.runtime, version: '0.0.0' } },
      { ...original, package: { ...original.package, name: 'foreign-package' } },
      { ...original, package: { ...original.package, lockSha256: '0'.repeat(64) } },
      { ...original, package: { ...original.package, sourceFiles: [] } },
      { ...original, assets: [] },
      { ...original, hclSource: { ...original.hclSource, reproducibleSourceCorrespondenceVerified: true } },
      { ...original, dependencies: [] },
      { ...original, supplementalNotices: [] }
    ]) {
      await writeFile(file, JSON.stringify(changed));
      try {
        await expect(verifyNativeBundle(damaged)).rejects.toThrow();
      } finally {
        await writeFile(file, bytes);
      }
    }
    await verifyNativeBundle(damaged);
  }, 120_000);

  it('rejects non-executable and changed private runtime bytes even with a recomputed inventory', async () => {
    const damaged = path.join(fixtureRoot, 'changed runtime bundle');
    await cp(bundle, damaged, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const file = path.join(damaged, 'bundle.json');
    const bytes = await readFile(file);
    const original = await verifyNativeBundle(damaged);
    const node = path.join(damaged, 'runtime/node');
    await chmod(node, 0o644);
    try {
      await writeFile(file, JSON.stringify({ ...original, inventory: await bundleInventory(damaged) }));
      await expect(verifyNativeBundle(damaged)).rejects.toThrow('not executable');
    } finally {
      await chmod(node, 0o755);
      await writeFile(file, bytes);
    }
    const handle = await open(node, 'r+');
    const saved = Buffer.alloc(1);
    try {
      expect((await handle.read(saved, 0, 1, 0)).bytesRead).toBe(1);
      try {
        expect((await handle.write(Buffer.from([saved[0]! ^ 0xff]), 0, 1, 0)).bytesWritten).toBe(1);
        await writeFile(file, JSON.stringify({ ...original, inventory: await bundleInventory(damaged) }));
        await expect(verifyNativeBundle(damaged)).rejects.toThrow('runtime bytes differ');
      } finally {
        expect((await handle.write(saved, 0, 1, 0)).bytesWritten).toBe(1);
        await writeFile(file, bytes);
      }
    } finally {
      await handle.close();
    }
    await verifyNativeBundle(damaged);
  }, 120_000);
});
