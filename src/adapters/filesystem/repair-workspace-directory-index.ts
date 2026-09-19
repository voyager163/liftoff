import path from 'node:path';
import type { RepairWorkspaceFileIdentity } from '../../application/repair/workspaces-types.js';

export function indexWorkspaceDirectoryAncestors(directories: ReadonlyMap<string, RepairWorkspaceFileIdentity>) {
  const key = (directory: string) => path.resolve(directory.normalize('NFC').toLowerCase());
  const indexed = new Map<string, Array<{ directory: string; ordinal: number }>>();
  let ordinal = 0;
  for (const directory of directories.keys()) {
    const folded = key(directory);
    const entries = indexed.get(folded) ?? [];
    entries.push({ directory, ordinal: ordinal++ });
    indexed.set(folded, entries);
  }
  // Only index the captured names. Every lookup retains current map membership,
  // original order and identity objects; no filesystem observation is cached.
  return (targetPath: string): Map<string, RepairWorkspaceFileIdentity> => {
    const ancestors: Array<{ directory: string; ordinal: number }> = [];
    let current = key(targetPath);
    for (;;) {
      for (const entry of indexed.get(current) ?? []) {
        if (entry.directory !== targetPath && directories.has(entry.directory)) ancestors.push(entry);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    ancestors.sort((left, right) => left.ordinal - right.ordinal);
    return new Map(ancestors.map(({ directory }) => [directory, directories.get(directory)!]));
  };
}
