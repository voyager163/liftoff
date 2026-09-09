import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_NPM_REGISTRY,
  verifyPublishedPackage,
  type PublishedVerifierDependencies
} from '../src/published-verifier.js';

interface HarnessOptions {
  packageVersion?: string;
  observedVersion?: string;
  registryUnavailable?: boolean;
  installedVersion?: string;
  failedCommand?: 'help' | 'upgrade-help' | 'version' | 'plan';
}

function verifierHarness(options: HarnessOptions = {}): {
  dependencies: PublishedVerifierDependencies;
  state: {
    npmCalls: string[][];
    npmOptions: Array<{ cwd: string; env: NodeJS.ProcessEnv }>;
    nodeCalls: string[][];
    time: number;
    tempRoot?: string;
    removed: boolean;
  };
} {
  const state = {
    npmCalls: [] as string[][],
    npmOptions: [] as Array<{ cwd: string; env: NodeJS.ProcessEnv }>,
    nodeCalls: [] as string[][],
    time: 0,
    tempRoot: undefined as string | undefined,
    removed: false
  };
  const dependencies: PublishedVerifierDependencies = {
    runNpm(args, commandOptions) {
      state.npmCalls.push(args);
      state.npmOptions.push(commandOptions);
      if (args[0] === 'view') {
        return options.registryUnavailable
          ? { status: 1, stdout: '', stderr: 'registry unavailable' }
          : { status: 0, stdout: `${options.observedVersion ?? '0.3.3'}\n`, stderr: '' };
      }
      return { status: 0, stdout: 'installed', stderr: '' };
    },
    runNode(args) {
      state.nodeCalls.push(args);
      const command = args[1] === 'help'
        ? 'help'
        : args[1] === 'upgrade'
          ? 'upgrade-help'
          : args[1] === '--version'
            ? 'version'
            : 'plan';
      if (options.failedCommand === command) {
        return { status: 1, stdout: '', stderr: `${command} failed` };
      }
      if (command === 'help') {
        return { status: 0, stdout: 'Mission Control Liftoff 0.3.3\n', stderr: '' };
      }
      if (command === 'upgrade-help') {
        return {
          status: 0,
          stdout: 'Replace the supported global npm Liftoff CLI\n--check\n',
          stderr: ''
        };
      }
      if (command === 'version') {
        return { status: 0, stdout: 'Liftoff 0.3.3\n', stderr: '' };
      }
      return { status: 0, stdout: 'Project type: Standard application\n', stderr: '' };
    },
    now: () => state.time,
    wait: async (milliseconds) => { state.time += milliseconds; },
    readJson: async (filePath) => filePath === path.join(process.cwd(), 'package.json')
      ? { name: '@msn-control/liftoff', version: options.packageVersion ?? '0.3.3' }
      : {
          name: '@msn-control/liftoff',
          version: options.installedVersion ?? options.packageVersion ?? '0.3.3'
        },
    makeTempRoot: async () => {
      state.tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-verifier-test-'));
      return state.tempRoot;
    },
    makeDirectory: async (directory) => { await mkdir(directory, { recursive: true }); },
    removeTempRoot: async (directory) => {
      await rm(directory, { recursive: true, force: true });
      state.removed = true;
    },
    platform: 'linux',
    environment: {
      HOME: '/private/original-home',
      USERPROFILE: 'C:\\private\\original-home',
      npm_config_cache: '/private/original-cache',
      npm_config_registry: 'https://mirror.example.test/npm/',
      npm_config_userconfig: '/private/original-user.npmrc',
      npm_config_globalconfig: '/private/original-global.npmrc'
    }
  };
  return { dependencies, state };
}

describe('published package verifier', () => {
  it('verifies the canonical dist-tag, installed version, and representative commands', async () => {
    const { dependencies, state } = verifierHarness();
    const result = await verifyPublishedPackage({ packageRoot: process.cwd(), tag: 'latest' }, dependencies);

    expect(result).toEqual({
      name: '@msn-control/liftoff',
      version: '0.3.3',
      tag: 'latest',
      registry: CANONICAL_NPM_REGISTRY,
      legacyVersionCommandAllowed: false
    });
    expect(state.npmCalls).toHaveLength(2);
    expect(state.npmCalls.every((args) => args.includes(`--registry=${CANONICAL_NPM_REGISTRY}`))).toBe(true);
    expect(state.npmCalls.every((args) =>
      args.includes(`--@msn-control:registry=${CANONICAL_NPM_REGISTRY}`)
    )).toBe(true);
    expect(state.npmCalls.find((args) => args[0] === 'install')).toContain('@msn-control/liftoff@0.3.3');
    expect(state.nodeCalls.map((args) => args[1])).toEqual([
      'help',
      'upgrade',
      '--version',
      'plan'
    ]);
    for (const options of state.npmOptions) {
      expect(options.cwd).toContain('outside');
      expect(options.env).toMatchObject({
        npm_config_registry: CANONICAL_NPM_REGISTRY
      });
      expect(options.env.npm_config_userconfig).not.toContain('/private/');
      expect(options.env.npm_config_globalconfig).not.toContain('/private/');
    }
    expect(state.removed).toBe(true);
    expect(state.tempRoot && existsSync(state.tempRoot)).toBe(false);
  });

  it('supports explicit non-publishing compatibility for immutable 0.3.3', async () => {
    const { dependencies, state } = verifierHarness();
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest',
      allowLegacyVersionCommand: true
    }, dependencies);

    expect(result.legacyVersionCommandAllowed).toBe(true);
    expect(state.nodeCalls.map((args) => args[1])).toEqual([
      'help',
      'plan'
    ]);
  });

  it('rejects legacy version-command compatibility for every other release', async () => {
    const { dependencies, state } = verifierHarness({
      packageVersion: '0.3.4',
      observedVersion: '0.3.4'
    });
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest',
      allowLegacyVersionCommand: true
    }, dependencies)).rejects.toThrow(
      'Legacy version-command compatibility is allowed only for immutable @msn-control/liftoff@0.3.3.'
    );
    expect(state.npmCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

  it('requires the current version command for a modern release', async () => {
    const { dependencies, state } = verifierHarness({
      packageVersion: '0.10.4',
      observedVersion: '0.10.4',
      failedCommand: 'version'
    });

    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest'
    }, dependencies)).rejects.toThrow(
      'Installed command --version failed: version failed'
    );
    expect(state.nodeCalls.map((args) => args[1])).toEqual([
      'help',
      'upgrade',
      '--version'
    ]);
    expect(state.removed).toBe(true);
  });

  it('uses the Windows global node_modules layout when resolving the installed entrypoint', async () => {
    const { dependencies, state } = verifierHarness();
    dependencies.platform = 'win32';
    await verifyPublishedPackage({ packageRoot: process.cwd(), tag: 'latest' }, dependencies);

    expect(state.nodeCalls[0][0]).toContain(path.join('global', 'node_modules', '@msn-control', 'liftoff', 'dist', 'cli.js'));
  });

  it('fails with expected and observed versions when the dist-tag is stale', async () => {
    const { dependencies, state } = verifierHarness({ observedVersion: '0.2.1' });
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest',
      timeoutMs: 0
    }, dependencies)).rejects.toThrow(/expected .*latest to resolve 0\.3\.3, observed 0\.2\.1/);
    expect(state.npmCalls.some((args) => args[0] === 'install')).toBe(false);
  });

  it('retries unavailable registry metadata until the bounded timeout', async () => {
    const { dependencies, state } = verifierHarness({ registryUnavailable: true });
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest',
      timeoutMs: 10,
      retryIntervalMs: 5
    }, dependencies)).rejects.toThrow(/observed unavailable/);
    expect(state.npmCalls.filter((args) => args[0] === 'view')).toHaveLength(3);
    expect(state.time).toBe(10);
  });

  it('rejects an installed-version mismatch and removes its temporary root', async () => {
    const { dependencies, state } = verifierHarness({ installedVersion: '0.2.1' });
    await expect(verifyPublishedPackage({ packageRoot: process.cwd(), tag: 'latest' }, dependencies))
      .rejects.toThrow(/expected @msn-control\/liftoff@0\.3\.3, observed @msn-control\/liftoff@0\.2\.1/);
    expect(state.removed).toBe(true);
    expect(state.tempRoot && existsSync(state.tempRoot)).toBe(false);
  });

  it('fails on an installed command error and removes its temporary root', async () => {
    const { dependencies, state } = verifierHarness({ failedCommand: 'help' });
    await expect(verifyPublishedPackage({ packageRoot: process.cwd(), tag: 'latest' }, dependencies))
      .rejects.toThrow(/Installed command help failed: help failed/);
    expect(state.removed).toBe(true);
    expect(state.tempRoot && existsSync(state.tempRoot)).toBe(false);
  });
});