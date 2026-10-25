import { describe, expect, it } from "vitest";
import {
  assessCheckpoints,
  type Desired,
  GITHUB_ACTIONS_APP_ID,
  type Observed,
} from "../../src/domain/governance/checkpoints.ts";
import type { DesiredRuleset } from "../../src/domain/governance/ruleset-drift.ts";

const RULESET: DesiredRuleset = {
  name: "Protect develop",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};

const DESIRED: Desired = {
  rulesets: [RULESET],
  workflows: [".github/workflows/01-pr-ci.yml", ".github/workflows/90-governance-drift.yml"],
  requiredChecks: [
    { context: "ci-gate", integrationId: GITHUB_ACTIONS_APP_ID },
    { context: "review-policy", integrationId: GITHUB_ACTIONS_APP_ID },
  ],
  driftWorkflow: ".github/workflows/90-governance-drift.yml",
};

/** A repository where every checkpoint GitHub can show is done. */
const ENFORCED: Observed = {
  repository: { id: 7, fullName: "octo/demo", defaultBranch: "develop", admin: true },
  branches: { develop: "d".repeat(40), main: "m".repeat(40) },
  workflows: [...DESIRED.workflows],
  checks: [
    { context: "ci-gate", appId: GITHUB_ACTIONS_APP_ID, url: "https://ci" },
    { context: "review-policy", appId: GITHUB_ACTIONS_APP_ID, url: "https://rp" },
  ],
  rulesets: [{ id: 41, name: "Protect develop", enforcement: "active" }],
  rules: { develop: [{ type: "deletion" }, { type: "non_fast_forward" }] },
  driftRun: { conclusion: "success", url: "https://drift" },
};

const PROVED = { passed: true, rulesetIds: [41], at: "2026-10-25T00:00:00Z" };

const assess = (
  observed: Partial<Observed>,
  local: Parameters<typeof assessCheckpoints>[2] = { problems: [], proof: PROVED },
) => assessCheckpoints(DESIRED, { ...ENFORCED, ...observed }, local);
const next = (checkpoints: ReturnType<typeof assess>) =>
  checkpoints.find((checkpoint) => checkpoint.status === "next");

describe("GOV-001 the governance checkpoints, in order", () => {
  it("is done when GitHub shows every checkpoint and the proof is recorded", () => {
    const checkpoints = assess({});
    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      "handoff",
      "branches",
      "workflows",
      "checks",
      "rulesets",
      "readback",
      "drift",
      "proof",
    ]);
    expect(checkpoints.every((checkpoint) => checkpoint.status === "done")).toBe(true);
  });

  it("starts with the local handoff", () => {
    const checkpoints = assess({}, { problems: ["liftoff.yaml: invalid"] });
    expect(next(checkpoints)).toMatchObject({
      id: "handoff",
      todo: "fix what liftoff validate reports",
    });
    expect(checkpoints.slice(1).filter((c) => c.status === "next")).toEqual([]);
    expect(
      next(assessCheckpoints({ ...DESIRED, rulesets: [] }, ENFORCED, { problems: [] })),
    ).toMatchObject({
      id: "handoff",
      todo: "use a GitFlow governance profile",
    });
  });

  it("offers to create develop, then to make it the default branch", () => {
    expect(next(assess({ branches: { main: "m".repeat(40) } }))).toMatchObject({
      id: "branches",
      action: { kind: "create-develop", from: "m".repeat(40) },
    });
    expect(
      next(assess({ repository: { ...ENFORCED.repository, defaultBranch: "main" } })),
    ).toMatchObject({
      id: "branches",
      action: { kind: "set-default-branch", branch: "develop" },
    });
    expect(next(assess({ branches: {} }))).toMatchObject({
      id: "branches",
      todo: "push the project's first commit to main",
    });
  });

  it("waits for the workflows on develop and a real run of every required check", () => {
    expect(next(assess({ workflows: [".github/workflows/01-pr-ci.yml"] }))).toMatchObject({
      id: "workflows",
      detail: "develop is missing .github/workflows/90-governance-drift.yml",
      todo: "push the generated files to develop",
    });
    const fromAnotherApp = assess({
      checks: [
        { context: "ci-gate", appId: GITHUB_ACTIONS_APP_ID, url: "u" },
        { context: "review-policy", appId: 999, url: "u" },
      ],
    });
    expect(next(fromAnotherApp)).toMatchObject({
      id: "checks",
      detail: "no successful run yet of review-policy",
    });
    expect(next(fromAnotherApp)).not.toHaveProperty("action");
  });

  it("applies the rulesets only after every check has run, and only as an admin", () => {
    const unapplied = assess({ rulesets: [], rules: {} });
    expect(next(unapplied)).toMatchObject({
      id: "rulesets",
      action: { kind: "apply-rulesets", names: ["Protect develop"] },
    });
    // Later checkpoints are not offered before the earlier ones.
    expect(unapplied.find((checkpoint) => checkpoint.id === "readback")?.status).toBe("later");
    const notAdmin = assess({
      rulesets: [{ id: 41, name: "Protect develop", enforcement: "evaluate" }],
      repository: { ...ENFORCED.repository, admin: false },
    });
    expect(next(notAdmin)).toMatchObject({
      id: "rulesets",
      todo: "ask a repository admin to apply them",
    });
    expect(next(notAdmin)).not.toHaveProperty("action");
    const beforeChecks = assess({ rulesets: [], rules: {}, checks: [] });
    expect(next(beforeChecks)?.id).toBe("checks");
  });

  it("reads back what GitHub enforces", () => {
    expect(next(assess({ rules: { develop: [{ type: "deletion" }] } }))).toMatchObject({
      id: "readback",
      detail: "develop non_fast_forward: not active on this branch",
    });
  });

  it("offers to run the drift job until it has passed", () => {
    const { driftRun: _ran, ...neverRan } = ENFORCED;
    for (const observed of [
      neverRan,
      { ...ENFORCED, driftRun: { conclusion: "failure", url: "u" } },
    ]) {
      const checkpoints = assessCheckpoints(DESIRED, observed, { problems: [], proof: PROVED });
      expect(next(checkpoints)).toMatchObject({
        id: "drift",
        action: { kind: "run-drift", workflow: DESIRED.driftWorkflow },
      });
    }
  });

  it("needs a proof of the rulesets that are live now", () => {
    expect(next(assess({}, { problems: [] }))).toMatchObject({
      id: "proof",
      detail: "not proved yet",
    });
    expect(
      next(assess({}, { problems: [], proof: { ...PROVED, rulesetIds: [40] } })),
    ).toMatchObject({
      id: "proof",
      detail: "the rulesets changed since the proof",
    });
    expect(next(assess({}, { problems: [], proof: { ...PROVED, passed: false } }))?.id).toBe(
      "proof",
    );
  });
});
