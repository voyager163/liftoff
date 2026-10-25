/** One merged pull request, as the metrics need it. */
export interface MergedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly createdAt: number;
  readonly mergedAt: number;
  /** Distinct human approvals it received. */
  readonly humanApprovals: number;
  /** Rounds of verified AI review it went through. */
  readonly aiRounds: number;
}

export interface ReviewMetrics {
  readonly merged: number;
  readonly hoursToMerge: { readonly median: number; readonly p95: number };
  readonly humanApprovals: { readonly median: number; readonly p95: number };
  /** Of the pull requests that had verified AI review, the share that passed in one round. */
  readonly passedFirstRound: number | undefined;
  readonly meanAiRounds: number | undefined;
  readonly reverts: number;
  readonly revertRate: number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Measures where human attention goes and how the reviewer performs, with
 * reverts as the guardrail: fewer approvals is not progress if reverts rise.
 */
export function computeMetrics(pulls: readonly MergedPullRequest[]): ReviewMetrics {
  const hours = pulls.map((pr) => (pr.mergedAt - pr.createdAt) / 3_600_000);
  const approvals = pulls.map((pr) => pr.humanApprovals);
  const reviewed = pulls.filter((pr) => pr.aiRounds > 0);
  const reverts = pulls.filter((pr) => /^revert\b/i.test(pr.title)).length;
  return {
    merged: pulls.length,
    hoursToMerge: { median: round1(percentile(hours, 50)), p95: round1(percentile(hours, 95)) },
    humanApprovals: { median: percentile(approvals, 50), p95: percentile(approvals, 95) },
    passedFirstRound:
      reviewed.length === 0
        ? undefined
        : round1((reviewed.filter((pr) => pr.aiRounds === 1).length / reviewed.length) * 100),
    meanAiRounds:
      reviewed.length === 0
        ? undefined
        : round1(reviewed.reduce((sum, pr) => sum + pr.aiRounds, 0) / reviewed.length),
    reverts,
    revertRate: pulls.length === 0 ? 0 : round1((reverts / pulls.length) * 100),
  };
}

export function renderMetrics(metrics: ReviewMetrics, days: number): string {
  const or = (value: number | undefined, unit = "") =>
    value === undefined ? "no verified AI reviews" : `${value}${unit}`;
  return [
    `## Review metrics (last ${days} days)`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Pull requests merged | ${metrics.merged} |`,
    `| Hours open to merged (median / p95) | ${metrics.hoursToMerge.median} / ${metrics.hoursToMerge.p95} |`,
    `| Human approvals per pull request (median / p95) | ${metrics.humanApprovals.median} / ${metrics.humanApprovals.p95} |`,
    `| Passed verified AI review in one round | ${or(metrics.passedFirstRound, "%")} |`,
    `| Mean verified AI review rounds | ${or(metrics.meanAiRounds)} |`,
    `| Reverts (guardrail) | ${metrics.reverts} (${metrics.revertRate}%) |`,
    "",
    "Fewer human approvals or faster merges only count as progress while reverts and incidents do not rise.",
  ].join("\n");
}
