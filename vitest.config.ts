import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig, type ViteUserConfig } from 'vitest/config';
import { isolateProcessUserState } from './tests/setup/user-state-isolation.js';

const migrationInspectionFile = 'tests/migration-inspection.test.ts';
const distributionInspectionFile = 'tests/installed-tool-distribution.test.ts';
const preparationExecutionFile = 'tests/repair-preparation-execution.test.ts';
const cancellationFile = 'tests/repair-cancellation.test.ts';

// Every root Vitest invocation (npm test, targeted runs and the coverage gate)
// uses a temporary HOME/XDG/profile root. The main process isolates while this
// config is evaluated, before Vitest writes its own user-data token; the global
// setup tears it down. Test workers that import this file only read it.
export const userStateIsolationSetup = fileURLToPath(new URL('./tests/setup/user-state-isolation.ts', import.meta.url));
if (process.env.VITEST_WORKER_ID === undefined) isolateProcessUserState();

type CoverageConfig = NonNullable<NonNullable<ViteUserConfig['test']>['coverage']>;

// Each metric must be strictly greater than 80%; 80.01 is the configured floor.
export const coverageFloorPercent = 80.01;

// Disabled for ordinary runs. `npm run coverage:cli` enables it through
// scripts/coverage-gate.mjs, which also proves that every file matched by the
// tsconfig build input is present, including files that no test imports.
export const cliCoverage = {
  provider: 'v8',
  enabled: false,
  include: ['src/**/*.ts'],
  exclude: [],
  reportsDirectory: './coverage/cli',
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

export function createRootTestConfig(
  platform: NodeJS.Platform,
  nodeVersion = process.versions.node,
  architecture = process.arch
) {
  const test = {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    // Bound concurrent filesystem-heavy migration and evidence checks on Windows.
    maxWorkers: platform === 'win32' ? 2 : undefined,
    testTimeout: 30_000,
    // Avoid the Node 24 ARM64 Sparkplug/GC crash in test workers (nodejs/node#62393).
    ...(platform === 'darwin' && architecture === 'arm64' && nodeVersion.startsWith('24.')
      ? { execArgv: ['--no-sparkplug'] }
      : {})
  };

  return {
    test: {
      ...test,
      ...(platform === 'win32' ? {
        projects: [
          {
            extends: false,
            test: {
              ...test,
              name: 'root-tests',
              include: [...test.include],
              exclude: [...defaultExclude, migrationInspectionFile, distributionInspectionFile, preparationExecutionFile, cancellationFile],
              sequence: { groupOrder: 0 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'repair-cancellation',
              include: [cancellationFile],
              // Keep cancellation and exact receipt reuse inside the unchanged 30s cases.
              sequence: { groupOrder: 1 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'repair-preparation-execution',
              include: [preparationExecutionFile],
              sequence: { groupOrder: 2 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'installed-tool-distribution',
              include: [distributionInspectionFile],
              // Exercise the full 8192-file scan inside its unchanged 30s deadline.
              sequence: { groupOrder: 3 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'migration-inspection',
              include: [migrationInspectionFile],
              // Keep real revalidation inside its timed cases, without competing native builds.
              sequence: { groupOrder: 4 }
            }
          }
        ]
      } : {})
    }
  } satisfies ViteUserConfig;
}

// Global setup stays at the root: Windows projects must not repeat it.
export function createRootConfig(
  platform: NodeJS.Platform,
  nodeVersion = process.versions.node,
  architecture = process.arch
) {
  const config = createRootTestConfig(platform, nodeVersion, architecture);
  return {
    ...config,
    test: { ...config.test, globalSetup: [userStateIsolationSetup], coverage: cliCoverage }
  } satisfies ViteUserConfig;
}

export default defineConfig(createRootConfig(process.platform));