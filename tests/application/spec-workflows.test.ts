import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyInit, InitializerError, planInit } from "../../src/application/init/init-project.ts";
import type { ProjectFsPort, ToolPort } from "../../src/application/ports.ts";
import { runDoctor } from "../../src/application/project/doctor.ts";
import { validateProject } from "../../src/application/project/validate-project.ts";
import { PlanError, sealPlan } from "../../src/domain/plan/plan.ts";
import { type ProjectConfig, validateConfig } from "../../src/domain/project/config.ts";
import { parseManifest } from "../../src/domain/project/manifest.ts";
import { type FakeClock, FakeInitializer, type FakeStep } from "../helpers/initializer.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();

const config = (overrides: Record<string, unknown> = {}): ProjectConfig =>
  validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "python-fastapi",
    workflow: "openspec",
    agents: ["claude", "copilot", "codex"],
    governance: "single-maintainer-gitflow",
    review: { ai: false },
    ...overrides,
  });

const OPENSPEC_FILES = {
  "openspec/config.yaml": "schema: spec-driven\n",
  "openspec/specs/.gitkeep": "",
  ".claude/skills/openspec-propose/SKILL.md": "---\nname: openspec-propose\n---\n",
};

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-workflow-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const target = () => path.join(work, "demo");
const plan = (project = config()) =>
  planInit({ assets, fs }, { config: project, target: target(), liftoffVersion: "1.0.0" });
const create = async (
  initializer: FakeInitializer,
  project = config(),
  files: ProjectFsPort = fs,
  where = target(),
) => {
  const planned = await planInit(
    { assets, fs },
    { config: project, target: where, liftoffVersion: "1.0.0" },
  );
  return applyInit({ assets, fs: files, initializer }, planned, "1.0.0");
};
const writes = (files: Record<string, string>, outcome?: FakeStep["outcome"]) =>
  new FakeInitializer(() => ({ files, ...(outcome ? { outcome } : {}) }));

describe("PROJ-020 the plan lists the framework's pinned initializer", () => {
  it("runs OpenSpec's initializer for each selected host", async () => {
    const planned = await plan();
    expect(planned.effects).toEqual(["write-files", "run-initializer"]);
    expect(planned.initializer).toEqual({
      name: "OpenSpec",
      version: "1.14.3",
      steps: [
        {
          command: "npx",
          args: [
            "--yes",
            "@fission-ai/openspec@1.14.3",
            "init",
            "--tools",
            "claude,github-copilot,codex",
            "--no-animation",
            "--no-copilot-cloud",
            ".",
          ],
        },
      ],
    });
    const none = await plan(config({ agents: [] }));
    expect(none.initializer?.steps[0]?.args).toContain("none");
  });

  it("runs Spec Kit's initializer at a pinned commit, then adds the other hosts", async () => {
    const source =
      "git+https://github.com/github/spec-kit.git@9dca9bf42a031765ee5e5f2371137f2f26967e11";
    const planned = await plan(config({ workflow: "spec-kit", agents: ["claude", "copilot"] }));
    expect(planned.initializer?.name).toBe("Spec Kit");
    expect(planned.initializer?.version).toBe("1.2.1");
    expect(planned.initializer?.steps).toEqual([
      {
        command: "uvx",
        args: [
          "--from",
          source,
          "specify",
          "init",
          "--here",
          "--non-interactive",
          "--ignore-agent-tools",
          "--script",
          "py",
          "--integration",
          "claude",
        ],
      },
      {
        command: "uvx",
        args: ["--from", source, "specify", "integration", "install", "copilot", "--force"],
      },
    ]);
    // Without Copilot every integration is declared safe to combine.
    const safe = await plan(config({ workflow: "spec-kit", agents: ["codex", "claude"] }));
    expect(safe.initializer?.steps[1]?.args).not.toContain("--force");
  });

  it("runs nothing for the manual workflow", async () => {
    const manual = await plan(config({ workflow: "manual" }));
    expect(manual.effects).toEqual(["write-files"]);
    expect(manual.initializer).toBeUndefined();
  });
});

describe("PROJ-020 init records the framework's files as its own", () => {
  it("runs the initializer alone in the staging directory, then adds Liftoff's files", async () => {
    let emptyWhenRun = false;
    const initializer = new FakeInitializer((_step, directory) => {
      emptyWhenRun = readdirSync(directory).length === 0;
      return { files: OPENSPEC_FILES };
    });
    const liftoffFiles = (await plan()).files.length;
    const result = await create(initializer);

    expect(initializer.runs).toHaveLength(1);
    const staging = initializer.runs[0]?.directory ?? "";
    expect(path.dirname(staging)).toBe(work);
    expect(staging).not.toBe(target());
    expect(emptyWhenRun).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(result.files).toBe(liftoffFiles);
    expect(result.frameworkFiles).toBe(3);
    expect(readFileSync(path.join(target(), "openspec/config.yaml"), "utf8")).toContain("spec");

    const manifest = parseManifest(
      readFileSync(path.join(target(), ".liftoff/manifest.json"), "utf8"),
    );
    const framework = manifest.files.filter((file) => file.ownership === "framework");
    expect(framework.map((file) => [file.path, file.plugin])).toEqual([
      [".claude/skills/openspec-propose/SKILL.md", "workflow/openspec"],
      ["openspec/config.yaml", "workflow/openspec"],
      ["openspec/specs/.gitkeep", "workflow/openspec"],
    ]);
    expect(manifest.plugins.map((plugin) => plugin.id)).toContain("workflow/openspec");
  });

  it("never reports the framework's files, even when changed or removed", async () => {
    await create(writes(OPENSPEC_FILES));
    writeFileSync(path.join(target(), "openspec/config.yaml"), "schema: mine\n");
    rmSync(path.join(target(), ".claude/skills/openspec-propose"), { recursive: true });
    const result = await validateProject(fs, target());
    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("explains the workflow in README and AGENTS.md", async () => {
    await create(writes(OPENSPEC_FILES));
    const readme = readFileSync(path.join(target(), "README.md"), "utf8");
    const agents = readFileSync(path.join(target(), "AGENTS.md"), "utf8");
    for (const text of [readme, agents]) {
      expect(text).toContain("## Specifications");
      expect(text).toContain("OpenSpec");
      expect(text).toContain("npm install --global @fission-ai/openspec@1.14.3");
    }
    const manual = path.join(work, "manual");
    await create(new FakeInitializer(), config({ workflow: "manual" }), fs, manual);
    for (const file of ["README.md", "AGENTS.md"]) {
      expect(readFileSync(path.join(manual, file), "utf8")).not.toContain("## Specifications");
    }
  });

  it("checks the workflow's tools with doctor", async () => {
    const versions = (known: Record<string, string>): ToolPort => ({
      version: async (command) => known[command],
    });
    await create(writes(OPENSPEC_FILES));
    const openspec = await runDoctor(
      { fs, tools: versions({ openspec: "1.14.3", uv: "uv 0.13.1", git: "git version 2.54.0" }) },
      target(),
    );
    expect(openspec.tools.find((tool) => tool.name === "OpenSpec")).toMatchObject({
      status: "ok",
      required: true,
    });

    const specKit = path.join(work, "spec-kit");
    await create(
      writes({ ".specify/memory/constitution.md": "# Constitution\n" }),
      config({ workflow: "spec-kit", agents: ["codex"] }),
      fs,
      specKit,
    );
    const python = async (known: Record<string, string>) =>
      (await runDoctor({ fs, tools: versions(known) }, specKit)).tools.find(
        (tool) => tool.name === "Python",
      );
    // Without python3, the python command is checked instead.
    expect(await python({ python: "Python 3.10.4" })).toMatchObject({
      status: "too-old",
      version: "3.10.4",
      minimum: "3.11.0",
    });
    expect(await python({ python3: "Python 3.14.0", python: "Python 2.7.18" })).toMatchObject({
      status: "ok",
      version: "3.14.0",
    });
  });
});

describe("INIT-005 what an initializer writes is checked before anything is published", () => {
  it.each<[string, FakeInitializer, RegExp]>([
    [
      "a failing initializer",
      writes({}, { exitCode: 1, output: "npm error 404" }),
      /OpenSpec 1.14.3's initializer failed with exit code 1:\nnpm error 404/,
    ],
    [
      "an initializer that cannot start",
      writes({}, { started: false, exitCode: null, output: "could not start npx: ENOENT" }),
      /could not start \(could not start npx: ENOENT\); it needs Node.js with npm/,
    ],
    [
      "an initializer that runs too long",
      writes({}, { timedOut: true, exitCode: null }),
      /did not finish in time/,
    ],
    [
      "a Git repository",
      writes({ ".git/HEAD": "ref: refs/heads/main\n" }),
      /created a Git repository/,
    ],
    [
      "a Git repository in capitals",
      writes({ ".GIT/HEAD": "ref: x\n" }),
      /created a Git repository/,
    ],
    [
      "an empty Git directory",
      new FakeInitializer(() => ({ directories: [".git"] })),
      /created a Git repository/,
    ],
    [
      "a nested Git directory with only directories in it",
      new FakeInitializer(() => ({ directories: ["vendor/x/.GIT/refs"] })),
      /created a Git repository/,
    ],
    [
      "a directory where Liftoff writes a file",
      new FakeInitializer(() => ({ directories: ["README.md"] })),
      /wrote README.md, where Liftoff writes its own file/,
    ],
    [
      "a nested Git repository",
      writes({ "vendor/template/.git/HEAD": "ref: x\n" }),
      /created a Git repository/,
    ],
    [
      "a Windows path escaped as in JSON",
      new FakeInitializer(
        () => ({
          files: {
            "openspec/tools.json": JSON.stringify({ python: "C:\\Users\\alice\\py.exe" }),
          },
        }),
        ["C:\\Users\\alice"],
      ),
      /wrote a path from this machine into openspec\/tools.json/,
    ],
    [
      "a file where Liftoff writes its own",
      writes({ "README.md": "# Mine\n" }),
      /wrote README.md, where Liftoff writes its own file/,
    ],
    ["the same file in another case", writes({ "readme.md": "# Mine\n" }), /wrote readme.md/],
    ["a file where Liftoff writes a directory", writes({ backend: "" }), /wrote backend, where/],
    [
      "a path from this machine",
      new FakeInitializer(
        () => ({ files: { "openspec/config.yaml": "python: /home/someone/.venv/bin/python\n" } }),
        ["/home/someone", "/"],
      ),
      /wrote a path from this machine into openspec\/config.yaml/,
    ],
  ])("refuses %s and creates nothing", async (_case, initializer, message) => {
    await expect(create(initializer)).rejects.toThrow(message);
    await expect(create(initializer)).rejects.toThrow(InitializerError);
    expect(readdirSync(work)).toEqual([]);
  });

  it("refuses the staging directory's own path in a file", async () => {
    const leaking = new FakeInitializer((_step, directory) => ({
      files: { "openspec/config.yaml": `root: ${directory}\n` },
    }));
    await expect(create(leaking)).rejects.toThrow(/a path from this machine/);
    expect(readdirSync(work)).toEqual([]);
  });

  it("ignores machine paths too short to mean anything", async () => {
    const initializer = new FakeInitializer(() => ({ files: OPENSPEC_FILES }), ["/", "C:\\"]);
    await expect(create(initializer)).resolves.toMatchObject({ frameworkFiles: 3 });
  });

  it("refuses anything that is not a regular file", async () => {
    const linking: ProjectFsPort = {
      state: (p) => fs.state(p),
      readText: (p) => fs.readText(p),
      createStaging: (p) => fs.createStaging(p),
      writeFile: (p, c, x) => fs.writeFile(p, c, x),
      publish: (s, t) => fs.publish(s, t),
      remove: (p) => fs.remove(p),
      replaceFile: (p, c) => fs.replaceFile(p, c),
      createExclusive: (p, c) => fs.createExclusive(p, c),
      listTree: async () => [{ path: "openspec/link", kind: "other" }],
    };
    await expect(create(writes({}), config(), linking)).rejects.toThrow(
      /created openspec\/link, which is not a regular file/,
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it("stops when cancelled while the initializer runs", async () => {
    const controller = new AbortController();
    const initializer = new FakeInitializer(() => {
      controller.abort();
      return { files: OPENSPEC_FILES };
    });
    await expect(
      applyInit({ assets, fs, initializer }, await plan(), "1.0.0", { signal: controller.signal }),
    ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(readdirSync(work)).toEqual([]);
  });
});

describe("INIT-005 one time limit for the whole initializer", () => {
  const specKit = config({ workflow: "spec-kit", agents: ["claude", "codex", "copilot"] });
  const minutes = (count: number) => count * 60_000;
  const apply = async (initializer: FakeInitializer, clock: FakeClock) =>
    applyInit({ assets, fs, initializer }, await plan(specKit), "1.0.0", {
      now: () => clock.ms,
    });

  it("gives each step only what is left of ten minutes", async () => {
    const clock = { ms: 0 };
    const initializer = new FakeInitializer(() => ({ takesMs: minutes(4) }), [], clock);
    await expect(apply(initializer, clock)).rejects.toThrow(
      /Spec Kit 1.2.1's initializer did not finish in time/,
    );
    expect(initializer.runs.map((run) => run.timeoutMs)).toEqual([
      minutes(10),
      minutes(6),
      minutes(2),
    ]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("starts no step once the time is up", async () => {
    const clock = { ms: 0 };
    const initializer = new FakeInitializer(() => ({ takesMs: minutes(10) }), [], clock);
    await expect(apply(initializer, clock)).rejects.toThrow(/did not finish in time/);
    expect(initializer.runs).toHaveLength(1);
    expect(readdirSync(work)).toEqual([]);
  });

  it("finishes when all the steps fit", async () => {
    const clock = { ms: 0 };
    const initializer = new FakeInitializer(() => ({ takesMs: minutes(3) }), [], clock);
    await expect(apply(initializer, clock)).resolves.toMatchObject({ frameworkFiles: 0 });
  });
});

describe("INIT-004 a plan's initializer cannot be changed", () => {
  it("refuses a plan whose initializer or effects were edited", async () => {
    const planned = await plan();
    const { hash: _hash, ...rest } = planned;
    const step = rest.initializer?.steps[0];
    const edited = sealPlan({
      ...rest,
      initializer: {
        name: "OpenSpec",
        version: "1.14.3",
        steps: [{ command: "npx", args: [...(step?.args ?? []), "--force"] }],
      },
    });
    const initializer = writes(OPENSPEC_FILES);
    await expect(applyInit({ assets, fs, initializer }, edited, "1.0.0")).rejects.toThrow(
      /would now run a different initializer/,
    );
    const quiet = sealPlan({ ...rest, effects: ["write-files"] });
    await expect(applyInit({ assets, fs, initializer }, quiet, "1.0.0")).rejects.toThrow(PlanError);
    expect(initializer.runs).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });
});
