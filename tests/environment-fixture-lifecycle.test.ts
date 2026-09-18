import { lstat, mkdir, rename, rmdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { environmentQualificationFixture } from './helpers/environment-qualification-fixture.js';

describe('exact owned environment fixture cleanup', () => {
  it('retains a fixture until its owning operation and actual project lease settle', async () => {
    const fixture = await environmentQualificationFixture();
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = fixture.leased(async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    try {
      await ready;
      await expect(fixture.cleanup()).rejects.toThrow(/owning operations are not settled/);
      expect((await lstat(fixture.root)).isDirectory()).toBe(true);
    } finally {
      finish();
      await pending;
      await fixture.cleanup();
    }
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a replacement directory merely because it has the old fixture path', async () => {
    const fixture = await environmentQualificationFixture();
    const retained = `${fixture.root}-identity-test`;
    await rename(fixture.root, retained);
    await mkdir(fixture.root, { mode: 0o700 });
    try {
      await expect(fixture.cleanup()).rejects.toThrow(/creation identity changed/);
      expect((await lstat(fixture.root)).isDirectory()).toBe(true);
      expect((await lstat(retained)).isDirectory()).toBe(true);
    } finally {
      await rmdir(fixture.root);
      await rename(retained, fixture.root);
      await fixture.cleanup();
    }
  });
});
