import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPublicActivationInputs } from '../src/adapters/filesystem/governance-records.js';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/cli/commands/dispatch.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

interface HandleUse { stats: number; readBytes: number; closes: number }

const simulated = vi.hoisted(() => ({ nonblockingOpenUnavailable: false }));
const fsHooks = vi.hoisted(() => ({
  handles: [] as HandleUse[],
  afterLstat: undefined as (() => Promise<void>) | undefined,
  lstatOverride: undefined as ((details: unknown) => unknown) | undefined,
  statOverride: undefined as ((details: unknown) => unknown) | undefined
}));

// Simulates a host whose Node exposes no atomic no-follow open, as on Windows, on this host's
// real file system. A test can also withdraw non-blocking opens.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const constants = Object.create(actual.constants, {
    O_NOFOLLOW: { value: undefined, enumerable: true },
    O_NONBLOCK: { get: () => (simulated.nonblockingOpenUnavailable ? undefined : actual.constants.O_NONBLOCK), enumerable: true }
  }) as typeof actual.constants;
  const wrapped = { ...actual, constants };
  return { ...wrapped, default: wrapped };
});

// The pre-open lstat can run a one-shot race step or report a synthetic identity; opened handles
// record stat/read/close use and can report a synthetic identity too.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const lstat = (async (...args: unknown[]) => {
    const details = await (actual.lstat as (...parameters: unknown[]) => Promise<unknown>)(...args);
    const afterLstat = fsHooks.afterLstat;
    fsHooks.afterLstat = undefined;
    await afterLstat?.();
    return fsHooks.lstatOverride ? fsHooks.lstatOverride(details) : details;
  }) as typeof actual.lstat;
  const open = async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
    const handle = await actual.open(...args);
    const use: HandleUse = { stats: 0, readBytes: 0, closes: 0 };
    fsHooks.handles.push(use);
    const statHandle = handle.stat.bind(handle);
    const readHandle = handle.read.bind(handle);
    const readFileHandle = handle.readFile.bind(handle);
    const closeHandle = handle.close;
    return Object.assign(handle, {
      stat: async (...options: Parameters<FileHandle['stat']>) => {
        use.stats += 1;
        const details = await statHandle(...options);
        return fsHooks.statOverride ? fsHooks.statOverride(details) : details;
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const result = await readHandle(buffer, offset, length, position);
        use.readBytes += result.bytesRead;
        return result;
      },
      readFile: async (...options: Parameters<FileHandle['readFile']>) => {
        const content = await readFileHandle(...options);
        use.readBytes += Buffer.byteLength(content);
        return content;
      },
      close: async () => {
        use.closes += 1;
        await closeHandle();
      }
    });
  };
  const wrapped = { ...actual, lstat, open };
  return { ...wrapped, default: wrapped };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function makeFifo(file: string): void {
  execFileSync('mkfifo', [file], { stdio: 'ignore', timeout: 10_000 });
}

const host = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'liftoff-governance-fallback-probe-'));
  const works = (action: () => void) => {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  };
  try {
    writeFileSync(path.join(probe, 'target.json'), '{}');
    return {
      symlinks: works(() => symlinkSync(path.join(probe, 'target.json'), path.join(probe, 'link.json'))),
      fifos: process.platform !== 'win32' && works(() => {
        makeFifo(path.join(probe, 'probe-fifo'));
        if (!statSync(path.join(probe, 'probe-fifo')).isFIFO()) throw new Error('not a FIFO');
      })
    };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// Observes an operation that must not wait for a FIFO writer; if it is still pending at the
// deadline, a non-blocking writer releases the blocked open so no reader thread is left behind.
async function settleOrReleaseFifo<T>(operation: Promise<T>, fifo: string, deadlineMs: number): Promise<{
  blocked: boolean; result: PromiseSettledResult<T>;
}> {
  const settled = operation.then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason })
  );
  const within = async (milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), milliseconds);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await within(deadlineMs);
  if (first !== 'pending') return { blocked: false, result: first };
  let released = false;
  for (let attempt = 0; !released && attempt < 250; attempt += 1) {
    try {
      actualFs.closeSync(actualFs.openSync(fifo, actualFs.constants.O_WRONLY | actualFs.constants.O_NONBLOCK));
      released = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO' || await within(20) !== 'pending') break;
    }
  }
  const final = await within(10_000);
  if (final === 'pending') throw new Error('The FIFO reader could not be released.');
  return { blocked: true, result: final };
}

function withIdentity(details: unknown, ino: bigint): unknown {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(details) as object) as object, details) as { ino: number | bigint };
  copy.ino = typeof (details as { ino: unknown }).ino === 'bigint' ? ino : Number(ino);
  return copy;
}

const refusal = 'Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.';
const identityUnavailable = 'Activation inputs file identity is unavailable on this file system; the opened file cannot be matched to the inspected path.';
const publicInputs = { schemaVersion: 1, phases: {}, repository: { name: 'octo/governance-fallback' } };
const otherInputs = { schemaVersion: 1, phases: {}, repository: { name: 'octo/other-file' } };
const roots: string[] = [];

async function ownedRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-governance-fallback-')));
  roots.push(root);
  return root;
}

async function rejection(action: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await action;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the activation inputs to be refused.');
}

async function inputFile(root: string, name: string, value: unknown): Promise<{ file: string; bytes: number }> {
  const content = JSON.stringify(value);
  const file = path.join(root, name);
  await writeFile(file, content);
  return { file, bytes: Buffer.byteLength(content) };
}

beforeEach(() => {
  fsHooks.handles.length = 0;
  fsHooks.afterLstat = undefined;
  fsHooks.lstatOverride = undefined;
  fsHooks.statOverride = undefined;
  simulated.nonblockingOpenUnavailable = false;
});

afterEach(async () => {
  fsHooks.afterLstat = undefined;
  fsHooks.lstatOverride = undefined;
  fsHooks.statOverride = undefined;
  simulated.nonblockingOpenUnavailable = false;
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('activation inputs where no atomic no-follow open exists (simulated capability)', () => {
  it('reads a regular file whose opened identity matches the pre-open observation', async () => {
    const root = await ownedRoot();
    const { file, bytes } = await inputFile(root, 'inputs.json', publicInputs);

    await expect(readPublicActivationInputs(file)).resolves.toEqual(publicInputs);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: bytes, closes: 1 }]);
  });

  it.skipIf(!host.symlinks)('refuses a non-racing symlink before opening anything (requires symlinks)', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'target.json', publicInputs);
    const alias = path.join(root, 'alias.json');
    await symlink(file, alias);

    expect((await rejection(readPublicActivationInputs(alias))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([]);
  });

  it.skipIf(!host.symlinks)('refuses a swap to a symlink to another file after the pre-open check with zero reads (requires symlinks)', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'inputs.json', publicInputs);
    const { file: other } = await inputFile(root, 'other.json', otherInputs);
    fsHooks.afterLstat = async () => {
      await unlink(file);
      await symlink(other, file);
    };

    expect((await rejection(readPublicActivationInputs(file))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it('refuses a different regular file renamed over the path after the pre-open check with zero reads', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'inputs.json', publicInputs);
    const { file: other } = await inputFile(root, 'other.json', otherInputs);
    fsHooks.afterLstat = () => rename(other, file);

    expect((await rejection(readPublicActivationInputs(file))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it.skipIf(!host.symlinks)('accepts a swap to a symlink that resolves to the same file object, a documented limit (requires symlinks)', async () => {
    const root = await ownedRoot();
    const { file, bytes } = await inputFile(root, 'inputs.json', publicInputs);
    const moved = path.join(root, 'moved.json');
    fsHooks.afterLstat = async () => {
      await rename(file, moved);
      await symlink(moved, file);
    };

    await expect(readPublicActivationInputs(file)).resolves.toEqual(publicInputs);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: bytes, closes: 1 }]);
  });

  it('fails closed with zero reads when the opened file reports no identity', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'inputs.json', publicInputs);
    fsHooks.statOverride = (details) => withIdentity(details, 0n);

    expect((await rejection(readPublicActivationInputs(file))).message).toBe(identityUnavailable);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it('compares identities exactly rather than as rounded numbers', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'inputs.json', publicInputs);
    // Both identities round to the same double; only an exact comparison tells them apart.
    fsHooks.lstatOverride = (details) => withIdentity(details, 2n ** 60n + 1n);
    fsHooks.statOverride = (details) => withIdentity(details, 2n ** 60n + 2n);
    expect(Number(2n ** 60n + 1n)).toBe(Number(2n ** 60n + 2n));

    expect((await rejection(readPublicActivationInputs(file))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it.skipIf(!host.fifos)('refuses a swap to a FIFO after the pre-open check without waiting for a writer (requires mkfifo)', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'inputs.json', publicInputs);
    fsHooks.afterLstat = async () => {
      await unlink(file);
      makeFifo(file);
    };

    const { blocked, result } = await settleOrReleaseFifo(readPublicActivationInputs(file), file, 2_000);
    expect(blocked, 'opening the swapped inputs waited for a FIFO writer').toBe(false);
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toMatchObject({ message: refusal });
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it.skipIf(!host.fifos)('refuses a FIFO before opening when non-blocking opens are unavailable too (requires mkfifo)', async () => {
    const root = await ownedRoot();
    const fifo = path.join(root, 'inputs.json');
    makeFifo(fifo);
    simulated.nonblockingOpenUnavailable = true;

    const { blocked, result } = await settleOrReleaseFifo(readPublicActivationInputs(fifo), fifo, 2_000);
    expect(blocked, 'the FIFO was opened and waited for a writer').toBe(false);
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toMatchObject({ message: refusal });
    expect(fsHooks.handles).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('refuses a directory junction before opening it (native Windows only)', async () => {
    const root = await ownedRoot();
    const target = path.join(root, 'target');
    await mkdir(target);
    const junction = path.join(root, 'inputs.json');
    await symlink(target, junction, 'junction');

    expect((await rejection(readPublicActivationInputs(junction))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([]);
  });
});

describe('governance --inputs routing with the simulated capability', () => {
  let project = '';

  async function projectTree(root: string): Promise<Record<string, string>> {
    const tree: Record<string, string> = {};
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        const key = path.relative(root, file).split(path.sep).join('/');
        if (entry.isDirectory()) {
          tree[`${key}/`] = 'directory';
          await walk(file);
        } else if (entry.isSymbolicLink()) {
          tree[key] = `symlink:${await readlink(file)}`;
        } else {
          tree[key] = createHash('sha256').update(await readFile(file)).digest('hex');
        }
      }
    };
    await walk(root);
    return tree;
  }

  beforeAll(async () => {
    project = await createFixtureProject({
      projectName: 'Governance Inputs Fallback', projectType: 'standard', apiStack: 'node', cloud: 'azure', region: 'eastus',
      environments: ['dev'], specWorkflow: 'openspec', agents: ['github-copilot']
    });
  }, 60_000);

  afterAll(async () => {
    if (project) await rm(path.dirname(project), { recursive: true, force: true });
  });

  it.skipIf(!host.symlinks)('refuses a symlinked inputs file through governance status without project writes (requires symlinks)', async () => {
    const root = await ownedRoot();
    const { file } = await inputFile(root, 'target.json', publicInputs);
    const alias = path.join(root, 'alias.json');
    await symlink(file, alias);
    const before = await projectTree(project);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const afterCommand = vi.fn(async () => undefined);

    const code = await runCli({
      argv: ['governance', 'status', '--inputs', alias, '--json'],
      cwd: project,
      stdin: Readable.from([]),
      stdout,
      stderr,
      env: { ...process.env, LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
      telemetry: { beforeCommand: async () => false, afterCommand },
      execute: (parsed, context) => runCommand(parsed, {
        ...context, runner: new ReadyInitRunner(), terminal: { snapshot: true, columns: 100 }
      })
    });

    expect(code).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain(refusal);
    expect(afterCommand).not.toHaveBeenCalled();
    expect(await projectTree(project)).toEqual(before);
  });
});
