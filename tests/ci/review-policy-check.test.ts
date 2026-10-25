import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundle } from "../../scripts/build-ci-bundle.ts";
import { main } from "../../src/ci/review-policy-check.ts";
import { type FakePullRequest, startFakeGitHub } from "../helpers/fake-github.ts";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");

const POLICY = `
version: 1
profile: risk-tiered-gitflow
trusted_authors: [alice]
rules:
  - paths: ["docs/**"]
    tier: low
    reason: documentation
  - paths: ["src/auth/**"]
    tier: high
    always_human: true
    reason: authentication
`;

const pullRequest = {
  number: 12,
  state: "open",
  head: { sha: "abc123" },
  base: { ref: "develop" },
  user: { login: "alice" },
};

const approval = (login: string, commit = "abc123") => ({
  user: { login, type: "User" },
  state: "APPROVED",
  commit_id: commit,
  submitted_at: "2026-10-20T00:00:00Z",
});

let workdir: string;
let server: Awaited<ReturnType<typeof startFakeGitHub>> | undefined;

beforeEach(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "liftoff-ci-"));
  await mkdir(path.join(workdir, ".github"), { recursive: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(workdir, { recursive: true, force: true });
});

async function setup(
  pr: FakePullRequest,
  policy: string | null = POLICY,
  eventBody: unknown = { pull_request: pullRequest },
) {
  server = await startFakeGitHub("acme/app", 12, { pull: pullRequest, ...pr });
  if (policy !== null) writeFileSync(path.join(workdir, ".github/review-policy.yml"), policy);
  writeFileSync(path.join(workdir, "event.json"), JSON.stringify(eventBody));
  writeFileSync(path.join(workdir, "summary.md"), "");
  writeFileSync(path.join(workdir, "output.txt"), "");
  return {
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: path.join(workdir, "event.json"),
    GITHUB_STEP_SUMMARY: path.join(workdir, "summary.md"),
    GITHUB_OUTPUT: path.join(workdir, "output.txt"),
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_TOKEN: "secret",
    GITHUB_API_URL: server.url,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "99",
  } as Record<string, string | undefined>;
}

const inProcess = (env: Record<string, string | undefined>) => {
  const logs: string[] = [];
  return {
    logs,
    run: () =>
      main({
        env,
        readFile: (file) =>
          readFileSync(path.isAbsolute(file) ? file : path.join(workdir, file), "utf8"),
        appendFile: (file, text) => writeFileSync(file, readFileSync(file, "utf8") + text),
        log: (text) => logs.push(text),
      }),
  };
};

const noFiles: FakePullRequest = { files: [], reviews: [], permissions: {} };

describe("REVIEW-010 the review-policy check reports a head-commit status", () => {
  it("passes a low-risk change and reports success on the head commit", async () => {
    const env = await setup({
      ...noFiles,
      files: [{ filename: "docs/a.md", additions: 3, deletions: 0 }],
    });
    expect(await inProcess(env).run()).toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT as string, "utf8")).toBe(
      "tier=low\ndepth=quick\nrequired-approvals=0\napprovals=0\nalways-human=false\n",
    );
    expect(readFileSync(env.GITHUB_STEP_SUMMARY as string, "utf8")).toContain(
      "## Review policy: passed",
    );
    expect(server?.statuses).toEqual([
      {
        sha: "abc123",
        body: {
          state: "success",
          context: "review-policy",
          description: "low risk: 0 of 0 required approvals",
          target_url: "https://github.com/acme/app/actions/runs/99",
        },
      },
    ]);
  });

  it("fails a high-risk change until two people approve the current commit", async () => {
    const env = await setup({
      files: [{ filename: "src/auth/login.ts", additions: 10, deletions: 2 }],
      reviews: [
        approval("bob"),
        approval("carol", "old"),
        { ...approval("dependabot"), user: { login: "dependabot", type: "Bot" } },
      ],
      permissions: { bob: "write", carol: "write", dependabot: "write" },
    });
    expect(await inProcess(env).run()).toBe(1);
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY as string, "utf8");
    expect(summary).toContain("## Review policy: needs approval");
    expect(summary).toContain("| **high** | deep | risk-tiered-gitflow | 1 of 2 |");
    expect(summary).toContain("@carol: approval is for an older commit");
    expect(summary).toContain("@dependabot: bot approvals never count");
    expect(summary).toContain("Needs 1 more approval");
    expect(summary).toContain("Always needs a person: `src/auth/login.ts`");
    expect(server?.statuses.at(-1)?.body).toMatchObject({
      state: "failure",
      description: "high risk: 1 of 2 required approvals",
    });
  });

  it("passes once enough people approve", async () => {
    const env = await setup({
      files: [{ filename: "src/auth/login.ts", additions: 1, deletions: 0 }],
      reviews: [approval("bob"), approval("carol")],
      permissions: { bob: "write", carol: "admin" },
    });
    expect(await inProcess(env).run()).toBe(0);
    expect(server?.statuses.at(-1)?.body.state).toBe("success");
  });

  it("summarises long path lists", async () => {
    const env = await setup({
      ...noFiles,
      files: Array.from({ length: 8 }, (_, i) => ({
        filename: `src/x${i}.ts`,
        additions: 1,
        deletions: 0,
      })),
    });
    await inProcess(env).run();
    expect(readFileSync(env.GITHUB_STEP_SUMMARY as string, "utf8")).toContain("and 3 more");
  });

  it("re-checks a pull request dispatched from its base branch", async () => {
    const env = await setup(
      { ...noFiles, files: [{ filename: "docs/a.md", additions: 1, deletions: 0 }] },
      POLICY,
      { inputs: { pull_request: "12" } },
    );
    const dispatched = {
      ...env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/develop",
    };
    expect(await inProcess(dispatched).run()).toBe(0);
    expect(server?.requests.some((r) => r.endsWith("/repos/acme/app/pulls/12"))).toBe(true);
    expect(server?.statuses.at(-1)).toMatchObject({ sha: "abc123", body: { state: "success" } });
  });

  it("refuses a dispatch from any other branch and reports the error on the pull request", async () => {
    const env = await setup(noFiles, POLICY, { inputs: { pull_request: "12" } });
    const check = inProcess({
      ...env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/attacker",
    });
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain("dispatch this check from develop");
    expect(server?.statuses).toEqual([]);
  });

  it.each([
    [{ inputs: {} }, "needs a pull_request input"],
    [{ inputs: { pull_request: "-3" } }, "needs a pull_request input"],
  ])("rejects a dispatch without a valid pull request %#", async (eventBody, message) => {
    const env = await setup(noFiles, POLICY, eventBody);
    const check = inProcess({
      ...env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/develop",
    });
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain(message);
  });

  it("rejects a dispatch for a closed pull request", async () => {
    server = await startFakeGitHub("acme/app", 12, {
      ...noFiles,
      pull: { ...pullRequest, state: "closed" },
    });
    writeFileSync(
      path.join(workdir, "event.json"),
      JSON.stringify({ inputs: { pull_request: "12" } }),
    );
    const check = inProcess({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: path.join(workdir, "event.json"),
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "t",
      GITHUB_API_URL: server.url,
    });
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain("#12 is not open");
  });

  it("reports success on the merge queue commit", async () => {
    server = await startFakeGitHub("acme/app", 12, noFiles);
    const check = inProcess({
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_SHA: "f00d",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "t",
      GITHUB_API_URL: server.url,
    });
    expect(await check.run()).toBe(0);
    expect(check.logs.join("")).toContain("merge queue");
    expect(server.statuses).toEqual([
      {
        sha: "f00d",
        body: {
          state: "success",
          context: "review-policy",
          description: "Evaluated on each pull request before it entered the queue",
        },
      },
    ]);
  });

  it.each([
    [{ GITHUB_EVENT_NAME: "pull_request" }, "run this check on pull_request_target"],
    [{}, "got no event"],
  ])("fails closed on the wrong trigger %#", async (env, message) => {
    const check = inProcess(env);
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain(message);
  });

  it("reports an error status when the base branch has no policy", async () => {
    const env = await setup(noFiles, null);
    const check = inProcess(env);
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain("the base branch has no .github/review-policy.yml");
    expect(server?.statuses.at(-1)?.body).toMatchObject({
      state: "error",
      context: "review-policy",
    });
  });

  it("fails closed without a token or a pull request", async () => {
    const env = await setup(noFiles);
    const noToken = inProcess({
      ...env,
      GITHUB_TOKEN: undefined,
      GITHUB_STEP_SUMMARY: undefined,
      GITHUB_OUTPUT: undefined,
    });
    expect(await noToken.run()).toBe(1);
    expect(noToken.logs.join("")).toContain("GITHUB_TOKEN is not set");

    writeFileSync(env.GITHUB_EVENT_PATH as string, JSON.stringify({}));
    const noPr = inProcess(env);
    expect(await noPr.run()).toBe(1);
    expect(noPr.logs.join("")).toContain("the event has no pull request");
  });
});

describe("REVIEW-007 the committed bundle matches source and works", () => {
  it("is identical to a fresh build", async () => {
    const committed = readFileSync(
      path.join(repoRoot, ".github/liftoff/review-policy.mjs"),
      "utf8",
    );
    expect(await bundle("src/ci/review-policy-entry.ts")).toBe(committed);
  });

  it("runs as a standalone script against the GitHub API", async () => {
    const script = path.join(repoRoot, ".github/liftoff/review-policy.mjs");
    const env = await setup({
      files: [{ filename: "src/auth/login.ts", additions: 1, deletions: 0 }],
      reviews: [approval("bob")],
      permissions: { bob: "write" },
    });
    const failed = await run(process.execPath, [script], {
      cwd: workdir,
      env: { ...env, PATH: process.env.PATH },
    }).catch((error: { code: number; stdout: string }) => error);
    expect((failed as { code: number }).code).toBe(1);
    expect((failed as { stdout: string }).stdout).toContain("1 of 2");
    expect(server?.statuses.at(-1)?.body.state).toBe("failure");
  });
});
