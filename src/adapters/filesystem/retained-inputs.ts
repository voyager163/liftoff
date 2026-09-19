import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AssessmentSnapshot } from './standards-assessment/snapshot.js';
import { boundedSourceObservationLimits, type SourceObservationLimits } from './source-observation-limits.js';

export interface RetainedInputFile {
  pathParts: string[];
  digest: string;
  mode: number;
}

export async function captureRetainedInputTree(
  projectRoot: string,
  includePath: (parts: readonly string[]) => boolean,
  overrides: Partial<SourceObservationLimits> = {}
): Promise<RetainedInputFile[]> {
  const limits = boundedSourceObservationLimits(overrides);
  const started = performance.now();
  const withinBudget = () => performance.now() - started < limits.scanTimeoutMs;
  const assertBudget = () => {
    if (!withinBudget()) throw new Error('Retained project source observation exceeded its time budget; no partial input binding was accepted.');
  };
  assertBudget();
  const snapshot = await AssessmentSnapshot.create(projectRoot);
  const result: RetainedInputFile[] = [];
  let remainingEntries = limits.maxEntries;
  let remainingBytes = limits.maxScanBytes;
  let files = 0;
  let failed = false;
  let failure: unknown;
  const reads = new Set<Promise<void>>();
  const recordFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    failure = code === 'ENOENT' || code === 'ENOTDIR'
      ? new Error('Retained project source changed or disappeared during guarded capture.', { cause: error })
      : error;
  };
  const assertCurrentWork = () => {
    if (failed) throw failure;
    assertBudget();
  };

  async function queueRead(child: string[]): Promise<void> {
    // Pin each file before advancing traversal; concurrent reads retain every path/handle/final snapshot check.
    const pinned = await snapshot.inspect(child);
    if (!pinned?.isFile() || pinned.isSymbolicLink() ||
        !Number.isSafeInteger(pinned.size) || pinned.size < 0 ||
        pinned.size > Math.min(limits.maxFileSize, remainingBytes)) {
      throw new Error('Retained project source exceeds its bounded read limit or changed file type.');
    }
    remainingBytes -= pinned.size;
    const task: Promise<void> = (async () => {
      try {
        assertCurrentWork();
        const { content, metadata } = await snapshot.read(child, pinned.size, pinned);
        try {
          assertCurrentWork();
          result.push({
            pathParts: child,
            digest: createHash('sha256').update(content).digest('hex'),
            mode: metadata.mode & 0o7777
          });
        } finally {
          content.fill(0);
        }
      } catch (error) {
        recordFailure(error);
      }
    })().finally(() => { reads.delete(task); });
    reads.add(task);
    if (reads.size >= 3) {
      await Promise.race(reads);
      assertCurrentWork();
    }
  }

  async function visit(parts: string[]): Promise<void> {
    assertCurrentWork();
    if (parts.length > limits.maxDepth) throw new Error('Retained project source exceeds its directory-depth limit.');
    const entries = await snapshot.list(parts, remainingEntries, withinBudget);
    remainingEntries -= entries.length;
    for (const entry of entries) {
      assertCurrentWork();
      const child = [...parts, entry.name];
      if (!includePath(child)) continue;
      if (entry.kind === 'directory') {
        await visit(child);
      } else if (entry.kind === 'file') {
        if (files++ >= limits.maxFiles) throw new Error('Retained project source exceeds its file-count limit.');
        await queueRead(child);
      } else {
        throw new Error(`Protected update source ${child.join('/')} must not be a link or special file.`);
      }
    }
  }

  try {
    await visit([]);
  } catch (error) {
    recordFailure(error);
  }
  await Promise.all(reads);
  if (failed) throw failure;
  await snapshot.assertCurrent(withinBudget);
  assertBudget();
  return result.sort((left, right) => left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en'));
}
