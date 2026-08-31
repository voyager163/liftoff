import { describe, expect, it } from 'vitest';
import {
  classifyFreshness,
  compareStableVersions,
  requireStableVersion,
  selectLatestCompatibleVersion,
  versionSatisfiesDeclaredRange,
  selectLatestNodeLts
} from '../scripts/supported-stack-freshness.mjs';

describe('supported stack freshness policy', () => {
  it('selects the newest stable Node.js LTS instead of Current', () => {
    expect(selectLatestNodeLts([
      { version: 'v26.8.1', lts: false },
      { version: 'v24.20.0', lts: 'Krypton' },
      { version: 'v22.22.1', lts: 'Jod' }
    ])).toBe('24.20.0');
  });

  it('rejects prerelease and malformed candidate versions', () => {
    expect(() => requireStableVersion('1.2.3-rc.1', 'candidate'))
      .toThrow(/non-stable version/);
    expect(() => requireStableVersion('latest', 'candidate'))
      .toThrow(/non-stable version/);
  });

  it('compares stable versions numerically', () => {
    expect(compareStableVersions('1.12.6', '1.12.5')).toBe(1);
    expect(compareStableVersions('1.12.6', '1.12.6')).toBe(0);
    expect(classifyFreshness('1.12.5', '1.12.6')).toBe('stale');
    expect(classifyFreshness('1.2.7', '1.3.0', '1.3.0')).toBe('reviewed');
  });

  it('selects the newest stable version permitted by an upstream npm range', () => {
    expect(versionSatisfiesDeclaredRange('1.3.0', '^1.2.5')).toBe(true);
    expect(versionSatisfiesDeclaredRange('2.0.0', '^1.2.5')).toBe(false);
    expect(versionSatisfiesDeclaredRange('5.9.9', '~5.9.3')).toBe(true);
    expect(versionSatisfiesDeclaredRange('5.10.0', '~5.9.3')).toBe(false);
    expect(selectLatestCompatibleVersion(
      ['7.1.7', '7.3.6', '8.0.0', '8.0.0-beta.1'],
      '^7.1.7'
    )).toBe('7.3.6');
  });

  it('fails when the Node release feed has no stable LTS candidate', () => {
    expect(() => selectLatestNodeLts([
      { version: 'v27.0.0-rc.1', lts: false }
    ])).toThrow(/no stable LTS release/);
  });
});
