import { defaultExclude, defineConfig, type ViteUserConfig } from 'vitest/config';

const migrationInspectionFile = 'tests/migration-inspection.test.ts';

export function createRootTestConfig(platform: NodeJS.Platform) {
  const test = {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
              exclude: [...defaultExclude, migrationInspectionFile],
              sequence: { groupOrder: 0 }
            }
          },
          {
            extends: false,
            test: {
              ...test,
              name: 'migration-inspection',
              include: [migrationInspectionFile],
              // Keep real revalidation inside its timed cases, without competing native builds.
              sequence: { groupOrder: 1 }
            }
          }
        ]
      } : {})
    }
  } satisfies ViteUserConfig;
}

export default defineConfig(createRootTestConfig(process.platform));