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

  async function visit(parts: string[]): Promise<void> {
    assertBudget();
    if (parts.length > limits.maxDepth) throw new Error('Retained project source exceeds its directory-depth limit.');
    const entries = await snapshot.list(parts, remainingEntries, withinBudget);
    remainingEntries -= entries.length;
    for (const entry of entries) {
      assertBudget();
      const child = [...parts, entry.name];
      if (!includePath(child)) continue;
      if (entry.kind === 'directory') {
        await visit(child);
      } else if (entry.kind === 'file') {
        if (result.length >= limits.maxFiles) throw new Error('Retained project source exceeds its file-count limit.');
        const { content, metadata } = await snapshot.read(child, Math.min(limits.maxFileSize, remainingBytes));
        try {
          assertBudget();
          remainingBytes -= content.length;
          result.push({
            pathParts: child,
            digest: createHash('sha256').update(content).digest('hex'),
            mode: metadata.mode & 0o7777
          });
        } finally {
          content.fill(0);
        }
      } else {
        throw new Error(`Protected update source ${child.join('/')} must not be a link or special file.`);
      }
    }
  }

  await visit([]);
  await snapshot.assertCurrent(withinBudget);
  assertBudget();
  return result.sort((left, right) => left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en'));
}
