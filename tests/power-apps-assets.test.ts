import { describe, expect, it } from 'vitest';
import { powerAppsCodeAppStarter } from '../src/catalogs.js';
import {
  powerAppsStarterCatalog,
  readPowerAppsStarterAsset,
  readPowerAppsStarterLicense
} from '../src/power-apps-assets.js';

describe('packaged Power Apps starter assets', () => {
  it('loads the immutable catalog only after validating paths, provenance, and hashes', () => {
    const paths = powerAppsStarterCatalog.files.map((file) => file.pathParts.join('/'));
    const logicalNames = powerAppsStarterCatalog.files.map((file) => file.logicalName);

    expect(powerAppsStarterCatalog.source).toMatchObject(powerAppsCodeAppStarter);
    expect(powerAppsStarterCatalog.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(powerAppsStarterCatalog.license.spdx).toBe('MIT');
    expect(readPowerAppsStarterLicense()).toContain('MIT License');
    expect(powerAppsStarterCatalog.lockfile).toMatchObject({
      nodeBaseline: '22.x',
      npmVersion: '11.7.0'
    });
    expect(powerAppsStarterCatalog.files).toHaveLength(46);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(logicalNames).size).toBe(logicalNames.length);
    expect(paths).toContain('package.json');
    expect(paths).toContain('package-lock.json');
    expect(paths).toContain('src/App.tsx');
    expect(paths).not.toContain('power.config.json');
    expect(paths.some((entry) => entry.includes('node_modules'))).toBe(false);
    expect(paths.some((entry) => entry.includes('dist'))).toBe(false);
    for (const file of powerAppsStarterCatalog.files) {
      expect(file.assetPath).toMatch(
        file.pathParts.join('/') === '.gitignore'
          ? /^packaged\/gitignore$/
          : /^starter\//
      );
      expect(readPowerAppsStarterAsset(file)).not.toContain('\0');
    }
  });
});
