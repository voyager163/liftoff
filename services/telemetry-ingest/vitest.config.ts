import { defineConfig, type ViteUserConfig } from 'vitest/config';

type CoverageConfig = NonNullable<NonNullable<ViteUserConfig['test']>['coverage']>;

// Each metric must be strictly greater than 80%; 80.01 is the configured floor.
export const coverageFloorPercent = 80.01;

// Disabled for ordinary runs. `npm run coverage:gateway` (repository root)
// enables it through scripts/coverage-gate.mjs. The gateway build compiles the
// shared telemetry contract from outside this package (tsconfig include), so
// that file is measured here as gateway source as well.
export const gatewayCoverage = {
  provider: 'v8',
  enabled: false,
  allowExternal: true,
  include: ['src/**/*.ts', '**/src/telemetry/contract.ts'],
  exclude: [],
  reportsDirectory: '../../coverage/gateway',
  reporter: ['text-summary', ['text', { file: 'coverage.txt' }], 'json-summary', 'json'],
  clean: true,
  reportOnFailure: false,
  thresholds: {
    statements: coverageFloorPercent,
    branches: coverageFloorPercent,
    functions: coverageFloorPercent,
    lines: coverageFloorPercent
  }
} satisfies CoverageConfig;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: gatewayCoverage
  }
});
