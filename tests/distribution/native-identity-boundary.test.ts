import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSemver, isStableSemver } from '../../src/semver.js';
import { parseNativeReleaseManifest, parseRuntimeConstraints } from '../../src/domain/distribution/release-manifest.js';
import { stableVersion } from '../../src/domain/distribution/validation.js';
import { upgradeLiftoff } from '../../src/application/upgrade/use-case.js';
import * as nativeUpgrade from '../../src/application/distribution/native-upgrade.js';
import * as historicalUpgrade from '../../src/self-upgrade.js';
import { PresentationSession } from '../../src/terminal.js';
import type { CommandRunner } from '../../src/process-runner.js';
import { CaptureStream } from '../helpers.js';
import { validManifest } from './manifest-fixture.js';

afterEach(() => vi.restoreAllMocks());

describe('exact stable version identity', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('rejects a trailing line terminator %#', (ending) => {
    expect(isStableSemver(`1.2.3${ending}`)).toBe(false);
    expect(() => stableVersion(`1.2.3${ending}`)).toThrow(/canonical stable SemVer/);
    expect(() => parseRuntimeConstraints({ nodeVersion: `24.20.0${ending}` })).toThrow(/canonical stable SemVer/);
    expect(() => parseNativeReleaseManifest({ ...validManifest(), version: `0.13.0${ending}` })).toThrow(/canonical stable SemVer/);
  });

  it.each(['0.0.0', '1.2.3', '24.20.0'])('accepts canonical stable identity %s', (version) => {
    expect(isStableSemver(version)).toBe(true);
  });

  it.each([' 1.2.3', '1.2.3 ', '1.2.3\t', '1.2.3\0', '01.2.3', '1.2.3-alpha', '1.2.3+build', '', null, 123])(
    'rejects noncanonical stable identity %#', (value) => expect(isStableSemver(value)).toBe(false)
  );

  it('preserves historical comparison semantics without using comparison as identity admission', () => {
    expect(compareSemver('1.2.3\n', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.1', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3-alpha.2', '1.2.3-alpha.10')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3-beta')).toBe(1);
  });
});

describe('native upgrade application boundary', () => {
  function context() {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const runner: CommandRunner = { run: vi.fn<CommandRunner['run']>().mockRejectedValue(new Error('Unexpected external execution.')) };
    const env = { PATH: 'selected-path-only', HOME: '/selected-home' };
    return {
      cwd: '/selected-invocation', env, runner, stdout, stderr,
      presentation: new PresentationSession({ stdout, stderr, json: true, color: false })
    };
  }

  it.each(['unknown', 'unlinked', 'npm'] as const)('retains selected context and never adopts %s as npm fallback authority', async (owner) => {
    const selected = context();
    const native = vi.spyOn(nativeUpgrade, 'runNativeOwnerUpgrade').mockResolvedValue({
      schemaVersion: 1, distribution: 'native', mode: 'apply', status: 'blocked', currentVersion: '0.13.0', owner,
      upstreamAvailability: 'unknown', ownerAvailability: 'unknown', reasonCode: owner === 'npm' ? 'migration_required' : 'ownership_unknown',
      completedEffects: [], uncertainEffects: [], recoveryRequired: false
    });
    const historical = vi.spyOn(historicalUpgrade, 'runSelfUpgrade').mockRejectedValue(new Error('Native ownership cannot authorize npm fallback.'));
    expect(await upgradeLiftoff({ mode: 'apply', json: true }, selected)).toBe(1);
    expect(native.mock.calls).toHaveLength(1);
    const dependencies = native.mock.calls[0][1];
    expect(dependencies?.env).toBe(selected.env);
    expect(dependencies?.runner).toBe(selected.runner);
    expect(dependencies?.cwd).toBe(selected.cwd);
    expect(historical).not.toHaveBeenCalled();
    expect(selected.runner.run).not.toHaveBeenCalled();
    expect(JSON.parse(selected.stdout.text())).toMatchObject({ schemaVersion: 1, distribution: 'native', owner, status: 'blocked' });
    expect(selected.stderr.text()).toBe('');
  });

  it('keeps unexpected native failure in the native schema-1 contract without npm execution', async () => {
    const selected = context();
    vi.spyOn(nativeUpgrade, 'runNativeOwnerUpgrade').mockRejectedValue(new Error('Native boundary failure.'));
    const historical = vi.spyOn(historicalUpgrade, 'runSelfUpgrade').mockRejectedValue(new Error('No npm fallback.'));
    expect(await upgradeLiftoff({ mode: 'check', json: true }, selected)).toBe(1);
    expect(JSON.parse(selected.stdout.text())).toMatchObject({ schemaVersion: 1, distribution: 'native', status: 'failed' });
    expect(historical).not.toHaveBeenCalled();
    expect(selected.runner.run).not.toHaveBeenCalled();
  });
});
