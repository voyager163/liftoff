import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../../domain/standards/profile-schema.js';

export const projectEvolutionEngine = canonicalEngines['project-evolution'];

export const projectEvolutionCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'project-update',
    engine: 'project-evolution',
    owner: 'Project Evolution',
    title: 'Managed Core Project Update',
    description: 'Compatibility-first, preview-gated workflow for supported generated and adopted projects',
    supportedProfiles: [...SUPPORTED_STANDARDS_PROFILE_IDS],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot'],
    commandSchema: {
      resultSchemaVersion: 3,
      reportContract: 'update-output-v3'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--approve-plan', '--check', '--force'],
      consentRequirements: [
        'Default-No terminal approval or exact current plan fingerprint',
        'Forced owned-core conflicts require their separately reviewed plan',
        'Any local revalidation commands and their host effects must be included in the reviewed scope'
      ]
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'attributable-journal',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution'],
    compatibilityIdentities: ['manifest-v2', 'manifest-v3', 'manifest-v4', 'manifest-v5', 'manifest-v6', 'manifest-v7', 'manifest-v8'],
    qualificationState: 'unqualified',
    readOnly: false
  },
  {
    schemaVersion: 1,
    id: 'project-repair',
    engine: 'project-evolution',
    owner: 'Project Evolution',
    title: 'Reviewed Project Repair',
    description: 'Registered recipe execution for project layout, application patch, and baseline settings',
    supportedProfiles: [...SUPPORTED_STANDARDS_PROFILE_IDS],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot'],
    commandSchema: {
      resultSchemaVersion: 2,
      contractVersion: 1,
      reportContract: 'repair-report-v2'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--approve-plan', '--verify-plan', '--allow-dependency-preparation', '--allow-network', '--live', '--check', '--recover'],
      consentRequirements: [
        'Default-No terminal approval or the exact current verification/file plan',
        'Project-code checks, locked preparation, declared network effects, and final file writes require independent authority',
        'Live metadata inspection requires explicit selection and an exact subscription',
        'Recovery is limited to original attributable recorded effects'
      ]
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'attributable-journal',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution', 'network-read'],
    compatibilityIdentities: ['repair-contract-v1'],
    qualificationState: 'unqualified',
    readOnly: false
  },
  {
    schemaVersion: 1,
    id: 'project-adoption',
    engine: 'project-evolution',
    owner: 'Project Evolution',
    title: 'Reviewed In-Place Adoption',
    description: 'Reviewed adoption of existing supported-stack repositories with truthful provenance',
    supportedProfiles: [...SUPPORTED_STANDARDS_PROFILE_IDS],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot'],
    commandSchema: {
      resultSchemaVersion: 1,
      reportContract: 'adoption-report-v1'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--check', '--verify-plan', '--allow-dependency-preparation', '--allow-network', '--approve-plan', '--recover'],
      consentRequirements: [
        'Default-No terminal approval or exact current adoption plan',
        'Preparation, project/framework code, network access, and file/metadata commit require independent authority',
        'Recovery cannot authorize a new adoption or overwrite unrelated work'
      ]
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'attributable-journal',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution', 'network-read'],
    compatibilityIdentities: ['manifest-v8', 'adoption-contract-v1', 'adoption-record-v1'],
    qualificationState: 'unqualified',
    readOnly: false
  },
  {
    schemaVersion: 1,
    id: 'project-migration',
    engine: 'project-evolution',
    owner: 'Project Evolution',
    title: 'Fresh-Target Project Migration',
    description: 'Source-read-only fresh-target project generation from existing project facts',
    supportedProfiles: SUPPORTED_STANDARDS_PROFILE_IDS.filter((profile) => profile !== 'vue-component'),
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['sourceRoot', 'targetRoot'],
    commandSchema: {
      outputFormat: 'human',
      resultSchemaVersion: null
    },
    authorization: {
      mechanism: 'flag-consent',
      defaultDecision: 'no',
      automationFlags: ['--yes', '--force', '--install-tools', '--install-dependencies', '--configure-openspec-profile'],
      consentRequirements: [
        'The source remains read-only and the destination must be fresh; force does not bypass that boundary',
        'Tool installation, project dependency installation, and global framework profile changes require their separate flags'
      ]
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'none',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution', 'network-read'],
    compatibilityIdentities: ['manifest-v8'],
    qualificationState: 'unqualified',
    readOnly: false
  }
];
