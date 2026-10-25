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
// Other events have nothing to check and pass.
import { GitHubClient, GitHubError } from "../adapters/github.ts";
import { checkBranch } from "../domain/governance/branch-policy.ts";

export type Mode = "branch" | "lineage";

export interface CheckEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface PullRequest {
  number: number;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface Comparison {
  ahead_by: number;
  behind_by: number;
}

/** The workflow that runs CI in a generated project. */
const CI_WORKFLOW = ".github/workflows/01-pr-ci.yml";

/** Runs one check and returns the process exit code: 0 pass, 1 fail. */
export async function main(mode: Mode, context: CheckEnvironment): Promise<number> {
  const { env } = context;
  const title = mode === "branch" ? "Branch policy" : "Release lineage";
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, text);
    context.log(text);
  };
  try {
    if (env.GITHUB_EVENT_NAME !== "pull_request") {
      summary(
        `## ${title}: passed\n\nIt checks pull requests; a ${env.GITHUB_EVENT_NAME ?? "run without an event"} has nothing to check.\n`,
      );
      return 0;
    }
    const event = JSON.parse(context.readFile(required(env, "GITHUB_EVENT_PATH"))) as {
      pull_request?: { number: number };
    };
    if (!event.pull_request) throw new Error("the event has no pull request");
    const client = new GitHubClient({
      token: required(env, "GITHUB_TOKEN"),
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    const repository = required(env, "GITHUB_REPOSITORY");
    // The pull request as it is now, not as the event recorded it, so a
    // re-run sees an edited description or base.
    const pr = await client.get<PullRequest>(
      `/repos/${repository}/pulls/${event.pull_request.number}`,
    );
    const problems =
      mode === "branch"
        ? await branchProblems(client, repository, pr, env)
        : await lineageProblems(client, repository, pr, required(env, "GITHUB_SHA"));
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
    } else if (!(await ciPassedOnDevelop(client, repository, pr.head.sha))) {
      problems.push(`CI has not passed on develop for ${pr.head.sha}, the commit being released`);
    }
  }
  if (decision.kind === "hotfix") {
    const fromMain = await compare(client, repository, "main", pr.head.sha);
    if (fromMain.behind_by > 0) {
      problems.push(`${pr.head.ref} does not start from the current main; rebase it onto main`);
    }
  }
  if (decision.version !== undefined && (await tagExists(client, repository, decision.version))) {
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
  if (mergeSha !== pr.head.sha) {
    const tree = async (sha: string) =>
      (await client.get<{ tree: { sha: string } }>(`/repos/${repository}/git/commits/${sha}`)).tree
        .sha;
    if ((await tree(mergeSha)) !== (await tree(pr.head.sha))) {
      return [
        `merging ${pr.head.ref} would not leave exactly the tree of ${pr.head.sha}, the commit CI qualified`,
      ];
    }
  }
  return [];
}

const compare = (client: GitHubClient, repository: string, base: string, sha: string) =>
  client.get<Comparison>(`/repos/${repository}/compare/${base}...${sha}`);

/**
 * Whether the CI workflow succeeded on a push of this commit to develop. It
 * asks for that workflow's successful runs only, so one is never lost behind
 * a page of other runs.
 */
async function ciPassedOnDevelop(
  client: GitHubClient,
  repository: string,
  sha: string,
): Promise<boolean> {
  const { total_count: count } = await client.get<{ total_count: number }>(
    `/repos/${repository}/actions/workflows/${CI_WORKFLOW.split("/").at(-1)}/runs?head_sha=${sha}&branch=develop&event=push&status=success&per_page=1`,
  );
  return count > 0;
}

async function tagExists(client: GitHubClient, repository: string, version: string) {
  try {
    await client.get(`/repos/${repository}/git/ref/tags/v${version}`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

function required(env: CheckEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
