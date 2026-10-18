import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '../src/process-runner.js';

type EntryKind = 'file' | 'directory' | 'symlink';
interface AbiCase {
  name: string;
  source?: Exclude<EntryKind, 'symlink'>;
  destination?: EntryKind;
  previous?: EntryKind;
  substitution?: EntryKind;
  sameBytes?: boolean;
  parent?: 'source' | 'destination';
  operation?: 'rename' | 'clone';
  control?: 'default-flags' | 'strict-no-follow' | 'invalid-flags' | 'bad-source-fd' |
    'missing-symbol' | 'replace-before-open' | 'replace-before-unlink';
  abort?: 'marker' | 'process' | 'deadline';
  postPublication?: Exclude<EntryKind, 'symlink'>;
  cleanup?: boolean;
}

const ruby = process.env.LIFTOFF_TEST_DARWIN_EXCLUSIVE_RUBY;
const fixture = fileURLToPath(new URL('./fixtures/darwin-exclusive-publication.rb', import.meta.url));
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const candidateBytes = 'inert candidate fixture bytes\n';
const foreignBytes = 'foreign fixture bytes\n';
const entryKinds: EntryKind[] = ['file', 'directory', 'symlink'];
const replacements: [EntryKind, EntryKind][] = [
  ['directory', 'file'], ['file', 'symlink'], ['symlink', 'directory']
];
const cases: AbiCase[] = [
  { name: 'rename publishes the original file inode', source: 'file' },
  { name: 'rename publishes the original directory inode', source: 'directory' },
  ...entryKinds.map<AbiCase>(type => ({ name: `rename refuses a competing ${type}`, destination: type })),
  ...replacements.map<AbiCase>(([old, type]) => ({
    name: `rename refuses ${old} replaced by ${type}`, destination: type, previous: old
  })),
  ...entryKinds.map<AbiCase>(type => ({
    name: `zero-flag clone collision with ${type}`, operation: 'clone', control: 'default-flags', destination: type
  })),
  ...replacements.map<AbiCase>(([old, type]) => ({
    name: `zero-flag clone collision with ${old} replaced by ${type}`, operation: 'clone',
    control: 'default-flags', destination: type, previous: old
  })),
  ...entryKinds.map<AbiCase>(type => ({
    name: `strict clone refuses a competing ${type}`, operation: 'clone', control: 'strict-no-follow', destination: type
  })),
  { name: 'rename moves a substituted foreign file despite the held source fd', substitution: 'file' },
  { name: 'rename moves a substituted foreign directory despite the held source fd',
    source: 'directory', substitution: 'directory' },
  { name: 'rename moves a substituted foreign symlink despite the held source fd', substitution: 'symlink' },
  { name: 'same-byte digest comparison misses a substituted source inode', substitution: 'file', sameBytes: true },
  { name: 'source parent fd stays bound to the old directory after canonical path replacement', parent: 'source' },
  { name: 'destination parent fd stays bound to the old directory after canonical path replacement', parent: 'destination' },
  { name: 'invalid flags refuse without a replacing fallback', control: 'invalid-flags' },
  { name: 'invalid source fd refuses without a replacing fallback', control: 'bad-source-fd' },
  { name: 'unavailable symbol refuses without invoking publication', control: 'missing-symbol' },
  { name: 'explicit pre-kernel abort closes descriptors without publication', abort: 'marker' },
  { name: 'process cancellation before the kernel call settles without publication', abort: 'process' },
  { name: 'pre-kernel deadline settles without publication', abort: 'deadline' },
  { name: 'strict clone selects the held file after source-name substitution', operation: 'clone', substitution: 'file' },
  { name: 'strict clone selects the held directory after source-name substitution',
    operation: 'clone', source: 'directory', substitution: 'directory' },
  { name: 'post-clone open captures a foreign same-byte file, not creation ownership',
    operation: 'clone', control: 'replace-before-open', postPublication: 'file' },
  { name: 'post-clone open captures a foreign same-byte directory, not creation ownership',
    operation: 'clone', source: 'directory', control: 'replace-before-open', postPublication: 'directory' },
  { name: 'checked unlink still removes a late foreign replacement',
    control: 'replace-before-unlink', postPublication: 'file', cleanup: true }
];

async function snapshot(entry: string) {
  const value = await lstat(entry, { bigint: true });
  return {
    dev: value.dev.toString(), ino: value.ino.toString(), mode: value.mode.toString(),
    uid: value.uid.toString(), gid: value.gid.toString(), size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString(),
    content: value.isFile() ? await readFile(entry, 'utf8')
      : value.isSymbolicLink() ? await readlink(entry) : await readFile(path.join(entry, 'payload'), 'utf8')
  };
}

async function absent(entry: string) {
  await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function makeEntry(entry: string, type: EntryKind, bytes = foreignBytes) {
  if (type === 'directory') {
    await mkdir(entry, { mode: 0o700 });
    await writeFile(path.join(entry, 'payload'), bytes, { flag: 'wx', mode: 0o600 });
  } else if (type === 'symlink') {
    await symlink('deliberately-missing-foreign-target', entry);
  } else await writeFile(entry, bytes, { flag: 'wx', mode: 0o600 });
}

async function waitReady(cell: string, name = 'ready') {
  const deadline = performance.now() + 2000;
  for (;;) {
    try {
      expect(await readFile(path.join(cell, name), 'utf8')).toBe(
        name === 'ready' ? 'validated-parents-and-source;destination-absent' : 'native-barrier');
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' ||
        performance.now() >= deadline) throw error;
      await setTimeout(5);
    }
  }
}

describe.skipIf(!ruby || process.platform !== 'darwin')(
  'raw Darwin ABI boundaries (requires LIFTOFF_TEST_DARWIN_EXCLUSIVE_RUBY; not provider qualification)', () => {
    let root: string | undefined;
    let rootIdentity: Stats | undefined;
    let executable: string;
    let runtimeBefore: string;
    let allSettled = true;
    let cellNumber = 0;
    const runner = new NodeCommandRunner();

    beforeAll(async () => {
      if (!ruby || !path.isAbsolute(ruby)) throw new Error('Name an existing absolute Ruby executable; no fallback is installed.');
      executable = await realpath(ruby);
      runtimeBefore = hash(await readFile(executable));
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-darwin-exclusive-abi-')));
      rootIdentity = await stat(root);
      expect(rootIdentity.uid).toBe(process.getuid?.());
      expect(rootIdentity.mode & 0o077).toBe(0);
    });

    afterAll(async () => {
      if (!root) return;
      if (!allSettled) throw new Error(`Unsettled child: retained exact private fixture ${root}`);
      if (!rootIdentity) throw new Error(`Missing initial identity: retained exact private fixture ${root}`);
      const observed = await stat(root);
      expect(await realpath(root)).toBe(root);
      expect(path.basename(root)).toMatch(/^liftoff-darwin-exclusive-abi-/);
      expect(observed.dev).toBe(rootIdentity.dev);
      expect(observed.ino).toBe(rootIdentity.ino);
      expect(observed.uid).toBe(process.getuid?.());
      await rm(root, { recursive: true, force: false });
      await absent(root);
      expect(hash(await readFile(executable))).toBe(runtimeBefore);
    });

    it.each(cases)('$name', async item => {
      if (!root) throw new Error('Private fixture was not initialized.');
      const cell = path.join(root, `${++cellNumber}`);
      await mkdir(cell, { mode: 0o700 });
      await mkdir(path.join(cell, 'source'), { mode: 0o700 });
      await mkdir(path.join(cell, 'destination'), { mode: 0o700 });
      await makeEntry(path.join(cell, 'source', 'entry'), item.source ?? 'file', candidateBytes);
      const original = await snapshot(path.join(cell, 'source', 'entry'));
      const controller = new AbortController();
      allSettled = false;
      const running = runner.run({
        executable, args: [fixture, cell, item.operation ?? 'rename', item.control ?? 'normal']
      }, {
        cwd: cell, inheritEnvironment: false,
        env: { PATH: '', HOME: cell, RUBYOPT: '', RUBYLIB: '', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0',
          LIFTOFF_DARWIN_ABI_FIXTURE: cell },
        timeoutMs: item.abort === 'deadline' ? 1500 : 5000,
        signal: controller.signal, maxOutputBytes: 32 * 1024, ensureProcessTreeSettled: true
      });
      let competing: Awaited<ReturnType<typeof snapshot>> | undefined;
      let actualCreated: Awaited<ReturnType<typeof snapshot>> | undefined;
      try {
        await waitReady(cell);
        if (item.destination) {
          const target = path.join(cell, 'destination', 'published');
          if (item.previous) {
            await makeEntry(target, item.previous);
            await rename(target, path.join(cell, 'destination', 'competitor-retained'));
          }
          await makeEntry(target, item.destination);
          competing = await snapshot(target);
        }
        if (item.substitution) {
          await rename(path.join(cell, 'source', 'entry'), path.join(cell, 'source', 'original-retained'));
          await makeEntry(path.join(cell, 'source', 'entry'), item.substitution,
            item.sameBytes ? candidateBytes : foreignBytes);
          competing = await snapshot(path.join(cell, 'source', 'entry'));
          expect(competing.ino).not.toBe(original.ino);
        }
        if (item.parent) {
          await rename(path.join(cell, item.parent), path.join(cell, `${item.parent}-retained`));
          await mkdir(path.join(cell, item.parent), { mode: 0o700 });
          await makeEntry(path.join(cell, item.parent, item.parent === 'source' ? 'entry' : 'published'), 'file');
          competing = await snapshot(path.join(cell, item.parent, item.parent === 'source' ? 'entry' : 'published'));
        }
        if (item.abort === 'process') controller.abort();
        else if (item.abort !== 'deadline') {
          if (item.abort === 'marker') await writeFile(path.join(cell, 'abort'), '', { flag: 'wx' });
          await writeFile(path.join(cell, 'continue'), '', { flag: 'wx' });
        }
        if (item.postPublication) {
          await waitReady(cell, item.cleanup ? 'before-unlink' : 'after-native');
          const target = path.join(cell, 'destination', 'published');
          actualCreated = await snapshot(target);
          await rename(target, path.join(cell, 'destination', 'original-publication-retained'));
          await makeEntry(target, item.postPublication, candidateBytes);
          competing = await snapshot(target);
          expect(competing.ino).not.toBe(actualCreated.ino);
          await writeFile(path.join(cell, item.cleanup ? 'continue-unlink' : 'continue-observe'), '', { flag: 'wx' });
        }
        const result = await running;
        allSettled = result.processTreeSettled === true;
        expect(result).toMatchObject({ processSpawned: true, processTreeSettled: true });
        if (item.abort === 'process' || item.abort === 'deadline') {
          expect(item.abort === 'process' ? result.aborted : result.timedOut).toBe(true);
          await absent(path.join(cell, 'destination', 'published'));
          expect(await snapshot(path.join(cell, 'source', 'entry'))).toEqual(original);
          return;
        }
        expect(result, result.stderr).toMatchObject({ status: 0, stderr: '', timedOut: false });
        expect(result.aborted).not.toBe(true);
        expect(result.outputLimitExceeded).not.toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.errorMessage).toBeUndefined();
        const observed = JSON.parse(result.stdout);
        expect(observed.library).toBe('/usr/lib/libSystem.B.dylib');
        expect(observed.descriptors.length).toBeGreaterThanOrEqual(3);
        for (const descriptor of observed.descriptors) {
          expect(descriptor).toMatchObject({ rubyClosed: true, fcntl: -1, errno: 9 });
        }
        if (item.destination) {
          if (item.operation === 'clone' && item.destination === 'symlink' && item.control === 'default-flags') {
            expect(observed.return).toBe(0);
            expect(await readFile(path.join(cell, 'destination', 'deliberately-missing-foreign-target'), 'utf8')).toBe(candidateBytes);
          } else {
            expect(observed.return).toBe(-1);
            expect(observed.errorClass).toBe(item.control === 'strict-no-follow' && item.destination === 'symlink'
              ? 'Errno::ELOOP' : 'Errno::EEXIST');
            await absent(path.join(cell, 'destination', 'deliberately-missing-foreign-target'));
          }
          expect(await snapshot(path.join(cell, 'destination', 'published'))).toEqual(competing);
          expect(await snapshot(path.join(cell, 'source', 'entry'))).toEqual(original);
        } else if (['invalid-flags', 'bad-source-fd', 'missing-symbol'].includes(item.control ?? '') || item.abort === 'marker') {
          if (item.control === 'invalid-flags') expect(observed.errorClass).toBe('Errno::EINVAL');
          if (item.control === 'bad-source-fd') expect(observed.errorClass).toBe('Errno::EBADF');
          if (item.control === 'missing-symbol') {
            expect(observed.unsupportedSymbol).toBe('Fiddle::DLError');
            expect(observed.nativeCalled).toBe(false);
          }
          if (item.abort === 'marker') {
            expect(observed.aborted).toBe(true);
            expect(observed.nativeCalled).toBe(false);
          }
          await absent(path.join(cell, 'destination', 'published'));
          expect(await snapshot(path.join(cell, 'source', 'entry'))).toEqual(original);
        } else if (item.postPublication) {
          if (!actualCreated || !competing) throw new Error('Post-publication barrier did not capture both identities.');
          expect(observed.return).toBe(0);
          expect((await snapshot(path.join(cell, 'destination', 'original-publication-retained'))).ino).toBe(actualCreated.ino);
          if (item.cleanup) {
            expect(observed.cleanupPrecheckExpectedSource).toBe(true);
            expect(observed.unlinkReturn).toBe(0);
            await absent(path.join(cell, 'destination', 'published'));
          } else {
            expect(observed.cloneFlags).toBe(8);
            expect(observed.destination.ino).toBe(competing.ino);
            expect(observed.destination.ino).not.toBe(actualCreated.ino);
            expect(competing.content).toBe(candidateBytes);
            expect(await snapshot(path.join(cell, 'destination', 'published'))).toEqual(competing);
          }
        } else if (item.operation === 'clone') {
          expect(observed.return).toBe(0);
          expect(observed.cloneFlags).toBe(8);
          expect(await snapshot(path.join(cell, 'source', 'entry'))).toEqual(competing);
          const destination = await snapshot(path.join(cell, 'destination', 'published'));
          expect(destination.content).toBe(candidateBytes);
          expect(destination.ino).not.toBe(original.ino);
          expect(observed.source.ino).toBe(original.ino);
          expect(observed.sourceAfter.ino).toBe(original.ino);
        } else {
          expect(observed.return).toBe(0);
          const destinationParent = item.parent === 'destination' ? 'destination-retained' : 'destination';
          const destination = await snapshot(path.join(cell, destinationParent, 'published'));
          if (item.substitution) {
            if (!competing) throw new Error('Source substitution was not captured.');
            expect(destination.ino).toBe(competing.ino);
            expect(destination.ino).not.toBe(original.ino);
            expect(destination.content).toBe(competing.content);
            expect(observed.sourceAfter.ino).toBe(original.ino);
            await absent(path.join(cell, 'source', 'entry'));
            expect((await snapshot(path.join(cell, 'source', 'original-retained'))).ino).toBe(original.ino);
          } else {
            expect(destination.ino).toBe(original.ino);
            expect(destination.content).toBe(candidateBytes);
            expect(observed.destination.ino).toBe(original.ino);
            if (item.parent) {
              expect(await snapshot(path.join(cell, item.parent,
                item.parent === 'source' ? 'entry' : 'published'))).toEqual(competing);
              for (const key of ['dev', 'ino', 'mode', 'uid', 'gid']) {
                expect(observed.sourceParentAfter[key]).toBe(observed.sourceParent[key]);
                expect(observed.destinationParentAfter[key]).toBe(observed.destinationParent[key]);
              }
            }
          }
        }
      } finally {
        controller.abort();
        const result = await running;
        allSettled = result.processTreeSettled === true;
      }
    }, 10_000);
  }
);
