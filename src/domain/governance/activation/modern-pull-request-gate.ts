import type { ModernPhaseGraph } from './modern-graph.js';

export type ModernPullRequestReviewState = 'approved' | 'changes-requested' | 'dismissed';

export interface ModernPullRequestReviewObservation {
  readonly id: number;
  readonly reviewer: string;
  readonly actorType: 'human' | 'bot';
  readonly state: ModernPullRequestReviewState;
  readonly reviewedHeadSha: string;
  readonly submittedAt: string;
}

export interface ModernPullRequestGateInput {
  readonly author: string;
  readonly headSha: string;
  readonly automatedChecks: {
    readonly status: 'passed' | 'failed' | 'pending' | 'not-observed';
    readonly headSha: string | null;
  };
  readonly reviews: readonly ModernPullRequestReviewObservation[];
}

export interface ModernPullRequestGateEvaluation {
  readonly reviewKind: ModernPhaseGraph['profileContract']['pullRequestReview']['kind'];
  readonly requiredHumanApprovals: 0 | 1;
  readonly automatedChecksSatisfied: boolean;
  readonly humanReviewSatisfied: boolean;
  readonly satisfied: boolean;
  readonly qualifyingReviewers: readonly string[];
  readonly rejectedApprovals: readonly {
    readonly reviewer: string;
    readonly reason: 'self-review' | 'bot-review' | 'stale-review' | 'not-approved';
  }[];
  readonly deploymentReviewers: 'not-required';
  readonly reasons: readonly string[];
}

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

function requiredString(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredSha(value: string, label: string): string {
  const sha = requiredString(value, label).toLowerCase();
  if (!shaPattern.test(sha)) {
    throw new Error(`${label} must be a complete 40- or 64-character Git object ID.`);
  }
  return sha;
}

function loginKey(value: string): string {
  return requiredString(value, 'Review actor login').toLowerCase();
}

function normalizeReview(review: ModernPullRequestReviewObservation): ModernPullRequestReviewObservation & {
  readonly reviewerKey: string;
  readonly submittedAtMs: number;
} {
  if (!Number.isSafeInteger(review.id) || review.id <= 0) {
    throw new Error('Review observation id must be a positive safe integer.');
  }
  if (review.actorType !== 'human' && review.actorType !== 'bot') {
    throw new Error('Review actor type must be human or bot.');
  }
  if (!['approved', 'changes-requested', 'dismissed'].includes(review.state)) {
    throw new Error('Review state is unsupported.');
  }
  const submittedAtMs = Date.parse(review.submittedAt);
  if (!Number.isFinite(submittedAtMs)) {
    throw new Error('Review submittedAt must be a valid timestamp.');
  }
  const reviewer = requiredString(review.reviewer, 'Review actor login');
  return {
    ...review,
    reviewer,
    reviewerKey: loginKey(reviewer),
    reviewedHeadSha: requiredSha(review.reviewedHeadSha, 'Review observed head'),
    submittedAt: new Date(submittedAtMs).toISOString(),
    submittedAtMs
  };
}

function latestReviews(reviews: readonly ModernPullRequestReviewObservation[]): ReturnType<typeof normalizeReview>[] {
  const latest = new Map<string, ReturnType<typeof normalizeReview>>();
  for (const review of reviews.map(normalizeReview)) {
    const current = latest.get(review.reviewerKey);
    if (
      !current ||
      current.submittedAtMs < review.submittedAtMs ||
      (current.submittedAtMs === review.submittedAtMs && current.id < review.id)
    ) {
      latest.set(review.reviewerKey, review);
    }
  }
  return [...latest.values()].sort((left, right) => left.reviewerKey.localeCompare(right.reviewerKey, 'en'));
}

export function evaluateModernPullRequestGate(
  reviewRule: ModernPhaseGraph['profileContract']['pullRequestReview'],
  input: ModernPullRequestGateInput
): ModernPullRequestGateEvaluation {
  const author = loginKey(input.author);
  const headSha = requiredSha(input.headSha, 'Pull request head');
  if (!['passed', 'failed', 'pending', 'not-observed'].includes(input.automatedChecks.status)) {
    throw new Error('Automated-check status is unsupported.');
  }
  if (!Array.isArray(input.reviews)) {
    throw new Error('Review observations must be an array.');
  }
  const checksHead =
    input.automatedChecks.headSha === null ? null : requiredSha(input.automatedChecks.headSha, 'Automated-check head');
  const automatedChecksSatisfied = input.automatedChecks.status === 'passed' && checksHead === headSha;
  const reasons: string[] = automatedChecksSatisfied
    ? []
    : [
        checksHead !== headSha
          ? 'Automated checks are not bound to the current pull request head.'
          : `Automated checks are ${input.automatedChecks.status}.`
      ];

  if (reviewRule.kind === 'automated-only') {
    return Object.freeze({
      reviewKind: reviewRule.kind,
      requiredHumanApprovals: 0,
      automatedChecksSatisfied,
      humanReviewSatisfied: true,
      satisfied: automatedChecksSatisfied,
      qualifyingReviewers: Object.freeze([]),
      rejectedApprovals: Object.freeze([]),
      deploymentReviewers: 'not-required',
      reasons: Object.freeze(reasons)
    });
  }

  const qualifyingReviewers: string[] = [];
  const rejectedApprovals: Array<ModernPullRequestGateEvaluation['rejectedApprovals'][number]> = [];
  for (const review of latestReviews(input.reviews)) {
    const bot = review.actorType === 'bot' || review.reviewerKey.endsWith('[bot]');
    const reason =
      review.state !== 'approved'
        ? 'not-approved'
        : review.reviewerKey === author
          ? 'self-review'
          : bot
            ? 'bot-review'
            : review.reviewedHeadSha !== headSha
              ? 'stale-review'
              : null;
    if (reason === null) {
      qualifyingReviewers.push(review.reviewer);
    } else {
      rejectedApprovals.push({
        reviewer: review.reviewer,
        reason
      });
    }
  }
  const humanReviewSatisfied = qualifyingReviewers.length >= reviewRule.humanApprovals;
  if (!humanReviewSatisfied) {
    reasons.push('No current independent human approving review exists for the current pull request head.');
  }
  return Object.freeze({
    reviewKind: reviewRule.kind,
    requiredHumanApprovals: reviewRule.humanApprovals,
    automatedChecksSatisfied,
    humanReviewSatisfied,
    satisfied: automatedChecksSatisfied && humanReviewSatisfied,
    qualifyingReviewers: Object.freeze(qualifyingReviewers),
    rejectedApprovals: Object.freeze(rejectedApprovals),
    deploymentReviewers: 'not-required',
    reasons: Object.freeze(reasons)
  });
}
