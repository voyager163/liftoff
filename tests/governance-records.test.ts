import { execFileSync } from 'node:child_process';
import {
  closeSync, constants, existsSync, linkSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathExists, readProjectJsonDirectory, readPublicActivationInputs
} from '../src/adapters/filesystem/governance-records.js';

interface HandleUse { stats: number; readBytes: number; closes: number }

const fsHooks = vi.hoisted(() => ({
  handles: [] as HandleUse[],
  fail: {} as { stat?: Error; read?: Error; close?: Error },
  afterReaddir: undefined as (() => Promise<void>) | undefined,
  afterStat: undefined as (() => Promise<void>) | undefined,
  readChunk: undefined as number | undefined,
  unboundedReads: 0
}));

// Pass-through wrappers record every FileHandle the adapter opens, count the content bytes it
// reads and can inject one stat/read/close failure. The real handle is always closed.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
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
        if (fsHooks.fail.stat) throw fsHooks.fail.stat;
        const details = await statHandle(...options);
        const afterStat = fsHooks.afterStat;
        fsHooks.afterStat = undefined;
        await afterStat?.();
        return details;
      },
      // The bounded path: positional reads, optionally shortened to force partial reads.
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (fsHooks.fail.read) throw fsHooks.fail.read;
        const result = await readHandle(buffer, offset, Math.min(length, fsHooks.readChunk ?? length), position);
        use.readBytes += result.bytesRead;
        return result;
      },
      // readFile has no size bound; its use is counted so tests can require the bounded path.
      readFile: async (...options: Parameters<FileHandle['readFile']>) => {
        fsHooks.unboundedReads += 1;
        if (fsHooks.fail.read) throw fsHooks.fail.read;
        const content = await readFileHandle(...options);
        use.readBytes += Buffer.byteLength(content);
        return content;
      },
      close: async () => {
        use.closes += 1;
        await closeHandle();
        if (fsHooks.fail.close) throw fsHooks.fail.close;
      }
    });
  };
  const readdir = (async (...args: unknown[]) => {
    const entries = await (actual.readdir as (...parameters: unknown[]) => Promise<unknown>)(...args);
    await fsHooks.afterReaddir?.();
    return entries;
  }) as typeof actual.readdir;
  const wrapped = { ...actual, open, readdir };
  return { ...wrapped, default: wrapped };
});

// mkfifo runs synchronously and exits before the test continues.
function makeFifo(file: string): void {
  execFileSync('mkfifo', [file], { stdio: 'ignore', timeout: 10_000 });
}

// Observes an operation that must not wait for a FIFO writer. If it is still pending at the
// deadline, a non-blocking writer releases the open() waiting for one, so no reader thread is
// left behind, and the caller fails on `blocked`.
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
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      released = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO' || await within(20) !== 'pending') break;
    }
  }
  const final = await within(10_000);
  if (final === 'pending') throw new Error('The FIFO reader could not be released.');
  return { blocked: true, result: final };
}

// Link and special-file semantics are host capabilities; unsupported cases are skipped explicitly.
const host = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'liftoff-governance-records-probe-'));
  const target = path.join(probe, 'target.json');
  writeFileSync(target, '{}');
  const works = (action: () => void) => {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  };
  try {
    return {
      symlinks: works(() => symlinkSync(target, path.join(probe, 'link.json'))),
      hardLinks: works(() => linkSync(target, path.join(probe, 'hard.json'))),
      noFollowOpen: constants.O_NOFOLLOW !== undefined,
      posix: process.platform !== 'win32',
      nullDevice: process.platform !== 'win32' && existsSync('/dev/null'),
      fifos: process.platform !== 'win32' && works(() => {
        makeFifo(path.join(probe, 'probe-fifo'));
        if (!statSync(path.join(probe, 'probe-fifo')).isFIFO()) throw new Error('not a FIFO');
      })
    };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const refusal = 'Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.';
const notJson = 'Activation inputs are not valid JSON; credential or state content must not be supplied here.';
const inputLimitBytes = 64 * 1024;
const publicInputs = { schemaVersion: 1, phases: {}, repository: { name: 'octo/governance-records' } };
const approvalParts = ['governance', 'approvals'] as const;
const roots: string[] = [];

async function ownedRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-governance-records-')));
  roots.push(root);
  return root;
}

async function inputFile(root: string, name: string, content: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, content);
  return file;
}

async function rejection(action: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await action;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the governance record operation to reject.');
}

beforeEach(() => {
  fsHooks.handles.length = 0;
  fsHooks.fail = {};
  fsHooks.afterReaddir = undefined;
  fsHooks.afterStat = undefined;
  fsHooks.readChunk = undefined;
  fsHooks.unboundedReads = 0;
});

afterEach(async () => {
  fsHooks.fail = {};
  fsHooks.afterReaddir = undefined;
  fsHooks.afterStat = undefined;
  fsHooks.readChunk = undefined;
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('public activation inputs', () => {
  it('returns the validated public configuration in canonical order and closes its only handle', async () => {
    const root = await ownedRoot();
    const content = `${JSON.stringify({
      budget: { usageMonthlyCents: 500, fixedMonthlyCents: 0, currency: 'USD' },
      azure: { region: 'eastus', tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      repository: { create: true, visibility: 'private', defaultBranch: 'main', name: 'octo/governance-records' },
      phases: { 'runner-ready': { group: 'restricted' } },
      schemaVersion: 1
    }, null, 2)}\n`;
    const file = await inputFile(root, 'inputs.json', content);

    expect(JSON.stringify(await readPublicActivationInputs(file))).toBe(JSON.stringify({
      schemaVersion: 1,
      phases: { 'runner-ready': { group: 'restricted' } },
      repository: { name: 'octo/governance-records', defaultBranch: 'main', visibility: 'private', create: true },
      azure: { subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tenantId: '11111111-2222-3333-4444-555555555555', region: 'eastus' },
      budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 500 }
    }));
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: Buffer.byteLength(content), closes: 1 }]);
  });

  it('accepts exactly 64 KiB and refuses one more byte without reading the content', async () => {
    const root = await ownedRoot();
    const body = JSON.stringify(publicInputs);
    const atLimit = await inputFile(root, 'at-limit.json', body.padEnd(inputLimitBytes, ' '));
    const overLimit = await inputFile(root, 'over-limit.json', body.padEnd(inputLimitBytes + 1, ' '));
    expect((await stat(atLimit)).size).toBe(inputLimitBytes);

    await expect(readPublicActivationInputs(atLimit)).resolves.toEqual(publicInputs);
    expect((await rejection(readPublicActivationInputs(overLimit))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([
      { stats: 1, readBytes: inputLimitBytes, closes: 1 },
      ...(host.noFollowOpen ? [{ stats: 1, readBytes: 0, closes: 1 }] : [])
    ]);
  });

  it('refuses malformed JSON with fixed text that never echoes the payload', async () => {
    const root = await ownedRoot();
    const sentinel = 'SENTINEL-governance-records-7f3a';
    const content = `{"repository": {"name": "${sentinel}"}, ${sentinel}}`;
    const file = await inputFile(root, 'malformed.json', content);

    const error = await rejection(readPublicActivationInputs(file));
    expect(error.message).toBe(notJson);
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(sentinel);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: Buffer.byteLength(content), closes: 1 }]);
  });

  it('closes the handle before surfacing well-formed but unsupported or credential-bearing inputs', async () => {
    const root = await ownedRoot();
    const token = ['ghp', 'S'.repeat(36)].join('_');
    const unsupportedContent = JSON.stringify({ schemaVersion: 2, phases: {} });
    const credentialContent = JSON.stringify({ schemaVersion: 1, phases: { 'runner-ready': { note: token } } });
    const unsupported = await inputFile(root, 'unsupported.json', unsupportedContent);
    const credential = await inputFile(root, 'credential.json', credentialContent);

    expect((await rejection(readPublicActivationInputs(unsupported))).message).toBe('activationInputs.schemaVersion must be 1.');
    const refused = await rejection(readPublicActivationInputs(credential));
    expect(refused.message).toBe(
      'activationInputs.phases.runner-ready contains credential material in a nested value; use protected credential enrollment instead.'
    );
    expect(refused.message).not.toContain(token);
    expect(refused.message).not.toContain('.note');
    expect(fsHooks.handles).toEqual([
      { stats: 1, readBytes: Buffer.byteLength(unsupportedContent), closes: 1 },
      { stats: 1, readBytes: Buffer.byteLength(credentialContent), closes: 1 }
    ]);
  });

  it.skipIf(!host.posix)('refuses a directory as a non-regular input without reading it (POSIX open semantics)', async () => {
    const root = await ownedRoot();
    const directory = path.join(root, 'directory.json');
    await mkdir(directory);

    expect((await rejection(readPublicActivationInputs(directory))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it.skipIf(!host.nullDevice)('refuses a character device as a non-regular input without reading it (requires /dev/null)', async () => {
    expect((await rejection(readPublicActivationInputs('/dev/null'))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it.skipIf(!host.hardLinks)('refuses both names of a hard-linked input without reading it (requires hard links)', async () => {
    const root = await ownedRoot();
    const original = await inputFile(root, 'original.json', JSON.stringify(publicInputs));
    const alias = path.join(root, 'alias.json');
    await link(original, alias);

    for (const file of [original, alias]) expect((await rejection(readPublicActivationInputs(file))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual(host.noFollowOpen
      ? [{ stats: 1, readBytes: 0, closes: 1 }, { stats: 1, readBytes: 0, closes: 1 }]
      : []);
  });

  it.skipIf(!host.symlinks || !host.noFollowOpen)('refuses a symlinked input at open without following it (requires symlinks and O_NOFOLLOW)', async () => {
    const root = await ownedRoot();
    const target = await inputFile(root, 'target.json', JSON.stringify(publicInputs));
    const alias = path.join(root, 'alias.json');
    await symlink(target, alias);

    expect((await rejection(readPublicActivationInputs(alias))).code).toBe('ELOOP');
    expect(fsHooks.handles).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(publicInputs));
  });

  it.skipIf(!host.fifos)('refuses a FIFO input without waiting for a writer or reading from it (requires mkfifo)', async () => {
    const root = await ownedRoot();
    const fifo = path.join(root, 'inputs.json');
    makeFifo(fifo);

    const { blocked, result } = await settleOrReleaseFifo(readPublicActivationInputs(fifo), fifo, 2_000);
    expect(blocked, 'opening the inputs waited for a FIFO writer').toBe(false);
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toMatchObject({ message: refusal });
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }]);
  });

  it('propagates a missing input file without opening a handle', async () => {
    const root = await ownedRoot();
    expect((await rejection(readPublicActivationInputs(path.join(root, 'missing.json')))).code).toBe('ENOENT');
    expect(fsHooks.handles).toEqual([]);
  });

  it('closes the handle and propagates metadata or content read failures unchanged', async () => {
    const root = await ownedRoot();
    const file = await inputFile(root, 'inputs.json', JSON.stringify(publicInputs));
    const statFailure = Object.assign(new Error('simulated stat failure'), { code: 'EIO' });
    const readFailure = Object.assign(new Error('simulated read failure'), { code: 'EIO' });

    fsHooks.fail = { stat: statFailure };
    expect(await rejection(readPublicActivationInputs(file))).toBe(statFailure);
    fsHooks.fail = { read: readFailure };
    expect(await rejection(readPublicActivationInputs(file))).toBe(readFailure);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: 0, closes: 1 }, { stats: 1, readBytes: 0, closes: 1 }]);
  });

  it('fails closed with fixed cleanup diagnostics that keep the primary refusal and never repeat the close error text', async () => {
    const root = await ownedRoot();
    const sentinel = 'SENTINEL-governance-records-close-52be';
    const validContent = JSON.stringify(publicInputs);
    const malformedContent = `{"note": ${sentinel}}`;
    const valid = await inputFile(root, 'inputs.json', validContent);
    const malformed = await inputFile(root, 'malformed.json', malformedContent);
    fsHooks.fail = { close: Object.assign(new Error(`raw close text ${sentinel}`), { code: 'EIO' }) };

    // A validated configuration is never returned when its handle cannot be closed.
    const afterValid = await rejection(readPublicActivationInputs(valid));
    expect(afterValid.message).toBe('Closing the activation inputs file failed (EIO); the inputs were not used.');
    expect(afterValid.cause).toBeUndefined();
    const afterRefusal = await rejection(readPublicActivationInputs(malformed));
    expect(afterRefusal.message).toBe(`${notJson} Closing the activation inputs file also failed (EIO).`);
    expect(afterRefusal.cause).toMatchObject({ message: notJson });
    for (const error of [afterValid, afterRefusal]) expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(sentinel);
    expect(fsHooks.handles).toEqual([
      { stats: 1, readBytes: Buffer.byteLength(validContent), closes: 1 },
      { stats: 1, readBytes: Buffer.byteLength(malformedContent), closes: 1 }
    ]);
  });

  it('omits an untrusted close error code and keeps the fixed cleanup sentence', async () => {
    const root = await ownedRoot();
    const valid = await inputFile(root, 'inputs.json', JSON.stringify(publicInputs));
    const malformed = await inputFile(root, 'malformed.json', '{"note": ');
    for (const code of [undefined, 'EIO; injected', 'eio', 42]) {
      fsHooks.fail = { close: Object.assign(new Error('raw close text'), code === undefined ? {} : { code }) };
      expect((await rejection(readPublicActivationInputs(valid))).message)
        .toBe('Closing the activation inputs file failed; the inputs were not used.');
      expect((await rejection(readPublicActivationInputs(malformed))).message)
        .toBe(`${notJson} Closing the activation inputs file also failed.`);
    }
  });

  it('reads at most 64 KiB plus one byte and refuses a file that grows past the limit after its size check', async () => {
    const root = await ownedRoot();
    const file = await inputFile(root, 'growing.json', JSON.stringify(publicInputs));
    fsHooks.afterStat = () => appendFile(file, ' '.repeat(70 * 1024));

    expect((await rejection(readPublicActivationInputs(file))).message).toBe(refusal);
    expect(fsHooks.handles).toEqual([{ stats: 1, readBytes: inputLimitBytes + 1, closes: 1 }]);
    expect(fsHooks.unboundedReads).toBe(0);
  });

  it('assembles partial reads and keeps the exact read bound', async () => {
    const root = await ownedRoot();
    const body = JSON.stringify(publicInputs);
    const small = await inputFile(root, 'small.json', body);
    fsHooks.readChunk = 1;
    await expect(readPublicActivationInputs(small)).resolves.toEqual(publicInputs);
    fsHooks.readChunk = 4096;
    const atLimit = await inputFile(root, 'at-limit.json', body.padEnd(inputLimitBytes, ' '));
    await expect(readPublicActivationInputs(atLimit)).resolves.toEqual(publicInputs);
    const growing = await inputFile(root, 'growing.json', body.padEnd(inputLimitBytes, ' '));
    fsHooks.afterStat = () => appendFile(growing, ' ');

    expect((await rejection(readPublicActivationInputs(growing))).message).toBe(refusal);
    expect(fsHooks.handles.map((use) => use.readBytes)).toEqual([Buffer.byteLength(body), inputLimitBytes, inputLimitBytes + 1]);
    expect(fsHooks.unboundedReads).toBe(0);
  });
});

describe('project JSON record directories', () => {
  it('returns nothing for an absent directory and reads only .json entries in stable order', async () => {
    const project = await ownedRoot();
    expect(await readProjectJsonDirectory(project, approvalParts, 'Approval')).toEqual([]);

    const directory = path.join(project, ...approvalParts);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'b.json'), '{"id":"b"}');
    await writeFile(path.join(directory, 'A.json'), '{"id":"A"}');
    await writeFile(path.join(directory, 'notes.md'), 'ignored');
    await writeFile(path.join(directory, '.gitkeep'), '');

    expect(await readProjectJsonDirectory(project, approvalParts, 'Approval')).toEqual([
      { name: 'A.json', value: { id: 'A' } },
      { name: 'b.json', value: { id: 'b' } }
    ]);
  });

  it('rejects unsafe directory path parts before reading anything', async () => {
    const project = await ownedRoot();
    expect((await rejection(readProjectJsonDirectory(project, ['governance', '..'], 'Approval'))).message)
      .toBe('Approval directory path contains unsafe path part "..".');
  });

  it('reports a record directory path that is not a directory', async () => {
    const project = await ownedRoot();
    await mkdir(path.join(project, 'governance'));
    await writeFile(path.join(project, ...approvalParts), 'not a directory');

    const error = await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'));
    expect(error.message.startsWith('Unable to read governance/approvals: ')).toBe(true);
    expect(error.message).toContain('ENOTDIR');
  });

  it('refuses a .json entry that is a directory', async () => {
    const project = await ownedRoot();
    await mkdir(path.join(project, ...approvalParts, 'nested.json'), { recursive: true });

    expect((await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'))).message)
      .toBe('governance/approvals/nested.json must be a regular JSON file.');
  });

  it.skipIf(!host.symlinks)('refuses a symlinked .json entry even when its target is inside the project (requires symlinks)', async () => {
    const project = await ownedRoot();
    const directory = path.join(project, ...approvalParts);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(project, 'record.json'), '{"id":"target"}');
    await symlink(path.join(project, 'record.json'), path.join(directory, 'linked.json'));

    expect((await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'))).message)
      .toBe('governance/approvals/linked.json must be a regular JSON file.');
  });

  it.skipIf(!host.symlinks)('refuses a record directory that escapes the project through a symlink (requires symlinks)', async () => {
    const project = await ownedRoot();
    const outside = await ownedRoot();
    await writeFile(path.join(outside, 'foreign.json'), '{"id":"foreign"}');
    await mkdir(path.join(project, 'governance'));
    await symlink(outside, path.join(project, ...approvalParts), 'dir');

    expect((await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'))).message)
      .toBe('Artifact path escapes project root through a symlink: governance/approvals');
  });

  it.skipIf(!host.posix)('refuses unsafe or non-portable .json entry names (POSIX file names)', async () => {
    for (const [name, message] of [
      ['CON.json', 'Approval file path contains non-portable path part "CON.json".'],
      ['a\\b.json', 'Approval file path contains unsafe path part "a\\\\b.json".']
    ] as const) {
      const project = await ownedRoot();
      await mkdir(path.join(project, ...approvalParts), { recursive: true });
      await writeFile(path.join(project, ...approvalParts, name), '{}');
      expect((await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'))).message).toBe(message);
    }
  });

  it('reports a .json entry that disappears between listing and reading', async () => {
    const project = await ownedRoot();
    const gone = path.join(project, ...approvalParts, 'gone.json');
    await mkdir(path.dirname(gone), { recursive: true });
    await writeFile(gone, '{}');
    fsHooks.afterReaddir = async () => {
      fsHooks.afterReaddir = undefined;
      await unlink(gone);
    };

    expect((await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'))).message)
      .toBe('governance/approvals/gone.json disappeared during governance inspection.');
  });

  it('identifies an unparsable record by its project path without repeating its content', async () => {
    const project = await ownedRoot();
    await mkdir(path.join(project, ...approvalParts), { recursive: true });
    await writeFile(path.join(project, ...approvalParts, 'bad.json'), '{"id": SENTINEL-approval-record-3c1e}');

    const error = await rejection(readProjectJsonDirectory(project, approvalParts, 'Approval'));
    expect(error.message).toBe('Unable to parse governance/approvals/bad.json: the file is not valid JSON; its content was withheld.');
    expect(error.cause).toBeUndefined();
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain('SENTINEL');
  });
});

describe('path existence', () => {
  it('reports existing files and directories and treats missing paths as absent', async () => {
    const root = await ownedRoot();
    const file = await inputFile(root, 'present.json', '{}');
    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(root)).toBe(true);
    expect(await pathExists(path.join(root, 'missing.json'))).toBe(false);
  });

  it.skipIf(!host.symlinks)('treats a dangling symlink as absent (requires symlinks)', async () => {
    const root = await ownedRoot();
    await symlink(path.join(root, 'missing-target.json'), path.join(root, 'dangling.json'));
    expect(await pathExists(path.join(root, 'dangling.json'))).toBe(false);
    await writeFile(path.join(root, 'missing-target.json'), '{}');
    expect(await pathExists(path.join(root, 'dangling.json'))).toBe(true);
  });

  it.skipIf(!host.posix)('rethrows access failures other than a missing path (POSIX ENOTDIR)', async () => {
    const root = await ownedRoot();
    const file = await inputFile(root, 'present.json', '{}');
    expect((await rejection(pathExists(path.join(file, 'child')))).code).toBe('ENOTDIR');
  });
});
