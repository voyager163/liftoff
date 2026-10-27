import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandSpec } from "../../src/cli/command.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeDoctorCommand } from "../../src/cli/commands/validate-doctor.ts";
import { REGISTRY } from "../../src/cli/registry.ts";
import { runCli } from "../../src/cli/run.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { captureIo } from "../helpers/io.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-cli-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const exec = async (
  argv: string[],
  answer?: boolean,
  registry: readonly CommandSpec[] = REGISTRY,
  cwd = work,
) => {
  const io = captureIo(cwd, answer);
  const code = await runCli(argv, io, registry, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

const PROJECT = [
  "--name",
  "demo",
  "--workflow",
  "manual",
  "--agents",
  "claude,copilot",
  "--owners",
  "octocat",
];

describe("INIT-001 plan changes nothing but the plan file", () => {
  it("previews without writing", async () => {
    const { code, out } = await exec(["plan", ...PROJECT]);
    expect(code).toBe(0);
    expect(out).toContain(`Project demo in ${path.join(work, "demo")}`);
    expect(out).toContain("Effects: write-files");
    expect(readdirSync(work)).toEqual([]);
  });

  it("saves a plan that init then applies", async () => {
    const saved = await exec(["plan", ...PROJECT, "--out", "demo.plan.json"]);
    expect(saved.out).toContain("liftoff init --plan demo.plan.json");
    expect(readdirSync(work)).toEqual(["demo.plan.json"]);
    const created = await exec(["init", "--plan", "demo.plan.json", "--yes"]);
    expect(created.code).toBe(0);
    expect(created.out).toContain("Created");
    expect(created.out).toContain("cd backend && uv sync && uv run pytest");
    expect(existsSync(path.join(work, "demo/CLAUDE.md"))).toBe(true);
  });

  it("suggests the selected stack's first commands", async () => {
    const { code, out } = await exec(["init", ...PROJECT, "--stack", "node-fastify", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("cd backend && npm ci && npm test");
    expect(out).not.toContain("uv sync");
    const go = await exec(["init", ...PROJECT, "--stack", "go-huma", "--dir", "go-demo", "--yes"]);
    expect(go.out).toContain("cd backend && go test ./...");
  });

  it("creates a GenAI project with the generic pattern by default", async () => {
    const { code, out } = await exec(["init", ...PROJECT, "--workload", "genai", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("  cd backend && uv sync && uv run pytest\n");
    const config = readFileSync(path.join(work, "demo/liftoff.yaml"), "utf8");
    expect(config).toContain("stack: python-pydanticai\npattern: generic\n");
  });

  it("creates infrastructure for every environment by default", async () => {
    const { code, out } = await exec([
      "init",
      ...PROJECT,
      "--frontend",
      "vue",
      "--infrastructure",
      "azure",
      "--yes",
    ]);
    expect(code).toBe(0);
    expect(out).toContain(
      "  cd ../frontend && npm ci && npm test\n  cd ../infrastructure/opentofu/azure && tofu fmt -check -recursive\n",
    );
    const roots = path.join(work, "demo/infrastructure/opentofu/azure/environments");
    expect(readdirSync(roots).sort()).toEqual(["dev", "prod", "staging"]);
  });

  it("suggests the frontend's first commands from the backend's directory", async () => {
    const { code, out } = await exec(["init", ...PROJECT, "--frontend", "vue", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain(
      "  cd backend && uv sync && uv run pytest\n  cd ../frontend && npm ci && npm test\n",
    );
    expect(existsSync(path.join(work, "demo/frontend/package.json"))).toBe(true);
  });

  it("emits the plan as JSON", async () => {
    const { out } = await exec(["plan", ...PROJECT, "--json"]);
    const report = JSON.parse(out);
    expect(report.schema).toBe("liftoff.plan-report/v1");
    expect(report.plan.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.plan.files.some((f: { path: string }) => f.path === "liftoff.yaml")).toBe(true);
  });

  it("refuses an edited plan", async () => {
    await exec(["plan", ...PROJECT, "--out", "p.json"]);
    const plan = JSON.parse(readFileSync(path.join(work, "p.json"), "utf8"));
    plan.target = path.join(work, "elsewhere");
    writeFileSync(path.join(work, "p.json"), JSON.stringify(plan));
    const { code, err } = await exec(["init", "--plan", "p.json", "--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("changed after it was made");
  });
});

describe("PROJ-020 the command line runs the workflow's own initializer", () => {
  const OPENSPEC = ["--name", "demo", "--agents", "claude"];
  const init = (initializer: FakeInitializer) => [
    makeInitCommand((cwd) => ({ ...defaultProjectPorts(cwd), initializer })),
  ];

  it("shows the initializer and its exact command in the plan", async () => {
    const { code, out } = await exec(["plan", ...OPENSPEC]);
    expect(code).toBe(0);
    expect(out).toContain("workflow openspec");
    expect(out).toContain("Effects: write-files, run-initializer\n");
    expect(out).toContain("runs OpenSpec 1.14.3's own initializer");
    expect(out).toContain(
      "    npx --yes @fission-ai/openspec@1.14.3 init --tools claude --no-animation --no-copilot-cloud .\n",
    );
    expect(out).toContain("nothing else is installed, run or sent anywhere");
  });

  it("asks before running it and counts the framework's files", async () => {
    const initializer = new FakeInitializer(() => ({
      files: { "openspec/config.yaml": "schema: spec-driven\n" },
    }));
    const declined = await exec(["init", ...OPENSPEC], false, init(initializer));
    expect(declined.questions[0]).toMatch(/^Create \d+ files and run OpenSpec's initializer in /);
    expect(initializer.runs).toEqual([]);

    const { code, out } = await exec(
      ["init", ...OPENSPEC, "--yes", "--json"],
      undefined,
      init(initializer),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ created: true, frameworkFiles: 1 });
    const text = await exec(
      ["init", ...OPENSPEC, "--dir", "again", "--yes"],
      undefined,
      init(initializer),
    );
    expect(text.out).toMatch(
      /^Created \d+ files in .*again, 1 of them by OpenSpec's initializer\./,
    );
  });

  it("fails with the initializer's output and creates nothing", async () => {
    const initializer = new FakeInitializer(() => ({
      outcome: { exitCode: 2, output: "npm error network" },
    }));
    const { code, err } = await exec(["init", ...OPENSPEC, "--yes"], undefined, init(initializer));
    expect(code).toBe(1);
    expect(err).toContain(
      "OpenSpec 1.14.3's initializer failed with exit code 2:\nnpm error network",
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it("lists every workflow and its initializer in capabilities", async () => {
    const { out } = await exec(["capabilities", "--json"]);
    const report = JSON.parse(out);
    expect(report.defaultWorkflow).toBe("openspec");
    expect(report.workflows).toEqual([
      expect.objectContaining({
        id: "openspec",
        available: true,
        initializer: { name: "OpenSpec", version: "1.14.3" },
      }),
      expect.objectContaining({
        id: "spec-kit",
        available: true,
        initializer: { name: "Spec Kit", version: "1.2.1" },
      }),
      { id: "manual", available: true, summary: "No specification framework" },
    ]);
  });
});

describe("INIT-003 init asks before writing", () => {
  it("asks, and writes nothing when the answer is no", async () => {
    const { code, out, questions } = await exec(["init", ...PROJECT], false);
    expect(code).toBe(4);
    expect(questions[0]).toMatch(/^Create \d+ files in /);
    expect(out).toContain("Nothing was created.");
    expect(readdirSync(work)).toEqual([]);
  });

  it("creates the project when the answer is yes", async () => {
    const { code } = await exec(["init", ...PROJECT], true);
    expect(code).toBe(0);
    expect(existsSync(path.join(work, "demo/liftoff.yaml"))).toBe(true);
  });

  it("refuses to write without a terminal unless --yes is given", async () => {
    const { code, err } = await exec(["init", ...PROJECT]);
    expect(code).toBe(2);
    expect(err).toContain("pass --yes");
    expect(readdirSync(work)).toEqual([]);
  });

  it("reports JSON for a created project", async () => {
    const { out } = await exec(["init", ...PROJECT, "--yes", "--json", "--dir", "custom"]);
    expect(JSON.parse(out)).toMatchObject({
      schema: "liftoff.init-report/v1",
      created: true,
      target: path.join(work, "custom"),
    });
  });
});

describe("PROJ-003 selection errors map to exit codes", () => {
  it.each([
    [["plan", "--name", "demo", "--workflow", "spec-kit"], 2, "Spec Kit needs at least one"],
    [
      ["plan", "--name", "demo", "--workflow", "manual", "--stack", "cobol"],
      2,
      'unknown stack "cobol"',
    ],
    [
      ["plan", "--name", "demo", "--workflow", "manual", "--pattern", "rag"],
      2,
      "patterns are for genai projects",
    ],
    [
      [
        "plan",
        "--name",
        "demo",
        "--workflow",
        "manual",
        "--workload",
        "genai",
        "--frontend",
        "vue",
      ],
      6,
      "not available for genai projects",
    ],
    [
      ["plan", "--name", "demo", "--workflow", "manual", "--environments", "dev"],
      2,
      "environments need infrastructure",
    ],
    [
      ["plan", "--name", "demo", "--workflow", "manual", "--frontend", "react"],
      2,
      '--frontend must be one of none, vue (got "react")',
    ],
    [["plan", "--workflow", "manual"], 2, "--name is required"],
    [["plan", "--name", "Bad Name", "--workflow", "manual"], 2, "invalid option: name"],
    [
      ["plan", "--name", "demo", "--workflow", "manual", "--ai-review", "on"],
      2,
      "needs at least one coding agent",
    ],
    [["init", "--plan", "missing.json", "--yes"], 2, "cannot read the plan"],
    [["init", "--plan", "x.json", "--name", "demo"], 2, "either --plan or project options"],
    [["init", "--plan", "x.json", "--governance", "none"], 2, "either --plan or project options"],
    [["init", "--plan", "x.json", "--workflow", "manual"], 2, "either --plan or project options"],
    [
      ["init", "--plan", "x.json", "--stack", "python-fastapi"],
      2,
      "either --plan or project options",
    ],
    [["init", "--plan", "x.json", "--ai-review", "off"], 2, "either --plan or project options"],
    [
      ["init", "--name", "demo", "--workflow", "manual", "--dir", ".", "--yes"],
      1,
      "is the current directory or contains it",
    ],
  ])("%j exits %i", async (argv, expected, message) => {
    const { code, err } = await exec(argv);
    expect(code).toBe(expected);
    expect(err).toContain(message);
  });

  it("refuses to create over existing files", async () => {
    await exec(["init", ...PROJECT, "--yes"]);
    const { code, err } = await exec(["init", ...PROJECT, "--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("already has files");
  });
});

describe("VALID-001 validate from the command line", () => {
  it("passes a new project and reports hand edits with exit 3", async () => {
    await exec(["init", ...PROJECT, "--yes"]);
    const ok = await exec(["validate", "--dir", "demo"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toBe("demo is valid.\n");

    writeFileSync(path.join(work, "demo/.github/liftoff/review-policy.mjs"), "tampered");
    const changed = await exec(["validate", "--dir", "demo", "--json"]);
    expect(changed.code).toBe(3);
    const report = JSON.parse(changed.out);
    expect(report.findings[0]).toMatchObject({
      code: "managed-file-changed",
      path: ".github/liftoff/review-policy.mjs",
    });
    const text = await exec(["validate", "--dir", "demo"]);
    expect(text.out).toContain("1 problem in");
    expect(text.out).toContain(
      "warning .github/liftoff/review-policy.mjs: a file Liftoff manages was changed by hand",
    );
  });
});

describe("VALID-002 validate names each old record's state", () => {
  it("lists what a release before the rebuild left, with each state", async () => {
    mkdirSync(path.join(work, "old", ".liftoff", "governance"), { recursive: true });
    writeFileSync(
      path.join(work, "old", "liftoff.manifest.json"),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    writeFileSync(path.join(work, "old", "liftoff.config.json"), '{"telemetry":true}');
    const { code, out } = await exec(["validate", "--dir", "old"]);
    expect(code).toBe(3);
    expect(out.split("\n").slice(1, 5)).toEqual([
      expect.stringMatching(
        /^error {3}liftoff\.manifest\.json: this was made by a Liftoff release before the rebuild;/,
      ),
      expect.stringMatching(
        /^info {4}liftoff\.manifest\.json: migratable: the project's old manifest;.*\[manifest v7 from 0\.12\.3\]$/,
      ),
      "warning liftoff.config.json: unsupported: fields no release before the rebuild wrote: telemetry",
      expect.stringMatching(
        /^info {4}\.liftoff\/governance: readable: governance files from the old release,/,
      ),
    ]);
  });
});

describe("DOCTOR-001 doctor from the command line", () => {
  const doctor = (versions: Record<string, string | undefined>) =>
    makeDoctorCommand(() => ({
      assets: undefined as never,
      fs: { state: async () => "missing", readText: async () => undefined } as never,
      tools: { version: async (command) => versions[command] },
      initializer: undefined as never,
      processes: undefined as never,
    }));

  it("is ready when the tools are present", async () => {
    const { code, out } = await exec(["doctor"], undefined, [
      doctor({ git: "git version 2.54.0" }),
    ]);
    expect(code).toBe(0);
    expect(out).toContain("ok       Git 2.54.0 (needs 2.40.0+): version control");
    expect(out).toContain("Ready.");
  });

  it("says what to install with exit 3", async () => {
    const { code, out } = await exec(["doctor", "--json"], undefined, [doctor({})]);
    expect(code).toBe(3);
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      schema: "liftoff.doctor/v1",
      outcome: "attention",
      ready: false,
    });
    const text = await exec(["doctor"], undefined, [doctor({})]);
    expect(text.out).toContain("install: https://git-scm.com/downloads");
  });

  // Runs the real version commands (each capped at 10 seconds), which can take
  // several seconds in total on Windows runners.
  it("checks a real project's stack", { timeout: 30_000 }, async () => {
    await exec(["init", ...PROJECT, "--yes"]);
    const { out } = await exec(["doctor", "--dir", "demo"]);
    expect(out).toContain("Tools for demo (python-fastapi):");
    expect(out).toContain("[optional]");
  });
});
