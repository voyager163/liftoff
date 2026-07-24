import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCommand, NodeCommandRunner } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

describe('external command runner', () => {
  it('passes hostile-looking arguments literally without shell interpolation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-runner-'));
    cleanups.push(root);
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
