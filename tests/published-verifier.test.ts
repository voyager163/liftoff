import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_NPM_REGISTRY,
  parseHistoricalVerifierArguments,
  verifyPublishedPackage,
  type PublishedVerifierDependencies
} from '../src/published-verifier.js';

interface HarnessOptions {
  packageName?: string;
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
        return {
          status: 0,
          stdout: `Liftoff ${options.installedVersion ?? options.packageVersion ?? '0.3.3'}\n`,
          stderr: ''
        };
      }
      return { status: 0, stdout: 'Project type: Standard application\n', stderr: '' };
    },
    now: () => state.time,
    wait: async (milliseconds) => { state.time += milliseconds; },
    readJson: async (filePath) => filePath === path.join(process.cwd(), 'package.json')
      ? { name: options.packageName ?? '@msn-control/liftoff', version: options.packageVersion ?? '0.3.3' }
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

describe('historical npm verifier arguments', () => {
  it('selects an immutable historical version rather than a moving tag', () => {
    expect(parseHistoricalVerifierArguments(['0.12.3'])).toEqual({
      tag: '0.12.3',
      historicalVersion: '0.12.3',
      allowLegacyVersionCommand: false
    });
  });

  it.each([
    ['0.3.3', '--allow-legacy-version-command'],
    ['--allow-legacy-version-command', '0.3.3']
  ])('retains the explicit historical compatibility opt-in (%s %s)', (...args) => {
    expect(parseHistoricalVerifierArguments(args)).toEqual({
      tag: '0.3.3',
      historicalVersion: '0.3.3',
      allowLegacyVersionCommand: true
    });
  });

  it.each([
    { args: [] },
    { args: ['latest'] },
    { args: ['next'] },
    { args: ['0.12.4'] },
    { args: ['0.13.0'] },
    { args: ['1.0.0'] },
    { args: ['0.12.3-beta.1'] },
    { args: ['0.12.3+build'] },
    { args: ['v0.12.3'] },
    { args: ['0.12'] },
    { args: ['0.012.3'] },
    { args: ['0.0.9007199254740992'] },
    { args: ['0.12.3\n'] },
    { args: [' 0.12.3'] },
    { args: ['0.12.3', 'latest'] },
    { args: ['0.12.3', '--unknown'] },
    { args: ['0.3.3', '--allow-legacy-version-command', '--allow-legacy-version-command'] }
  ])('rejects unsupported or ambiguous arguments $args', ({ args }) => {
    expect(() => parseHistoricalVerifierArguments(args)).toThrow();
  });
});

describe('published package verifier', () => {
  it.each(['-latest', 'latest\n', ' latest', 'latest --global'])('rejects invalid retained npm reference %j before effects', async (tag) => {
    const { dependencies, state } = verifierHarness();
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag
    }, dependencies)).rejects.toThrow('Invalid npm dist-tag');
    expect(state.npmCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

  it('verifies the requested historical release independently of current native source metadata', async () => {
    const { dependencies, state } = verifierHarness({
      packageVersion: '0.13.0',
      observedVersion: '0.12.3',
      installedVersion: '0.12.3'
    });
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(),
      ...parseHistoricalVerifierArguments(['0.12.3'])
    }, dependencies);

    expect(result).toMatchObject({
      version: '0.12.3',
      tag: '0.12.3',
      legacyVersionCommandAllowed: false
    });
    expect(state.npmCalls[0].slice(0, 3)).toEqual([
      'view', '@msn-control/liftoff@0.12.3', 'version'
    ]);
    expect(state.npmCalls[1]).toContain('@msn-control/liftoff@0.12.3');
    expect(state.npmCalls.flat()).not.toContain('latest');
    expect(state.nodeCalls.map((args) => args[1])).toEqual(['help', 'upgrade', '--version', 'plan']);
    expect(state.removed).toBe(true);
  });

  it('applies the 0.3.3 exception to the requested release, not the verifier checkout', async () => {
    const { dependencies, state } = verifierHarness({
      packageVersion: '0.13.0',
      observedVersion: '0.3.3',
      installedVersion: '0.3.3'
    });
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(),
      ...parseHistoricalVerifierArguments(['0.3.3', '--allow-legacy-version-command'])
    }, dependencies);
    expect(result.legacyVersionCommandAllowed).toBe(true);
    expect(state.nodeCalls.map((args) => args[1])).toEqual(['help', 'plan']);
  });

  it.each([
    { tag: 'latest', historicalVersion: '0.12.3' },
    { tag: '0.3.3', historicalVersion: '0.12.3' },
    { tag: '0.13.0', historicalVersion: '0.13.0' },
    { tag: '0.12.4', historicalVersion: '0.12.4' },
    { tag: '0.12.3-beta.1', historicalVersion: '0.12.3-beta.1' },
    { tag: '0.12.3', historicalVersion: 'latest' }
  ])('rejects the mixed or nonhistorical selection $tag/$historicalVersion before effects', async (options) => {
    const { dependencies, state } = verifierHarness();
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      ...options
    }, dependencies)).rejects.toThrow(/Historical npm verification/);
    expect(state.npmCalls).toEqual([]);
    expect(state.nodeCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

  it('rejects a mutable historical selection before constructing real process dependencies', async () => {
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest',
      historicalVersion: '0.12.3'
    })).rejects.toThrow('must select the exact version');
  });

  it('does not let the retained source-version API treat the native candidate as an npm release', async () => {
    const { dependencies, state } = verifierHarness({ packageVersion: '0.13.0' });
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: 'latest'
    }, dependencies)).rejects.toThrow('Native releases are not published to npm.');
    expect(state.npmCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

  it('retains canonical source package validation with an explicit historical selection', async () => {
    const { dependencies, state } = verifierHarness({
      packageName: '@other/liftoff',
      packageVersion: '0.13.0'
    });
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      ...parseHistoricalVerifierArguments(['0.12.3'])
    }, dependencies)).rejects.toThrow('Published package identity must be @msn-control/liftoff');
    expect(state.npmCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

  it.each([
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { retryIntervalMs: 0 },
    { retryIntervalMs: Number.NaN },
    { retryIntervalMs: Number.POSITIVE_INFINITY }
  ])('rejects invalid timeout bounds $timeoutMs/$retryIntervalMs before effects', async (options) => {
    const { dependencies, state } = verifierHarness();
    await expect(verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: '0.12.3',
      historicalVersion: '0.12.3',
      ...options
    }, dependencies)).rejects.toThrow('must be finite');
    expect(state.npmCalls).toEqual([]);
    expect(state.tempRoot).toBeUndefined();
  });

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