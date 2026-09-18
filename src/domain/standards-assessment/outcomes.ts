import type {
  AssessmentCoverage,
  AssessmentDiagnostic,
  AssessmentFinding,
  AssessmentOutcome,
  StandardsProfileIdentity
} from './types.js';

export function calculateCoverage(
  profile: StandardsProfileIdentity,
  findings: readonly AssessmentFinding[]
): AssessmentCoverage {
  let alignedRules = 0;
  let differingRules = 0;
  let missingRules = 0;
  let unsupportedRules = 0;
  let unknownRules = 0;

  for (const finding of findings) {
    switch (finding.classification) {
      case 'aligned':
        alignedRules++;
        break;
      case 'difference':
        differingRules++;
        break;
      case 'missing':
        missingRules++;
        break;
      case 'unsupported':
        unsupportedRules++;
        break;
      case 'unknown':
        unknownRules++;
        break;
      default:
        break;
    }
  }

  return {
    declaredRules: profile.declaredRuleCoverage.length,
    assessedRules: findings.length,
    alignedRules,
    differingRules,
    missingRules,
    unsupportedRules,
    unknownRules
  };
}

export function determineOutcomeAndExitCode(
  profile: StandardsProfileIdentity,
  coverage: AssessmentCoverage,
  diagnostics: readonly AssessmentDiagnostic[],
  unobservedCount = 0
): { outcome: AssessmentOutcome; exitCode: 0 | 1 | 2 } {
  // If there are fatal/error diagnostics (e.g. boundary safety, catalog invalid, path traversal)
  const hasErrorDiagnostic = diagnostics.some((d) => d.severity === 'error');
  if (hasErrorDiagnostic) {
    return {
      outcome: 'error',
      exitCode: 1
    };
  }

  // If profile is unsupported or unresolved
  if (profile.status === 'unsupported' || profile.status === 'unresolved') {
    return {
      outcome: 'differences',
      exitCode: 2
    };
  }

  // If there are unobserved scopes or limits exceeded
  if (unobservedCount > 0 || coverage.unknownRules > 0) {
    return {
      outcome: 'differences',
      exitCode: 2
    };
  }

  // Clean success: All declared rules assessed, all aligned, 0 differences, 0 missing, 0 unsupported, 0 unknown
  const isCompleteCoverage =
    coverage.declaredRules > 0 &&
    coverage.assessedRules === coverage.declaredRules &&
    coverage.alignedRules === coverage.declaredRules &&
    coverage.differingRules === 0 &&
    coverage.missingRules === 0 &&
    coverage.unsupportedRules === 0 &&
    coverage.unknownRules === 0;

  if (isCompleteCoverage) {
    return {
      outcome: 'success',
      exitCode: 0
    };
  }

  // Valid report with differences, missing items, or incomplete coverage
  return {
    outcome: 'differences',
    exitCode: 2
  };
}
