import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractWindowsJobInteropSource, windowsJobInteropSdkVersion } from '../scripts/windows-job-interop.mjs';
import {
  captureWindowsJobInteropAssembly, prepareWindowsJobInteropAssembly, WindowsJobInteropAssemblyCache,
  windowsJobControllerAssetDigest, windowsJobInteropAssemblyAssetDigest, windowsJobInteropAssemblyAssetPathParts,
  type WindowsJobInteropCaptureOperations, type WindowsJobInteropPreparationOperations
} from '../src/adapters/process/windows-job-runner.js';

const directories: string[] = [];
const asset = path.join(process.cwd(), ...windowsJobInteropAssemblyAssetPathParts);
const identity = {
  controllerAssetDigest: windowsJobControllerAssetDigest,
  assemblyAssetDigest: windowsJobInteropAssemblyAssetDigest,
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function sourceCopy() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-packaged-interop-'));
  directories.push(directory);
  const file = path.join(directory, 'source.dll');
  await copyFile(asset, file);
  return file;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('verified packaged Windows Job interop', () => {
  it('binds actual first-party DLL bytes, unchanged literal C# and locked compiler inputs', async () => {
    const bytes = await captureWindowsJobInteropAssembly(asset);
    expect(bytes.length).toBe(9216);
    expect(sha256(bytes)).toBe(windowsJobInteropAssemblyAssetDigest);
    const source = extractWindowsJobInteropSource(await readFile('assets/repair/windows-job-controller.ps1'));
    expect(source.length).toBe(11029);
    expect(sha256(source)).toBe('0d843d351ee4712c0476a3ce343a96ad4f33a3a5bf421e1ba7c015f57b19f6a3');
    expect(windowsJobInteropSdkVersion).toBe('10.0.402');
    const lock = JSON.parse(await readFile('scripts/windows-job-interop/packages.lock.json', 'utf8'));
    expect(lock.dependencies['.NETFramework,Version=v4.6.2']).toEqual({
      'Microsoft.NETFramework.ReferenceAssemblies.net462': {
        type: 'Direct', requested: '[1.0.3, 1.0.3]', resolved: '1.0.3',
        contentHash: 'IzAV30z22ESCeQfxP29oVf4qEo8fBGXLXSU6oacv/9Iqe6PzgHDKCaWfwMBak7bSJQM0F5boXWoZS+kChztRIQ=='
      }
    });
    const project = await readFile('scripts/windows-job-interop/Interop.csproj', 'utf8');
    expect(project).toContain('<TargetFramework>net462</TargetFramework>');
    expect(project).toContain('<Deterministic>true</Deterministic>');
    expect(project).toContain('Version="[1.0.3]" PrivateAssets="all"');
  });

  it('rejects missing or multiple literal definitions instead of guessing another C# source', () => {
    expect(() => extractWindowsJobInteropSource(Buffer.from('no source'))).toThrow('exactly one literal');
    const literal = '$win32TypeDef = @"\nclass Exact {}\n"@';
    expect(extractWindowsJobInteropSource(Buffer.from(literal))).toEqual(Buffer.from('class Exact {}'));
    expect(() => extractWindowsJobInteropSource(Buffer.from(`${literal}\n${literal}`))).toThrow('exactly one literal');
  });

  it('rejects unknown rebuild arguments before attempting an SDK or network operation', () => {
    const result = spawnSync(process.execPath, ['scripts/windows-job-interop.mjs', '--unknown'], {
      env: { ...process.env, PATH: '' }, encoding: 'utf8', shell: false, timeout: 10_000
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: node scripts/windows-job-interop.mjs [--write]');
    expect(result.stderr).not.toContain('could not run dotnet');
  });

  it('seeds the first exclusive private file before controller launch without publishing unauthenticated cache bytes', async () => {
    const cache = new WindowsJobInteropAssemblyCache();
    const prepared = await prepareWindowsJobInteropAssembly({
      identity, packagedAssemblyPath: asset, startupTimeoutMs: 1000, cache
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    directories.push(prepared.directory);
    expect(prepared.reservation.kind).toBe('producer');
    expect(await readFile(prepared.assemblyPath)).toEqual(await readFile(asset));
    expect((await lstat(prepared.assemblyPath)).nlink).toBe(1);
    if (process.platform !== 'win32') expect((await lstat(prepared.assemblyPath)).mode & 0o777).toBe(0o600);
    let published = false;
    const waiting = cache.reserve(identity).then(value => { published = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(published).toBe(false);
    if (prepared.reservation.kind !== 'producer') throw new Error('Expected a producer.');
    prepared.reservation.publish(await captureWindowsJobInteropAssembly(prepared.assemblyPath));
    expect(await waiting).toMatchObject({ kind: 'consumer' });
    const next = await prepareWindowsJobInteropAssembly({
      identity, packagedAssemblyPath: asset, startupTimeoutMs: 1000, cache
    });
    if (!next.ok) throw new Error(next.errorMessage);
    directories.push(next.directory);
    expect(next.reservation.kind).toBe('consumer');
    expect(next.assemblyPath).not.toBe(prepared.assemblyPath);
    expect(await readFile(next.assemblyPath)).toEqual(await readFile(asset));
    expect(await next.cleanup()).toBe(true);
    expect(await prepared.cleanup()).toBe(true);
  });

  it.each(['missing', 'changed', 'hard-linked'] as const)(
    'rejects an actually %s packaged asset even when authenticated bytes already exist in cache', async mode => {
      const file = await sourceCopy(), cache = new WindowsJobInteropAssemblyCache();
      const producer = await cache.reserve(identity);
      if (producer.kind !== 'producer') throw new Error('Expected a producer.');
      producer.publish(await readFile(file));
      if (mode === 'missing') await rm(file);
      if (mode === 'changed') {
        const changed = await readFile(file);
        changed[changed.length - 1] = changed.readUInt8(changed.length - 1) ^ 1;
        await writeFile(file, changed);
      }
      if (mode === 'hard-linked') await link(file, `${file}.link`);
      const createPrivateDirectory = vi.fn<WindowsJobInteropPreparationOperations['createPrivateDirectory']>();
      const operations: WindowsJobInteropPreparationOperations = {
        createPrivateDirectory, writePrivateFile: vi.fn(), removePrivateDirectory: vi.fn()
      };
      const result = await prepareWindowsJobInteropAssembly({
        identity, packagedAssemblyPath: file, startupTimeoutMs: 1000, cache, operations
      });
      expect(result).toMatchObject({ ok: false, reason: 'failed', cleanupStatus: 'complete' });
      expect(createPrivateDirectory).not.toHaveBeenCalled();
      if (result.ok) throw new Error('Expected refusal.');
      expect(result.errorMessage).toMatch(/ENOENT|integrity failure|not a private regular file/u);
      expect(await result.cleanup).toBe(true);
    }
  );

  it('rejects poisoned cached PE-looking bytes rather than writing them into the current private directory', async () => {
    const cache = new WindowsJobInteropAssemblyCache(), producer = await cache.reserve(identity);
    if (producer.kind !== 'producer') throw new Error('Expected a producer.');
    producer.publish(Buffer.from([0x4d, 0x5a, 1]));
    const result = await prepareWindowsJobInteropAssembly({
      identity, packagedAssemblyPath: asset, startupTimeoutMs: 1000, cache
    });
    expect(result).toMatchObject({ ok: false, reason: 'failed', cleanupStatus: 'complete' });
    if (result.ok) throw new Error('Expected refusal.');
    expect(result.errorMessage).toContain('differs from the freshly verified packaged assembly');
  });

  it('invalidates a ready cache when the declared packaged assembly identity changes', async () => {
    const cache = new WindowsJobInteropAssemblyCache(), producer = await cache.reserve(identity);
    if (producer.kind !== 'producer') throw new Error('Expected a producer.');
    producer.publish(await readFile(asset));
    expect(await cache.reserve({ ...identity, assemblyAssetDigest: 'f'.repeat(64) })).toMatchObject({ kind: 'producer' });
  });

  it.each(['path', 'digest'] as const)('requires both the packaged path and exact digest when %s is absent', async missing => {
    const result = await prepareWindowsJobInteropAssembly({
      identity: missing === 'digest' ? { controllerAssetDigest: identity.controllerAssetDigest, powershellPath: identity.powershellPath } : identity,
      packagedAssemblyPath: missing === 'path' ? undefined : asset,
      startupTimeoutMs: 1000, cache: new WindowsJobInteropAssemblyCache()
    });
    expect(result).toMatchObject({ ok: false, reason: 'failed', cleanupStatus: 'complete' });
    if (result.ok) throw new Error('Expected refusal.');
    expect(result.errorMessage).toContain('exact asset path and SHA-256 identity');
  });

  it.each(['timeout', 'aborted'] as const)(
    'bounds delayed actual asset capture by the same startup deadline and drains after %s without creating or writing private files',
    async reason => {
      const cache = new WindowsJobInteropAssemblyCache(), abort = new AbortController();
      const handle = await open(asset, 'r');
      const original = await lstat(asset, { bigint: true });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let opened!: () => void;
      const entered = new Promise<void>(resolve => { opened = resolve; });
      let closed = false;
      const captureOperations: WindowsJobInteropCaptureOperations = {
        lstat: async () => original,
        open: async () => {
          opened();
          await held;
          return {
            stat: () => handle.stat({ bigint: true }),
            read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async () => { await handle.close(); closed = true; }
          };
        }
      };
      const operations: WindowsJobInteropPreparationOperations = {
        createPrivateDirectory: vi.fn(), writePrivateFile: vi.fn(), removePrivateDirectory: vi.fn()
      };
      const preparing = prepareWindowsJobInteropAssembly({
        identity, packagedAssemblyPath: asset, startupTimeoutMs: reason === 'timeout' ? 100 : 1000,
        signal: abort.signal, cache, operations, captureOperations
      });
      try {
        await entered;
        if (reason === 'aborted') abort.abort();
        const result = await preparing;
        expect(result).toMatchObject({ ok: false, reason, cleanupStatus: 'pending' });
        if (result.ok) throw new Error('Expected bounded capture refusal.');
        expect(closed).toBe(false);
        expect(operations.createPrivateDirectory).not.toHaveBeenCalled();
        expect(operations.writePrivateFile).not.toHaveBeenCalled();
        release();
        expect(await result.cleanup).toBe(true);
        expect(closed).toBe(true);
        const next = await cache.reserve(identity);
        expect(next.kind).toBe('producer');
        if (next.kind === 'producer') next.fail(new Error('test complete'));
      } finally {
        release();
        const result = await preparing;
        if (!result.ok) await result.cleanup;
        if (!closed) await handle.close();
      }
    }
  );

  it('checks each invocation copy after authenticated readiness before cache publication or target dispatch', async () => {
    const runner = await readFile('src/adapters/process/windows-job-runner.ts', 'utf8');
    const capture = runner.indexOf('const bytes = await captureWindowsJobInteropAssembly(', runner.indexOf('async function handleIncomingMessage'));
    expect(runner.lastIndexOf('session.authenticateControllerReady(r)', capture)).toBeGreaterThan(0);
    expect(capture).toBeLessThan(runner.indexOf('interopReservation.publish(bytes)', capture));
    expect(capture).toBeLessThan(runner.indexOf('const spawnReq = session.requestRootStart()', capture));
    expect(runner.slice(capture, runner.indexOf('interopPublished = true;', capture)))
      .toContain('!== windowsJobInteropAssemblyAssetDigest');
    expect(runner).toContain('if (interopAssemblyPath && !interopPublished)');
    expect(runner).toContain("['-InteropAssemblyPath', interopAssemblyPath, '-RequirePrecompiledInterop']");
    const controller = await readFile('assets/repair/windows-job-controller.ps1', 'utf8');
    for (const message of ['The packaged Win32 interop assembly is required.', 'The private packaged Win32 interop assembly is missing.']) {
      const refusal = controller.indexOf(`throw '${message}'`);
      expect(refusal).toBeGreaterThan(0);
      expect(refusal).toBeLessThan(controller.indexOf('& $compilerCmdlet -TypeDefinition', refusal));
    }
  });
});
