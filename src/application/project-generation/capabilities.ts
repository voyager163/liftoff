import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../../domain/standards/profile-schema.js';

export const projectGenerationEngine = canonicalEngines['project-generation'];

export const projectGenerationCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'project-generation',
    engine: 'project-generation',
    owner: 'Project Generation',
    title: 'Project Scaffold and Generation',
    description: 'Compose and stage approved new-project artifacts from catalog-based components',
    supportedProfiles: SUPPORTED_STANDARDS_PROFILE_IDS.filter((profile) => profile !== 'vue-component'),
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectName', 'workload'],
    commandSchema: {
      outputFormat: 'human',
      resultSchemaVersion: null
    },
    authorization: {
      mechanism: 'flag-consent',
      defaultDecision: 'no',
      automationFlags: ['--yes', '--force', '--install-tools', '--install-dependencies', '--configure-openspec-profile'],
      consentRequirements: [
        'Project defaults and plan confirmation do not authorize separate host or dependency changes',
        'Only explicitly selected regular-file conflicts may be replaced',
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
