import { spawn } from 'node:child_process';
import { access, lstat, mkdir, rename, rmdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialFixture } from './helpers/credential-fixture.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture() { const value = await credentialFixture(); fixtures.push(value); return value; }

describe('exact credential fixture cleanup ownership', () => {
  it('preserves its scope until the owned child has actually closed', async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], {
      cwd: f.projectRoot, stdio: 'ignore', env: {}
    });
    f.trackProcess(child);
    let failed = false;
    child.once('error', () => { failed = true; });
    const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
    await expect(f.cleanup()).rejects.toThrow(/has not closed/);
    await expect(access(f.root)).resolves.toBeUndefined();
    await closed;
    expect(failed).toBe(false);
    await f.cleanup();
    await expect(access(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove an active project lease or its surrounding fixture', async () => {
    const f = await fixture();
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      await expect(f.cleanup()).rejects.toThrow(/lease/);
      await lease.assertHeld();
      await expect(access(f.root)).resolves.toBeUndefined();
    });
    await f.cleanup();
  });

  it('refuses a replacement directory at the exact old path, then cleans only its restored owned directory', async () => {
    const f = await fixture();
    const retained = `${f.root}.retained`;
    await rename(f.root, retained);
    await mkdir(f.root, { mode: 0o700 });
    const replacement = await lstat(f.root);
    try {
      await expect(f.cleanup()).rejects.toThrow(/identity changed/);
      await expect(access(f.root)).resolves.toBeUndefined();
      await expect(access(retained)).resolves.toBeUndefined();
    } finally {
      const current = await lstat(f.root);
      if (current.isSymbolicLink() || current.dev !== replacement.dev || current.ino !== replacement.ino ||
        current.birthtimeMs !== replacement.birthtimeMs) throw new Error('Replacement fixture identity changed; both paths retained.');
      await rmdir(f.root);
      await rename(retained, f.root);
    }
    await f.cleanup();
  });
});
