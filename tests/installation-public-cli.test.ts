import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { runCommand } from '../src/cli/commands/dispatch.js';
import type { CommandContext } from '../src/application/context.js';
import type { InstallationCommandContext } from '../src/cli/commands/installation.js';
import { ReceiptStore } from '../src/adapters/distribution/receipt-store.js';
import type { CommandRunner } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff installation public ')));
  roots.push(root);
  const home = path.join(root, 'isolated home');
  await mkdir(home);
  return { root, home };
}

async function invoke(source: Awaited<ReturnType<typeof fixture>>, argv: string[]) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const run = vi.fn<CommandRunner['run']>().mockRejectedValue(
    new Error('An unverified candidate must not execute.')
  );
  const hooks: CliTelemetryHooks = {
    beforeCommand: vi.fn<CliTelemetryHooks['beforeCommand']>().mockResolvedValue(true),
    afterCommand: vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined)
  };
  const before = await readdir(source.root, { recursive: true });
  const code = await runCli({
    argv, cwd: source.root, stdout, stderr,
    env: {
      PATH: '', HOME: source.home, USERPROFILE: source.home,
      XDG_CONFIG_HOME: path.join(source.home, 'config'), APPDATA: path.join(source.home, 'appdata')
    },
    telemetry: hooks,
    execute: async (parsed, context) => {
      const selected: CommandContext & Pick<InstallationCommandContext, 'receiptStore'> = {
        ...context, runner: { run },
        receiptStore: new ReceiptStore({ baseDirectory: path.join(source.home, 'receipts') })
      };
      return runCommand(parsed, selected);
    }
  });
  expect(hooks.beforeCommand).not.toHaveBeenCalled();
  expect(hooks.afterCommand).not.toHaveBeenCalled();
  expect(await readdir(source.root, { recursive: true })).toEqual(before);
  return { code, stdout: stdout.text(), stderr: stderr.text(), run };
}

describe('public non-executing installation admission', () => {
  it('returns one schema-1 failure for an absent invocation-relative candidate without effects', async () => {
    const source = await fixture();
    const result = await invoke(source, [
      'installation', 'migrate', '--to', 'direct', '--candidate', 'missing candidate', '--check', '--json'
    ]);
    expect(result.run.mock.calls.length).toBe(0);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1 });
  });

  it('rejects corrupt candidate metadata without falling through to executable version discovery', async () => {
    const source = await fixture();
    const candidate = path.join(source.root, 'unverified candidate');
    await mkdir(path.join(candidate, 'bin'), { recursive: true });
    await writeFile(path.join(candidate, 'build-info.json'), '{"version":');
    await writeFile(path.join(candidate, 'bin', process.platform === 'win32' ? 'liftoff.cmd' : 'liftoff'),
      'Untrusted bytes must never execute merely to discover a version.\n', { mode: 0o700 });
    const result = await invoke(source, [
      'installation', 'migrate', '--to', 'direct', '--candidate', candidate, '--check', '--json'
    ]);
    expect(result.run.mock.calls.length).toBe(0);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1 });
  });

  it('reports missing recovery records as schema-1 inspection without creating a checkpoint', async () => {
    const source = await fixture();
    const result = await invoke(source, ['installation', 'migrate', '--recover', '--json']);
    expect(result.run.mock.calls.length).toBe(0);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1 });
  });
});
