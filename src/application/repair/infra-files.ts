import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { artifactPath } from '../../adapters/filesystem/project-paths.js';
import { unsupported } from '../../adapters/hcl/semantic.js';

export const infrastructureRoot = ['infrastructure', 'opentofu', 'azure'];
export const infrastructureFileLimit = 256 * 1024;
export const infrastructureTotalFileLimit = 4 * 1024 * 1024;
const directoryEntryLimit = 256;

export interface InfrastructureDirectoryObservation {
  pathParts: string[];
  exists: boolean;
  entries: { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class InfrastructureFiles {
  readonly snapshots = new Map<string, ProjectFileSnapshot>();
  readonly directoryInventory: InfrastructureDirectoryObservation[] = [];
  private totalBytes = 0;

  constructor(private readonly projectRoot: string) {}

  async safePath(parts: string[]): Promise<string> {
    const target = artifactPath(this.projectRoot, parts);
    for (let i = 1; i <= parts.length; i++) {
      try {
        const details = await lstat(path.join(this.projectRoot, ...parts.slice(0, i)));
        if (details.isSymbolicLink()) {
          unsupported(`${parts.slice(0, i).join('/')}: symlink or junction is unsupported.`);
        }
      } catch (error) {
        if (missing(error)) break;
        throw error;
      }
    }
    return target;
  }

  async read(parts: string[]): Promise<ProjectFileSnapshot> {
    const key = parts.join('/');
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    const snapshot: ProjectFileSnapshot = { pathParts: [...parts] };
    this.snapshots.set(key, snapshot);
    const target = await this.safePath(parts);
    try {
      const before = await lstat(target);
      if (!before.isFile() || before.nlink !== 1) unsupported(`${key}: expected an unlinked regular file.`);
      if (before.size > infrastructureFileLimit) unsupported(`${key}: source exceeds the 256 KiB file bound.`);
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.ino !== before.ino || details.dev !== before.dev ||
            details.size !== before.size) unsupported(`${key}: source changed during inspection.`);
        const buffer = Buffer.alloc(infrastructureFileLimit + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        if (bytes > infrastructureFileLimit) unsupported(`${key}: source exceeds the 256 KiB file bound.`);
        this.totalBytes += bytes;
        if (this.totalBytes > infrastructureTotalFileLimit) unsupported('Infrastructure exceeds the 4 MiB total source bound.');
        const content = buffer.subarray(0, bytes);
        if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content) || content.includes(0)) {
          unsupported(`${key}: configuration must contain UTF-8 text without NUL bytes.`);
        }
        snapshot.content = content;
        snapshot.mode = details.mode & 0o7777;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return snapshot;
  }

  async inventory(parts: string[], known: Set<string>): Promise<void> {
    const observation: InfrastructureDirectoryObservation = { pathParts: [...parts], exists: false, entries: [] };
    this.directoryInventory.push(observation);
    try {
      const target = await this.safePath(parts);
      const details = await lstat(target);
      if (!details.isDirectory()) unsupported(`${parts.join('/')}: expected an infrastructure directory.`);
      const directory = await opendir(target);
      observation.exists = true;
      for await (const entry of directory) {
        if (observation.entries.length >= directoryEntryLimit) {
          unsupported(`${parts.join('/')}: directory exceeds the 256-entry inspection bound.`);
        }
        const kind = entry.isSymbolicLink() ? 'symlink' :
          entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
        observation.entries.push({ name: entry.name, kind });
      }
      observation.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const folded = new Set<string>();
      for (const entry of observation.entries) {
        const full = [...parts, entry.name].join('/');
        const lower = entry.name.toLowerCase();
        if (folded.has(lower)) unsupported(`${parts.join('/')}: case-colliding infrastructure entries.`);
        folded.add(lower);
        const expected = [...known].find((item) => item.toLowerCase() === full.toLowerCase());
        if (expected && expected !== full) unsupported(`${full}: case-colliding expected infrastructure path.`);
        // Enumeration detects active configuration; it never grants file ownership.
        if ((lower.endsWith('.tf') || lower.endsWith('.tf.json') ||
             lower.endsWith('.tfvars') || lower.endsWith('.tfvars.json') ||
             lower.endsWith('.tofu') || lower.endsWith('.tofu.json') ||
             lower === '.terraform.lock.hcl' || lower === '.terraformrc' || lower === 'terraform.rc') &&
            !known.has(full)) unsupported(`${full}: additional active configuration is not in the registered inventory.`);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
