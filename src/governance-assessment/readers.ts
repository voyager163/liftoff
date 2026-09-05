import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolveProjectPath, validateArtifactPathParts } from '../file-system.js';
import { canonicalSha256, sha256Hex } from '../governance-activation/canonical-json.js';
import { assessmentLimits } from './types.js';
import { sanitizeAssessmentText } from './sanitize.js';

export class AssessmentInputError extends Error {
  constructor(readonly code: string, message: string, readonly source: string | null = null) {
    super(sanitizeAssessmentText(message));
    this.name = 'AssessmentInputError';
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

export class AssessmentFiles {
  private readonly files = new Map<string, { parts: string[]; digest: string | null }>();
  private readonly directories = new Map<string, { parts: string[]; entries: string[] }>();
  private bytesRead = 0;

  constructor(readonly root: string) {}

  async read(parts: readonly string[]): Promise<string | null> {
    const normalized = validateArtifactPathParts([...parts], 'Assessment artifact');
    const label = normalized.join('/');
    const resolved = await resolveProjectPath(this.root, normalized);
    if (!this.files.has(label) && this.files.size >= assessmentLimits.maxFiles) {
      throw new AssessmentInputError('input-limit', 'Assessment input file limit exceeded.', label);
    }
    let file;
    try {
      const entry = await lstat(resolved);
      if (!entry.isFile()) throw new AssessmentInputError('unsafe-input', `Assessment artifact ${label} is not a regular file.`, label);
      file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error instanceof AssessmentInputError) throw error;
      if (errorCode(error) === 'ENOENT') {
        this.files.set(label, { parts: normalized, digest: null });
        return null;
      }
      throw new AssessmentInputError('unreadable-input', `Cannot read assessment artifact ${label}.`, label);
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new AssessmentInputError('invalid-input', `Assessment artifact ${label} is not a regular file.`, label);
      if (stat.size > assessmentLimits.fileBytes) throw new AssessmentInputError('input-limit', `Assessment artifact ${label} exceeds the 1 MiB limit.`, label);
      const buffer = Buffer.alloc(assessmentLimits.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      this.bytesRead += length;
      if (length > assessmentLimits.fileBytes || this.bytesRead > 20 * assessmentLimits.fileBytes) {
        throw new AssessmentInputError('input-limit', `Assessment input budget exceeded while reading ${label}.`, label);
      }
      const contents = buffer.subarray(0, length).toString('utf8');
      this.files.set(label, { parts: normalized, digest: sha256Hex(contents) });
      return contents;
    } finally {
      await file.close();
    }
  }

  async list(parts: readonly string[], extensions: readonly string[]): Promise<string[][]> {
    const normalized = validateArtifactPathParts([...parts], 'Assessment directory');
    const label = normalized.join('/');
    const resolved = await resolveProjectPath(this.root, normalized);
    let entries;
    try {
      entries = await readdir(resolved, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.directories.set(label, { parts: normalized, entries: [] });
        return [];
      }
      throw new AssessmentInputError('unreadable-input', `Cannot enumerate ${label}.`, label);
    }
    const files = entries.filter((entry) => extensions.some((extension) => entry.name.endsWith(extension)));
    if (files.length > assessmentLimits.maxFiles) throw new AssessmentInputError('input-limit', `${label} exceeds the file inventory limit.`, label);
    const result = files.map((entry) => {
      if (!entry.isFile()) throw new AssessmentInputError('unsafe-input', `${label} contains a non-regular assessment artifact.`, label);
      return validateArtifactPathParts([...normalized, entry.name], 'Assessment file');
    }).sort((a, b) => a.join('/').localeCompare(b.join('/'), 'en'));
    this.directories.set(label, { parts: normalized, entries: entries.map((entry) => entry.name).sort() });
    return result;
  }

  digest(): string {
    return canonicalSha256({
      files: [...this.files.entries()].map(([name, value]) => [name, value.digest]).sort(([a], [b]) => String(a).localeCompare(String(b), 'en')),
      directories: [...this.directories.entries()].map(([name, value]) => [name, value.entries]).sort(([a], [b]) => String(a).localeCompare(String(b), 'en'))
    });
  }

  async stable(): Promise<boolean> {
    const before = this.digest();
    const files = [...this.files.values()];
    const directories = [...this.directories.values()];
    this.bytesRead = 0;
    for (const file of files) await this.read(file.parts);
    for (const directory of directories) await this.list(directory.parts, []);
    return before === this.digest();
  }
}

export function parseAssessmentJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AssessmentInputError('malformed-json', `Invalid JSON in ${label}.`, label);
  }
}
