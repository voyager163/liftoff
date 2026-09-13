import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SpawnPrivateStateCommandRunner } from '../src/adapters/state/native-command.js';
import { cleanupOwnedStateScratch, stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

const root = path.join(process.cwd(), '.cache', `state-process-tests-${process.pid}`);
const syntheticSecret = 'SYNTHETIC_PRIVATE_PROCESS_OUTPUT';
afterAll(async () => {
  await stopOwnedStateProcessesIn(root);
  await rm(root, { recursive: true, force: true });
});

async function fixture(mode: 'hang' | 'exit' | 'escaped' | 'output', timeoutMs = 800) {
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  await writeFile(path.join(directory, 'plan'), `
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
writeFileSync('root.pid', String(process.pid));
process.stdout.write(process.env.ARM_CLIENT_SECRET + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'output') {
  process.on('SIGTERM', () => {});
  setInterval(() => process.stdout.write('SYNTHETIC_PRIVATE_PROCESS_OUTPUT'.repeat(1024)), 5);
} else {
  const worker = spawn(process.execPath, [mode === 'escaped' ? 'escaped' : 'worker'], {
    cwd: process.cwd(), env: process.env, detached: mode === 'escaped', stdio: mode === 'exit' ? 'ignore' : 'inherit'
  });
  writeFileSync('child.pid', String(worker.pid));
  process.on('SIGTERM', () => {});
  if (mode === 'exit' || mode === 'escaped') {
    const poll = setInterval(() => {
      if (existsSync(mode === 'escaped' ? 'escaped.ready' : 'grandchild.ready')) {
        clearInterval(poll); process.exit(0);
      }
    }, 5);
  } else setInterval(() => {}, 1000);
}
`, { mode: 0o600 });
  await writeFile(path.join(directory, 'worker'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['grandchild'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
writeFileSync('grandchild.pid', String(grandchild.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o600 });
  await writeFile(path.join(directory, 'grandchild'), `
import { writeFileSync } from 'node:fs';
writeFileSync('grandchild.ready', 'ready');
process.on('SIGTERM', () => {});
setInterval(() => process.stdout.write('SYNTHETIC_PRIVATE_PROCESS_OUTPUT\\n'), 20);
`, { mode: 0o600 });
  await writeFile(path.join(directory, 'escaped'), `
import { writeFileSync } from 'node:fs';
writeFileSync('escaped.ready', 'ready');
process.on('SIGTERM', () => {});
setInterval(() => process.stdout.write('SYNTHETIC_PRIVATE_PROCESS_OUTPUT\\n'), 20);
`, { mode: 0o600 });
  const legacyTerminator = vi.fn(async () => { throw new Error('The abstract fallback must not be used'); });
  const runner = new SpawnPrivateStateCommandRunner({
    executable: process.execPath, executableDigest: stateDigest(await readFile(process.execPath)),
    timeoutMs, cleanupTimeoutMs: 300, maxCaptureBytes: mode === 'output' ? 256 : 64 * 1024,
    host: {
      async verify(cwd) {
        // This is a process-only fixture, not an encrypted-volume attestation.
        return { directory: cwd, encryptedVolume: true, isolated: true, providerIdentityReadOnly: true, providerRegistrationDisabled: true };
      },
      async privateEnvironment() { return { ARM_CLIENT_SECRET: syntheticSecret }; },
      terminateProcessTree: legacyTerminator
    }
  });
  return { directory, runner, legacyTerminator };
}

async function waitFor(filename: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await readFile(filename).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Disposable process fixture did not become ready');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function pids(directory: string): Promise<number[]> {
  const values = await Promise.all(['root.pid', 'child.pid', 'grandchild.pid'].map(async (name) =>
    readFile(path.join(directory, name), 'utf8').then(Number, () => null)));
  return values.filter((value): value is number => value !== null);
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('owned private native process lifetime', () => {
  it('kills SIGTERM-resistant child and grandchild on timeout before returning and keeps output private', async () => {
    const { directory, runner, legacyTerminator } = await fixture('hang');
    const error = await runner.run({ cwd: directory, args: ['plan'], operation: 'inspect' }).then(() => null, (value) => value);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(String(error)).not.toContain(syntheticSecret);
    const descendants = await pids(directory);
    expect(descendants).toHaveLength(3);
    expect(descendants.every((pid) => !alive(pid))).toBe(true);
    expect(legacyTerminator).not.toHaveBeenCalled();
    await runner.quiesce();
  });

  it('waits for the full inherited process group on caller cancellation', async () => {
    const { directory, runner } = await fixture('hang', 10_000);
    const abort = new AbortController();
    const result = runner.run({ cwd: directory, args: ['plan'], operation: 'inspect', signal: abort.signal })
      .then(() => null, (error) => error);
    await waitFor(path.join(directory, 'grandchild.ready'));
    abort.abort();
    expect(await result).toMatchObject({ code: 'cancelled' });
    expect((await pids(directory)).every((pid) => !alive(pid))).toBe(true);
  });

  it('does not treat zero root exit or closed root pipes as proof that ignored-stdio grandchildren ended', async () => {
    const { directory, runner } = await fixture('exit', 5_000);
    const error = await runner.run({ cwd: directory, args: ['plan'], operation: 'inspect' }).then(() => null, (value) => value);
    expect(error).toMatchObject({ code: 'native-command-failed' });
    expect((await pids(directory)).every((pid) => !alive(pid))).toBe(true);
  });

  it('terminates the owned group on private output overflow without retaining payload', async () => {
    const { directory, runner } = await fixture('output', 5_000);
    const error = await runner.run({ cwd: directory, args: ['plan'], operation: 'inspect' }).then(() => null, (value) => value);
    expect(error).toMatchObject({ code: 'storage-limit' });
    expect(JSON.stringify(error)).not.toContain(syntheticSecret);
    expect((await pids(directory)).every((pid) => !alive(pid))).toBe(true);
  });

  it('retains scratch and reports unproven cleanup for an unsupported session-escaping descendant', async () => {
    const { directory, runner } = await fixture('escaped', 5_000);
    let escapedPid: number | null = null;
    try {
      const error = await runner.run({ cwd: directory, args: ['plan'], operation: 'inspect' }).then(() => null, (value) => value);
      expect(error).toMatchObject({ code: 'process-tree-termination-unproven' });
      expect(String(error)).not.toContain(syntheticSecret);
      escapedPid = Number(await readFile(path.join(directory, 'child.pid'), 'utf8'));
      expect(alive(escapedPid)).toBe(true);
      const cleanup = vi.fn(() => rm(directory, { recursive: true }));
      await expect(cleanupOwnedStateScratch(directory, cleanup)).rejects.toMatchObject({ code: 'process-tree-termination-unproven' });
      expect(cleanup).not.toHaveBeenCalled();
      expect(await readFile(path.join(directory, 'root.pid'), 'utf8')).toMatch(/^\d+$/);
      // Only the explicitly captured disposable fixture's separate group is
      // removed. The production supervisor never guesses this escaped PID.
      process.kill(-escapedPid, 'SIGKILL');
      await runner.quiesce();
      await cleanupOwnedStateScratch(directory, cleanup);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      if (escapedPid !== null && alive(escapedPid)) process.kill(-escapedPid, 'SIGKILL');
      await runner.quiesce();
    }
  }, 15_000);
});
