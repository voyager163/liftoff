import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilerFixtureSource, compilerMarkerDecoder, exactControllerDefinition, observeCompilerProcess } from '../scripts/windows-compiler-fixture.mjs';

afterEach(() => { vi.useRealTimers(); });

describe('isolated native compiler diagnostic contract', () => {
  const binding = 'a'.repeat(64);
  it('copies exactly the pinned controller definition without invoking its native methods or changing execution policy', async () => {
    const asset = await readFile(path.join(process.cwd(), 'assets', 'repair', 'windows-job-controller.ps1'));
    const definition = exactControllerDefinition(asset), script = compilerFixtureSource('exact', binding, definition);
    expect(script).toContain(`$win32TypeDef = @"\n${definition}\n"@`);
    expect(script).toContain('& $compiler -TypeDefinition $win32TypeDef -ErrorAction Stop');
    expect(script).not.toContain('[Win32JobNative]::');
    expect(script).not.toMatch(/ExecutionPolicy|Bypass|Unrestricted/);
    expect(() => exactControllerDefinition(Buffer.concat([asset, Buffer.from('\n')]))).toThrow('identity mismatch');
    expect(compilerFixtureSource('trivial', binding, definition)).not.toContain(definition);
    const fixture = await readFile(path.join(process.cwd(), 'scripts', 'windows-compiler-fixture.mjs'), 'utf8');
    expect(fixture).toContain("qualification: 'incomplete-descendant-settlement'");
    expect(fixture).toContain('passed: false');
    expect(fixture).toContain('if (!result.passed) process.exitCode = 1');
  });
  it('recognizes only bound ordered phases and rejects replay, injected text and partial output', () => {
    const stages = ['script-started', 'command-resolution-started', 'command-resolution-ready', 'compile-started', 'compile-ready'];
    const decoder = compilerMarkerDecoder(binding);
    const text = stages.map(stage => `LIFTOFF_COMPILE:${binding}:${stage}\r\n`).join('');
    expect([...text].flatMap(character => decoder.feed(character))).toEqual(stages);
    expect(decoder.result().complete).toBe(true);
    decoder.feed(`LIFTOFF_COMPILE:${binding}:compile-ready\n`);
    expect(decoder.result().complete).toBe(false);
    for (const text of [
      `LIFTOFF_COMPILE:${'b'.repeat(64)}:script-started\n`,
      `LIFTOFF_COMPILE:${binding}:compile-ready\n`,
      `${'x'.repeat(1000)}LIFTOFF_COMPILE:${binding}:script-started\n`,
      `LIFTOFF_COMPILE:${binding}:script-started`,
      `LIFTOFF_COMPILE:${binding}:failed\n`
    ]) {
      const altered = compilerMarkerDecoder(binding);
      altered.feed(text);
      expect(altered.result().complete).toBe(false);
      expect(JSON.stringify(altered.result())).not.toContain(binding);
    }
  });

  function processes() {
    const child = new ChildProcess(), killer = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 12345 });
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const launch = vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const options = { executable: path.resolve('powershell.exe'), script: path.resolve('fixture.ps1'),
      repository: process.cwd(), env: { SystemRoot: path.resolve('fixture-windows') }, binding };
    return { child, killer, launch, promise: observeCompilerProcess(options, launch), options };
  }
  it('retains only bounded phases and counts, never raw compiler errors', async () => {
    const f = processes();
    f.child.stdout!.emit('data', Buffer.from([
      'script-started', 'command-resolution-started', 'command-resolution-ready', 'compile-started', 'compile-ready'
    ].map(stage => `LIFTOFF_COMPILE:${binding}:${stage}\n`).join('')));
    f.child.stderr!.emit('data', Buffer.from('NONFUNCTIONAL_COMPILER_ERROR_SENTINEL'));
    f.child.exitCode = 0; f.child.emit('close', 0);
    const result = await f.promise;
    expect(result).toMatchObject({ closed: true, exitCode: 0, complete: true, failure: null, termination: 'not-requested' });
    expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_COMPILER_ERROR_SENTINEL');
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('targets only its exact live PID after the unchanged ten-second compiler deadline', async () => {
    vi.useFakeTimers();
    const f = processes();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.launch).toHaveBeenLastCalledWith(path.join(f.options.env.SystemRoot, 'System32', 'taskkill.exe'),
      ['/PID', '12345', '/T', '/F'], expect.objectContaining({ shell: false, stdio: 'ignore', timeout: 5000 }));
    f.killer.emit('close', 0); f.child.emit('close', 1);
    expect(await f.promise).toMatchObject({ failure: 'deadline', termination: 'completed', closed: true, complete: false });
  });
  it('never targets a process that already exited and reports unclosed resources honestly', async () => {
    vi.useFakeTimers();
    const f = processes();
    f.child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(await f.promise).toMatchObject({ failure: 'deadline', closed: false, complete: false, termination: 'not-requested' });
  });
  it('rejects excessive output without retaining it or manufacturing a passing result', async () => {
    const f = processes();
    f.child.stdout!.emit('data', Buffer.alloc(4097, 65));
    f.killer.emit('close', 0); f.child.emit('close', 1);
    expect(await f.promise).toMatchObject({ failure: 'output-limit', complete: false, events: [], outputBytes: 4097 });
    expect(f.launch).toHaveBeenCalledTimes(2);
  });
});
