import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureQualifiedOpenSpecProfile,
  createNativeCustodyQualificationEvidence,
  nativeContainerToolProfile,
  nativeCustodyQualificationCommands,
  qualifiedOpenSpecProfile,
  verifyQualifiedOpenSpecProfile
} from '../scripts/native-custody-qualification.mjs';

const revision = '8'.repeat(40);
const fixtures: string[] = [];
const outcomeEnvironment = {
  NATIVE_TOOLCHAIN_OUTCOME: 'success',
  NATIVE_CLEAN_START_OUTCOME: 'success',
  NATIVE_SUPPORTED_STACK_OUTCOME: 'success',
  NATIVE_BUILD_OUTCOME: 'success',
  NATIVE_FULL_SUITE_OUTCOME: 'success',
  NATIVE_COVERAGE_OUTCOME: 'success',
  NATIVE_COVERAGE_VERIFY_OUTCOME: 'success',
  NATIVE_FOCUSED_OUTCOME: 'success',
  NATIVE_PACKAGE_OUTCOME: 'success',
  NATIVE_POLICY_OUTCOME: 'success',
  NATIVE_OPENSPEC_OUTCOME: 'success',
  NATIVE_CLEAN_FINISH_OUTCOME: 'success',
  NATIVE_COMPOSE_EXECUTABLE: '/qualified/docker-compose'
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function coverageEvidence() {
  return {
    schemaVersion: 1,
    kind: 'liftoff-coverage-evidence',
    qualifying: true,
    result: 'passed',
    failures: [],
    metrics: {
      statements: { covered: 81, total: 100, percent: '81.0000', passed: true },
      branches: { covered: 81, total: 100, percent: '81.0000', passed: true },
      functions: { covered: 81, total: 100, percent: '81.0000', passed: true },
      lines: { covered: 81, total: 100, percent: '81.0000', passed: true }
    },
    revision: { commit: revision, dirty: false, changedPaths: [] },
    sourceInventory: { fileCount: 506, digest: `sha256:${'a'.repeat(64)}`, files: [] },
    testInventory: { fileCount: 309, digest: `sha256:${'b'.repeat(64)}`, testFiles: [] },
    tools: { node: 'v24.21.0', npm: '12.0.2' },
    invocation: { host: { platform: 'darwin', arch: 'arm64' } },
    tests: { passed: 10_000, failed: 0, skipped: 100, todo: 0, files: 309 }
  };
}

function execute(executable: string, args: string[] = []): string {
  if (executable.endsWith('docker-compose')) return nativeContainerToolProfile.compose.version;
  if (executable === 'docker') {
    return `Docker version ${nativeContainerToolProfile.docker.version}, build ${nativeContainerToolProfile.docker.build}`;
  }
  return {
    npm: '12.0.2',
    tofu: 'OpenTofu v1.12.6\non darwin_arm64',
    openspec: '1.11.0',
    go: 'go version go1.27.0 darwin/arm64',
    python: 'Python 3.14.7',
    uv: 'uv 0.12.7 (fixture)'
  }[executable]!;
}

function reader(evidence = coverageEvidence()) {
  return async (file: string): Promise<string> => {
    if (file.endsWith('coverage-evidence.json')) return `${JSON.stringify(evidence, null, 2)}\n`;
    if (file.endsWith('native-full-suite.log')) return 'full suite passed\n';
    if (file.endsWith('native-coverage.log')) return 'coverage passed\n';
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  };
}

describe('hosted native custody qualification evidence', () => {
  it('binds a complete stable OpenSpec package profile and rejects changed bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-openspec-profile-'));
    fixtures.push(root);
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@fission-ai/openspec',
      version: '1.11.0'
    }));
    await writeFile(path.join(root, 'bin', 'openspec.js'), '#!/usr/bin/env node\n');
    const captured = await captureQualifiedOpenSpecProfile(root, {
      ...qualifiedOpenSpecProfile,
      counts: { files: 2, directories: 2, symlinks: 0, totalBytes: 1000 }
    });
    const expected = {
      ...captured,
      registryCutoff: 'fixture'
    };
    expect(await verifyQualifiedOpenSpecProfile(root, expected)).toEqual(expected);
    await writeFile(path.join(root, 'bin', 'openspec.js'), '#!/usr/bin/env nodE\n');
    await expect(verifyQualifiedOpenSpecProfile(root, expected))
      .rejects.toThrow('Qualified OpenSpec distribution content profile mismatch.');
  });

  it('binds passing native gates, raw metrics, inventories, logs, and tool versions', async () => {
    const evidence = await createNativeCustodyQualificationEvidence({
      env: {
        ...outcomeEnvironment,
        GITHUB_SHA: revision,
        GITHUB_REPOSITORY: 'voyager163/liftoff',
        GITHUB_REF: 'refs/heads/voyager163-liftoff-modernization',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKFLOW: 'Hosted native custody qualification'
      },
      runtime: { platform: 'darwin', architecture: 'arm64', node: '24.21.0' },
      execute,
      readText: reader(),
      verify: async () => ({ result: 'passed', failures: [], metrics: coverageEvidence().metrics }),
      verifyOpenSpecProfile: async () => qualifiedOpenSpecProfile,
      generatedAt: () => '2026-10-13T00:00:00.000Z'
    });
    expect(evidence.result).toBe('passed');
    expect(evidence.failures).toEqual([]);
    expect(evidence.revision).toEqual({
      commit: revision,
      ref: 'refs/heads/voyager163-liftoff-modernization',
      clean: true
    });
    expect(evidence.coverage?.sourceInventory.fileCount).toBe(506);
    expect(evidence.coverage?.metrics.branches.covered).toBe(81);
    expect(evidence.logs.fullSuite?.bytes).toBeGreaterThan(0);
    expect(evidence.tools).toMatchObject({
      npm: '12.0.2',
      openspec: '1.11.0',
      go: 'go version go1.27.0 darwin/arm64',
      docker: 'Docker version 29.8.2, build 7fc2dff',
      compose: '5.5.1',
      composeExecutable: '/qualified/docker-compose',
      containerProfile: nativeContainerToolProfile,
      openspecDistribution: qualifiedOpenSpecProfile
    });
    expect(evidence.commands).toEqual(nativeCustodyQualificationCommands);
    expect(evidence.claims).toEqual({
      hostedNativeMacosArm64: true,
      macbookRetroactiveQualification: false,
      productionCustodyQualification: false,
      disposableAzureQualification: false
    });
  });

  it('fails closed on a failed gate, wrong host, stale revision, or metric at 80 percent', async () => {
    const coverage = coverageEvidence();
    coverage.metrics.branches = { covered: 80, total: 100, percent: '80.0000', passed: false };
    coverage.revision.commit = '7'.repeat(40);
    const evidence = await createNativeCustodyQualificationEvidence({
      env: {
        ...outcomeEnvironment,
        NATIVE_FULL_SUITE_OUTCOME: 'failure',
        NATIVE_COMPOSE_EXECUTABLE: 'docker-compose',
        GITHUB_SHA: revision
      },
      runtime: { platform: 'darwin', architecture: 'x64', node: '24.21.0' },
      execute,
      readText: reader(coverage),
      verify: async () => ({ result: 'failed', failures: ['stale'], metrics: coverage.metrics }),
      verifyOpenSpecProfile: async () => qualifiedOpenSpecProfile
    });
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toEqual(expect.arrayContaining([
      'fullSuite gate outcome was failure, not success.',
      expect.stringContaining('expected darwin/arm64'),
      'NATIVE_COMPOSE_EXECUTABLE is not an absolute path: "docker-compose".',
      'Coverage evidence is not bound to the exact clean dispatched revision.',
      'Coverage metric branches is not strictly above 80%.',
      'Independent coverage verification failed: stale'
    ]));
    expect(evidence.claims.hostedNativeMacosArm64).toBe(false);
  });
});
