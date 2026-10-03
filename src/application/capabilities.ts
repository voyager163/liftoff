import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { liftoffManifestArtifactVersion } from '../domain/governance/policy/identity.js';
import { SUPPORTED_MANIFEST_VERSIONS } from '../domain/project/manifest/reader.js';
import { minimumNodeVersion } from '../runtime.js';
import { liftoffVersion } from '../version.js';
import { projectCatalog } from './project/catalog.js';
import { builtinPluginRegistry } from './project/plugins.js';
import { repairCapabilities } from './repair/capabilities.js';
import { updateReportSchemaVersion } from './update/output.js';

export function installedCapabilities() {
  const registry = builtinPluginRegistry();
  return {
    schemaVersion: 1 as const,
    kind: 'liftoff-capabilities' as const,
    cliVersion: liftoffVersion,
    projectIndependent: true,
    schemas: {
      manifestRead: [...SUPPORTED_MANIFEST_VERSIONS],
      manifestWrite: liftoffManifestArtifactVersion,
      reports: {
        capabilities: 1, validate: 1, doctor: 1, upgrade: 1,
        update: updateReportSchemaVersion, governance: 2, governanceAssessment: 1
      },
      repair: { ...repairCapabilities.schemas }
    },
    plugins: {
      apiVersion: registry.apiVersion,
      registryDigest: registry.registryDigest,
      pluginSetDigest: registry.pluginSetDigest,
      inventory: registry.inventory.map(({ category, id, apiVersion, contentVersion, contentDigest, hostPlatforms, supports }) =>
        ({ category, id, apiVersion, contentVersion, contentDigest, hostPlatforms, supports }))
    },
    workflows: projectCatalog.specWorkflows.map(({ id, default: isDefault }) => ({ id, default: isDefault })),
    agents: projectCatalog.codingAgents.map(({ id, inputName }) => ({ id, inputName })),
    profiles: projectCatalog.governanceProfiles.map(({ id, policyVersion }) => ({
      id, policyVersion: policyVersion ?? 'none'
    })),
    repair: structuredClone(repairCapabilities),
    governance: {
      phases: Object.entries(phaseCapabilities).map(([phase, capability]) => ({
        phase, ...capability,
        productionExecutorAvailable: capability.executor === 'built-in' && capability.blocker === undefined
      })),
      scope: 'A registered command or built-in phase still requires applicable project state and independent effect approval.'
    },
    runtime: {
      distribution: 'node/npm',
      minimumNodeVersion,
      nativeDistribution: false,
      hostSupport: 'Plugin hostPlatforms are declared composition support, not installed tools or native-package qualification.',
      readiness: 'No tool, project, credential, network or provider readiness is probed by capability discovery.'
    },
    boundaries: {
      thirdPartyPluginLoading: false,
      publicStatefulMigration: false,
      projectTelemetryEnrollment: false,
      capabilityIsApproval: false,
      privateApis: 'Internal modern source, Manual/team and v8 candidate APIs are not public CLI support.',
      registration: 'Command syntax does not imply that every option combination is valid or an executor is available.'
    }
  };
}
