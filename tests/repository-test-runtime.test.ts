import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareTestRuntime, testRuntimeEnvironment } from '../scripts/run-tests.mjs';

describe('external test-runner temporary storage', () => {
  it.runIf(process.platform === 'darwin')('uses a private owned short root when canonical temp would exceed the Unix socket limit', async () => {
    const long = await mkdtemp(path.join(os.tmpdir(), `liftoff-long-${'x'.repeat(64)}-`));
    let runtime: Awaited<ReturnType<typeof prepareTestRuntime>> | undefined;
    try {
      runtime = await prepareTestRuntime(process.cwd(), {}, long);
      expect(runtime.ownedRoot).not.toBeNull();
      expect(Buffer.byteLength(path.join(runtime.environment.TMPDIR, `liftoff-job-${'0'.repeat(36)}.sock`))).toBeLessThan(104);
      expect((await lstat(runtime.ownedRoot!)).mode & 0o077).toBe(0);
      const root = runtime.ownedRoot!;
      await runtime.cleanup();
      runtime = undefined;
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await runtime?.cleanup(); await rm(long, { recursive: true }); }
  });
  it('normalizes native temp and preserves other test environment values', async () => {
    const temp = await realpath(os.tmpdir());
    const result = await testRuntimeEnvironment(process.cwd(), { VITEST: 'fixture' }, temp);
    expect(result).toEqual({ VITEST: 'fixture', TMPDIR: temp, TMP: temp, TEMP: temp });
  });
  it('rejects source-root or nested temporary selection instead of creating untracked caches', async () => {
    for (const dir of [process.cwd(), path.join(process.cwd(), 'tests'), 'relative-directory']) {
      await expect(testRuntimeEnvironment(process.cwd(), { LIFTOFF_TEST_TEMP_PARENT: dir })).rejects.toThrow();
    }
    await expect(testRuntimeEnvironment(process.cwd(), {}, process.cwd())).rejects.toThrow();
  });
  it('uses explicitly registered external storage instead of inherited source-root temp variables', async () => {
    const temp = await realpath(os.tmpdir());
    const env = await testRuntimeEnvironment(process.cwd(), {
      RUNNER_TEMP: temp, TMPDIR: process.cwd(), TEMP: process.cwd(), TMP: process.cwd()
    });
    expect(env.TMPDIR).toBe(temp); expect(env.TMP).toBe(temp); expect(env.TEMP).toBe(temp);
  });
  it.skipIf(process.platform === 'win32')('checks real paths so an alias into source cannot bypass the boundary', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff test runtime '));
    try {
      const alias = path.join(parent, 'alias');
      await symlink(process.cwd(), alias);
      await expect(testRuntimeEnvironment(process.cwd(), { LIFTOFF_TEST_TEMP_PARENT: alias })).rejects.toThrow();
      await mkdir(path.join(parent, 'external'));
      const env = await testRuntimeEnvironment(process.cwd(), { LIFTOFF_TEST_TEMP_PARENT: path.join(parent, 'external') });
      expect(env.TMPDIR).toBe(await realpath(path.join(parent, 'external')));
    } finally { await rm(parent, { recursive: true }); }
  });
});
