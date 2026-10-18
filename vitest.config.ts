import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig, type ViteUserConfig } from 'vitest/config';
import { isolateProcessUserState } from './tests/setup/user-state-isolation.js';
import { coveragePackage, publishedRuntimeSources } from './scripts/coverage-gate.mjs';

const migrationInspectionFile = 'tests/migration-inspection.test.ts';
const distributionInspectionFile = 'tests/installed-tool-distribution.test.ts';
const preparationExecutionFile = 'tests/repair-preparation-execution.test.ts';
const adoptionVerificationFile = 'tests/adoption-verification-execution.test.ts';
const cancellationFile = 'tests/repair-cancellation.test.ts';
const workflowMatrixFile = 'tests/governance-workflow-source5-matrix.test.ts';
const workflowFinalizationFile = 'tests/governance-workflow-source5-finalization.test.ts';
const successorUpdateFile = 'tests/activation-successor-update.test.ts';

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
// build input and published raw runtime module is present, even if unimported.
export const cliCoverage = {
  provider: 'v8',
  enabled: false,
  include: ['src/**/*.ts', ...publishedRuntimeSources(coveragePackage('cli'))],
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
  const ordered = [
    ...(platform === 'win32' ? [
      { name: 'repair-cancellation', file: cancellationFile },
      { name: 'repair-preparation-execution', file: preparationExecutionFile },
      { name: 'installed-tool-distribution', file: distributionInspectionFile },
      { name: 'migration-inspection', file: migrationInspectionFile },
      { name: 'adoption-verification-execution', file: adoptionVerificationFile }
    ] : []),
    { name: 'workflow-source5-matrix', file: workflowMatrixFile },
    { name: 'workflow-source5-finalization', file: workflowFinalizationFile },
    { name: 'activation-successor-update', file: successorUpdateFile }
  ];

  return {
    test: {
      ...test,
      projects: [
        {
          extends: false,
          test: {
            ...test,
            name: 'root-tests',
            include: [...test.include],
            exclude: [...defaultExclude, ...ordered.map(({ file }) => file)],
            sequence: { groupOrder: 0 }
          }
        },
        ...ordered.map(({ name, file }, index) => ({
          extends: false as const,
          test: { ...test, name, include: [file], sequence: { groupOrder: index + 1 } }
        }))
      ]
    }
  } satisfies ViteUserConfig;
}

// Global setup stays at the root; individual projects must not repeat it.
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