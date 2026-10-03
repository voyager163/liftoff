import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  checkConfiguredRegistryTarget,
  runSelfUpgrade,
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  selfUpgradeSummary,
  type SelfUpgradeExecutor,
  type SelfUpgradeResult
} from '../src/self-upgrade.js';
import { StableReleaseLookupError } from '../src/stable-release.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ttyCaptureStream } from './helpers.js';
import { liftoffPackage, upgradeWorld, type UpgradeWorld } from './fixtures/installer-upgrade.js';

// Characterization captured from the pre-extraction implementation. The root facade API is the stable
// entry point, so these traces must stay byte-identical while responsibilities move between layers.

interface TraceScenario {
  name: string;
  world?: Parameters<typeof upgradeWorld>[0];
  arrange?: (fixture: UpgradeWorld) => void;
  expected: [SelfUpgradeResult['status'], SelfUpgradeResult['reasonCode']];
}

const mirror = 'https://mirror.example.test/npm/';
const lookupFailure = (code: StableReleaseLookupError['code']) => (fixture: UpgradeWorld) => {
  fixture.world.stable = async () => { throw new StableReleaseLookupError(code, `fixture ${code}`); };
};
const addDirectory = (fixture: UpgradeWorld, directory: string) => fixture.world.nodes.set(directory, { kind: 'directory' });

const traceScenarios: TraceScenario[] = [
  { name: 'linux check reports the running release as current', world: { targetVersion: '0.12.3' }, expected: ['current', 'current'] },
  { name: 'linux check finds an update through canonical npm', expected: ['update-available', 'update_available'] },
  {
    name: 'linux check finds an update through a scoped mirror returning an npm 12 metadata array',
    arrange: ({ world }) => {
      world.scopedRegistry = mirror;
      world.viewResult = { stdout: JSON.stringify([{ name: liftoffPackage, version: world.targetVersion }]) };
    },
    expected: ['update-available', 'update_available']
  },
  {
    name: 'linux check blocks a stale registry reporting E404',
    arrange: ({ world }) => { world.viewResult = { status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' }; },
    expected: ['blocked', 'registry_stale']
  },
  {
    name: 'linux check fails a registry transport error',
    arrange: ({ world }) => { world.viewResult = { status: 1, stderr: 'npm error code ETIMEDOUT' }; },
    expected: ['failed', 'registry_unavailable']
  },
  {
    name: 'linux check fails malformed registry metadata',
    arrange: ({ world }) => { world.viewResult = { stdout: '{not json' }; },
    expected: ['failed', 'registry_invalid']
  },
  {
    name: 'linux check fails an ambiguous two-element metadata array',
    arrange: ({ world }) => {
      world.viewResult = { stdout: JSON.stringify([{ name: liftoffPackage, version: world.targetVersion }, { name: liftoffPackage, version: '0.12.3' }]) };
    },
    expected: ['failed', 'registry_invalid']
  },
  {
    name: 'linux check blocks a credential-bearing registry URL',
    arrange: ({ world }) => { world.defaultRegistry = 'https://fixture-user:fixture-pass@mirror.example.test/'; },
    expected: ['blocked', 'registry_invalid']
  },
  {
    name: 'linux check fails when the scoped registry cannot be read',
    arrange: ({ world }) => { world.configResult['@msn-control:registry'] = { status: 1, stderr: 'config failure' }; },
    expected: ['failed', 'registry_unavailable']
  },
  {
    name: 'linux check fails when the default registry cannot be read',
    arrange: ({ world }) => { world.configResult.registry = { status: 1, stderr: 'config failure' }; },
    expected: ['failed', 'registry_unavailable']
  },
  {
    name: 'linux check blocks registry metadata for another version',
    arrange: ({ world }) => { world.viewResult = { stdout: JSON.stringify({ name: liftoffPackage, version: '0.12.9' }) }; },
    expected: ['blocked', 'registry_stale']
  },
  { name: 'linux apply upgrades with JSON progress on stderr', world: { mode: 'apply', json: true }, expected: ['upgraded', 'upgrade_complete'] },
  { name: 'linux apply upgrades with human progress on stdout', world: { mode: 'apply', json: false }, expected: ['upgraded', 'upgrade_complete'] },
  {
    name: 'linux apply reports an npm install timeout',
    world: { mode: 'apply' },
    arrange: ({ world }) => { world.installResult = { status: null, timedOut: true }; },
    expected: ['failed', 'npm_install_timeout']
  },
  {
    name: 'linux apply reports an npm install failure',
    world: { mode: 'apply' },
    arrange: ({ world }) => { world.installResult = { status: 1, stderr: 'EACCES' }; },
    expected: ['failed', 'npm_install_failed']
  },
  {
    name: 'linux apply rejects mismatched replacement version output',
    world: { mode: 'apply' },
    arrange: ({ world }) => { world.versionOutput = 'Liftoff 0.12.9'; },
    expected: ['failed', 'verification_failed']
  },
  {
    name: 'linux apply rejects a replacement binary escaping its package',
    world: { mode: 'apply' },
    arrange: ({ world }) => {
      world.afterInstall = () => {
        world.metadata.version = world.targetVersion;
        world.metadata.bin = { liftoff: '../../outside/cli.js' };
      };
    },
    expected: ['failed', 'verification_failed']
  },
  {
    name: 'linux apply rejects a replacement under another global root',
    world: { mode: 'apply' },
    arrange: (fixture) => {
      fixture.world.postInstallRoot = path.posix.join('/', 'usr', 'lib', 'node_modules');
      addDirectory(fixture, fixture.world.postInstallRoot);
    },
    expected: ['failed', 'verification_failed']
  },
  {
    name: 'linux blocks when npm is unavailable',
    arrange: ({ world }) => { world.rootResult = { status: null, errorCode: 'ENOENT' }; },
    expected: ['blocked', 'npm_unavailable']
  },
  {
    name: 'linux fails when npm cannot report its global root',
    arrange: ({ world }) => { world.rootResult = { status: 1, stderr: 'root failure' }; },
    expected: ['failed', 'invalid_global_root']
  },
  {
    name: 'linux blocks an ambiguous multi-line global root',
    arrange: ({ world }) => { world.rootResult = { stdout: '/usr/local/lib/node_modules\n/opt/other/node_modules\n' }; },
    expected: ['blocked', 'invalid_global_root']
  },
  {
    name: 'linux blocks a relative global root',
    arrange: ({ world }) => { world.rootResult = { stdout: 'lib/node_modules\n' }; },
    expected: ['blocked', 'invalid_global_root']
  },
  {
    name: 'linux blocks an unreadable global root',
    arrange: ({ world }) => { world.reportedRoot = path.posix.join('/', 'usr', 'local', 'lib', 'missing'); },
    expected: ['blocked', 'invalid_global_root']
  },
  {
    name: 'linux refuses an npx execution cache',
    arrange: (fixture) => {
      const cache = path.posix.join('/', 'home', 'dev', '.npm', '_npx', 'fixture', 'node_modules', '@msn-control', 'liftoff');
      addDirectory(fixture, cache);
      fixture.request.runningPackageRoot = cache;
    },
    expected: ['blocked', 'unsupported_installation']
  },
  {
    name: 'linux refuses a linked development checkout',
    arrange: (fixture) => {
      const checkout = path.posix.join('/', 'home', 'dev', 'liftoff');
      addDirectory(fixture, checkout);
      fixture.world.nodes.set(fixture.world.packageRoot, { kind: 'symlink', target: checkout });
    },
    expected: ['blocked', 'unsupported_installation']
  },
  {
    name: 'linux blocks another package at the global package path',
    arrange: ({ world }) => { world.metadata.name = '@other/liftoff'; },
    expected: ['blocked', 'invalid_package']
  },
  {
    name: 'linux blocks installed metadata for another running version',
    arrange: ({ world }) => { world.metadata.version = '0.12.2'; },
    expected: ['blocked', 'invalid_package']
  },
  { name: 'linux refuses a downgrade', world: { targetVersion: '0.12.2' }, expected: ['blocked', 'downgrade_refused'] },
  { name: 'linux reports a canonical lookup timeout', arrange: lookupFailure('timeout'), expected: ['failed', 'canonical_timeout'] },
  { name: 'linux reports invalid canonical metadata', arrange: lookupFailure('invalid_metadata'), expected: ['failed', 'canonical_invalid'] },
  { name: 'linux reports a canonical HTTP failure', arrange: lookupFailure('http_failure'), expected: ['failed', 'canonical_unavailable'] },
  { name: 'linux reports a canonical network failure', arrange: lookupFailure('network_failure'), expected: ['failed', 'canonical_unavailable'] },
  {
    name: 'linux reports an unexpected canonical lookup error',
    arrange: ({ world }) => { world.stable = async () => { throw new Error('fixture lookup failure'); }; },
    expected: ['failed', 'canonical_unavailable']
  },
  {
    name: 'linux rejects a prerelease canonical target',
    arrange: ({ world }) => { world.stable = async () => ({ name: liftoffPackage, version: '0.13.0-rc.1' }); },
    expected: ['failed', 'canonical_invalid']
  },
  {
    name: 'linux rejects canonical metadata for another product',
    arrange: ({ world }) => { world.stable = async () => ({ name: '@other/liftoff' as typeof liftoffPackage, version: '0.13.0' }); },
    expected: ['failed', 'canonical_invalid']
  },
  {
    name: 'linux maps an unexpected runner exception after target resolution',
    arrange: ({ world }) => { world.runnerFailure = (command) => command.args[0] === 'view' ? new Error('fixture runner failure') : undefined; },
    expected: ['failed', 'verification_failed']
  },
  {
    name: 'win32 check accepts a case-folded package root',
    world: { platform: 'win32' },
    arrange: (fixture) => {
      const folded = fixture.world.packageRoot.toLowerCase();
      addDirectory(fixture, folded);
      fixture.request.runningPackageRoot = folded;
    },
    expected: ['update-available', 'update_available']
  },
  { name: 'win32 apply upgrades through npm.cmd', world: { platform: 'win32', mode: 'apply' }, expected: ['upgraded', 'upgrade_complete'] },
  { name: 'darwin Homebrew /opt/homebrew prefix check finds an update', world: { layout: 'homebrew-opt' }, expected: ['update-available', 'update_available'] },
  {
    name: 'darwin Homebrew /usr/local prefix apply upgrades in place',
    world: { layout: 'homebrew-usr-local', mode: 'apply' },
    expected: ['upgraded', 'upgrade_complete']
  },
  {
    name: 'darwin Homebrew prefix selecting another registry is blocked',
    world: { layout: 'homebrew-opt' },
    arrange: ({ world }) => { world.prefixDefaultRegistry = mirror; },
    expected: ['blocked', 'registry_prefix_mismatch']
  },
  {
    name: 'darwin Homebrew launcher drift before installation is blocked',
    world: { layout: 'homebrew-opt', mode: 'apply' },
    arrange: (fixture) => {
      const other = path.posix.join(fixture.world.prefix!, 'lib', 'node_modules', 'other', 'cli.js');
      fixture.world.nodes.set(other, { kind: 'file' });
      fixture.world.beforeView = () => {
        fixture.world.nodes.set(path.posix.join(fixture.world.prefix!, 'bin', 'liftoff'), { kind: 'symlink', target: other });
      };
    },
    expected: ['blocked', 'unsupported_installation']
  },
  {
    name: 'darwin Homebrew fallback is refused for a non-Cellar runtime',
    world: { layout: 'homebrew-opt' },
    arrange: (fixture) => {
      const runtime = path.posix.join('/', 'usr', 'bin', 'node');
      fixture.world.nodes.set(runtime, { kind: 'file' });
      fixture.dependencies.execPath = runtime;
    },
    expected: ['blocked', 'unsupported_installation']
  }
];

interface TargetScenario {
  name: string;
  arrange?: (fixture: UpgradeWorld) => void;
  expected: Awaited<ReturnType<typeof checkConfiguredRegistryTarget>>['status'];
}

const targetScenarios: TargetScenario[] = [
  { name: 'configured target available through canonical npm', expected: 'available' },
  { name: 'configured target available through a scoped mirror', arrange: ({ world }) => { world.scopedRegistry = mirror; }, expected: 'available' },
  {
    name: 'configured target stale in the effective registry',
    arrange: ({ world }) => { world.viewResult = { status: 1, stderr: 'npm error code E404' }; },
    expected: 'stale'
  },
  {
    name: 'configured target unavailable when registry configuration fails',
    arrange: ({ world }) => { world.configResult['@msn-control:registry'] = { status: 1 }; },
    expected: 'unavailable'
  },
  {
    name: 'configured target unavailable without a neutral directory',
    arrange: ({ world }) => { world.makeNeutral = async () => { throw new Error('fixture neutral directory failure'); }; },
    expected: 'unavailable'
  }
];

describe('self-upgrade effect parity', () => {
  it.each(traceScenarios)('$name', async ({ world: options, arrange, expected }) => {
    const fixture = upgradeWorld(options);
    arrange?.(fixture);
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect([result.status, result.reasonCode]).toEqual(expected);
    expect({
      trace: fixture.world.trace,
      result,
      exitCode: selfUpgradeExitCode(result),
      remedy: selfUpgradeRemedy(result) ?? null,
      summary: selfUpgradeSummary(result)
    }).toMatchSnapshot();
  });

  it.each(targetScenarios)('$name', async ({ arrange, expected }) => {
    const fixture = upgradeWorld();
    arrange?.(fixture);
    const result = await checkConfiguredRegistryTarget(fixture.world.targetVersion, fixture.dependencies);
    expect(result.status).toBe(expected);
    expect({ trace: fixture.world.trace, result }).toMatchSnapshot();
  });
});

const results: Record<string, SelfUpgradeResult> = {
  current: { schemaVersion: 1, mode: 'check', status: 'current', currentVersion: liftoffVersion, reasonCode: 'current' },
  available: {
    schemaVersion: 1, mode: 'check', status: 'update-available', currentVersion: liftoffVersion,
    reasonCode: 'update_available', targetVersion: '99.0.0', registryKind: 'configured'
  },
  upgraded: {
    schemaVersion: 1, mode: 'apply', status: 'upgraded', currentVersion: liftoffVersion,
    reasonCode: 'upgrade_complete', targetVersion: '99.0.0', registryKind: 'canonical'
  },
  stale: {
    schemaVersion: 1, mode: 'apply', status: 'blocked', currentVersion: liftoffVersion,
    reasonCode: 'registry_stale', targetVersion: '99.0.0', registryKind: 'configured'
  },
  homebrewBlocked: {
    schemaVersion: 1, mode: 'apply', status: 'blocked', currentVersion: liftoffVersion,
    reasonCode: 'unsupported_installation', installationTarget: 'homebrew-opt'
  },
  installFailed: {
    schemaVersion: 1, mode: 'apply', status: 'failed', currentVersion: liftoffVersion,
    reasonCode: 'npm_install_failed', targetVersion: '99.0.0', registryKind: 'configured', installationTarget: 'homebrew-usr-local'
  },
  unverified: { schemaVersion: 1, mode: 'apply', status: 'failed', currentVersion: liftoffVersion, reasonCode: 'verification_failed' }
};

function executor(result: SelfUpgradeResult | 'throw', requests: unknown[]): SelfUpgradeExecutor {
  return async (request) => {
    requests.push({
      keys: Object.keys(request).sort(),
      mode: request.mode,
      json: request.json,
      currentVersion: request.currentVersion === liftoffVersion ? '<cli-version>' : request.currentVersion,
      runningPackageRoot: request.runningPackageRoot ?? null
    });
    if (result === 'throw') throw new Error('fixture executor failure with private detail');
    if (result.status === 'upgraded') {
      request.onStage?.('Inspect global installation');
      request.onStage?.('Resolve canonical stable target');
      request.onStage?.('Verify configured registry parity');
      request.onStage?.('Install exact Liftoff release', result.targetVersion);
      request.onInstallCommand?.({
        executable: 'npm',
        args: ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${liftoffPackage}@${result.targetVersion}`]
      });
      (request.json ? request.stderr : request.stdout).write('fixture npm progress\n');
      request.onStage?.('Verify replacement', result.targetVersion);
    }
    return result;
  };
}

interface PresentationScenario {
  name: string;
  argv: string[];
  result: SelfUpgradeResult | 'throw';
  terminal?: { tty?: boolean; columns?: number; env?: NodeJS.ProcessEnv; color?: boolean; snapshot?: boolean };
}

const tty = (columns: number, extra: Omit<NonNullable<PresentationScenario['terminal']>, 'tty' | 'columns'> = {}) =>
  ({ tty: true, columns, snapshot: true, env: {}, ...extra });

const presentationScenarios: PresentationScenario[] = [
  { name: 'plain check current', argv: ['upgrade', '--check'], result: results.current! },
  { name: 'plain check update available', argv: ['upgrade', '--check'], result: results.available! },
  { name: 'plain apply upgraded with stages', argv: ['upgrade'], result: results.upgraded! },
  { name: 'plain apply blocked by a stale registry', argv: ['upgrade'], result: results.stale! },
  { name: 'plain apply blocked Homebrew target', argv: ['upgrade'], result: results.homebrewBlocked! },
  { name: 'plain apply install failure with exact remedy', argv: ['upgrade'], result: results.installFailed! },
  { name: 'plain apply verification failure without target', argv: ['upgrade'], result: results.unverified! },
  { name: 'plain apply executor exception', argv: ['upgrade'], result: 'throw' },
  { name: 'rich apply upgraded with stages', argv: ['upgrade'], result: results.upgraded!, terminal: tty(100) },
  { name: 'rich apply blocked Homebrew target', argv: ['upgrade'], result: results.homebrewBlocked!, terminal: tty(100) },
  { name: 'compact apply upgraded with stages', argv: ['upgrade'], result: results.upgraded!, terminal: tty(80) },
  { name: 'narrow apply upgraded with stages', argv: ['upgrade'], result: results.upgraded!, terminal: tty(50) },
  { name: 'no-color check current', argv: ['upgrade', '--check'], result: results.current!, terminal: tty(100, { env: { NO_COLOR: '1' } }) },
  { name: 'color apply upgraded with stages', argv: ['upgrade'], result: results.upgraded!, terminal: tty(100, { snapshot: false, color: true }) },
  { name: 'color apply install failure', argv: ['upgrade'], result: results.installFailed!, terminal: tty(100, { snapshot: false, color: true }) },
  { name: 'json check update available', argv: ['upgrade', '--check', '--json'], result: results.available! },
  { name: 'json apply upgraded keeps progress on stderr', argv: ['upgrade', '--json'], result: results.upgraded! },
  { name: 'json apply blocked Homebrew target', argv: ['upgrade', '--json'], result: results.homebrewBlocked! },
  { name: 'json apply executor exception', argv: ['upgrade', '--json'], result: 'throw' }
];

describe('upgrade command presentation parity', () => {
  it.each(presentationScenarios)('$name', async ({ argv, result, terminal }) => {
    const stdout = terminal?.tty ? ttyCaptureStream() : new CaptureStream();
    const stderr = terminal?.tty ? ttyCaptureStream() : new CaptureStream();
    const requests: unknown[] = [];
    const code = await runCommand(parseArgs(argv), {
      cwd: path.join(path.parse(process.cwd()).root, 'directory without a liftoff project'),
      stdout,
      stderr,
      env: {},
      selfUpgrade: executor(result, requests),
      terminal: {
        columns: terminal?.columns,
        snapshot: terminal?.snapshot,
        color: terminal?.color,
        env: terminal?.env ?? {}
      }
    });
    const normalize = (value: string) => value.replaceAll(liftoffVersion, '<cli-version>');
    expect({ code, stdout: normalize(stdout.text()), stderr: normalize(stderr.text()), requests }).toMatchSnapshot();
  });
});
