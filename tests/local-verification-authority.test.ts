import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import {
  createLocalVerificationTransactionAuthority, localVerificationTransactionAuthorityKey,
  validateLocalVerificationTransactionAuthority, createUpdateTransactionApprovalSeal,
  updateTransactionApprovalKey
} from '../src/application/update/transaction-approval.js';
import {
  createLocalVerificationTransactionAuthorityStore, createUpdateTransactionApprovalStore,
  nodeUpdatePreviewFileSystem, resolveUpdatePreviewLocation, type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import { repairApprovalStore } from '../src/application/repair/preview.js';

const roots: string[] = [];
const now = new Date('2026-09-30T04:00:00.000Z');
const issuance = { approvalId: '12345678-1234-4234-8234-123456789abc', approvedAt: now.toISOString() };
const binding = { projectRoot: '/project', planFingerprint: 'a'.repeat(64), transactionDigest: 'b'.repeat(64) };

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lv-authority-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces'), home = path.join(parent, 'home'), state = path.join(parent, 'state');
  await mkdir(root); await mkdir(home); await mkdir(state);
  const options: UpdatePreviewOptions = { env: { XDG_STATE_HOME: state, LOCALAPPDATA: state }, homedir: home, clock: () => now };
  const localBinding = { ...binding, projectRoot: root };
  const location = await resolveUpdatePreviewLocation(root, options);
  const file = path.join(location.directory, `local-verification-authority-${localVerificationTransactionAuthorityKey(localBinding)}.json`);
  return { parent, root, options, localBinding, location, file };
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });

describe('closed dedicated local publication authority', () => {
  it('has distinct keys and wire meaning without changing update seals', () => {
    const seal = createLocalVerificationTransactionAuthority(binding, issuance);
    expect(validateLocalVerificationTransactionAuthority(seal, binding, now)).toEqual(seal);
    expect(seal.kind).toBe('liftoff-local-verification-transaction-authority');
    expect(Object.isFrozen(seal)).toBe(true);
    expect(localVerificationTransactionAuthorityKey(binding)).not.toBe(updateTransactionApprovalKey(binding));
    expect(createUpdateTransactionApprovalSeal(binding, issuance).kind).toBe('liftoff-update-transaction-approval');
  });

  it.each([
    { kind: 'liftoff-update-transaction-approval' }, { kind: 'liftoff-repair-transaction-authority' },
    { kind: 'liftoff-modern-local-consent' }, { schemaVersion: 2 }, { planFingerprint: 'c'.repeat(64) },
    { transactionDigest: 'c'.repeat(64) }, { projectRoot: '/other' }, { projectKey: 'c'.repeat(64) },
    { approvedAt: '2026-10-01T00:00:00.000Z' }, { approvedAt: 'not-a-time' }, { approvalId: 'bad' },
    { committed: true }
  ])('rejects a foreign, malformed or mismatched record: %j', patch => {
    const seal = { ...createLocalVerificationTransactionAuthority(binding, issuance), ...patch };
    expect(() => validateLocalVerificationTransactionAuthority(seal, binding, now)).toThrow();
  });

  it('rejects getters without invocation, extra nonenumerable fields and invalid observation time', () => {
    const seal = { ...createLocalVerificationTransactionAuthority(binding, issuance) };
    const getter = vi.fn(() => binding.projectRoot);
    Object.defineProperty(seal, 'projectRoot', { enumerable: true, get: getter });
    expect(() => validateLocalVerificationTransactionAuthority(seal, binding, now)).toThrow(/own-data/);
    expect(getter).not.toHaveBeenCalled();
    const extra = { ...createLocalVerificationTransactionAuthority(binding, issuance) };
    Object.defineProperty(extra, 'hidden', { value: 1 });
    expect(() => validateLocalVerificationTransactionAuthority(extra, binding, now)).toThrow();
    expect(() => validateLocalVerificationTransactionAuthority(
      createLocalVerificationTransactionAuthority(binding, issuance), binding, new Date(NaN))).toThrow(/clock/);
    expect(() => createLocalVerificationTransactionAuthority({ ...binding, planFingerprint: 'a' }, issuance)).toThrow(/SHA-256/);
  });
});

describe('real guarded local authority storage', () => {
  it('publishes immutable own-data local-kind and canonical-root attribution', async () => {
    const f = await fixture(), store = createLocalVerificationTransactionAuthorityStore(f.root, f.options);
    expect(store.transactionKind).toBe('local-verification');
    expect(store.projectRoot).toBe(f.root);
    expect(Object.getOwnPropertyDescriptor(store, 'transactionKind')).toMatchObject({ value: 'local-verification', writable: false });
    expect(Object.getOwnPropertyDescriptor(store, 'projectRoot')).toMatchObject({ value: f.root, writable: false });
    expect(Reflect.set(store, 'transactionKind', 'update')).toBe(false);
    expect(Reflect.set(store, 'projectRoot', f.parent)).toBe(false);
    expect(Reflect.deleteProperty(store, 'projectRoot')).toBe(false);
    await store.write(binding.planFingerprint, binding.transactionDigest);
    expect(await store.verify(binding.planFingerprint, binding.transactionDigest)).toBe(true);
  });

  it('keeps update, repair and local authority independent for the same digests', async () => {
    const f = await fixture();
    const local = createLocalVerificationTransactionAuthorityStore(f.root, f.options);
    const update = createUpdateTransactionApprovalStore(f.root, f.options);
    const repair = repairApprovalStore(f.root, f.options);
    expect(await local.verify(binding.planFingerprint, binding.transactionDigest)).toBe(false);
    await update.write(binding.planFingerprint, binding.transactionDigest);
    await repair.write(binding.planFingerprint, binding.transactionDigest);
    expect(await local.verify(binding.planFingerprint, binding.transactionDigest)).toBe(false);
    await local.write(binding.planFingerprint, binding.transactionDigest);
    const bytes = await readFile(f.file);
    expect(JSON.parse(bytes.toString()).kind).toBe('liftoff-local-verification-transaction-authority');
    await local.write(binding.planFingerprint, binding.transactionDigest);
    expect(await readFile(f.file)).toEqual(bytes);
    const fresh = createLocalVerificationTransactionAuthorityStore(f.root, f.options);
    expect(await fresh.verify(binding.planFingerprint, binding.transactionDigest)).toBe(true);
    await fresh.remove(binding.planFingerprint, binding.transactionDigest);
    expect(await fresh.verify(binding.planFingerprint, binding.transactionDigest)).toBe(false);
    expect(await update.verify(binding.planFingerprint, binding.transactionDigest)).toBe(true);
    expect(await repair.verify(binding.planFingerprint, binding.transactionDigest)).toBe(true);
    expect(await readdir(f.root)).toEqual([]);
  });

  it.each(['malformed', 'update', 'different', 'oversized'] as const)('preserves and rejects %s authority at the exact local path', async fault => {
    const f = await fixture(), store = createLocalVerificationTransactionAuthorityStore(f.root, f.options);
    await store.write(binding.planFingerprint, binding.transactionDigest);
    const content = fault === 'malformed' ? '{' : fault === 'oversized' ? 'x'.repeat(64 * 1024 + 1) :
      canonicalJson(fault === 'update' ? createUpdateTransactionApprovalSeal(f.localBinding, issuance) :
        createLocalVerificationTransactionAuthority({ ...f.localBinding, transactionDigest: 'c'.repeat(64) }, issuance));
    await writeFile(f.file, content);
    await expect(store.verify(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow();
    await expect(store.remove(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow();
    await expect(store.write(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow();
    expect(await readFile(f.file, 'utf8')).toBe(content);
  });

  it('rejects project-contained authority storage', async () => {
    const f = await fixture();
    const options = { ...f.options, homedir: f.root, env: { XDG_STATE_HOME: f.root, LOCALAPPDATA: f.root } };
    await expect(createLocalVerificationTransactionAuthorityStore(f.root, options)
      .write(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow(/inside|contain|outside|boundary/i);
    expect(await readdir(f.root)).toEqual([]);
  });

  it('surfaces denied writes and preserves a durably persisted seal after lost acknowledgement', async () => {
    const f = await fixture();
    const denied = createLocalVerificationTransactionAuthorityStore(f.root, {
      ...f.options, fileSystem: { ...nodeUpdatePreviewFileSystem,
        replaceFile: async () => { throw Object.assign(new Error('denied authority replacement'), { code: 'EACCES' }); } }
    });
    await expect(denied.write(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow(/denied/);
    const normal = createLocalVerificationTransactionAuthorityStore(f.root, f.options);
    expect(await normal.verify(binding.planFingerprint, binding.transactionDigest)).toBe(false);
    let persisted = false;
    const lost = createLocalVerificationTransactionAuthorityStore(f.root, {
      ...f.options, fileSystem: { ...nodeUpdatePreviewFileSystem,
        replaceFile: async (from, to) => { await nodeUpdatePreviewFileSystem.replaceFile(from, to); persisted = to === f.file; },
        syncDirectory: async directory => {
          await nodeUpdatePreviewFileSystem.syncDirectory(directory);
          if (persisted) { persisted = false; throw new Error('lost authority acknowledgement'); }
        } }
    });
    await expect(lost.write(binding.planFingerprint, binding.transactionDigest)).rejects.toThrow(/lost authority/);
    expect(await normal.verify(binding.planFingerprint, binding.transactionDigest)).toBe(true);
    await normal.remove(binding.planFingerprint, binding.transactionDigest);
  });

  it('captures configured state storage before awaits', async () => {
    const f = await fixture(), env = { ...f.options.env };
    const store = createLocalVerificationTransactionAuthorityStore(f.root, { ...f.options, env });
    env.XDG_STATE_HOME = f.root; env.LOCALAPPDATA = f.root;
    await store.write(binding.planFingerprint, binding.transactionDigest);
    expect(await readFile(f.file, 'utf8')).toContain('local-verification');
    expect(await readdir(f.root)).toEqual([]);
  });
});
