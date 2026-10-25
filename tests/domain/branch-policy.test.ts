import { describe, expect, it } from "vitest";
import { checkBranch } from "../../src/domain/governance/branch-policy.ts";

const check = (head: string, base: string, body = "", automation = ["dependabot", "copilot"]) =>
  checkBranch({ head, base, body, automation });

describe("FLOW-001 which branches may merge where", () => {
  it.each([
    ["feature/login", "work"],
    ["fix/null-check", "work"],
    ["chore/deps", "work"],
    ["docs/readme", "work"],
    ["ci/cache", "work"],
    ["feature/ABC-12/sub.task_1", "work"],
    ["sync/main-into-develop-1.2.0", "sync"],
    ["dependabot/npm_and_yarn/backend/fastify-5.9.0", "automation"],
    ["copilot/fix-typo", "automation"],
  ])("lets %s into develop", (head, kind) => {
    expect(check(head, "develop")).toMatchObject({ allowed: true, kind });
  });

  it.each([
    "feat/login",
    "feature/",
    "feature/-x",
    "release/1.2.0",
    "hotfix/1.2.1",
    "main",
    "codex/task",
  ])("keeps %s out of develop", (head) => {
    const decision = check(head, "develop");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("feature/…, fix/…, chore/…, docs/…, ci/…");
  });

  it("treats tool prefixes as plain text", () => {
    expect(check("x/y", "develop", "", [".*"]).allowed).toBe(false);
    expect(check(".*/y", "develop", "", [".*"]).allowed).toBe(true);
  });

  it("lets only releases and hotfixes with an incident into main", () => {
    expect(check("release/1.2.0", "main")).toMatchObject({
      allowed: true,
      kind: "release",
      version: "1.2.0",
    });
    expect(
      check("hotfix/1.2.1", "main", "Fixes the login outage.\n\nIncident: INC-42"),
    ).toMatchObject({ allowed: true, kind: "hotfix", version: "1.2.1" });
    for (const body of [
      "Incident:\n\n## Testing\nTests pass",
      "Incident:   \nINC-42",
      "Incident:",
    ]) {
      expect(check("hotfix/1.2.1", "main", body).allowed).toBe(false);
    }
    expect(check("hotfix/1.2.1", "main", "Incident:\tINC-42").allowed).toBe(true);
    expect(check("hotfix/1.2.1", "main", "Fixes the login outage.")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('"Incident: <reference>"'),
    });
    for (const head of ["release/1.2", "release/v1.2.0", "feature/x", "develop", "sync/x"]) {
      expect(check(head, "main")).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("only release/X.Y.Z and hotfix/X.Y.Z"),
      });
    }
  });

  it("does not police other base branches", () => {
    expect(check("anything", "feature/big")).toMatchObject({ allowed: true, kind: "other" });
  });
});
