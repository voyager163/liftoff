import path from "node:path";
import {
  assessCheckpoints,
  type Checkpoint,
  type Desired,
  GITHUB_ACTIONS_APP_ID,
  type Observed,
  type ProofRecord,
} from "../../domain/governance/checkpoints.ts";
import {
  type DesiredRuleset,
  type EffectiveRule,
  type LiveRuleset,
  targetedBranches,
} from "../../domain/governance/ruleset-drift.ts";
import type { GitHubApiPort, ProjectFsPort } from "../ports.ts";
import { validateProject } from "../project/validate-project.ts";
import { readGovernanceState } from "./state.ts";

export const DRIFT_WORKFLOW = ".github/workflows/90-governance-drift.yml";
/** How many recent pull requests are searched for runs of the required checks. */
const RECENT_PULLS = 20;
/** Pages of 100 check runs or statuses read for one commit before giving up. */
const MAX_PAGES = 10;

export class GovernanceError extends Error {
  override readonly name = "GovernanceError";
}

/** What the project's committed governance files ask GitHub to enforce. */
export async function readDesired(fs: ProjectFsPort, directory: string): Promise<Desired> {
  const files = async (relative: string, extension: string) => {
    const absolute = path.join(directory, ...relative.split("/"));
    if ((await fs.state(absolute)) === "missing") return [];
    return (await fs.listTree(absolute))
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(extension))
      .map((entry) => `${relative}/${entry.path}`);
  };
  const rulesets: DesiredRuleset[] = [];
  for (const file of await files(".github/rulesets", ".json")) {
    const text = (await fs.readText(path.join(directory, ...file.split("/")))) ?? "";
    try {
      rulesets.push(JSON.parse(text) as DesiredRuleset);
    } catch (error) {
      throw new GovernanceError(`${file} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const requiredChecks = new Map<string, { context: string; integrationId: number }>();
  for (const ruleset of rulesets) {
    for (const rule of ruleset.rules) {
      if (rule.type !== "required_status_checks") continue;
      const checks = (rule.parameters?.required_status_checks ?? []) as {
        context: string;
        integration_id?: number;
      }[];
      for (const check of checks) {
        // The same name from two apps is two requirements.
        const integrationId = check.integration_id ?? GITHUB_ACTIONS_APP_ID;
        requiredChecks.set(`${check.context}\u0000${integrationId}`, {
          context: check.context,
          integrationId,
        });
      }
    }
  }
  const workflows = [...(await files(".github/workflows", ".yml"))].sort();
  return {
    rulesets,
    workflows,
    requiredChecks: [...requiredChecks.values()],
    // Generated projects number it; a repository may name it differently.
    driftWorkflow: workflows.includes(DRIFT_WORKFLOW)
      ? DRIFT_WORKFLOW
      : (workflows.find((file) => file.endsWith("governance-drift.yml")) ?? DRIFT_WORKFLOW),
  };
}

interface ApiRepository {
  id: number;
  full_name: string;
  default_branch: string;
  permissions?: { admin?: boolean };
}

/** Reads, and only reads, the repository's state on GitHub. */
export async function observe(
  api: GitHubApiPort,
  repository: string,
  desired: Desired,
): Promise<Observed> {
  const route = `/repos/${repository}`;
  const repo = await api.get<ApiRepository>(route);
  const head = async (branch: string) =>
    (await api.find<{ commit: { sha: string } }>(`${route}/branches/${branch}`))?.commit.sha;
  const [develop, main] = [await head("develop"), await head("main")];
  const listed =
    (await api.find<{ path: string; type: string }[]>(
      `${route}/contents/.github/workflows?ref=${encodeURIComponent(repo.default_branch)}`,
    )) ?? [];
  const workflows = listed.filter((entry) => entry.type === "file").map((entry) => entry.path);

  const checks: Observed["checks"][number][] = [];
  const pulls = await api.get<{ head: { sha: string } }[]>(
    `${route}/pulls?state=all&sort=updated&direction=desc&per_page=${RECENT_PULLS}`,
  );
  const wanted = () =>
    desired.requiredChecks.some(
      ({ context, integrationId }) =>
        !checks.some((check) => check.context === context && check.appId === integrationId),
    );
  // Every page of a commit's check runs or statuses, until the required
  // checks are all seen; a commit with more than MAX_PAGES is an error.
  const paged = async <T>(sha: string, what: string, read: (page: number) => Promise<T[]>) => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await read(page);
      if (items.length < 100 || !wanted()) return;
    }
    throw new GovernanceError(
      `${sha} has more than ${MAX_PAGES * 100} ${what}; let a required check run on a newer pull request`,
    );
  };
  for (const sha of [...new Set(pulls.map((pull) => pull.head.sha))]) {
    if (!wanted()) break;
    await paged(sha, "check runs", async (page) => {
      const runs = await api.get<{
        check_runs: {
          name: string;
          conclusion: string | null;
          app?: { id: number };
          html_url: string;
        }[];
      }>(`${route}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      for (const run of runs.check_runs) {
        if (run.conclusion === "success" && run.app) {
          checks.push({ context: run.name, appId: run.app.id, url: run.html_url });
        }
      }
      return runs.check_runs;
    });
    await paged(sha, "statuses", async (page) => {
      const statuses = await api.get<
        {
          context: string;
          state: string;
          creator?: { login: string };
          target_url?: string | null;
        }[]
      >(`${route}/commits/${sha}/statuses?per_page=100&page=${page}`);
      for (const status of statuses) {
        // A status set with a workflow's token comes from the GitHub Actions app.
        if (status.state === "success" && status.creator?.login === "github-actions[bot]") {
          checks.push({
            context: status.context,
            appId: GITHUB_ACTIONS_APP_ID,
            url: status.target_url ?? `https://github.com/${repository}/commit/${sha}`,
          });
        }
      }
      return statuses;
    });
  }

  const rulesets = (
    await api.get<{ id: number; name: string; enforcement: string }[]>(
      `${route}/rulesets?per_page=100`,
    )
  ).map(({ id, name, enforcement }) => ({ id, name, enforcement }));
  // The committed rulesets in full, for what the rules on each branch cannot
  // show: the branches each applies to and who may bypass it.
  const definitions: Record<string, LiveRuleset> = {};
  for (const { name } of desired.rulesets) {
    const live = rulesets.find((ruleset) => ruleset.name === name);
    if (live) definitions[name] = await api.get<LiveRuleset>(`${route}/rulesets/${live.id}`);
  }
  const rules: Record<string, readonly EffectiveRule[]> = {};
  for (const branch of new Set(desired.rulesets.flatMap(targetedBranches))) {
    rules[branch] =
      (await api.find<EffectiveRule[]>(`${route}/rules/branches/${encodeURIComponent(branch)}`)) ??
      [];
  }
  const runs = await api.find<{ workflow_runs: { conclusion: string | null; html_url: string }[] }>(
    // develop's own runs: apply-next starts it there, and a run of a changed
    // copy on another branch says nothing about develop.
    `${route}/actions/workflows/${path.posix.basename(desired.driftWorkflow)}/runs?branch=develop&per_page=1`,
  );
  const latest = runs?.workflow_runs[0];

  return {
    repository: {
      id: repo.id,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      admin: repo.permissions?.admin === true,
    },
    branches: {
      ...(develop === undefined ? {} : { develop }),
      ...(main === undefined ? {} : { main }),
    },
    workflows,
    checks,
    rulesets,
    definitions,
    rules,
    ...(latest ? { driftRun: { conclusion: latest.conclusion, url: latest.html_url } } : {}),
  };
}

export interface Assessment {
  readonly repository: string;
  readonly checkpoints: readonly Checkpoint[];
  readonly observed: Observed;
  readonly desired: Desired;
}

/**
 * Problems with the local handoff that must be fixed before GitHub is touched.
 * A repository that is not a Liftoff project, such as Liftoff's own, can
 * still be assessed against the rulesets it commits.
 */
async function localProblems(fs: ProjectFsPort, directory: string): Promise<string[]> {
  const result = await validateProject(fs, directory);
  return result.findings
    .filter((finding) => finding.severity === "error" && finding.code !== "not-a-liftoff-project")
    .map((finding) => `${finding.path ? `${finding.path}: ` : ""}${finding.message}`);
}

/** Observes the repository and evaluates every checkpoint. Changes nothing. */
export async function assessGovernance(
  ports: { fs: ProjectFsPort; github: GitHubApiPort },
  directory: string,
  repository: string,
): Promise<Assessment> {
  const desired = await readDesired(ports.fs, directory);
  const problems = await localProblems(ports.fs, directory);
  const observed = await observe(ports.github, repository, desired);
  const state = await readGovernanceState(ports.fs, directory);
  // An unfinished probe means the last proof did not finish, whatever an
  // earlier one recorded.
  const proof: ProofRecord | undefined =
    state?.repository.id === observed.repository.id && state.probe === undefined
      ? state.proof
      : undefined;
  return {
    repository,
    desired,
    observed,
    checkpoints: assessCheckpoints(desired, observed, {
      problems,
      ...(proof ? { proof } : {}),
    }),
  };
}
