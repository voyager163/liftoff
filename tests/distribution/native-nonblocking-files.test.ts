import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashNativeFile } from '../../src/adapters/distribution/native-files.js';
import { captureNativeLauncher } from '../../src/adapters/distribution/native-launcher.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'liftoff-native-file-')));
  roots.push(root);
  await fs.mkdir(path.join(root, 'bin'));
  const parts = ['bin', 'liftoff.exe'];
  const file = path.join(root, ...parts);
  const content = Buffer.from('controlled native file read fixture\n');
  await fs.writeFile(file, content);
  return { root, parts, file, content };
}

describe('native file reads reject unsafe opens without native-host qualification', () => {
  it.skipIf(process.platform === 'win32').each([
    { name: 'streaming native hash', openNumber: 1, capture: hashNativeFile },
    { name: 'second launcher-content descriptor', openNumber: 2, capture: captureNativeLauncher }
  ])('opens $name nonblocking before a FIFO substitution', async ({ openNumber, capture }) => {
    const f = await fixture();
    const preserved = path.join(f.root, 'original.bin');
    const open = fs.open;
    let opens = 0;
    let moved = false;
    let substituted = false;
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === f.file && ++opens === openNumber) {
        if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK)) {
          throw new Error('A nonblocking descriptor is required before the FIFO race can be exercised.');
        }
        await fs.rename(f.file, preserved);
        moved = true;
        const made = spawnSync('mkfifo', [f.file], { encoding: 'utf8', timeout: 5000 });
        if (made.status !== 0) throw new Error(`Unable to create the bounded FIFO fixture: ${made.error?.message ?? made.stderr}`);
        substituted = true;
      }
      return open(filename, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      await expect(capture(f.root, f.parts)).rejects.toMatchObject({ reasonCode: 'stale_plan' });
      expect(substituted).toBe(true);
      expect((await fs.lstat(f.file)).isFIFO()).toBe(true);
      expect(await fs.readFile(preserved)).toEqual(f.content);
    } finally {
      if (moved) {
        if (substituted) await fs.unlink(f.file);
        await fs.rename(preserved, f.file);
      }
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])('refuses invalid streaming read ceiling %s before filesystem access', async (maximum) => {
    const f = await fixture();
    const inspect = vi.spyOn(fs, 'lstat');
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(hashNativeFile(f.root, f.parts, maximum)).rejects.toThrow(/read limit/);
    expect(inspect).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
