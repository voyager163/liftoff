import type {
  PullRequestFacts,
  PullRequestSource,
} from "../application/review/check-pull-request.ts";
import type { Review } from "../domain/risk-policy/approvals.ts";
import type { GitHubClient } from "./github.ts";

interface ApiFile {
  filename: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
}

interface ApiReview {
  user: { login: string; type: string } | null;
  state: Review["state"];
  commit_id: string;
  submitted_at?: string;
}

interface ApiPermission {
  permission: string;
  role_name?: string;
}

/** GitHub's file list API stops at 3,000 files; beyond that the change cannot be classified. */
const MAX_FILES = 3000;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

/** Reads the facts the review-policy check needs from the GitHub REST API. */
export class GitHubPullRequestSource implements PullRequestSource {
  private readonly client: GitHubClient;
  private readonly repository: string;

  constructor(client: GitHubClient, repository: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error(`invalid repository "${repository}"`);
    this.client = client;
    this.repository = repository;
  }

  async facts(number: number, headSha: string, author: string): Promise<PullRequestFacts> {
    const base = `/repos/${this.repository}/pulls/${number}`;
    const [apiFiles, apiReviews] = await Promise.all([
      this.client.list<ApiFile>(`${base}/files`, MAX_FILES),
      this.client.list<ApiReview>(`${base}/reviews`, 1000),
    ]);

    const writeAccess = new Map<string, boolean>();
    for (const review of apiReviews) {
      const login = review.user?.login;
      if (!login || review.state !== "APPROVED" || writeAccess.has(login)) continue;
      writeAccess.set(login, await this.hasWriteAccess(login));
    }

    return {
      number,
      author,
      headSha,
      files: apiFiles.map((file) => ({
        path: file.filename,
        ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
        additions: file.additions,
        deletions: file.deletions,
      })),
      reviews: apiReviews
        .filter((review) => review.user !== null)
        .map((review, index) => {
          const user = review.user as { login: string; type: string };
          return {
            reviewer: user.login,
            isBot: user.type !== "User",
            hasWriteAccess: writeAccess.get(user.login) ?? false,
            state: review.state,
            commitId: review.commit_id,
            // The API lists reviews in submission order; the index breaks ties.
            submittedAt: (Date.parse(review.submitted_at ?? "") || 0) * 1000 + index,
          };
        }),
    };
  }

  private async hasWriteAccess(login: string): Promise<boolean> {
    const result = await this.client.get<ApiPermission>(
      `/repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return WRITE_ROLES.has(result.role_name ?? result.permission);
  }
}
