import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observePathLaunchers } from '../../src/adapters/distribution/launcher-observation.js';
import { NATIVE_LAUNCHER_MAX_BYTES } from '../../src/adapters/distribution/native-launcher-limits.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = path.resolve('tests', `.launcher-observation-${randomUUID()}`);
  roots.push(root);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second);
  await writeFile(path.join(second, 'liftoff'), 'later unverified launcher', { mode: 0o755 });
  return { root, first, second, env: { PATH: `${first}:${second}` } };
}

describe('fail-closed PATH launcher observation', () => {
  it('does not hide an oversized higher-priority launcher as absence', async () => {
    const value = await fixture();
    await writeFile(path.join(value.first, 'liftoff'), Buffer.alloc(NATIVE_LAUNCHER_MAX_BYTES + 1), { mode: 0o755 });
    await expect(observePathLaunchers(value.env, value.root, 'linux')).rejects.toMatchObject({ reasonCode: 'unsafe_path' });
  });

  it('observes the complete current byte limit without hiding the first launcher', async () => {
    const value = await fixture();
    await writeFile(path.join(value.first, 'liftoff'), Buffer.alloc(NATIVE_LAUNCHER_MAX_BYTES), { mode: 0o755 });
    const observed = await observePathLaunchers(value.env, value.root, 'linux');
    expect(observed[0]).toMatchObject({
      path: path.join(value.first, 'liftoff'), state: 'file', file: { size: NATIVE_LAUNCHER_MAX_BYTES }
    });
    expect(observed.map((entry) => entry.path)).toEqual([
      path.join(value.first, 'liftoff'), path.join(value.second, 'liftoff')
    ]);
  });

  it('does not hide a directory at a launcher path while selecting a later owner', async () => {
    const value = await fixture();
    await mkdir(path.join(value.first, 'liftoff'));
    await expect(observePathLaunchers(value.env, value.root, 'linux')).rejects.toMatchObject({ reasonCode: 'unsafe_path' });
  });

  it('does not hide a case-colliding launcher name while selecting a later owner', async () => {
    const value = await fixture();
    await writeFile(path.join(value.first, 'Liftoff'), 'case alias', { mode: 0o755 });
    await expect(observePathLaunchers(value.env, value.root, 'linux')).rejects.toMatchObject({ reasonCode: 'unsafe_path' });
  });

  it('skips genuinely absent entries and keeps actual PATH precedence', async () => {
    const value = await fixture();
    const observed = await observePathLaunchers({
      PATH: `${path.join(value.root, 'absent')}:${value.first}:${value.second}`
    }, value.root, 'linux');
    expect(observed.map((entry) => entry.path)).toEqual([path.join(value.second, 'liftoff')]);
  });
});
