import { describe, expect, it } from "vitest";
import type { GitPort, WorkspacePort } from "../../src/application/ports.ts";
import {
  ClassifyChangeError,
  classifyChange,
} from "../../src/application/review/classify-change.ts";
import type { ChangedFile } from "../../src/domain/risk-policy/classify.ts";

const POLICY = `
version: 1
profile: risk-tiered-gitflow
trusted_authors: [alice]
rules:
  - paths: ["docs/**"]
    tier: low
    reason: docs
`;

interface FakeRepo {
  refs?: Record<string, string>;
  basePolicy?: string;
  workingPolicy?: string;
  files?: ChangedFile[];
}

function fakes(repo: FakeRepo): { git: GitPort; workspace: WorkspacePort; calls: string[] } {
  const calls: string[] = [];
  const refs = repo.refs ?? { "origin/develop": "base-sha", HEAD: "head-sha" };
  return {
    calls,
    git: {
      resolveCommit: async (ref) => refs[ref],
      mergeBase: async (a, b) => {
        calls.push(`merge-base ${a} ${b}`);
        return "merge-sha";
      },
      changedFiles: async (from, includeWorkingTree) => {
        calls.push(`diff ${from} ${includeWorkingTree}`);
        return repo.files ?? [{ path: "docs/a.md", additions: 1, deletions: 0 }];
      },
      showFile: async (ref, path) => {
        calls.push(`show ${ref}:${path}`);
        return repo.basePolicy;
      },
    },
    workspace: { readText: async () => repo.workingPolicy },
  };
}

describe("REVIEW-008 policy comes from the base branch", () => {
  it("prefers origin, reads the policy at the base commit and diffs from the merge base", async () => {
    const ports = fakes({ basePolicy: POLICY, workingPolicy: "version: 1\nprofile: none\n" });
    const result = await classifyChange(ports, {
      base: "develop",
      author: "alice",
      committedOnly: false,
    });
    expect(result.base).toEqual({
      ref: "origin/develop",
      commit: "base-sha",
      mergeBase: "merge-sha",
    });
    expect(result.policySource).toBe("base");
    expect(result.classification.profile).toBe("risk-tiered-gitflow");
    expect(result.classification.tier).toBe("low");
    expect(ports.calls).toEqual([
      "merge-base base-sha head-sha",
      "show base-sha:.github/review-policy.yml",
      "diff merge-sha true",
    ]);
  });

  it("falls back to the working tree and marks the result unverified", async () => {
    const ports = fakes({ workingPolicy: POLICY });
    const result = await classifyChange(ports, { base: "develop", committedOnly: true });
    expect(result.policySource).toBe("working-tree");
    expect(ports.calls).toContain("diff merge-sha false");
  });

  it("uses a local base when there is no remote branch", async () => {
    const ports = fakes({ refs: { main: "main-sha", HEAD: "head-sha" }, basePolicy: POLICY });
    const result = await classifyChange(ports, { base: "main", committedOnly: false });
    expect(result.base.ref).toBe("main");
  });

  it("fails clearly when the base, HEAD or policy is missing", async () => {
    await expect(
      classifyChange(fakes({ refs: { HEAD: "h" } }), { base: "develop", committedOnly: false }),
    ).rejects.toThrow(/base branch "develop" was not found/);
    await expect(
      classifyChange(fakes({ refs: { develop: "d" } }), { base: "develop", committedOnly: false }),
    ).rejects.toThrow(/no commits yet/);
    await expect(
      classifyChange(fakes({}), { base: "develop", committedOnly: false }),
    ).rejects.toThrow(ClassifyChangeError);
  });
});

describe("REVIEW-004 author handling", () => {
  it("classifies the real author when given", async () => {
    const ports = fakes({ basePolicy: POLICY });
    const result = await classifyChange(ports, {
      base: "develop",
      author: "mallory",
      committedOnly: false,
    });
    expect(result.author).toEqual({ login: "mallory", assumedTrusted: false });
    expect(result.classification.tier).toBe("medium");
  });

  it("assumes a trusted author when none is given", async () => {
    const result = await classifyChange(fakes({ basePolicy: POLICY }), {
      base: "develop",
      committedOnly: false,
    });
    expect(result.author).toEqual({ login: "alice", assumedTrusted: true });
    expect(result.classification.tier).toBe("low");
  });

  it("assumes trust even when the policy lists no trusted authors", async () => {
    const result = await classifyChange(
      fakes({ basePolicy: "version: 1\nprofile: none\ndefault_tier: low\n" }),
      {
        base: "develop",
        committedOnly: false,
      },
    );
    expect(result.author.login).toBe("local-author");
    expect(result.classification.trustedAuthor).toBe(true);
    expect(result.classification.tier).toBe("low");
  });
});
