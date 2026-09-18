import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../../domain/standards/profile-schema.js';

export const azureActivationEngine = canonicalEngines['azure-activation'];

export const azureActivationCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'azure-activation',
    engine: 'azure-activation',
    owner: 'Azure Activation',
    title: 'Azure Environment Activation',
    description: 'Explicit account discovery and provider adapters; complete private-state/provisioning/qualification producers and recovery remain blocked.',
    supportedProfiles: SUPPORTED_STANDARDS_PROFILE_IDS.filter((profile) => profile !== 'vue-component'),
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot', 'inputsFile'],
    commandSchema: {
      resultSchemaVersion: 3,
      reportContract: 'governance-output-v3'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--plan', '--scope', '--inputs', '--execute'],
      consentRequirements: ['Exact public subscription/tenant/environment binding', 'Separate governance approve for the exact plan', 'Exact disposable targets, actors, effects, spending and time authorization for live qualification']
    },
    planner: 'built-in',
    executor: 'unavailable',
    verifier: 'built-in',
    recovery: 'none',
    effectClasses: ['cloud-state', 'process-execution', 'filesystem-write'],
    compatibilityIdentities: ['activation-contract-v4'],
    qualificationState: 'implementation-missing',
    readOnly: false
  }
];
