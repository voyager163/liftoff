import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { portableParts, SecurityEvidenceError } from './evidence.ts';

export interface RegisteredWorkspace {
  root: string;
  write(parts: readonly string[], content: string): Promise<void>;
  verify(parts: readonly string[], content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export function resolveSecurityPath(root: string, parts: readonly string[], pathApi = path): string {
  return pathApi.join(root, ...portableParts(parts));
}

export async function createSecurityWorkspace(parent: string): Promise<RegisteredWorkspace> {
  const created = await mkdtemp(path.join(parent, 'liftoff-security-'));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const owner = randomUUID();
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const identities = new Map<string, string>();
  let closed = false;

  async function checkRoot() {
    if (closed) throw new SecurityEvidenceError('workspace-closed');
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new SecurityEvidenceError('workspace-root-changed');
    const marker = path.join(root, '.security-owner');
    const markerStatus = await lstat(marker);
    if (!markerStatus.isFile() || markerStatus.isSymbolicLink() || await readFile(marker, 'utf8') !== owner) {
      throw new SecurityEvidenceError('workspace-owner-changed');
    }
  }

  const marker = await open(path.join(root, '.security-owner'), 'wx', 0o600);
  try { await marker.writeFile(owner); } finally { await marker.close(); }

  async function checkParents(parts: readonly string[], create: boolean) {
    let current = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const relative = parts.slice(0, index + 1).join('/');
      current = path.join(current, parts[index]!);
      const folded = relative.toLowerCase();
      if (identities.has(folded) && identities.get(folded) !== relative) throw new SecurityEvidenceError('workspace-case-alias');
      if (create && !directories.has(relative)) {
        await mkdir(current);
        directories.add(relative);
        identities.set(folded, relative);
      }
      const status = await lstat(current);
      if (!directories.has(relative) || !status.isDirectory() || status.isSymbolicLink()) {
        throw new SecurityEvidenceError('workspace-parent-changed');
      }
    }
  }

  return {
    root,
    async write(input, content) {
      await checkRoot();
      const parts = portableParts(input);
      const key = parts.join('/');
      const folded = key.toLowerCase();
      if (parts[0] === '.security-owner' || identities.has(folded)) throw new SecurityEvidenceError('workspace-entry-conflict');
      await checkParents(parts, true);
      const destination = resolveSecurityPath(root, parts);
      const file = await open(destination, 'wx', 0o600);
      files.set(key, createHash('sha256').update(content).digest('hex'));
      identities.set(folded, key);
      try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
    },
    async verify(input, content) {
      await checkRoot();
      const parts = portableParts(input);
      await checkParents(parts, false);
      const key = parts.join('/');
      const destination = resolveSecurityPath(root, parts);
      const status = await lstat(destination);
      if (!files.has(key) || !status.isFile() || status.isSymbolicLink() ||
          files.get(key) !== createHash('sha256').update(content).digest('hex') ||
          await readFile(destination, 'utf8') !== content) {
        throw new SecurityEvidenceError('workspace-input-changed');
      }
    },
    async cleanup() {
      await checkRoot();
      const ordered = [...directories].sort((a, b) => b.split('/').length - a.split('/').length);
      for (const directory of ['', ...ordered]) {
        const parts = directory ? directory.split('/') : [];
        await checkParents([...parts, '_entry'], false);
        const target = directory ? resolveSecurityPath(root, parts) : root;
        for (const entry of await readdir(target, { withFileTypes: true })) {
          const key = [...parts, entry.name].join('/');
          if (key === '.security-owner') continue;
          if (entry.isSymbolicLink() || !(entry.isFile() && files.has(key) || entry.isDirectory() && directories.has(key))) {
            throw new SecurityEvidenceError('workspace-unregistered-entry');
          }
        }
      }
      for (const file of files.keys()) {
        const parts = file.split('/');
        await checkParents(parts, false);
        const target = resolveSecurityPath(root, parts);
        const status = await lstat(target);
        if (!status.isFile() || status.isSymbolicLink()) throw new SecurityEvidenceError('workspace-file-changed');
      }
      for (const file of files.keys()) await unlink(resolveSecurityPath(root, file.split('/')));
      for (const directory of ordered) await rmdir(resolveSecurityPath(root, directory.split('/')));
      await unlink(path.join(root, '.security-owner'));
      await rmdir(root);
      closed = true;
    }
  };
}
