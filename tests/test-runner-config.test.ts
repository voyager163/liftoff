import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultExclude } from 'vitest/config';
import config, { createRootConfig, createRootTestConfig } from '../vitest.config.js';

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
    expect(projects).toHaveLength(5);
    if (!projects) throw new Error('Expected all Windows test projects.');

    expect(projects[0]).toMatchObject({
      extends: false,
      test: {
        name: 'root-tests',
        include: ['tests/**/*.test.ts'],
        exclude: [...defaultExclude, 'tests/migration-inspection.test.ts', 'tests/installed-tool-distribution.test.ts',
          'tests/repair-preparation-execution.test.ts', 'tests/repair-cancellation.test.ts'],
        sequence: { groupOrder: 0 }
      }
    });
    expect(projects[1]).toMatchObject({
      extends: false,
      test: {
        name: 'repair-cancellation',
        include: ['tests/repair-cancellation.test.ts'],
        sequence: { groupOrder: 1 }
      }
    });
    expect(projects[2]).toMatchObject({
      extends: false,
      test: {
        name: 'repair-preparation-execution',
        include: ['tests/repair-preparation-execution.test.ts'],
        sequence: { groupOrder: 2 }
      }
    });
    expect(projects[3]).toMatchObject({
      extends: false,
      test: {
        name: 'installed-tool-distribution',
        include: ['tests/installed-tool-distribution.test.ts'],
        sequence: { groupOrder: 3 }
      }
    });
    expect(projects[4]).toMatchObject({
      extends: false,
      test: {
        name: 'migration-inspection',
        include: ['tests/migration-inspection.test.ts'],
        sequence: { groupOrder: 4 }
      }
    });
    for (const project of projects.slice(1)) expect(project.test).not.toHaveProperty('exclude');
  });

  it('retains the worker cap and test semantics in all Windows groups', () => {
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

  it.each(['darwin', 'linux'] as const)('leaves the %s runner scheduling and discovery unchanged', (platform) => {
    const { execArgv, ...test } = createRootTestConfig(platform).test;
    expect(test).toEqual({
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      restoreMocks: true,
      maxWorkers: undefined,
      testTimeout: 30_000
    });
    expect(execArgv).toEqual(
      platform === 'darwin' && process.arch === 'arm64' && process.versions.node.startsWith('24.')
        ? ['--no-sparkplug']
        : undefined
    );
  });

  it.each([
    { platform: 'darwin', architecture: 'arm64', version: '24.20.0', affected: true },
    { platform: 'darwin', architecture: 'arm64', version: '24.21.0', affected: true },
    { platform: 'darwin', architecture: 'x64', version: '24.21.0', affected: false },
    { platform: 'linux', architecture: 'arm64', version: '24.21.0', affected: false },
    { platform: 'win32', architecture: 'arm64', version: '24.21.0', affected: false },
    { platform: 'darwin', architecture: 'arm64', version: '22.0.0', affected: false },
    { platform: 'darwin', architecture: 'arm64', version: '25.0.0', affected: false },
    { platform: 'darwin', architecture: 'arm64', version: '26.0.0', affected: false }
  ] as const)('scopes the worker workaround to $platform/$architecture Node $version', ({
    platform, architecture, version, affected
  }) => {
    for (const current of [
      createRootTestConfig(platform, version, architecture),
      createRootConfig(platform, version, architecture)
    ]) {
      if (affected) expect(current.test.execArgv).toEqual(['--no-sparkplug']);
      else expect(current.test).not.toHaveProperty('execArgv');
    }
  });

  it('passes the workaround directly to affected test workers, not through NODE_OPTIONS', () => {
    const affected = process.platform === 'darwin' && process.arch === 'arm64'
      && process.versions.node.startsWith('24.');
    expect(process.execArgv.includes('--no-sparkplug')).toBe(affected);
    expect(process.env.NODE_OPTIONS ?? '').not.toContain('--no-sparkplug');
  });

  it('keeps migration fixture construction inside its original 90-second cases', async () => {
    const source = await readFile(new URL('./migration-inspection.test.ts', import.meta.url), 'utf8');
    expect(source).toContain('timeout: 90_000');
    expect(source).toContain('const fixture = await linkedFixture(status);');
    expect(source).not.toMatch(/\b(?:beforeAll|beforeEach)\b/);
  });
});
