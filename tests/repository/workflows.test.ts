import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const directory = path.resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on"?: string;
  permissions?: Record<string, string> | string;
  steps?: Step[];
  strategy?: { matrix?: { include?: { os?: string }[] } };
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
      expect.arrayContaining(["cla.yml", "review-policy.yml"]),
    );
  });

  it.each(privileged.map((w) => [w.name, w.data]))(
    "%s does not check out or interpolate pull request input",
    (_name, data) => {
      for (const job of Object.values((data as Workflow).jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@")) {
            const ref = String(step.with?.ref ?? "");
            expect(ref, "checkout must not use the pull request ref").not.toMatch(
              /head|merge|pull_request/,
            );
            expect(
              step.with?.repository,
              "checkout must not use the fork repository",
            ).toBeUndefined();
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

describe("REPO-006 tests run on the supported developer platforms", () => {
  it("runs the test job on macOS arm64 and Windows x64 only", () => {
    const ci = workflows.find((w) => w.name === "ci.yml")?.data;
    const matrix = ci?.jobs.test?.strategy?.matrix?.include?.map((entry) => entry.os);
    expect(matrix).toEqual(["macos-15", "windows-latest"]);
    expect(ci?.jobs["ci-gate"]).toBeDefined();
  });
});
