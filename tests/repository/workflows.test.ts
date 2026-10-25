import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STACKS } from "../../src/plugins/registry.ts";

const directory = path.resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  "runs-on"?: string;
  needs?: string[];
  permissions?: Record<string, string> | string;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
  strategy?: { matrix?: { include?: { os?: string }[]; stack?: string[] } };
}
interface Workflow {
  on: Record<string, unknown> | string | string[];
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

const workflows = files.map((name) => ({
  name,
  text: readFileSync(path.join(directory, name), "utf8"),
  data: parse(readFileSync(path.join(directory, name), "utf8")) as Workflow,
}));

const triggers = (workflow: Workflow): string[] =>
  typeof workflow.on === "string"
    ? [workflow.on]
    : Array.isArray(workflow.on)
      ? workflow.on
      : Object.keys(workflow.on);

describe("REPO-003 actions are pinned to full commit SHAs", () => {
  it("finds workflows to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(workflows.map((w) => [w.name, w.text]))("%s pins every action", (_name, text) => {
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
    for (const [, reference, comment] of uses) {
      if (reference?.startsWith("./")) continue;
      expect(reference, `${reference} must be pinned`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(comment, `${reference} needs a version comment`).toMatch(/#\s*v\d/);
    }
  });
});

describe("REPO-004 workflows default to read-only permissions", () => {
  it.each(workflows.map((w) => [w.name, w.data]))("%s is read-only by default", (_name, data) => {
    const top = (data as Workflow).permissions;
    expect(top, "top-level permissions are required").toBeDefined();
    if (typeof top === "string") {
      expect(["read-all", "{}"]).toContain(top);
    } else {
      for (const [scope, level] of Object.entries(top ?? {})) {
        expect(level, `top-level ${scope}`).not.toBe("write");
      }
    }
    for (const job of Object.values((data as Workflow).jobs)) {
      expect(job.permissions).not.toBe("write-all");
    }
  });
});

describe("REPO-005 privileged triggers never run pull request code", () => {
  const privileged = workflows.filter((w) =>
    triggers(w.data).some((t) => t === "pull_request_target" || t === "workflow_run"),
  );

  it("covers the privileged workflows", () => {
    expect(privileged.map((w) => w.name)).toEqual(
      expect.arrayContaining(["ai-review.yml", "cla.yml", "review-policy.yml"]),
    );
  });

  it.each(privileged.map((w) => [w.name, w.data]))(
    "%s does not run or interpolate pull request input",
    (_name, data) => {
      for (const job of Object.values((data as Workflow).jobs)) {
        // The pull request may only be checked out into a directory of its
        // own, as files to read; the workspace stays the base branch's.
        const readOnly = new Set<string>();
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@")) {
            const ref = String(step.with?.ref ?? "");
            expect(
              step.with?.repository,
              "checkout must not use the fork repository",
            ).toBeUndefined();
            if (/head|merge|pull_request/.test(ref)) {
              const into = String(step.with?.path ?? ".").replace(/\/+$/, "");
              expect(into, "the pull request must not replace the workspace").not.toMatch(/^\.?$/);
              expect(step.with?.["persist-credentials"]).toBe(false);
              readOnly.add(into);
            }
          }
        }
        for (const step of job.steps ?? []) {
          for (const into of readOnly) {
            const runsFrom = (dir: string | undefined) =>
              dir !== undefined && (dir === into || dir.startsWith(`${into}/`));
            expect(runsFrom(job.defaults?.run?.["working-directory"])).toBe(false);
            expect(runsFrom(step["working-directory"])).toBe(false);
            expect(step.uses?.startsWith(`./${into}`) ?? false).toBe(false);
            expect(step.run ?? "", `nothing may run from ${into}/`).not.toContain(`${into}/`);
          }
          if (step.run) {
            expect(step.run).not.toMatch(
              /\$\{\{\s*github\.(event\.pull_request\.(title|body|head\.ref)|head_ref)/,
            );
          }
        }
      }
    },
  );
});

describe("AIREVIEW-002 review jobs hand their files on reliably", () => {
  // download-artifact puts a single matching artifact straight into the
  // path, and several into one folder each, unless merge-multiple is set.
  it.each(workflows.map((w) => [w.name, w.data]))(
    "%s downloads artifacts by pattern into one known layout",
    (_name, data) => {
      for (const job of Object.values((data as Workflow).jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/download-artifact@") && step.with?.pattern) {
            expect(step.with["merge-multiple"], String(step.with.pattern)).toBe(true);
          }
        }
      }
    },
  );
});

describe("REVIEW-012 reviews re-check the policy, forks included", () => {
  const find = (name: string) => workflows.find((w) => w.name === name)?.data;

  it("records reviews with no permissions and no code", () => {
    const submitted = find("review-submitted.yml");
    expect(triggers(submitted as Workflow)).toEqual(["pull_request_review"]);
    expect(submitted?.permissions).toEqual({});
    for (const job of Object.values(submitted?.jobs ?? {})) {
      expect(job.permissions).toBeUndefined();
      expect(job.steps?.some((step) => step.uses !== undefined)).toBe(false);
    }
  });

  it("refreshes from the default branch when a review was recorded", () => {
    const refresh = find("review-policy-refresh.yml");
    expect(refresh?.on).toEqual({
      workflow_run: { workflows: ["Review submitted"], types: ["completed"] },
    });
    const job = Object.values(refresh?.jobs ?? {})[0];
    expect(job?.permissions).toEqual({ actions: "write", "pull-requests": "read" });
    expect(job?.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(job?.steps?.map((step) => step.run ?? "").join("\n")).toContain(
      "gh workflow run review-policy.yml",
    );
  });
});

describe("PROJ-006 and PROJ-011 every API stack is checked in CI", () => {
  const ci = workflows.find((w) => w.name === "ci.yml")?.data;

  it.each(["generated", "services"])("the %s job covers every stack and gates merging", (job) => {
    expect([...(ci?.jobs[job]?.strategy?.matrix?.stack ?? [])].sort()).toEqual(
      Object.keys(STACKS).sort(),
    );
    expect(ci?.jobs["ci-gate"]?.needs).toContain(job);
  });
});

describe("REPO-006 tests run on the supported developer platforms", () => {
  it("runs the test job on macOS arm64 and Windows x64 only", () => {
    const ci = workflows.find((w) => w.name === "ci.yml")?.data;
    const matrix = ci?.jobs.test?.strategy?.matrix?.include?.map((entry) => entry.os);
    expect(matrix).toEqual(["macos-15", "windows-latest"]);
    expect(ci?.jobs["ci-gate"]).toBeDefined();
  });
});
