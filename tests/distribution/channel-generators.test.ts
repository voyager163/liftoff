import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderHomebrewCask } from '../../src/adapters/distribution/channel-generators/homebrew-cask.js';
import { renderWinGetManifests } from '../../src/adapters/distribution/channel-generators/winget-manifest.js';
import { generateDirectReceiptContent } from '../../src/adapters/distribution/channel-generators/direct-receipt.js';
import { renderHomebrewDefinition, renderWinGetDefinitions } from '../../scripts/distribution/channel-definitions.mjs';
import { validManifest } from './manifest-fixture.js';

function channelManifest() {
  const manifest = validManifest();
  for (const [target, payload] of Object.entries(manifest.targets)) {
    payload.archiveUrl = `https://github.com/voyager163/liftoff/releases/download/v${manifest.version}/liftoff-v${manifest.version}-${target}.${payload.archiveFormat}`;
  }
  return manifest;
}

describe('channel manifest generators and release blockers', () => {
  it('blocks Homebrew Cask generation when tap is not approved', () => {
    const unapproved = renderHomebrewCask({
      version: '0.13.0',
      arm64Sha256: 'a'.repeat(64),
      x64Sha256: 'b'.repeat(64),
      isTapApproved: false
    });

    expect(unapproved.isBlocked).toBe(true);
    expect(unapproved.blockerReason).toContain('RELEASE BLOCKER');
    expect(unapproved.rubySource).toBe('');
  });

  it('renders valid Homebrew Cask ruby definition when tap is approved', () => {
    const approved = renderHomebrewCask({
      version: '0.13.0',
      arm64Sha256: 'a'.repeat(64),
      x64Sha256: 'b'.repeat(64),
      isTapApproved: true
    });

    expect(approved.isBlocked).toBe(false);
    expect(approved.rubySource).toContain('cask "liftoff" do');
    expect(approved.rubySource).toContain('version "0.13.0"');
    expect(approved.rubySource).toContain('conflicts_with formula: "liftoff"');
    expect(approved.rubySource).toContain('depends_on macos: ">= 13.5.0"');
    expect(approved.rubySource).not.toContain('zap');
  });

  it('keeps the retained cask format identical to the canonical build renderer without granting owner authority', () => {
    const manifest = channelManifest();
    const retained = renderHomebrewCask({
      version: manifest.version, arm64Sha256: manifest.targets['darwin-arm64'].checksumSha256,
      x64Sha256: manifest.targets['darwin-x64'].checksumSha256, isTapApproved: true
    });
    expect(retained.rubySource).toBe(renderHomebrewDefinition(manifest, { packageId: 'voyager163/liftoff/liftoff' }));
  });

  it('blocks WinGet generation when publisher is not approved', () => {
    const unapproved = renderWinGetManifests({
      version: '0.13.0',
      x64Sha256: 'a'.repeat(64),
      arm64Sha256: 'b'.repeat(64),
      isPublisherApproved: false
    });

    expect(unapproved.isBlocked).toBe(true);
    expect(unapproved.blockerReason).toContain('RELEASE BLOCKER');
    expect(unapproved.installerYaml).toBe('');
  });

  it('renders valid WinGet YAML manifests when publisher is approved', () => {
    const approved = renderWinGetManifests({
      version: '0.13.0',
      x64Sha256: 'a'.repeat(64),
      arm64Sha256: 'b'.repeat(64),
      isPublisherApproved: true
    });

    expect(approved.isBlocked).toBe(false);
    expect(approved.versionYaml).toContain('PackageIdentifier: voyager163.liftoff');
    expect(approved.installerYaml).toContain('MinimumOSVersion: 10.0.17763');
    expect(approved.installerYaml).toContain('InstallerType: zip\nNestedInstallerType: portable');
    expect(approved.installerYaml).toContain('RelativeFilePath: liftoff-v0.13.0-win32-x64\\bin\\liftoff.exe');
    expect(approved.installerYaml).toContain('RelativeFilePath: liftoff-v0.13.0-win32-arm64\\bin\\liftoff.exe');
    expect(approved.installerYaml).not.toContain('liftoff.cmd');
    expect(approved.localeYaml).toContain('PackageName: Liftoff');
  });

  it('keeps all retained WinGet documents semantically identical to the canonical build renderer', () => {
    const manifest = channelManifest();
    const retained = renderWinGetManifests({
      version: manifest.version, x64Sha256: manifest.targets['win32-x64'].checksumSha256,
      arm64Sha256: manifest.targets['win32-arm64'].checksumSha256, isPublisherApproved: true
    });
    const canonical = renderWinGetDefinitions(manifest, { packageId: 'voyager163.liftoff', publisher: 'Voyager163' });
    expect(parse(retained.versionYaml)).toEqual(parse(canonical.version));
    expect(parse(retained.installerYaml)).toEqual(parse(canonical.installer));
    expect(parse(retained.localeYaml)).toEqual(parse(canonical.locale));
  });

  it('generates direct install receipt content', () => {
    const receipt = generateDirectReceiptContent({
      version: '0.13.0',
      target: 'linux-x64',
      sourceCommit: '70d10881b46d873118d825735696f39b6d35ebe0',
      installRoot: '/usr/local/liftoff',
      versionRoot: '/usr/local/liftoff/versions/0.13.0',
      launcherPath: '/usr/local/bin/liftoff',
      runtime: { nodeVersion: '24.20.0', minimumGlibc: '2.31' },
      checksumSha256: 'c'.repeat(64)
    });

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.product).toBe('liftoff');
    expect(receipt.target).toBe('linux-x64');
    expect(receipt.authority).toBeUndefined();
  });
});
