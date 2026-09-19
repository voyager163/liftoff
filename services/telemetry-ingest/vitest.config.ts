import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../..');

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['services/telemetry-ingest/tests/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      all: true,
      reportOnFailure: true,
      allowExternal: true,
      include: [
        'services/telemetry-ingest/src/**/*.{ts,js}',
        'src/telemetry/contract.ts'
      ],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: path.join(dir, 'coverage')
    }
  }
});
