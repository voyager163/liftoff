import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareRuleset,
  type DesiredRuleset,
  normalize,
  targetedBranches,
} from "../../src/domain/governance/ruleset-drift.ts";

const desired: DesiredRuleset = {
  name: "Protect develop",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      include: ["refs/heads/develop", "refs/heads/release/*", "~DEFAULT_BRANCH"],
      exclude: [],
    },
  },
  bypass_actors: [],
  rules: [
    { type: "deletion" },
    {
      type: "pull_request",
      parameters: {
        allowed_merge_methods: ["squash", "merge"],
        required_approving_review_count: 0,
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: "ci-gate", integration_id: 15368 },
          { context: "review-policy", integration_id: 15368 },
        ],
      },
    },
  ],
};

describe("REPO-002 ruleset drift", () => {
  it("only reads back branches named exactly", () => {
    expect(targetedBranches(desired)).toEqual(["develop"]);
  });

  it("normalizes key and list order", () => {
    expect(normalize({ b: [3, 1, 2], a: [{ y: 1, x: 2 }, { a: 0 }] })).toEqual({
      a: [{ a: 0 }, { x: 2, y: 1 }],
      b: [1, 2, 3],
    });
  });

  it("finds no drift when every rule is active as committed, in any order", () => {
    const effective = {
      develop: [
        { type: "deletion", parameters: null, ruleset_id: 1 },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { integration_id: 15368, context: "review-policy" },
              { context: "ci-gate", integration_id: 15368 },
            ],
            strict_required_status_checks_policy: true,
          },
        },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            allowed_merge_methods: ["merge", "squash"],
          },
        },
        // A stricter rule from elsewhere is not drift.
        { type: "required_signatures", parameters: null, ruleset_source: "org" },
      ],
    };
    expect(compareRuleset(desired, effective)).toEqual([]);
  });

  it("reports missing and changed rules key by key", () => {
    const effective = {
      develop: [
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["squash", "merge"],
            required_approving_review_count: 1,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: "ci-gate", integration_id: 15368 }],
          },
        },
      ],
    };
    const differences = compareRuleset(desired, effective);
    expect(differences.map((d) => [d.rule, d.kind])).toEqual([
      ["deletion", "missing"],
      ["pull_request", "changed"],
      ["required_status_checks", "changed"],
    ]);
    expect(differences[1]?.detail).toBe("required_approving_review_count: expected 0, found 1");
    expect(differences[2]?.detail).toContain(
      "strict_required_status_checks_policy: expected true, found false",
    );
  });

  it("treats an unprotected branch as entirely missing", () => {
    expect(compareRuleset(desired, {}).every((d) => d.kind === "missing")).toBe(true);
  });

  it("reports a ruleset that is not active", () => {
    const differences = compareRuleset({ ...desired, enforcement: "evaluate" }, {});
    expect(differences).toEqual([
      {
        branch: "develop",
        rule: "(ruleset)",
        kind: "inactive-ruleset",
        detail: 'ruleset "Protect develop" is evaluate, so nothing is enforced',
      },
    ]);
  });

  it("parses Liftoff's own committed rulesets", () => {
    for (const file of ["develop.json", "main.json"]) {
      const ruleset = JSON.parse(
        readFileSync(path.resolve(import.meta.dirname, "../../.github/rulesets", file), "utf8"),
      ) as DesiredRuleset;
      expect(targetedBranches(ruleset)).toEqual([file.replace(".json", "")]);
      const types = ruleset.rules.map((r) => r.type);
      expect(types).toEqual(
        expect.arrayContaining([
          "deletion",
          "non_fast_forward",
          "pull_request",
          "required_status_checks",
          "code_scanning",
          "copilot_code_review",
        ]),
      );
    }
  });
});
