import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const releasedBaselineIndexSha256 = 'ccd0fc5ce4122383aeb32ac384f7aa8d9c1de00df56a2d76abfe615c7047b3ab';
export const releasedBaselineDirectory = fileURLToPath(new URL('./corpus-v2/', import.meta.url));

export interface CapturedBlob {
  sha256: string;
  byteLength: number;
}
export interface CapturedFile extends CapturedBlob {
  path: string;
  mode: number;
}
export interface ReleasedSource {
  release: string;
  commit: string;
  tagObject: string;
  files: Array<CapturedFile & { gitBlob: string }>;
  journalExecutionFiles: string[];
}
export interface CapturedActivation {
  id: string;
  family: 'activation';
  root: string;
  files: CapturedFile[];
  externalAuthority?: CapturedFile[];
  authority: { release: string; kind: string };
}
export interface CapturedJournal {
  id: string;
  family: 'journal';
  writerId: string;
  release: string;
  kind: 'update' | 'repair';
  schemaVersion: number;
  explicitKind: boolean;
  recipe?: 'azure-local-layout' | 'application-layout-patch';
  checkpoint: { phase: 'after-mutation' | 'committed'; index?: number };
  root: string;
  home: string;
  files: CapturedFile[];
  externalSeals: CapturedFile[];
  owner: CapturedFile;
  handover: CapturedBlob;
  journalPath: string;
}
export interface ReleasedBaselineIndex {
  schemaVersion: number;
  implementationBaseline: { release: string; commit: string };
  capture: Record<string, string>;
  sources: ReleasedSource[];
  cases: Array<CapturedActivation | CapturedJournal>;
  counts: { cases: number; blobs: number; sourceFiles: number };
}

export const releasedDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function readReleasedBaselineIndex(): ReleasedBaselineIndex {
  const bytes = readFileSync(path.join(releasedBaselineDirectory, 'index.json'));
  if (releasedDigest(bytes) !== releasedBaselineIndexSha256) throw new Error('Immutable released baseline index changed.');
  return JSON.parse(bytes.toString('utf8')) as ReleasedBaselineIndex;
}

export function releasedBytes(file: CapturedBlob): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid released blob identity.');
  const bytes = readFileSync(path.join(releasedBaselineDirectory, 'blobs', file.sha256));
  if (bytes.length !== file.byteLength || releasedDigest(bytes) !== file.sha256) throw new Error('Immutable released bytes changed.');
  return bytes;
}

export function releasedCase(id: string): CapturedActivation | CapturedJournal {
  const entry = readReleasedBaselineIndex().cases.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No captured release case: ${id}`);
  return entry;
}

export function releasedCaseFiles(id: string): Map<string, Buffer> {
  return new Map(releasedCase(id).files.map((file) => [file.path, releasedBytes(file)]));
}

export async function materializeReleasedFiles(root: string, files: readonly CapturedFile[]): Promise<void> {
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\u0000]/u.test(part))) {
      throw new Error(`Invalid captured relative path: ${file.path}`);
    }
    const target = path.join(root, ...parts);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, releasedBytes(file), { flag: 'wx', mode: file.mode });
    await chmod(target, file.mode);
  }
}

export async function materializeReleasedJournalSource(root: string, source: ReleasedSource): Promise<void> {
  const selected = new Set(source.journalExecutionFiles);
  const files = source.files.filter((file) => selected.has(file.path));
  if (files.length !== selected.size) throw new Error('The released writer source closure is incomplete.');
  await materializeReleasedFiles(root, files);
}

export async function capturedTree(root: string): Promise<Array<{ path: string; mode: number; bytes: string }>> {
  const files: Array<{ path: string; mode: number; bytes: string }> = [];
  async function visit(parts: string[]): Promise<void> {
    for (const entry of (await readdir(path.join(root, ...parts), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const next = [...parts, entry.name];
      if (entry.isDirectory()) await visit(next);
      else {
        const target = path.join(root, ...next);
        const details = await lstat(target);
        if (!details.isFile() || details.nlink !== 1) throw new Error('Expected a private regular characterization file.');
        files.push({ path: next.join('/'), mode: details.mode & 0o7777, bytes: (await readFile(target)).toString('base64') });
      }
    }
  }
  await visit([]);
  return files;
}
