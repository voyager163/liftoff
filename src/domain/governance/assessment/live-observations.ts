import {
  effectiveProtectedRefs, singleMaintainer, tagControls, teamReview, type PredicateResult
} from './predicates.js';
import { isRecord, jsonValue, notObserved, observed, sanitizeAssessmentText } from './sanitize.js';
import type { AssessmentProfile, JsonValue, LiveAssessmentResult, Observation } from './types.js';

export const liveMetadataEvaluators = [
  'default-branch', 'protected-refs', 'single-maintainer', 'team-review',
  'tag-controls', 'push-protection', 'environments'
] as const;
export type LiveMetadataEvaluator = typeof liveMetadataEvaluators[number];

export function isLiveMetadataEvaluator(value: string): value is LiveMetadataEvaluator {
  return liveMetadataEvaluators.some(evaluator => evaluator === value);
}

export function predicateObservation(check: PredicateResult, from: Observation['source']): Observation {
  if (check.value === null || from === null) return notObserved(check.reason, from);
  if (check.absent) return { availability: 'missing', value: null, source: from, reason: sanitizeAssessmentText(check.reason) };
  const observation = observed(check.value, from);
  if (observation.availability === 'observed') observation.reason = sanitizeAssessmentText(check.reason);
  return observation;
}

export function livePredicate(
  live: LiveAssessmentResult, key: string, evaluate: (value: JsonValue) => PredicateResult
): Observation {
  const observation = live.observations[key];
  if (!observation || observation.availability !== 'observed') return observation ?? notObserved(`Live ${key} was not collected.`);
  const converted = predicateObservation(evaluate(observation.value), observation.source);
  if (converted.availability === 'not-observed') converted.value = observation.value;
  else converted.facts = observation.value;
  return converted;
}

function environmentReviewers(value: unknown, environments: readonly string[]): PredicateResult {
  if (!Array.isArray(value) || !value.every(isRecord)) return { value: null, reason: 'Environment inventory is unavailable.' };
  const selected = environments.map(name => value.find(entry => entry.name === name));
  if (selected.some(entry => !entry)) return {
    value: false, reason: 'A declared deployment environment is absent from the complete live inventory.', absent: true
  };
  return {
    value: selected.every(entry => typeof entry?.reviewers === 'number')
      ? selected.every(entry => entry?.reviewers === 0) : null,
    reason: 'Declared deployment environments must not require human reviewers.'
  };
}

export function observeLiveGovernanceControl(
  evaluator: LiveMetadataEvaluator, profile: AssessmentProfile, live: LiveAssessmentResult,
  environments: readonly string[]
): Observation {
  const repository = live.observations['github.repository'];
  const branch = repository?.availability === 'observed' && isRecord(repository.value) &&
    typeof repository.value.defaultBranch === 'string' ? repository.value.defaultBranch : null;
  switch (evaluator) {
    case 'default-branch':
      return branch !== null && repository?.source ? observed(branch, repository.source)
        : repository ?? notObserved('Live repository default branch was not observed.');
    case 'protected-refs': {
      const rules = live.observations['github.rulesets'];
      const branches = live.observations['github.branches'];
      const families = live.observations['github.ref-families'];
      if (rules?.availability !== 'observed' || branches?.availability !== 'observed' ||
          families?.availability !== 'observed') {
        return notObserved('Complete repository/inherited rulesets, classic/effective branch protection, and bounded release/hotfix enumeration are required.');
      }
      const observation = predicateObservation(
        effectiveProtectedRefs(rules.value, branches.value, families.value, branch, profile), rules.source
      );
      observation.facts = jsonValue({ rulesets: rules.value, branches: branches.value, refFamilies: families.value });
      return observation;
    }
    case 'single-maintainer':
      return livePredicate(live, 'github.rulesets', value => singleMaintainer(value, branch));
    case 'team-review':
      return livePredicate(live, 'github.rulesets', value => teamReview(value, branch));
    case 'tag-controls': {
      const app = live.observations['github.actions-app'];
      if (app?.availability !== 'observed' || !isRecord(app.value) || typeof app.value.id !== 'number' ||
          app.value.id <= 0 || app.value.slug !== 'github-actions') {
        return notObserved('The GitHub Actions bypass application identity was not observed.');
      }
      const appId = app.value.id;
      return livePredicate(live, 'github.rulesets', value => tagControls(value, appId));
    }
    case 'push-protection':
      return livePredicate(live, 'github.security', value => {
        if (!isRecord(value)) return { value: null, reason: 'Security feature metadata is unavailable.' };
        const scanning = isRecord(value.secret_scanning) ? value.secret_scanning.status : value.secretScanning;
        const protection = isRecord(value.secret_scanning_push_protection) ? value.secret_scanning_push_protection.status : value.pushProtection;
        return {
          value: typeof scanning === 'string' && typeof protection === 'string'
            ? scanning === 'enabled' && protection === 'enabled' : null,
          reason: 'Secret scanning and push protection must both be enabled; omitted fields are not evidence of absence.'
        };
      });
    case 'environments':
      return livePredicate(live, 'github.environments', value => environmentReviewers(value, environments));
  }
}
