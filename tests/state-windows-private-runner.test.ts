import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureWindowsPrivateExecutable, verifyWindowsPrivateProcessAsset, WindowsPrivateProcessRunner,
  windowsPrivateProcessAssetDigest, windowsPrivateProcessContract, type WindowsPrivateExecutable
} from '../src/adapters/state/windows-private-runner.js';
import { windowsWorkingDirectoryLimit } from '../src/domain/execution/windows-working-directory.js';

const roots: string[] = [];
const retainedRoots = new Set<string>();
const runners: WindowsPrivateProcessRunner[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(runners.map((runner) => runner.quiesce()));
  if (roots.some((root) => retainedRoots.has(root))) throw new Error('Retain the exact source fixture: private parent-loss settlement is unproven.');
  runners.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = path.resolve('tests', `.wpriv-${randomUUID().slice(0, 8)}`);
  await mkdir(root);
  const canonical = await realpath(root); roots.push(canonical); return canonical;
}

describe('Windows private runner source admission, not Windows qualification', () => {
  it('pins a separate private helper and preserves the public controller identity', async () => {
    const file = await verifyWindowsPrivateProcessAsset();
    const source = await readFile(file, 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(windowsPrivateProcessAssetDigest);
    expect(windowsPrivateProcessContract).toMatchObject({
      kind: 'windows-private-job-pipes/1', helperDigest: windowsPrivateProcessAssetDigest,
      encryptedCustody: false, nativeQualification: 'not-established-by-source', cleanupMs: 2000
    });
    const publicBytes = await readFile('assets/repair/windows-job-controller.ps1');
    expect(createHash('sha256').update(publicBytes).digest('hex'))
      .toBe('a7aa404d84d1e0a9188b8c9d487533cacee830b4d58172ef959d159895c2d909');
    for (const primitive of ['CreatePipe', 'SetHandleInformation', '0x0002000D', '0x00020002', 'GetProcessTimes',
      'Process32First', 'CancelSynchronousIo', 'QueryInformationJobObject', 'Array.Clear']) expect(source).toContain(primitive);
    expect(source).not.toMatch(/(?:stdoutFile|stderrFile|GetTempFileName|WriteAllText|WriteAllBytes|CreateNamedPipe|ExecutionPolicy\s+Bypass|File\.Create|FileMode\.Create)/);
    expect(source.indexOf('Suspended | Extended | UnicodeEnvironment')).toBeLessThan(source.indexOf('ResumeThread(target.thread)'));
    expect(source.indexOf('IsProcessInJob(target.process')).toBeLessThan(source.indexOf('ResumeThread(target.thread)'));
  });

  it('rejects absent or corrupted private assets without accepting an override digest', async () => {
    const root = await fixture();
    const file = path.join(root, 'windows-private-process.ps1');
    await expect(verifyWindowsPrivateProcessAsset(file)).rejects.toMatchObject({ code: 'helper-unavailable' });
    await copyFile('assets/repair/windows-private-process.ps1', file);
    expect(await verifyWindowsPrivateProcessAsset(file)).toBe(file);
    await writeFile(file, 'NONSECRET corrupted fixture');
    await expect(verifyWindowsPrivateProcessAsset(file)).rejects.toMatchObject({ code: 'helper-unavailable' });
  });

  it('observes exact bounded executable bytes without treating the observation as native execution', async () => {
    const root = await fixture();
    const filename = path.join(root, 'nonexecuted-fixture.exe');
    const content = Buffer.from('NONSECRET identity fixture');
    await writeFile(filename, content);
    const selected = await captureWindowsPrivateExecutable(filename);
    expect(selected).toEqual({ path: filename, sha256: createHash('sha256').update(content).digest('hex') });
    await writeFile(filename, 'NONSECRET changed fixture');
    expect((await captureWindowsPrivateExecutable(filename)).sha256).not.toBe(selected.sha256);
  });

  it.skipIf(process.platform === 'win32')('refuses a foreign host while wiping transferred private input', async () => {
    const input = Buffer.from([0, 255, 128, 0]);
    const runner = new WindowsPrivateProcessRunner({ path: '/not-a-windows-interpreter', sha256: 'a'.repeat(64) });
    await expect(runner.run({
      executable: { path: '/not-a-windows-target', sha256: 'a'.repeat(64) }, args: [], cwd: process.cwd(),
      stdin: input, timeoutMs: 1000, maximumBytes: 1024
    })).rejects.toMatchObject({ code: 'unsupported-host' });
    expect(input.every((byte) => byte === 0)).toBe(true);
    await runner.quiesce();
  });

  it('wipes an oversized transferred input before any host or executable admission', async () => {
    const input = Buffer.alloc(windowsPrivateProcessContract.maximumInputBytes + 1, 7);
    const runner = new WindowsPrivateProcessRunner({ path: 'not-a-host', sha256: 'a'.repeat(64) });
    await expect(runner.run({
      executable: { path: 'not-a-target', sha256: 'a'.repeat(64) }, args: [], cwd: process.cwd(),
      stdin: input, timeoutMs: 1000, maximumBytes: 1024
    })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(input.every((byte) => byte === 0)).toBe(true);
    await runner.quiesce();
  });
});

describe.skipIf(process.platform !== 'win32')('actual Windows private binary pipes and owned jobs (NONSECRET source fixtures, not custody)', () => {
  async function host() {
    const powershell = await captureWindowsPrivateExecutable(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const executable = await captureWindowsPrivateExecutable(await realpath(process.execPath));
    const root = await fixture();
    const runner = new WindowsPrivateProcessRunner(powershell);
    runners.push(runner);
    return { root, executable, powershell, runner };
  }
  function request(value: { root: string; executable: WindowsPrivateExecutable }, code: string, extra: Record<string, unknown> = {}) {
    return { executable: value.executable, args: ['-e', code], cwd: value.root,
      timeoutMs: 15_000, maximumBytes: 16384, ...extra };
  }

  it('round-trips NUL/non-UTF8 private input/output with separate stderr and no payload artifacts', async () => {
    const value = await host();
    const input = Buffer.from([78, 79, 78, 83, 69, 67, 82, 69, 84, 0, 255, 128]);
    const expected = Buffer.from(input);
    const before = await readdir(value.root);
    const result = await value.runner.run(request(value,
      "const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(b));process.stderr.write(Buffer.from([0,254,129]));});",
      { stdin: input }));
    expect(input.every((byte) => byte === 0)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).equals(expected)).toBe(true);
    expect([...result.stderr]).toEqual([0, 254, 129]);
    result.dispose(); expected.fill(0);
    expect(result.stdout.every((byte) => byte === 0)).toBe(true);
    expect(result.stderr.every((byte) => byte === 0)).toBe(true);
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual(before);
  });

  it.each(['output-limit', 'timeout'] as const)('settles the owned job after %s and returns no partial private output', async (kind) => {
    const value = await host();
    const input = Buffer.from('NONSECRET fixture');
    const code = kind === 'output-limit' ? "process.stdout.write(Buffer.alloc(32768));setInterval(()=>{},100);" : 'setInterval(()=>{},100);';
    await expect(value.runner.run(request(value, code, {
      stdin: input, maximumBytes: 4096, timeoutMs: kind === 'timeout' ? 1000 : 15000
    }))).rejects.toMatchObject({ code: kind });
    expect(input.every((byte) => byte === 0)).toBe(true);
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual([]);
  });

  it('retains a real nonzero exit and binary error output rather than manufacturing command success', async () => {
    const value = await host();
    const result = await value.runner.run(request(value, 'process.stderr.write(Buffer.from([0,255,78]));process.exit(23);'));
    expect(result.exitCode).toBe(23);
    expect([...result.stderr]).toEqual([0, 255, 78]);
    expect(result.stdout.length).toBe(0);
    result.dispose();
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual([]);
  });

  it('cancels only the authenticated running job and leaves an unrelated neighbor untouched', async () => {
    const value = await host();
    const neighbor = spawn(process.execPath, ['-e', 'process.stdout.write("NONSECRET-ready");setInterval(()=>{},100);'], {
      cwd: value.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    try {
      await once(neighbor.stdout!, 'data');
      const controller = new AbortController();
      await expect(value.runner.run(request(value, 'process.stdout.write("NONSECRET-started");setInterval(()=>{},100);', {
        signal: controller.signal, observePrivateStdout: () => controller.abort()
      }))).rejects.toMatchObject({ code: 'cancelled' });
      await value.runner.quiesce();
      expect(neighbor.exitCode).toBeNull();
    } finally {
      const closed = once(neighbor, 'close'); neighbor.kill(); await closed;
    }
    expect(await readdir(value.root)).toEqual([]);
  });

  it('does not treat root exit as descendant settlement or successful completion', async () => {
    const value = await host();
    await expect(value.runner.run(request(value,
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});process.exit(0);"
    ))).rejects.toMatchObject({ code: 'native-command-failed' });
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual([]);
  });

  it('terminates the owned root and descendants when the authenticated parent is lost', async () => {
    const value = await host();
    const target = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});process.stdout.write(JSON.stringify({kind:'descendant',root:process.pid,child:c.pid})+'\\n');setInterval(()=>{},100);";
    const moduleUrl = pathToFileURL(path.resolve('dist/adapters/state/windows-private-runner.js')).href;
    const script = `
      import { WindowsPrivateProcessRunner } from ${JSON.stringify(moduleUrl)};
      const runner = new WindowsPrivateProcessRunner(${JSON.stringify(value.powershell)});
      await runner.run({
        executable: ${JSON.stringify(value.executable)}, args: ['-e', ${JSON.stringify(target)}],
        cwd: ${JSON.stringify(value.root)}, timeoutMs: 15000, maximumBytes: 4096,
        observeOwnership: value => process.stdout.write(JSON.stringify({kind:'owner',...value})+'\\n'),
        observePrivateStdout: bytes => process.stdout.write(Buffer.from(bytes))
      });
    `;
    retainedRoots.add(value.root);
    const parent = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: value.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    try {
      const observations = await new Promise<Record<string, any>>((resolve, reject) => {
        let text = '';
        const seen: Record<string, any> = {};
        parent.stdout!.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          if (text.length > 4096) { reject(new Error('NONSECRET source observation exceeded its bound.')); return; }
          for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) {
            const row = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
            seen[row.kind] = row;
          }
          if (seen.owner && seen.descendant) resolve(seen);
        });
        parent.once('error', reject);
        parent.once('exit', () => reject(new Error('The source-fixture parent exited before both owned-process observations.')));
      });
      expect(observations.owner.parentPid).toBe(parent.pid);
      expect(observations.descendant.root).toBe(observations.owner.rootPid);
      const pids = [observations.owner.controllerPid, observations.owner.rootPid, observations.descendant.child];
      expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
      const closed = once(parent, 'close'); parent.kill(); await closed;
      const absent = (pid: number): boolean => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      };
      const end = Date.now() + 2000;
      while (!pids.every(absent) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pids.every(absent)).toBe(true);
      retainedRoots.delete(value.root);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        const closed = once(parent, 'close'); parent.kill(); await closed;
      }
    }
    expect(await readdir(value.root)).toEqual([]);
  });

  it('refuses inherited Restricted policy without bypass or input persistence', async () => {
    const value = await host();
    vi.stubEnv('PSExecutionPolicyPreference', 'Restricted');
    const input = Buffer.from('NONSECRET private fixture');
    await expect(value.runner.run(request(value, 'process.exit(0)', { stdin: input })))
      .rejects.toMatchObject({ code: 'helper-unavailable' });
    expect(input.every((byte) => byte === 0)).toBe(true);
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual([]);
  });

  it('preserves the shared cwd limit and rejects changed executable admission before launch', async () => {
    const value = await host();
    await expect(value.runner.run({ ...request(value, 'process.exit(0)'), cwd: `C:\\${'a'.repeat(windowsWorkingDirectoryLimit)}` }))
      .rejects.toMatchObject({ code: 'working-directory-too-long' });
    await expect(value.runner.run({ ...request(value, 'process.exit(0)'), executable: { ...value.executable, sha256: '0'.repeat(64) } }))
      .rejects.toMatchObject({ code: 'executable-changed' });
    await value.runner.quiesce();
    expect(await readdir(value.root)).toEqual([]);
  });
});
