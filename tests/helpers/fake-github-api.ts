import type { GitHubApiPort } from "../../src/application/ports.ts";
import type { DesiredRuleset, Rule } from "../../src/domain/governance/ruleset-drift.ts";

export interface FakeRuleset {
  id: number;
  name: string;
  enforcement: string;
  body: DesiredRuleset;
  /** Changes with every update, as GitHub's updated_at does. */
  updatedAt?: string;
}

/** A repository as the fake GitHub API holds it. Tests change it to stage each checkpoint. */
export interface FakeRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  admin: boolean;
  origin?: string;
  branches: Record<string, string>;
  commits: Record<string, { tree: string; parents: string[]; message?: string }>;
  /** Workflow files on the default branch. */
  workflows: string[];
  pulls: { head: { sha: string } }[];
  checkRuns: Record<
    string,
    { name: string; conclusion: string; app: { id: number }; html_url: string }[]
  >;
  statuses: Record<
    string,
    { context: string; state: string; creator: { login: string }; target_url: string }[]
  >;
  rulesets: FakeRuleset[];
  driftRuns: { conclusion: string | null; html_url: string }[];
  /** GitHub's record of changes to each branch, oldest first, as its activity API keeps it. */
  activity?: { ref: string; before: string; after: string; activity_type: string }[];
  /** False to act like a repository whose rules GitHub does not enforce on pushes. */
  enforce: boolean;
}

export class FakeGitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

/** A new repository with only main, at one commit. */
export function fakeRepository(overrides: Partial<FakeRepository> = {}): FakeRepository {
  const main = "1".repeat(40);
  return {
    id: 7,
    fullName: "octo/demo",
    defaultBranch: "main",
    admin: true,
    origin: "https://github.com/octo/demo.git",
    branches: { main },
    commits: { [main]: { tree: "t".repeat(40), parents: [] } },
    workflows: [],
    pulls: [],
    checkRuns: {},
    statuses: {},
    rulesets: [],
    driftRuns: [],
    enforce: true,
    ...overrides,
  };
}

/**
 * The GitHub REST API the governance commands use, in memory. It applies the
 * active rulesets' rules to ref changes as GitHub does, and records every
 * call in `calls`.
 */
export class FakeGitHubApi implements GitHubApiPort {
  readonly calls: { method: string; route: string; body?: unknown }[] = [];
  readonly repo: FakeRepository;
  /**
   * Runs before each write, so a test can change the repository as someone
   * else would, or refuse the write by throwing.
   */
  beforeWrite: ((method: string, route: string, body?: unknown) => void) | undefined;
  /** Runs after each write that GitHub made, as someone else's change straight after. */
  afterWrite: ((method: string, route: string) => void) | undefined;
  /** Writes whose change GitHub makes but whose answer is lost, as on a timeout. */
  loseAnswer: ((method: string, route: string) => boolean) | undefined;
  private nextId = 100;
  private stamps = 0;

  constructor(repo: FakeRepository) {
    this.repo = repo;
  }

  async repositoryOf(): Promise<string | undefined> {
    return this.repo.origin?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  }

  async get<T>(route: string): Promise<T> {
    this.calls.push({ method: "GET", route });
    return this.handle("GET", route) as T;
  }

  async find<T>(route: string): Promise<T | undefined> {
    try {
      return await this.get<T>(route);
    } catch (error) {
      if (error instanceof FakeGitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  async send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", route: string, body?: unknown) {
    this.beforeWrite?.(method, route, body);
    this.calls.push({ method, route, ...(body === undefined ? {} : { body }) });
    const answer = this.handle(method, route, body) as T;
    this.afterWrite?.(method, route);
    return answer;
  }

  async attempt(method: "PATCH" | "DELETE", route: string, body?: unknown) {
    try {
      await this.send(method, route, body);
      if (this.loseAnswer?.(method, route)) {
        return { ok: false, message: "the connection timed out" } as const;
      }
      return { ok: true } as const;
    } catch (error) {
      if (!(error instanceof FakeGitHubError)) throw error;
      return { ok: false, status: error.status, message: error.message } as const;
    }
  }

  /** A new updated_at, later than any before. */
  private stamp() {
    return `2026-10-26T00:00:${String(++this.stamps % 60).padStart(2, "0")}Z`;
  }

  /** The writes made so far. */
  writes() {
    return this.calls.filter((call) => call.method !== "GET");
  }

  private rulesFor(branch: string): Rule[] {
    return this.repo.rulesets
      .filter(
        (ruleset) =>
          ruleset.enforcement === "active" &&
          ruleset.body.conditions.ref_name.include.includes(`refs/heads/${branch}`),
      )
      .flatMap((ruleset) =>
        ruleset.body.rules.map((rule) => ({ ...rule, ruleset_id: ruleset.id })),
      );
  }

  private handle(method: string, route: string, body?: unknown): unknown {
    const repo = this.repo;
    const [pathPart = "", query = ""] = route.split("?");
    const base = `/repos/${repo.fullName}`;
    if (!pathPart.startsWith(base)) throw new FakeGitHubError(404, `no repository at ${route}`);
    const rest = pathPart.slice(base.length);
    const input = (body ?? {}) as Record<string, unknown>;
    const has = (type: string, branch: string) =>
      this.repo.enforce && this.rulesFor(branch).some((rule) => rule.type === type);
    // The path's one captured part, for this method, or undefined.
    const on = (verb: string, pattern: RegExp): string | undefined => {
      const captured = method === verb ? pattern.exec(rest)?.[1] : undefined;
      return captured === undefined ? undefined : decodeURIComponent(captured);
    };

    if (method === "GET" && rest === "") {
      return {
        id: repo.id,
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        permissions: { admin: repo.admin },
      };
    }
    if (method === "PATCH" && rest === "") {
      repo.defaultBranch = String(input.default_branch);
      return {};
    }
    const branchName = on("GET", /^\/branches\/(.+)$/);
    if (branchName !== undefined) {
      const sha = repo.branches[branchName];
      if (sha === undefined) throw new FakeGitHubError(404, "Branch not found");
      return { commit: { sha } };
    }
    if (method === "GET" && rest === "/contents/.github/workflows") {
      if (
        new URLSearchParams(query).get("ref") !== repo.defaultBranch ||
        repo.workflows.length === 0
      ) {
        throw new FakeGitHubError(404, "Not Found");
      }
      return repo.workflows.map((file) => ({ path: file, type: "file" }));
    }
    if (method === "GET" && rest === "/pulls") return repo.pulls;
    // One page of a list, as GitHub's per_page and page parameters select.
    const page = <T>(items: T[]): T[] => {
      const params = new URLSearchParams(query);
      const size = Number(params.get("per_page") ?? 30);
      const number = Number(params.get("page") ?? 1);
      return items.slice((number - 1) * size, number * size);
    };
    const checkedSha = on("GET", /^\/commits\/(\w+)\/check-runs$/);
    if (checkedSha !== undefined) {
      return { check_runs: page(repo.checkRuns[checkedSha] ?? []) };
    }
    const statusSha = on("GET", /^\/commits\/(\w+)\/statuses$/);
    if (statusSha !== undefined) {
      return page(repo.statuses[statusSha] ?? []);
    }
    if (method === "GET" && rest === "/rulesets") {
      // The list gives no updated_at; the ruleset by id does.
      return repo.rulesets.map(({ id, name, enforcement }) => ({ id, name, enforcement }));
    }
    const shownId = on("GET", /^\/rulesets\/(\d+)$/);
    if (shownId !== undefined) {
      const shown = repo.rulesets.find((ruleset) => ruleset.id === Number(shownId));
      if (!shown) throw new FakeGitHubError(404, "Not Found");
      return {
        ...shown.body,
        id: shown.id,
        enforcement: shown.enforcement,
        updated_at: shown.updatedAt ?? "2026-10-01T00:00:00Z",
      };
    }
    if (method === "POST" && rest === "/rulesets") {
      const ruleset = input as unknown as DesiredRuleset;
      repo.rulesets.push({
        id: this.nextId++,
        name: ruleset.name,
        enforcement: ruleset.enforcement,
        body: ruleset,
        updatedAt: this.stamp(),
      });
      return {};
    }
    const rulesetId = on("PUT", /^\/rulesets\/(\d+)$/);
    if (rulesetId !== undefined) {
      const existing = repo.rulesets.find((ruleset) => ruleset.id === Number(rulesetId));
      if (!existing) throw new FakeGitHubError(404, "Not Found");
      const ruleset = input as unknown as DesiredRuleset;
      Object.assign(existing, {
        name: ruleset.name,
        enforcement: ruleset.enforcement,
        body: ruleset,
        updatedAt: this.stamp(),
      });
      return {};
    }
    const rulesBranch = on("GET", /^\/rules\/branches\/(.+)$/);
    if (rulesBranch !== undefined) {
      return this.rulesFor(rulesBranch);
    }
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(rest)) {
      if (!repo.workflows.some((file) => file.endsWith("90-governance-drift.yml"))) {
        throw new FakeGitHubError(404, "Not Found");
      }
      return { workflow_runs: [...repo.driftRuns].reverse().slice(0, 1) };
    }
    if (method === "POST" && /^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest)) {
      repo.driftRuns.push({
        conclusion: "success",
        html_url: `https://github.com/${repo.fullName}/actions/runs/${this.nextId++}`,
      });
      return undefined;
    }
    if (method === "GET" && rest === "/activity") {
      const ref = new URLSearchParams(query).get("ref");
      return page([...(repo.activity ?? [])].reverse().filter((entry) => entry.ref === ref));
    }
    const refBranch = on("GET", /^\/git\/ref\/heads\/(.+)$/);
    if (refBranch !== undefined) {
      const sha = repo.branches[refBranch];
      if (sha === undefined) throw new FakeGitHubError(404, "Not Found");
      return { object: { sha } };
    }
    const commitSha = on("GET", /^\/git\/commits\/(\w+)$/);
    if (commitSha !== undefined) {
      const commit = repo.commits[commitSha];
      if (!commit) throw new FakeGitHubError(404, "Not Found");
      return {
        tree: { sha: commit.tree },
        parents: commit.parents.map((sha) => ({ sha })),
        message: commit.message ?? "",
      };
    }
    if (method === "POST" && rest === "/git/commits") {
      const sha = String(this.nextId++).padStart(40, "c");
      repo.commits[sha] = {
        tree: String(input.tree),
        parents: input.parents as string[],
        message: String(input.message ?? ""),
      };
      return { sha };
    }
    if (method === "POST" && rest === "/git/refs") {
      const branch = String(input.ref).replace("refs/heads/", "");
      if (repo.branches[branch]) throw new FakeGitHubError(422, "Reference already exists");
      repo.branches[branch] = String(input.sha);
      return {};
    }
    const branch =
      on("PATCH", /^\/git\/refs\/heads\/(.+)$/) ?? on("DELETE", /^\/git\/refs\/heads\/(.+)$/);
    if (branch !== undefined) {
      const head = repo.branches[branch];
      if (head === undefined) throw new FakeGitHubError(404, "Not Found");
      if (method === "DELETE") {
        // As GitHub does, whatever the rules.
        if (branch === repo.defaultBranch) {
          throw new FakeGitHubError(422, "Cannot delete the default branch");
        }
        if (has("deletion", branch))
          throw new FakeGitHubError(422, "Repository rule violations: deletion");
        delete repo.branches[branch];
        repo.activity = repo.activity ?? [];
        repo.activity.push({
          ref: `refs/heads/${branch}`,
          before: head,
          after: "0".repeat(40),
          activity_type: "branch_deletion",
        });
        return undefined;
      }
      const sha = String(input.sha);
      const fastForward = repo.commits[sha]?.parents.includes(head) === true;
      if (!fastForward && has("non_fast_forward", branch)) {
        throw new FakeGitHubError(422, "Repository rule violations: non_fast_forward");
      }
      if (has("pull_request", branch)) {
        throw new FakeGitHubError(
          422,
          "Repository rule violations: changes must be made through a pull request",
        );
      }
      if (!fastForward && input.force !== true)
        throw new FakeGitHubError(422, "Update is not a fast forward");
      repo.branches[branch] = sha;
      return {};
    }
    throw new FakeGitHubError(404, `no fake for ${method} ${route}`);
  }
}
