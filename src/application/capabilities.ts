import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { modernActivationSourceContracts } from '../domain/governance/policy/identity.js';
import { SUPPORTED_MANIFEST_VERSIONS } from '../domain/project/manifest/reader.js';
import { minimumNodeVersion } from '../runtime.js';
import { liftoffVersion } from '../version.js';
import { projectCatalog } from './project/catalog.js';
import { modernSourceRegistry } from './project/modern-plugins.js';
import { repairCapabilities } from './repair/capabilities.js';
import { currentUpdateReportSchemaVersion } from './update/current-request.js';
import { modernGovernanceReportSchemaVersion } from './governance/modern-inspection.js';
import { modernLocalCommandReportSchemaVersion } from './governance/modern-local-request.js';
import { modernLocalCompletionReportSchemaVersion } from './governance/modern-local-completion-request.js';
import { modernRevalidationCommandReportSchemaVersion } from './update/modern-revalidation-request.js';
import { manualInfrastructurePolicy } from '../domain/governance/activation/modern-manual-infrastructure.js';
import { protectedCompletionIndexEncoding } from '../domain/governance/activation/modern-local-completion.js';

export function installedCapabilities() {
  const registry = modernSourceRegistry();
  return {
    schemaVersion: 1 as const,
    kind: 'liftoff-capabilities' as const,
    cliVersion: liftoffVersion,
    projectIndependent: true,
    schemas: {
      manifestRead: [...SUPPORTED_MANIFEST_VERSIONS, 8],
      manifestWrite: 8,
      currentGeneration: {
        manifestWrite: 8,
        commands: ['plan', 'init', 'migrate'],
        workflows: projectCatalog.developmentWorkflows.map(({ id }) => id),
        defaultWorkflow: 'openspec',
        manualAgentsOptional: true,
        frameworkInitialization: 'Official initialization is required only for OpenSpec and Spec Kit.',
        scope: 'Fresh project generation and sibling migration scaffolding. No automatic source adoption, local verification/finalization, provider operations, or live governance activation.'
      },
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
        requests: ['verify-local', 'verify-manual-native', 'verify-openspec-local', 'verify-openspec-initialized', 'verify-openspec-archived'],
        explicitRequest: true, separateConsent: true, explicitExecution: true,
        workflowFinalization: false, publication: false, successorRevalidation: false,
        nativeManual: {
          consent: 'approve-manual-native', previewSchema: 6, consentSchema: 5, resultSchema: 5,
          requiredScopes: ['infrastructurePreparation', 'infrastructureNetwork'],
          platform: manualInfrastructurePolicy.qualifiedPlatform, architecture: manualInfrastructurePolicy.qualifiedArchitecture,
          tofuVersion: manualInfrastructurePolicy.tofuVersion, providerSource: manualInfrastructurePolicy.providerSource,
          providerVersion: manualInfrastructurePolicy.providerVersion,
          admission: 'Actual native HCL runtime, installed tools and captured source are revalidated; discovery performs no probes.'
        },
        scope: 'Exact captured-input verification in a private workspace; not a sandbox or full project readiness. Native Manual needs independent locked-provider preparation/network consent; local provider execution grants no Azure/GitHub resource operations. Initialized OpenSpec requires a separate generated-baseline scope attestation.'
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
        artifactSchemas: [1, 2, 3], protectedIndexArtifact: protectedCompletionIndexEncoding,
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
      currentUpdate: {
        manifestRead: [...SUPPORTED_MANIFEST_VERSIONS, 8], manifestWrite: 8, report: currentUpdateReportSchemaVersion,
        command: 'update', preview: 'update --check', recovery: 'update <project> --recover --approve-plan <fingerprint>',
        separateConsent: true, explicitRecovery: true, configurationBound: true, committedIncompleteExit: 2,
        applicationWrites: false, workflowChanges: false, profileChanges: false, providerOperations: false,
        scope: 'Historical-to-v8 successor and current-v8 managed maintenance. Recorded project, plugins, compatible layout, original history and configuration are preserved. Local revalidation and other transitions remain separate.'
      },
      projectAssessment: {
        command: 'assess', report: 1, modes: ['local', 'live'], readOnly: true,
        comparisonProfiles: ['none', 'single-maintainer-gitflow', 'team-gitflow'],
        explicitNonGitRoot: true, liveMetadata: true, liveProviders: ['github'], liveConformance: false,
        credentialEnrollment: false, projectExecution: false, projectWrites: false, telemetry: false,
        scope: 'Bounded local metadata, declaration names and exact current managed-byte comparisons. Runtime constraints, references, agent behavior, effective governance and deployment proof remain unobserved. Team policy metadata comparison is not public team generation or enforcement support.',
        recommendations: 'Advisory separate lanes only. Unavailable adoption, workflow/profile/plugin transitions, provider activation and deployed-state migration have no executable recommendation.',
        liveScope: 'Explicit bounded GitHub metadata reads for the verified local repository binding, applicable main/develop/release/hotfix refs and declared current environments, plus fixed GitHub Actions app metadata. No account/runner/Azure discovery; observed metadata is not current-profile conformance or activation proof.'
      },
      reports: {
        capabilities: 1, validate: 1, doctor: 1, upgrade: 1,
        update: currentUpdateReportSchemaVersion, governance: 2, governanceAssessment: 1, projectAssessment: 1
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
    workflows: projectCatalog.developmentWorkflows.map(({ id, default: isDefault }) => ({ id, default: isDefault })),
    agents: projectCatalog.codingAgents.map(({ id, inputName }) => ({ id, inputName })),
    profiles: projectCatalog.governanceProfiles.map(({ id }) => {
      if (id === 'none') return { id, policyVersion: 'none' };
      const source = modernActivationSourceContracts().find(({ identity }) => identity.profile === id && identity.workflow === 'openspec');
      if (!source) throw new Error('No current governance source matches the public profile.');
      return { id, policyVersion: source.identity.policyVersion };
    }),
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
      privateApis: 'OpenSpec finalization, team generation and arbitrary v8 project writer APIs are not public CLI support. Fresh generation is limited to currentGeneration. Historical successor creation is limited to the separately advertised currentUpdate scope.',
      registration: 'Command syntax does not imply that every option combination is valid or an executor is available.'
    }
  };
}
