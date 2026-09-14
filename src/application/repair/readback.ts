import {
  captureProjectFileSnapshot, type ProjectFileMutation, type ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import { reviewedUpdateTargetMode } from '../../adapters/filesystem/reviewed-update-transaction.js';
import { byteDigest } from './preview.js';

export async function assertRepairReadback(
  root: string, mutations: readonly ProjectFileMutation[], originals: readonly ProjectFileSnapshot[]
): Promise<void> {
  const before = new Map(originals.map((entry) => [entry.pathParts.join('/'), entry]));
  for (const mutation of mutations) {
    const actual = await captureProjectFileSnapshot(root, mutation.pathParts);
    if (mutation.type === 'write'
      ? actual.content === undefined || byteDigest(actual.content) !== byteDigest(mutation.content) ||
        actual.mode !== reviewedUpdateTargetMode(mutation.mode, before.get(mutation.pathParts.join('/'))?.mode)
      : actual.content !== undefined) {
      throw new Error(`Repair committed, but ${mutation.pathParts.join('/')} changed before final byte/mode readback.`);
    }
  }
}
