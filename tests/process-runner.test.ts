import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCommand, NodeCommandRunner } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';

const cleanups: string[] = [];
const scratchRoot = path.join(process.cwd(), '.cache', 'process-runner-tests');
let counter = 0;

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
