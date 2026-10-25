import {
  AgentOutputError,
  type Candidate,
  mergeCandidates,
  parseCandidates,
  parseVerdicts,
  type RawCandidate,
  type Verdict,
  vote,
} from "../../domain/ai-review/findings.ts";
import {
  commentableLines,
  type InlineComment,
  type PreviousReview,
  planReview,
  type ReviewPlan,
} from "../../domain/ai-review/plan.ts";
import { FINDER_PASSES } from "../../domain/ai-review/prompts.ts";
import { type Classification, classify } from "../../domain/risk-policy/classify.ts";
import { parsePolicy } from "../../domain/risk-policy/policy.ts";

export const MAX_ROUNDS = 3;

export interface ReviewFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

export interface PullRequestForReview {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly files: readonly ReviewFile[];
  /** Earlier rounds, read only from comments the review bot itself posted. */
  readonly previous: PreviousReview;
}

/** GitHub access the review pipeline needs. */
export interface ReviewGateway {
  load(number: number): Promise<PullRequestForReview>;
  publish(
    number: number,
    headSha: string,
    summary: string,
    comments: readonly InlineComment[],
  ): Promise<void>;
}

export interface ReviewDecision {
  readonly run: boolean;
  readonly reason: string;
  readonly round: number;
  readonly passes: number;
  /** The git range the finders review: the whole change, or only what is new since the last round. */
  readonly range: string;
  readonly classification: Classification;
}

/**
 * Decides whether the verified review runs and how deep. Low-risk changes
 * get only the managed reviewer; after the round cap the pipeline stops and
 * says so once; from the third round on, finders see only the new commits.
 */
export function decideReview(pr: PullRequestForReview, basePolicyText: string): ReviewDecision {
  const classification = classify({
    policy: parsePolicy(basePolicyText),
    files: pr.files,
    author: pr.author,
  });
  const round = pr.previous.rounds + 1;
  const fullRange = `origin/${pr.baseRef}...${pr.headSha}`;
  const range =
    pr.previous.rounds >= 2 && pr.previous.lastHead
      ? `${pr.previous.lastHead}..${pr.headSha}`
      : fullRange;
  const base = { round, range, classification };

  if (pr.draft) return { ...base, run: false, passes: 0, reason: "draft pull request" };
  if (pr.previous.lastHead === pr.headSha)
    return { ...base, run: false, passes: 0, reason: "this commit was already reviewed" };
  if (round > MAX_ROUNDS)
    return { ...base, run: false, passes: 0, reason: `stopped after ${MAX_ROUNDS} rounds` };
  const passes = FINDER_PASSES[classification.depth];
  if (passes === 0) {
    return {
      ...base,
      run: false,
      passes,
      reason: `${classification.tier} risk: the managed reviewer covers it`,
    };
  }
  return {
    ...base,
    run: true,
    passes,
    reason: `${classification.tier} risk, ${classification.depth} review`,
  };
}

export interface PublishInput {
  readonly finderOutputs: readonly string[];
  readonly verifierOutputs: readonly string[];
}

export interface PublishResult {
  readonly plan: ReviewPlan;
  readonly failedPasses: number;
  readonly failedVerifiers: number;
}

export class ReviewIncompleteError extends Error {
  override readonly name = "ReviewIncompleteError";
}

/** Merges candidates from the finder passes, keeping parse failures out. */
export function collectCandidates(finderOutputs: readonly string[]): {
  candidates: Candidate[];
  failed: number;
} {
  const passes: RawCandidate[][] = [];
  let failed = 0;
  for (const output of finderOutputs) {
    try {
      passes.push(parseCandidates(output));
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      failed++;
    }
  }
  if (passes.length === 0)
    throw new ReviewIncompleteError("no finder pass produced a usable result");
  return { candidates: mergeCandidates(passes), failed };
}

/**
 * Votes on the candidates and posts one review: inline comments where the
 * diff allows and a summary that starts with the count. Fails closed when
 * too few verifier runs produced a usable result.
 */
export async function publishReview(
  gateway: ReviewGateway,
  pr: PullRequestForReview,
  input: PublishInput,
): Promise<PublishResult> {
  const { candidates, failed: failedPasses } = collectCandidates(input.finderOutputs);
  const runs: Verdict[][] = [];
  let failedVerifiers = 0;
  for (const output of input.verifierOutputs) {
    try {
      runs.push(parseVerdicts(output));
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      failedVerifiers++;
    }
  }
  if (candidates.length > 0 && runs.length < 2) {
    throw new ReviewIncompleteError(
      `only ${runs.length} verifier run(s) produced a usable result; at least 2 are needed`,
    );
  }

  const commentable: Record<string, Set<number>> = {};
  for (const file of pr.files) commentable[file.path] = commentableLines(file.patch);
  const plan = planReview({
    findings: vote(candidates, runs),
    commentable,
    previous: pr.previous,
    headSha: pr.headSha,
    maxRounds: MAX_ROUNDS,
  });
  let summary = plan.summary;
  if (failedPasses > 0 || failedVerifiers > 0) {
    summary += `\n\n<sub>${failedPasses} finder pass(es) and ${failedVerifiers} verifier run(s) returned no usable result and were left out.</sub>`;
  }
  await gateway.publish(pr.number, pr.headSha, summary, plan.inline);
  return { plan: { ...plan, summary }, failedPasses, failedVerifiers };
}

/** The note posted once when the round cap is reached. */
export async function publishStop(
  gateway: ReviewGateway,
  pr: PullRequestForReview,
): Promise<ReviewPlan> {
  const plan = planReview({
    findings: [],
    commentable: {},
    previous: pr.previous,
    headSha: pr.headSha,
    maxRounds: MAX_ROUNDS,
  });
  await gateway.publish(pr.number, pr.headSha, plan.summary, []);
  return plan;
}
