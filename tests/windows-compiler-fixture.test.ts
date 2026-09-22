import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilerFixtureSource, compilerMarkerDecoder, exactControllerDefinition, observeCompilerProcess } from '../scripts/windows-compiler-fixture.mjs';

afterEach(() => { vi.useRealTimers(); });

describe('isolated native compiler diagnostic contract', () => {
  const binding = 'a'.repeat(64);
  const moduleRoot = path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const options = { moduleScope: 'baseline', moduleRoot };
  const stages = [
    'script-started', 'module-root-verified', 'original-environment-recorded', 'module-scope-verified',
    'effective-environment-recorded', 'command-resolution-started', 'command-discovered', 'command-identity-recorded',
    'command-resolution-ready', 'compile-started', 'compile-ready'
  ];
  function completeFrames() {
    const metadata = { 'original-environment-recorded': 'o', 'effective-environment-recorded': 'e', 'command-identity-recorded': 'm' };
    return stages.map(stage => {
      const kind = metadata[stage as keyof typeof metadata];
      return (kind ? ['a', 'b'].map(part => `LIFTOFF_COMPILE:${binding}:${kind}${part}:${'c'.repeat(32)}\r\n`).join('') : '') +
        `LIFTOFF_COMPILE:${binding}:${stage}\r\n`;
    }).join('');
  }
  it('copies exactly the pinned controller definition without invoking its native methods or changing execution policy', async () => {
    const asset = await readFile(path.join(process.cwd(), 'assets', 'repair', 'windows-job-controller.ps1'));
    const definition = exactControllerDefinition(asset), script = compilerFixtureSource('exact', binding, definition, options);
    expect(script).toContain(`$win32TypeDef = @"\n${definition}\n"@`);
    expect(script).toContain('& $compiler -TypeDefinition $win32TypeDef -ErrorAction Stop');
    expect(script).not.toContain('[Win32JobNative]::');
    expect(script).not.toMatch(/Set-ExecutionPolicy|-ExecutionPolicy\s|Bypass|Unrestricted/);
    expect(() => exactControllerDefinition(Buffer.concat([asset, Buffer.from('\n')]))).toThrow('identity mismatch');
    expect(compilerFixtureSource('trivial', binding, definition, options)).not.toContain(definition);
    expect(script).not.toContain('$Env:PSModulePath =');
    const fixture = await readFile(path.join(process.cwd(), 'scripts', 'windows-compiler-fixture.mjs'), 'utf8');
    expect(fixture).toContain("qualification: 'incomplete-descendant-settlement'");
    expect(fixture).toContain('passed: false');
    expect(fixture).toContain('if (!result.passed) process.exitCode = 1');
  });
  it('changes only diagnostic module discovery after verifying the local builtin root and reparse ancestors', async () => {
    const asset = await readFile(path.join(process.cwd(), 'assets', 'repair', 'windows-job-controller.ps1'));
    const definition = exactControllerDefinition(asset);
    const scoped = compilerFixtureSource('exact', binding, definition, { ...options, moduleScope: 'builtin-only' });
    expect(scoped).toContain('$Env:PSModulePath = $builtin');
    expect(scoped).toContain('[Environment+SpecialFolder]::Windows');
    expect(scoped).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(scoped).toContain('[IO.DriveType]::Fixed');
    expect(scoped.indexOf("Mark 'module-root-verified'")).toBeLessThan(scoped.indexOf('$Env:PSModulePath = $builtin'));
    expect(scoped.indexOf('$Env:PSModulePath = $builtin')).toBeLessThan(scoped.indexOf('Get-Command -Name Add-Type'));
    expect(scoped).toContain(`$win32TypeDef = @"\n${definition}\n"@`);
    expect(scoped).not.toMatch(/Set-ExecutionPolicy|SetValue|HKLM:|HKCU:/);
    const prelude = scoped.slice(0, scoped.indexOf("    Mark 'command-resolution-started'"));
    expect(prelude).not.toMatch(/\b(?:Get-Item|Resolve-Path|Join-Path|Test-Path|Get-FileHash|Import-Module|New-Object|ConvertTo-Json)\b/);
    expect(scoped.replace([
      '    $Env:PSModulePath = $builtin',
      "    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($Env:PSModulePath, $builtin)) { throw 'Module scope mismatch.' }",
      ''
    ].join('\n'), '')).toBe(compilerFixtureSource('exact', binding, definition, options));
    for (const unsafe of ['\\\\server\\share\\Modules', '..\\Modules', `${moduleRoot}'`, `${moduleRoot}\\..\\Modules`]) {
      expect(() => compilerFixtureSource('exact', binding, definition, { ...options, moduleRoot: unsafe })).toThrow();
    }
    expect(() => compilerFixtureSource('exact', binding, definition, { ...options, moduleScope: 'ambient' })).toThrow();
  });
  it('recognizes only bound ordered phases and rejects replay, injected text and partial output', () => {
    const decoder = compilerMarkerDecoder(binding);
    const text = completeFrames();
    expect([...text].flatMap(character => decoder.feed(character))).toEqual(stages);
    expect(decoder.result().complete).toBe(true);
    expect(decoder.result()).toMatchObject({
      originalEnvironmentDigest: 'c'.repeat(64), effectiveEnvironmentDigest: 'c'.repeat(64), resolvedCommandIdentityDigest: 'c'.repeat(64)
    });
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
  it('rejects unbound, oversized, missing or out-of-order environment and module identity fragments', () => {
    for (const text of [
      completeFrames().replace(`LIFTOFF_COMPILE:${binding}:oa:${'c'.repeat(32)}\r\n`, ''),
      completeFrames().replace(`LIFTOFF_COMPILE:${binding}:oa:`, `LIFTOFF_COMPILE:${binding}:eb:`),
      completeFrames().replace(`LIFTOFF_COMPILE:${binding}:oa:${'c'.repeat(32)}`, `LIFTOFF_COMPILE:${binding}:oa:${'c'.repeat(33)}`),
      `LIFTOFF_COMPILE:${binding}:ma:${'c'.repeat(32)}\n` + completeFrames()
    ]) {
      const decoder = compilerMarkerDecoder(binding);
      decoder.feed(text);
      expect(decoder.result().complete).toBe(false);
      expect(decoder.result().rejected).toBe(true);
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
    f.child.stdout!.emit('data', Buffer.from(completeFrames()));
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
