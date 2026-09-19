export const sourceObservationLimitKeys = [
  'maxFiles', 'maxFileSize', 'maxDepth', 'maxScanBytes', 'scanTimeoutMs', 'maxEntries'
] as const;

export type SourceObservationLimits = Record<(typeof sourceObservationLimitKeys)[number], number>;

// Whole-project observation limits are separate from released application-preparation limits.
export const sourceObservationLimits: Readonly<SourceObservationLimits> = Object.freeze({
  maxFiles: 5000,
  maxFileSize: 2 * 1024 * 1024,
  maxDepth: 15,
  maxScanBytes: 50 * 1024 * 1024,
  scanTimeoutMs: 15_000,
  maxEntries: 10_000
});

export function boundedSourceObservationLimits(
  overrides: Partial<SourceObservationLimits> = {}
): Readonly<SourceObservationLimits> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Retained-source observation limits require an object.');
  }
  if (Object.keys(overrides).some((key) => !sourceObservationLimitKeys.some((allowed) => allowed === key))) {
    throw new Error('Unknown retained-source observation limit.');
  }
  const limits = { ...sourceObservationLimits, ...overrides };
  for (const key of sourceObservationLimitKeys) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > sourceObservationLimits[key]) {
      throw new Error(`${key} must be an integer between 0 and ${sourceObservationLimits[key]}; retained-source limits cannot be widened.`);
    }
  }
  return Object.freeze(limits);
}
