import { defaultExclude, defineConfig, type ViteUserConfig } from 'vitest/config';

const migrationInspectionFile = 'tests/migration-inspection.test.ts';

export const sharedTestExcludes = [
  ...defaultExclude,
  'tests/.**/*',
  'tests/**/.*/**',
  'tests/fixtures/**'
];

export function createRootTestConfig(platform: NodeJS.Platform) {
  const test = {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: sharedTestExcludes,
    restoreMocks: true,
    // Bound concurrent filesystem-heavy migration and evidence checks on Windows.
    maxWorkers: platform === 'win32' ? 2 : undefined,
    testTimeout: 30_000
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
              exclude: [...sharedTestExcludes, migrationInspectionFile],
              sequence: { groupOrder: 0 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'migration-inspection',
              include: [migrationInspectionFile],
              exclude: sharedTestExcludes,
              // Keep real revalidation inside its timed cases, without competing native builds.
              sequence: { groupOrder: 1 }
            }
          }
        ]
      } : {})
    }
  } satisfies ViteUserConfig;
}

const rootConfig = createRootTestConfig(process.platform);

export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    coverage: {
      provider: 'v8',
      all: true,
      reportOnFailure: true,
      include: [
        'src/**/*.{ts,js}',
        'assets/governance/single-maintainer-gitflow/activation-v3-reader/**/*.js',
        'assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/**/*.js',
        'scripts/distribution/**/*.mjs',
        'scripts/capture-activation-v3-baseline.mjs'
      ],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage'
    }
  }
});