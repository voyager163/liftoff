import { describe, expect, it } from "vitest";
import { type Mode, main } from "../../src/ci/branch-policy-check.ts";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

interface Repo {
  /** compare/<base>...<sha> answers. */
  compare?: Record<string, { ahead_by: number; behind_by: number }>;
  runs?: { path: string; conclusion: string | null }[];
  tags?: string[];
  trees?: Record<string, string>;
  /** Answer every request with a server error. */
  down?: boolean;
  /** The pull request as GitHub has it now, when it differs from the event. */
  current?: { body?: string | null; base?: { ref: string } };
}

/** Answers the GitHub REST routes the checks read, from `repo`. */
function fakeFetch(repo: Repo, requests: string[], pull: Record<string, unknown>) {
  return async (input: string): Promise<Response> => {
    const url = new URL(input);
    requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (repo.down) return json({ message: "unavailable" }, 503);
    const compare = /\/compare\/([^.]+)\.\.\.(\w+)$/.exec(url.pathname);
    if (compare) return json(repo.compare?.[compare[1] ?? ""] ?? { ahead_by: 0, behind_by: 0 });
    if (url.pathname.endsWith("/pulls/7")) return json({ ...pull, ...repo.current });
    const workflow = /\/actions\/workflows\/([^/]+)\/runs$/.exec(url.pathname)?.[1];
    if (workflow !== undefined) {
      // Only successful runs are asked for.
      expect(url.searchParams.get("status")).toBe("success");
      const passed = (repo.runs ?? []).filter(
        (run) => run.path.endsWith(`/${workflow}`) && run.conclusion === "success",
      );
      return json({ total_count: passed.length });
    }
    const tag = /\/git\/ref\/tags\/v(.+)$/.exec(url.pathname);
    if (tag) return (repo.tags ?? []).includes(tag[1] ?? "") ? json({}) : json({}, 404);
    const commit = /\/git\/commits\/(\w+)$/.exec(url.pathname);
    if (commit) return json({ tree: { sha: repo.trees?.[commit[1] ?? ""] ?? "tree" } });
    return json({ message: "not found" }, 404);
  };
}

const run = async (
  mode: Mode,
  pr: { head: string; base: string; body?: string },
  repo: Repo = {},
  env: Record<string, string> = {},
) => {
  const logs: string[] = [];
  const requests: string[] = [];
  const event = {
    pull_request: {
      number: 7,
      body: pr.body ?? null,
      head: { ref: pr.head, sha: HEAD },
      base: { ref: pr.base },
    },
  };
  const code = await main(mode, {
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: "event.json",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_SHA: MERGE,
      AUTOMATION_BRANCHES: "dependabot, copilot",
      ...env,
    },
    readFile: () => JSON.stringify(event),
    appendFile: () => undefined,
    log: (text) => logs.push(text),
    fetch: fakeFetch(repo, requests, event.pull_request),
  });
  // A check of a pull request reads it first; the rest is what it asked.
  const [first, ...rest] = requests;
  return { code, log: logs.join(""), requests: first === "/repos/o/r/pulls/7" ? rest : requests };
};

const CI_PASSED = { runs: [{ path: ".github/workflows/01-pr-ci.yml", conclusion: "success" }] };

describe("FLOW-001 the branch-policy check", () => {
  it("passes work and tool branches into develop without asking GitHub", async () => {
    for (const head of ["feature/x", "dependabot/npm/y", "copilot/z"]) {
      const result = await run("branch", { head, base: "develop" });
      expect(result.code).toBe(0);
      expect(result.requests).toEqual([]);
    }
  });

  it("fails a branch that may not merge there", async () => {
    const { code, log } = await run("branch", { head: "feat/x", base: "develop" });
    expect(code).toBe(1);
    expect(log).toContain("## Branch policy: failed");
    expect(log).toContain("feat/x cannot merge into develop");
  });

  it("passes a release at a develop commit whose CI passed", async () => {
    const { code, requests } = await run(
      "branch",
      { head: "release/1.2.0", base: "main" },
      {
        compare: { develop: { ahead_by: 0, behind_by: 3 } },
        ...CI_PASSED,
      },
    );
    expect(code).toBe(0);
    expect(requests).toEqual([
      `/repos/o/r/compare/develop...${HEAD}`,
      `/repos/o/r/actions/workflows/01-pr-ci.yml/runs?head_sha=${HEAD}&branch=develop&event=push&status=success&per_page=1`,
      "/repos/o/r/git/ref/tags/v1.2.0",
    ]);
  });

  it.each([
    [
      "has commits develop does not",
      { compare: { develop: { ahead_by: 2, behind_by: 0 } }, ...CI_PASSED },
      "has 2 commit(s) that are not on develop",
    ],
    ["has no passing CI on develop", { runs: [] }, "CI has not passed on develop"],
    [
      "had CI fail on develop",
      { runs: [{ path: ".github/workflows/01-pr-ci.yml", conclusion: "failure" }] },
      "CI has not passed on develop",
    ],
    [
      "passed some other workflow only",
      { runs: [{ path: ".github/workflows/02-codeql.yml", conclusion: "success" }] },
      "CI has not passed on develop",
    ],
    ["is already released", { ...CI_PASSED, tags: ["1.2.0"] }, "v1.2.0 is already released"],
  ])("fails a release that %s", async (_case, repo, message) => {
    const { code, log } = await run("branch", { head: "release/1.2.0", base: "main" }, repo);
    expect(code).toBe(1);
    expect(log).toContain(message);
  });

  it("reads the description and base as they are now, not as the event recorded them", async () => {
    const hotfix = { head: "hotfix/1.2.1", base: "main", body: "Incident: INC-7" };
    const removed = await run("branch", hotfix, { current: { body: "No incident any more" } });
    expect(removed.code).toBe(1);
    expect(removed.log).toContain('needs an "Incident: <reference>" line');
    const added = await run(
      "branch",
      { ...hotfix, body: "" },
      { current: { body: "Incident: INC-7" } },
    );
    expect(added.code).toBe(0);
    const retargeted = await run(
      "branch",
      { head: "feature/x", base: "develop" },
      {
        current: { base: { ref: "main" } },
      },
    );
    expect(retargeted.log).toContain("feature/x cannot merge into main");
  });

  it("checks that a hotfix starts from the current main and names its incident", async () => {
    const hotfix = { head: "hotfix/1.2.1", base: "main", body: "Incident: INC-7" };
    expect((await run("branch", hotfix)).code).toBe(0);
    const behind = await run("branch", hotfix, {
      compare: { main: { ahead_by: 1, behind_by: 2 } },
    });
    expect(behind.code).toBe(1);
    expect(behind.log).toContain("does not start from the current main");
    const unnamed = await run("branch", { ...hotfix, body: "" });
    expect(unnamed.log).toContain('needs an "Incident: <reference>" line');
  });
});

describe("FLOW-002 the release-lineage check", () => {
  it("passes when the candidate contains main and merging keeps its tree", async () => {
    const { code, requests } = await run(
      "lineage",
      { head: "release/1.2.0", base: "main" },
      {
        trees: { [HEAD]: "t1", [MERGE]: "t1" },
      },
    );
    expect(code).toBe(0);
    expect(requests).toEqual([
      `/repos/o/r/compare/main...${HEAD}`,
      `/repos/o/r/git/commits/${MERGE}`,
      `/repos/o/r/git/commits/${HEAD}`,
    ]);
  });

  it("fails a candidate missing commits from main", async () => {
    const { code, log } = await run(
      "lineage",
      { head: "release/1.2.0", base: "main" },
      {
        compare: { main: { ahead_by: 4, behind_by: 1 } },
      },
    );
    expect(code).toBe(1);
    expect(log).toContain("is missing 1 commit(s) from main");
  });

  it("fails when merging would change the qualified tree", async () => {
    const { code, log } = await run(
      "lineage",
      { head: "release/1.2.0", base: "main" },
      {
        trees: { [HEAD]: "t1", [MERGE]: "t2" },
      },
    );
    expect(code).toBe(1);
    expect(log).toContain("would not leave exactly the tree");
  });

  it("does not compare trees when the merge is the candidate itself", async () => {
    const { code, requests } = await run(
      "lineage",
      { head: "release/1.2.0", base: "main" },
      {},
      { GITHUB_SHA: HEAD },
    );
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("has nothing to check outside pull requests into main", async () => {
    expect((await run("lineage", { head: "feature/x", base: "develop" })).requests).toEqual([]);
    const push = await run(
      "lineage",
      { head: "x", base: "main" },
      {},
      { GITHUB_EVENT_NAME: "push" },
    );
    expect(push.code).toBe(0);
    expect(push.log).toContain("a push has nothing to check");
  });
});

describe("FLOW-001 failing closed", () => {
  it("errors without its configuration or event", async () => {
    const missing = await run(
      "branch",
      { head: "feature/x", base: "develop" },
      {},
      { GITHUB_TOKEN: "" },
    );
    expect(missing.code).toBe(1);
    expect(missing.log).toContain("GITHUB_TOKEN is not set");
    const logs: string[] = [];
    const code = await main("branch", {
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "e" },
      readFile: () => "{}",
      appendFile: () => undefined,
      log: (text) => logs.push(text),
    });
    expect(code).toBe(1);
    expect(logs.join("")).toContain("the event has no pull request");
  });

  it("reports a GitHub failure as an error", async () => {
    const { code, log } = await run(
      "branch",
      { head: "release/1.2.0", base: "main" },
      {
        down: true,
      },
    );
    expect(code).toBe(1);
    expect(log).toContain("## Branch policy: error");
    expect(log).toContain("returned HTTP 503");
  });
});
