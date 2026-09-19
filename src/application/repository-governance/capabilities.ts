import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';

export const repositoryGovernanceEngine = canonicalEngines['repository-governance'];

export const repositoryGovernanceCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'repository-governance',
    engine: 'repository-governance',
    owner: 'Repository Governance',
    title: 'Repository Governance Enforcement',
    description: 'Repository inspection and reviewed planning; complete owned-control execution and disposable live qualification remain blocked.',
    supportedProfiles: ['single-maintainer-gitflow'],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot'],
    commandSchema: {
      resultSchemaVersion: 3,
      reportContract: 'governance-output-v3'
    },
    authorization: {
      mechanism: 'reviewed-plan',
      defaultDecision: 'no',
      automationFlags: ['--plan', '--scope', '--inputs', '--execute'],
      consentRequirements: ['Explicit repository scope', 'Separate governance approve for the exact plan', 'Separately authorized disposable live qualification']
    },
    planner: 'built-in',
    executor: 'unavailable',
    verifier: 'built-in',
    recovery: 'none',
    effectClasses: ['repository-controls', 'filesystem-write'],
    compatibilityIdentities: ['governance-policy-v7'],
    qualificationState: 'implementation-missing',
    readOnly: false
  },
  {
    schemaVersion: 1,
    id: 'governance-assessment',
    engine: 'repository-governance',
    owner: 'Repository Governance',
    title: 'Governance Assessment',
    description: 'Read-only assessment of repository governance and policy compliance',
    supportedProfiles: ['single-maintainer-gitflow'],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['projectRoot'],
    commandSchema: {
      resultSchemaVersion: 1,
      reportContract: 'governance-assessment-report-v1'
    },
    authorization: {
      mechanism: 'read-only',
      defaultDecision: 'n/a',
      automationFlags: ['--live'],
      consentRequirements: ['Live metadata reads require explicit selection and existing authentication; no login or privilege expansion']
    },
    planner: 'built-in',
    executor: 'built-in',
    verifier: 'n/a',
    recovery: 'n/a',
    effectClasses: ['filesystem-read', 'network-read'],
    compatibilityIdentities: ['governance-policy-v7'],
    qualificationState: 'unqualified',
    readOnly: true
  }
];
