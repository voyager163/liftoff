import { stringify } from 'yaml';
import { demand } from './native-build-files.mjs';

const repository = 'voyager163/liftoff';
const targets = ['darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];
const manifestVersion = '1.12.0';

function completeManifest(manifest) {
  demand(manifest?.schemaVersion === 1 && manifest.product === 'liftoff' && /^\d+\.\d+\.\d+$/.test(manifest.version) &&
    /^[a-f0-9]{40}$/.test(manifest.sourceCommit) && manifest.sourceCommit !== '0'.repeat(40), 'Channel definitions require exact native release identity, never development metadata');
  demand(manifest.targets && Object.keys(manifest.targets).length === 6 && targets.every((target) => manifest.targets[target]), 'Channel definitions require all six final artifact identities');
  for (const target of targets) {
    const payload = manifest.targets[target];
    const format = target.startsWith('win32') ? 'zip' : 'tar.gz';
    demand(payload.archiveFormat === format && /^[a-f0-9]{64}$/.test(payload.checksumSha256) && payload.checksumSha256 !== '0'.repeat(64) &&
      payload.archiveUrl === `https://github.com/${repository}/releases/download/v${manifest.version}/liftoff-v${manifest.version}-${target}.${format}`,
    `Channel artifact URL/format/checksum is inconsistent: ${target}`);
  }
}

export function renderHomebrewDefinition(manifest, registration) {
  completeManifest(manifest);
  demand(typeof registration?.packageId === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/liftoff$/.test(registration.packageId), 'A full registered upstream tap/cask identity is required');
  const floors = ['darwin-x64', 'darwin-arm64'].map((target) => manifest.targets[target].runtime.minimumHostVersion);
  demand(floors.every((floor) => typeof floor === 'string' && /^\d+\.\d+\.\d+$/.test(floor)), 'Cask definitions require explicit native manifest host floors');
  floors.sort((left, right) => {
    const a = left.split('.').map(Number), b = right.split('.').map(Number);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  return `# typed: false
# frozen_string_literal: true

cask "liftoff" do
  arch arm: "arm64", intel: "x64"

  version "${manifest.version}"
  sha256 arm:   "${manifest.targets['darwin-arm64'].checksumSha256}",
         intel: "${manifest.targets['darwin-x64'].checksumSha256}"

  url "https://github.com/${repository}/releases/download/v#{version}/liftoff-v#{version}-darwin-#{arch}.tar.gz"
  name "Liftoff"
  desc "Development lifecycle orchestration CLI"
  homepage "https://github.com/${repository}"

  conflicts_with formula: "liftoff"
  depends_on macos: ">= ${floors.at(-1)}"

  binary "liftoff-v#{version}-darwin-#{arch}/bin/liftoff"
end
`;
}

export function renderWinGetDefinitions(manifest, registration) {
  completeManifest(manifest);
  demand(typeof registration?.packageId === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(registration.packageId) &&
    typeof registration.publisher === 'string' && registration.publisher.length > 0 && registration.publisher.length <= 128 &&
    !/[\u0000-\u001f]/.test(registration.publisher), 'Exact registered WinGet package and publisher identities are required');
  const identity = { PackageIdentifier: registration.packageId, PackageVersion: manifest.version };
  const installers = ['x64', 'arm64'].map((arch) => {
    const payload = manifest.targets[`win32-${arch}`];
    demand(typeof payload.runtime.minimumHostVersion === 'string' && /^\d+(?:\.\d+){1,3}$/.test(payload.runtime.minimumHostVersion), 'WinGet definitions require an explicit per-target Windows floor');
    return {
      Architecture: arch, MinimumOSVersion: payload.runtime.minimumHostVersion,
      InstallerUrl: payload.archiveUrl, InstallerSha256: payload.checksumSha256,
      NestedInstallerFiles: [{ RelativeFilePath: `liftoff-v${manifest.version}-win32-${arch}\\bin\\liftoff.exe`, PortableCommandAlias: 'liftoff' }]
    };
  });
  const yaml = (value) => stringify(value, { lineWidth: 0 });
  return {
    version: yaml({ ...identity, DefaultLocale: 'en-US', ManifestType: 'version', ManifestVersion: manifestVersion }),
    installer: yaml({ ...identity, Platform: ['Windows.Desktop'], InstallerType: 'zip', NestedInstallerType: 'portable',
      Installers: installers, ManifestType: 'installer', ManifestVersion: manifestVersion }),
    locale: yaml({ ...identity, PackageLocale: 'en-US', Publisher: registration.publisher,
      PublisherUrl: `https://github.com/${repository}`, PackageName: 'Liftoff', License: 'GPL-3.0-only',
      ShortDescription: 'Development lifecycle orchestration CLI', ManifestType: 'defaultLocale', ManifestVersion: manifestVersion })
  };
}

export function directArtifactDescriptor(manifest) {
  completeManifest(manifest);
  return {
    schemaVersion: 1, kind: 'native-direct-artifacts-not-an-installation-receipt', product: 'liftoff',
    version: manifest.version, sourceCommit: manifest.sourceCommit,
    targets: Object.fromEntries(['linux-x64', 'linux-arm64'].map((target) => [target, manifest.targets[target]]))
  };
}
