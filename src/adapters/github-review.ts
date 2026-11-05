import type {
  PullRequestForReview,
  ReviewGateway,
} from "../application/ai-review/review-pull-request.ts";
import type { InlineComment } from "../domain/ai-review/plan.ts";
import { FINDING_MARKER, SUMMARY_MARKER } from "../domain/ai-review/plan.ts";
import type { GitHubClient } from "./github.ts";

interface ApiPull {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  user: { login: string };
  head: { sha: string };
  base: { ref: string };
}
interface ApiFile {
  filename: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
  patch?: string;
}
interface ApiAuthored {
  body: string | null;
  user: { login: string } | null;
}

const FINGERPRINT = new RegExp(`<!-- ${FINDING_MARKER}:([0-9a-f]{16}) -->`, "g");
const SUMMARY = new RegExp(`<!-- ${SUMMARY_MARKER} round=(\\d+) head=([0-9a-f]+) -->`);

/** Reads and posts AI review results through the GitHub REST API. */
export class GitHubReviewGateway implements ReviewGateway {
  private readonly client: GitHubClient;
  private readonly repository: string;
  /** Only comments from this login count as earlier rounds, so others cannot suppress findings. */
  private readonly botLogin: string;

  constructor(client: GitHubClient, repository: string, botLogin = "github-actions[bot]") {
    this.client = client;
    this.repository = repository;
    this.botLogin = botLogin;
  }

  async load(number: number): Promise<PullRequestForReview> {
    const base = `/repos/${this.repository}/pulls/${number}`;
    const [pull, files, reviews, comments] = await Promise.all([
      this.client.get<ApiPull>(base),
      this.client.list<ApiFile>(`${base}/files`, 3000),
      this.client.list<ApiAuthored>(`${base}/reviews`, 1000),
      this.client.list<ApiAuthored>(`${base}/comments`, 3000),
    ]);
    const mine = (item: ApiAuthored) => item.user?.login === this.botLogin;
    const summaries = reviews.filter(mine).flatMap((review) => {
      const match = SUMMARY.exec(review.body ?? "");
      return match ? [{ round: Number(match[1]), head: match[2] as string }] : [];
    });
    const fingerprints = new Set<string>();
    for (const item of [...reviews, ...comments].filter(mine)) {
      for (const match of (item.body ?? "").matchAll(FINGERPRINT))
        fingerprints.add(match[1] as string);
    }
    const last = summaries.sort((a, b) => a.round - b.round).at(-1);
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      author: pull.user.login,
      draft: pull.draft === true,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      files: files.map((file) => ({
        path: file.filename,
        ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
        additions: file.additions,
        deletions: file.deletions,
        ...(file.patch === undefined ? {} : { patch: file.patch }),
      })),
      previous: {
        rounds: last?.round ?? 0,
        fingerprints,
        ...(last ? { lastHead: last.head } : {}),
      },
    };
  }

  async publish(
    number: number,
    headSha: string,
    summary: string,
    comments: readonly InlineComment[],
  ): Promise<void> {
    await this.client.post(`/repos/${this.repository}/pulls/${number}/reviews`, {
      commit_id: headSha,
      event: "COMMENT",
      body: summary,
      comments: comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body,
      })),
    });
  }
}
