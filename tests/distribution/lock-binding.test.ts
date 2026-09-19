import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureInputBinding, assertInputBindingUnchanged } from '../../src/application/execution/plan-binding.js';
import {
  currentProjectMutationLease, userScopeMutationLockPath, withProjectMutationLock, withUserScopeMutationLock
} from '../../src/adapters/filesystem/project-lock.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = path.resolve('tests', `.exact-lock-binding-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { mode: 0o700 });
  const nested = path.join(root, 'nested');
  await mkdir(nested, { mode: 0o700 });
  return { root, nested, options: { projectRoot: root, directoryPaths: ['', 'nested'] } };
}

describe('exact active-root lock omission', () => {
  it('does not invalidate review when only the actual current-root user lock is acquired', async () => {
    const value = await fixture();
    const before = await captureInputBinding(value.options);
    expect(await currentProjectMutationLease(value.root)).toBeUndefined();
    await withUserScopeMutationLock(value.root, async () => {
      expect((await currentProjectMutationLease(value.root))?.path).toBe(await userScopeMutationLockPath(value.root));
      await expect(assertInputBindingUnchanged(before, value.options)).resolves.toBeUndefined();
    });
    await expect(assertInputBindingUnchanged(before, value.options)).resolves.toBeUndefined();
  });

  it('retains ordinary project-lock behavior when the owned lock is outside the scanned root', async () => {
    const value = await fixture();
    const before = await captureInputBinding(value.options);
    await withProjectMutationLock(value.root, async () => {
      await expect(assertInputBindingUnchanged(before, value.options)).resolves.toBeUndefined();
    });
  });

  it('never omits an unowned file at the expected root-lock name merely because its name matches', async () => {
    const value = await fixture();
    const before = await captureInputBinding(value.options);
    const lock = await userScopeMutationLockPath(value.root);
    await writeFile(lock, 'foreign owner', { mode: 0o600 });
    expect(await currentProjectMutationLease(value.root)).toBeUndefined();
    await expect(assertInputBindingUnchanged(before, value.options)).rejects.toThrow(/directory inventory/i);
    expect(await readFile(lock, 'utf8')).toBe('foreign owner');
  });

  it.each(['root', 'nested'] as const)('binds foreign %s lock-like additions, content changes, and modes', async (location) => {
    const value = await fixture();
    const filename = `.liftoff-mutation-${'a'.repeat(64)}.lock`;
    const file = path.join(location === 'root' ? value.root : value.nested, filename);
    const before = await captureInputBinding(value.options);
    await writeFile(file, 'owner-one', { mode: 0o600 });
    await expect(assertInputBindingUnchanged(before, value.options)).rejects.toThrow(/directory inventory/i);
    const existing = await captureInputBinding(value.options);
    await writeFile(file, 'owner-two');
    await expect(assertInputBindingUnchanged(existing, value.options)).rejects.toThrow(/directory inventory/i);
    const content = await captureInputBinding(value.options);
    await chmod(file, 0o400);
    await expect(assertInputBindingUnchanged(content, value.options)).rejects.toThrow(/directory inventory/i);
  });

  it('does not omit a nested basename equal to the currently held root lock', async () => {
    const value = await fixture();
    const before = await captureInputBinding(value.options);
    await withUserScopeMutationLock(value.root, async () => {
      const lease = await currentProjectMutationLease(value.root);
      if (!lease) throw new Error('Fixture root lease was not acquired.');
      await writeFile(path.join(value.nested, path.basename(lease.path)), 'unrelated nested owner', { mode: 0o600 });
      await expect(assertInputBindingUnchanged(before, value.options)).rejects.toThrow(/directory inventory/i);
    });
  });

  it('keeps matching directory entries and directory permission changes in the binding', async () => {
    const value = await fixture();
    const directory = path.join(value.root, `.liftoff-mutation-${'b'.repeat(64)}.lock`);
    const before = await captureInputBinding(value.options);
    await mkdir(directory, { mode: 0o700 });
    await expect(assertInputBindingUnchanged(before, value.options)).rejects.toThrow(/directory inventory/i);
    const existing = await captureInputBinding(value.options);
    await chmod(directory, 0o500);
    await expect(assertInputBindingUnchanged(existing, value.options)).rejects.toThrow(/directory inventory/i);
  });

  it('does not borrow another root’s active lease to hide its lock in the inventory', async () => {
    const value = await fixture();
    const before = await captureInputBinding(value.options);
    await withProjectMutationLock(value.nested, async () => {
      expect(await currentProjectMutationLease(value.root)).toBeUndefined();
      await expect(assertInputBindingUnchanged(before, value.options)).rejects.toThrow(/directory inventory/i);
    });
  });

  it('rejects a changed active lock rather than omitting it or cleaning the replacement', async () => {
    const value = await fixture();
    const lock = await userScopeMutationLockPath(value.root);
    await expect(withUserScopeMutationLock(value.root, async () => {
      await writeFile(lock, 'replaced lease content');
      await expect(captureInputBinding(value.options)).rejects.toThrow(/lock contents changed|confirm project mutation lock/);
    })).rejects.toThrow(/release project mutation lock|lock contents changed/);
    expect(await readFile(lock, 'utf8')).toBe('replaced lease content');
  });

  it('does not hide permission changes to the actual held lock', async () => {
    const value = await fixture();
    const lock = await userScopeMutationLockPath(value.root);
    await expect(withUserScopeMutationLock(value.root, async () => {
      await chmod(lock, 0o400);
      await expect(captureInputBinding(value.options)).rejects.toThrow(/mutation lock changed/);
    })).rejects.toThrow(/release project mutation lock/);
    expect(await readFile(lock, 'utf8')).toContain('"schemaVersion":1');
  });
});
