import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { liftoffManifestArtifactVersion } from '../domain/governance/policy/identity.js';
import { SUPPORTED_MANIFEST_VERSIONS } from '../domain/project/manifest/reader.js';
import { minimumNodeVersion } from '../runtime.js';
import { liftoffVersion } from '../version.js';
import { projectCatalog } from './project/catalog.js';
import { builtinPluginRegistry } from './project/plugins.js';
import { repairCapabilities } from './repair/capabilities.js';
import { updateReportSchemaVersion } from './update/output.js';
import { modernGovernanceReportSchemaVersion } from './governance/modern-inspection.js';
import { modernLocalCommandReportSchemaVersion } from './governance/modern-local-request.js';
import { modernLocalCompletionReportSchemaVersion } from './governance/modern-local-completion-request.js';
import { modernRevalidationCommandReportSchemaVersion } from './update/modern-revalidation-request.js';

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
      modernReadOnly: {
        manifestRead: [8],
        commands: ['validate', 'doctor', 'dev', 'infra', 'governance status', 'governance resume', 'governance verify'],
        governanceReport: modernGovernanceReportSchemaVersion,
        execution: false,
        scope: 'Source inspection and independently reconstructed local publication proof only; no current writers or provider completion.'
      },
      modernLocalVerification: {
        manifestRead: [8], report: modernLocalCommandReportSchemaVersion,
        selector: 'governance <plan|approve|apply-next> --scope local --local-operation verify',
        requests: ['verify-local', 'verify-openspec-local', 'verify-openspec-initialized', 'verify-openspec-archived'],
        explicitRequest: true, separateConsent: true, explicitExecution: true,
        workflowFinalization: false, publication: false, successorRevalidation: false,
        scope: 'Exact captured-input verification in a private workspace; not a sandbox or full project readiness. Initialized OpenSpec requires a separate generated-baseline scope attestation.'
      },
      modernLocalCompletion: {
        manifestRead: [8], report: modernLocalCompletionReportSchemaVersion,
        selectors: {
          finalize: 'governance <plan|approve|apply-next> --scope local --local-operation finalize',
          publish: 'governance <plan|approve|apply-next|recover> --scope local --local-operation publish'
        },
        workflows: ['manual', 'spec-kit'],
        profiles: ['none', 'single-maintainer-gitflow', 'team-gitflow'],
        requests: ['finalize-local', 'review-local-publication'],
        separateFinalizationConsent: true, separatePublicationConsent: true, explicitExecution: true,
        attributedRecovery: true, openSpecFinalization: false, successorRevalidation: false, providerOperations: false,
        scope: 'Existing admitted fresh/current local projects only. Exact-file publication requires original verification, workflow-specific finalization, independent exact-byte consent and current readback. Saved progress is not current proof; no generation, conversion or whole-directory rollback.'
      },
      modernSuccessorRevalidation: {
        manifestRead: [8], report: modernRevalidationCommandReportSchemaVersion,
        selector: 'governance <plan|approve|apply-next|recover> --scope local --local-operation revalidate-successor',
        requests: ['revalidate-successor', 'review-successor-revalidation'],
        separatePublicationConsent: true, explicitExecution: true, attributedRecovery: true,
        committedIncompleteExit: 2, successorCreation: false, workflowFinalization: false, providerOperations: false,
        scope: 'Existing supported activation-history successors only. Completed Spec Kit or archived OpenSpec verification supplies fresh local proof; exact-byte publication preserves original transition/preparation identities. Committed incomplete revalidation stays active; saved progress is not current proof.'
      },
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
      privateApis: 'OpenSpec finalization, successor creation, Manual/team generation and general v8 project writer APIs are not public CLI support.',
      registration: 'Command syntax does not imply that every option combination is valid or an executor is available.'
    }
  };
}
