import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMigrationRetainedProjectInputs } from '../src/governance-activation/historical-inputs.js';

const io = vi.hoisted(() => ({
  root: '', active: 0, maximum: 0, starts: [] as string[], completed: [] as string[],
  operations: [] as string[], gates: new Map<string, Promise<void>>(),
  redirects: new Map<string, string>(), errors: new Map<string, unknown>()
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const observe = (target: unknown) => {
    const name = String(target);
    if (io.root && name.startsWith(io.root + path.sep)) io.operations.push(name);
  };
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      observe(args[0]); return actual.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      observe(args[0]); return actual.realpath(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      observe(args[0]); return actual.readdir(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const target = String(args[0]);
      if (!io.root || !target.startsWith(io.root + path.sep)) return actual.readFile(...args);
      observe(target); io.starts.push(target);
      io.maximum = Math.max(io.maximum, ++io.active);
      try {
        await io.gates.get(target);
        const redirect = io.redirects.get(target);
        if (redirect) args[0] = redirect;
        return await actual.readFile(...args);
      } catch (error) {
        io.errors.set(target, error); throw error;
      } finally {
        io.active--; io.completed.push(target);
      }
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  io.root = ''; io.active = 0; io.maximum = 0;
  io.starts = []; io.completed = []; io.operations = [];
  io.gates.clear(); io.redirects.clear(); io.errors.clear();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migration-input-batches-')));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}
function start(root: string, files: string[]) {
  io.root = root;
  const gates = files.map(name => ({ file: path.join(root, name), ...deferred() }));
  for (const gate of gates) io.gates.set(gate.file, gate.promise);
  return gates;
}
const nine = Array.from({ length: 9 }, (_, index) => `a${index}.txt`);

describe('bounded migration retained-input capture', () => {
  it('settles fixed-four complete file batches before starting the next batch', async () => {
    const root = await fixture(Object.fromEntries(nine.map(name => [name, `${name}\n`]))), gates = start(root, nine);
    const pending = captureMigrationRetainedProjectInputs(root);
    try {
      await vi.waitFor(() => expect([...io.starts].sort()).toEqual(gates.slice(0, 4).map(gate => gate.file)), { timeout: 5000 });
      expect(io.maximum).toBe(4);
      for (const gate of gates.slice(0, 3)) gate.resolve();
      await vi.waitFor(() => expect(io.completed).toHaveLength(3), { timeout: 5000 });
      expect(io.starts).toHaveLength(4);
      gates[3]!.resolve();
      await vi.waitFor(() => expect([...io.starts].sort()).toEqual(gates.slice(0, 8).map(gate => gate.file)), { timeout: 5000 });
    } finally {
      for (const gate of gates) gate.resolve();
      await pending;
    }
    expect(io.active).toBe(0); expect(io.maximum).toBe(4);
    expect(io.completed).toHaveLength(9);
    const result = await captureMigrationRetainedProjectInputs(root);
    expect(result).toEqual(await Promise.all(nine.map(async name => ({
      pathParts: [name], digest: createHash('sha256').update(`${name}\n`).digest('hex'),
      mode: (await fs.lstat(path.join(root, name))).mode & 0o7777
    }))));
  });

  it('drains reversed actual read errors and returns the first original raw error without a later batch', async () => {
    const root = await fixture(Object.fromEntries(nine.map(name => [name, name]))), gates = start(root, nine);
    io.redirects.set(gates[0]!.file, path.join(root, 'missing-first'));
    io.redirects.set(gates[2]!.file, path.join(root, 'missing-later'));
    gates[2]!.resolve();
    let settled = false;
    const pending = captureMigrationRetainedProjectInputs(root).then(
      value => { settled = true; return { status: 'fulfilled' as const, value }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    let outcome: Awaited<typeof pending>;
    try {
      await vi.waitFor(() => expect(io.starts).toHaveLength(4), { timeout: 5000 });
      await vi.waitFor(() => expect(io.errors.has(gates[2]!.file)).toBe(true), { timeout: 5000 });
      expect(settled).toBe(false);
      gates[0]!.resolve();
      await vi.waitFor(() => expect(io.errors.has(gates[0]!.file)).toBe(true), { timeout: 5000 });
      expect(settled).toBe(false); expect(io.active).toBe(2);
    } finally {
      for (const gate of gates) gate.resolve();
      outcome = await pending;
    }
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('The actual read failure must reject capture.');
    expect(outcome.reason).toBe(io.errors.get(gates[0]!.file));
    expect(outcome.reason).not.toBe(io.errors.get(gates[2]!.file));
    expect(outcome.reason).toMatchObject({ code: 'ENOENT', path: path.join(root, 'missing-first') });
    expect(io.active).toBe(0); expect(io.completed).toHaveLength(4);
    expect(io.operations.some(name => name === gates[4]!.file)).toBe(false);
  });

  it('settles an earlier native read error before returning a later hardlink refusal', async () => {
    const root = await fixture(Object.fromEntries(nine.map(name => [name, name])));
    await fs.link(path.join(root, nine[2]!), path.join(root, '.env.production'));
    const gates = start(root, nine);
    io.redirects.set(gates[0]!.file, path.join(root, 'missing-earlier'));
    let settled = false;
    const pending = captureMigrationRetainedProjectInputs(root).then(
      value => { settled = true; return { status: 'fulfilled' as const, value }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    let outcome: Awaited<typeof pending>;
    try {
      await vi.waitFor(() => expect(io.starts).toHaveLength(3), { timeout: 5000 });
      expect(io.starts).not.toContain(gates[2]!.file); expect(settled).toBe(false);
      gates[0]!.resolve();
      await vi.waitFor(() => expect(io.errors.has(gates[0]!.file)).toBe(true), { timeout: 5000 });
      expect(settled).toBe(false); expect(io.active).toBe(2);
    } finally {
      for (const gate of gates) gate.resolve();
      outcome = await pending;
    }
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('The earlier native error must reject capture.');
    expect(outcome.reason).toBe(io.errors.get(gates[0]!.file));
    expect(io.active).toBe(0); expect(io.completed).toHaveLength(3);
    expect(io.operations.some(name => name === gates[4]!.file)).toBe(false);
  });

  it('drains preceding files before entering a directory and finishes that directory before later siblings', async () => {
    const names = ['a.txt', 'b.txt', 'c/inside0.txt', 'c/inside1.txt', 'd.txt'];
    const root = await fixture(Object.fromEntries(names.map(name => [name, name]))), gates = start(root, names);
    const pending = captureMigrationRetainedProjectInputs(root);
    try {
      await vi.waitFor(() => expect(io.starts).toHaveLength(2), { timeout: 5000 });
      expect(io.operations).not.toContain(path.join(root, 'c'));
      for (const gate of gates.slice(0, 2)) gate.resolve();
      await vi.waitFor(() => expect(io.starts).toHaveLength(4), { timeout: 5000 });
      expect(io.operations).not.toContain(path.join(root, 'd.txt'));
      expect(io.completed).toHaveLength(2);
    } finally {
      for (const gate of gates) gate.resolve();
      await pending;
    }
    expect(io.active).toBe(0); expect(io.maximum).toBe(2);
    expect(io.completed).toHaveLength(5);
  });

  it('excludes sensitive, reserved and dependency paths before any child observation while retaining public credential policy', async () => {
    const excluded = ['.env.production', 'terraform.tfstate', 'saved.tfplan', 'private.pem',
      '.git', 'node_modules', '.venv', '.azure', '.liftoff/sealed',
      'governance/credentials/private.txt'];
    const publicFiles = ['README.md', '.env.example', 'governance/credentials/preflight-policy.json'];
    const root = await fixture(Object.fromEntries([
      ...excluded.map(name => [`${name}/never-read.txt`, 'private fixture bytes']),
      ...publicFiles.map(name => [name, '{}'])
    ]));
    io.root = root;
    const result = await captureMigrationRetainedProjectInputs(root, [['.liftoff', 'sealed']]);
    expect(result.map(entry => entry.pathParts.join('/'))).toEqual([...publicFiles].sort((a, b) => a.localeCompare(b, 'en')));
    for (const name of excluded) {
      const target = path.join(root, name);
      expect(io.operations.some(value => value === target || value.startsWith(target + path.sep))).toBe(false);
    }
  });

  it('freshly captures changed bytes, modes and membership on every invocation', async () => {
    const root = await fixture({ 'a.txt': 'original', 'b.txt': 'remove me' });
    io.root = root;
    const before = await captureMigrationRetainedProjectInputs(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'changed');
    if (process.platform !== 'win32') await fs.chmod(path.join(root, 'a.txt'), 0o755);
    await fs.rm(path.join(root, 'b.txt'));
    await fs.writeFile(path.join(root, 'c.txt'), 'new');
    const after = await captureMigrationRetainedProjectInputs(root);
    expect(before.map(entry => entry.pathParts)).toEqual([['a.txt'], ['b.txt']]);
    expect(after).toEqual(await Promise.all(['a.txt', 'c.txt'].map(async name => ({
      pathParts: [name], digest: createHash('sha256').update(name === 'a.txt' ? 'changed' : 'new').digest('hex'),
      mode: (await fs.lstat(path.join(root, name))).mode & 0o7777
    }))));
    expect(io.starts.filter(name => name === path.join(root, 'a.txt'))).toHaveLength(2);
  });

  it.each([0, 1, 3])('retains exact sorted inventories for %i public files', async count => {
    const names = nine.slice(0, count);
    const root = await fixture(Object.fromEntries(names.map(name => [name, name])));
    io.root = root;
    expect(await captureMigrationRetainedProjectInputs(root)).toEqual(await Promise.all(names.map(async name => ({
      pathParts: [name], digest: createHash('sha256').update(name).digest('hex'),
      mode: (await fs.lstat(path.join(root, name))).mode & 0o7777
    }))));
    expect(io.active).toBe(0); expect(io.completed).toHaveLength(count);
  });

  it('rejects a genuine hardlink before reading its bytes', async () => {
    const root = await fixture({ 'a.txt': 'original' });
    await fs.link(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    io.root = root;
    await expect(captureMigrationRetainedProjectInputs(root)).rejects.toThrow(/must not be a link or special file/u);
    expect(io.starts).toEqual([]); expect(io.active).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects a genuine file symlink without reading the linked bytes', async () => {
    const root = await fixture({ '.env.production': 'private fixture bytes' });
    await fs.symlink(path.join(root, '.env.production'), path.join(root, 'public.txt'));
    io.root = root;
    await expect(captureMigrationRetainedProjectInputs(root)).rejects.toThrow(/must not be a link or special file/u);
    expect(io.starts).toEqual([]); expect(io.active).toBe(0);
  });
});
