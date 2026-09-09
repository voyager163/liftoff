import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProjectFileTransaction, ProjectFileTransactionError, writeProjectFile } from '../src/file-system.js';
import { createFileAtomically } from '../src/adapters/filesystem/atomic-write.js';
import { projectMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import {
  applyMergePreflight,
  authorizeMergePreflight,
  buildMergePreflight,
  withStagingArea,
  writeStagedArtifacts
} from '../src/init-filesystem.js';

const faults = vi.hoisted(() => ({
  partialWrite: false,
  partialLockWrite: false,
  rename: false,
  temporaryCleanup: false,
  competingOpen: false,
  competingPath: ''
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.competingOpen) {
        faults.competingPath = String(args[0]);
        await actual.writeFile(args[0], 'belongs to another writer', { flag: 'wx' });
        throw Object.assign(new Error('temporary path already exists'), { code: 'EEXIST' });
      }
      const handle = await actual.open(...args);
      if (faults.partialWrite) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
          await write('partial bytes');
          throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
        });
      }
      if (faults.partialLockWrite && String(args[0]).endsWith('.lock')) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (content) => {
          if (typeof content !== 'string') throw new Error('Expected a textual lock record.');
          await write(content.slice(0, 12));
          throw Object.assign(new Error('injected lock disk full'), { code: 'ENOSPC' });
        });
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.temporaryCleanup && String(args[0]).endsWith('.tmp')) {
        faults.temporaryCleanup = false;
        throw Object.assign(new Error('injected temporary cleanup failure'), { code: 'EACCES' });
      }
      return actual.unlink(...args);
    }
  };
});

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-atomic-'));
  roots.push(root);
  const target = path.join(root, 'existing.txt');
  await writeFile(target, 'original', { mode: 0o600 });
  return { root, target };
}

afterEach(async () => {
  faults.partialWrite = false;
  faults.partialLockWrite = false;
  faults.rename = false;
  faults.temporaryCleanup = false;
  faults.competingOpen = false;
  faults.competingPath = '';
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('atomic project-file recovery', () => {
  it.runIf(process.platform !== 'win32')('preserves restricted modes on successful replacement', async () => {
    const { root, target } = await fixture();
    await writeProjectFile(root, ['existing.txt'], 'replacement');
    expect(await readFile(target, 'utf8')).toBe('replacement');
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('cleans a created temporary file when writing fails partway through', async () => {
    const { root, target } = await fixture();
    faults.partialWrite = true;
    await expect(writeProjectFile(root, ['existing.txt'], 'replacement')).rejects.toThrow('disk full');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('cleans a completed temporary file when replacement fails', async () => {
    const { root, target } = await fixture();
    faults.rename = true;
    await expect(writeProjectFile(root, ['existing.txt'], 'replacement')).rejects.toThrow('rename failure');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('does not delete an unowned temporary path when exclusive creation fails', async () => {
    const { root, target } = await fixture();
    faults.competingOpen = true;
    await expect(writeProjectFile(root, ['existing.txt'], 'replacement')).rejects.toThrow('already exists');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readFile(faults.competingPath, 'utf8')).toBe('belongs to another writer');
  });

  it('preserves an unowned initialization temporary file when exclusive creation fails', async () => {
    const { root } = await fixture();
    faults.competingOpen = true;
    await expect(createFileAtomically(path.join(root, 'new.txt'), 'new', 0o600))
      .rejects.toThrow('already exists');
    expect(await readFile(faults.competingPath, 'utf8')).toBe('belongs to another writer');
    await expect(readFile(path.join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never replaces an existing destination through the create-only adapter', async () => {
    const { root, target } = await fixture();
    const created = vi.fn();
    await expect(createFileAtomically(target, 'replacement', 0o600, created)).rejects.toThrow();
    expect(created).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('rolls back a newly linked initialization file when temporary cleanup fails', async () => {
    const { root, target } = await fixture();
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [{
        logicalName: 'new-file', pathParts: ['new.txt'], content: 'new',
        category: 'documentation', lifecycle: 'project', provisioningGroup: 'base'
      }], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, root), false);
      faults.temporaryCleanup = true;
      await expect(applyMergePreflight(preflight!)).rejects.toMatchObject({
        rollback: { removed: ['new.txt'], failures: [] }
      });
    });
    expect(await readdir(root)).toEqual(['existing.txt']);
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('cleans a partially written owned lock without starting the mutation', async () => {
    const { root } = await fixture();
    const lockPath = await projectMutationLockPath(root);
    const operation = vi.fn();
    faults.partialLockWrite = true;
    await expect(withProjectMutationLock(root, operation)).rejects.toThrow('lock disk full');
    expect(operation).not.toHaveBeenCalled();
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('preserves a concurrent content edit instead of overwriting it during rollback', async () => {
    const { root, target } = await fixture();
    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['existing.txt'], content: 'liftoff update' },
      { type: 'write', pathParts: ['second.txt'], content: 'second update' }
    ], {
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          await writeFile(target, 'developer edit');
          throw new Error('later operation failed');
        }
      }
    })).rejects.toBeInstanceOf(ProjectFileTransactionError);
    expect(await readFile(target, 'utf8')).toBe('developer edit');
  });

  it.runIf(process.platform !== 'win32')('preserves a concurrent permission edit during rollback', async () => {
    const { root, target } = await fixture();
    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['existing.txt'], content: 'liftoff update' },
      { type: 'write', pathParts: ['second.txt'], content: 'second update' }
    ], {
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          await chmod(target, 0o400);
          throw new Error('later operation failed');
        }
      }
    })).rejects.toThrow('changed before rollback');
    expect(await readFile(target, 'utf8')).toBe('liftoff update');
    expect((await lstat(target)).mode & 0o777).toBe(0o400);
  });
});
