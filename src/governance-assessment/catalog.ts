import { readFileSync } from 'node:fs';
import { canonicalSha256, sha256Hex } from '../domain/governance/activation/canonical-json.js';
import type { ModernWorkflow } from '../domain/governance/activation/modern-record-contracts.js';
import { modernActivationSourceContracts } from '../domain/governance/policy/identity.js';
import {
  validateAssessmentCatalog as validateDomainAssessmentCatalog
} from '../domain/governance/assessment/catalog.js';
import { resolvePackageFileUrl } from '../adapters/packaged-assets/package-root.js';
import type {
  AssessmentCatalog,
  AssessmentProfile,
  AssessmentTarget
} from './types.js';

export {
  assessmentInventoryContract,
  evaluatorIds,
  policyFamilies
} from '../domain/governance/assessment/catalog.js';

export function validateAssessmentCatalog(
  value: unknown,
  policyDigest = installedAssessmentSource('single-maintainer-gitflow', 'openspec').identity.policyDigest.slice(7)
): AssessmentCatalog {
  const source = installedAssessmentSource('single-maintainer-gitflow', 'openspec');
  return validateDomainAssessmentCatalog(value, {
    profile: 'single-maintainer-gitflow',
    policyVersion: source.identity.policyVersion,
    policyDigest
  });
}

function installedAssessmentSource(profile: AssessmentProfile, workflow: ModernWorkflow) {
  const source = modernActivationSourceContracts().find(entry =>
    entry.identity.profile === profile && entry.identity.workflow === workflow
  );
  if (!source) throw new Error(`No installed assessment source exists for ${profile}/${workflow}.`);
  return source;
}

export function loadAssessmentCatalog(
  profile: AssessmentProfile = 'single-maintainer-gitflow',
  workflow: ModernWorkflow = 'openspec'
): {
  catalog: AssessmentCatalog;
  target: AssessmentTarget;
} {
  const source = installedAssessmentSource(profile, workflow);
  const policyFile = profile === 'single-maintainer-gitflow' ? 'policy-v7.md' : 'policy-v1.md';
  const policyDigest = sha256Hex(readFileSync(
    resolvePackageFileUrl('assets', 'governance', profile, policyFile),
    'utf8'
  ));
  const catalog = validateDomainAssessmentCatalog(JSON.parse(readFileSync(
    resolvePackageFileUrl('assets', 'governance', profile, 'assessment-controls.json'),
    'utf8'
  )), {
    profile,
    policyVersion: source.identity.policyVersion,
    policyDigest
  });
  if (source.identity.policyDigest !== `sha256:${policyDigest}`) {
    throw new Error('Assessment policy bytes do not match the installed governance source identity.');
  }
  return {
    catalog,
    target: {
      cliVersion: source.identity.liftoffVersion,
      profile,
      policyVersion: source.identity.policyVersion,
      policyDigest,
      activationIdentity: source.identity,
      phaseGraphHash: source.identity.phaseGraphHash,
      catalogSchemaVersion: 1,
      catalogDigest: canonicalSha256(catalog)
    }
  };
}
