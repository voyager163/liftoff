import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TRIVY } from "../../src/plugins/builtin/release.ts";
import { PATTERNS, STACKS, WORKFLOWS } from "../../src/plugins/registry.ts";

const directory = path.resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

interface Step {
  name?: string;
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

describe("REVIEW-012 the refresh dispatches exactly the reviewed pull requests", () => {
  const script =
    Object.values(workflows.find((w) => w.name === "review-policy-refresh.yml")?.data.jobs ?? {})[0]
      ?.steps?.[0]?.run ?? "";

  // Runs the workflow's own script with gh replaced by a function: the
  // lookup runs `lookup`, and every other call is recorded.
  const refresh = (lookup: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "liftoff-refresh-"));
    try {
      const file = path.join(dir, "refresh.sh");
      const calls = path.join(dir, "calls.txt");
      writeFileSync(
        file,
        `gh() {\n  if [ "$1" = api ]; then ${lookup}; else echo "$*" >> "$CALLS"; fi\n}\n${script}`,
      );
      const result = spawnSync("bash", [file], {
        encoding: "utf8",
        env: { ...process.env, CALLS: calls, REPO: "acme/app", HEAD_SHA: "abc123" },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        dispatched: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("fails when the lookup fails, instead of reporting nothing to do", () => {
    const result = refresh('echo "HTTP 502" >&2; return 1');
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("nothing to re-check");
    expect(result.dispatched).toEqual([]);
  });

  it("succeeds without dispatching when no open pull request has the commit", () => {
    const result = refresh("return 0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to re-check");
    expect(result.dispatched).toEqual([]);
  });

  it("dispatches the check from each matching pull request's base branch", () => {
    const result = refresh("printf '9\\tdevelop\\n12\\tmain\\n'");
    expect(result.status).toBe(0);
    expect(result.dispatched).toEqual([
      "workflow run review-policy.yml --repo acme/app --ref develop -f pull_request=9",
      "workflow run review-policy.yml --repo acme/app --ref main -f pull_request=12",
    ]);
  });
});

describe("PROJ-006 and PROJ-011 every API stack is checked in CI", () => {
  const ci = workflows.find((w) => w.name === "ci.yml")?.data;

  const apiStacks = Object.entries(STACKS)
    .filter(([, stack]) => stack.workload === "api")
    .map(([id]) => id)
    .sort();

  it.each(["generated", "services"])(
    "the %s job covers every API stack and gates merging",
    (job) => {
      expect([...(ci?.jobs[job]?.strategy?.matrix?.stack ?? [])].sort()).toEqual(apiStacks);
      expect(ci?.jobs["ci-gate"]?.needs).toContain(job);
    },
  );

  it("PROJ-019 checks every GenAI pattern, and ci-gate needs it", () => {
    const job = ci?.jobs.genai as Job & { strategy?: { matrix?: { pattern?: string[] } } };
    expect([...(job?.strategy?.matrix?.pattern ?? [])].sort()).toEqual(
      Object.keys(PATTERNS).sort(),
    );
    const runs = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("uv run pytest");
    expect(runs).toContain("docker compose up --build --wait");
    expect(ci?.jobs["ci-gate"]?.needs).toContain("genai");
  });

  it("PROJ-021 runs every framework's initializer on each platform, and ci-gate needs it", () => {
    const job = ci?.jobs["spec-workflows"] as Job & {
      strategy?: { matrix?: { workflow?: string[]; platform?: { os: string }[] } };
    };
    const withInitializer = Object.entries(WORKFLOWS)
      .filter(([, workflow]) => workflow.initializer)
      .map(([id]) => id);
    expect([...(job?.strategy?.matrix?.workflow ?? [])].sort()).toEqual(withInitializer.sort());
    expect((job?.strategy?.matrix?.platform ?? []).map((platform) => platform.os)).toEqual([
      "ubuntu-latest",
      "macos-15",
      "windows-latest",
    ]);
    const runs = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain('--workflow "$WORKFLOW"');
    expect(runs).toContain("validate");
    expect(ci?.jobs["ci-gate"]?.needs).toContain("spec-workflows");
  });

  it("PROJ-023 runs the full matrix nightly", () => {
    const nightly = workflows.find((workflow) => workflow.name === "nightly-matrix.yml");
    expect(nightly?.data.on).toHaveProperty("schedule");
    const lint = (nightly?.data.jobs["generated-workflows"]?.steps ?? []).map(
      (step) => step.run ?? step.uses ?? "",
    );
    expect(lint.join("\n")).toContain("scripts/matrix/write-distinct.ts");
    expect(lint.join("\n")).toContain("raven-actions/actionlint@");
    expect(lint.join("\n")).toContain("shellcheck");
    const projects = nightly?.data.jobs.projects as Job & {
      strategy?: { matrix?: { platform?: { os: string }[]; project?: { stack: string }[] } };
    };
    expect((projects?.strategy?.matrix?.platform ?? []).map((p) => p.os)).toEqual([
      "macos-15",
      "windows-latest",
      "ubuntu-latest",
    ]);
    expect((projects?.strategy?.matrix?.project ?? []).map((p) => p.stack).sort()).toEqual(
      Object.keys(STACKS).sort(),
    );
    const runs = (projects?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("--agents copilot,codex,claude");
    expect(runs).toContain("scripts/matrix/check-project.sh");
  });

  it("PROJ-016 checks generated infrastructure, and ci-gate needs it", () => {
    const job = ci?.jobs.infrastructure;
    const runs = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("tofu fmt -check -recursive");
    expect(runs).toContain("-lockfile=readonly");
    expect(runs).toContain("checkov");
    expect(runs).toContain("npm run check:azure-names");
    expect(ci?.jobs["ci-gate"]?.needs).toContain("infrastructure");
  });

  it("checks the frontend with every stack, in a browser on Linux", () => {
    const runs = (job: string) =>
      (ci?.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs("generated")).toContain("--frontend vue");
    expect(runs("generated")).toContain("npm run build");
    expect(runs("services")).toContain("--frontend vue");
    expect(runs("services")).toContain("npm run test:e2e");
    expect(runs("services")).toContain("docker compose rm --stop --force api");
  });
});

describe("PROJ-011 probes retry until their deadline", () => {
  const services = workflows.find((w) => w.name === "ci.yml")?.data.jobs.services;
  const moved =
    services?.steps?.find(
      (step) => step.name === "Check the frontend finds the API at a new address without a restart",
    )?.run ?? "";

  // Runs the step's own script with docker, curl and sleep replaced by
  // functions. The first `failures` probes time out, as curl does with exit 28.
  const moveApi = (failures: number) => {
    const dir = mkdtempSync(path.join(tmpdir(), "liftoff-move-"));
    try {
      const file = path.join(dir, "step.sh");
      writeFileSync(
        file,
        [
          'moved="$STATE/moved"; probes="$STATE/probes"; echo 0 > "$probes"',
          "docker() {",
          '  case "$1 $2" in',
          '    "inspect --format") case "$3" in *IPAddress*) if [ -f "$moved" ]; then echo 10.0.0.3; else echo 10.0.0.2; fi ;; *) echo demo_default ;; esac ;;',
          '    "compose ps") echo "$4-container" ;;',
          '    "compose up") touch "$moved" ;;',
          '    "run --detach") echo holder ;;',
          "  esac",
          "}",
          "curl() {",
          `  case "$*" in *"/items"*) echo '[{"name":"saved"}]'; return 0 ;; esac`,
          '  n=$(( $(cat "$probes") + 1 )); echo "$n" > "$probes"',
          '  if [ "$n" -le "$FAILURES" ]; then printf 000; return 28; fi',
          "  printf 200",
          "}",
          "sleep() { :; }",
          moved,
        ].join("\n"),
      );
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
        encoding: "utf8",
        env: { ...process.env, STATE: dir, FAILURES: String(failures) },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        probes: Number(readFileSync(path.join(dir, "probes"), "utf8")),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("keeps trying after a probe times out", () => {
    const result = moveApi(2);
    expect(result.stdout).toContain("API address: 10.0.0.2 before, 10.0.0.3 after");
    expect(result.stdout).toContain("readiness through the frontend: 200");
    expect(result.status).toBe(0);
    expect(result.probes).toBe(3);
  });

  it("fails once 30 probes have gone unanswered", () => {
    const result = moveApi(1000);
    expect(result.stdout).toContain("readiness through the frontend: 000");
    expect(result.status).not.toBe(0);
    expect(result.probes).toBe(30);
  });

  it("never lets a probe that times out end a step", () => {
    const helpers = (services?.steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").filter((line) => line.trim().startsWith("status() {")),
    );
    expect(helpers).toHaveLength(2);
    for (const helper of helpers) {
      const result = spawnSync(
        "bash",
        [
          "-eo",
          "pipefail",
          "-c",
          `curl() { printf 000; return 28; }\n${helper}\ncode=$(status /x 1)\necho "got $code"`,
        ],
        { encoding: "utf8" },
      );
      expect(result.stdout).toBe("got 000\n");
      expect(result.status).toBe(0);
    }
  });
});

describe("PROJ-011 generated images are scanned as their own build scans them", () => {
  const ci = () => workflows.find((workflow) => workflow.name === "ci.yml")?.data;
  const step = (job: string, name: string) => {
    const found = ci()?.jobs[job]?.steps?.find((candidate) => candidate.name?.startsWith(name));
    if (!found) throw new Error(`${job} has no "${name}" step`);
    return found as Step & { env?: Record<string, string> };
  };

  it("runs the release's Trivy, checked by its checksum, on every image Compose built", () => {
    for (const job of ["services", "genai"]) {
      const install = step(job, "Install Trivy");
      expect(install.env).toEqual({ TRIVY_VERSION: TRIVY.version, TRIVY_SHA256: TRIVY.sha256 });
      expect(install.run).toContain("sha256sum --check --strict");
      expect(step(job, "Scan the images").run).toContain("--exit-code 1 --severity HIGH,CRITICAL");
    }
  });

  // Runs the scan with docker and Trivy replaced, for a project whose
  // Compose file has `services`.
  const scan = (services: string, trivyStatus = 0) => {
    const dir = mkdtempSync(path.join(tmpdir(), "liftoff-scan-"));
    try {
      const calls = path.join(dir, "calls.txt");
      writeFileSync(
        path.join(dir, "trivy"),
        `#!/usr/bin/env bash\necho "trivy $*" >> "${calls.replaceAll("\\", "/")}"\nexit ${trivyStatus}\n`,
        { mode: 0o755 },
      );
      const docker = [
        "docker() {",
        '  case "$*" in',
        `    "compose config --services") printf '${services}' ;;`,
        '    "compose ps -q "*) echo "container-$4" ;;',
        '    inspect*) local args="$*"; echo "demo-${args##*container-}" ;;',
        '    *) echo "unexpected docker $*" >&2; return 1 ;;',
        "  esac",
        "}",
      ].join("\n");
      const file = path.join(dir, "scan.sh");
      writeFileSync(file, `${docker}\n${step("genai", "Scan the images").run ?? ""}`);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: dir },
      });
      return {
        status: result.status,
        scanned: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("scans only the images a project has, and fails when Trivy finds something", () => {
    const flags = "--exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed --no-progress";
    expect(scan("database\\napi\\nmigrate\\n")).toEqual({
      status: 0,
      scanned: [`trivy image ${flags} demo-api`],
    });
    expect(scan("api\\nweb\\n").scanned).toEqual([
      `trivy image ${flags} demo-api`,
      `trivy image ${flags} demo-web`,
    ]);
    expect(scan("api\\n", 1).status).toBe(1);
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
