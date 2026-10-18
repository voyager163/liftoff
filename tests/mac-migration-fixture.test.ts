import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { admitNativeStableMaterial } from '../src/adapters/distribution/native-metadata.js';

const fixtures: Awaited<ReturnType<typeof macMigrationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.cleanup();
});

describe('synthetic Mac migration fixture contracts, not genuine native qualification', () => {
  it('copies the canonical distribution contract rather than a script compatibility wrapper', async () => {
    const value = await macMigrationFixture('custom', false, false, undefined, { recovery: 'omitted' }); fixtures.push(value);
    expect(value.recoveryPreparation).toBe('omitted');
    expect(value.request).not.toHaveProperty('recovery');
    await expect(access(value.recovery)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(value.source, 'installation/native-bundle-contract.mjs')))
      .toEqual(await readFile('distribution/native/native-bundle-contract.mjs'));
    expect(await value.dependencies.upgrade.readJson(path.resolve('distribution/native/release-policy.json')))
      .toEqual(value.policy);
  });
  it('derives truthful prerelease context from selected fixture metadata without relaxing stable admission', async () => {
    const input = await macMigrationFixture('custom', false, false, undefined, { recovery: 'omitted' }); fixtures.push(input);
    const manifestPath = path.join(input.source, 'bundle.json');
    const syntheticManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    syntheticManifest.package.version = '0.13.0-dev.0';
    await writeFile(manifestPath, JSON.stringify(syntheticManifest));
    const value = await macMigrationFixture('custom', false, false, input.source, { recovery: 'omitted' }); fixtures.push(value);
    expect(value.recoveryPreparation).toBe('omitted');
    expect(value.request).not.toHaveProperty('recovery');
    expect(JSON.parse(value.material.record.toString()).version).toBe('0.13.0-dev.0');
    expect(value.material).toMatchObject({ stableTag: 'v0.13.0-dev.0', prerelease: true });
    expect(value.channel).toMatchObject({ version: '0.13.0-dev.0', exactApply: false });
    await expect(admitNativeStableMaterial(value.material, { target: 'darwin-arm64' }, value.policy))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });
  it.skipIf(process.platform === 'win32')('refuses the prerelease before invoking POSIX fixture managers', async () => {
    const input = await macMigrationFixture('custom', false, false, undefined, { recovery: 'omitted' }); fixtures.push(input);
    const manifestPath = path.join(input.source, 'bundle.json');
    const syntheticManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    syntheticManifest.package.version = '0.13.0-dev.0';
    await writeFile(manifestPath, JSON.stringify(syntheticManifest));
    const value = await macMigrationFixture('custom', false, false, input.source, { recovery: 'omitted' }); fixtures.push(value);
    const channel = vi.spyOn(value.dependencies.cask!, 'channel'), dispatch = vi.spyOn(value.dependencies.cask!, 'installExact');
    expect(await runMacMigration(value.request, value.dependencies)).toMatchObject({
      status: 'blocked', effects: 'none', blockers: ['native-native_invalid']
    });
    expect(channel).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
