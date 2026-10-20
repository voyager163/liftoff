import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isContainerPortPending, readCreatedContainerId } from '../scripts/generated-container-startup.mjs';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-container-identity-'));
  directories.push(directory);
  return { directory, file: path.join(directory, 'created.cid') };
}

afterEach(async () => {
  vi.mocked(open).mockClear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('generated container port publication', () => {
  const name = 'liftoff-verify-owned-genai-worker';

  it.each([80, 8000])('waits for the exact %i/tcp mapping while Docker starts the container', port => {
    expect(isContainerPortPending(`Error: No public port '${port}/tcp' published for ${name}\n`, name, port)).toBe(true);
  });

  describe('generated container creation identity', () => {
    const id = 'a'.repeat(64);

    it('waits for missing and reserved empty receipts without treating the requested name as ownership', async () => {
      const { file } = await fixture();
      expect(await readCreatedContainerId(file)).toBeUndefined();
      await writeFile(file, '', { flag: 'wx', mode: 0o600 });
      expect(await readCreatedContainerId(file)).toBeUndefined();
      await writeFile(file, id);
      expect(await readCreatedContainerId(file)).toBe(id);
    });

    it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}\n`, 'z'.repeat(64)])(
      'rejects a malformed receipt instead of selecting another cleanup target: %j', async contents => {
        const { file } = await fixture();
        await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
        await expect(readCreatedContainerId(file)).rejects.toThrow(/Docker creation receipt/u);
      }
    );

    it('rejects directories and multiply linked receipts', async () => {
      const { directory, file } = await fixture();
      await mkdir(file);
      await expect(readCreatedContainerId(file)).rejects.toThrow(/single-link regular/u);
      await rm(file, { recursive: true });
      await writeFile(file, id, { flag: 'wx', mode: 0o600 });
      await link(file, path.join(directory, 'another.cid'));
      await expect(readCreatedContainerId(file)).rejects.toThrow(/single-link regular/u);
    });

    it.skipIf(process.platform === 'win32')('rejects linked and dangling receipts without following them', async () => {
      const { directory, file } = await fixture();
      const target = path.join(directory, 'target.cid');
      await writeFile(target, id, { flag: 'wx', mode: 0o600 });
      await symlink(target, file);
      await expect(readCreatedContainerId(file)).rejects.toThrow(/single-link regular/u);
      await rm(target);
      await expect(readCreatedContainerId(file)).rejects.toThrow(/single-link regular/u);
    });

    it.each(['bytes', 'inode', 'size'] as const)('refuses actual %s changes during capture', async mutation => {
      const { directory, file } = await fixture();
      await writeFile(file, id, { flag: 'wx', mode: 0o600 });
      const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const before = await original.lstat(file, { bigint: true });
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await original.open(...args);
        if (mutation === 'inode') {
          await rename(file, path.join(directory, 'original.cid'));
          await writeFile(file, id, { flag: 'wx', mode: 0o600 });
        } else {
          await writeFile(file, mutation === 'size' ? 'b'.repeat(1024 * 1024) : 'b'.repeat(64));
          if (mutation === 'bytes') {
            // A same-size write need not advance the observed Windows timestamps.
            await original.utimes(file, before.atime, new Date(Number(before.mtimeMs) + 2_000));
          }
        }
        return handle;
      });
      await expect(readCreatedContainerId(file)).rejects.toThrow(/changed while/u);
      if (mutation === 'bytes') {
        expect((await original.lstat(file, { bigint: true })).mtimeNs).toBeGreaterThan(before.mtimeNs);
        expect(await readFile(file, 'utf8')).toBe('b'.repeat(64));
      }
    });

    it('addresses inspection and cleanup by the created ID, never by a requested container name', async () => {
      const source = await readFile(path.join(process.cwd(), 'scripts/verify-generated-containers.mjs'), 'utf8');
      expect(source).toContain("'--cidfile', cidFile, '--name', name");
      expect(source).toContain("['port', containerId,");
      expect(source).toContain("'{{json .Config.WorkingDir}}', containerId]");
      expect(source).toContain('`${containerId}:${imagePath}`');
      expect(source).toContain("['rm', '--force', containerId]");
      expect(source).not.toContain("['rm', '--force', name]");
      expect(source).toContain('name-based cleanup is refused');
      expect(source).toContain('if (!retainTempRoot) await rm(tempRoot,');
    });
  });

  it.each([
    `Error response from daemon: No such container: ${name}`,
    `Error: No such object: ${name}`
  ])('retains the existing container-creation wait: %s', message => {
    expect(isContainerPortPending(message, name, 8000)).toBe(true);
  });

  it.each([
    `Error: No public port '80/tcp' published for ${name}`,
    `Error: No public port '8000/udp' published for ${name}`,
    "Error: No public port '8000/tcp' published for another-container",
    `Error: No public port '8000/tcp' published for ${name}-other`,
    `Permission denied: Error: No public port '8000/tcp' published for ${name}`,
    `Error: No public port '8000/tcp' published for ${name}\nDocker daemon unavailable`,
    'Cannot connect to the Docker daemon',
    'permission denied',
    ''
  ])('does not hide a different Docker error: %s', message => {
    expect(isContainerPortPending(message, name, 8000)).toBe(false);
  });
});
