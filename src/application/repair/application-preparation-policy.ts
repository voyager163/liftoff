import { workstationRequirementCatalog } from '../../workstation-catalog.js';
import type { ApplicationToolId, ApplicationToolRequirement } from './application-preparation-types.js';

export const applicationPreparationBounds = {
  providers: 4,
  manifestBytes: 1024 * 1024,
  lockPackages: 4096,
  toolFileBytes: 256 * 1024 * 1024,
  probeTimeoutMs: 15_000,
  probeOutputBytes: 8192,
  preparationTimeoutMs: 180_000,
  preparationOutputBytes: 64 * 1024,
  privateFiles: 50_000,
  privateDirectories: 10_000,
  privateDepth: 40,
  privateBytes: 1024 * 1024 * 1024
} as const;

export function applicationToolRequirement(id: ApplicationToolId): ApplicationToolRequirement {
  const definition = workstationRequirementCatalog[id];
  if (!definition.minimumVersion || !definition.releaseLine) {
    throw new Error('Packaged application preparation tool requirements are incomplete.');
  }
  return {
    minimumVersion: definition.minimumVersion, releaseLine: definition.releaseLine,
    allowPrerelease: definition.allowPrerelease === true
  };
}

export const applicationPackageSources = {
  npmjs: {
    family: 'npm', registry: 'https://registry.npmjs.org/',
    artifactOrigins: ['https://registry.npmjs.org'], remoteProxyOptIn: false
  },
  'microsoft-npm': {
    family: 'npm', registry: 'https://packagefeedproxy.microsoft.io/npm/',
    artifactOrigins: ['https://packagefeedproxy.microsoft.io', 'https://pkgs.dev.azure.com'],
    remoteProxyOptIn: true
  },
  pypi: {
    family: 'python', registry: 'https://pypi.org/simple',
    artifactOrigins: ['https://files.pythonhosted.org', 'https://pypi.org'], remoteProxyOptIn: false
  },
  'microsoft-pypi': {
    family: 'python', registry: 'https://packagefeedproxy.microsoft.io/pypi/simple',
    artifactOrigins: ['https://packagefeedproxy.microsoft.io', 'https://pkgs.dev.azure.com'],
    remoteProxyOptIn: false
  },
  'go-proxy': {
    family: 'go', registry: 'https://proxy.golang.org',
    artifactOrigins: ['https://proxy.golang.org', 'https://sum.golang.org'], remoteProxyOptIn: false
  }
} as const;

/** Static packaged capability data; importing it resolves no executable and runs no probe. */
export const applicationPreparationSupport = {
  schemaVersion: 1,
  kind: 'liftoff-application-preparation-support',
  providers: [
    {
      id: 'npm-ci', version: 1, targetIdentities: ['node-backend-package', 'frontend-package'],
      inputs: ['package.json', 'package-lock.json'], lockfileVersions: [3],
      recordedIntegrityAlgorithms: ['sha512', 'sha384', 'sha256', 'sha1'],
      bundledArtifacts: 'only-explicit-children-of-integrity-bound-registry-packages',
      packageSources: ['npmjs', 'microsoft-npm'],
      tools: { node: applicationToolRequirement('node'), npm: applicationToolRequirement('npm') },
      lifecycle: 'disabled', network: 'separate-explicit-consent',
      effects: ['private-node_modules', 'private-cache', 'declared-build-output'],
      limitations: ['No workspaces, local/VCS/authenticated sources, global installs, lock updates, or install hooks.']
    },
    {
      id: 'uv-locked-sync', version: 1, targetIdentities: ['backend-pyproject'],
      inputs: ['pyproject.toml', 'uv.lock'], lockfileVersions: [1],
      packageSources: ['pypi', 'microsoft-pypi'],
      tools: { python: applicationToolRequirement('python'), uv: applicationToolRequirement('uv') },
      lifecycle: 'disabled', network: 'separate-explicit-consent',
      effects: ['private-virtual-environment-from-existing-interpreter-copies', 'private-cache', 'declared-test-cache'],
      limitations: ['Locked wheel-only sync; no interpreter download, source builds, project installation, workspaces, or local/VCS/authenticated sources.']
    },
    {
      id: 'go-mod-download', version: 1, targetIdentities: ['go-backend-module'],
      inputs: ['go.mod', 'go.sum'], packageSources: ['go-proxy'],
      tools: { go: applicationToolRequirement('go') },
      lifecycle: 'disabled', network: 'separate-explicit-consent',
      effects: ['private-module-cache', 'private-build-cache'],
      limitations: ['Local installed toolchain only; no go.work, replacements, VCS fetching, global cache reuse, or module/checksum updates.']
    }
  ],
  bounds: applicationPreparationBounds,
  securitySandbox: false,
  absentPreparation: 'none',
  frontendQualification: 'build-only-unless-the-project-declares-tests'
} as const;
