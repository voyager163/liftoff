import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/**
 * @param {string} stderr
 * @param {string} name
 * @param {number} port
 */
export function isContainerPortPending(stderr, name, port) {
  return /no such (object|container)/i.test(stderr) ||
    stderr.trim() === `Error: No public port '${port}/tcp' published for ${name}`;
}

/**
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export async function readCreatedContainerId(file) {
  let selected;
  try {
    selected = await lstat(file, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!selected.isFile() || selected.nlink !== 1n || ![0n, 64n].includes(selected.size)) {
    throw new Error('Docker creation receipt must be a single-link regular container ID file.');
  }
  // Docker reserves an empty cidfile before it creates the container.
  if (selected.size === 0n) return undefined;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(65);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    for (const current of [await handle.stat({ bigint: true }), await lstat(file, { bigint: true })]) {
      if (!current.isFile() || current.dev !== selected.dev || current.ino !== selected.ino ||
        current.size !== selected.size || current.nlink !== 1n ||
        current.mtimeNs !== selected.mtimeNs || current.ctimeNs !== selected.ctimeNs) {
        throw new Error('Docker creation receipt changed while its container ID was read.');
      }
    }
    const id = bytes.subarray(0, bytesRead).toString('utf8');
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Docker creation receipt has an invalid container ID.');
    return id;
  } finally {
    await handle.close();
  }
}
