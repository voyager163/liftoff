import type { PublicCapabilityV1 } from '../../protocol/capabilities.js';
import { canonicalEngines } from '../../domain/execution/engines.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../../domain/standards/profile-schema.js';

export const standardsAssessmentEngine = canonicalEngines['standards-assessment'];

export const standardsAssessmentCapabilities: readonly PublicCapabilityV1[] = [
  {
    schemaVersion: 1,
    id: 'standards-assessment',
    engine: 'standards-assessment',
    owner: 'Standards and Assessment',
    title: 'Whole-Project Standards Assessment',
    description: 'Evidence-backed whole-project inventory and standards-gap reporting before or after initialization',
    supportedProfiles: [...SUPPORTED_STANDARDS_PROFILE_IDS],
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredInputs: ['targetPath'],
    commandSchema: {
      resultSchemaVersion: 1,
      reportContract: 'assessment-report-v1'
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
    compatibilityIdentities: ['standards-catalog-v1'],
    qualificationState: 'unqualified',
    readOnly: true
  }
];
