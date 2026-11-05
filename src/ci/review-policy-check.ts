// The review-policy check, run by GitHub Actions. It is bundled into
// .github/liftoff/review-policy.mjs so CI needs no Liftoff installation, and
// it runs the same domain code as `liftoff review classify`.
//
// The workflow runs on pull_request_target, or on workflow_dispatch from the
// pull request's base branch, so the workflow, the policy and this script
// come from the base, never from the pull request. It never runs pull
// request code. It reports a `review-policy` commit status on the pull
// request's head commit, which is what branch rules require.
//
// Any workflow with write access can set a commit status, so a repository
// writer could forge this one. The tamper-proof floor is native: rulesets
// require code-owner review, and CODEOWNERS covers the always-human paths
// (including workflows). This check adds the tier-based counts above it.
import { GitHubClient } from "../adapters/github.ts";
import { GitHubPullRequestSource } from "../adapters/github-pull-request.ts";
import { checkPullRequest, renderCheckSummary } from "../application/review/check-pull-request.ts";
import { POLICY_PATH } from "../domain/risk-policy/policy.ts";

export const STATUS_CONTEXT = "review-policy";

export interface CheckEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface ApiPullRequest {
  number: number;
  state: string;
  head: { sha: string };
  base: { ref: string };
  user: { login: string };
}

interface Event {
  pull_request?: ApiPullRequest;
  inputs?: { pull_request?: string };
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

  let report:
    | ((state: "success" | "failure" | "error", description: string) => Promise<void>)
    | undefined;
  try {
    const eventName = env.GITHUB_EVENT_NAME;
    if (
      eventName !== "pull_request_target" &&
      eventName !== "workflow_dispatch" &&
      eventName !== "merge_group"
    ) {
      throw new Error(
        `run this check on pull_request_target or workflow_dispatch so it uses the base branch's policy (got ${eventName ?? "no event"})`,
      );
    }

    const repository = required(env, "GITHUB_REPOSITORY");
    const client = new GitHubClient({
      token: required(env, "GITHUB_TOKEN"),
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    if (eventName === "merge_group") {
      // Every pull request in the queue already passed this check, and the
      // queue's merge commit needs the same status to be mergeable.
      await client.post(`/repos/${repository}/statuses/${required(env, "GITHUB_SHA")}`, {
        state: "success",
        context: STATUS_CONTEXT,
        description: "Evaluated on each pull request before it entered the queue",
      });
      summary(
        "Review policy was evaluated on each pull request before it entered the merge queue.\n",
      );
      return 0;
    }
    const event = JSON.parse(context.readFile(required(env, "GITHUB_EVENT_PATH"))) as Event;
    const pr = await resolvePullRequest(client, repository, event, eventName);

    // A dispatched run must use the workflow and policy of the branch the
    // pull request merges into, not some other branch's copy.
    if (eventName === "workflow_dispatch" && env.GITHUB_REF !== `refs/heads/${pr.base.ref}`) {
      throw new Error(`dispatch this check from ${pr.base.ref}, the pull request's base branch`);
    }

    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    report = async (state, description) => {
      await client.post(`/repos/${repository}/statuses/${pr.head.sha}`, {
        state,
        context: STATUS_CONTEXT,
        description: description.slice(0, 140),
        ...(runUrl ? { target_url: runUrl } : {}),
      });
    };

    let basePolicyText: string;
    try {
      basePolicyText = context.readFile(POLICY_PATH);
    } catch {
      throw new Error(`the base branch has no ${POLICY_PATH}`);
    }

    const source = new GitHubPullRequestSource(client, repository);
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
    const { tier } = check.classification;
    const { approvers, required: needed } = check.approvals;
    await report(
      check.passed ? "success" : "failure",
      `${tier} risk: ${approvers.length} of ${needed} required approvals`,
    );
    return check.passed ? 0 : 1;
  } catch (error) {
    const message = (error as Error).message;
    summary(`## Review policy: error\n\n${message}\n`);
    await report?.("error", message).catch(() => undefined);
    return 1;
  }
}

async function resolvePullRequest(
  client: GitHubClient,
  repository: string,
  event: Event,
  eventName: string,
): Promise<ApiPullRequest> {
  if (eventName === "pull_request_target") {
    if (!event.pull_request) throw new Error("the event has no pull request");
    return event.pull_request;
  }
  const number = Number(event.inputs?.pull_request);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("workflow_dispatch needs a pull_request input with the pull request number");
  }
  const pr = await client.get<ApiPullRequest>(`/repos/${repository}/pulls/${number}`);
  if (pr.state !== "open") throw new Error(`pull request #${number} is not open`);
  return pr;
}

function required(env: CheckEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
