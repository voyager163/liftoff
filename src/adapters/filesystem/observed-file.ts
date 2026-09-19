import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export type ObservedFileFailure = 'unsafe-file' | 'size-limit' | 'changed-file';

export class ObservedFileError extends Error {
  constructor(message: string, readonly failure: ObservedFileFailure) {
    super(message);
    this.name = 'ObservedFileError';
  }
}

export function observedFileStamp(details: Stats): string {
  return [
    details.dev, details.ino, details.mode, details.nlink,
    details.size, details.mtimeMs, details.ctimeMs
  ].join(':');
}

export interface ObservedFileReadOptions {
  maximumBytes: number;
  expected?: Stats;
  assertPathCurrent(): Promise<string>;
}

export async function readObservedFile(
  filename: string,
  options: ObservedFileReadOptions
): Promise<{ content: Buffer; metadata: Stats }> {
  if (!path.isAbsolute(filename) || !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 0 || options.maximumBytes > 64 * 1024 * 1024) {
    throw new ObservedFileError('Invalid bounded file read request.', 'unsafe-file');
  }
  const assertPath = async () => {
    if (await options.assertPathCurrent() !== filename) {
      throw new ObservedFileError('File path changed during inspection.', 'changed-file');
    }
  };
  await assertPath();
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7000) !== 0) {
    throw new ObservedFileError('Only singly linked regular files with ordinary modes can be inspected.', 'unsafe-file');
  }
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > options.maximumBytes) {
    throw new ObservedFileError('File size exceeds the bounded read limit.', 'size-limit');
  }
  if (options.expected && observedFileStamp(options.expected) !== observedFileStamp(before)) {
    throw new ObservedFileError('File changed before inspection.', 'changed-file');
  }
  const original = observedFileStamp(before);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || observedFileStamp(opened) !== original) {
      throw new ObservedFileError('File changed while opening for inspection.', 'changed-file');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    const after = await handle.stat();
    await assertPath();
    const current = await lstat(filename);
    if (bytes !== before.size || observedFileStamp(after) !== original ||
        observedFileStamp(current) !== original || !current.isFile()) {
      throw new ObservedFileError('File changed during inspection.', 'changed-file');
    }
    return { content: Buffer.from(buffer.subarray(0, bytes)), metadata: before };
  } finally {
    await handle.close();
  }
}
