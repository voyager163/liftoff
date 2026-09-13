import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultExclude } from 'vitest/config';
import config, { createRootTestConfig } from '../vitest.config.js';

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

  it('partitions Windows discovery into disjoint ordered groups without dropping the migration file', () => {
    const windows = createRootTestConfig('win32');
    const projects = windows.test.projects;
    expect(projects).toHaveLength(2);
    if (!projects) throw new Error('Expected both Windows test projects.');

    expect(projects[0]).toMatchObject({
      extends: false,
      test: {
        name: 'root-tests',
        include: ['tests/**/*.test.ts'],
        exclude: [...defaultExclude, 'tests/migration-inspection.test.ts'],
        sequence: { groupOrder: 0 }
      }
    });
    expect(projects[1]).toMatchObject({
      extends: false,
      test: {
        name: 'migration-inspection',
        include: ['tests/migration-inspection.test.ts'],
        sequence: { groupOrder: 1 }
      }
    });
    expect(projects[1].test).not.toHaveProperty('exclude');
  });

  it('retains the worker cap and test semantics in both Windows groups', () => {
    const windows = createRootTestConfig('win32');
    expect(windows.test.maxWorkers).toBe(2);
    for (const project of windows.test.projects ?? []) {
      expect(project.test).toMatchObject({
        environment: 'node',
        restoreMocks: true,
        maxWorkers: 2,
        testTimeout: 30_000
      });
      expect(project.test).not.toHaveProperty('fileParallelism', false);
      expect(project.test).not.toHaveProperty('isolate', false);
      expect(project.test).not.toHaveProperty('testNamePattern');
      expect(project.test).not.toHaveProperty('setupFiles');
      expect(project.test).not.toHaveProperty('globalSetup');
    }
  });

  it.each(['darwin', 'linux'] as const)('leaves the %s runner configuration unchanged', (platform) => {
    expect(createRootTestConfig(platform).test).toEqual({
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      restoreMocks: true,
      maxWorkers: undefined,
      testTimeout: 30_000
    });
  });

  it('keeps migration fixture construction inside its original 90-second cases', async () => {
    const source = await readFile(new URL('./migration-inspection.test.ts', import.meta.url), 'utf8');
    expect(source).toContain('timeout: 90_000');
    expect(source).toContain('const fixture = await linkedFixture(status);');
    expect(source).not.toMatch(/\b(?:beforeAll|beforeEach)\b/);
  });
});
