// Weekly review metrics, run by GitHub Actions and bundled into
// .github/liftoff/review-metrics.mjs. Reads recently merged pull requests and
// their reviews; writes only the job summary.
import { GitHubClient } from "../adapters/github.ts";
import {
  computeMetrics,
  type MergedPullRequest,
  renderMetrics,
} from "../domain/ai-review/metrics.ts";
import { SUMMARY_MARKER } from "../domain/ai-review/plan.ts";

export interface MetricsEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly now: () => number;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface ApiPull {
  number: number;
  title: string;
  created_at: string;
  merged_at: string | null;
}
interface ApiReview {
  user: { login: string; type: string } | null;
  state: string;
  body: string | null;
}

export async function main(context: MetricsEnvironment): Promise<number> {
  const { env } = context;
  try {
    const repository = env.GITHUB_REPOSITORY;
    if (!repository || !env.GITHUB_TOKEN)
      throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    const days = Number(env.LIFTOFF_METRICS_DAYS ?? "28");
    const client = new GitHubClient({
      token: env.GITHUB_TOKEN,
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    const since = context.now() - days * 86_400_000;
    const pulls = (
      await client
        .list<ApiPull>(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc`, 300)
        .catch((error: Error) => {
          // More than 300 closed pull requests: the newest are enough for a 28-day window.
          if (/more than/.test(error.message)) return [];
          throw error;
        })
    ).filter((pr) => pr.merged_at !== null && Date.parse(pr.merged_at) >= since);

    const merged: MergedPullRequest[] = [];
    for (const pr of pulls) {
      const reviews = await client.list<ApiReview>(
        `/repos/${repository}/pulls/${pr.number}/reviews`,
        1000,
      );
      const approvers = new Set(
        reviews
          .filter((review) => review.state === "APPROVED" && review.user?.type === "User")
          .map((review) => review.user?.login),
      );
      const aiRounds = reviews.filter(
        (review) =>
          review.user?.login === "github-actions[bot]" &&
          (review.body ?? "").includes(`<!-- ${SUMMARY_MARKER} round=`),
      ).length;
      merged.push({
        number: pr.number,
        title: pr.title,
        createdAt: Date.parse(pr.created_at),
        mergedAt: Date.parse(pr.merged_at as string),
        humanApprovals: approvers.size,
        aiRounds,
      });
    }
    const text = `${renderMetrics(computeMetrics(merged), days)}\n`;
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, text);
    context.log(text);
    return 0;
  } catch (error) {
    context.log(`## Review metrics: error\n\n${(error as Error).message}\n`);
    return 1;
  }
}
