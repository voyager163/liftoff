import { describe, expect, it } from "vitest";
import { evaluateApprovals, type Review } from "../../src/domain/risk-policy/approvals.ts";
import { type ChangedFile, classify } from "../../src/domain/risk-policy/classify.ts";
import {
  DEFAULT_LINE_COUNT_IGNORE,
  PolicyError,
  parsePolicy,
} from "../../src/domain/risk-policy/policy.ts";
import { PROFILES } from "../../src/domain/risk-policy/profiles.ts";

const basePolicy = `
version: 1
profile: risk-tiered-gitflow
trusted_authors: [alice]
rules:
  - paths: ["docs/**", "*.md"]
    tier: low
    reason: documentation
  - paths: ["src/auth/**"]
    tier: high
    always_human: true
    reason: authentication
`;

const file = (path: string, lines = 10, previousPath?: string): ChangedFile => ({
  path,
  additions: lines,
  deletions: 0,
  ...(previousPath === undefined ? {} : { previousPath }),
});

describe("REVIEW-001 policy parsing", () => {
  it("applies defaults to a minimal policy", () => {
    const policy = parsePolicy("version: 1\nprofile: none\n");
    expect(policy.default_tier).toBe("medium");
    expect(policy.untrusted_author_tier).toBe("medium");
    expect(policy.large_change).toEqual({
      lines: 1000,
      tier: "high",
      ignore: [...DEFAULT_LINE_COUNT_IGNORE],
    });
    expect(policy.depth).toEqual({ low: "quick", medium: "standard", high: "deep" });
    expect(policy.rules).toEqual([]);
  });

  it("rejects unknown keys and names them", () => {
    expect(() => parsePolicy("version: 1\nprofile: none\nsurprise: true\n")).toThrow(/surprise/);
  });

  it("rejects an unknown profile or version", () => {
    expect(() => parsePolicy("version: 2\nprofile: none\n")).toThrow(PolicyError);
    expect(() => parsePolicy("version: 1\nprofile: lax\n")).toThrow(/profile/);
  });

  it("rejects malformed YAML", () => {
    expect(() => parsePolicy("version: [1\n")).toThrow(/not valid YAML/);
  });

  it("rejects absolute and backslash globs", () => {
    const rule = (glob: string) =>
      `version: 1\nprofile: none\nrules:\n  - paths: ["${glob}"]\n    tier: low\n    reason: x\n`;
    expect(() => parsePolicy(rule("/etc/**"))).toThrow(/repository-relative/);
    expect(() => parsePolicy(rule("src\\\\a"))).toThrow(/repository-relative/);
  });

  it("rejects an empty document", () => {
    expect(() => parsePolicy("")).toThrow(/invalid/);
  });
});

describe("REVIEW-002 the change sets the tier", () => {
  const policy = parsePolicy(basePolicy);

  it("classifies a docs-only change as low", () => {
    const result = classify({ policy, files: [file("docs/guide.md")], author: "alice" });
    expect(result.tier).toBe("low");
    expect(result.depth).toBe("quick");
    expect(result.requiredApprovals).toBe(0);
  });

  it("takes the highest tier across files", () => {
    const result = classify({
      policy,
      files: [file("docs/guide.md"), file("src/auth/token.ts")],
      author: "alice",
    });
    expect(result.tier).toBe("high");
    expect(result.alwaysHuman).toBe(true);
    expect(result.alwaysHumanPaths).toEqual(["src/auth/token.ts"]);
    expect(result.requiredApprovals).toBe(2);
    expect(result.reasons[0]).toEqual({
      tier: "high",
      reason: "authentication",
      paths: ["src/auth/token.ts"],
    });
  });

  it("uses the default tier for unmatched files", () => {
    const result = classify({ policy, files: [file("src/app.ts")], author: "alice" });
    expect(result.tier).toBe("medium");
    expect(result.requiredApprovals).toBe(1);
    expect(result.reasons.map((r) => r.reason)).toContain(
      "matches no rule, so it takes the default tier",
    );
  });

  it("classifies a rename by its old path too", () => {
    const result = classify({
      policy,
      files: [file("src/public/token.ts", 1, "src/auth/token.ts")],
      author: "alice",
    });
    expect(result.tier).toBe("high");
  });

  it("treats an empty change as low", () => {
    const result = classify({ policy, files: [], author: "alice" });
    expect(result.tier).toBe("low");
    expect(result.changedLines).toBe(0);
  });
});

describe("REVIEW-003 built-in rules", () => {
  const permissive = parsePolicy(`
version: 1
profile: team-gitflow
trusted_authors: [alice]
rules:
  - paths: [".github/**", "**"]
    tier: low
    reason: everything is fine
`);

  it.each([
    ".github/workflows/ci.yml",
    ".github/review-policy.yml",
    ".github/liftoff/review-policy.mjs",
    ".github/rulesets/main.json",
    "REVIEW.md",
    "src/domain/REVIEW.md",
    "AGENTS.md",
    ".claude/skills/liftoff-code-review/SKILL.md",
    ".agents/skills/liftoff-code-review/SKILL.md",
    ".codex/agents/liftoff-verifier.toml",
    ".github/agents/liftoff-verifier.agent.md",
    ".github/CODEOWNERS",
  ])("keeps %s high and always-human", (path) => {
    const result = classify({ policy: permissive, files: [file(path)], author: "alice" });
    expect(result.tier).toBe("high");
    expect(result.alwaysHuman).toBe(true);
    expect(result.requiredApprovals).toBe(2);
  });
});

describe("REVIEW-004 escalation", () => {
  const policy = parsePolicy(basePolicy);

  it("raises a large change to high", () => {
    const result = classify({ policy, files: [file("docs/big.md", 1200)], author: "alice" });
    expect(result.tier).toBe("high");
    expect(result.changedLines).toBe(1200);
    expect(result.reasons[0]?.reason).toBe("changes 1200 lines, more than 1000");
  });

  it("does not count lockfiles toward the size limit", () => {
    const result = classify({
      policy,
      files: [file("package-lock.json", 5000), file("backend/uv.lock", 900), file("docs/a.md", 5)],
      author: "alice",
    });
    expect(result.changedLines).toBe(5);
    expect(result.tier).toBe("medium");
  });

  it("uses a custom ignore list when given", () => {
    const custom = parsePolicy(`
version: 1
profile: none
trusted_authors: [alice]
large_change: { lines: 10, tier: high, ignore: ["gen/**"] }
`);
    const result = classify({
      policy: custom,
      files: [file("gen/a.ts", 50), file("package-lock.json", 50)],
      author: "alice",
    });
    expect(result.changedLines).toBe(50);
    expect(result.tier).toBe("high");
  });

  it("matches trusted authors in any letter case, as GitHub does", () => {
    const result = classify({ policy, files: [file("docs/guide.md")], author: "Alice" });
    expect(result.trustedAuthor).toBe(true);
    expect(result.tier).toBe("low");
  });

  it("never gives an untrusted author the low path", () => {
    const result = classify({ policy, files: [file("docs/guide.md")], author: "mallory" });
    expect(result.tier).toBe("medium");
    expect(result.trustedAuthor).toBe(false);
    expect(result.requiredApprovals).toBe(1);
  });
});

describe("REVIEW-005 profiles", () => {
  it("maps tiers to approvals for every profile", () => {
    expect(PROFILES["single-maintainer-gitflow"].approvals).toEqual({ low: 0, medium: 0, high: 0 });
    expect(PROFILES["team-gitflow"].approvals).toEqual({ low: 1, medium: 1, high: 2 });
    expect(PROFILES["risk-tiered-gitflow"].approvals).toEqual({ low: 0, medium: 1, high: 2 });
    expect(PROFILES.none.approvals).toEqual({ low: 0, medium: 0, high: 0 });
  });

  it("applies the always-human minimum even at low tier", () => {
    const policy = parsePolicy(`
version: 1
profile: risk-tiered-gitflow
trusted_authors: [alice]
default_tier: low
rules:
  - paths: ["billing/**"]
    tier: low
    always_human: true
    reason: billing
`);
    const result = classify({ policy, files: [file("billing/a.ts")], author: "alice" });
    expect(result.tier).toBe("low");
    expect(result.requiredApprovals).toBe(1);
  });

  it("never requires approvals under single-maintainer", () => {
    const policy = parsePolicy("version: 1\nprofile: single-maintainer-gitflow\n");
    const result = classify({
      policy,
      files: [file(".github/workflows/ci.yml")],
      author: "maintainer",
    });
    expect(result.tier).toBe("high");
    expect(result.depth).toBe("deep");
    expect(result.requiredApprovals).toBe(0);
  });
});

describe("REVIEW-006 approvals", () => {
  const review = (overrides: Partial<Review>): Review => ({
    reviewer: "bob",
    isBot: false,
    hasWriteAccess: true,
    state: "APPROVED",
    commitId: "head",
    submittedAt: 1,
    ...overrides,
  });
  const evaluate = (reviews: Review[], required = 1) =>
    evaluateApprovals({ required, author: "alice", headSha: "head", reviews });

  it("counts a current human approval", () => {
    const result = evaluate([review({})]);
    expect(result).toMatchObject({ approvers: ["bob"], satisfied: true });
  });

  it("ignores bots, the author, readers and stale approvals", () => {
    const result = evaluate(
      [
        review({ reviewer: "copilot[bot]", isBot: true }),
        review({ reviewer: "Alice" }),
        review({ reviewer: "carol", hasWriteAccess: false }),
        review({ reviewer: "dave", commitId: "old" }),
      ],
      1,
    );
    expect(result.satisfied).toBe(false);
    expect(result.ignored.map((i) => i.why)).toEqual([
      "bot approvals never count as human approvals",
      "the author cannot approve",
      "reviewer has no write access",
      "approval is for an older commit",
    ]);
  });

  it("lets a later change request cancel an approval", () => {
    const result = evaluate([
      review({ submittedAt: 1 }),
      review({ state: "CHANGES_REQUESTED", submittedAt: 2 }),
    ]);
    expect(result.approvers).toEqual([]);
  });

  it("keeps an approval after a later comment", () => {
    const result = evaluate([
      review({ submittedAt: 1 }),
      review({ state: "COMMENTED", submittedAt: 2 }),
    ]);
    expect(result.approvers).toEqual(["bob"]);
  });

  it("is satisfied when nothing is required", () => {
    expect(evaluate([], 0).satisfied).toBe(true);
  });
});
