import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    // Bound concurrent filesystem-heavy migration and evidence checks on Windows.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    testTimeout: 30_000
  }
});