import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import * as nativeUpgrade from '../src/application/distribution/native-upgrade.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('native upgrade outer outcome preservation', () => {
  it.each(['check', 'apply'] as const)('retains previous effects and recovery details in both human and JSON %s output', async (mode) => {
    const result: nativeUpgrade.NativeUpgradeResult = {
      schemaVersion: 1, distribution: 'native', mode,
      status: mode === 'check' ? 'blocked' : 'failed',
      currentVersion: liftoffVersion, targetVersion: '0.14.0', owner: 'direct',
      upstreamAvailability: 'available', ownerAvailability: 'blocked',
      reasonCode: 'recovery_required', completedEffects: ['stage-candidate'],
      uncertainEffects: ['install-target-owner'], recoveryRequired: true,
      recordPersistence: 'unconfirmed',
      manualAction: 'Retain the original owner-operation record before further work.'
    };
    const execute = vi.spyOn(nativeUpgrade, 'runNativeOwnerUpgrade').mockResolvedValue(result);
    for (const json of [false, true]) {
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      const code = await runCommand(parseArgs([
        'upgrade', ...(mode === 'check' ? ['--check'] : []), ...(json ? ['--json'] : [])
      ]), { cwd: path.resolve('tests'), stdout, stderr, env: {} });
      expect(code).toBe(1);
      if (json) {
        expect(JSON.parse(stdout.text())).toEqual(result);
      } else {
        const output = `${stdout.text()} ${stderr.text()}`.replace(/\s+/g, ' ');
        expect(output).toContain('Upstream availability: available');
        expect(output).toContain('Owner availability: blocked');
        expect(output).toContain('Completed effects');
        expect(output).toContain('stage-candidate');
        expect(output).toContain('Uncertain effects');
        expect(output).toContain('install-target-owner');
        expect(output).toContain('Recovery: required');
        expect(output).toContain('Record persistence: unconfirmed');
        expect(output).toContain(result.manualAction);
      }
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('shows possible partial effects after an unexpected apply failure in human output', async () => {
    vi.spyOn(nativeUpgrade, 'runNativeOwnerUpgrade')
      .mockRejectedValue(new Error('private failure detail must not escape'));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['upgrade']), {
      cwd: path.resolve('tests'), stdout, stderr, env: {}
    });
    const output = `${stdout.text()} ${stderr.text()}`.replace(/\s+/g, ' ');
    expect(code).toBe(1);
    expect(output).toContain('Uncertain effects');
    expect(output).toContain('possible partial effects must be preserved');
    expect(output).toContain('Record persistence: unconfirmed');
    expect(output).toContain('Recovery: required');
    expect(output).not.toContain('Completed effects');
    expect(output).not.toContain('private failure detail');
  });

  it.each(['check', 'apply'] as const)('does not invent a settled or untouched outcome after an unexpected %s failure', async (mode) => {
    const execute = vi.spyOn(nativeUpgrade, 'runNativeOwnerUpgrade')
      .mockRejectedValue(new Error('private failure detail must not escape'));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['upgrade', ...(mode === 'check' ? ['--check'] : []), '--json']), {
      cwd: path.resolve('tests'), stdout, stderr, env: {}
    });
    expect(code).toBe(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode }), expect.any(Object));
    const report = JSON.parse(stdout.text());
    expect(report).toMatchObject({
      schemaVersion: 1, distribution: 'native', mode, status: 'failed',
      currentVersion: liftoffVersion, owner: 'unknown',
      upstreamAvailability: 'unknown', ownerAvailability: 'unknown',
      recoveryRequired: mode === 'apply', completedEffects: []
    });
    if (mode === 'apply') {
      expect(report.uncertainEffects).toEqual([
        'The native owner operation outcome is unconfirmed; possible partial effects must be preserved.'
      ]);
      expect(report.recordPersistence).toBe('unconfirmed');
    } else {
      expect(report.uncertainEffects).toEqual([]);
      expect(report).not.toHaveProperty('recordPersistence');
    }
    expect(report.manualAction).toContain('No speculative rollback, cleanup or new replacement');
    expect(stdout.text() + stderr.text()).not.toContain('private failure detail');
  });

  it('retains the historical injected report body without relabeling its schema or adding native recovery claims', async () => {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['upgrade', '--json']), {
      cwd: path.resolve('tests'), stdout, stderr, env: {},
      selfUpgrade: async () => { throw new Error('historical fixture'); }
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.text())).toEqual({
      schemaVersion: 1, mode: 'apply', status: 'failed',
      currentVersion: liftoffVersion, reasonCode: 'verification_failed'
    });
  });
});
