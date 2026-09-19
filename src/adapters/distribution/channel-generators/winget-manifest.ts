import {
  canonicalRepository,
  canonicalWinGetId,
  nativeTargetFloors
} from '../../../domain/distribution/contracts.js';

const manifestVersion = '1.12.0';

export interface WinGetManifestInputs {
  version: string;
  x64Sha256: string;
  arm64Sha256: string;
  isPublisherApproved?: boolean;
  publisherName?: string;
}

export interface WinGetGenerationResult {
  versionYaml: string;
  installerYaml: string;
  localeYaml: string;
  isBlocked: boolean;
  blockerReason?: string;
}

export function renderWinGetManifests(inputs: WinGetManifestInputs): WinGetGenerationResult {
  const {
    version,
    x64Sha256,
    arm64Sha256,
    isPublisherApproved = false,
    publisherName = 'Voyager163'
  } = inputs;

  if (!isPublisherApproved) {
    return {
      versionYaml: '',
      installerYaml: '',
      localeYaml: '',
      isBlocked: true,
      blockerReason: `RELEASE BLOCKER: WinGet publisher "${publisherName}" / package ID "${canonicalWinGetId}" is not officially approved or established. Do not publish until approved.`
    };
  }

  const versionYaml = `PackageIdentifier: ${canonicalWinGetId}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${manifestVersion}
`;

  const installerYaml = `PackageIdentifier: ${canonicalWinGetId}
PackageVersion: ${version}
Platform:
  - Windows.Desktop
InstallerType: zip
NestedInstallerType: portable
Installers:
  - Architecture: x64
    MinimumOSVersion: ${nativeTargetFloors.win32.minimumHostVersion}
    InstallerUrl: https://github.com/${canonicalRepository}/releases/download/v${version}/liftoff-v${version}-win32-x64.zip
    InstallerSha256: ${x64Sha256}
    NestedInstallerFiles:
      - RelativeFilePath: liftoff-v${version}-win32-x64\\bin\\liftoff.exe
        PortableCommandAlias: liftoff
  - Architecture: arm64
    MinimumOSVersion: ${nativeTargetFloors.win32.minimumHostVersion}
    InstallerUrl: https://github.com/${canonicalRepository}/releases/download/v${version}/liftoff-v${version}-win32-arm64.zip
    InstallerSha256: ${arm64Sha256}
    NestedInstallerFiles:
      - RelativeFilePath: liftoff-v${version}-win32-arm64\\bin\\liftoff.exe
        PortableCommandAlias: liftoff
ManifestType: installer
ManifestVersion: ${manifestVersion}
`;

  const localeYaml = `PackageIdentifier: ${canonicalWinGetId}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${publisherName}
PublisherUrl: https://github.com/${canonicalRepository}
PackageName: Liftoff
License: GPL-3.0-only
ShortDescription: Development lifecycle orchestration CLI
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}
`;

  return {
    versionYaml,
    installerYaml,
    localeYaml,
    isBlocked: false
  };
}
