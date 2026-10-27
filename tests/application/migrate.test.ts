import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readdirSync,
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
import { ProjectChangeError } from "../../src/application/change/project-change.ts";
import { InitTargetError } from "../../src/application/init/init-project.ts";
import {
  applyMigrate,
  isBlocked,
  MAX_COPIED_BYTES,
  MigrateChangedError,
  type MigrateChoices,
  MigrateOptionError,
  type MigratePlan,
  type MigrateWhere,
  planMigrate,
  planMigrateFromSaved,
} from "../../src/application/migrate/migrate-project.ts";
import type { FileHash, ProjectFsPort } from "../../src/application/ports.ts";
import { AssessError } from "../../src/application/project/assess-project.ts";
import { CHANGE_JOURNAL_FILE, parseChangePlan } from "../../src/domain/plan/change-plan.ts";
import { type Plan, PlanError, parsePlan } from "../../src/domain/plan/plan.ts";
import { CONFIG_FILE, parseConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { projectFiles } from "../helpers/older-project.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const VERSION = "1.0.0";

let work: string;
let root: string;
let target: string;
beforeEach(async () => {
  // As the CLI resolves it: macOS's /var is /private/var, and Windows may
  // give a short name.
  work = await promises.realpath(mkdtempSync(path.join(tmpdir(), "liftoff-migrate-")));
  root = path.join(work, "shop");
  target = path.join(work, "shop-liftoff");
  mkdirSync(root);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const { at, write, snapshot } = projectFiles(() => root);
const made = projectFiles(() => target);

const PYPROJECT = `[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["fastapi>=0.115"]
`;

/** A FastAPI service at the repository root, with what a working copy also holds. */
const service = () => {
  mkdirSync(at(".git"));
  write(".git/HEAD", "ref: refs/heads/main\n");
  write("pyproject.toml", PYPROJECT);
  write("uv.lock", "version = 1\n");
  write("app/main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");
  write("tests/test_main.py", "def test_ok():\n    pass\n");
  write("README.md", "# shop\n");
  write(".env", "SECRET=1\n");
  write(".env.example", "SECRET=\n");
  write("config/.env.local", "SECRET=2\n");
  write("deploy/key.pem", "-----BEGIN PRIVATE KEY-----\n");
  write("node_modules/left-pad/index.js", "module.exports = 1;\n");
  write(".venv/bin/python", "");
  write("dist/app.js", "built\n");
};

const where = (extra: Partial<MigrateWhere> = {}): MigrateWhere => ({
  named: true,
  refused: [],
  cwd: work,
  ...extra,
});

const migrate = (
  choices: MigrateChoices = {},
  port: ProjectFsPort = fs,
  into = target,
  extra: Partial<MigrateWhere> = {},
) => planMigrate({ assets, fs: port }, root, into, VERSION, choices, where(extra));

const fail = (): never => {
  throw new Error("expected a value");
};

/** Each choice as the proposal shows it, with where it came from. */
const chosen = (plan: MigratePlan) =>
  Object.fromEntries(plan.proposal.map((item) => [item.choice, `${item.value} (${item.from})`]));

/** A port that sees each listed path as a file of the given size, too large to hash. */
const sized = (sizes: Readonly<Record<string, number>>): ProjectFsPort =>
  Object.assign(Object.create(fs) as ProjectFsPort, {
    hashWithin: async (directory: string, relative: string, maxBytes: number) => {
      const size = sizes[relative];
      if (size === undefined) return fs.hashWithin(directory, relative, maxBytes);
      const real = await fs.hashWithin(directory, relative, maxBytes);
      if (real.kind !== "file") return real;
      return (size > maxBytes ? { kind: "file", size } : { ...real, size }) satisfies FileHash;
    },
  });

describe("MIGRATE-001 migrating makes a new project beside the old one, and never changes the old one", () => {
  it("makes the project init would make, with the migration in its history", async () => {
    service();
    const before = snapshot();
    const plan = await migrate();
    expect(plan.blocked).toEqual([]);
    expect(chosen(plan)).toMatchObject({
      name: "shop (directory name)",
      backend: "python-fastapi in backend (found)",
      frontend: "none (found)",
      infrastructure: "none (found)",
      workflow: "manual (default)",
    });
    expect(plan.config).toMatchObject({ stack: "python-fastapi", workflow: "manual", layout: {} });
    expect(plan.parts).toEqual([
      expect.objectContaining({ path: ".", component: "backend", to: "backend" }),
    ]);
    const saved = plan.plan ?? fail();
    expect(saved).toMatchObject({
      operation: "migrate",
      source: root,
      target,
      effects: ["write-files", "copy-files"],
    });

    const result = await applyMigrate(fs, plan, { cwd: work });
    expect(result.differences).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(work).sort()).toEqual(["shop", "shop-liftoff"]);
    expect(parseConfig(made.read(CONFIG_FILE))).toMatchObject({ name: "shop", layout: {} });
    const manifest = parseManifest(made.read(MANIFEST_FILE));
    expect(manifest.history).toEqual([{ operation: "migrate", liftoff: VERSION }]);
    expect(manifest.files.map((file) => file.path)).toContain("backend/app/main.py");
    expect(manifest.files.map((file) => file.path)).not.toContain("MIGRATION.md");
    expect(made.read("legacy/app/main.py")).toBe(
      "from fastapi import FastAPI\n\napp = FastAPI()\n",
    );
    expect(existsSync(made.at("MIGRATION.md"))).toBe(true);
    expect(result.files).toBe(saved.files.length + 1 + plan.copies.length);
  });

  it("refuses a target that overlaps the project, has files or holds the current directory", async () => {
    service();
    await expect(migrate({}, fs, path.join(root, "next"))).rejects.toThrow(InitTargetError);
    await expect(migrate({}, fs, root)).rejects.toThrow(InitTargetError);
    await expect(migrate({}, fs, work)).rejects.toThrow(
      "overlaps the project it is made from; put the new project beside it, with --to",
    );
    // Compared as macOS and Windows compare names.
    await expect(migrate({}, fs, path.join(work, "SHOP", "next"))).rejects.toThrow(InitTargetError);
    mkdirSync(target);
    writeFileSync(path.join(target, "notes.txt"), "mine\n");
    await expect(migrate()).rejects.toThrow(
      "already has files; Liftoff creates new projects only in a new or empty directory",
    );
    rmSync(target, { recursive: true });
    await expect(migrate({}, fs, target, { cwd: target })).rejects.toThrow(
      "is the current directory or contains it",
    );
    // An empty directory is fine.
    mkdirSync(target);
    expect(isBlocked(await migrate())).toBe(false);
  });

  it("refuses a Liftoff project, an unfinished change, and a directory that is not a project", async () => {
    service();
    write(CONFIG_FILE, "schema: liftoff.config/v1\n");
    await expect(migrate()).rejects.toThrow(ProjectChangeError);
    rmSync(at(CONFIG_FILE));
    write(CHANGE_JOURNAL_FILE, "");
    await expect(migrate()).rejects.toThrow("a change stopped part way");
    rmSync(at(".liftoff"), { recursive: true });
    await expect(migrate({}, fs, target, { refused: [root] })).rejects.toThrow(AssessError);
    rmSync(at(".git"), { recursive: true });
    await expect(migrate({}, fs, target, { named: false })).rejects.toThrow(
      "is not the root of a Git repository",
    );
    await expect(
      planMigrate({ assets, fs }, path.join(work, "missing"), target, VERSION, {}, where()),
    ).rejects.toThrow("is not a directory Liftoff can migrate");
  });

  it("refuses an option's mistake before anything about the project", async () => {
    write("package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    expect(isBlocked(await migrate())).toBe(true);
    for (const [choices, message] of [
      [{ agents: ["gemini"] }, '--agents: unknown agent "gemini"'],
      [{ stack: "rails" }, '--stack: unknown stack "rails"'],
      [{ infrastructure: "none", environments: ["dev"] }, "--environments are for infrastructure"],
      [{ stack: "python-fastapi", pattern: "rag" }, "--pattern is for GenAI projects"],
    ] as const) {
      await expect(migrate(choices)).rejects.toThrow(message);
      await expect(migrate(choices)).rejects.toThrow(MigrateOptionError);
    }
    // One only the proposal rules out is refused once the parts are known.
    write("pyproject.toml", PYPROJECT);
    rmSync(at("package.json"));
    await expect(migrate({ reviewEngine: "claude" })).rejects.toThrow(MigrateOptionError);
  });

  it("moves an application to a stack named for it, and blocks without one", async () => {
    write("package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    write("server.js", "require('express')\n");
    const none = await migrate();
    expect(none.blocked).toEqual([
      expect.stringContaining(
        "no backend this release supports was found: the project holds express in .; name the stack to move it to with --stack",
      ),
    ]);
    expect(none.plan).toBeUndefined();
    const moved = await migrate({ stack: "node-fastify" });
    expect(moved.blocked).toEqual([]);
    expect(chosen(moved)).toMatchObject({ backend: "node-fastify in backend (option)" });
    expect(moved.parts).toEqual([
      expect.objectContaining({
        stack: "express",
        to: "backend",
        note: expect.stringContaining(
          "It is on express, which this release has no standard for, and the new project's is on node-fastify: rewrite it there.",
        ),
      }),
    ]);
    rmSync(at("package.json"));
    expect((await migrate()).blocked).toEqual([
      "no backend this release supports was found; name the stack the new project has with --stack",
    ]);
  });

  it("blocks backends on several stacks until --stack picks one, and names the others", async () => {
    write("orders/pyproject.toml", PYPROJECT);
    write(
      "billing/go.mod",
      "module x\n\ngo 1.25\n\nrequire github.com/danielgtaylor/huma/v2 v2.34.1\n",
    );
    write("audit/pyproject.toml", PYPROJECT);
    const both = await migrate();
    expect(both.blocked).toEqual([
      "the project holds a backend on each of go-huma and python-fastapi (python-fastapi in audit, go-huma in billing, python-fastapi in orders); name the one the new project has with --stack",
    ]);
    const picked = await migrate({ stack: "python-fastapi" });
    expect(picked.blocked).toEqual([]);
    expect(picked.parts.map((part) => `${part.path}: ${part.note}`)).toEqual([
      expect.stringMatching(/^audit: The new project has one backend, and the old one holds 3/),
      expect.stringMatching(
        /^billing: .*It is on go-huma, and the new project's is on python-fastapi/,
      ),
      expect.stringMatching(/^orders: The new project has one backend/),
    ]);
  });

  it("blocks on a directory it could not tell, unless every kind of part is named", async () => {
    write("pyproject.toml", PYPROJECT);
    write("web/package.json", "{ not json");
    const unclear = await migrate();
    expect(unclear.blocked).toEqual([
      expect.stringContaining(
        "so a part may be there that Liftoff cannot see; name the new project's parts with --stack, --frontend and --infrastructure",
      ),
    ]);
    const named = await migrate({
      stack: "python-fastapi",
      frontend: "vue",
      infrastructure: "none",
    });
    expect(named.blocked).toEqual([]);
    expect(chosen(named)).toMatchObject({ frontend: "vue in frontend (option)" });
  });

  it("blocks a part the stack cannot have beside it, saying how to leave it out", async () => {
    write("pyproject.toml", PYPROJECT.replace('"fastapi>=0.115"', '"fastapi", "pydantic-ai"'));
    write("web/package.json", '{"name":"web","dependencies":{"vue":"^3.5.0"}}\n');
    const plan = await migrate();
    expect(plan.blocked).toEqual([
      expect.stringContaining(
        "leave that part out with --frontend none or --infrastructure none, and its copy stays in legacy/",
      ),
    ]);
    const without = await migrate({ frontend: "none" });
    expect(without.blocked).toEqual([]);
    expect(without.parts).toEqual([
      expect.objectContaining({ component: "backend", to: "backend" }),
      expect.objectContaining({
        path: "web",
        component: "frontend",
        note: "The new project has no frontend: keep it apart as its own project, or leave it out.",
      }),
    ]);
    expect(without.parts[1]?.to).toBeUndefined();
  });

  it("blocks when part of the project was not walked, or the copy would be too large", async () => {
    service();
    write("closed/notes.md", "secret plans\n");
    const closing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      listWithin: (directory: string, relative: string, max: number) =>
        relative === "closed"
          ? Promise.resolve({ kind: "inaccessible", via: "closed" })
          : fs.listWithin(directory, relative, max),
    });
    expect((await migrate({}, closing)).blocked).toEqual([
      "part of the project was not walked (closed: closed to this user), so the copy would miss it",
    ]);
    rmSync(at("closed"), { recursive: true });
    const limited = await planMigrate(
      { assets, fs },
      root,
      target,
      VERSION,
      {},
      where({
        limits: { entries: 5, directoryEntries: 5, depth: 12, reads: 300, bytes: 512 * 1024 },
      }),
    );
    expect(limited.blocked).toContainEqual(
      expect.stringMatching(
        /^part of the project was not walked \(\.: the walk stopped after 5 entries\)/,
      ),
    );
    // Each under the size of one file it copies, and over a gigabyte together.
    const parts: Record<string, number> = {};
    for (let index = 0; index < 20; index++) {
      write(`assets/part-${index}.bin`, "");
      parts[`assets/part-${index}.bin`] = 60 * 1024 * 1024;
    }
    const huge = await migrate({}, sized(parts));
    expect(huge.blocked).toEqual([
      "the copy would hold 1201 MiB, more than the 1 GiB Liftoff copies",
    ]);
    expect(huge.plan).toBeUndefined();
  });

  it("blocks when no name can be made, and on old records it cannot rely on", async () => {
    const odd = path.join(work, "123");
    mkdirSync(odd);
    writeFileSync(path.join(odd, "pyproject.toml"), PYPROJECT);
    const nameless = await planMigrate({ assets, fs }, odd, target, VERSION, {}, where());
    expect(nameless.blocked).toEqual([
      "the directory's name, 123, does not make a project name; give one with --name",
    ]);
    expect(
      isBlocked(await planMigrate({ assets, fs }, odd, target, VERSION, { name: "odd" }, where())),
    ).toBe(false);

    write("pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({ artifactVersion: 99, generatedBy: "Mission Control Liftoff" }),
    );
    expect((await migrate()).blocked).toEqual([
      expect.stringContaining(
        "liftoff.manifest.json, from a Liftoff release before the rebuild, is not a record migrating can rely on",
      ),
    ]);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    write(".liftoff/reviewed-update-transaction.json", "{}");
    expect((await migrate()).blocked).toEqual([
      expect.stringContaining(".liftoff/reviewed-update-transaction.json: "),
    ]);
  });

  it("carries over an old configuration's choices, and leaves the old records with the old project", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    write(
      "liftoff.config.json",
      JSON.stringify({ projectName: "legacy-shop", projectType: "standard", agents: ["claude"] }),
    );
    write("governance/credentials/token.json", "{}");
    write("governance/activation-state.json", '{"schemaVersion":3}');
    const plan = await migrate();
    expect(plan.blocked).toEqual([]);
    expect(chosen(plan)).toMatchObject({
      name: "legacy-shop (old configuration)",
      agents: "claude (old configuration)",
    });
    expect(plan.copies.map((copy) => copy.path)).toEqual(["backend/pyproject.toml"]);
    expect(plan.left.filter((item) => item.kind === "records").map((item) => item.path)).toEqual([
      "governance/activation-state.json",
      "governance/credentials",
      "liftoff.config.json",
      "liftoff.manifest.json",
    ]);
    await applyMigrate(fs, plan, { cwd: work });
    expect(made.read("MIGRATION.md")).toContain(
      "- Records from a Liftoff release before the rebuild (0.12.3): `governance/activation-state.json`, `governance/credentials`, `liftoff.config.json`, `liftoff.manifest.json`. They stay with `shop` as its history, and are not proof of anything about this project.",
    );
    expect(parseManifest(made.read(MANIFEST_FILE)).legacy).toBeUndefined();
  });
});

describe("MIGRATE-002 the copy leaves out secrets, dependencies, caches, state and build output", () => {
  it("copies the project's own files with their permissions, and names what it leaves out", async () => {
    service();
    if (process.platform !== "win32") chmodSync(at("app/main.py"), 0o750);
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-migrate-outside-"));
    try {
      writeFileSync(path.join(outside, "pyproject.toml"), PYPROJECT);
      symlinkSync(outside, at("linked"), "junction");
      const plan = await migrate();
      expect(plan.copies.map((copy) => copy.path)).toEqual([
        ".env.example",
        "README.md",
        "app/main.py",
        "pyproject.toml",
        "tests/test_main.py",
        "uv.lock",
      ]);
      expect(plan.left.map((item) => `${item.kind} ${item.path}`)).toEqual([
        "secrets .env",
        "git .git",
        "dependencies .venv",
        "secrets config/.env.local",
        "secrets deploy/key.pem",
        "dependencies dist",
        "link linked",
        "dependencies node_modules",
      ]);
      expect(plan.plan?.copies).toEqual(plan.copies);
      await applyMigrate(fs, plan, { cwd: work });
      const copied = readdirSync(made.at("legacy"), { recursive: true }).map(String).sort();
      expect(copied).not.toContain(".env");
      expect(copied).not.toContain("linked");
      expect(copied).not.toContain("node_modules");
      if (process.platform !== "win32") {
        expect(statSync(made.at("legacy/app/main.py")).mode & 0o777).toBe(0o750);
      }
      const checklist = made.read("MIGRATION.md");
      expect(checklist).toContain(
        "- [ ] Files that may hold secrets or state, never copied: `.env`, `config/.env.local`, `deploy/key.pem`.",
      );
      expect(checklist).toContain(
        "- [ ] Installed dependencies, caches and build output: `.venv`, `dist`, `node_modules`.",
      );
      expect(checklist).toContain("- [ ] Links and special files, never followed: `linked`.");
      expect(checklist).toContain("- Git's data: `.git`. The history stays with `shop`.");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves out a file over 64 MiB and a path not every system can hold", async () => {
    write("pyproject.toml", PYPROJECT);
    write("data/big.bin", "pretend this is large\n");
    write("docs/Notes.md", "notes\n");
    const extra: ProjectFsPort = Object.assign(
      Object.create(sized({ "data/big.bin": MAX_COPIED_BYTES + 1 })) as ProjectFsPort,
      {
        // As a volume that tells letter case apart, and one that allows any name, would list them.
        listWithin: async (directory: string, relative: string, max: number) => {
          const listing = await fs.listWithin(directory, relative, max);
          if (listing.kind !== "directory" || relative !== "docs") return listing;
          return {
            ...listing,
            entries: [
              ...listing.entries,
              { name: "nul.txt", kind: "file" as const },
              { name: "notes.md", kind: "file" as const },
            ].sort((a, b) => (a.name < b.name ? -1 : 1)),
          };
        },
      },
    );
    const plan = await migrate({}, extra);
    expect(plan.copies.map((copy) => copy.path)).toEqual(["docs/Notes.md", "pyproject.toml"]);
    expect(plan.left).toEqual([
      { path: "data/big.bin", kind: "large", why: "over 64 MiB" },
      {
        path: "docs/notes.md",
        kind: "name",
        why: "macOS and Windows take it for docs/Notes.md",
      },
      { path: "docs/nul.txt", kind: "name", why: expect.stringContaining("nul.txt") },
    ]);
  });

  it("refuses a saved plan once a file it copies changed, and creates nothing when one changes as it is copied", async () => {
    service();
    const plan = await migrate();
    const saved = plan.plan ?? fail();
    write("app/main.py", "changed\n");
    await expect(
      planMigrateFromSaved({ assets, fs }, saved, VERSION, { refused: [], cwd: work }),
    ).rejects.toThrow("the project changed since the plan was made");
    await expect(applyMigrate(fs, plan, { cwd: work })).rejects.toThrow(MigrateChangedError);
    await expect(applyMigrate(fs, plan, { cwd: work })).rejects.toThrow(
      "app/main.py changed since the migration was planned, so nothing was created; plan it again",
    );
    expect(readdirSync(work)).toEqual(["shop"]);
  });

  it("refuses a file that changed while the plan was being made", async () => {
    service();
    const vanishing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      hashWithin: (directory: string, relative: string, maxBytes: number) =>
        relative === "README.md"
          ? Promise.resolve({ kind: "missing" } satisfies FileHash)
          : fs.hashWithin(directory, relative, maxBytes),
    });
    await expect(migrate({}, vanishing)).rejects.toThrow(
      "README.md changed while migrating was being planned; plan it again",
    );
  });
});

describe("MIGRATE-003 a checklist says what to move, and the new project is checked", () => {
  it("lists where each part goes, what to compare and how to check the result", async () => {
    service();
    write("web/package.json", '{"name":"web","dependencies":{"react":"^19.0.0"}}\n');
    write(".github/workflows/ci.yml", "name: ci\n");
    write("AGENTS.md", "# ours\n");
    write(".claude/settings.json", "{}\n");
    const plan = await migrate();
    await applyMigrate(fs, plan, { cwd: work });
    const checklist = made.read("MIGRATION.md");
    for (const line of [
      "# Migrating shop",
      "  echo legacy/ >> .git/info/exclude",
      "- [ ] The backend on python-fastapi in `legacy/`: move it into `backend/`. Where the starter and the old code do the same thing, keep the starter's configuration, health checks and tests, and move the rest.",
      "  - `backend/app/`: the FastAPI application",
      "- [ ] The frontend on react in `legacy/web`: The new project has no frontend: keep it apart as its own project, or leave it out.",
      "- [ ] The old project's workflows, in `legacy/.github/workflows/`: Liftoff's own are in `.github/workflows/`. Carry over only what they do not do, as a reviewed change.",
      "- [ ] The old project's coding-agent instructions: `legacy/AGENTS.md`, `legacy/.claude/`. Carry what still applies into the new project's `AGENTS.md` and skills.",
      "- [ ] `liftoff validate` reports no problem.",
      "- [ ] In `backend`, the tests pass: `uv sync && uv run pytest`",
      "- [ ] Delete `legacy/` and this file, and commit.",
    ]) {
      expect(checklist).toContain(line);
    }
    // The same project and choices give the same checklist.
    rmSync(target, { recursive: true });
    expect((await migrate()).plan?.checklist).toEqual(plan.plan?.checklist);
  });

  it("moves each part of a monorepo into the new project's standard directories", async () => {
    write(
      "services/api/go.mod",
      "module example.com/api\n\ngo 1.25\n\nrequire github.com/danielgtaylor/huma/v2 v2.34.1\n",
    );
    write("web/package.json", '{"name":"web","dependencies":{"vue":"^3.5.0"}}\n');
    const lock = 'provider "registry.opentofu.org/hashicorp/azurerm" {\n  version = "4.0.0"\n}\n';
    write("infra/azure/environments/dev/main.tf", "terraform {}\n");
    write("infra/azure/environments/dev/.terraform.lock.hcl", lock);
    const plan = await migrate();
    expect(plan.blocked).toEqual([]);
    expect(chosen(plan)).toMatchObject({
      backend: "go-huma in backend (found)",
      frontend: "vue in frontend (found)",
      infrastructure: "azure in infrastructure/opentofu/azure (found)",
      environments: "dev, staging, prod (default)",
    });
    expect(plan.parts.map((part) => `${part.path} -> ${part.to}`)).toEqual([
      "services/api -> backend",
      "web -> frontend",
      "infra/azure/environments/dev -> infrastructure/opentofu/azure",
    ]);
    await applyMigrate(fs, plan, { cwd: work });
    const checklist = made.read("MIGRATION.md");
    expect(checklist).toContain(
      "- [ ] The frontend on vue in `legacy/web`: move it into `frontend/`.",
    );
    expect(checklist).toContain("  - `frontend/src/`: the Vue application and its unit tests");
    expect(checklist).toContain(
      "- [ ] The infrastructure on azure in `legacy/infra/azure/environments/dev`: move it into `infrastructure/opentofu/azure/`.",
    );
    expect(checklist).toContain(
      "  - `infrastructure/opentofu/azure/environments/`: one OpenTofu root per environment",
    );
  });

  it("says when nothing was found to move, and writes paths as code whatever they hold", async () => {
    write("docs/guide.md", "# guide\n");
    write("odd`name.txt", "x\n");
    write("`odd.pem", "key\n");
    const plan = await migrate({ stack: "python-fastapi" });
    expect(plan.parts).toEqual([]);
    await applyMigrate(fs, plan, { cwd: work });
    const checklist = made.read("MIGRATION.md");
    expect(checklist).toContain(
      "- [ ] Nothing in `shop` was found to move into the new project's parts. Build the application from its starter, using what `legacy/` holds.",
    );
    expect(made.read("legacy/odd`name.txt")).toBe("x\n");
    expect(checklist).toContain("never copied: `` `odd.pem ``.");
  });

  it("applies exactly a saved plan, and refuses one from another release or command", async () => {
    service();
    const plan = await migrate({ agents: ["claude"], governance: "team-gitflow" });
    const saved = parsePlan(JSON.stringify(plan.plan), "migrate");
    const again = await planMigrateFromSaved({ assets, fs }, saved, VERSION, {
      refused: [],
      cwd: work,
    });
    expect(again.plan?.hash).toBe(saved.hash);
    expect(again.config).toEqual(plan.config);
    await expect(
      planMigrateFromSaved({ assets, fs }, saved, "1.0.1", { refused: [], cwd: work }),
    ).rejects.toThrow("the plan was made by Liftoff 1.0.0, but this is 1.0.1; make a new plan");
    expect(() => parsePlan(JSON.stringify(plan.plan))).toThrow(
      "this plan is for liftoff migrate, not liftoff init; apply it with that command",
    );
    expect(() => parseChangePlan(JSON.stringify(plan.plan))).toThrow(
      "this plan creates a project; apply it with liftoff migrate --plan",
    );
    const init = { ...(plan.plan as Plan), operation: "init" };
    expect(() => parsePlan(JSON.stringify(init), "migrate")).toThrow(
      "this plan is for liftoff init, not liftoff migrate; apply it with that command",
    );
    // What only a migration holds, it must hold, and nothing else may.
    const { source: _, ...sourceless } = plan.plan as Plan;
    expect(() => parsePlan(JSON.stringify(sourceless), "migrate")).toThrow(PlanError);
  });

  it("leaves nothing when cancelled before the project is in place", async () => {
    service();
    const plan = await migrate();
    const controller = new AbortController();
    let copies = 0;
    const cancelling: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      copyWithin: (directory: string, relative: string, maxBytes: number, to: string) => {
        if (++copies === 2) controller.abort();
        return fs.copyWithin(directory, relative, maxBytes, to);
      },
    });
    await expect(
      applyMigrate(cancelling, plan, { cwd: work, signal: controller.signal }),
    ).rejects.toThrow();
    expect(readdirSync(work)).toEqual(["shop"]);
  });

  it("names what reading the new project back finds different", async () => {
    service();
    const plan = await migrate();
    const tampering: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      publish: async (staging: string, to: string) => {
        await fs.publish(staging, to);
        writeFileSync(path.join(to, "legacy", "README.md"), "edited\n");
        writeFileSync(path.join(to, "REVIEW.md"), "edited\n");
      },
    });
    const result = await applyMigrate(tampering, plan, { cwd: work });
    expect(result.differences).toEqual(
      expect.arrayContaining([
        "REVIEW.md is not as planned",
        "legacy/README.md is not as planned",
        expect.stringContaining("REVIEW.md"),
      ]),
    );
  });
});
