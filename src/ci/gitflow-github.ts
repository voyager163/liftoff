// GitHub reads and writes the GitFlow checks and release workflows share.
import { type GitHubClient, GitHubError } from "../adapters/github.ts";

/** The workflows of a generated project the release flow relies on. */
export const WORKFLOWS = {
  ci: ".github/workflows/01-pr-ci.yml",
  reviewPolicy: ".github/workflows/03-review-policy.yml",
  build: ".github/workflows/10-build.yml",
} as const;

export interface Comparison {
  readonly ahead_by: number;
  readonly behind_by: number;
}

export interface PullRequest {
  readonly number: number;
  readonly body: string | null;
  readonly state?: string;
  readonly merged_at?: string | null;
  readonly merge_commit_sha?: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
}

/** How `sha` compares with `base`: commits it has that base lacks, and the reverse. */
export const compare = (client: GitHubClient, repository: string, base: string, sha: string) =>
  client.get<Comparison>(`/repos/${repository}/compare/${base}...${sha}`);

/**
 * Whether a workflow succeeded on a push of this commit, optionally to one
 * branch. It asks for that workflow's successful runs only, so one is never
 * lost behind a page of other runs.
 */
export async function workflowPassed(
  client: GitHubClient,
  repository: string,
  sha: string,
  workflow: string,
  branch?: string,
): Promise<boolean> {
  const filter = branch === undefined ? "" : `&branch=${encodeURIComponent(branch)}`;
  const { total_count: count } = await client.get<{ total_count: number }>(
    `/repos/${repository}/actions/workflows/${workflow.split("/").at(-1)}/runs?head_sha=${sha}${filter}&event=push&status=success&per_page=1`,
  );
  return count > 0;
}

/** Whether a ref such as "tags/v1.2.0" or "heads/release/1.2.0" exists. */
export async function refExists(client: GitHubClient, repository: string, ref: string) {
  try {
    await client.get(`/repos/${repository}/git/ref/${ref}`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

export const treeOf = async (client: GitHubClient, repository: string, sha: string) =>
  (await client.get<{ tree: { sha: string } }>(`/repos/${repository}/git/commits/${sha}`)).tree.sha;

/** Starts a workflow on a branch, with inputs. */
export const dispatch = (
  client: GitHubClient,
  repository: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
) =>
  client.post(`/repos/${repository}/actions/workflows/${workflow.split("/").at(-1)}/dispatches`, {
    ref,
    inputs,
  });
