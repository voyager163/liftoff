import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyNext, resume } from "../../src/application/governance/apply.ts";
import {
  assessGovernance,
  GovernanceError,
  readDesired,
} from "../../src/application/governance/assess.ts";
import { verifyGovernance } from "../../src/application/governance/verify.ts";
import { applyInit, planInit } from "../../src/application/init/init-project.ts";
import type { Action } from "../../src/domain/governance/checkpoints.ts";
import { validateConfig } from "../../src/domain/project/config.ts";
import {
  FakeGitHubApi,
  FakeGitHubError,
  type FakeRepository,
  fakeRepository,
} from "../helpers/fake-github-api.ts";
import { FakeInitializer } from "../helpers/initializer.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const REPOSITORY = "octo/demo";
const now = () => "2026-10-26T00:00:00.000Z";
const yes = { confirm: async () => true, now };

let work: string;
let project: string;
beforeEach(async () => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-governance-"));
  project = path.join(work, "demo");
  const config = validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "python-fastapi",
    workflow: "manual",
    agents: [],
    governance: "single-maintainer-gitflow",
    review: { ai: false },
  });
  const plan = await planInit({ assets, fs }, { config, target: project, liftoffVersion: "1.0.0" });
  await applyInit({ assets, fs, initializer: new FakeInitializer() }, plan, "1.0.0");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const state = () =>
  JSON.parse(readFileSync(path.join(project, ".liftoff/governance.json"), "utf8"));
const next = async (github: FakeGitHubApi) =>
  (await assessGovernance({ fs, github }, project, REPOSITORY)).checkpoints.find(
    (checkpoint) => checkpoint.status === "next",
  );

/** Stages the repository as it would be once the project is pushed and a pull request's checks passed. */
async function pushedAndChecked(repo: FakeRepository) {
  const desired = (
    await assessGovernance({ fs, github: new FakeGitHubApi(repo) }, project, REPOSITORY)
  ).desired;
  repo.workflows = [...desired.workflows];
  const head = "f".repeat(40);
  repo.pulls = [{ head: { sha: head } }];
  repo.checkRuns[head] = [
    { name: "ci-gate", conclusion: "success", app: { id: 15368 }, html_url: "https://ci-gate" },
  ];
  repo.statuses[head] = [
    {
      context: "review-policy",
      state: "success",
      creator: { login: "github-actions[bot]" },
      target_url: "https://review-policy",
    },
  ];
}

describe("GOV-001 assessing reads GitHub and changes nothing", () => {
  it("starts a new repository at its branches, after a valid handoff", async () => {
    const github = new FakeGitHubApi(fakeRepository());
    const assessment = await assessGovernance({ fs, github }, project, REPOSITORY);
    expect(assessment.checkpoints[0]).toMatchObject({ id: "handoff", status: "done" });
    expect(assessment.checkpoints[1]).toMatchObject({
      id: "branches",
      status: "next",
      action: { kind: "create-develop", from: "1".repeat(40) },
    });
    expect(assessment.desired.requiredChecks.map((check) => check.context).sort()).toEqual([
      "ci-gate",
      "review-policy",
    ]);
    expect(assessment.desired.workflows).toContain(".github/workflows/01-pr-ci.yml");
    expect(github.writes()).toEqual([]);
  });

  it("reports an invalid handoff first", async () => {
    rmSync(path.join(project, ".liftoff/manifest.json"));
    const github = new FakeGitHubApi(fakeRepository());
    expect(await next(github)).toMatchObject({
      id: "handoff",
      detail: expect.stringContaining("missing"),
    });
  });
});

describe("GOV-001 each required check is required from the app that produces it", () => {
  it("keeps a check of the same name from two apps as two requirements", async () => {
    const dir = path.join(work, "two-apps");
    mkdirSync(path.join(dir, ".github/rulesets"), { recursive: true });
    for (const [file, app] of [
      ["develop.json", 15368],
      ["main.json", 999],
    ] as const) {
      writeFileSync(
        path.join(dir, ".github/rulesets", file),
        JSON.stringify({
          name: file,
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
          bypass_actors: [],
          rules: [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "ci-gate", integration_id: app }] },
            },
          ],
        }),
      );
    }
    expect((await readDesired(fs, dir)).requiredChecks).toEqual([
      { context: "ci-gate", integrationId: 15368 },
      { context: "ci-gate", integrationId: 999 },
    ]);
  });
});

describe("GOV-002 apply-next takes one agreed step at a time, in order", () => {
  it("goes from a new repository to enforced, proved rules", async () => {
    const repo = fakeRepository();
    const github = new FakeGitHubApi(repo);
    const step = () => applyNext({ fs, github }, project, REPOSITORY, yes);

    expect(await step()).toMatchObject({ kind: "applied", action: { kind: "create-develop" } });
    expect(repo.branches.develop).toBe(repo.branches.main);
    expect(await step()).toMatchObject({ kind: "applied", action: { kind: "set-default-branch" } });
    expect(repo.defaultBranch).toBe("develop");
    // Pushing the files and opening a pull request are the person's steps.
    expect(await step()).toMatchObject({ kind: "person", checkpoint: { id: "workflows" } });
    await pushedAndChecked(repo);
    expect(await step()).toMatchObject({
      kind: "applied",
      action: { kind: "apply-rulesets", names: ["Protect develop", "Protect main"] },
    });
    expect(repo.rulesets.map((ruleset) => [ruleset.name, ruleset.enforcement])).toEqual([
      ["Protect develop", "active"],
      ["Protect main", "active"],
    ]);
    expect(await step()).toMatchObject({ kind: "applied", action: { kind: "run-drift" } });
    expect(await step()).toMatchObject({ kind: "person", checkpoint: { id: "proof" } });

    const proved = await verifyGovernance({ fs, github }, project, REPOSITORY, {
      prove: true,
      confirm: async () => true,
      now,
    });
    expect(proved).toMatchObject({ kind: "proved", passed: true });
    expect(await step()).toMatchObject({ kind: "done" });
    expect(
      state().actions.map((action: { kind: string; outcome: string }) => [
        action.kind,
        action.outcome,
      ]),
    ).toEqual([
      ["create-develop", "done"],
      ["set-default-branch", "done"],
      ["apply-rulesets", "done"],
      ["run-drift", "done"],
    ]);
    expect(state().proof).toMatchObject({ passed: true, rulesetIds: [100, 101] });
  });

  it("changes nothing when the person declines", async () => {
    const github = new FakeGitHubApi(fakeRepository());
    const result = await applyNext({ fs, github }, project, REPOSITORY, {
      confirm: async () => false,
      now,
    });
    expect(result).toMatchObject({ kind: "declined" });
    expect(github.writes()).toEqual([]);
    expect(() => state()).toThrow();
  });

  it("refuses a step other than the one planned", async () => {
    const github = new FakeGitHubApi(fakeRepository());
    const expected: Action = { kind: "set-default-branch", branch: "develop" };
    await expect(
      applyNext({ fs, github }, project, REPOSITORY, { ...yes, expected }),
    ).rejects.toThrow(/make a new plan/);
    expect(github.writes()).toEqual([]);
  });

  it("records a failed step, and offers it again", async () => {
    const repo = fakeRepository({ fullName: "octo/demo" });
    const github = new FakeGitHubApi(repo);
    // develop appears between the observation and the step.
    const confirm = async () => {
      repo.branches.develop = "2".repeat(40);
      return true;
    };
    await expect(applyNext({ fs, github }, project, REPOSITORY, { confirm, now })).rejects.toThrow(
      /Reference already exists/,
    );
    expect(state().actions).toEqual([
      expect.objectContaining({ kind: "create-develop", outcome: "failed", finishedAt: now() }),
    ]);
  });

  it("changes only Liftoff's own rulesets, and only when they are not active", async () => {
    const repo = fakeRepository({
      defaultBranch: "develop",
      branches: { main: "1".repeat(40), develop: "1".repeat(40) },
    });
    await pushedAndChecked(repo);
    const github = new FakeGitHubApi(repo);
    const desired = (await assessGovernance({ fs, github }, project, REPOSITORY)).desired.rulesets;
    const develop = desired.find((ruleset) => ruleset.name === "Protect develop");
    if (!develop) throw new Error("no develop ruleset");
    repo.rulesets = [
      {
        id: 5,
        name: "Protect develop",
        enforcement: "disabled",
        body: { ...develop, enforcement: "disabled" },
      },
      {
        id: 6,
        name: "Organization rules",
        enforcement: "active",
        body: { ...develop, name: "Organization rules" },
      },
    ];
    await applyNext({ fs, github }, project, REPOSITORY, yes);
    expect(github.writes().map((call) => `${call.method} ${call.route}`)).toEqual([
      "PUT /repos/octo/demo/rulesets/5",
      "POST /repos/octo/demo/rulesets",
    ]);
    expect(repo.rulesets.find((ruleset) => ruleset.id === 6)?.name).toBe("Organization rules");
  });

  it("leaves a ruleset that changed on GitHub while the person was deciding", async () => {
    const repo = fakeRepository({
      defaultBranch: "develop",
      branches: { main: "1".repeat(40), develop: "1".repeat(40) },
    });
    await pushedAndChecked(repo);
    const github = new FakeGitHubApi(repo);
    const desired = (await assessGovernance({ fs, github }, project, REPOSITORY)).desired.rulesets;
    const [develop, main] = desired;
    if (!develop || !main) throw new Error("no rulesets");
    repo.rulesets = [{ id: 5, name: develop.name, enforcement: "disabled", body: { ...develop } }];
    // Another admin makes it active, and stricter, before the answer.
    const activated = applyNext({ fs, github }, project, REPOSITORY, {
      ...yes,
      confirm: async () => {
        Object.assign(repo.rulesets[0] ?? {}, { enforcement: "active", updatedAt: "later" });
        return true;
      },
    });
    await expect(activated).rejects.toThrow(/changed on GitHub since it was assessed/);
    // Or creates one of the same name.
    repo.rulesets = [];
    const created = applyNext({ fs, github }, project, REPOSITORY, {
      ...yes,
      confirm: async () => {
        repo.rulesets.push({ id: 6, name: develop.name, enforcement: "active", body: develop });
        return true;
      },
    });
    await expect(created).rejects.toThrow(/changed on GitHub since it was assessed/);
    expect(github.writes().filter((call) => call.route.includes("/rulesets"))).toEqual([]);
  });

  it("leaves the rulesets to an admin", async () => {
    const repo = fakeRepository({
      admin: false,
      defaultBranch: "develop",
      branches: { main: "1".repeat(40), develop: "1".repeat(40) },
    });
    await pushedAndChecked(repo);
    const result = await applyNext(
      { fs, github: new FakeGitHubApi(repo) },
      project,
      REPOSITORY,
      yes,
    );
    expect(result).toMatchObject({
      kind: "person",
      checkpoint: { id: "rulesets", todo: "ask a repository admin to apply them" },
    });
  });
});

describe("GOV-003 an interrupted step is checked, never repeated", () => {
  const interrupted = (repositoryId = 7) =>
    writeFileSync(
      path.join(project, ".liftoff/governance.json"),
      JSON.stringify({
        schema: "liftoff.governance/v1",
        repository: { id: repositoryId, fullName: REPOSITORY },
        actions: [{ checkpoint: "branches", kind: "create-develop", startedAt: now() }],
      }),
    );

  it("records it done when GitHub shows it happened", async () => {
    interrupted();
    const repo = fakeRepository({
      defaultBranch: "develop",
      branches: { main: "1".repeat(40), develop: "1".repeat(40) },
    });
    const github = new FakeGitHubApi(repo);
    await expect(applyNext({ fs, github }, project, REPOSITORY, yes)).rejects.toThrow(/resume/);
    expect(await resume({ fs, github }, project, REPOSITORY, now)).toMatchObject({
      kind: "checked",
      outcome: "done",
    });
    expect(state().actions[0]).toMatchObject({ outcome: "done", finishedAt: now() });
    expect(github.writes()).toEqual([]);
  });

  it("records it failed when GitHub does not, for apply-next to offer again", async () => {
    interrupted();
    const github = new FakeGitHubApi(fakeRepository());
    expect(await resume({ fs, github }, project, REPOSITORY, now)).toMatchObject({
      outcome: "failed",
    });
    expect(github.writes()).toEqual([]);
    expect(await applyNext({ fs, github }, project, REPOSITORY, yes)).toMatchObject({
      kind: "applied",
      action: { kind: "create-develop" },
    });
  });

  it("has nothing to check without an interrupted step, and refuses another repository's record", async () => {
    const github = new FakeGitHubApi(fakeRepository());
    expect(await resume({ fs, github }, project, REPOSITORY, now)).toMatchObject({
      kind: "nothing",
    });
    interrupted(99);
    await expect(resume({ fs, github }, project, REPOSITORY, now)).rejects.toThrow(GovernanceError);
  });
});

describe("GOV-004 the proof tries what the rules forbid", () => {
  const enforced = async (overrides: Partial<FakeRepository> = {}) => {
    const repo = fakeRepository({
      defaultBranch: "develop",
      branches: { main: "1".repeat(40), develop: "1".repeat(40) },
      ...overrides,
    });
    await pushedAndChecked(repo);
    const github = new FakeGitHubApi(repo);
    await applyNext({ fs, github }, project, REPOSITORY, yes);
    return { repo, github };
  };
  const prove = (github: FakeGitHubApi, confirm = async () => true) =>
    verifyGovernance({ fs, github }, project, REPOSITORY, { prove: true, confirm, now });

  it("reads back the rules without changing anything", async () => {
    const { github } = await enforced();
    const before = github.writes().length;
    const result = await verifyGovernance({ fs, github }, project, REPOSITORY, {
      prove: false,
      confirm: async () => true,
      now,
    });
    expect(result).toMatchObject({ kind: "readback", matches: true });
    expect(github.writes()).toHaveLength(before);
  });

  it("passes when GitHub refuses every forbidden change", async () => {
    const { repo, github } = await enforced();
    const result = await prove(github);
    expect(result).toMatchObject({ kind: "proved", passed: true });
    if (result.kind !== "proved") throw new Error("not proved");
    expect(result.results.map((r) => `${r.proof} ${r.branch} ${r.refused}`)).toEqual([
      "direct-push develop true",
      "force-push develop true",
      "deletion develop true",
      "direct-push main true",
      "force-push main true",
      "deletion main true",
    ]);
    expect(repo.branches).toEqual({ main: "1".repeat(40), develop: "1".repeat(40) });
  });

  it("fails, and puts each branch back, when GitHub allows them", async () => {
    const { repo, github } = await enforced({ enforce: false });
    const result = await prove(github);
    expect(result).toMatchObject({ kind: "proved", passed: false });
    expect(repo.branches).toEqual({ main: "1".repeat(40), develop: "1".repeat(40) });
    expect(state().proof).toMatchObject({ passed: false });
  });

  it("reads back who may bypass each ruleset", async () => {
    const { repo, github } = await enforced();
    const develop = repo.rulesets.find((ruleset) => ruleset.name === "Protect develop");
    if (!develop) throw new Error("no develop ruleset");
    develop.body = {
      ...develop.body,
      bypass_actors: [{ actor_id: 9, actor_type: "Team", bypass_mode: "always" }],
    };
    const result = await verifyGovernance({ fs, github }, project, REPOSITORY, {
      prove: false,
      confirm: async () => true,
      now,
    });
    expect(result).toMatchObject({ kind: "readback", matches: false });
    if (result.kind !== "readback") throw new Error("no readback");
    expect(result.assessment.checkpoints.find((c) => c.id === "readback")?.detail).toContain(
      '"Protect develop" (bypass)',
    );
  });

  it("puts a branch back when GitHub's answer to an allowed change is lost", async () => {
    const { repo, github } = await enforced({ enforce: false });
    github.loseAnswer = (method) => method === "PATCH" || method === "DELETE";
    const result = await prove(github);
    expect(result).toMatchObject({ kind: "proved", passed: false });
    if (result.kind !== "proved") throw new Error("not proved");
    expect(result.results[0]?.detail).toContain("GitHub gave no clear answer");
    expect(repo.branches).toEqual({ main: "1".repeat(40), develop: "1".repeat(40) });
    expect(state().probe).toBeUndefined();
  });

  it("keeps the record, and stops, when a branch cannot be put back; resume finishes it", async () => {
    const { repo, github } = await enforced({ enforce: false });
    const head = "1".repeat(40);
    // Pushing on top is allowed, but not moving the branch back.
    github.beforeWrite = (method, _route, body) => {
      const update = body as { sha?: string; force?: boolean } | undefined;
      if (method === "PATCH" && update?.force === true && update.sha === head) {
        throw new FakeGitHubError(422, "Repository rule violations: non_fast_forward");
      }
    };
    const result = await prove(github);
    expect(result).toMatchObject({ kind: "proved", passed: false });
    if (result.kind !== "proved") throw new Error("not proved");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.detail).toContain("could not be put back");
    expect(repo.branches.develop).not.toBe(head);
    expect(state().probe).toMatchObject({ branch: "develop", proof: "direct-push", head });
    await expect(applyNext({ fs, github }, project, REPOSITORY, yes)).rejects.toThrow(/resume/);
    await expect(resume({ fs, github }, project, REPOSITORY, now)).rejects.toThrow(
      /non_fast_forward/,
    );
    expect(state().probe).toBeDefined();
    github.beforeWrite = undefined;
    expect(await resume({ fs, github }, project, REPOSITORY, now)).toMatchObject({
      kind: "probe",
      detail: `develop was put back at ${head.slice(0, 12)}`,
    });
    expect(repo.branches.develop).toBe(head);
    expect(state().probe).toBeUndefined();
  });

  it("never undoes a merge made while the proof runs", async () => {
    const { repo, github } = await enforced({ enforce: false });
    const merge = "e".repeat(40);
    // A merge lands straight after the first allowed change.
    let merged = false;
    github.afterWrite = (method, route) => {
      if (merged || method !== "PATCH" || !route.endsWith("/develop")) return;
      merged = true;
      repo.commits[merge] = { tree: "t".repeat(40), parents: [repo.branches.develop ?? ""] };
      repo.branches.develop = merge;
    };
    const result = await prove(github);
    if (result.kind !== "proved") throw new Error("not proved");
    expect(result.results[0]?.detail).toContain("has moved to eeeeeeeeeeee since, so it was left");
    expect(repo.branches.develop).toBe(merge);

    // A merge while a proof commit is made stops the proof before any change.
    const { repo: other, github: racing } = await enforced();
    let commits = 0;
    racing.beforeWrite = (method, route) => {
      if (method !== "POST" || !route.endsWith("/git/commits") || ++commits !== 2) return;
      other.commits[merge] = { tree: "t".repeat(40), parents: [other.branches.develop ?? ""] };
      other.branches.develop = merge;
    };
    await expect(prove(racing)).rejects.toThrow(/develop moved while the proof was running/);
    expect(other.branches.develop).toBe(merge);
    const forced = racing
      .writes()
      .filter((call) => (call.body as { force?: boolean } | undefined)?.force === true);
    expect(forced).toEqual([]);
    expect(state().probe).toBeUndefined();
  });

  it("proves nothing, and matches nothing, without committed rulesets", async () => {
    const { github } = await enforced();
    const empty = path.join(work, "empty");
    mkdirSync(empty);
    const verify = (proving: boolean) =>
      verifyGovernance({ fs, github }, empty, REPOSITORY, {
        prove: proving,
        confirm: async () => true,
        now,
      });
    expect(await verify(false)).toMatchObject({ kind: "readback", matches: false });
    await expect(verify(true)).rejects.toThrow(/must be applied and match/);
  });

  it("refuses another repository's record before changing anything", async () => {
    const { github } = await enforced();
    writeFileSync(
      path.join(project, ".liftoff/governance.json"),
      JSON.stringify({
        schema: "liftoff.governance/v1",
        repository: { id: 99, fullName: "octo/other" },
        actions: [],
      }),
    );
    const before = github.writes().length;
    await expect(prove(github)).rejects.toThrow(GovernanceError);
    expect(github.writes()).toHaveLength(before);
  });

  it("needs the rules applied first, and the person's agreement", async () => {
    const github = new FakeGitHubApi(fakeRepository());
    await expect(prove(github)).rejects.toThrow(/must be applied and match/);
    const { github: ready } = await enforced();
    const before = ready.writes().length;
    expect(await prove(ready, async () => false)).toEqual({ kind: "declined" });
    expect(ready.writes()).toHaveLength(before);
  });
});
