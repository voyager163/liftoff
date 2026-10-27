import { mkdirSync, mkdtempSync, promises, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import {
  type AdoptChoices,
  AdoptOptionError,
  type AdoptPlan,
  isBlocked,
  planAdopt,
  planAdoptFromSaved,
} from "../../src/application/adopt/adopt-project.ts";
import { applyChanges, ChangeError } from "../../src/application/change/apply-changes.ts";
import { ProjectChangeError } from "../../src/application/change/project-change.ts";
import type { FileHash, ProjectFsPort } from "../../src/application/ports.ts";
import { AssessError } from "../../src/application/project/assess-project.ts";
import { planRestore } from "../../src/application/repair/repair-project.ts";
import { planUpdate } from "../../src/application/update/update-project.ts";
import { PlanError } from "../../src/domain/plan/plan.ts";
import { CONFIG_FILE, parseConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { projectFiles, SKILL, sha } from "../helpers/older-project.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const VERSION = "1.0.0";

let work: string;
let root: string;
beforeEach(async () => {
  // As the CLI resolves it: macOS's /var is /private/var, and Windows may
  // give a short name.
  work = await promises.realpath(mkdtempSync(path.join(tmpdir(), "liftoff-adopt-")));
  root = path.join(work, "shop-api");
  mkdirSync(root);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const { at, write, read, snapshot } = projectFiles(() => root);

const PYPROJECT = `[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["fastapi>=0.115"]
`;

/** A FastAPI service at the repository root, set up for Claude Code. */
const service = () => {
  write("pyproject.toml", PYPROJECT);
  write("uv.lock", "version = 1\n");
  write("app/main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");
  write("tests/test_main.py", "def test_ok():\n    pass\n");
  write("AGENTS.md", "# Our own instructions\n");
  write("CLAUDE.md", "@AGENTS.md\n");
  write(".gitignore", ".venv/\n");
  write("README.md", "# shop\n");
};

/** A Go API, a Vue frontend and Azure infrastructure, each in its own directory. */
const monorepo = () => {
  write(
    "services/api/go.mod",
    "module example.com/api\n\ngo 1.25\n\nrequire github.com/danielgtaylor/huma/v2 v2.34.1\n",
  );
  write("services/api/go.sum", "");
  write("web/package.json", '{"name":"web","dependencies":{"vue":"^3.5.0"}}\n');
  write("web/package-lock.json", "{}\n");
  const lock = 'provider "registry.opentofu.org/hashicorp/azurerm" {\n  version = "4.0.0"\n}\n';
  for (const root of ["bootstrap", "environments/dev"]) {
    write(`infra/azure/${root}/main.tf`, "terraform {}\n");
    write(`infra/azure/${root}/.terraform.lock.hcl`, lock);
  }
};

const adopt = (choices: AdoptChoices = {}) =>
  planAdopt({ assets, fs }, root, VERSION, choices, { named: true, refused: [] });

const changePorts = {
  fs,
  processes: {
    pid: process.pid,
    host: "test-host",
    isRunning: (pid: number) => pid === process.pid,
  },
  now: () => "2026-10-27T12:00:00Z",
};
const apply = (plan: AdoptPlan) => {
  if (plan.plan === undefined) throw new Error(`blocked: ${plan.blocked.join("; ")}`);
  return applyChanges(changePorts, plan.plan, plan.contents);
};
const chosen = (plan: AdoptPlan) =>
  Object.fromEntries(
    plan.proposal.map(({ choice, value, from }) => [choice, `${value} (${from})`]),
  );
const of = (plan: AdoptPlan, step: "add" | "kept") =>
  plan.files.filter((file) => file.step === step).map((file) => file.path);

describe("ADOPT-001 adopting proposes what the project is, from what it holds", () => {
  it("binds a FastAPI application at the repository root, and the hosts it is set up for", async () => {
    service();
    const plan = await adopt();
    expect(plan.blocked).toEqual([]);
    expect(chosen(plan)).toEqual({
      name: "shop-api (directory name)",
      backend: "python-fastapi in . (found)",
      frontend: "none (found)",
      infrastructure: "none (found)",
      workflow: "manual (default)",
      agents: "claude (found)",
      governance: "single-maintainer-gitflow (default)",
      "AI review": "on (default)",
    });
    expect(plan.proposal.find((proposed) => proposed.choice === "backend")?.evidence).toEqual([
      "pyproject.toml",
    ]);
    expect(plan.config).toMatchObject({
      name: "shop-api",
      workload: "api",
      stack: "python-fastapi",
      workflow: "manual",
      agents: ["claude"],
      layout: { backend: "." },
    });
  });

  it("finds each part in its own directory, and takes the options over what it finds", async () => {
    monorepo();
    const found = await adopt();
    expect(found.blocked).toEqual([]);
    expect(found.config).toMatchObject({
      stack: "go-huma",
      frontend: "vue",
      infrastructure: "azure",
      environments: ["dev", "staging", "prod"],
      layout: { backend: "services/api", frontend: "web", infrastructure: "infra/azure" },
    });
    const chosenByOptions = await adopt({
      name: "storefront",
      agents: ["copilot"],
      governance: "team-gitflow",
      owners: ["alice", "bob"],
      aiReview: "off",
      infrastructure: "none",
    });
    expect(chosen(chosenByOptions)).toMatchObject({
      name: "storefront (option)",
      agents: "copilot (option)",
      governance: "team-gitflow (option)",
      infrastructure: "none (option)",
      "AI review": "off (option)",
    });
    expect(chosenByOptions.config).toMatchObject({
      infrastructure: "none",
      environments: [],
      owners: ["alice", "bob"],
      review: { ai: false },
    });
    expect((await adopt({ environments: ["dev", "prod"] })).config?.environments).toEqual([
      "dev",
      "prod",
    ]);
    // What only an option chose is the option's problem, not the project's.
    for (const [choices, message] of [
      [{ infrastructure: "none", environments: ["dev"] }, "environments need infrastructure"],
      [{ agents: ["gemini"] }, "gemini"],
      [{ environments: ["qa"] }, "qa"],
      [{ owners: ["bad!login"] }, "an option is invalid: owners"],
      [{ name: "Store Front" }, "an option is invalid: name"],
      [{ agents: ["copilot"], reviewEngine: "claude" }, "claude"],
    ] as const) {
      await expect(adopt(choices), message).rejects.toThrow(AdoptOptionError);
      await expect(adopt(choices)).rejects.toThrow(message);
    }
    expect(chosenByOptions.others).toContainEqual({
      path: "infra/azure",
      component: "infrastructure",
      stack: "azure",
      reason: "left out with --infrastructure none",
    });
  });

  it("carries over only what an old configuration says this release has", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    const old = (fields: Record<string, unknown>) =>
      write(
        "liftoff.config.json",
        JSON.stringify({ projectName: "legacy-shop", projectType: "standard", ...fields }),
      );
    old({ agents: ["claude"], governanceProfile: "risk-tiered-gitflow", environments: ["dev"] });
    expect(chosen(await adopt())).toMatchObject({
      name: "legacy-shop (old configuration)",
      agents: "claude (old configuration)",
      governance: "risk-tiered-gitflow (old configuration)",
    });
    // A value this release does not have is not carried over, nor guessed at.
    old({ agents: ["claude", "gemini"], governanceProfile: "enterprise" });
    expect(chosen(await adopt())).toMatchObject({
      name: "legacy-shop (old configuration)",
      agents: "none (default)",
      governance: "single-maintainer-gitflow (default)",
    });
  });

  it("keeps the workflow manual, and a framework's files the project's", async () => {
    service();
    write("openspec/project.md", "# Specs\n");
    const plan = await adopt();
    expect(plan.config?.workflow).toBe("manual");
    expect(
      plan.files.map((file) => file.path).filter((file) => file.startsWith("openspec")),
    ).toEqual([]);
  });

  it("refuses a project Liftoff already has, a change not finished, and a directory not named", async () => {
    service();
    write(CONFIG_FILE, "schema: liftoff.config/v1\n");
    await expect(adopt()).rejects.toThrow(
      "liftoff.yaml is already here, so this is a Liftoff project",
    );
    rmSync(at(CONFIG_FILE));
    write(".liftoff/change-journal.json", "");
    await expect(adopt()).rejects.toThrow(ProjectChangeError);
    rmSync(at(".liftoff"), { recursive: true });
    await expect(
      planAdopt({ assets, fs }, root, VERSION, {}, { named: false, refused: [] }),
    ).rejects.toThrow(AssessError);
    await expect(
      planAdopt({ assets, fs }, root, VERSION, {}, { named: true, refused: [root] }),
    ).rejects.toThrow(AssessError);
  });
});

describe("ADOPT-002 a part it cannot place blocks adopting", () => {
  it("asks which of two backends to adopt, and leaves the other as it is", async () => {
    write("orders/pyproject.toml", PYPROJECT);
    write("billing/pyproject.toml", PYPROJECT);
    const two = await adopt();
    expect(two.plan).toBeUndefined();
    expect(two.blocked).toEqual([
      "2 directories hold a backend (python-fastapi in billing, python-fastapi in orders); name the one to adopt with --layout backend=<directory>",
    ]);
    const one = await adopt({ layout: { backend: "orders" } });
    expect(isBlocked(one)).toBe(false);
    expect(one.config?.layout).toEqual({ backend: "orders" });
    expect(one.others).toEqual([
      {
        path: "billing",
        component: "backend",
        stack: "python-fastapi",
        reason: "another backend is adopted",
      },
    ]);
  });

  it("blocks a part that is not where an option names it", async () => {
    service();
    expect((await adopt({ layout: { backend: "api" } })).blocked).toEqual([
      "no backend this release supports is in api",
    ]);
    expect((await adopt({ stack: "go-huma" })).blocked).toEqual([
      "--stack go-huma names a backend, but none on go-huma was found; name its directory with --layout backend=<directory>",
    ]);
    expect((await adopt({ layout: { backend: "." }, stack: "node-fastify" })).blocked).toEqual([
      ". holds a backend on python-fastapi, not on node-fastify",
    ]);
    write("tools/package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    expect((await adopt({ layout: { backend: "tools" } })).blocked).toEqual([
      "tools holds an application on express, not a backend this release supports",
    ]);
    expect((await adopt({ frontend: "none", layout: { frontend: "web" } })).blocked).toEqual([
      "--layout binds the frontend, but --frontend none leaves it out",
    ]);
  });

  it("blocks when it cannot tell what a directory holds, unless every part is named", async () => {
    service();
    write("worker/pyproject.toml", "[project\n");
    const unclear = await adopt();
    expect(unclear.blocked).toEqual([
      expect.stringMatching(
        /^could not tell what worker holds: worker\/pyproject.toml is not valid TOML, so a part may be there that Liftoff cannot see; name every part with --layout/,
      ),
    ]);
    const named = await adopt({
      layout: { backend: "." },
      frontend: "none",
      infrastructure: "none",
    });
    expect(isBlocked(named)).toBe(false);
  });

  it("blocks a part the backend's stack cannot have, saying how to leave it out", async () => {
    write("api/pyproject.toml", PYPROJECT.replace('"fastapi>=0.115"', '"fastapi", "pydantic-ai"'));
    write("web/package.json", '{"dependencies":{"vue":"^3.5.0"}}\n');
    const plan = await adopt();
    expect(plan.blocked).toEqual([
      expect.stringMatching(
        /^the vue frontend is not available for genai projects.*; leave that part out with --frontend none or --infrastructure none, and it stays the project's own$/,
      ),
    ]);
    const without = await adopt({ frontend: "none" });
    expect(isBlocked(without)).toBe(false);
    expect(without.config).toMatchObject({ stack: "python-pydanticai", pattern: "generic" });
  });

  it("blocks parts that cannot be bound where they are, and a name it cannot make", async () => {
    write("web/package.json", '{"dependencies":{"vue":"^3.5.0"}}\n');
    write("web/api/pyproject.toml", PYPROJECT);
    expect((await adopt()).blocked).toEqual([
      "the proposal is invalid: layout: backend is inside frontend's directory",
    ]);
    rmSync(at("web"), { recursive: true });
    const numbered = path.join(work, "2024");
    mkdirSync(numbered);
    writeFileSync(path.join(numbered, "pyproject.toml"), PYPROJECT);
    const unnamed = await planAdopt(
      { assets, fs },
      numbered,
      VERSION,
      {},
      {
        named: true,
        refused: [],
      },
    );
    expect(unnamed.blocked).toEqual([
      "the directory's name, 2024, does not make a project name; give one with --name",
    ]);
    expect(
      isBlocked(
        await planAdopt(
          { assets, fs },
          numbered,
          VERSION,
          { name: "archive" },
          {
            named: true,
            refused: [],
          },
        ),
      ),
    ).toBe(false);
  });

  it("says the project is unsupported when no backend this release has is there", async () => {
    write("package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    const plan = await adopt();
    expect(plan.unsupported).toBe(true);
    expect(plan.blocked).toEqual([
      "no backend this release supports was found: the project holds express in ., which this release has no stack for",
    ]);
    rmSync(at("package.json"));
    expect((await adopt()).blocked).toEqual([
      "no backend this release supports was found: no pyproject.toml that depends on FastAPI, package.json that depends on Fastify, or go.mod that requires Huma",
    ]);
  });

  it("blocks on an old record it does not recognize, or an old change not finished", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 9,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.13.0",
      }),
    );
    expect((await adopt()).blocked).toEqual([
      expect.stringMatching(
        /^liftoff\.manifest\.json, from a Liftoff release before the rebuild, is not a record adopting can rely on \(newer than any release before the rebuild wrote/,
      ),
    ]);
    rmSync(at("liftoff.manifest.json"));
    write(".liftoff/reviewed-update-transaction.json", "{}");
    expect((await adopt()).blocked).toEqual([
      expect.stringMatching(
        /^\.liftoff\/reviewed-update-transaction\.json: the old release stopped part way/,
      ),
    ]);
  });
});

describe("ADOPT-003 adopting adds Liftoff's own files, never over the project's", () => {
  it("adds only Liftoff's files, keeps the project's, and lists the application's changes", async () => {
    service();
    const before = snapshot();
    const plan = await adopt();
    expect(of(plan, "kept")).toEqual([".gitignore", "AGENTS.md", "CLAUDE.md"]);
    expect(plan.files.find((file) => file.path === "AGENTS.md")?.reason).toBe(
      "the project has a file there",
    );
    const added = of(plan, "add");
    expect(added).toEqual(
      expect.arrayContaining([
        CONFIG_FILE,
        ".github/workflows/01-pr-ci.yml",
        ".github/review-policy.yml",
        SKILL("liftoff-adopt"),
        "GOVERNANCE.md",
      ]),
    );
    // None of the application's files, which are its own.
    expect(
      added.filter((file) => /^(app|tests|backend)\/|^(README\.md|compose\.yaml)$/.test(file)),
    ).toEqual([]);
    expect(plan.application.map((change) => change.check)).toEqual([
      "tests.coverage-gate",
      "build.container",
      "liftoff.ignored",
    ]);
    expect(plan.application.at(-1)).toMatchObject({
      message:
        ".gitignore does not list .liftoff/governance.lock, .liftoff/change-journal.json, .liftoff/change.lock, which Liftoff writes only while one of its commands runs",
    });
    // The change rests on the declaration the backend was found from.
    expect(plan.plan?.unchanged).toEqual([{ path: "pyproject.toml", sha256: sha(PYPROJECT) }]);

    await apply(plan);
    const after = snapshot();
    for (const [file, bytes] of Object.entries(before)) expect(after[file], file).toBe(bytes);
    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.history).toEqual([{ operation: "adopt", liftoff: VERSION }]);
    expect(manifest.kept).toEqual([".gitignore", "AGENTS.md", "CLAUDE.md"]);
    expect(manifest.files.map((file) => file.path).sort()).toEqual(added.sort());
    expect(parseConfig(read(CONFIG_FILE)).layout).toEqual({ backend: "." });
    expect(read(".github/workflows/01-pr-ci.yml")).toContain("working-directory: .\n");
  });

  it("never records a file the project had as Liftoff's, even one the same as Liftoff's", async () => {
    service();
    const editorconfig = (await adopt()).contents.get(".editorconfig")?.content ?? "";
    write(".editorconfig", editorconfig);
    // Another name for AGENTS.md, as macOS and Windows compare names.
    rmSync(at("AGENTS.md"));
    write("agents.md", "# lower case\n");
    const plan = await adopt();
    expect(of(plan, "kept")).toEqual(expect.arrayContaining([".editorconfig", "AGENTS.md"]));
    await apply(plan);
    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.files.map((file) => file.path)).not.toContain(".editorconfig");
    expect(manifest.kept).toEqual(expect.arrayContaining([".editorconfig", "AGENTS.md"]));
  });

  it("takes .gitignore lines written from the root, or all of .liftoff, as listed", async () => {
    service();
    const listed = async () =>
      (await adopt()).application.filter((change) => change.check === "liftoff.ignored");
    write(".gitignore", "/.liftoff/change.lock\n/.liftoff/change-journal.json\n");
    expect((await listed())[0]?.message).toMatch(
      /^\.gitignore does not list \.liftoff\/governance\.lock,/,
    );
    write(
      ".gitignore",
      "/.liftoff/change.lock\n.liftoff/change-journal.json\n.liftoff/governance.lock\n",
    );
    expect(await listed()).toEqual([]);
    write(".gitignore", ".liftoff/\n");
    expect(await listed()).toEqual([]);
  });

  it("keeps whatever is, or may be, where a file of Liftoff's would go", async () => {
    service();
    rmSync(at("CLAUDE.md"));
    mkdirSync(at("REVIEW.md"));
    // Links and closed directories, as the file system port reports them.
    const seen = (overrides: Record<string, FileHash>): ProjectFsPort =>
      Object.assign(Object.create(fs) as ProjectFsPort, {
        hashWithin: (directory: string, relative: string, maxBytes: number) =>
          overrides[relative] ?? fs.hashWithin(directory, relative, maxBytes),
      });
    const port = seen({
      "CLAUDE.md": { kind: "other" },
      ".github/workflows/01-pr-ci.yml": { kind: "inaccessible", via: ".github" },
    });
    const plan = await planAdopt(
      { assets, fs: port },
      root,
      VERSION,
      { agents: ["claude"] },
      {
        named: true,
        refused: [],
      },
    );
    const reasons = Object.fromEntries(
      plan.files.filter((file) => file.step === "kept").map((file) => [file.path, file.reason]),
    );
    expect(reasons).toMatchObject({
      "REVIEW.md": "the project has a directory there",
      "CLAUDE.md":
        "a link or another kind of file is there or on the way to it, which Liftoff does not follow",
      ".github/workflows/01-pr-ci.yml":
        "a directory on the way to it is closed to this user, so whether something is there cannot be told",
    });
    expect(plan.plan?.changes.map((change) => change.path)).not.toContain("REVIEW.md");
    // Liftoff's own records must be added, so anything there blocks adopting.
    const linked = await planAdopt(
      { assets, fs: seen({ [CONFIG_FILE]: { kind: "other" } }) },
      root,
      VERSION,
      {},
      { named: true, refused: [] },
    );
    expect(linked.plan).toBeUndefined();
    expect(linked.blocked).toEqual([
      "liftoff.yaml cannot be added: a link or another kind of file is there or on the way to it, which Liftoff does not follow",
    ]);
  });

  it("changes nothing when a declaration it rests on changed before it applies", async () => {
    service();
    const plan = await adopt();
    write("pyproject.toml", PYPROJECT.replace("fastapi", "flask"));
    const before = snapshot();
    await expect(apply(plan)).rejects.toThrow(ChangeError);
    expect(snapshot()).toEqual(before);
  });

  it("lists infrastructure laid out otherwise than Liftoff's CI validates", async () => {
    monorepo();
    rmSync(at("infra/azure/bootstrap"), { recursive: true });
    const plan = await adopt();
    expect(plan.config?.layout.infrastructure).toBe("infra/azure/environments/dev");
    expect(plan.application).toContainEqual({
      check: "infrastructure.roots",
      status: "noncompliant",
      subject: "infrastructure at infra/azure/environments/dev",
      message:
        "Liftoff's CI validates the OpenTofu roots in infra/azure/environments/dev/bootstrap and each infra/azure/environments/dev/environments/<environment>, and infra/azure/environments/dev/bootstrap and infra/azure/environments/dev/environments are not there",
      next: "Move the roots there, or leave the infrastructure out with --infrastructure none.",
    });
  });

  it("is then updated and repaired where its parts live, never with an application's files", async () => {
    monorepo();
    write("AGENTS.md", "# Ours\n");
    await apply(await adopt({ agents: ["claude"] }));
    const update = await planUpdate({ assets, fs }, root, VERSION);
    expect(update.plan).toBeUndefined();
    expect(update.files).toEqual([]);
    rmSync(at(SKILL("liftoff-verify")));
    const repair = await planRestore({ assets, fs }, root, VERSION, {
      restore: new Set([SKILL("liftoff-verify")]),
    });
    expect(repair.files.map((file) => `${file.step} ${file.path}`)).toEqual([
      `restore ${SKILL("liftoff-verify")}`,
    ]);
    await applyChanges(changePorts, repair.plan ?? fail(), repair.contents, {});
    expect(read(".github/workflows/01-pr-ci.yml")).toContain("working-directory: services/api\n");
  });
});

describe("ADOPT-004 records from before the rebuild stay the project's, byte for byte", () => {
  it("keeps the old records as they are, and records them in the manifest", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    const oldManifest = JSON.stringify({
      artifactVersion: 7,
      generatedBy: "Mission Control Liftoff",
      liftoffVersion: "0.12.3",
    });
    const oldConfig = JSON.stringify({ projectName: "legacy-shop", projectType: "standard" });
    write("liftoff.manifest.json", oldManifest);
    write("liftoff.config.json", oldConfig);
    write(".liftoff/governance/handoff.json", "{}");
    write("governance/credentials/token.json", "{}");
    const plan = await adopt();
    expect(plan.legacy.map((record) => record.path)).toEqual([
      "liftoff.manifest.json",
      "liftoff.config.json",
      ".liftoff/governance",
      "governance/credentials",
    ]);
    const before = snapshot();
    await apply(plan);
    const after = snapshot();
    for (const file of [
      "liftoff.manifest.json",
      "liftoff.config.json",
      ".liftoff/governance/handoff.json",
      "governance/credentials/token.json",
    ]) {
      expect(after[file], file).toBe(before[file]);
    }
    expect(parseManifest(read(MANIFEST_FILE)).legacy).toEqual({
      release: "0.12.3",
      records: [
        { path: ".liftoff/governance", record: "governance-handoff", state: "readable" },
        { path: "governance/credentials", record: "credential-records", state: "readable" },
        {
          path: "liftoff.config.json",
          record: "config",
          state: "migratable",
          format: "configuration",
          sha256: sha(oldConfig),
        },
        {
          path: "liftoff.manifest.json",
          record: "manifest",
          state: "migratable",
          format: "manifest v7",
          sha256: sha(oldManifest),
        },
      ],
    });
  });

  it("never takes what an old record holds for a part of the project", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    write("governance/credentials/package.json", '{"dependencies":{"fastify":"^5.0.0"}}');
    write(".liftoff/repair-history/r1/pyproject.toml", PYPROJECT);
    const plan = await adopt();
    expect(plan.blocked).toEqual([]);
    expect(plan.config?.layout).toEqual({});
    expect(plan.others).toEqual([]);
  });

  it("changes nothing when an old record it records changed before it applies", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.manifest.json",
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    const plan = await adopt();
    write("liftoff.manifest.json", "{}");
    await expect(apply(plan)).rejects.toThrow(ChangeError);
    expect(snapshot()[MANIFEST_FILE]).toBeUndefined();
  });
});

describe("ADOPT-003 the adoption rests on exactly what was assessed", () => {
  it("refuses a declaration that changed after it was read, before it was hashed", async () => {
    service();
    let edited = false;
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      hashWithin: (directory: string, relative: string, maxBytes: number) => {
        // Edited by something else after the assessment read it.
        if (relative === "pyproject.toml" && !edited) {
          edited = true;
          write("pyproject.toml", PYPROJECT.replace("fastapi>=0.115", "fastapi>=0.116"));
        }
        return fs.hashWithin(directory, relative, maxBytes);
      },
    });
    await expect(
      planAdopt({ assets, fs: port }, root, VERSION, {}, { named: true, refused: [] }),
    ).rejects.toThrow(
      "pyproject.toml changed while adopting was being planned, or is not UTF-8 text; plan it again",
    );
  });

  it("refuses an old configuration that changed after it was found migratable", async () => {
    write("backend/pyproject.toml", PYPROJECT);
    write(
      "liftoff.config.json",
      JSON.stringify({ projectName: "legacy-shop", projectType: "standard" }),
    );
    let reads = 0;
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      readWithin: (directory: string, relative: string, maxBytes: number) => {
        if (relative === "liftoff.config.json" && ++reads === 2) {
          write("liftoff.config.json", JSON.stringify({ projectName: "other", projectType: "x" }));
        }
        return fs.readWithin(directory, relative, maxBytes);
      },
    });
    await expect(
      planAdopt({ assets, fs: port }, root, VERSION, {}, { named: true, refused: [] }),
    ).rejects.toThrow("liftoff.config.json changed while adopting was being planned");
  });
});

describe("ADOPT-005 adopting applies exactly what was approved", () => {
  it("refuses a saved plan once a declaration it rests on changed, even keeping its stack", async () => {
    service();
    const saved = (await adopt()).plan ?? fail();
    write("pyproject.toml", PYPROJECT.replace("fastapi>=0.115", "fastapi>=0.116"));
    const before = snapshot();
    await expect(
      planAdoptFromSaved({ assets, fs }, saved, VERSION, { refused: [] }),
    ).rejects.toThrow("the project changed since the plan was made");
    // Nor does the saved plan itself apply.
    const contents = (await adopt()).contents;
    await expect(applyChanges(changePorts, saved, contents)).rejects.toThrow(ChangeError);
    expect(snapshot()).toEqual(before);
  });

  it("plans a saved adoption again, and refuses it once the project changed", async () => {
    service();
    const plan = await adopt({ agents: ["copilot"], governance: "team-gitflow" });
    const saved = plan.plan ?? fail();
    const again = await planAdoptFromSaved({ assets, fs }, saved, VERSION, { refused: [] });
    expect(again.plan?.hash).toBe(saved.hash);
    write("Dockerfile", "FROM scratch\n");
    write(".github/workflows/01-pr-ci.yml", "name: ours\n");
    await expect(
      planAdoptFromSaved({ assets, fs }, saved, VERSION, { refused: [] }),
    ).rejects.toThrow("the project changed since the plan was made");
    await expect(
      planAdoptFromSaved({ assets, fs }, saved, "2.0.0", { refused: [] }),
    ).rejects.toThrow("the plan was made by Liftoff 1.0.0, but this is 2.0.0");
    await expect(
      planAdoptFromSaved({ assets, fs }, { ...saved, operation: "update" }, VERSION, {
        refused: [],
      }),
    ).rejects.toThrow(PlanError);
  });
});

function fail(): never {
  throw new Error("expected a plan");
}
