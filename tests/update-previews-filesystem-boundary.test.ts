import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeUpdatePreviewReceipt,
  createInstallationRecordStore,
  createInstallationTransactionApprovalStore,
  createRepairWorkspaceRegistryStore,
  createScopedUserLocalRecordStore,
  createSkillsOwnershipAuthorityStore,
  createSkillsTransactionApprovalStore,
  createUpdateTransactionApprovalStore,
  getUpdatePreviewDirectory,
  issueUpdatePreviewReceipt,
  loadUpdatePreviewReceipt,
  nodeUpdatePreviewFileSystem,
  resolveUpdatePreviewLocation,
  type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import {
  createUpdatePreviewDescriptor,
  createUpdatePreviewReceipt,
  UpdatePreviewError
} from '../src/application/update/preview.js';
import type { UpdatePreviewInput } from '../src/application/update/preview.js';

function makeSampleInput(root: string): UpdatePreviewInput {
  return {
    projectRoot: root,
    cliVersion: '0.13.0',
    mode: 'normal',
    source: { manifest: { version: 8 } },
    target: { renderer: 'packaged-release' },
    operations: [
      { path: ['package.json'], expected: { kind: 'file', hash: 'abc', mode: 0o644 } }
    ]
  };
}

describe('update-previews real filesystem boundary and error matrix', () => {
  let scratchDir: string;
  let projectRoot: string;
  let homedir: string;
  let storage: UpdatePreviewOptions;

  beforeEach(async () => {
    const rawScratch = await mkdtemp(path.join(os.tmpdir(), 'liftoff-preview-test-'));
    scratchDir = await realpath(rawScratch);
    projectRoot = path.join(scratchDir, 'project');
    homedir = path.join(scratchDir, 'home');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    await mkdir(homedir, { recursive: true, mode: 0o700 });
    storage = { homedir, env: {} };
  });

  afterEach(async () => {
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  const getDescriptors = (root: string) => [createUpdatePreviewDescriptor(makeSampleInput(root))];

  describe('nodeUpdatePreviewFileSystem direct operations', () => {
    it('exercises openFile, writeText, readText, stat, chmod, sync, and close with size limits', async () => {
      const target = path.join(scratchDir, 'direct-file.txt');
      const handle = await nodeUpdatePreviewFileSystem.openFile(target, 'create-exclusive', 0o600);
      try {
        await handle.writeText('hello-preview');
        await handle.sync();
        await handle.chmod(0o600);
        const stats = await handle.stat();
        expect(stats.isFile()).toBe(true);
        expect(stats.size).toBe(13);
      } finally {
        await handle.close();
      }

      const readHandle = await nodeUpdatePreviewFileSystem.openFile(target, 'read', 0o600);
      try {
        expect(await readHandle.readText(100)).toBe('hello-preview');
        await expect(readHandle.readText(5)).rejects.toThrow(/Preview receipt exceeds its size limit/);
      } finally {
        await readHandle.close();
      }

      const renamed = path.join(scratchDir, 'renamed-file.txt');
      await nodeUpdatePreviewFileSystem.replaceFile(target, renamed);
      expect((await nodeUpdatePreviewFileSystem.lstat(renamed)).isFile()).toBe(true);
      await nodeUpdatePreviewFileSystem.removeFile(renamed);
      await expect(nodeUpdatePreviewFileSystem.lstat(renamed)).rejects.toThrow();
    });

    it('exercises syncDirectory on directories and rejects regular files', async () => {
      const subDir = path.join(scratchDir, 'subdir');
      await nodeUpdatePreviewFileSystem.makeDirectory(subDir, 0o700);
      await expect(nodeUpdatePreviewFileSystem.syncDirectory(subDir)).resolves.not.toThrow();

      const fileTarget = path.join(scratchDir, 'not-a-dir.txt');
      await writeFile(fileTarget, 'data', { mode: 0o600 });
      await expect(nodeUpdatePreviewFileSystem.syncDirectory(fileTarget)).rejects.toThrow();
    });
  });

  describe('real disk preview receipt lifecycle', () => {
    it('issues, loads, and consumes a receipt on real filesystem with private modes', async () => {
      const location = await resolveUpdatePreviewLocation(projectRoot, storage);
      expect(location.projectRoot).toBe(projectRoot);
      expect(location.receiptPath.endsWith('.json')).toBe(true);

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrowError(UpdatePreviewError);

      const issued = await issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage);
      expect(issued.receipt.variants).toHaveLength(1);
      expect(issued.location.projectRoot).toBe(projectRoot);

      const fileStat = await nodeUpdatePreviewFileSystem.lstat(issued.location.receiptPath);
      expect(fileStat.isFile()).toBe(true);
      expect(fileStat.nlink).toBe(1);
      if (process.platform !== 'win32') {
        expect(fileStat.mode & 0o077).toBe(0);
        const dirStat = await nodeUpdatePreviewFileSystem.lstat(issued.location.directory);
        expect(dirStat.mode & 0o077).toBe(0);
      }

      const loaded = await loadUpdatePreviewReceipt(projectRoot, storage);
      expect(loaded.receipt.receiptId).toBe(issued.receipt.receiptId);

      await consumeUpdatePreviewReceipt(projectRoot, issued.receipt, storage);

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrowError(UpdatePreviewError);
    });

    it('rejects consumeUpdatePreviewReceipt when receipt on disk does not match expected receipt', async () => {
      const issued = await issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage);
      const differentReceipt = createUpdatePreviewReceipt(getDescriptors(projectRoot), {
        receiptId: randomUUID(),
        issuedAt: new Date().toISOString()
      });

      await expect(consumeUpdatePreviewReceipt(projectRoot, differentReceipt, storage))
        .rejects.toThrow(/A newer or different preview receipt was found/);
    });

    it('rejects issueUpdatePreviewReceipt when preview clock is invalid', async () => {
      const invalidClock = () => new Date('invalid');
      await expect(issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), { ...storage, clock: invalidClock }))
        .rejects.toThrow(/The preview clock is invalid/);
    });

    it('rejects loading malformed JSON receipt on disk', async () => {
      const location = await resolveUpdatePreviewLocation(projectRoot, storage);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      await writeFile(location.receiptPath, '{ invalid json', { mode: 0o600 });

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrow(/Malformed preview receipt JSON/);
    });
  });

  describe('real disk update transaction approval store', () => {
    it('writes, verifies, and removes transaction approval seals', async () => {
      const store = createUpdateTransactionApprovalStore(projectRoot, storage);
      const planFingerprint = 'a'.repeat(64);
      const transactionDigest = 'b'.repeat(64);

      expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);

      await store.write(planFingerprint, transactionDigest);

      expect(await store.verify(planFingerprint, transactionDigest)).toBe(true);

      expect(await store.verify('c'.repeat(64), transactionDigest)).toBe(false);

      await expect(store.write(planFingerprint, transactionDigest)).resolves.not.toThrow();

      await store.remove(planFingerprint, transactionDigest);
      expect(await store.verify(planFingerprint, transactionDigest)).toBe(false);

      await expect(store.remove(planFingerprint, transactionDigest)).resolves.not.toThrow();
    });

    it('rejects write when transaction approval clock is invalid', async () => {
      const store = createUpdateTransactionApprovalStore(projectRoot, {
        ...storage,
        clock: () => new Date('invalid')
      });
      await expect(store.write('a'.repeat(64), 'b'.repeat(64)))
        .rejects.toThrow(/The transaction approval clock is invalid/);
    });

    it('creates installation transaction approval store and enforces boundaries', async () => {
      const store = createInstallationTransactionApprovalStore(projectRoot, storage);
      const plan = 'a'.repeat(64);
      const digest = 'b'.repeat(64);
      await store.write(plan, digest);
      expect(await store.verify(plan, digest)).toBe(true);
      await store.remove(plan, digest);

      const location = await resolveUpdatePreviewLocation(projectRoot, storage);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      const insideStore = createInstallationTransactionApprovalStore(location.directory, storage);
      await expect(insideStore.write(plan, digest))
        .rejects.toThrow(/Installation authority requires an exact canonical target outside its private approval store/);
    });

    it('creates skills transaction approval store and checks scope validation', () => {
      // @ts-expect-error Exercise runtime rejection outside the public scope union.
      expect(() => createSkillsTransactionApprovalStore(projectRoot, 'invalid-scope', storage))
        .toThrow(/Unknown skills approval scope/);

      const projectStore = createSkillsTransactionApprovalStore(projectRoot, 'project', storage);
      expect(projectStore).toBeDefined();

      const userStore = createSkillsTransactionApprovalStore(homedir, 'user', storage);
      expect(userStore).toBeDefined();
    });
  });

  describe('scoped user-local records and repair workspace registry', () => {
    it('manages scoped records and rejects malformed keys and overwrites with different content', async () => {
      const store = createScopedUserLocalRecordStore(projectRoot, 'repair-preview', storage);
      const key = 'a'.repeat(64);

      await expect(store.read('short-key')).rejects.toThrow(/complete lowercase SHA-256 digest/);
      await expect(store.write('short-key', { data: 1 })).rejects.toThrow(/complete lowercase SHA-256 digest/);

      expect(await store.read(key)).toBeNull();

      const written = await store.write(key, { config: 'repair-v1' });
      expect(written.projectRoot).toBe(projectRoot);
      const read = await store.read(key);
      expect(read?.value).toEqual({ config: 'repair-v1' });

      await expect(store.write(key, { config: 'repair-v1' })).resolves.not.toThrow();

      await expect(store.write(key, { config: 'different' }))
        .rejects.toThrow(/Refusing to replace different repair-preview metadata/);
    });

    it('manages skills ownership authority store and installation record store', async () => {
      // @ts-expect-error Exercise runtime rejection outside the public scope union.
      expect(() => createSkillsOwnershipAuthorityStore(projectRoot, 'bad-scope', storage))
        .toThrow(/Unknown skills ownership authority scope/);

      const projectStore = createSkillsOwnershipAuthorityStore(projectRoot, 'project', storage);
      const key = 'c'.repeat(64);
      await projectStore.write(key, { owner: 'user1' });
      expect((await projectStore.read(key))?.value).toEqual({ owner: 'user1' });

      const installStore = createInstallationRecordStore(projectRoot, storage);
      await installStore.write(key, { installed: true });
      expect((await installStore.read(key))?.value).toEqual({ installed: true });
    });

    it('manages mutable repair workspace registry with compare-and-exchange', async () => {
      const registry = createRepairWorkspaceRegistryStore(projectRoot, storage);
      const key = 'd'.repeat(64);

      expect(await registry.read(key)).toBeNull();

      await expect(registry.compareExchange(key, 'not-a-digest', { data: 1 }))
        .rejects.toThrow(/complete digest or absence/);

      const first = await registry.compareExchange(key, null, { step: 1 });
      expect(first.value).toEqual({ step: 1 });
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/);

      await expect(registry.compareExchange(key, 'e'.repeat(64), { step: 2 }))
        .rejects.toThrow(/compare-and-exchange refused/);

      const updated = await registry.compareExchange(key, first.digest, { step: 2 });
      expect(updated.value).toEqual({ step: 2 });
      expect(updated.digest).not.toBe(first.digest);

      const current = await registry.read(key);
      expect(current?.value).toEqual({ step: 2 });
      expect(current?.digest).toBe(updated.digest);
    });
  });

  describe('filesystem integrity, mode, link, and lock protections', () => {
    it('detects and rejects hard links on preview receipt files', async () => {
      const issued = await issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage);
      const hardlink = path.join(scratchDir, 'hardlink.json');
      await link(issued.location.receiptPath, hardlink);

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrow(/singly linked regular file, not a symlink, junction, or hard link/);

      await unlink(hardlink);
    });

    it.skipIf(process.platform === 'win32')('detects and rejects non-private file modes on POSIX', async () => {
      const issued = await issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage);
      await chmod(issued.location.receiptPath, 0o666);

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrow(/Preview files require private permissions \(0600\)/);
    });

    it.skipIf(process.platform === 'win32')('detects and rejects non-private directory modes on POSIX', async () => {
      const issued = await issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage);
      await chmod(issued.location.directory, 0o777);

      await expect(loadUpdatePreviewReceipt(projectRoot, storage))
        .rejects.toThrow(/Preview directories require private permissions \(0700\)/);
    });

    it('detects and rejects existing lock files indicating busy store', async () => {
      const location = await resolveUpdatePreviewLocation(projectRoot, storage);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      const lockPath = path.join(location.directory, `${location.projectKey}.lock`);
      await writeFile(lockPath, 'active-pid', { mode: 0o600 });

      await expect(issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage))
        .rejects.toThrowError(UpdatePreviewError);
      await expect(issueUpdatePreviewReceipt(projectRoot, getDescriptors(projectRoot), storage))
        .rejects.toThrow(/Another preview write or cleanup is in progress/);

      await unlink(lockPath);
    });

    it('rejects unsafe symlink in .git repository marker during discovery', async () => {
      const gitMarker = path.join(projectRoot, '.git');
      const fakeTarget = path.join(scratchDir, 'fake-git');
      await mkdir(fakeTarget, { mode: 0o700 });
      await symlink(fakeTarget, gitMarker, process.platform === 'win32' ? 'junction' : 'dir');

      await expect(resolveUpdatePreviewLocation(projectRoot, storage))
        .rejects.toThrow(/Repository marker has an unsafe path type/);
    });

    it('rejects missing or non-directory project paths', async () => {
      const missingDir = path.join(scratchDir, 'non-existent-project');
      await expect(resolveUpdatePreviewLocation(missingDir, storage))
        .rejects.toThrow(/Project or repository directory is missing/);

      const fileAsProject = path.join(scratchDir, 'file-project');
      await writeFile(fileAsProject, 'not a dir', { mode: 0o600 });
      await expect(resolveUpdatePreviewLocation(fileAsProject, storage))
        .rejects.toThrow(/Preview path must be a regular directory/);
    });

    it('rejects project contained inside preview store or preview store inside project', async () => {
      const location = await resolveUpdatePreviewLocation(projectRoot, storage);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      await expect(resolveUpdatePreviewLocation(location.directory, storage))
        .rejects.toThrow(/Preview storage must be outside both the project and its containing repository/);
      await expect(resolveUpdatePreviewLocation(projectRoot, { ...storage, homedir: projectRoot }))
        .rejects.toThrow(/Preview storage must be outside both the project and its containing repository/);
    });

    it('rejects repository root that does not contain the project', async () => {
      const otherRepo = path.join(scratchDir, 'other-repo');
      await mkdir(otherRepo, { recursive: true, mode: 0o700 });
      await expect(resolveUpdatePreviewLocation(projectRoot, { ...storage, repositoryRoot: otherRepo }))
        .rejects.toThrow(/The supplied repository does not contain the project/);
    });
  });

  describe('path and environment resolution matrix', () => {
    it('resolves XDG_STATE_HOME on linux and LOCALAPPDATA on win32', () => {
      const linuxDir = getUpdatePreviewDirectory({
        platform: 'linux',
        env: { XDG_STATE_HOME: '/custom/state' }
      });
      expect(linuxDir).toBe('/custom/state/liftoff/update-previews');

      const winDir = getUpdatePreviewDirectory({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local' }
      });
      expect(winDir).toBe('C:\\Users\\User\\AppData\\Local\\liftoff\\update-previews');
    });

    it('rejects unsupported platform or non-native platform without injected filesystem', async () => {
      expect(() => getUpdatePreviewDirectory({ platform: 'sunos', homedir: '/home/user', env: {} }))
        .toThrow(/Update preview storage does not support platform sunos/);

      const foreignPlatform = process.platform === 'win32' ? 'linux' : 'win32';
      await expect(resolveUpdatePreviewLocation(projectRoot, { ...storage, platform: foreignPlatform }))
        .rejects.toThrow(/A non-native preview platform requires an injected filesystem/);
    });

    it('rejects non-absolute, control-character, or invalid drive paths', () => {
      expect(() => getUpdatePreviewDirectory({ platform: 'linux', homedir: 'relative/home', env: {} }))
        .toThrow(/must be an absolute native path/);

      expect(() => getUpdatePreviewDirectory({ platform: 'linux', homedir: '/home/\u0000/bad', env: {} }))
        .toThrow(/must be an absolute native path/);

      expect(() => getUpdatePreviewDirectory({ platform: 'win32', homedir: '\\standalone-root', env: {} }))
        .toThrow(/must include an absolute Windows drive or UNC share/);

      expect(() => getUpdatePreviewDirectory({ platform: 'win32', homedir: 'C:\\bad<dir>', env: {} }))
        .toThrow(/contains an unsafe Windows path component/);

      expect(() => getUpdatePreviewDirectory({ platform: 'win32', homedir: 'C:\\nul\\path', env: {} }))
        .toThrow(/contains an unsafe Windows path component/);
    });
  });
});
