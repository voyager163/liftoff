import { describe, expect, it, vi } from 'vitest';
import { getGeneralHelp, parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type {
  SelfUpgradeExecutor,
  SelfUpgradeResult
} from '../src/self-upgrade.js';
import { liftoffVersion } from '../src/version.js';
import {
  CaptureStream,
  ttyCaptureStream
} from './helpers.js';

function upgradeResult(
  status: SelfUpgradeResult['status'],
  mode: 'apply' | 'check'
): SelfUpgradeResult {
  switch (status) {
    case 'current':
      return {
        schemaVersion: 1,
        mode,
        status,
        currentVersion: liftoffVersion,
        reasonCode: 'current'
      };
    case 'update-available':
      return {
        schemaVersion: 1,
        mode,
        status,
        currentVersion: liftoffVersion,
        targetVersion: '99.0.0',
        registryKind: 'configured',
        reasonCode: 'update_available'
      };
    case 'upgraded':
      return {
        schemaVersion: 1,
        mode,
        status,
        currentVersion: liftoffVersion,
        targetVersion: '99.0.0',
        registryKind: 'canonical',
        reasonCode: 'upgrade_complete'
      };
    case 'blocked':
      return {
        schemaVersion: 1,
        mode,
        status,
        currentVersion: liftoffVersion,
        targetVersion: '99.0.0',
        reasonCode: 'registry_stale'
      };
    case 'failed':
      return {
        schemaVersion: 1,
        mode,
        status,
        currentVersion: liftoffVersion,
        targetVersion: '99.0.0',
        registryKind: 'configured',
        reasonCode: 'npm_install_failed'
      };
  }
}

async function execute(
  argv: string[],
  selfUpgrade: SelfUpgradeExecutor,
  values: {
    columns?: number;
    env?: NodeJS.ProcessEnv;
    tty?: boolean;
  } = {}
) {
  const stdout = values.tty ? ttyCaptureStream() : new CaptureStream();
  const stderr = values.tty ? ttyCaptureStream() : new CaptureStream();
  const code = await runCommand(parseArgs(argv), {
    cwd: '/directory/without/a/liftoff/project',
    stdout,
    stderr,
    env: values.env ?? {},
    selfUpgrade,
    terminal: {
      columns: values.columns,
      snapshot: values.tty,
      env: values.env
    }
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

describe('upgrade command surface', () => {
  it('accepts only check, json, and help without positionals', () => {
    expect(parseArgs(['upgrade'])).toMatchObject({
      command: 'upgrade',
      positional: [],
      flags: {}
    });
    expect(parseArgs(['upgrade', '--check', '--json']).flags).toEqual({
      check: true,
      json: true
    });
    for (const flag of [
      '--force',
      '--yes',
      '--install-tools',
      '--install-dependencies'
    ]) {
      expect(() => parseArgs(['upgrade', flag])).toThrow(
        `Unknown flag for upgrade: ${flag}`
      );
    }
    expect(() => parseArgs(['upgrade', './project'])).toThrow(
      /Too many positional arguments/
    );
  });

  it('describes CLI replacement without running discovery', async () => {
    const selfUpgrade = vi.fn<SelfUpgradeExecutor>();
    const result = await execute(['upgrade', '--help'], selfUpgrade);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('Replace the supported global npm Liftoff CLI');
    expect(result.out).toContain('--check');
    expect(result.out).toContain('--json');
    expect(selfUpgrade).not.toHaveBeenCalled();

    const maintenance = getGeneralHelp(liftoffVersion).commandGroups
      .find((group) => group.title === 'Maintenance')?.entries ?? [];
    expect(maintenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        syntax: 'upgrade',
        description: expect.stringContaining('global npm Liftoff CLI')
      }),
      expect.objectContaining({
        syntax: 'update',
        description: expect.stringContaining('project')
      })
    ]));
  });

  it.each([
    ['current', 0],
    ['upgraded', 0],
    ['update-available', 2],
    ['blocked', 1],
    ['failed', 1]
  ] as const)('maps %s to exit %i identically in human and JSON modes', async (
    status,
    expectedCode
  ) => {
    for (const json of [false, true]) {
      const mode = status === 'update-available' ? 'check' : 'apply';
      const selfUpgrade = vi.fn<SelfUpgradeExecutor>(
        async () => upgradeResult(status, mode)
      );
      const result = await execute([
        'upgrade',
        ...(mode === 'check' ? ['--check'] : []),
        ...(json ? ['--json'] : [])
      ], selfUpgrade);
      expect(result.code).toBe(expectedCode);
      expect(selfUpgrade).toHaveBeenCalledOnce();
      if (json) {
        expect(JSON.parse(result.out)).toEqual(upgradeResult(status, mode));
      }
    }
  });

  it('keeps JSON stdout byte-pure and routes progress to stderr', async () => {
    const selfUpgrade: SelfUpgradeExecutor = async (request) => {
      request.stderr.write('npm progress\n');
      return upgradeResult('upgraded', 'apply');
    };
    const result = await execute(['upgrade', '--json'], selfUpgrade);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      status: 'upgraded'
    });
    expect(result.err).toBe('npm progress\n');
  });

  it.each([
    ['rich', 100],
    ['compact', 80],
    ['plain', 50]
  ] as const)('renders responsive %s stages and completion', async (
    layout,
    columns
  ) => {
    const selfUpgrade: SelfUpgradeExecutor = async (request) => {
      request.onStage?.('Inspect global installation');
      request.onStage?.('Resolve canonical stable target');
      request.onStage?.('Verify configured registry parity');
      request.onStage?.('Install exact Liftoff release', '99.0.0');
      request.onInstallCommand?.({
        executable: 'npm',
        args: [
          'install',
          '--global',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '@msn-control/liftoff@99.0.0'
        ]
      });
      request.onStage?.('Verify replacement', '99.0.0');
      return upgradeResult('upgraded', 'apply');
    };
    const result = await execute(['upgrade'], selfUpgrade, {
      columns,
      tty: true
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Inspect global installation');
    expect(result.out).toContain('@msn-control/liftoff@99.0.0');
    expect(result.out).toContain('Liftoff CLI upgraded');
    expect(result.out).toContain('Next recommended command');
    expect(result.out).toContain('liftoff update --check');
    if (layout === 'plain') {
      expect(result.out).not.toMatch(/[┌┐└┘│]/);
    }
  });

  it('keeps no-color output free of ANSI sequences', async () => {
    const result = await execute(
      ['upgrade'],
      async () => upgradeResult('current', 'apply'),
      {
        columns: 100,
        tty: true,
        env: { NO_COLOR: '1' }
      }
    );
    expect(result.out).not.toMatch(/\u001B\[/);
  });

  it('redacts executor failures into the stable JSON failure shape', async () => {
    const result = await execute(
      ['upgrade', '--json'],
      async () => {
        throw new Error('https://user:secret@example.test/private/path');
      }
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schemaVersion: 1,
      mode: 'apply',
      status: 'failed',
      currentVersion: liftoffVersion,
      reasonCode: 'verification_failed'
    });
    expect(`${result.out}${result.err}`).not.toMatch(/secret|private\/path/);
  });
});
