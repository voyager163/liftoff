import type {
  AssessmentDiagnostic, AssessmentInventory, AssessmentTarget, StandardsProfileIdentity
} from '../../domain/standards-assessment/types.js';
import {
  adaptStandardsProfile, resolveProfileId, makeUnsupportedProfile, makeUnresolvedProfile
} from '../../domain/standards-assessment/catalog.js';
import { detectProjectComponents } from '../../adapters/filesystem/standards-assessment/evidence.js';
import { loadPackagedProfilesCatalog, PackagedResourceIntegrityError } from '../../adapters/packaged-assets/resource-catalog.js';
import { isSupportedProfileId, type StandardsProfileCatalog } from '../../domain/standards/profile-schema.js';
import { assessmentEvidenceBounds } from '../../domain/standards-assessment/evaluation.js';
import { containsSensitiveText, sanitizeText } from '../../domain/standards-assessment/sanitizer.js';

/** componentRoot is project-relative, uses "/", and is "." for the project root. */
export interface ObservedStandardsProfile extends StandardsProfileIdentity { componentRoot: string }
export interface ProfileResolutionResult {
  profile: StandardsProfileIdentity;
  observedProfiles: ObservedStandardsProfile[];
  diagnostics: AssessmentDiagnostic[];
}

export function resolveTargetProfile(
  target: AssessmentTarget, inventory: AssessmentInventory, explicitProfileId?: string
): ProfileResolutionResult {
  const diagnostics: AssessmentDiagnostic[] = [], observedProfiles: ObservedStandardsProfile[] = [];
  let catalog: StandardsProfileCatalog;
  try { catalog = loadPackagedProfilesCatalog(); }
  catch (error) {
    return {
      profile: makeUnresolvedProfile(), observedProfiles,
      diagnostics: [{ code: 'CATALOG_INTEGRITY_ERROR', severity: 'error', message: error instanceof PackagedResourceIntegrityError
        ? error.message : 'The installed standards catalog could not be validated.' }]
    };
  }
  const components = detectProjectComponents(target, inventory);
  let observationsOmitted = 0;
  for (const component of components) {
    const root = component.componentRoot!;
    if (root.length > assessmentEvidenceBounds.referencePathCharacters || containsSensitiveText(root) ||
        /[\u0000-\u001f\u007f-\u009f\\]/u.test(root) || observationsOmitted ||
        observedProfiles.length >= assessmentEvidenceBounds.observedComponents ||
        diagnostics.length >= assessmentEvidenceBounds.profileDiagnostics - 4) {
      observationsOmitted++;
      continue;
    }
    if (component.status === 'conflicting') {
      diagnostics.push({ code: 'PROFILE_CONFLICT', severity: 'warning', source: root, message: component.evidence.details });
      continue;
    }
    if (component.status !== 'observed') {
      diagnostics.push({ code: 'PROFILE_SOURCE_UNOBSERVED', severity: 'warning', source: root, message: component.evidence.details });
      continue;
    }
    if (component.isSupported && component.profileId && isSupportedProfileId(component.profileId) && Object.hasOwn(catalog.profiles, component.profileId)) {
      observedProfiles.push({ ...adaptStandardsProfile(catalog.profiles[component.profileId]), componentRoot: root });
    } else {
      const unsupported = catalog.unsupportedStacks[component.detectedFramework];
      observedProfiles.push({
        ...makeUnsupportedProfile(component.detectedFramework, unsupported?.label), componentRoot: root
      });
      diagnostics.push({
        code: 'UNSUPPORTED_STACK_OBSERVED', severity: 'warning', source: root,
        message: `Observed ${component.detectedFramework} application source is diagnostic-only. Liftoff does not infer automatic conversion to a supported profile.`
      });
    }
  }
  if (observationsOmitted) {
    observationsOmitted += observedProfiles.length;
    observedProfiles.length = 0;
    diagnostics.push({
      code: 'PROFILE_EVIDENCE_LIMIT', severity: 'warning',
      message: `Component evidence exceeded its bounded or safe reporting scope (${observationsOmitted} observations omitted). No single observed component is published as adoption authority.`
    });
  }
  observedProfiles.sort((a, b) => a.componentRoot.localeCompare(b.componentRoot, 'en') || a.id.localeCompare(b.id, 'en'));
  const roots = new Set(components.map((entry) => entry.componentRoot));
  const ambiguous = roots.size > 1;
  if (ambiguous) diagnostics.push({
    code: 'PROFILE_SCOPE_AMBIGUOUS', severity: 'warning',
    message: 'Multiple distinct or overlapping component roots are observed. Select an exact component; a whole-target profile does not merge their source or authorize adoption.'
  });
  let profile: StandardsProfileIdentity;
  if (explicitProfileId) {
    const id = resolveProfileId(explicitProfileId);
    if (!id || !Object.hasOwn(catalog.profiles, id)) {
      diagnostics.push({
        code: 'INVALID_PROFILE_SELECTION', severity: 'error',
        message: `Requested profile '${sanitizeText(explicitProfileId, 128)}' is not one of the 13 installed supported release profiles.`
      });
      profile = makeUnsupportedProfile(explicitProfileId.length <= 128 && !containsSensitiveText(explicitProfileId) &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(explicitProfileId) ? explicitProfileId : 'invalid-profile');
    } else {
      profile = adaptStandardsProfile(catalog.profiles[id]);
      const matching = observedProfiles.filter((entry) => entry.status === 'supported' && entry.id === id);
      if (!ambiguous && matching.length === 1) profile.componentRoot = matching[0]!.componentRoot;
      for (const observed of observedProfiles.filter((entry) => entry.id !== id)) {
        diagnostics.push({
          code: 'INCOMPATIBLE_PROFILE_TARGET', severity: 'warning', source: observed.componentRoot,
          message: `Explicit target '${id}' does not convert observed '${observed.id}' source or supply missing pattern, runtime or business proof.`
        });
      }
      if (!observedProfiles.length && !diagnostics.some((entry) => entry.code === 'PROFILE_SOURCE_UNOBSERVED' || entry.code === 'PROFILE_CONFLICT')) {
        diagnostics.push({ code: 'PROFILE_SOURCE_UNOBSERVED', severity: 'warning',
          message: 'The explicit profile is a standards target only; matching application source was not observed.' });
      }
    }
  } else if (!ambiguous && observedProfiles.length === 1 && components.length === 1) {
    profile = { ...observedProfiles[0]! };
  } else {
    profile = makeUnresolvedProfile();
    if (!diagnostics.length) diagnostics.push({
      code: 'PROFILE_UNRESOLVED', severity: 'warning',
      message: 'No supported same-component declaration/import/use evidence established a profile for this snapshot.'
    });
  }
  diagnostics.sort((a, b) => a.code.localeCompare(b.code, 'en') || (a.source ?? '').localeCompare(b.source ?? '', 'en'));
  if (diagnostics.length > assessmentEvidenceBounds.profileDiagnostics) {
    observedProfiles.length = 0;
    diagnostics.splice(assessmentEvidenceBounds.profileDiagnostics - 1);
    diagnostics.push({
      code: 'PROFILE_EVIDENCE_LIMIT', severity: 'warning',
      message: 'Profile diagnostics exceeded the reporting bound. Component observations are withheld rather than presented as complete adoption evidence.'
    });
  }
  return { profile, observedProfiles, diagnostics };
}
