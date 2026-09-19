import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';

export const distributionEngine = canonicalEngines['distribution'];

export const distributionCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'cli-upgrade',
    engine: 'distribution',
    owner: 'Distribution and CLI Upgrade',
    title: 'CLI Self-Upgrade',
    description: 'Installation-owner-aware native upgrades for proven manager channels',
    supportedProfiles: ['all'],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: [],
    commandSchema: {
      resultSchemaVersion: 1
    },
    authorization: {
      mechanism: 'command-invocation'
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'workspace-seal',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution', 'network-read'],
    compatibilityIdentities: ['native-manifest-v1'],
    qualificationState: 'unqualified',
    readOnly: false
  },
  {
    schemaVersion: 1,
    id: 'installation-inspection',
    engine: 'distribution',
    owner: 'Distribution and CLI Upgrade',
    title: 'Installation Ownership Inspection',
    description: 'Non-mutating discovery of installation manager, path, and legacy package conflicts',
    supportedProfiles: ['all'],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: [],
    commandSchema: {
      resultSchemaVersion: 1
    },
    authorization: {
      mechanism: 'read-only',
      defaultDecision: 'n/a'
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'n/a',
    recovery: 'n/a',
    effectClasses: ['filesystem-read'],
    compatibilityIdentities: ['native-manifest-v1'],
    qualificationState: 'unqualified',
    readOnly: true
  },
  {
    schemaVersion: 1,
    id: 'installation-migration',
    engine: 'distribution',
    owner: 'Distribution and CLI Upgrade',
    title: 'Direct npm-to-Native Installation Handover',
    description: 'Explicitly reviewed migration from legacy npm installation to verified native manager',
    supportedProfiles: ['all'],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['targetOwner'],
    commandSchema: {
      resultSchemaVersion: 1,
      reportContract: 'installation-migration-plan-v1'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--approve-plan', '--to']
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'built-in',
    recovery: 'attributable-journal',
    effectClasses: ['filesystem-read', 'filesystem-write', 'process-execution'],
    compatibilityIdentities: ['native-manifest-v1'],
    qualificationState: 'unqualified',
    readOnly: false
  }
];
