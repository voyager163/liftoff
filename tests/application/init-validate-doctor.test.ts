import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyInit, InitTargetError, planInit } from "../../src/application/init/init-project.ts";
import type { ProjectFsPort, ToolPort } from "../../src/application/ports.ts";
import { parseVersion, runDoctor } from "../../src/application/project/doctor.ts";
import { validateProject } from "../../src/application/project/validate-project.ts";
import { PlanError, sealPlan } from "../../src/domain/plan/plan.ts";
import { validateConfig } from "../../src/domain/project/config.ts";
import { FakeInitializer } from "../helpers/initializer.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const initializer = new FakeInitializer();
const config = validateConfig({
  schema: "liftoff.config/v1",
  name: "demo",
  workload: "api",
  stack: "python-fastapi",
  workflow: "manual",
  agents: ["claude"],
  governance: "single-maintainer-gitflow",
  review: { ai: true },
});

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-init-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const create = async (target = path.join(work, "demo"), project = config) => {
  const plan = await planInit({ assets, fs }, { config: project, target, liftoffVersion: "1.0.0" });
  await applyInit({ assets, fs, initializer }, plan, "1.0.0");
  return target;
};

describe("INIT-002 projects are created in one step or not at all", () => {
  it("creates every planned file and leaves no staging directory", async () => {
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    const result = await applyInit({ assets, fs, initializer }, plan, "1.0.0");
    expect(result.files).toBe(plan.files.length);
    expect(readdirSync(work)).toEqual(["demo"]);
    expect(readFileSync(path.join(work, "demo/liftoff.yaml"), "utf8")).toContain("name: demo");
    if (process.platform !== "win32") {
      expect(statSync(path.join(work, "demo")).mode & 0o777).toBe(0o777 & ~process.umask());
      expect(
        statSync(path.join(work, "demo/.github/liftoff/review-agent.sh")).mode & 0o111,
      ).not.toBe(0);
    }
  });

  it("creates into an empty directory", async () => {
    mkdirSync(path.join(work, "empty"));
    await create(path.join(work, "empty"));
    expect(readdirSync(path.join(work, "empty"))).toContain("liftoff.yaml");
  });

  it("refuses a directory that has files, or a file", async () => {
    mkdirSync(path.join(work, "taken"));
    writeFileSync(path.join(work, "taken/keep.txt"), "mine");
    await expect(create(path.join(work, "taken"))).rejects.toThrow(InitTargetError);
    expect(readdirSync(path.join(work, "taken"))).toEqual(["keep.txt"]);
    writeFileSync(path.join(work, "plain-file"), "");
    await expect(create(path.join(work, "plain-file"))).rejects.toThrow(/is a file/);
  });

  it("refuses when the target fills up between planning and applying", async () => {
    const target = path.join(work, "demo");
    const plan = await planInit({ assets, fs }, { config, target, liftoffVersion: "1.0.0" });
    mkdirSync(target);
    writeFileSync(path.join(target, "surprise.txt"), "");
    await expect(applyInit({ assets, fs, initializer }, plan, "1.0.0")).rejects.toThrow(
      /already has files/,
    );
  });

  it("removes the staging directory when a write fails", async () => {
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    let writes = 0;
    const failing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      writeFile: async (p: string, c: string, x: boolean) => {
        if (++writes === 5) throw new Error("disk full");
        return fs.writeFile(p, c, x);
      },
    });
    await expect(applyInit({ assets, fs: failing, initializer }, plan, "1.0.0")).rejects.toThrow(
      "disk full",
    );
    expect(readdirSync(work)).toEqual([]);
  });
});

describe("INIT-002 the working directory and cancellation", () => {
  it("refuses the current directory, or a directory that contains it", async () => {
    const here = path.join(work, "here");
    mkdirSync(here);
    await expect(
      planInit({ assets, fs }, { config, target: here, liftoffVersion: "1.0.0", cwd: here }),
    ).rejects.toThrow(/is the current directory or contains it/);
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    await expect(
      applyInit({ assets, fs, initializer }, plan, "1.0.0", {
        cwd: path.join(work, "demo", "sub"),
      }),
    ).rejects.toThrow(InitTargetError);
    expect(readdirSync(work)).toEqual(["here"]);
  });

  it("stops writing when cancelled and leaves nothing behind", async () => {
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    const controller = new AbortController();
    let writes = 0;
    const interrupted: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      writeFile: async (p: string, c: string, x: boolean) => {
        if (++writes === 3) controller.abort();
        return fs.writeFile(p, c, x);
      },
    });
    await expect(
      applyInit({ assets, fs: interrupted, initializer }, plan, "1.0.0", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(writes).toBe(3);
    expect(readdirSync(work)).toEqual([]);
  });
});

describe("INIT-004 stale plans are refused", () => {
  it("refuses a plan from another Liftoff version", async () => {
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    await expect(applyInit({ assets, fs, initializer }, plan, "1.0.1")).rejects.toThrow(
      /made by Liftoff 1.0.0, but this is 1.0.1/,
    );
  });

  it("refuses a plan whose files no longer match", async () => {
    const plan = await planInit(
      { assets, fs },
      { config, target: path.join(work, "demo"), liftoffVersion: "1.0.0" },
    );
    const { hash: _hash, ...rest } = plan;
    const resealed = sealPlan({ ...rest, files: rest.files.slice(1) });
    await expect(applyInit({ assets, fs, initializer }, resealed, "1.0.0")).rejects.toThrow(
      PlanError,
    );
    expect(readdirSync(work)).toEqual([]);
  });
});

describe("PROJ-024 layout bindings", () => {
  it("refuses to generate a project in another layout rather than use the standard one", async () => {
    await expect(
      planInit(
        { assets, fs },
        {
          config: { ...config, layout: { backend: "services/api" } },
          target: path.join(work, "demo"),
          liftoffVersion: "1.0.0",
        },
      ),
    ).rejects.toThrow("this release generates only the standard layout");
  });

  it("warns about a part bound to a directory that is not there", async () => {
    const target = await create();
    const yaml = path.join(target, "liftoff.yaml");
    writeFileSync(yaml, `${readFileSync(yaml, "utf8")}layout:\n  backend: services/api\n`);
    const result = await validateProject(fs, target);
    expect(result.findings).toContainEqual({
      severity: "warning",
      code: "layout-directory-missing",
      path: "liftoff.yaml",
      message:
        "layout: backend is bound to services/api, which is not a directory here, or is reached through a link",
    });
    mkdirSync(path.join(target, "services", "api"), { recursive: true });
    const bound = await validateProject(fs, target);
    expect(bound.findings.map((finding) => finding.code)).not.toContain("layout-directory-missing");
    // Reached through a link, it is not the project's own directory.
    const elsewhere = mkdtempSync(path.join(tmpdir(), "liftoff-elsewhere-"));
    try {
      mkdirSync(path.join(elsewhere, "api"));
      rmSync(path.join(target, "services"), { recursive: true });
      symlinkSync(elsewhere, path.join(target, "services"), "junction");
      const linked = await validateProject(fs, target);
      expect(linked.findings.map((finding) => finding.code)).toContain("layout-directory-missing");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reports a binding no file system can hold as an invalid config, not a crash", async () => {
    const target = await create();
    const yaml = path.join(target, "liftoff.yaml");
    writeFileSync(yaml, `${readFileSync(yaml, "utf8")}layout:\n  backend: ${"a".repeat(256)}\n`);
    const result = await validateProject(fs, target);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "invalid-config",
        message: expect.stringContaining("has a name longer than 255 bytes"),
      }),
    ]);
  });
});

describe("PROJ-025 the manifest records its history", () => {
  it("records that init created the project, and with which release", async () => {
    const target = await create();
    const manifest = JSON.parse(
      readFileSync(path.join(target, ".liftoff", "manifest.json"), "utf8"),
    ) as { history: unknown };
    expect(manifest.history).toEqual([{ operation: "init", liftoff: "1.0.0" }]);
  });
});

describe("VALID-001 validate reports without repairing", () => {
  it("passes a fresh project", async () => {
    const result = await validateProject(fs, await create());
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("reports changed and missing files by ownership", async () => {
    const target = await create();
    writeFileSync(path.join(target, ".claude/skills/liftoff-verify/SKILL.md"), "edited");
    rmSync(path.join(target, ".claude/agents/liftoff-verifier.md"));
    rmSync(path.join(target, "README.md"));
    writeFileSync(path.join(target, "backend/app/main.py"), "# my own change\n");
    const result = await validateProject(fs, target);
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ["managed-file-missing", ".claude/agents/liftoff-verifier.md"],
      ["managed-file-changed", ".claude/skills/liftoff-verify/SKILL.md"],
      ["seeded-file-missing", "README.md"],
    ]);
    expect(result.valid).toBe(false);
    expect(readFileSync(path.join(target, ".claude/skills/liftoff-verify/SKILL.md"), "utf8")).toBe(
      "edited",
    );
  });

  it("reports a directory where a generated file should be, and keeps checking", async () => {
    const target = await create();
    rmSync(path.join(target, ".github/liftoff/review-policy.mjs"));
    mkdirSync(path.join(target, ".github/liftoff/review-policy.mjs"));
    rmSync(path.join(target, "README.md"));
    const result = await validateProject(fs, target);
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ["not-a-file", ".github/liftoff/review-policy.mjs"],
      ["seeded-file-missing", "README.md"],
    ]);
    expect(result.valid).toBe(false);
  });

  it("follows no link to liftoff.yaml, the manifest or a file it lists", async () => {
    const target = await create();
    const outside = path.join(work, "outside.yaml");
    writeFileSync(outside, "secret: do-not-read\n");
    // Windows may refuse a link to a file without a privilege, but not a
    // junction to a directory, which is a link all the same.
    const link = (at: string) =>
      process.platform === "win32"
        ? symlinkSync(work, at, "junction")
        : symlinkSync(outside, at, "file");
    const config = path.join(target, "liftoff.yaml");
    const original = readFileSync(config, "utf8");
    rmSync(config);
    link(config);
    const linked = await validateProject(fs, target);
    expect(linked.findings.map((f) => [f.code, f.path])).toEqual([
      ["config-not-a-file", "liftoff.yaml"],
    ]);
    expect(JSON.stringify(linked.findings)).not.toContain("secret");

    rmSync(config);
    mkdirSync(config);
    expect((await validateProject(fs, target)).findings[0]?.code).toBe("config-not-a-file");
    rmSync(config, { recursive: true });
    writeFileSync(config, original);

    const readme = path.join(target, "README.md");
    rmSync(readme);
    link(readme);
    expect((await validateProject(fs, target)).findings).toEqual([
      expect.objectContaining({
        code: "not-a-file",
        path: "README.md",
        message: expect.stringContaining("a link"),
      }),
    ]);
  });

  it("reports a file of its own that this user may not read", async () => {
    const target = await create();
    const closed = (closedPath: string): ProjectFsPort =>
      Object.assign(Object.create(fs) as ProjectFsPort, {
        readWithin: (directory: string, relative: string, max: number) =>
          relative === closedPath
            ? Promise.resolve({ kind: "inaccessible" })
            : fs.readWithin(directory, relative, max),
        hashWithin: (directory: string, relative: string, max: number) =>
          relative === closedPath
            ? Promise.resolve({ kind: "inaccessible" })
            : fs.hashWithin(directory, relative, max),
      });
    expect((await validateProject(closed("liftoff.yaml"), target)).findings).toEqual([
      expect.objectContaining({ code: "config-unreadable", severity: "error" }),
    ]);
    expect((await validateProject(closed(".liftoff/manifest.json"), target)).findings).toEqual([
      expect.objectContaining({ code: "manifest-unreadable" }),
    ]);
    expect((await validateProject(closed("AGENTS.md"), target)).findings).toEqual([
      expect.objectContaining({ code: "file-unreadable", severity: "warning", path: "AGENTS.md" }),
    ]);
    writeFileSync(path.join(target, ".liftoff/manifest.json"), " ".repeat(1024 * 1024 + 1));
    expect((await validateProject(fs, target)).findings).toEqual([
      expect.objectContaining({
        code: "manifest-not-a-file",
        message: expect.stringContaining("over 1 MiB"),
      }),
    ]);
  });

  it("reports invalid configuration, manifests and plugins", async () => {
    const target = await create();
    const manifestPath = path.join(target, ".liftoff/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.plugins.push({ id: "stack/cobol", version: "1" });
    manifest.plugins.find((p: { id: string }) => p.id === "review/layered").version = "0";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const findings = (await validateProject(fs, target)).findings;
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["unknown-plugin", "plugin-version"]),
    );

    writeFileSync(manifestPath, "{");
    expect((await validateProject(fs, target)).findings[0]?.code).toBe("invalid-manifest");
    rmSync(manifestPath);
    expect((await validateProject(fs, target)).findings[0]?.code).toBe("missing-manifest");
    writeFileSync(path.join(target, "liftoff.yaml"), "schema: liftoff.config/v1\nname: x\n");
    expect((await validateProject(fs, target)).findings[0]?.code).toBe("invalid-config");
  });

  it("reports an inherited property name as an unknown frontend", async () => {
    const target = await create();
    const configPath = path.join(target, "liftoff.yaml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("frontend: none", "frontend: constructor"),
    );
    expect((await validateProject(fs, target)).findings).toEqual([
      expect.objectContaining({
        code: "invalid-config",
        message: expect.stringContaining('unknown frontend "constructor"'),
      }),
    ]);
    await expect(
      runDoctor({ fs, tools: { version: async () => undefined } }, target),
    ).rejects.toThrow('unknown frontend "constructor"');
  });
});

describe("VALID-002 projects from before the rebuild", () => {
  it.each(["liftoff.config.json", "liftoff.manifest.json"])("recognizes %s", async (file) => {
    writeFileSync(path.join(work, file), "{}");
    const result = await validateProject(fs, work);
    expect(result.valid).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "pre-rebuild-project", path: file, severity: "error" }),
      expect.objectContaining({ code: "legacy-unsupported", path: file, severity: "warning" }),
    ]);
  });

  it("reports each record, its state and why", async () => {
    writeFileSync(
      path.join(work, "liftoff.manifest.json"),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    mkdirSync(path.join(work, ".liftoff"));
    writeFileSync(path.join(work, ".liftoff", "reviewed-update-transaction.json"), "{}");
    const result = await validateProject(fs, work);
    expect(result.legacy?.project).toBe(true);
    expect(result.findings.slice(1)).toEqual([
      {
        severity: "info",
        code: "legacy-migratable",
        path: "liftoff.manifest.json",
        message:
          "migratable: the project's old manifest; adopting the project can carry its choices over [manifest v7 from 0.12.3]",
      },
      expect.objectContaining({
        severity: "error",
        code: "legacy-readable",
        path: ".liftoff/reviewed-update-transaction.json",
      }),
    ]);
  });

  it("says when a directory is not a Liftoff project", async () => {
    expect((await validateProject(fs, work)).findings[0]?.code).toBe("not-a-liftoff-project");
  });
});

describe("DOCTOR-001 doctor checks the tools the project needs", () => {
  const tools = (versions: Record<string, string | undefined>): ToolPort => ({
    version: async (command) => versions[command],
  });

  it("checks the stack's tools inside a project", async () => {
    const target = await create();
    const result = await runDoctor(
      {
        fs,
        tools: tools({
          uv: "uv 0.13.1 (abc 2026-10-14)",
          git: "git version 2.39.1",
          docker: undefined,
        }),
      },
      target,
    );
    expect(result.project).toEqual({ name: "demo", stack: "python-fastapi" });
    expect(result.tools.map((t) => [t.name, t.status, t.version])).toEqual([
      ["uv", "ok", "0.13.1"],
      ["Git", "too-old", "2.39.1"],
      ["Docker", "missing", undefined],
    ]);
    expect(result.ready).toBe(false);
  });

  it("adds the frontend's tools, each tool once", async () => {
    const versions = tools({
      uv: "uv 0.13.1",
      git: "git version 2.54.0",
      docker: "Docker version 29.9.2",
      node: "v26.12.1",
    });
    const python = await create(path.join(work, "python"), { ...config, frontend: "vue" });
    const result = await runDoctor({ fs, tools: versions }, python);
    expect(result.tools.map((t) => [t.name, t.status])).toEqual([
      ["uv", "ok"],
      ["Git", "ok"],
      ["Docker", "ok"],
      ["Node.js", "ok"],
    ]);
    const node = await create(path.join(work, "node"), {
      ...config,
      stack: "node-fastify",
      frontend: "vue",
    });
    const names = (await runDoctor({ fs, tools: versions }, node)).tools.map((t) => t.name);
    expect(names).toEqual(["Node.js", "Git", "Docker"]);
  });

  it("adds the infrastructure's tools", async () => {
    const target = await create(path.join(work, "azure"), {
      ...config,
      infrastructure: "azure",
      environments: ["dev"],
    });
    const result = await runDoctor(
      {
        fs,
        tools: tools({ uv: "uv 0.13.1", git: "git version 2.54.0", tofu: "OpenTofu v1.13.2" }),
      },
      target,
    );
    expect(result.tools.map((t) => [t.name, t.status, t.required])).toEqual([
      ["uv", "ok", true],
      ["Git", "ok", true],
      ["Docker", "missing", false],
      ["OpenTofu", "ok", true],
      ["Checkov", "missing", false],
    ]);
    expect(result.ready).toBe(true);
  });

  it("checks only Git outside a project, and is ready when it is present", async () => {
    const result = await runDoctor({ fs, tools: tools({ git: "git version 2.54.0" }) }, work);
    expect(result.project).toBeUndefined();
    expect(result.tools.map((t) => t.name)).toEqual(["Git"]);
    expect(result.ready).toBe(true);
  });

  it("reports an unparsable version", async () => {
    const result = await runDoctor({ fs, tools: tools({ git: "git (custom build)" }) }, work);
    expect(result.tools[0]?.status).toBe("unknown-version");
    expect(result.ready).toBe(false);
  });

  it("parses dotted versions", () => {
    expect(parseVersion("v1.2")).toEqual([1, 2, 0]);
    expect(parseVersion("none")).toBeUndefined();
  });
});
