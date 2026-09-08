import { readFileSync } from 'node:fs';
import { canonicalSha256, sha256Hex } from '../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraphHash, currentActivationIdentity } from '../domain/governance/activation/graph.js';
import { liftoffVersion } from '../version.js';
import {
  governancePolicyVersion,
  renderCanonicalGovernancePolicy
} from '../repository-governance.js';
import {
  validateAssessmentCatalog as validateDomainAssessmentCatalog
} from '../domain/governance/assessment/catalog.js';
import { resolvePackageFileUrl } from '../adapters/packaged-assets/package-root.js';
import type {
  AssessmentCatalog,
  AssessmentTarget
} from './types.js';

export {
  assessmentInventoryContract,
  evaluatorIds,
  policyFamilies
} from '../domain/governance/assessment/catalog.js';

export function validateAssessmentCatalog(
  value: unknown,
  policyDigest = sha256Hex(renderCanonicalGovernancePolicy())
): AssessmentCatalog {
  return validateDomainAssessmentCatalog(value, {
    policyVersion: governancePolicyVersion,
    policyDigest
  });
}

export function loadAssessmentCatalog(): {
  catalog: AssessmentCatalog;
  target: AssessmentTarget;
} {
  const catalog = validateAssessmentCatalog(JSON.parse(readFileSync(
    resolvePackageFileUrl(
      'assets',
      'governance',
      'single-maintainer-gitflow',
      'assessment-controls.json'
    ),
    'utf8'
  )));
  return {
    catalog,
    target: {
      cliVersion: liftoffVersion,
      profile: catalog.profile,
      policyVersion: catalog.policyVersion,
      policyDigest: catalog.policyDigest,
      activationIdentity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      catalogSchemaVersion: 1,
      catalogDigest: canonicalSha256(catalog)
    }
  };
}
