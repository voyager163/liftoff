import { execFile, spawn as spawnFixture, type ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCommand, NodeCommandRunner } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import { CaptureStream } from './helpers.js';

const cleanups: string[] = [];
const scratchRoot = path.join(process.cwd(), '.cache', 'process-runner-tests');
const treeFiles: string[] = [];
const neighbors: ChildProcess[] = [];
const execFileAsync = promisify(execFile);
let counter = 0;

interface TreeFixture {
  parent: number;
  descendant: number;
  group: number | null;
}

async function processState(pid: number): Promise<{ running: boolean; command: string }> {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { running: false, command: '' };
    throw error;
  }
  if (process.platform === 'win32') return { running: true, command: '' };
  try {
    const result = await execFileAsync('ps', ['-ww', '-o', 'stat=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 500, maxBuffer: 32 * 1024
    });
    const value = result.stdout.trim();
    return { running: value !== '' && !value.startsWith('Z'), command: value };
  } catch (error) {
    if ((error as { code?: number }).code === 1) return { running: false, command: '' };
    throw error;
  }
}

async function fixtureState(file: string): Promise<TreeFixture> {
  const value = JSON.parse(await readFile(file, 'utf8')) as TreeFixture;
  if (![value.parent, value.descendant].every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) ||
      (value.group !== null && (!Number.isSafeInteger(value.group) || value.group <= 0))) {
    throw new Error('Invalid owned process fixture identities.');
  }
  return value;
}

async function waitForFixture(file: string): Promise<TreeFixture> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await fixtureState(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error('Owned process fixture did not start.');
}

async function expectStopped(state: TreeFixture): Promise<void> {
  for (const pid of [state.parent, state.descendant]) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!(await processState(pid)).running) break;
      await delay(10);
    }
    expect((await processState(pid)).running, `Owned fixture PID ${pid} is still running`).toBe(false);
  }
}

async function cleanupTree(file: string): Promise<void> {
  let state: TreeFixture;
  try { state = await fixtureState(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const living: number[] = [];
  for (const pid of [state.parent, state.descendant]) {
    const process = await processState(pid);
    if (!process.running) continue;
    if (process.command && !process.command.includes(file)) {
      throw new Error('Refusing to terminate a PID that no longer belongs to this fixture.');
    }
    living.push(pid);
  }
  if (process.platform !== 'win32' && living.length && state.group === state.parent) {
    try { process.kill(-state.group, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const pid of living) {
    if (!(await processState(pid)).running) continue;
    if (process.platform === 'win32') {
      await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { timeout: 1000 });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
}

async function treeCommand(mode: 'timeout' | 'output' | 'orphan-output'): Promise<{ file: string; command: ExternalCommand }> {
  const file = path.join(await testRoot('owned-tree'), 'processes.json');
  treeFiles.push(file);
  const descendant = `
    process.on('SIGTERM', () => {});
    ${mode !== 'timeout' ? "setTimeout(() => process.stdout.write('x'.repeat(4096)), 100);" : ''}
    setTimeout(() => {}, 3500);
  `;
  return {
    file,
    command: {
      executable: process.execPath,
      args: ['-e', `
        const {spawn, execFileSync} = require('node:child_process');
        const {writeFileSync, renameSync} = require('node:fs');
        const file = process.argv[1];
        const group = process.platform === 'win32' ? null :
          Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding:'utf8', timeout:500}).trim());
        const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, file], {stdio:['ignore','inherit','inherit']});
        descendant.once('spawn', () => {
          writeFileSync(file + '.stage', JSON.stringify({parent:process.pid, descendant:descendant.pid, group}));
          renameSync(file + '.stage', file);
          process.stdout.write('ready\\n');
          ${mode === 'orphan-output' ? 'descendant.unref(); process.exit(0);' : 'setTimeout(() => {}, 3500);'}
        });
      `, file]
    }
  };
}

async function testRoot(name: string): Promise<string> {
  counter += 1;
  const root = path.join(scratchRoot, `${name}-${process.pid}-${counter}`);
  await mkdir(root, { recursive: true });
  cleanups.push(root);
  return root;
}

beforeEach(async () => {
  await mkdir(scratchRoot, { recursive: true });
});

afterEach(async () => {
  for (const neighbor of neighbors.splice(0)) {
    if (neighbor.exitCode === null && neighbor.signalCode === null) neighbor.kill('SIGKILL');
  }
  for (const file of treeFiles.splice(0)) await cleanupTree(file);
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

describe('external command runner', () => {
  it('passes hostile-looking arguments literally without shell interpolation', async () => {
    const root = await testRoot('literal-args');
    const sentinel = path.join(root, 'shell-expanded');
    const literal = `; touch ${sentinel}`;
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', literal]
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(literal);
    await expect(access(sentinel)).rejects.toThrow();
  });

  it('captures and optionally streams stdout and stderr', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err")']
    }, { stream: true, stdout, stderr });

    expect(result).toMatchObject({ status: 0, stdout: 'out', stderr: 'err', timedOut: false });
    expect(stdout.text()).toBe('out');
    expect(stderr.text()).toBe('err');
  });

  it('preserves streamed bytes while decoding UTF-8 split across child chunks', async () => {
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 30)'
      ]
    }, { stream: true, stdout });

    expect(result).toMatchObject({ status: 0, stdout: '€', timedOut: false });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('€'));
  });

  it('redacts sensitive stdin echoes from returned and streamed output across chunks', async () => {
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdin.on("data", (chunk) => { const value = String(chunk); process.stdout.write(value.slice(0, 18)); setTimeout(() => process.stdout.write(value.slice(18)), 5); process.stderr.write(`err:${value}`); });'
      ]
    }, {
      stdin: token,
      stream: true,
      stdout,
      stderr,
      redactValues: [token]
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(stdout.text()).not.toContain(token);
    expect(stderr.text()).not.toContain(token);
    expect(`${result.stdout}${result.stderr}${stdout.text()}${stderr.text()}`)
      .toContain('<redacted-sensitive-value>');
  });

  it('terminates timed-out probes and records the timeout', async () => {
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)']
    }, { timeoutMs: 20 });

    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
  });

  it('bounds combined child output during capture and discards oversized output', async () => {
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(700)); process.stderr.write("b".repeat(700)); setTimeout(() => {}, 10_000)']
    }, { maxOutputBytes: 1024, timeoutMs: 5_000 });

    expect(result).toMatchObject({
      outputLimitExceeded: true, stdout: '', stderr: '', errorCode: 'MAX_OUTPUT_BYTES_EXCEEDED', timedOut: false
    });
  });

  it('measures bounded UTF-8 output in bytes rather than characters', async () => {
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("€".repeat(100))']
    }, { maxOutputBytes: 200 });

    expect(result).toMatchObject({ outputLimitExceeded: true, stdout: '', stderr: '' });
  });

  it('preserves complete output at the exact optional byte limit', async () => {
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("€".repeat(100))']
    }, { maxOutputBytes: 300 });

    expect(result).toMatchObject({ status: 0, outputLimitExceeded: false, stdout: '€'.repeat(100) });
  });

  it('does not flush partial sensitive redactor buffers after hitting the output limit', async () => {
    const stdout = new CaptureStream();
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1].slice(0, 18)); setTimeout(() => process.stdout.write(process.argv[1].slice(18)), 30)', token]
    }, { maxOutputBytes: 20, stream: true, stdout, redactValues: [token] });

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout).toBe('');
    expect(stdout.text()).toBe('');
  });

  it('terminates bounded requests even when a child ignores SIGTERM', async () => {
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)']
    }, { maxOutputBytes: 1024, timeoutMs: 200 });

    expect(result).toMatchObject({ timedOut: true, status: null, outputLimitExceeded: false });
  });

  it('settles at timeout after terminating its owned tree, not when inherited pipes eventually close', async () => {
    const fixture = await treeCommand('timeout');
    const neighbor = spawnFixture(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { stdio: 'ignore' });
    neighbors.push(neighbor);
    const timeoutMs = process.platform === 'win32' ? 800 : 200;
    const started = performance.now();
    const result = await new NodeCommandRunner().run(fixture.command, { timeoutMs });

    expect(performance.now() - started).toBeLessThan(timeoutMs + 800);
    expect(result).toMatchObject({ timedOut: true, status: null });
    const state = await fixtureState(fixture.file);
    if (process.platform !== 'win32') expect(state.group).toBe(state.parent);
    await expectStopped(state);
    expect((await processState(neighbor.pid!)).running).toBe(true);
  });

  it('terminates the entire owned tree on output overflow and settles without waiting for descendant pipes', async () => {
    const fixture = await treeCommand('output');
    const started = performance.now();
    const result = await new NodeCommandRunner().run(fixture.command, { maxOutputBytes: 1024 });

    expect(performance.now() - started).toBeLessThan(1300);
    expect(result).toMatchObject({
      outputLimitExceeded: true, errorCode: 'MAX_OUTPUT_BYTES_EXCEEDED', stdout: '', stderr: '', timedOut: false
    });
    await expectStopped(await fixtureState(fixture.file));
  });

  it.runIf(process.platform !== 'win32')('kills the owned POSIX group even after its leader has exited', async () => {
    const fixture = await treeCommand('orphan-output');
    const started = performance.now();
    const result = await new NodeCommandRunner().run(fixture.command, { maxOutputBytes: 1024 });

    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ outputLimitExceeded: true, stdout: '', stderr: '' });
    const state = await fixtureState(fixture.file);
    expect(state.group).toBe(state.parent);
    await expectStopped(state);
  });

  it('honors AbortSignal by terminating the owned tree and removes its abort listener', async () => {
    const fixture = await treeCommand('timeout');
    const controller = new AbortController();
    const pending = new NodeCommandRunner().run(fixture.command, { signal: controller.signal });
    const state = await waitForFixture(fixture.file);
    const started = performance.now();
    controller.abort(new Error('token=do-not-retain-the-cancellation-reason'));
    const result = await pending;

    expect(performance.now() - started).toBeLessThan(800);
    expect(result).toMatchObject({ aborted: true, timedOut: false, status: null, errorCode: 'ABORT_ERR' });
    expect(result.errorMessage).toBe('Command was cancelled.');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expectStopped(state);
  });

  it('does not start an already-aborted command', async () => {
    const root = await testRoot('pre-aborted');
    const sentinel = path.join(root, 'must-not-exist');
    const controller = new AbortController();
    controller.abort();
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "unexpected")', sentinel]
    }, { signal: controller.signal });

    expect(result).toMatchObject({ aborted: true, timedOut: false, stdout: '', stderr: '', status: null });
    await expect(access(sentinel)).rejects.toThrow();
  });

  it('removes cancellation listeners after successful completion without altering output', async () => {
    const controller = new AbortController();
    const result = await new NodeCommandRunner().run({
      executable: process.execPath, args: ['-e', 'process.stdout.write("complete")']
    }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 0, aborted: false, stdout: 'complete' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(result.aborted).toBe(false);
  });

  it('withholds partial sensitive stdout and stderr when a command times out', async () => {
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdin.on("data", chunk => { const partial = String(chunk).slice(0, 18); process.stdout.write(partial); process.stderr.write(partial); }); setTimeout(() => {}, 3500);']
    }, { stdin: token, timeoutMs: 200, stream: true, stdout, stderr, redactValues: [token] });

    expect(result).toMatchObject({ timedOut: true, stdout: '', stderr: '' });
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])('rejects invalid output limit %s before spawning', async (maxOutputBytes) => {
    await expect(new NodeCommandRunner().run({
      executable: process.execPath, args: ['-e', 'process.exit(99)']
    }, { maxOutputBytes })).rejects.toThrow('positive safe integer');
  });

  it('redacts only display formatting and preserves argument boundaries', () => {
    expect(formatCommand(
      { executable: 'tool', args: ['--token', 'secret value', '--name', 'safe'] },
      [1]
    )).toBe('tool --token <redacted> --name safe');
  });

  it.runIf(process.platform === 'win32')('launches Windows command shims without shell mode', async () => {
    const result = await new NodeCommandRunner().run({ executable: 'npm', args: ['--version'] });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
