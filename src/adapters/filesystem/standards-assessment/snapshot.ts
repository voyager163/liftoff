import type { Stats } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateArtifactPathParts } from '../../../domain/project/paths.js';
import { observedFileStamp, readObservedFile } from '../observed-file.js';
import { PathSafetyError } from './errors.js';

export type SnapshotEntryKind = 'file' | 'directory' | 'symlink' | 'other';
export interface SnapshotEntry { name: string; kind: SnapshotEntryKind }

export class SnapshotLimitError extends Error {
  constructor(readonly reason: 'time_limit_exceeded' | 'count_limit_exceeded') {
    super(reason === 'time_limit_exceeded' ? 'Assessment observation time budget exceeded.' : 'Assessment directory entry budget exceeded.');
    this.name = 'SnapshotLimitError';
  }
}

export const foldedAssessmentPath = (value: string): string => value.normalize('NFKC').toUpperCase().toLowerCase();

export function assessmentPathParts(value: readonly string[], allowRoot = false): string[] {
  if (allowRoot && value.length === 0) return [];
  let parts: string[];
  try { parts = validateArtifactPathParts(value, 'Assessment path'); }
  catch (error) { throw new PathSafetyError(error instanceof Error ? error.message : 'Invalid assessment path.'); }
  if (parts.length > 64 || Buffer.byteLength(parts.join('/')) > 4096 ||
      parts.some((part) => part !== part.normalize('NFKC') || Buffer.byteLength(part) > 255 ||
        /[\u0000-\u001f\u007f<>:"|?*]/u.test(part))) {
    throw new PathSafetyError('Assessment path is nonportable or normalization-ambiguous.');
  }
  return parts;
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return right.isDirectory() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid;
}

export async function captureCanonicalAncestors(directory: string): Promise<ReadonlyMap<string, Stats>> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory ||
      /[\u0000-\u001f\u007f]/u.test(directory) || /^\\\\[?.]\\/.test(directory)) {
    throw new PathSafetyError('Assessment requires an absolute canonical native directory.');
  }
  const root = path.parse(directory).root;
  const names = path.relative(root, directory).split(path.sep).filter(Boolean);
  const result = new Map<string, Stats>();
  let current = root;
  for (const name of ['', ...names]) {
    if (name) current = path.join(current, name);
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(current) !== current) {
      throw new PathSafetyError(`Assessment path traverses a link, junction, or noncanonical directory: ${current}`);
    }
    result.set(current, details);
  }
  return result;
}

export async function assertCanonicalAncestors(ancestors: ReadonlyMap<string, Stats>): Promise<void> {
  for (const [directory, before] of ancestors) {
    const current = await lstat(directory);
    if (!sameDirectoryIdentity(before, current) || await realpath(directory) !== directory) {
      throw new PathSafetyError('Assessment directory identity changed during observation.');
    }
  }
}

function kind(details: Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>): SnapshotEntryKind {
  return details.isSymbolicLink() ? 'symlink' : details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'other';
}

export class AssessmentSnapshot {
  private readonly observations = new Map<string, Stats>();
  private readonly absent = new Set<string>();
  private readonly directories = new Map<string, readonly SnapshotEntry[]>();

  private constructor(
    readonly root: string,
    private readonly ancestors: ReadonlyMap<string, Stats>
  ) {}

  static async create(root: string): Promise<AssessmentSnapshot> {
    return new AssessmentSnapshot(root, await captureCanonicalAncestors(root));
  }

  private async checkedPath(parts: readonly string[]): Promise<string> {
    assessmentPathParts(parts, true);
    await assertCanonicalAncestors(this.ancestors);
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const details = await lstat(current);
      const observed = this.observations.get(current);
      if (!details.isDirectory() || details.isSymbolicLink() || await realpath(current) !== current ||
          observed && !sameDirectoryIdentity(observed, details)) {
        throw new PathSafetyError('Assessment traverses a changed or linked parent directory.');
      }
    }
    return path.join(this.root, ...parts);
  }

  async inspect(parts: readonly string[]): Promise<Stats | null> {
    const fullPath = await this.checkedPath(parts);
    let details: Stats;
    try { details = await lstat(fullPath); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      if (this.observations.has(fullPath)) throw new PathSafetyError('Assessment entry disappeared during observation.');
      this.absent.add(fullPath);
      return null;
    }
    const prior = this.observations.get(fullPath);
    if (this.absent.has(fullPath) || prior && observedFileStamp(prior) !== observedFileStamp(details)) {
      throw new PathSafetyError('Assessment entry changed during observation.');
    }
    Object.freeze(details);
    this.observations.set(fullPath, details);
    return details;
  }

  async list(
    parts: readonly string[],
    maximumEntries: number,
    withinBudget: () => boolean = () => true
  ): Promise<readonly SnapshotEntry[]> {
    const fullPath = await this.checkedPath(parts);
    const cached = this.directories.get(fullPath);
    if (cached) return cached;
    const before = await this.inspect(parts);
    if (!before?.isDirectory() || before.isSymbolicLink() || await realpath(fullPath) !== fullPath) {
      throw new PathSafetyError('Assessment inventory requires a real canonical directory.');
    }
    const entries: SnapshotEntry[] = [];
    const names = new Set<string>();
    const directory = await opendir(fullPath);
    for await (const entry of directory) {
      if (!withinBudget()) throw new SnapshotLimitError('time_limit_exceeded');
      if (entries.length >= maximumEntries) throw new SnapshotLimitError('count_limit_exceeded');
      assessmentPathParts([entry.name]);
      const folded = foldedAssessmentPath(entry.name);
      if (names.has(folded)) throw new PathSafetyError('Case or normalization collision detected in assessment directory.');
      names.add(folded);
      entries.push({ name: entry.name, kind: kind(entry) });
    }
    await this.inspect(parts);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) Object.freeze(entry);
    Object.freeze(entries);
    this.directories.set(fullPath, entries);
    return entries;
  }

  async read(parts: readonly string[], maximumBytes: number): Promise<{ content: Buffer; metadata: Stats }> {
    const before = await this.inspect(parts);
    if (!before) throw new PathSafetyError('Assessment file disappeared before its bounded read.');
    const fullPath = path.join(this.root, ...parts);
    const result = await readObservedFile(fullPath, {
      maximumBytes, expected: before, assertPathCurrent: () => this.checkedPath(parts)
    });
    await this.inspect(parts);
    return result;
  }

  async assertCurrent(withinBudget: () => boolean = () => true): Promise<void> {
    await assertCanonicalAncestors(this.ancestors);
    for (const [filename, before] of this.observations) {
      if (!withinBudget()) throw new SnapshotLimitError('time_limit_exceeded');
      const parts = path.relative(this.root, filename).split(path.sep).filter(Boolean);
      const current = await lstat(await this.checkedPath(parts));
      if (observedFileStamp(before) !== observedFileStamp(current)) {
        throw new PathSafetyError('Assessment file or directory changed during observation.');
      }
    }
    for (const filename of this.absent) {
      if (!withinBudget()) throw new SnapshotLimitError('time_limit_exceeded');
      const parts = path.relative(this.root, filename).split(path.sep).filter(Boolean);
      try { await lstat(await this.checkedPath(parts)); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      throw new PathSafetyError('An absent assessment entry appeared during observation.');
    }
  }
}
