import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  type ReviewedAdoptionDirectorySnapshot
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { captureProjectFileSnapshot, type ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { adoptionExecutionIdentity } from '../src/domain/project-evolution/adoption/identity.js';
import { adoptionApprovalStore } from '../src/application/project-evolution/adoption/records.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const parent = path.resolve('tests', `.adoption-directory-${randomUUID()}`);
  roots.push(parent);
  const root = path.join(parent, 'project'), home = path.join(parent, 'home');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const storage = { homedir: home, env: {}, repositoryRoot: root };
  return { root, home, storage, approvalStore: adoptionApprovalStore(root, storage) };
}

async function directorySnapshots(root: string, mutations: readonly ProjectFileMutation[]): Promise<ReviewedAdoptionDirectorySnapshot[]> {
  const paths = new Map<string, string[]>([['', []], ['.liftoff', ['.liftoff']]]);
  for (const mutation of mutations) for (let count = 1; count < mutation.pathParts.length; count++) {
    const parts = mutation.pathParts.slice(0, count);
    paths.set(parts.join('/'), parts);
  }
  return Promise.all([...paths.values()].map(async (pathParts): Promise<ReviewedAdoptionDirectorySnapshot> => {
    try {
      const info = await lstat(path.join(root, ...pathParts));
      return { pathParts, state: 'directory', device: info.dev, inode: info.ino, mode: info.mode & 0o7777 };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { pathParts, state: 'absent' };
      }
      throw error;
    }
  }));
}

describe('adoption directory identity and conservative recovery', () => {
  it('rejects missing directory bindings rather than borrowing another transaction contract', async () => {
    const source = await fixture();
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['new', 'file.txt'], content: 'candidate' }];
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion),
      planFingerprint: 'a'.repeat(64), approvalStore: source.approvalStore
    })).rejects.toThrow(/adoption requires its reviewed directory inventory/);
    expect(await readdir(source.root)).toEqual([]);
    const directories = await directorySnapshots(source.root, mutations);
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion),
      adoptionDirectories: directories, skillsDirectories: directories,
      planFingerprint: 'a'.repeat(64), approvalStore: source.approvalStore
    })).rejects.toThrow(/another recipe or adoption lane identity/);
    expect(await readdir(source.root)).toEqual([]);
  });

  it('rejects a stale parent inode before any journal or target write', async () => {
    const source = await fixture();
    await mkdir(path.join(source.root, 'data'));
    await writeFile(path.join(source.root, 'data', 'value.txt'), 'original');
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['data', 'value.txt'], content: 'candidate' }];
    const directories = await directorySnapshots(source.root, mutations);
    await rename(path.join(source.root, 'data'), path.join(source.root, 'original-data'));
    await cp(path.join(source.root, 'original-data'), path.join(source.root, 'data'), { recursive: true });
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion), adoptionDirectories: directories,
      planFingerprint: 'b'.repeat(64), approvalStore: source.approvalStore
    })).rejects.toThrow(/adoption directory changed/);
    expect(await readFile(path.join(source.root, 'data', 'value.txt'), 'utf8')).toBe('original');
    expect(await readdir(source.root)).not.toContain('.liftoff');
  });

  it('refuses an identical-byte parent replacement between staging and rename, preserving its copied temporary', async () => {
    const source = await fixture();
    const directory = path.join(source.root, 'data'), originalDirectory = path.join(source.root, 'original-data');
    await mkdir(directory);
    await writeFile(path.join(directory, 'value.txt'), 'original');
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['data', 'value.txt'], content: 'candidate' }];
    const directories = await directorySnapshots(source.root, mutations);
    const preconditions = [await captureProjectFileSnapshot(source.root, ['data', 'value.txt'])];
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion), adoptionDirectories: directories,
      planFingerprint: 'c'.repeat(64), approvalStore: source.approvalStore, preconditions,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase !== 'staged' || checkpoint.index !== 0) return;
        await rename(directory, originalDirectory);
        await cp(originalDirectory, directory, { recursive: true });
      }
    })).rejects.toThrow(/adoption directory changed/);
    const replacementFiles = await readdir(directory);
    expect(replacementFiles.some((file) => file !== 'value.txt')).toBe(true);
    expect(await readFile(path.join(directory, 'value.txt'), 'utf8')).toBe('original');
    const blocked = await recoverReviewedUpdateTransaction(source.root, {
      transactionKind: 'adoption', approvalStore: source.approvalStore
    });
    expect(blocked.status).toBe('blocked');
    expect(await readdir(directory)).toEqual(replacementFiles);
    expect(await readFile(path.join(directory, 'value.txt'), 'utf8')).toBe('original');

    const preservedReplacement = path.join(source.root, 'preserved-replacement');
    await rename(directory, preservedReplacement);
    await rename(originalDirectory, directory);
    const recovered = await recoverReviewedUpdateTransaction(source.root, {
      transactionKind: 'adoption', approvalStore: source.approvalStore
    });
    expect(recovered.status).toBe('rolled-back');
    expect(recovered.retainedDirectories).toContainEqual(['.liftoff']);
    expect(await readdir(directory)).toEqual(['value.txt']);
    expect(await readdir(preservedReplacement)).toEqual(replacementFiles);
  });

  it('never removes a replacement of an originally missing parent, even when that replacement is empty', async () => {
    const source = await fixture();
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['new', 'child', 'value.txt'], content: 'candidate' }];
    const directories = await directorySnapshots(source.root, mutations);
    const owned = path.join(source.root, 'owned-new'), replacement = path.join(source.root, 'new');
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion), adoptionDirectories: directories,
      planFingerprint: 'd'.repeat(64), approvalStore: source.approvalStore,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase !== 'after-mutation' || checkpoint.index !== 0) return;
        await rename(replacement, owned);
        await mkdir(path.join(replacement, 'child'), { recursive: true, mode: 0o700 });
        throw new Error('Injected interruption after parent replacement.');
      }
    })).rejects.toThrow(/directory changed/);
    const pending = await inspectReviewedUpdateTransaction(source.root, {
      transactionKind: 'adoption', approvalStore: source.approvalStore
    });
    expect(pending.status).toBe('interrupted');
    const recovered = await recoverReviewedUpdateTransaction(source.root, {
      transactionKind: 'adoption', approvalStore: source.approvalStore
    });
    expect(recovered.status).toBe('blocked');
    expect(await readdir(path.join(replacement, 'child'))).toEqual([]);
    expect(await readFile(path.join(owned, 'child', 'value.txt'), 'utf8')).toBe('candidate');
  });

  it('reports retained created directories after an attributable file rollback', async () => {
    const source = await fixture();
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['new', 'file.txt'], content: 'candidate' }];
    const directories = await directorySnapshots(source.root, mutations);
    await expect(applyReviewedUpdateTransaction(source.root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion), adoptionDirectories: directories,
      planFingerprint: 'e'.repeat(64), approvalStore: source.approvalStore,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'after-mutation') throw new Error('Injected file-transaction failure.');
      }
    })).rejects.toThrow(/Adoption directories were retained without deletion authority/);
    expect(await readdir(path.join(source.root, 'new'))).toEqual([]);
    expect(await readdir(path.join(source.root, '.liftoff'))).toEqual([]);
    await expect(readFile(path.join(source.root, 'new', 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
