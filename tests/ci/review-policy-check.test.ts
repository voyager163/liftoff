import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleReviewPolicy } from "../../scripts/build-ci-bundle.ts";
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

const event = (headSha = "head") =>
  JSON.stringify({
    pull_request: { number: 12, head: { sha: headSha }, user: { login: "alice" } },
  });

const approval = (login: string, commit = "head") => ({
  user: { login, type: "User" },
  state: "APPROVED",
  commit_id: commit,
  submitted_at: "2026-10-20T00:00:00Z",
});

let workdir: string;
let closeServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "liftoff-ci-"));
  await mkdir(path.join(workdir, ".github"), { recursive: true });
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  rmSync(workdir, { recursive: true, force: true });
});

async function setup(pr: FakePullRequest, policy: string | null = POLICY) {
  const server = await startFakeGitHub("acme/app", 12, pr);
  closeServer = server.close;
  if (policy !== null) writeFileSync(path.join(workdir, ".github/review-policy.yml"), policy);
  writeFileSync(path.join(workdir, "event.json"), event());
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
  };
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

describe("REVIEW-009 the review-policy check in CI", () => {
  it("passes a low-risk change with no approvals", async () => {
    const env = await setup({
      files: [{ filename: "docs/a.md", additions: 3, deletions: 0 }],
      reviews: [],
      permissions: {},
    });
    expect(await inProcess(env).run()).toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(
      "tier=low\ndepth=quick\nrequired-approvals=0\napprovals=0\nalways-human=false\n",
    );
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("## Review policy: passed");
  });

  it("fails a high-risk change until two people approve the current commit", async () => {
    const files = [{ filename: "src/auth/login.ts", additions: 10, deletions: 2 }];
    const env = await setup({
      files,
      reviews: [
        approval("bob"),
        approval("carol", "old"),
        { ...approval("dependabot"), user: { login: "dependabot", type: "Bot" } },
      ],
      permissions: { bob: "write", carol: "write", dependabot: "write" },
    });
    const check = inProcess(env);
    expect(await check.run()).toBe(1);
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    expect(summary).toContain("## Review policy: needs approval");
    expect(summary).toContain("| **high** | deep | risk-tiered-gitflow | 1 of 2 |");
    expect(summary).toContain("@carol: approval is for an older commit");
    expect(summary).toContain("@dependabot: bot approvals never count");
    expect(summary).toContain("Needs 1 more approval");
    expect(summary).toContain("Always needs a person: `src/auth/login.ts`");
  });

  it("passes once enough people approve", async () => {
    const env = await setup({
      files: [{ filename: "src/auth/login.ts", additions: 1, deletions: 0 }],
      reviews: [approval("bob"), approval("carol")],
      permissions: { bob: "write", carol: "admin" },
    });
    expect(await inProcess(env).run()).toBe(0);
  });

  it("summarises long path lists", async () => {
    const env = await setup({
      files: Array.from({ length: 8 }, (_, i) => ({
        filename: `src/x${i}.ts`,
        additions: 1,
        deletions: 0,
      })),
      reviews: [],
      permissions: {},
    });
    await inProcess(env).run();
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("and 3 more");
  });

  it("succeeds in the merge queue without re-evaluating", async () => {
    const check = inProcess({ GITHUB_EVENT_NAME: "merge_group" });
    expect(await check.run()).toBe(0);
    expect(check.logs.join("")).toContain("merge queue");
  });

  it.each([
    [{ GITHUB_EVENT_NAME: "pull_request" }, "run this check on pull_request_target"],
    [{}, "got no event"],
  ])("fails closed on the wrong trigger %#", async (env, message) => {
    const check = inProcess(env);
    expect(await check.run()).toBe(1);
    expect(check.logs.join("")).toContain(message);
  });

  it("fails closed when the base has no policy, the token is missing or the event has no PR", async () => {
    const env = await setup({ files: [], reviews: [], permissions: {} }, null);
    const noPolicy = inProcess(env);
    expect(await noPolicy.run()).toBe(1);
    expect(noPolicy.logs.join("")).toContain("the base branch has no .github/review-policy.yml");

    writeFileSync(path.join(workdir, ".github/review-policy.yml"), POLICY);
    const noToken = inProcess({
      ...env,
      GITHUB_TOKEN: undefined,
      GITHUB_STEP_SUMMARY: undefined,
      GITHUB_OUTPUT: undefined,
    });
    expect(await noToken.run()).toBe(1);
    expect(noToken.logs.join("")).toContain("GITHUB_TOKEN is not set");

    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({}));
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
    expect(await bundleReviewPolicy()).toBe(committed);
  });

  it("runs as a standalone script against the GitHub API", async () => {
    const env = await setup({
      files: [{ filename: "src/auth/login.ts", additions: 1, deletions: 0 }],
      reviews: [approval("bob")],
      permissions: { bob: "write" },
    });
    const script = path.join(repoRoot, ".github/liftoff/review-policy.mjs");
    const failed = await run(process.execPath, [script], {
      cwd: workdir,
      env: { ...env, PATH: process.env.PATH },
    }).catch((error: { code: number; stdout: string }) => error);
    expect((failed as { code: number }).code).toBe(1);
    expect((failed as { stdout: string }).stdout).toContain("1 of 2");

    const lowRisk = await setup({
      files: [{ filename: "docs/x.md", additions: 1, deletions: 0 }],
      reviews: [],
      permissions: {},
    });
    const passed = await run(process.execPath, [script], {
      cwd: workdir,
      env: { ...lowRisk, PATH: process.env.PATH },
    });
    expect(passed.stdout).toContain("## Review policy: passed");
  });
});
