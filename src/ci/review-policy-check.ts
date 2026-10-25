// The review-policy check, run by GitHub Actions. It is bundled into
// .github/liftoff/review-policy.mjs so CI needs no Liftoff installation, and
// it runs the same domain code as `liftoff review classify`.
//
// The workflow must run on pull_request_target with the base branch checked
// out, so the policy and this script come from the base, never from the pull
// request. It only reads from GitHub; it never runs pull request code.
import { GitHubClient } from "../adapters/github.ts";
import { GitHubPullRequestSource } from "../adapters/github-pull-request.ts";
import { checkPullRequest, renderCheckSummary } from "../application/review/check-pull-request.ts";
import { POLICY_PATH } from "../domain/risk-policy/policy.ts";

export interface CheckEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface PullRequestEvent {
  pull_request?: { number: number; head: { sha: string }; user: { login: string } };
}

/** Runs the check and returns the process exit code: 0 pass, 1 fail. */
export async function main(context: CheckEnvironment): Promise<number> {
  const { env } = context;
  const output = (name: string, value: string | number | boolean) => {
    if (env.GITHUB_OUTPUT) context.appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, text);
    context.log(text);
  };

  try {
    if (env.GITHUB_EVENT_NAME === "merge_group") {
      summary(
        "Review policy was evaluated on each pull request before it entered the merge queue.\n",
      );
      return 0;
    }
    if (env.GITHUB_EVENT_NAME !== "pull_request_target") {
      throw new Error(
        `run this check on pull_request_target so it uses the base branch's policy (got ${env.GITHUB_EVENT_NAME ?? "no event"})`,
      );
    }
    const event = JSON.parse(
      context.readFile(required(env, "GITHUB_EVENT_PATH")),
    ) as PullRequestEvent;
    const pr = event.pull_request;
    if (!pr) throw new Error("the event has no pull request");

    let basePolicyText: string;
    try {
      basePolicyText = context.readFile(POLICY_PATH);
    } catch {
      throw new Error(`the base branch has no ${POLICY_PATH}`);
    }

    const client = new GitHubClient({
      token: required(env, "GITHUB_TOKEN"),
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    const source = new GitHubPullRequestSource(client, required(env, "GITHUB_REPOSITORY"));
    const check = await checkPullRequest(source, {
      number: pr.number,
      headSha: pr.head.sha,
      author: pr.user.login,
      basePolicyText,
    });

    output("tier", check.classification.tier);
    output("depth", check.classification.depth);
    output("required-approvals", check.approvals.required);
    output("approvals", check.approvals.approvers.length);
    output("always-human", check.classification.alwaysHuman);
    summary(renderCheckSummary(check));
    return check.passed ? 0 : 1;
  } catch (error) {
    summary(`## Review policy: error\n\n${(error as Error).message}\n`);
    return 1;
  }
}

function required(env: CheckEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
