import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import { CaptureStream } from './helpers.js';

describe('Canonical output contracts against actual CLI handlers', () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    root = path.resolve(`tests/.skill-output-${process.pid}-${randomUUID()}`);
    home = path.join(root, 'home');
    cwd = path.join(root, 'cwd');
    await mkdir(home, { recursive: true });
    await mkdir(cwd);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function invoke(argv: string[]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCli({
      argv, cwd, stdout, stderr,
      env: { LIFTOFF_TELEMETRY: '0', PATH: '', HOME: home, USERPROFILE: home },
      execute: (parsed, context) => runCommand(parsed, {
        ...context,
        runner: { run: async () => { throw new Error('Output-contract inspection cannot execute tools or mutate installations.'); } }
      })
    });
    return { code, out: stdout.text(), err: stderr.text() };
  }

  it.each(['init', 'migrate'] as const)('does not invent machine JSON for human-only %s', async (command) => {
    expect(getCanonicalSkill(command)).toMatchObject({ commandOutput: 'human', commandResultSchema: null });
    const help = await invoke([command, '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain(command);
    expect(() => JSON.parse(help.out)).toThrow();
    const invalid = await invoke([command, '--json']);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('--json');
    expect(await readdir(cwd)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it('observes upgrade schema1 without claiming installation or owner qualification', async () => {
    const result = await invoke(['upgrade', '--check', '--json']);
    const report = JSON.parse(result.out);
    expect(getCanonicalSkill('cli-upgrade')).toMatchObject({ commandOutput: 'json', commandResultSchema: 1 });
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'check' });
    expect(['blocked', 'failed']).toContain(report.status);
    expect(result.code).toBe(1);
    expect(report.status).not.toBe('upgraded');
    expect(await readdir(cwd)).toEqual([]);
  });
});
