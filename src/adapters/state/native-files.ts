import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';

async function inspectNativeFile(filename: string) {
  stateAssert(path.isAbsolute(filename) && await realpath(path.dirname(filename)) === path.dirname(filename), 'unsafe-path');
  const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  stateAssert(!existing || (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1), 'unsafe-path');
  return existing;
}

export async function writePrivateNativeFile(filename: string, bytes: string | Uint8Array, exclusive = false): Promise<void> {
  const before = await inspectNativeFile(filename);
  stateAssert(!exclusive || !before, 'unsafe-path');
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
    | (exclusive ? constants.O_EXCL : 0), 0o600);
  try {
    const current = await file.stat();
    stateAssert(current.isFile() && current.nlink === 1
      && (!before || (current.ino === before.ino && current.dev === before.dev)), 'unsafe-path');
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(bytes);
    await file.sync();
  } finally { await file.close(); }
}

export async function readPrivateNativeFile(filename: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await inspectNativeFile(filename);
  stateAssert(before && before.size <= maximumBytes, 'storage-limit');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat();
    stateAssert(current.isFile() && current.nlink === 1 && current.ino === before.ino && current.dev === before.dev
      && current.size === before.size, 'unsafe-path');
    return await file.readFile();
  } finally { await file.close(); }
}
