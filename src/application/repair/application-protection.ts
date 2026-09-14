import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  ApplicationFiles, ApplicationInspectionError, applicationPathKey, applicationWithin
} from './application-files.js';
import { applicationCandidateDirectories, applicationCandidateFiles } from './application-candidate.js';
import { applicationPreparationBounds } from './application-preparation-policy.js';
import type { ApplicationPrivateOutputRole, ApplicationResolvedPreparation } from './application-preparation-types.js';
import type { ApplicationPatchCandidate } from './application-types.js';

function sameParts(left: readonly string[], right: readonly string[]): boolean {
  return applicationPathKey(left) === applicationPathKey(right);
}

export class ApplicationCandidateProtection {
  private readonly files: ProjectFileSnapshot[];
  private readonly directories;
  private readonly controlFiles: ProjectFileSnapshot[] = [];
  private readonly frozen = new Map<string, { role: ApplicationPrivateOutputRole; digest: string }>();
  private readonly fileHashes = new Map<string, { stamp: string; digest: string }>();

  constructor(private readonly candidate: ApplicationPatchCandidate, private readonly workspace: string) {
    this.files = applicationCandidateFiles(candidate);
    this.directories = applicationCandidateDirectories(candidate);
  }

  async captureControls(): Promise<void> {
    const reader = new ApplicationFiles(this.workspace);
    for (const name of ['npm-user.rc', 'npm-global.rc', 'pip.conf', 'gitconfig']) {
      const snapshot = await reader.read(['home', name]);
      if (snapshot.content === undefined) throw new ApplicationInspectionError('[candidate-control] Private environment configuration was not initialized.');
      this.controlFiles.push(snapshot);
    }
    await reader.assertUnchanged();
  }

  private allowedOutput(parts: readonly string[]): boolean {
    const full = ['project', ...parts];
    return this.candidate.verificationPolicy.outputRoles.some((role) => {
      const key = applicationPathKey(full), allowed = applicationPathKey(role.pathParts);
      return key === allowed || allowed.startsWith(`${key}/`);
    });
  }

  async assertCurrent(): Promise<void> {
    const project = path.join(this.workspace, 'project');
    const present = new ApplicationFiles(project), absent = new ApplicationFiles(project);
    for (const expected of this.files) {
      const reader = expected.content === undefined ? absent : present;
      const actual = await reader.read(expected.pathParts);
      if (actual.mode !== expected.mode || (actual.content === undefined) !== (expected.content === undefined) ||
          actual.content !== undefined && !actual.content.equals(expected.content!)) {
        throw new ApplicationInspectionError('[changed-candidate-input] Preparation or verification changed protected candidate source, manifest, lock bytes, or modes.');
      }
    }
    for (const expected of this.directories) {
      const actual = await present.inventory(expected.pathParts);
      if (!actual.exists || expected.pathParts.length > 0 && expected.mode !== null && actual.mode !== expected.mode) {
        throw new ApplicationInspectionError('[changed-candidate-directory] An inspected candidate directory changed.');
      }
      const known = new Map<string, 'file' | 'directory'>();
      for (const file of this.files) {
        if (file.content !== undefined && sameParts(file.pathParts.slice(0, -1), expected.pathParts)) known.set(file.pathParts.at(-1)!, 'file');
      }
      for (const directory of this.directories) {
        if (directory.pathParts.length && sameParts(directory.pathParts.slice(0, -1), expected.pathParts)) {
          known.set(directory.pathParts.at(-1)!, 'directory');
        }
      }
      for (const entry of actual.entries) {
        const kind = known.get(entry.name);
        if (kind) {
          if (entry.kind !== kind) throw new ApplicationInspectionError('[changed-candidate-directory] A protected directory member changed type.');
          continue;
        }
        if (entry.kind !== 'directory' || !this.allowedOutput([...expected.pathParts, entry.name])) {
          throw new ApplicationInspectionError('[undeclared-private-output] Preparation or checking created an undeclared candidate file/directory outside its private output roles.');
        }
      }
    }
    const controls = new ApplicationFiles(this.workspace);
    for (const expected of this.controlFiles) {
      const actual = await controls.read(expected.pathParts);
      if (actual.mode !== expected.mode || !actual.content?.equals(expected.content!)) {
        throw new ApplicationInspectionError('[changed-private-configuration] Private credential-free tool configuration changed during execution.');
      }
    }
    await present.assertUnchanged();
    await absent.assertUnchanged();
    await controls.assertUnchanged();
    for (const { role, digest } of this.frozen.values()) {
      if (await this.dependencyDigest(role) !== digest) {
        throw new ApplicationInspectionError('[changed-prepared-dependencies] Prepared dependency bytes, modes, links, or directory inventory changed after preparation.');
      }
    }
  }

  async freeze(preparation: ApplicationResolvedPreparation): Promise<void> {
    for (const role of preparation.outputRoles.filter((item) => item.protectedAfterPreparation)) {
      this.frozen.set(role.id, { role, digest: await this.dependencyDigest(role) });
    }
  }

  get preparedScopeDigest(): string {
    return canonicalSha256([...this.frozen].map(([id, value]) => ({ id, digest: value.digest })).sort((a, b) => a.id.localeCompare(b.id, 'en')));
  }

  private async dependencyDigest(role: ApplicationPrivateOutputRole): Promise<string> {
    const root = path.join(this.workspace, ...role.pathParts);
    const rootDetails = await lstat(root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() || await realpath(root) !== root) {
      throw new ApplicationInspectionError('[missing-prepared-dependencies] The registered private dependency root is absent, linked, or changed.');
    }
    const mutable = this.candidate.verificationPolicy.outputRoles.filter((item) => !item.protectedAfterPreparation)
      .map((item) => path.join(this.workspace, ...item.pathParts));
    const approvedTools = new Set(this.candidate.verificationPolicy.toolchain.flatMap((item) =>
      [item.executablePath, ...item.files.map((file) => file.path)]));
    const entries: { path: string; kind: string; mode: number; digest?: string; target?: string }[] = [];
    let files = 0, directories = 0, totalBytes = 0;
    const visit = async (target: string, parts: string[]): Promise<void> => {
      if (mutable.some((allowed) => applicationWithin(allowed, target))) return;
      if (parts.length > applicationPreparationBounds.privateDepth) throw new ApplicationInspectionError('[private-output-bound] Prepared dependency depth exceeds its bound.');
      const before = await lstat(target);
      const mode = before.mode & 0o7777;
      if (before.isSymbolicLink()) {
        const resolved = await realpath(target);
        if (!applicationWithin(this.workspace, resolved) && !approvedTools.has(resolved)) {
          throw new ApplicationInspectionError('[unsafe-prepared-link] A private dependency link targets unapproved project, staging, cache, or host scope.');
        }
        entries.push({ path: parts.join('/'), kind: 'link', mode, target: await readlink(target) });
        if (++files > applicationPreparationBounds.privateFiles) throw new ApplicationInspectionError('[private-output-bound] Prepared dependency count exceeds its bound.');
        return;
      }
      if (before.isDirectory()) {
        if (++directories > applicationPreparationBounds.privateDirectories) throw new ApplicationInspectionError('[private-output-bound] Prepared directory count exceeds its bound.');
        entries.push({ path: parts.join('/'), kind: 'directory', mode });
        const names: string[] = [];
        for await (const entry of await opendir(target)) {
          if (names.length >= applicationPreparationBounds.privateFiles) throw new ApplicationInspectionError('[private-output-bound] Prepared directory entries exceed the bound.');
          names.push(entry.name);
        }
        names.sort();
        for (const name of names) await visit(path.join(target, name), [...parts, name]);
        const after = await lstat(target);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
            after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
          throw new ApplicationInspectionError('[changed-prepared-dependencies] Prepared directory changed while it was inspected.');
        }
        return;
      }
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7000) !== 0) {
        throw new ApplicationInspectionError('[unsafe-prepared-output] Prepared outputs must be ordinary private files, directories, or approved links.');
      }
      totalBytes += before.size;
      if (++files > applicationPreparationBounds.privateFiles || totalBytes > applicationPreparationBounds.privateBytes) {
        throw new ApplicationInspectionError('[private-output-bound] Prepared dependency file/byte bounds were exceeded.');
      }
      const stamp = [before.dev, before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs].join(':');
      const cached = this.fileHashes.get(target);
      let digest = cached?.stamp === stamp ? cached.digest : undefined;
      if (!digest) {
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = await handle.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) {
            throw new ApplicationInspectionError('[changed-prepared-dependencies] Prepared file changed before inspection.');
          }
          const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
          let offset = 0;
          while (offset < before.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) throw new ApplicationInspectionError('[changed-prepared-dependencies] Prepared file was truncated during inspection.');
            hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
          }
          const after = await handle.stat();
          if (after.size !== before.size || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new ApplicationInspectionError('[changed-prepared-dependencies] Prepared file changed during inspection.');
          }
          digest = hash.digest('hex');
          this.fileHashes.set(target, { stamp, digest });
        } finally { await handle.close(); }
      }
      entries.push({ path: parts.join('/'), kind: 'file', mode, digest });
    };
    await visit(root, []);
    return canonicalSha256(entries);
  }
}
