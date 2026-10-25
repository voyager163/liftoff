// The branch-policy and release-lineage checks, run by a generated project's
// CI on every pull request and bundled into .github/liftoff/branch-policy.mjs
// so CI needs no Liftoff installation. Both are jobs that ci-gate needs.
//
// - branch: the head branch may merge into the base: work branches and sync
//   branches into develop; release/X.Y.Z, at a develop commit whose CI
//   passed, and hotfix/X.Y.Z, from the current main with an incident
//   reference, into main. Neither version may be released already.
// - lineage: a pull request into main contains the current main, so merging
//   it leaves exactly the candidate's tree, the one CI qualified.
//
// They run on pull requests, and on a workflow_dispatch naming one, which is
// how CI is started for pull requests the release workflows open with the
// workflow token (GitHub starts no workflows for those). Other events have
// nothing to check and pass.
import { GitHubClient } from "../adapters/github.ts";
import { checkBranch } from "../domain/governance/branch-policy.ts";
import {
  compare,
  type PullRequest,
  refExists,
  treeOf,
  WORKFLOWS,
  workflowPassed,
} from "./gitflow-github.ts";

export type Mode = "branch" | "lineage";

export interface CheckEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Runs one check and returns the process exit code: 0 pass, 1 fail. */
export async function main(mode: Mode, context: CheckEnvironment): Promise<number> {
  const { env } = context;
  const title = mode === "branch" ? "Branch policy" : "Release lineage";
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, text);
    context.log(text);
  };
  try {
    const event = env.GITHUB_EVENT_NAME;
    const parsed =
      event === "pull_request" || event === "workflow_dispatch"
        ? (JSON.parse(context.readFile(required(env, "GITHUB_EVENT_PATH"))) as {
            pull_request?: PullRequest;
            inputs?: { pull_request?: string };
          })
        : undefined;
    const dispatched = parsed?.inputs?.pull_request?.trim();
    if (parsed === undefined || (event === "workflow_dispatch" && !dispatched)) {
      summary(
        `## ${title}: passed\n\nIt checks pull requests, and this ${event ?? "run"} names none, so there is nothing to check.\n`,
      );
      return 0;
    }
    if (event === "pull_request" && !parsed.pull_request) {
      throw new Error("the event has no pull request");
    }
    const client = new GitHubClient({
      token: required(env, "GITHUB_TOKEN"),
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    const repository = required(env, "GITHUB_REPOSITORY");
    const number =
      event === "pull_request" ? String(parsed.pull_request?.number ?? "") : (dispatched ?? "");
    if (!/^[1-9]\d*$/.test(number)) {
      throw new Error(`pull_request must be a pull request number, not "${number}"`);
    }
    // The pull request as it is now, not as the event recorded it, so a
    // re-run sees an edited description or base.
    const pr = await client.get<PullRequest>(`/repos/${repository}/pulls/${number}`);
    if (pr.state !== undefined && pr.state !== "open") {
      throw new Error(`pull request #${number} is not open`);
    }
    // A dispatched run is not on the merge result, so use GitHub's test merge.
    const mergeSha =
      event === "pull_request" ? required(env, "GITHUB_SHA") : (pr.merge_commit_sha ?? pr.head.sha);
    const problems =
      mode === "branch"
        ? await branchProblems(client, repository, pr, env)
        : await lineageProblems(client, repository, pr, mergeSha);
    if (problems.length > 0) {
      summary(`## ${title}: failed\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
      return 1;
    }
    summary(`## ${title}: passed\n\n${pr.head.ref} into ${pr.base.ref}.\n`);
    return 0;
  } catch (error) {
    summary(`## ${title}: error\n\n${(error as Error).message}\n`);
    return 1;
  }
}

async function branchProblems(
  client: GitHubClient,
  repository: string,
  pr: PullRequest,
  env: CheckEnvironment["env"],
): Promise<string[]> {
  const decision = checkBranch({
    head: pr.head.ref,
    base: pr.base.ref,
    body: pr.body ?? "",
    automation: (env.AUTOMATION_BRANCHES ?? "")
      .split(",")
      .map((prefix) => prefix.trim())
      .filter(Boolean),
  });
  if (!decision.allowed) return [decision.reason];
  const problems: string[] = [];
  if (decision.kind === "release") {
    const fromDevelop = await compare(client, repository, "develop", pr.head.sha);
    if (fromDevelop.ahead_by > 0) {
      problems.push(
        `${pr.head.ref} has ${fromDevelop.ahead_by} commit(s) that are not on develop; a release is an exact develop commit`,
      );
    } else {
      for (const [what, workflow] of [
        ["CI", WORKFLOWS.ci],
        ["The build", WORKFLOWS.build],
      ] as const) {
        if (!(await workflowPassed(client, repository, pr.head.sha, workflow, "develop"))) {
          problems.push(
            `${what} has not passed on develop for ${pr.head.sha}, the commit being released`,
          );
        }
      }
    }
  }
  if (decision.kind === "hotfix") {
    const fromMain = await compare(client, repository, "main", pr.head.sha);
    if (fromMain.behind_by > 0) {
      problems.push(`${pr.head.ref} does not start from the current main; rebase it onto main`);
    }
    if (!(await workflowPassed(client, repository, pr.head.sha, WORKFLOWS.build, pr.head.ref))) {
      problems.push(`the build has not passed for ${pr.head.sha}, so there is no image to release`);
    }
  }
  if (
    decision.version !== undefined &&
    (await refExists(client, repository, `tags/v${decision.version}`))
  ) {
    problems.push(`v${decision.version} is already released; choose the next version`);
  }
  return problems;
}

async function lineageProblems(
  client: GitHubClient,
  repository: string,
  pr: PullRequest,
  mergeSha: string,
): Promise<string[]> {
  if (pr.base.ref !== "main") return [];
  const fromMain = await compare(client, repository, "main", pr.head.sha);
  if (fromMain.behind_by > 0) {
    return [
      `${pr.head.ref} is missing ${fromMain.behind_by} commit(s) from main; bring main into develop with a sync/… pull request, then cut the release again`,
    ];
  }
  if (
    mergeSha !== pr.head.sha &&
    (await treeOf(client, repository, mergeSha)) !== (await treeOf(client, repository, pr.head.sha))
  ) {
    return [
      `merging ${pr.head.ref} would not leave exactly the tree of ${pr.head.sha}, the commit CI qualified`,
    ];
  }
  return [];
}

function required(env: CheckEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
