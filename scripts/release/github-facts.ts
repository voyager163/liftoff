// What GitHub says about a release, read with the GitHub CLI and the
// workflow's token. Failures other than "not found" stop the release.
import { execFileSync, spawnSync } from "node:child_process";

const gh = (args: string[]): string => execFileSync("gh", args, { encoding: "utf8" });

/**
 * The release tagged v<version>, or null. Drafts are listed only to a token
 * that can push, so a job asking about drafts needs contents: write.
 */
export function releaseOf(
  repository: string,
  version: string,
): { draft: boolean; prerelease: boolean; target: string; body: string } | null {
  const releases = JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
  ) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    target_commitish: string;
    body: string | null;
  }[][];
  const matching = releases.flat().filter((each) => each.tag_name === `v${version}`);
  if (matching.length > 1) throw new Error(`there are ${matching.length} releases v${version}`);
  const [release] = matching;
  return release === undefined
    ? null
    : {
        draft: release.draft,
        prerelease: release.prerelease,
        target: release.target_commitish,
        body: release.body ?? "",
      };
}

/** A workflow run, as Promote checks it, or null when there is none. */
export function runOf(
  repository: string,
  id: string,
): {
  path: string;
  event: string;
  headBranch: string;
  headSha: string;
  conclusion: string | null;
} | null {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/runs/${id}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (/HTTP 404|Not Found/.test(`${result.stdout}${result.stderr}`)) return null;
    throw new Error(`cannot read run ${id}: ${result.stderr.trim()}`);
  }
  const run = JSON.parse(result.stdout) as {
    path: string;
    event: string;
    head_branch: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
  };
  return {
    path: run.path,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    conclusion: run.status === "completed" ? run.conclusion : null,
  };
}

/** Whether main contains the commit. */
export function onMain(repository: string, sha: string): boolean {
  const comparison = JSON.parse(gh(["api", `repos/${repository}/compare/${sha}...main`])) as {
    status: string;
    behind_by: number;
  };
  return (
    (comparison.status === "identical" || comparison.status === "ahead") &&
    comparison.behind_by === 0
  );
}

/** Whether the tag v<version> exists. */
export function tagExists(repository: string, version: string): boolean {
  const result = spawnSync("gh", ["api", `repos/${repository}/git/ref/tags/v${version}`], {
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (/HTTP 404|Not Found/.test(`${result.stdout}${result.stderr}`)) return false;
  throw new Error(`cannot tell whether v${version} exists: ${result.stderr.trim()}`);
}

/** The conclusion of the latest ci-gate check run on the commit, or null. */
export function ciGateOf(repository: string, sha: string): string | null {
  const runs = JSON.parse(
    gh(["api", `repos/${repository}/commits/${sha}/check-runs?check_name=ci-gate&filter=latest`]),
  ) as { check_runs: { status: string; conclusion: string | null }[] };
  const [run] = runs.check_runs;
  if (run === undefined) return null;
  return run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
}

/** The release environment's required reviewers and branch limit, or null. */
export function environmentOf(
  repository: string,
  name: string,
): { reviewers: number; mainOnly: boolean } | null {
  const result = spawnSync("gh", ["api", `repos/${repository}/environments/${name}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (/HTTP 404|Not Found/.test(`${result.stdout}${result.stderr}`)) return null;
    throw new Error(`cannot read the ${name} environment: ${result.stderr.trim()}`);
  }
  const environment = JSON.parse(result.stdout) as {
    protection_rules?: { type: string; reviewers?: unknown[] }[];
    deployment_branch_policy?: {
      protected_branches: boolean;
      custom_branch_policies: boolean;
    } | null;
  };
  const reviewers = (environment.protection_rules ?? [])
    .filter((rule) => rule.type === "required_reviewers")
    .reduce((count, rule) => count + (rule.reviewers?.length ?? 0), 0);
  const policy = environment.deployment_branch_policy;
  let mainOnly = false;
  if (policy?.custom_branch_policies === true) {
    const branches = JSON.parse(
      gh(["api", `repos/${repository}/environments/${name}/deployment-branch-policies`]),
    ) as { branch_policies: { name: string; type?: string }[] };
    mainOnly =
      branches.branch_policies.length > 0 &&
      branches.branch_policies.every((each) => each.name === "main" && each.type !== "tag");
  }
  return { reviewers, mainOnly };
}
