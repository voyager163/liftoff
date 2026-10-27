import { describe, expect, it } from "vitest";
import { commandName } from "../../src/cli/command.ts";
import { REGISTRY } from "../../src/cli/registry.ts";
import {
  composeImages,
  lockedProviders,
  pinned,
  readGoMod,
  readPackageJson,
  readPyproject,
  readWorkflow,
} from "../../src/domain/assess/declarations.ts";
import {
  type Assessment,
  assess,
  type GitHubState,
  type LiftoffState,
} from "../../src/domain/assess/standard.ts";
import {
  type Declaration,
  type EntryKind,
  filesUnder,
  type Gap,
  holdsSecretsOrState,
  isDeclaration,
  presence,
  type Tree,
} from "../../src/domain/assess/tree.ts";

/**
 * A walked project: each file with its text (declarations are read), and
 * every directory listed unless a gap says otherwise.
 */
function tree(
  files: Record<string, string>,
  options: {
    gaps?: Gap[];
    unlisted?: string[];
    other?: string[];
    unread?: Record<string, Declaration>;
  } = {},
): Tree {
  const entries = new Map<string, EntryKind>();
  const listed = new Set<string>(["."]);
  const declarations = new Map<string, Declaration>();
  const add = (file: string, kind: EntryKind) => {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join("/");
      entries.set(directory, "directory");
      listed.add(directory);
    }
    entries.set(file, kind);
  };
  for (const [file, text] of Object.entries(files)) {
    add(file, "file");
    if (isDeclaration(file)) declarations.set(file, { text });
  }
  for (const file of options.other ?? []) add(file, "other");
  for (const directory of options.unlisted ?? []) {
    entries.set(directory, "directory");
    listed.delete(directory);
  }
  for (const [file, declaration] of Object.entries(options.unread ?? {})) {
    add(file, "file");
    declarations.set(file, declaration);
  }
  return { entries, listed, declarations, gaps: options.gaps ?? [] };
}

const NONE: LiftoffState = { kind: "none", findings: [] };
const NOT_LIVE: GitHubState = { kind: "not-requested" };
const run = (walked: Tree, github: GitHubState = NOT_LIVE, liftoff: LiftoffState = NONE) =>
  assess(walked, { git: true, liftoff, github });
const lines = (assessment: Assessment) =>
  assessment.findings.map(
    (finding) =>
      `${finding.status} ${finding.check}${finding.subject ? ` ${finding.subject}` : ""}`,
  );

const FASTAPI = '[project]\nname = "api"\ndependencies = ["fastapi"]\n';
const PINNED = "actions/checkout@0123456789abcdef0123456789abcdef01234567";

describe("ASSESS-001 only declarations are read, and secrets are never", () => {
  it.each([
    ["pyproject.toml", true],
    ["backend/package.json", true],
    ["svc/go.mod", true],
    ["compose.yaml", true],
    ["docker-compose.yml", true],
    ["infra/.terraform.lock.hcl", true],
    ["frontend/vitest.config.mts", true],
    [".github/workflows/ci.yml", true],
    [".github/workflows/nested/ci.yml", false],
    [".github/liftoff/review-agent/package.json", false],
    [".github/dependabot.yml", false],
    ["src/main.py", false],
    [".env", false],
    ["README.md", false],
  ])("%s is read: %s", (file, expected) => {
    expect(isDeclaration(file)).toBe(expected);
  });

  it.each([
    [".env", true],
    ["backend/.env.local", true],
    [".env.example", false],
    ["infra/terraform.tfstate", true],
    ["infra/terraform.tfstate.backup", true],
    ["infra/prod.tfvars", true],
    ["infra/terraform.tfvars.example", false],
    ["certs/server.key", true],
    ["certs/server.PEM", true],
    ["id_ed25519", true],
    [".npmrc", true],
    ["main.tf", false],
  ])("%s may hold secrets or state: %s", (file, expected) => {
    expect(holdsSecretsOrState(file)).toBe(expected);
  });
});

describe("ASSESS-003 reading declarations without running them", () => {
  it("reads every dependency list in a pyproject.toml, and nothing else", () => {
    const project = readPyproject(`
[project]
name = "fastapi-service" # mentions fastapi, but is not a dependency
description = "uses sqlalchemy"
requires-python = ">=3.14"
dependencies = [
  "Pydantic_AI[openai]>=2",  # a comment with "alembic"
  'psycopg[binary]',
]

[project.optional-dependencies]
docs = ["mkdocs"]

[dependency-groups]
dev = ["pytest>=8", "pytest-cov"]

[tool.uv]
dev-dependencies = ["ruff"]

[tool.poetry.dependencies]
python = "^3.14"
FastAPI = "^0.1"

[tool.poetry.group.test.dependencies]
hypothesis = "*"

[tool.coverage.report]
fail_under = 80
`);
    expect([...(project?.dependencies ?? [])].sort()).toEqual([
      "fastapi",
      "hypothesis",
      "mkdocs",
      "psycopg",
      "pydantic-ai",
      "pytest",
      "pytest-cov",
      "ruff",
    ]);
    expect(project).toMatchObject({ requiresPython: true, coverageGate: true });
    expect(project?.workspace).toBeUndefined();
    expect(readPyproject("[project]\ndependencies = []\n")).toMatchObject({
      requiresPython: false,
      coverageGate: false,
    });
    expect(readPyproject('[tool.poetry.dependencies]\npython = "^3.12"\n')).toMatchObject({
      requiresPython: true,
      dependencies: new Set(),
    });
    expect(
      readPyproject('[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/old"]\n')
        ?.workspace,
    ).toEqual({ members: ["packages/*"], exclude: ["packages/old"] });
    expect(readPyproject("[tool.coverage.report]\nfail_under = 0\n")?.coverageGate).toBe(false);
    expect(
      readPyproject('[tool.pytest.ini_options]\naddopts = ["--cov", "--cov-fail-under=80"]\n')
        ?.coverageGate,
    ).toBe(true);
    // Not TOML, even with a dependency that would otherwise be read.
    expect(readPyproject('[project]\ndependencies = ["fastapi"]\nbroken = [\n')).toBeUndefined();
    expect(readPyproject("not = toml = at all")).toBeUndefined();
  });

  it("reads a package.json, or refuses what is not a JSON object", () => {
    expect(readPackageJson("{ nope")).toBeUndefined();
    expect(readPackageJson("[]")).toBeUndefined();
    expect(readPackageJson("null")).toBeUndefined();
    const json = readPackageJson(
      JSON.stringify({
        dependencies: { fastify: "5" },
        devDependencies: { vitest: "4" },
        engines: { node: ">=26" },
        workspaces: ["packages/*"],
        jest: { coverageThreshold: { global: { lines: 80 } } },
      }),
    );
    expect([...(json?.dependencies ?? [])]).toEqual(["fastify", "vitest"]);
    expect(json).toMatchObject({
      engine: true,
      workspace: { members: ["packages/*"], exclude: [] },
      coverageGate: true,
    });
    expect(readPackageJson('{"dependencies": [], "jest": {"coverageThreshold": {}}}')).toEqual({
      dependencies: new Set(),
      engine: false,
      coverageGate: false,
    });
    expect(
      readPackageJson('{"workspaces": {"packages": ["apps/*", "!apps/legacy"]}}')?.workspace,
    ).toEqual({ members: ["apps/*"], exclude: ["apps/legacy"] });
  });

  it("reads a go.mod's go version and requirements", () => {
    const module = readGoMod(`module example.com/api

go 1.26 // the language version

require github.com/danielgtaylor/huma/v2 v2.30.0
require (
\tgithub.com/jackc/pgx/v5 v5.7.0
\t// a comment
\tgithub.com/pressly/goose/v3 v3.24.0 // indirect
)
`);
    expect(module).toEqual({
      goVersion: true,
      requires: [
        "github.com/danielgtaylor/huma/v2",
        "github.com/jackc/pgx/v5",
        "github.com/pressly/goose/v3",
      ],
    });
    expect(readGoMod("module x\n")?.goVersion).toBe(false);
    // Not a go.mod: no module, a block left open, or a requirement without a version.
    expect(readGoMod("go 1.26\n")).toBeUndefined();
    expect(
      readGoMod("module x\nrequire (\n\tgithub.com/danielgtaylor/huma/v2 v2.0.0\n"),
    ).toBeUndefined();
    expect(readGoMod("module x\nrequire github.com/danielgtaylor/huma/v2\n")).toBeUndefined();
    expect(readGoMod("module x\nreplace (\n\ta => b\n)\n")).toEqual({
      requires: [],
      goVersion: false,
    });
  });

  it("reads a workflow's triggers, jobs and actions", () => {
    expect(readWorkflow("on: pull_request\njobs: {}\n")?.onPullRequest).toBe(true);
    expect(readWorkflow("on: [push, pull_request]\njobs: {}\n")?.onPullRequest).toBe(true);
    expect(readWorkflow("on:\n  push: {}\njobs: {}\n")?.onPullRequest).toBe(false);
    expect(readWorkflow("true:\n  pull_request: {}\n")?.onPullRequest).toBe(true);
    expect(readWorkflow("on: [\n")).toBeUndefined();
    expect(readWorkflow("just text")).toBeUndefined();
    const workflow = readWorkflow(`
on: pull_request
jobs:
  test:
    steps:
      - uses: ${PINNED}
      - run: echo hi
      - uses: ./.github/actions/local
  shared:
    uses: octo/repo/.github/workflows/x.yml@main
  odd: 3
`);
    expect(workflow?.jobs).toEqual(["test", "shared", "odd"]);
    expect(workflow?.uses).toEqual([
      PINNED,
      "./.github/actions/local",
      "octo/repo/.github/workflows/x.yml@main",
    ]);
    expect(workflow?.uses.filter((used) => !pinned(used))).toEqual([
      "octo/repo/.github/workflows/x.yml@main",
    ]);
    expect(pinned("docker://alpine:3")).toBe(true);
    expect(pinned("actions/checkout@v4")).toBe(false);
  });

  it("reads Compose images and locked providers", () => {
    expect(
      composeImages("services:\n  db:\n    image: postgres:18\n  api:\n    build: .\n"),
    ).toEqual(["postgres:18"]);
    expect(composeImages("name: x\n")).toEqual([]);
    expect(composeImages("services: [\n")).toBeUndefined();
    expect(
      lockedProviders(
        'provider "registry.opentofu.org/hashicorp/azurerm" {\n}\nprovider "registry.opentofu.org/hashicorp/random" {\n}\n',
      ),
    ).toEqual(["hashicorp/azurerm", "hashicorp/random"]);
  });
});

describe("ASSESS-003 what is not walked is unknown, never missing", () => {
  const walked = tree(
    { "README.md": "", "api/pyproject.toml": FASTAPI },
    {
      unlisted: ["closed", "deep"],
      gaps: [
        { kind: "inaccessible", path: "closed", detail: "closed to this user" },
        { kind: "limit", path: "deep", detail: "deeper than 12 directories" },
      ],
      other: ["linked"],
    },
  );

  it("tells there, not there and cannot tell apart", () => {
    expect(presence(walked, "readme.md")).toEqual({ found: true, path: "README.md" });
    expect(presence(walked, "api/uv.lock")).toEqual({ found: false });
    expect(presence(walked, "missing/uv.lock")).toEqual({ found: false });
    expect(presence(walked, "README.md/x")).toEqual({ found: false });
    expect(presence(walked, "closed/x")).toMatchObject({
      found: "unknown",
      status: "inaccessible",
    });
    expect(presence(walked, "deep/x/y")).toMatchObject({ found: "unknown", status: "unknown" });
    expect(presence(walked, "linked/x")).toMatchObject({ found: "unknown", status: "unknown" });
  });

  it("counts files under a directory, and says when some were not seen", () => {
    expect(filesUnder(walked, "api", () => true)).toEqual({ files: ["api/pyproject.toml"] });
    expect(filesUnder(walked, "API", () => true)).toEqual({ files: ["api/pyproject.toml"] });
    expect(filesUnder(walked, "missing", () => true)).toEqual({ files: [] });
    expect(filesUnder(walked, "README.md", () => true)).toEqual({ files: [] });
    expect(filesUnder(walked, "closed/inner", () => true).hidden).toMatchObject({
      status: "inaccessible",
    });
    expect(filesUnder(walked, ".", (file) => file.endsWith(".md")).hidden).toMatchObject({
      found: "unknown",
    });
  });

  it("is unknown about tests it could not see", () => {
    const hidden = tree(
      { "api/pyproject.toml": FASTAPI },
      { unlisted: ["api/tests"], gaps: [{ kind: "limit", path: "api/tests", detail: "too deep" }] },
    );
    expect(lines(run(hidden))).toContain("unknown tests.present backend at api");
  });
});

describe("ASSESS-003 the standard's checks", () => {
  it("names a lock file from another tool, a missing runtime and missing tests", () => {
    const project = run(
      tree({
        "web/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
        "web/yarn.lock": "",
        "web/Dockerfile": "",
      }),
    );
    expect(lines(project)).toEqual(
      expect.arrayContaining([
        "compliant structure.part web",
        "noncompliant dependencies.lockfile frontend at web",
        "noncompliant dependencies.runtime frontend at web",
        "noncompliant tests.present frontend at web",
        "noncompliant tests.coverage-gate frontend at web",
        "compliant build.container frontend at web",
      ]),
    );
    expect(
      project.findings.find((finding) => finding.check === "dependencies.lockfile")?.message,
    ).toBe("locks dependencies with yarn.lock; this release's standard is package-lock.json");
  });

  it("checks a database's migrations and local service", () => {
    const api = (dependencies: string[], compose?: string) =>
      lines(
        run(
          tree({
            "pyproject.toml": `[project]\ndependencies = ${JSON.stringify(["fastapi", ...dependencies])}\n`,
            ...(compose === undefined ? {} : { "compose.yaml": compose }),
          }),
        ),
      );
    expect(api([])).not.toContain("noncompliant data.migrations backend at .");
    expect(api(["sqlalchemy"])).toEqual(
      expect.arrayContaining([
        "noncompliant data.migrations backend at .",
        "noncompliant data.local-database backend at .",
      ]),
    );
    expect(
      api(
        ["sqlalchemy", "alembic"],
        "services:\n  db:\n    image: docker.io/library/postgres:18@sha256:ab\n",
      ),
    ).toEqual(
      expect.arrayContaining([
        "compliant data.migrations backend at .",
        "compliant data.local-database backend at .",
      ]),
    );
    expect(api(["psycopg"], "services:\n  cache:\n    image: redis:8\n")).toContain(
      "noncompliant data.local-database backend at .",
    );
    expect(api(["psycopg"], "services: [\n")).toContain("unknown data.local-database backend at .");
  });

  it("tells a Go project's coverage gate only when it is Liftoff's", () => {
    const go = (files: Record<string, string>) =>
      lines(
        run(
          tree({
            "go.mod": "module x\n\ngo 1.26\n\nrequire github.com/danielgtaylor/huma/v2 v2.0.0\n",
            ...files,
          }),
        ),
      );
    expect(go({})).toContain("unknown tests.coverage-gate backend at .");
    expect(go({ "tools/coverage/main.go": "" })).toContain(
      "compliant tests.coverage-gate backend at .",
    );
  });

  it("recognizes other ecosystems as unsupported and does not check them further", () => {
    const project = run(
      tree({
        "Cargo.toml": "",
        "infra/main.bicep": "",
        "ops/main.tf": "",
        "ops/.terraform.lock.hcl": 'provider "registry.terraform.io/hashicorp/aws" {\n}\n',
        "py/requirements.txt": "",
        "py/setup.py": "",
        "site/package.json": JSON.stringify({ dependencies: { react: "19" } }),
        "server/package.json": JSON.stringify({ dependencies: { express: "5" } }),
        "cli/package.json": "{}",
        "mod/go.mod": "module x\n",
        "lib/pyproject.toml": "[project]\ndependencies = []\n",
        "packages/package.json": JSON.stringify({ workspaces: ["*"] }),
      }),
    );
    expect(project.parts.map((part) => `${part.component} ${part.stack} at ${part.path}`)).toEqual([
      "application Rust at .",
      "application Node.js without Fastify or Vue at cli",
      "infrastructure Bicep at infra",
      "application Python without FastAPI at lib",
      "application Go without Huma at mod",
      "infrastructure OpenTofu or Terraform with hashicorp/aws at ops",
      "application Python without pyproject.toml at py",
      "backend express at server",
      "frontend react at site",
    ]);
    expect(project.findings.filter((finding) => finding.area === "dependencies")).toEqual([]);
    expect(project.summary.unsupported).toBe(9);
  });

  it("checks that infrastructure locks its providers, but not in modules", () => {
    const lock = 'provider "registry.opentofu.org/hashicorp/azurerm" {\n}\n';
    const infrastructure = (files: Record<string, string>) =>
      lines(run(tree({ "infra/modules/app/main.tf": "", "infra/dev/main.tf": "", ...files })));
    expect(infrastructure({ "infra/dev/.terraform.lock.hcl": lock })).toContain(
      "compliant infrastructure.provider-lock infrastructure at infra",
    );
    expect(
      infrastructure({ "infra/dev/.terraform.lock.hcl": lock, "infra/prod/main.tf": "" }),
    ).toContain("noncompliant infrastructure.provider-lock infrastructure at infra");
    // With no lock, which cloud it is for cannot be told.
    expect(infrastructure({})).toContain("unknown structure.part infra/dev");
  });

  it("checks review skills for each coding-agent host, and nothing without one", () => {
    expect(lines(run(tree({ "README.md": "" })))).not.toContain("noncompliant agents.instructions");
    const claude = lines(run(tree({ "CLAUDE.md": "", ".github/copilot-instructions.md": "" })));
    expect(claude).toEqual(
      expect.arrayContaining([
        "noncompliant agents.instructions",
        "noncompliant agents.review-skills claude",
        "noncompliant agents.review-skills copilot",
      ]),
    );
    const shared = run(
      tree({
        "AGENTS.md": "",
        ".agents/skills/liftoff-code-review/SKILL.md": "",
        ".github/skills/x/SKILL.md": "",
      }),
    );
    expect(shared.agents).toEqual(["codex", "copilot"]);
    expect(lines(shared)).toEqual(
      expect.arrayContaining([
        "compliant agents.instructions",
        "compliant agents.review-skills codex",
        "compliant agents.review-skills copilot",
      ]),
    );
  });

  it("reports the workflows in use", () => {
    expect(run(tree({ "openspec/project.md": "", ".specify/memory/x.md": "" })).workflows).toEqual([
      "openspec",
      "spec-kit",
    ]);
    expect(run(tree({})).workflows).toEqual(["manual"]);
  });
});

describe("ASSESS-003 what the walk did not see is never a difference", () => {
  it("finds lock files at the root of an npm or uv workspace", () => {
    const npm = run(
      tree({
        "package.json": JSON.stringify({ workspaces: ["api", "web"] }),
        "package-lock.json": "",
        "api/package.json": JSON.stringify({ dependencies: { fastify: "5" } }),
        "web/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
      }),
    );
    expect(lines(npm)).toEqual(
      expect.arrayContaining([
        "compliant dependencies.lockfile backend at api",
        "compliant dependencies.lockfile frontend at web",
      ]),
    );
    const uv = run(
      tree({
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["api"]\n',
        "uv.lock": "",
        "api/pyproject.toml": FASTAPI,
      }),
    );
    expect(uv.parts.map((part) => part.path)).toEqual(["api"]);
    expect(lines(uv)).toContain("compliant dependencies.lockfile backend at api");
    // A lock file beside an unrelated package above does not count.
    const unrelated = run(
      tree({
        "package.json": "{}",
        "package-lock.json": "",
        "api/package.json": JSON.stringify({ dependencies: { fastify: "5" } }),
      }),
    );
    expect(lines(unrelated)).toContain("noncompliant dependencies.lockfile backend at api");
  });

  it("finds a coverage threshold wherever the tools read one", () => {
    const python = (files: Record<string, string>) =>
      lines(run(tree({ "pyproject.toml": FASTAPI, ...files })));
    expect(python({ ".coveragerc": "[report]\nfail_under = 90\n" })).toContain(
      "compliant tests.coverage-gate backend at .",
    );
    expect(python({ "pytest.ini": "[pytest]\naddopts = --cov-fail-under=80\n" })).toContain(
      "compliant tests.coverage-gate backend at .",
    );
    expect(python({ "tox.ini": "[tox]\n" })).toContain(
      "noncompliant tests.coverage-gate backend at .",
    );
    const node = (files: Record<string, string>) =>
      lines(
        run(tree({ "package.json": JSON.stringify({ dependencies: { fastify: "5" } }), ...files })),
      );
    expect(
      node({
        "jest.config.js": "module.exports = { coverageThreshold: { global: { lines: 80 } } };",
      }),
    ).toContain("compliant tests.coverage-gate backend at .");
    expect(
      node({
        "vite.config.ts": "export default { test: { coverage: { thresholds: { lines: 80 } } } };",
      }),
    ).toContain("compliant tests.coverage-gate backend at .");
    expect(
      lines(
        run(
          tree(
            { "package.json": JSON.stringify({ dependencies: { fastify: "5" } }) },
            {
              unread: {
                "vitest.config.ts": {
                  status: "unknown",
                  reason: "changed while it was being read",
                },
              },
            },
          ),
        ),
      ),
    ).toContain("unknown tests.coverage-gate backend at .");
  });

  it("is unknown where a directory was listed only in part, and finds what it did list", () => {
    const lock = 'provider "registry.opentofu.org/hashicorp/azurerm" {\n}\n';
    const partial = tree(
      {
        "infra/dev/main.tf": "",
        "infra/dev/.terraform.lock.hcl": lock,
        "infra/prod/main.tf": "",
        "web/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
        "web/Dockerfile": "",
        "Docs/pull_request_template.md": "",
        ".github/workflows/ci.yml": "on: push\njobs: {}\n",
      },
      {
        unlisted: ["infra/prod", "web", ".github/workflows"],
        gaps: [
          { kind: "limit", path: "infra/prod", detail: "only its first 1 entries were listed" },
          { kind: "limit", path: "web", detail: "only its first 2 entries were listed" },
          {
            kind: "limit",
            path: ".github/workflows",
            detail: "only its first 1 entries were listed",
          },
        ],
      },
    );
    const found = lines(run(partial));
    expect(found).toEqual(
      expect.arrayContaining([
        // prod's lock was not seen, so neither its cloud nor dev's part's locks are known.
        "unknown structure.part infra/prod",
        "unknown infrastructure.provider-lock infrastructure at infra/dev",
        "unknown tests.coverage-gate frontend at web",
        "unknown dependencies.lockfile frontend at web",
        "compliant build.container frontend at web",
        "compliant governance.pr-template",
        "unknown ci.pull-request",
        "unknown ci.pinned-actions",
      ]),
    );
    expect(
      found.filter(
        (line) =>
          line.startsWith("noncompliant") &&
          !line.includes("governance") &&
          !line.includes("docs") &&
          !line.includes("liftoff"),
      ),
    ).toEqual([]);
    const stopped = tree(
      { "infra/dev/main.tf": "", "infra/dev/.terraform.lock.hcl": lock },
      {
        unlisted: ["infra/prod"],
        gaps: [{ kind: "limit", path: ".", detail: "the walk stopped after 3 entries" }],
      },
    );
    expect(lines(run(stopped))).toContain(
      "unknown infrastructure.provider-lock infrastructure at infra/dev",
    );
  });

  it("is unknown about what a repository keeps at its root, below the root", () => {
    const below = assess(tree({ "pyproject.toml": FASTAPI, "uv.lock": "" }), {
      git: false,
      liftoff: NONE,
      github: NOT_LIVE,
    });
    const found = lines(below);
    expect(found).toEqual(
      expect.arrayContaining([
        "unknown liftoff.project",
        "unknown ci.workflows",
        "unknown governance.review-policy",
        "noncompliant docs.readme",
        "compliant dependencies.lockfile backend at .",
      ]),
    );
    expect(
      found.filter((line) => /^noncompliant (ci|governance|agents|liftoff)\./.test(line)),
    ).toEqual([]);
    expect(below.next).toContainEqual(
      expect.objectContaining({
        text: "Assess the root of the Git repository for what applies to the whole repository.",
      }),
    );
  });
});

describe("ASSESS-003 what is found is only what the declarations say", () => {
  it("takes only a regular file as a file, and never a link it did not follow", () => {
    const project = lines(
      run(
        tree(
          { "pyproject.toml": FASTAPI, "uv.lock/inner": "", "Dockerfile/inner": "" },
          { other: ["README.md", "AGENTS.md", "CLAUDE.md"] },
        ),
      ),
    );
    expect(project).toEqual(
      expect.arrayContaining([
        "noncompliant dependencies.lockfile backend at .",
        "noncompliant build.container backend at .",
        "unknown docs.readme",
        "unknown agents.instructions",
      ]),
    );
    const broken = run(
      tree({ "go.mod": "module x\nrequire (\n\tgithub.com/danielgtaylor/huma/v2 v2.0.0\n" }),
    );
    expect(broken.parts).toEqual([]);
    expect(lines(broken)).toContain("unknown structure.part .");
  });

  it("is unknown about a pyproject.toml that is not TOML, whatever it names", () => {
    const broken = run(
      tree({ "pyproject.toml": '[project]\ndependencies = ["fastapi"]\nbroken = [\n' }),
    );
    expect(broken.parts).toEqual([]);
    expect(lines(broken)).toContain("unknown structure.part .");
  });

  it("finds an application at a workspace's root as well as in its members", () => {
    const project = run(
      tree({
        "package.json": JSON.stringify({
          workspaces: ["packages/*"],
          dependencies: { fastify: "5" },
        }),
        "package-lock.json": "",
        "packages/web/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
        "services/api/package.json": JSON.stringify({ dependencies: { fastify: "5" } }),
      }),
    );
    expect(project.parts.map((part) => `${part.component} ${part.stack} at ${part.path}`)).toEqual([
      "backend node-fastify at .",
      "frontend vue at packages/web",
      "backend node-fastify at services/api",
    ]);
    // Only a member is locked by the workspace's lock file.
    expect(lines(project)).toEqual(
      expect.arrayContaining([
        "compliant dependencies.lockfile backend at .",
        "compliant dependencies.lockfile frontend at packages/web",
        "noncompliant dependencies.lockfile backend at services/api",
      ]),
    );
    const uv = run(
      tree({
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["libs/*"]\nexclude = ["libs/old"]\n',
        "uv.lock": "",
        "libs/api/pyproject.toml": FASTAPI,
        "libs/old/pyproject.toml": FASTAPI,
      }),
    );
    expect(lines(uv)).toEqual(
      expect.arrayContaining([
        "compliant dependencies.lockfile backend at libs/api",
        "noncompliant dependencies.lockfile backend at libs/old",
      ]),
    );
  });

  it("never calls a lock file it could not read unsupported", () => {
    const azure = 'provider "registry.opentofu.org/hashicorp/azurerm" {\n}\n';
    const infra = (declaration: Declaration | undefined) =>
      lines(
        run(
          tree(
            { "infra/main.tf": "" },
            declaration === undefined
              ? { other: [], unlisted: [] }
              : { unread: { "infra/.terraform.lock.hcl": declaration } },
          ),
        ),
      );
    expect(infra({ status: "inaccessible", reason: "closed to this user" })).toContain(
      "inaccessible structure.part infra",
    );
    expect(infra({ status: "unknown", reason: "over 512 KiB, so not read" })).toContain(
      "unknown structure.part infra",
    );
    const unread = tree({ "infra/main.tf": "", "infra/.terraform.lock.hcl": azure });
    const notRead = { ...unread, declarations: new Map() };
    expect(lines(run(notRead))).toContain("unknown structure.part infra");
    expect(lines(run(unread))).toContain("compliant structure.part infra");
  });

  it("keeps independent infrastructure apart by the providers each locks", () => {
    const lock = (provider: string) =>
      `provider "registry.opentofu.org/hashicorp/${provider}" {\n}\n`;
    const project = run(
      tree({
        "azure/main.tf": "",
        "azure/.terraform.lock.hcl": lock("azurerm"),
        "aws/main.tf": "",
        "aws/.terraform.lock.hcl": lock("aws"),
      }),
    );
    expect(project.parts.map((part) => `${part.stack} at ${part.path} ${part.supported}`)).toEqual([
      "OpenTofu or Terraform with hashicorp/aws at aws false",
      "azure at azure true",
    ]);
    expect(
      project.findings
        .filter((finding) => finding.check === "infrastructure.provider-lock")
        .map((finding) => finding.subject),
    ).toEqual(["infrastructure at azure"]);
  });

  it("takes only a configured threshold as a coverage gate", () => {
    const node = (files: Record<string, string>) =>
      lines(
        run(tree({ "package.json": JSON.stringify({ dependencies: { fastify: "5" } }), ...files })),
      );
    const gate = "compliant tests.coverage-gate backend at .";
    expect(
      lines(
        run(
          tree({
            "package.json": JSON.stringify({
              description: "Service for managing thresholds",
              dependencies: { fastify: "5" },
            }),
          }),
        ),
      ),
    ).toContain("noncompliant tests.coverage-gate backend at .");
    expect(
      node({ "vitest.config.ts": "// thresholds: { lines: 80 }\nexport default {};" }),
    ).toContain("noncompliant tests.coverage-gate backend at .");
    expect(
      node({ "vitest.config.ts": "export default { test: { coverage: { thresholds: {} } } };" }),
    ).toContain("noncompliant tests.coverage-gate backend at .");
    expect(node({ "vitest.config.ts": 'const note = "thresholds: { lines: 80 }";' })).toContain(
      "noncompliant tests.coverage-gate backend at .",
    );
    expect(
      node({
        "vitest.config.ts": 'export default { "coverageThreshold": { "global": { lines: 80 } } };',
      }),
    ).toContain(gate);
    expect(
      node({
        "vitest.config.ts": "export default { test: { coverage: { thresholds: shared } } };",
      }),
    ).toContain("unknown tests.coverage-gate backend at .");
    expect(
      node({
        "vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 80 } } } };",
      }),
    ).toContain(gate);
    expect(
      node({ "jest.config.json": '{"coverageThreshold": {"global": {"lines": 80}}}' }),
    ).toContain(gate);
    expect(node({ "jest.config.json": "{ nope" })).toContain(
      "unknown tests.coverage-gate backend at .",
    );
    const python = (files: Record<string, string>) =>
      lines(run(tree({ "pyproject.toml": FASTAPI, ...files })));
    expect(python({ ".coveragerc": "[report]\n# fail_under = 90\nfail_under = 0\n" })).toContain(
      "noncompliant tests.coverage-gate backend at .",
    );
    expect(python({ "setup.cfg": "[coverage:report]\nfail_under =\n  85\n" })).toContain(gate);
    expect(python({ "tox.ini": "[pytest]\naddopts = --cov --cov-fail-under 90\n" })).toContain(
      gate,
    );
  });
});

describe("ASSESS-003 CI and governance", () => {
  const ci = `
on: pull_request
jobs:
  ci-gate:
    steps:
      - uses: ${PINNED}
      - uses: github/codeql-action/init@0123456789abcdef0123456789abcdef01234567
      - uses: actions/dependency-review-action@0123456789abcdef0123456789abcdef01234567
`;

  it("is compliant with the standard workflows", () => {
    const project = lines(run(tree({ ".github/workflows/ci.yml": ci })));
    for (const check of [
      "ci.pull-request",
      "ci.gate",
      "ci.codeql",
      "ci.dependency-review",
      "ci.pinned-actions",
    ]) {
      expect(project).toContain(`compliant ${check}`);
    }
  });

  it("names unpinned actions, and is unknown where a workflow could not be read", () => {
    const unpinned = run(
      tree({
        ".github/workflows/ci.yml":
          "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n",
      }),
    );
    expect(lines(unpinned)).toEqual(
      expect.arrayContaining(["noncompliant ci.pull-request", "noncompliant ci.pinned-actions"]),
    );
    expect(
      unpinned.findings.find((finding) => finding.check === "ci.pinned-actions")?.message,
    ).toBe(
      "1 action is not pinned to a full commit SHA: actions/checkout@v4 in .github/workflows/ci.yml",
    );
    const unreadable = lines(
      run(
        tree(
          {
            ".github/workflows/ok.yml": "on: push\njobs: {}\n",
            ".github/workflows/bad.yml": "on: [\n",
          },
          {
            unread: {
              ".github/workflows/closed.yml": {
                status: "inaccessible",
                reason: "closed to this user",
              },
            },
          },
        ),
      ),
    );
    expect(unreadable).toEqual(
      expect.arrayContaining([
        "unknown ci.workflows .github/workflows/bad.yml",
        "inaccessible ci.workflows .github/workflows/closed.yml",
        "unknown ci.pull-request",
        "unknown ci.gate",
        "unknown ci.pinned-actions",
      ]),
    );
    expect(unreadable.filter((line) => line.startsWith("noncompliant ci."))).toEqual([]);
  });

  it("is noncompliant without workflows, and unknown when they could not be listed", () => {
    expect(lines(run(tree({})))).toContain("noncompliant ci.workflows");
    const closed = tree(
      { ".github/dependabot.yml": "" },
      {
        unlisted: [".github/workflows"],
        gaps: [{ kind: "inaccessible", path: ".github/workflows", detail: "closed" }],
      },
    );
    expect(lines(run(closed))).toContain("inaccessible ci.workflows");
  });

  it("expects no rulesets or GOVERNANCE.md when a Liftoff project chose no governance", () => {
    const project: LiftoffState = { kind: "project", governance: "none", findings: [] };
    const none = lines(run(tree({}), NOT_LIVE, project));
    expect(none).toEqual(
      expect.arrayContaining([
        "compliant liftoff.files",
        "compliant governance.rulesets",
        "compliant governance.document",
        "noncompliant governance.review-policy",
      ]),
    );
    expect(lines(run(tree({})))).toEqual(
      expect.arrayContaining([
        "noncompliant governance.rulesets",
        "noncompliant governance.document",
      ]),
    );
  });
});

describe("ASSESS-004 every finding that needs action says who acts next", () => {
  it("groups next actions by who acts, naming only commands that exist", () => {
    const known = new Set(REGISTRY.map(commandName));
    const liftoff: LiftoffState = {
      kind: "project",
      findings: [
        {
          severity: "warning",
          code: "managed-file-changed",
          message: "changed",
          path: "AGENTS.md",
        },
        { severity: "info", code: "plugin-version", message: "older" },
      ],
    };
    const github: GitHubState = {
      kind: "read",
      repository: "octo/demo",
      checkpoints: [
        { id: "handoff", title: "Files", status: "done", detail: "valid" },
        {
          id: "branches",
          title: "Branches",
          status: "next",
          detail: "no develop",
          action: { kind: "create-develop", from: "abc" },
        },
        {
          id: "workflows",
          title: "Workflows",
          status: "later",
          detail: "waiting",
          todo: "Merge the workflows",
        },
      ],
    };
    const assessment = run(
      tree(
        { "pyproject.toml": FASTAPI, "Cargo.toml": "" },
        { gaps: [{ kind: "inaccessible", path: "x", detail: "closed" }] },
      ),
      github,
      liftoff,
    );
    const categories = assessment.next.map((action) => action.category);
    expect(categories).toEqual(
      [...categories].sort(
        (a, b) =>
          ["project", "liftoff", "access", "unavailable"].indexOf(a) -
          ["project", "liftoff", "access", "unavailable"].indexOf(b),
      ),
    );
    expect(new Set(categories)).toEqual(new Set(["project", "liftoff", "access", "unavailable"]));
    for (const action of assessment.next) {
      if (action.command !== undefined) {
        expect(known).toContain(action.command.replace(/^liftoff /, ""));
      }
      expect(action.checks.length).toBeGreaterThan(0);
    }
    expect(assessment.next).toContainEqual(
      expect.objectContaining({
        command: "liftoff governance apply-next",
        checks: ["github.branches"],
      }),
    );
    expect(assessment.next).toContainEqual(
      expect.objectContaining({ category: "project", text: "Merge the workflows" }),
    );
    expect(lines(assessment)).toEqual(
      expect.arrayContaining([
        "noncompliant liftoff.managed-file-changed AGENTS.md",
        "compliant github.handoff",
        "noncompliant github.branches",
      ]),
    );
    expect(lines(assessment)).not.toContain("noncompliant liftoff.plugin-version");
  });
});

describe("ASSESS-005 GitHub is read only when asked", () => {
  it("lists GitHub as not checked without --live, and says why it could not be read", () => {
    expect(run(tree({})).gaps).toContainEqual(expect.objectContaining({ kind: "not-checked" }));
    const refused = run(tree({}), {
      kind: "failed",
      repository: "octo/demo",
      status: "inaccessible",
      reason: "HTTP 404",
    });
    expect(lines(refused)).toContain("inaccessible github.repository");
    expect(refused.next).toContainEqual(expect.objectContaining({ category: "access" }));
    expect(refused.gaps.map((gap) => gap.kind)).not.toContain("not-checked");
    const broken = run(tree({}), { kind: "failed", status: "unknown", reason: "timed out" });
    expect(broken.findings.find((finding) => finding.check === "github.repository")?.message).toBe(
      "could not read the repository on GitHub: timed out",
    );
  });
});

describe("ASSESS-003 Liftoff projects and projects from before the rebuild", () => {
  it("keeps a Liftoff file this user may not read apart from a difference", () => {
    const state: LiftoffState = {
      kind: "project",
      findings: [
        { severity: "error", code: "config-unreadable", message: "closed", path: "liftoff.yaml" },
        { severity: "error", code: "config-not-a-file", message: "a link", path: "liftoff.yaml" },
      ],
    };
    expect(lines(run(tree({}), NOT_LIVE, state))).toEqual(
      expect.arrayContaining([
        "inaccessible liftoff.config-unreadable liftoff.yaml",
        "noncompliant liftoff.config-not-a-file liftoff.yaml",
      ]),
    );
  });

  it("reports an interrupted change in a project that is not Liftoff's yet", () => {
    const state: LiftoffState = {
      kind: "none",
      findings: [
        {
          severity: "error",
          code: "interrupted-change",
          message: "stopped",
          path: ".liftoff/change-journal.json",
        },
        { severity: "error", code: "not-a-liftoff-project", message: "no liftoff.yaml" },
      ],
    };
    expect(lines(run(tree({}), NOT_LIVE, state))).toEqual(
      expect.arrayContaining([
        "noncompliant liftoff.project",
        "noncompliant liftoff.interrupted-change .liftoff/change-journal.json",
      ]),
    );
    expect(lines(run(tree({}), NOT_LIVE, state))).not.toContain(
      "noncompliant liftoff.not-a-liftoff-project",
    );
  });
});
