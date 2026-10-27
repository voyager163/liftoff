import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyInit, planInit } from "../../src/application/init/init-project.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import {
  AssessError,
  assessProject,
  type ProjectAssessment,
} from "../../src/application/project/assess-project.ts";
import { isDeclaration, LIMITS } from "../../src/domain/assess/tree.ts";
import { validateConfig } from "../../src/domain/project/config.ts";
import { FakeInitializer } from "../helpers/initializer.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-assess-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const write = (relative: string, content = "") => {
  const target = path.join(work, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

/** A Git repository root, as far as an assessment can tell. */
const repository = () => mkdirSync(path.join(work, ".git"), { recursive: true });

const run = (options: Partial<Parameters<typeof assessProject>[2]> = {}, port = fs) =>
  assessProject(port, work, { named: false, refused: [], ...options });

const statuses = (assessment: ProjectAssessment) =>
  assessment.findings.map(
    (finding) =>
      `${finding.status} ${finding.check}${finding.subject ? ` ${finding.subject}` : ""}`,
  );

const generated = async (overrides: Record<string, unknown>) => {
  const config = validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "python-fastapi",
    workflow: "manual",
    agents: [],
    governance: "single-maintainer-gitflow",
    review: { ai: false },
    ...overrides,
  });
  const plan = await planInit({ assets, fs }, { config, target: work, liftoffVersion: "1.0.0" });
  await applyInit({ assets, fs, initializer: new FakeInitializer() }, plan, "1.0.0");
  repository();
};

const PYPROJECT =
  '[project]\nname = "api"\nrequires-python = ">=3.14"\ndependencies = ["fastapi>=0.1"]\n';

describe("ASSESS-003 a project this release generates meets its standard", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ["python, no agents", {}, ["backend python-fastapi"]],
    [
      "python, every agent, owners",
      { agents: ["copilot", "codex", "claude"], review: { ai: true }, owners: ["octocat"] },
      ["backend python-fastapi"],
    ],
    [
      "python, no governance",
      { agents: ["claude"], review: { ai: true }, governance: "none" },
      ["backend python-fastapi"],
    ],
    [
      "node and vue",
      { stack: "node-fastify", frontend: "vue", agents: ["copilot"], review: { ai: true } },
      ["backend node-fastify", "frontend vue"],
    ],
    [
      "go, vue and azure",
      {
        stack: "go-huma",
        frontend: "vue",
        infrastructure: "azure",
        environments: ["dev", "staging", "prod"],
        agents: ["codex"],
        review: { ai: true },
      },
      ["backend go-huma", "frontend vue", "infrastructure azure"],
    ],
    [
      "genai",
      {
        workload: "genai",
        stack: "python-pydanticai",
        pattern: "rag",
        agents: ["copilot"],
        review: { ai: true },
      },
      ["backend python-pydanticai"],
    ],
  ])("%s: every finding is compliant", async (_name, overrides, parts) => {
    await generated(overrides);
    const assessment = await run();
    expect(statuses(assessment).filter((line) => !line.startsWith("compliant"))).toEqual([]);
    expect(assessment.liftoff).toBe("project");
    expect(assessment.parts.map((part) => `${part.component} ${part.stack}`).sort()).toEqual(parts);
    expect(assessment.parts.every((part) => part.supported)).toBe(true);
    expect(assessment.gaps.map((gap) => gap.kind)).toContain("not-checked");
  });
});

describe("ASSESS-001 assessing a project changes nothing and runs nothing", () => {
  it("only reads, and reads only declarations and Liftoff's own files", async () => {
    await generated({ agents: ["claude"], review: { ai: true } });
    write(".env", "SECRET=do-not-read\n");
    write("backend/terraform.tfstate", "{}");
    const snapshot = () => {
      const files = readdirSync(work, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      // Each file's time and contents through one handle, so both are the same file's.
      return files.sort().map((file) => {
        const handle = openSync(file, "r");
        try {
          return `${file} ${fstatSync(handle).mtimeMs} ${readFileSync(handle, "utf8")}`;
        } finally {
          closeSync(handle);
        }
      });
    };
    const before = snapshot();
    const calls: { method: string; file: string }[] = [];
    // Every way to look at the project that follows no link; nothing else,
    // and nothing that writes.
    const READS = new Set(["entry", "directoryIdentity", "listWithin", "readWithin", "hashWithin"]);
    const spy = new Proxy(fs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const method = String(property);
        return (...args: unknown[]) => {
          if (!READS.has(method)) throw new Error(`assess called ${method}`);
          const file =
            method === "entry" || method === "directoryIdentity"
              ? path.relative(work, String(args[0])).split(path.sep).join("/")
              : String(args[1]);
          calls.push({ method, file });
          return value.apply(target, args);
        };
      },
    });
    const assessment = await run({}, spy);
    expect(snapshot()).toEqual(before);
    const manifest = JSON.parse(
      readFileSync(path.join(work, ".liftoff/manifest.json"), "utf8"),
    ) as { files: { path: string }[] };
    // Declarations, and Liftoff's own files: its records, and what the
    // manifest lists, which validate hashes.
    const own = new Set(manifest.files.map((file) => file.path));
    const opened = calls.filter(
      (call) => call.method === "readWithin" || call.method === "hashWithin",
    );
    expect(opened.filter((call) => call.method === "readWithin").length).toBeGreaterThan(0);
    expect(
      opened.filter(
        (call) =>
          !isDeclaration(call.file) &&
          !own.has(call.file) &&
          !call.file.startsWith(".liftoff/") &&
          call.file !== "liftoff.yaml",
      ),
    ).toEqual([]);
    expect(opened.map((call) => call.file)).not.toContain(".env");
    expect(assessment.gaps).toContainEqual(
      expect.objectContaining({ kind: "not-read", path: ".env" }),
    );
    expect(assessment.gaps).toContainEqual(
      expect.objectContaining({ kind: "not-read", path: "backend/terraform.tfstate" }),
    );
  });

  it("assesses another directory only when it is named, and never the home or root", async () => {
    write("README.md", "# Notes\n");
    await expect(run()).rejects.toThrow(/is not the root of a Git repository; name it with --dir/);
    expect((await run({ named: true })).git).toBe(false);
    await expect(run({ named: true, refused: [work] })).rejects.toThrow(AssessError);
    await expect(
      assessProject(fs, path.parse(work).root, { named: true, refused: [] }),
    ).rejects.toThrow(/is not a project/);
    await expect(
      assessProject(fs, path.join(work, "README.md"), { named: true, refused: [] }),
    ).rejects.toThrow(/is not a directory/);
    await expect(
      assessProject(fs, path.join(work, "missing"), { named: true, refused: [] }),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses a project directory replaced while it is assessed", async () => {
    repository();
    let calls = 0;
    const replaced: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      directoryIdentity: async () => `identity ${calls++}`,
    });
    await expect(run({}, replaced)).rejects.toThrow(/was replaced while it was being assessed/);
  });

  it("calls nothing but reads when GitHub is not asked for", async () => {
    repository();
    let asked = false;
    await run({});
    await run({
      live: async () => {
        asked = true;
        return { kind: "not-requested" };
      },
    });
    expect(asked).toBe(true);
  });
});

describe("ASSESS-002 the walk is bounded and follows no link", () => {
  it("follows no link and lists it as a gap", async () => {
    repository();
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-assess-outside-"));
    try {
      writeFileSync(path.join(outside, "pyproject.toml"), PYPROJECT);
      symlinkSync(outside, path.join(work, "linked"), "junction");
      const assessment = await run();
      expect(assessment.parts).toEqual([]);
      expect(assessment.gaps).toContainEqual(
        expect.objectContaining({ kind: "link", path: "linked" }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not walk dependencies or build output", async () => {
    repository();
    write("node_modules/fastify/package.json", '{"dependencies":{"fastify":"5"}}');
    write("api/.venv/lib/pyproject.toml", PYPROJECT);
    const assessment = await run();
    expect(assessment.parts).toEqual([]);
    expect(assessment.gaps.filter((gap) => gap.kind === "skipped").map((gap) => gap.path)).toEqual([
      ".git",
      "node_modules",
      "api/.venv",
    ]);
  });

  it("stops at each limit and says which", async () => {
    repository();
    write("a/b/c/d/pyproject.toml", PYPROJECT);
    const deep = await run({ limits: { ...LIMITS, depth: 2 } });
    expect(deep.gaps).toContainEqual({
      kind: "limit",
      path: "a/b/c",
      detail: "deeper than 2 directories",
    });
    expect(deep.parts).toEqual([]);
    rmSync(path.join(work, "a"), { recursive: true });

    write("many/1");
    write("many/2");
    write("many/3");
    const wide = await run({ limits: { ...LIMITS, directoryEntries: 2 } });
    expect(wide.gaps).toContainEqual({
      kind: "limit",
      path: "many",
      detail: "only its first 2 entries were listed",
    });
    const few = await run({ limits: { ...LIMITS, entries: 3 } });
    expect(few.gaps).toContainEqual({
      kind: "limit",
      path: "many",
      detail: "the walk stopped after 3 entries",
    });
    rmSync(path.join(work, "many"), { recursive: true });

    write("big/pyproject.toml", `${PYPROJECT}# ${"x".repeat(200)}\n`);
    write("small/pyproject.toml", PYPROJECT);
    const large = await run({ limits: { ...LIMITS, bytes: 150 } });
    expect(large.gaps).toContainEqual({
      kind: "too-large",
      path: "big/pyproject.toml",
      detail: "over 150 bytes, so not read",
    });
    expect(statuses(large)).toContain("unknown structure.part big");
    const one = await run({ limits: { ...LIMITS, reads: 1 } });
    expect(one.gaps).toContainEqual({
      kind: "limit",
      path: "small/pyproject.toml",
      detail: "only the first 1 declarations were read",
    });
    expect(one.walked.read).toBe(1);
    expect(statuses(one)).toContain("unknown structure.part small");
  });
});

describe("ASSESS-003 findings keep unknown, unsupported, inaccessible and noncompliant apart", () => {
  it("tells a bad declaration, a closed directory and another ecosystem from a difference", async () => {
    repository();
    write("web/package.json", "{ not json");
    write("tools/Cargo.toml", '[package]\nname = "tool"\n');
    write("api/pyproject.toml", PYPROJECT);
    write("api/tests/test_app.py", "");
    write("secret/pyproject.toml", PYPROJECT);
    const closing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      listWithin: (directory: string, relative: string, max: number) =>
        relative === "secret"
          ? Promise.resolve({ kind: "inaccessible", via: "secret" })
          : fs.listWithin(directory, relative, max),
    });
    const assessment = await run({}, closing);
    const lines = statuses(assessment);
    expect(lines).toContain("unknown structure.part web");
    expect(lines).toContain("unsupported structure.part tools");
    expect(lines).toContain("compliant structure.part api");
    expect(lines).toContain("noncompliant dependencies.lockfile backend at api");
    expect(assessment.gaps).toContainEqual(
      expect.objectContaining({ kind: "inaccessible", path: "secret" }),
    );
    expect(assessment.next.map((action) => action.category)).toContain("access");
    expect(assessment.summary.inaccessible + assessment.summary.unknown).toBeGreaterThan(0);
  });

  it("reports a declaration it may not read, and one that changed as it was read or listed", async () => {
    repository();
    write("closed/pyproject.toml", PYPROJECT);
    write("moving/package.json", "{}");
    write("gone/x", "");
    const odd: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      readWithin: (directory: string, relative: string, max: number) =>
        relative === "closed/pyproject.toml"
          ? Promise.resolve({ kind: "inaccessible" })
          : relative === "moving/package.json"
            ? Promise.resolve({ kind: "other" })
            : fs.readWithin(directory, relative, max),
      listWithin: (directory: string, relative: string, max: number) =>
        relative === "gone"
          ? Promise.resolve({ kind: "missing" })
          : fs.listWithin(directory, relative, max),
    });
    const assessment = await run({}, odd);
    expect(statuses(assessment)).toEqual(
      expect.arrayContaining([
        "inaccessible structure.part closed",
        "unknown structure.part moving",
      ]),
    );
    expect(assessment.gaps).toEqual(
      expect.arrayContaining([
        { kind: "inaccessible", path: "closed/pyproject.toml", detail: "closed to this user" },
        { kind: "changed", path: "moving/package.json", detail: "changed while it was being read" },
        { kind: "changed", path: "gone", detail: "changed while it was being listed" },
      ]),
    );
    const closed: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      entry: () => Promise.resolve({ kind: "inaccessible", size: 0 }),
    });
    await expect(run({}, closed)).rejects.toThrow(/cannot be read by this user/);
  });

  it("reports a project from before the rebuild without changing it", async () => {
    repository();
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    write(".liftoff/reviewed-update-transaction.json", '{"schemaVersion":1}\n');
    const assessment = await run();
    expect(assessment.liftoff).toBe("pre-rebuild");
    expect(assessment.legacy?.project).toBe(true);
    expect(statuses(assessment)).toEqual(
      expect.arrayContaining([
        "unsupported liftoff.project",
        "noncompliant liftoff.unfinished .liftoff/reviewed-update-transaction.json",
      ]),
    );
  });

  it("gives the same report for the same project", async () => {
    await generated({ stack: "node-fastify", agents: ["copilot"], review: { ai: true } });
    write("README.md", "changed by hand\n");
    expect(JSON.stringify(await run())).toEqual(JSON.stringify(await run()));
  });

  it("reports what validate finds in a Liftoff project", async () => {
    await generated({});
    rmSync(path.join(work, ".github/workflows/03-review-policy.yml"));
    const assessment = await run();
    expect(statuses(assessment)).toContain(
      "noncompliant liftoff.managed-file-missing .github/workflows/03-review-policy.yml",
    );
    expect(assessment.next).toContainEqual(
      expect.objectContaining({ category: "liftoff", command: "liftoff validate" }),
    );
  });
});
