import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  assertDependencyClosure, assertNativeBundleReport, assertNativeRuntimeArchitectures,
  assertNativeRuntimeBuildVersion, assertPortableProductionDependencies, assertSystemRuntimeLibraries,
  bundleFile, bundleInventory, bundlePath, minimumNativeMacosVersion, nativeBundleCases, nativeBundleHost,
  nativeBundleLimits
} from '../scripts/native-bundle-contract.mjs';
import { buildNativeBundle, fetchNativeInput, nativeBundleArguments } from '../scripts/native-bundle.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff native bundle contract ')));
  roots.push(root);
  return root;
}

function dependencyLock() {
  return {
    lockfileVersion: 3,
    packages: {
      'node_modules/example': {
        version: '1.2.3', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`
      }
    }
  };
}

describe('native development bundle contracts', () => {
  it('qualifies native Apple Silicon at the runtime-derived macOS floor', () => {
    expect(nativeBundleHost({
      platform: 'darwin', architecture: 'arm64', operatingSystemVersion: '13.5', translated: false
    })).toEqual({
      platform: 'darwin', architecture: 'arm64', operatingSystemVersion: '13.5',
      translated: false, minimumOperatingSystemVersion: minimumNativeMacosVersion
    });
    expect(nativeBundleHost({
      platform: 'darwin', architecture: 'arm64', operatingSystemVersion: '13.5.1', translated: false
    }).operatingSystemVersion).toBe('13.5.1');
    expect(nativeBundleHost({
      platform: 'darwin', architecture: 'arm64', operatingSystemVersion: '14.0', translated: false
    }).operatingSystemVersion).toBe('14.0');
  });

  it('refuses Intel, translated, below-floor and unqualified hosts before native work', () => {
    const supported = {
      platform: 'darwin', architecture: 'arm64', operatingSystemVersion: '13.5', translated: false
    };
    for (const changed of [
      { platform: 'linux' },
      { platform: 'win32' },
      { architecture: 'x64' },
      { architecture: 'x64', translated: true },
      { translated: true },
      { translated: undefined },
      { operatingSystemVersion: '13.4.9' },
      { operatingSystemVersion: 'unobserved' }
    ]) expect(() => nativeBundleHost({ ...supported, ...changed })).toThrow();
  });

  it('requires explicit build inputs and rejects duplicate, extra and release-like authority options', () => {
    expect(nativeBundleArguments(['build', '--output', 'new bundle', '--runtime-archive', 'runtime.tgz']))
      .toEqual({ operation: 'build', output: path.resolve('new bundle'), runtimeArchive: path.resolve('runtime.tgz') });
    expect(nativeBundleArguments(['verify', 'bundle'])).toEqual({ operation: 'verify', output: path.resolve('bundle') });
    expect(nativeBundleArguments(['verify-report', 'report.json']))
      .toEqual({ operation: 'verify-report', output: path.resolve('report.json') });
    for (const args of [[], ['publish'], ['build'], ['build', '--output', 'a', '--output', 'b'],
      ['build', '--output', 'a', '--signed', 'true'], ['verify'], ['verify', 'a', '--release'],
      ['verify', '--output'], ['build', '--runtime-archive', '--output', '--output', 'a']]) {
      expect(() => nativeBundleArguments(args)).toThrow();
    }
  });

  it('requires every actual installed qualification case and rejects empty, skipped or duplicate evidence', () => {
    const file = {
      name: '/checkout/tests/native-bundle-installed.test.ts',
      assertionResults: nativeBundleCases.map(title => ({ title, status: 'passed' }))
    };
    const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [file] };
    expect(assertNativeBundleReport(report)).toEqual({ cases: nativeBundleCases.length, passed: nativeBundleCases.length });
    for (const changed of [
      { ...report, success: false },
      { ...report, numFailedTests: 1 },
      { ...report, numFailedTestSuites: 1 },
      { ...report, testResults: [] },
      { ...report, testResults: [file, file] },
      { ...report, testResults: [{ ...file, name: '/checkout/tests/native-bundle.test.ts' }] },
      { ...report, testResults: [{ ...file, assertionResults: [] }] },
      { ...report, testResults: [{ ...file, assertionResults: file.assertionResults.slice(1) }] },
      { ...report, testResults: [{ ...file, assertionResults: [...file.assertionResults, file.assertionResults[0]] }] },
      { ...report, testResults: [{ ...file, assertionResults: file.assertionResults.map(test => ({ ...test, status: 'pending' })) }] }
    ]) expect(() => assertNativeBundleReport(changed)).toThrow();
  });

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')
  ('refuses existing output and checkout aliases before reading archives or invoking build tools', async () => {
    const root = await fixture();
    const existing = path.join(root, 'existing');
    await mkdir(existing);
    await writeFile(path.join(existing, 'marker'), 'preserved');
    const inputs = { runtimeArchive: path.join(root, 'absent-runtime'), npmCli: process.execPath };
    await expect(buildNativeBundle({ ...inputs, output: existing })).rejects.toThrow('already exists');
    expect(await readFile(path.join(existing, 'marker'), 'utf8')).toBe('preserved');
    await symlink(process.cwd(), path.join(root, 'checkout-alias'));
    await expect(buildNativeBundle({ ...inputs, output: path.join(root, 'checkout-alias', path.basename(root)) }))
      .rejects.toThrow('outside the source checkout');
  });

  it.each(['', '../outside', '/absolute', 'C:/drive', 'a\\b', 'a//b', 'a/./b', 'a/../b',
    'a/CON.txt', 'a/lpt1', 'a/end.', 'a/end ', 'a/name\nother', 'a/name:stream', 'a/?'])
  ('rejects nonportable inventory path %j', value => {
    expect(() => bundlePath(value)).toThrow();
  });

  it('accepts scoped modules, dotfiles and paths containing spaces', () => {
    for (const name of ['application/node_modules/@inquirer/core/LICENSE',
      'application/assets/plugins/azure/.terraform.lock.hcl', 'root with spaces/file.txt']) {
      expect(bundlePath(name)).toBe(name);
    }
  });

  it('inventories bytes, modes, empty directories and relative internal links deterministically', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'empty'));
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/a'), 'source');
    await writeFile(path.join(root, 'zero'), '');
    if (process.platform !== 'win32') await symlink('nested/a', path.join(root, 'alias'));
    const first = await bundleInventory(root);
    expect(first).toEqual(await bundleInventory(root));
    expect(first.totalBytes).toBe(6);
    expect(first.entries).toContainEqual(expect.objectContaining({ path: 'empty', kind: 'directory' }));
    expect(first.entries).toContainEqual(expect.objectContaining({ path: 'nested/a', kind: 'file', bytes: 6 }));
    expect((await bundleFile(path.join(root, 'zero'))).sha256)
      .toBe(createHash('sha256').update('').digest('hex'));
    await writeFile(path.join(root, 'nested/a'), 'changed');
    expect((await bundleInventory(root)).sha256).not.toBe(first.sha256);
  });

  it('excludes only the independently parsed root manifest, not nested namesakes', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'bundle.json'), 'manifest');
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/bundle.json'), 'content');
    const inventory = await bundleInventory(root);
    expect(inventory.entries.map(entry => entry.path)).toEqual(['nested', 'nested/bundle.json']);
  });

  it('rejects hard-linked regular inputs before reading', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'one'), 'original');
    await link(path.join(root, 'one'), path.join(root, 'two'));
    await expect(bundleFile(path.join(root, 'one'))).rejects.toThrow('single-link');
    await expect(bundleInventory(root)).rejects.toThrow('single-link');
    expect(await readFile(path.join(root, 'two'), 'utf8')).toBe('original');
  });

  it.runIf(process.platform !== 'win32')('refuses escaping, absolute and broken links without changing their targets', async () => {
    const root = await fixture();
    const bundle = path.join(root, 'bundle');
    await mkdir(bundle);
    await writeFile(path.join(root, 'outside'), 'protected');
    for (const target of ['../outside', path.join(root, 'outside'), 'absent']) {
      await symlink(target, path.join(bundle, 'link'));
      await expect(bundleInventory(bundle)).rejects.toThrow();
      await rm(path.join(bundle, 'link'));
      expect(await readFile(path.join(root, 'outside'), 'utf8')).toBe('protected');
    }
  });

  it('enforces file, total, depth and entry bounds', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/a'), '12345');
    await writeFile(path.join(root, 'b'), '12345');
    for (const changed of [{ fileBytes: 4 }, { totalBytes: 9 }, { depth: 0 }, { entries: 2 }]) {
      await expect(bundleInventory(root, { ...nativeBundleLimits, ...changed })).rejects.toThrow();
    }
    await expect(bundleFile(path.join(root, 'b'), 4)).rejects.toThrow('byte limit');
  });

  it.runIf(process.platform === 'linux')('rejects case aliases on a case-sensitive host', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'Same'), 'first');
    await writeFile(path.join(root, 'same'), 'second');
    await expect(bundleInventory(root)).rejects.toThrow('alias');
  });

  it('requires actual system-only dynamic-library output, rejecting Homebrew and rpath dependencies', () => {
    const header = '/private/native bundle/runtime/node:\n';
    const system = '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n';
    expect(assertSystemRuntimeLibraries(header + system)).toEqual(['/usr/lib/libSystem.B.dylib']);
    for (const extra of ['\t@rpath/libnode.137.dylib (compatibility version 0.0.0, current version 0.0.0)\n',
      '\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)\n',
      '\t/usr/lib/../../foreign.dylib (compatibility version 1.0.0, current version 1.0.0)\n', 'unparsed\n']) {
      expect(() => assertSystemRuntimeLibraries(header + system + extra)).toThrow();
    }
    expect(() => assertSystemRuntimeLibraries(header)).toThrow('incomplete');
  });

  it('binds the private runtime to thin ARM64 Mach-O and its macOS build floor', () => {
    expect(assertNativeRuntimeArchitectures('arm64\n')).toEqual(['arm64']);
    for (const output of ['x86_64\n', 'arm64 x86_64\n', '', 'arm64\narm64\n']) {
      expect(() => assertNativeRuntimeArchitectures(output)).toThrow();
    }
    const build = [
      'Load command 9',
      '      cmd LC_BUILD_VERSION',
      '  cmdsize 32',
      ' platform 1',
      '    minos 13.5',
      '      sdk 15.0',
      '   ntools 1',
      ''
    ].join('\n');
    expect(assertNativeRuntimeBuildVersion(build)).toEqual({
      format: 'Mach-O', architectures: ['arm64'], platform: 'macos', platformCode: 1,
      minimumMacosVersion: '13.5', sdkVersion: '15.0'
    });
    for (const changed of [
      build.replace('LC_BUILD_VERSION', 'LC_VERSION_MIN_MACOSX'),
      build.replace('platform 1', 'platform 2'),
      build.replace('minos 13.5', 'minos 13.4'),
      build.replace('sdk 15.0', 'sdk unknown'),
      `${build}Load command 10\n      cmd LC_BUILD_VERSION\n platform 1\n minos 13.5\n sdk 15.0\n`
    ]) expect(() => assertNativeRuntimeBuildVersion(changed)).toThrow();
  });

  it('requires a platform-neutral production dependency closure', () => {
    expect(assertPortableProductionDependencies([
      '@cdktf/hcl2json/main.wasm.gz', 'commander/index.js', '.bin/liftoff'
    ])).toEqual({ nativeAddons: [] });
    for (const name of ['package/native.node', 'package/lib.dylib', 'package/lib.so',
      'package/lib.so.1', 'package/helper.dll', 'package/helper.exe']) {
      expect(() => assertPortableProductionDependencies(['portable.js', name])).toThrow();
    }
    for (const header of ['cffaedfe', 'cafebabe', '7f454c46', '4d5a9000']) {
      expect(() => assertPortableProductionDependencies([
        { path: 'extensionless-helper', header }
      ])).toThrow();
    }
    expect(() => assertPortableProductionDependencies([
      { path: 'invalid-evidence', header: 'not-hex' }
    ])).toThrow();
  });

  it('requires exact locked production dependencies, while allowing an omitted optional package', () => {
    const lock = dependencyLock();
    expect(assertDependencyClosure(lock, lock)).toEqual([{
      path: 'node_modules/example', version: '1.2.3', integrity: lock.packages['node_modules/example'].integrity
    }]);
    expect(() => assertDependencyClosure(lock, { ...lock, packages: {
      ...lock.packages, 'node_modules/optional': { optional: true }
    } })).not.toThrow();
    expect(() => assertDependencyClosure(lock, { ...lock, packages: {
      ...lock.packages, 'node_modules/required': { version: '2.0.0' }
    } })).toThrow('absent');
    expect(() => assertDependencyClosure({ lockfileVersion: 3, packages: {} }, lock)).toThrow('empty');
  });

  it('preserves npm registry-selected entries without inventing a resolved URL', () => {
    const source = dependencyLock();
    const { resolved: _resolved, ...entry } = source.packages['node_modules/example'];
    const lock = { lockfileVersion: 3, packages: { 'node_modules/example': entry } };
    expect(assertDependencyClosure(lock, lock)).toEqual([{
      path: 'node_modules/example', version: entry.version, integrity: entry.integrity
    }]);
    expect(() => assertDependencyClosure(source, lock)).toThrow('resolved differs');
  });

  it('rejects changed versions, weak integrity, credentials, linked and development-only dependencies', () => {
    const lock = dependencyLock();
    for (const changed of [{ version: '9.0.0' }, { integrity: 'sha1-weak' }, { integrity: 'sha512-AA==' }, { dev: true }, { link: true },
      { resolved: 'https://token:secret@registry.npmjs.org/example.tgz' }]) {
      const modified = { ...lock, packages: { 'node_modules/example': { ...lock.packages['node_modules/example'], ...changed } } };
      expect(() => assertDependencyClosure(modified, lock)).toThrow();
      if ('integrity' in changed || 'resolved' in changed) {
        expect(() => assertDependencyClosure(modified, modified)).toThrow();
      }
    }
    expect(() => assertDependencyClosure({ ...lock, lockfileVersion: 2 }, lock)).toThrow('version 3');
  });

  it('checks fetched input status, exact checksum and a streaming byte ceiling', async () => {
    const input = { url: 'https://nodejs.org/example', sha256: createHash('sha256').update('original').digest('hex') };
    const response = (body: string, status = 200) => {
      const value = new Response(body, { status });
      Object.defineProperty(value, 'url', { value: input.url });
      return value;
    };
    const fetch = vi.fn().mockResolvedValueOnce(response('original'))
      .mockResolvedValueOnce(response('changed'))
      .mockResolvedValueOnce(response('original'))
      .mockResolvedValueOnce(response('failure', 503));
    vi.stubGlobal('fetch', fetch);
    expect((await fetchNativeInput(input)).toString()).toBe('original');
    await expect(fetchNativeInput(input)).rejects.toThrow('checksum');
    await expect(fetchNativeInput(input, 3)).rejects.toThrow('byte limit');
    await expect(fetchNativeInput(input)).rejects.toThrow('retrieval failed');
    await expect(fetchNativeInput({ ...input, url: 'http://example.invalid' })).rejects.toThrow('HTTPS');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.runIf(process.platform !== 'win32')('preserves literal arguments, exit status and external PATH through a linked launcher', async () => {
    const root = await fixture();
    const bundle = path.join(root, 'bundle with spaces');
    for (const name of ['bin', 'runtime', 'application/dist']) await mkdir(path.join(bundle, name), { recursive: true });
    const launcher = path.join(bundle, 'bin/liftoff');
    await copyFile(path.join(process.cwd(), 'distribution/native/launcher.sh'), launcher);
    await chmod(launcher, 0o755);
    const fakeRuntime = path.join(bundle, 'runtime/node');
    await writeFile(fakeRuntime,
      '#!/bin/sh\nprintf "%s\\n" "$@" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" "$PATH"\nexit 7\n',
      { mode: 0o755 });
    await symlink('bundle with spaces/bin/liftoff', path.join(root, 'linked liftoff'));
    const result = spawnSync(path.join(root, 'linked liftoff'), ['space argument', '$literal', ';not-a-command'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, shell: false,
      env: { PATH: path.join(root, 'empty'), NODE_OPTIONS: '--require=unselected', NODE_PATH: 'unselected' }
    });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      path.join(bundle, 'application/dist/cli.js'), 'space argument', '$literal', ';not-a-command',
      'unset', 'unset', path.join(root, 'empty')
    ]);
  });
});
