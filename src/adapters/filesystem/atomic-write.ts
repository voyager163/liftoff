import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function replaceFileAtomically(targetPath: string, content: string | Buffer): Promise<void> {
  let mode: number | undefined;
  try {
    const existing = await lstat(targetPath);
    if (!existing.isFile()) throw new Error('Atomic replacement requires a regular-file destination.');
    mode = existing.mode & 0o7777;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return writeAtomicFile(targetPath, content, mode, (temporary) => rename(temporary, targetPath), true);
}

export async function createFileAtomically(
  targetPath: string,
  content: string | Buffer,
  mode: number,
  onCreated?: () => void
): Promise<void> {
  return writeAtomicFile(targetPath, content, mode, async (temporary) => {
    await link(temporary, targetPath);
    // Track the destination even if the subsequent temporary-file cleanup fails.
    onCreated?.();
    await unlink(temporary);
  });
}

async function writeAtomicFile(
  targetPath: string,
  content: string | Buffer,
  mode: number | undefined,
  commit: (temporaryPath: string) => Promise<void>,
  createParents = false
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.liftoff-${process.pid}-${randomUUID()}.tmp`
  );
  let handle: FileHandle | undefined;
  let ownsTemporaryPath = false;
  try {
    if (createParents) await mkdir(path.dirname(targetPath), { recursive: true });
    handle = await open(temporaryPath, 'wx', mode);
    ownsTemporaryPath = true;
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.close();
    handle = undefined;
    await commit(temporaryPath);
  } catch (error) {
    const cleanupFailures: string[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupFailures.push(`close: ${errorMessage(closeError)}`);
      }
    }
    if (ownsTemporaryPath) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          cleanupFailures.push(`unlink: ${errorMessage(cleanupError)}`);
        }
      }
    }
    const detail = cleanupFailures.length
      ? ` Temporary-file cleanup also failed: ${cleanupFailures.join('; ')}`
      : '';
    throw new Error(`${errorMessage(error)}${detail}`, { cause: error });
  }
}
