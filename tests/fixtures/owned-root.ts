import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkspaceBoundary } from '../../src/adapters/filesystem/repair-workspaces.js';

export interface OwnedFixtureRoot { name: string; device: bigint; inode: bigint; }

export async function bindCreatedFixtureRoot(allocated: string, identity: BigIntStats): Promise<OwnedFixtureRoot> {
  if (!identity.isDirectory() || identity.isSymbolicLink() ||
      process.getuid !== undefined && identity.uid !== BigInt(process.getuid())) {
    throw new Error('New fixture root is not an owned regular directory.');
  }
  const name = await realpath(allocated);
  for (const selected of [allocated, name]) {
    const current = await lstat(selected, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
        (['dev', 'ino', 'birthtimeNs', 'uid'] as const).some(field => current[field] !== identity[field])) {
      throw new Error('New fixture root changed during canonicalization.');
    }
  }
  await canonicalWorkspaceBoundary(name);
  return { name, device: identity.dev, inode: identity.ino };
}

export async function createOwnedFixtureRoot(parent: string, prefix: string): Promise<OwnedFixtureRoot> {
  const allocated = await mkdtemp(path.join(parent, prefix));
  return bindCreatedFixtureRoot(allocated, await lstat(allocated, { bigint: true }));
}
