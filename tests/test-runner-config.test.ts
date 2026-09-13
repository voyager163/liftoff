import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

describe('root test runner configuration', () => {
  it('bounds Windows workers without serializing files or changing other platforms', () => {
    expect(config.test?.maxWorkers).toBe(process.platform === 'win32' ? 2 : undefined);
    expect(config.test?.fileParallelism).not.toBe(false);
    expect(config.test?.isolate).not.toBe(false);
  });

  it('preserves complete discovery, mock restoration, and the default timeout', () => {
    expect(config.test?.environment).toBe('node');
    expect(config.test?.include).toEqual(['tests/**/*.test.ts']);
    expect(config.test?.exclude).toBeUndefined();
    expect(config.test?.testNamePattern).toBeUndefined();
    expect(config.test?.restoreMocks).toBe(true);
    expect(config.test?.testTimeout).toBe(30_000);
  });
});
