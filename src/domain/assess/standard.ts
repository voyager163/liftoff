import path from "node:path";
import type { Checkpoint } from "../governance/checkpoints.ts";
import type { LegacyInventory } from "../legacy/inventory.ts";
import {
  composeImages,
  type GoModule,
  hasPython,
  lockedProviders,
  type NodePackage,
  type PythonProject,
  pinned,
  readGoMod,
  readPackageJson,
  readPyproject,
  readWorkflow,
  requiresGo,
  type Workflow,
} from "./declarations.ts";
import {
  type Declaration,
  filesUnder,
  firstPresent,
  type Gap,
  type Presence,
  presence,
  type Tree,
} from "./tree.ts";

/**
 * This release's standard for a project, and an assessment against it. The
 * statuses stay apart: noncompliant means the project was seen and differs
 * from the standard; unknown means it could not be told; unsupported means
 * the standard does not cover it; inaccessible means this user may not read
 * it.
 */
export const STATUSES = [
  "compliant",
  "noncompliant",
  "unknown",
  "unsupported",
  "inaccessible",
] as const;
export type Status = (typeof STATUSES)[number];

export const AREAS = [
  "liftoff",
  "structure",
  "dependencies",
  "tests",
  "build",
  "data",
  "agents",
  "ci",
  "governance",
  "infrastructure",
  "docs",
  "github",
] as const;
export type Area = (typeof AREAS)[number];

/** A path a finding rests on, and how it was observed. */
export interface Evidence {
  readonly path: string;
  /** Seen by name in the walk, read as a declaration, or read from GitHub. */
  readonly how: "listed" | "read" | "github";
}

/**
 * Who acts next: the team changes the project, a Liftoff command this
 * release has does it, someone grants access, or this release cannot help.
 */
export const NEXT_CATEGORIES = ["project", "liftoff", "access", "unavailable"] as const;
export type NextCategory = (typeof NEXT_CATEGORIES)[number];

export interface NextAction {
  readonly category: NextCategory;
  readonly text: string;
  /** A command this release has, when one does it. */
  readonly command?: string;
}

export interface AssessmentFinding {
  /** Which check, such as "dependencies.lockfile". */
  readonly check: string;
  readonly area: Area;
  readonly status: Status;
  readonly message: string;
  /** The part of the project or path it is about, when not the whole project. */
  readonly subject?: string;
  readonly evidence: readonly Evidence[];
  readonly next?: NextAction;
}

export type Component = "backend" | "frontend" | "infrastructure" | "application";

/** An application, frontend or infrastructure found in the project. */
export interface Part {
  readonly component: Component;
  /** Its directory; "." is the project itself. */
  readonly path: string;
  /** A stack this release offers, such as "python-fastapi", or what it is. */
  readonly stack: string;
  readonly supported: boolean;
  readonly evidence: readonly Evidence[];
}

/** What validate found in a Liftoff project, as far as an assessment needs. */
export interface LiftoffFinding {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** Whether the project is Liftoff's, and what validate found in it. */
export type LiftoffState = { readonly findings: readonly LiftoffFinding[] } & (
  | { readonly kind: "none" }
  /** `governance` is the profile liftoff.yaml selects, when it can be read. */
  | { readonly kind: "project"; readonly governance?: string }
  | { readonly kind: "pre-rebuild"; readonly inventory: LegacyInventory }
);

/** What --live read from GitHub, or why it could not. */
export type GitHubState =
  | { readonly kind: "not-requested" }
  | {
      readonly kind: "read";
      readonly repository: string;
      readonly checkpoints: readonly Checkpoint[];
    }
  | {
      readonly kind: "failed";
      readonly repository?: string;
      readonly status: "inaccessible" | "unknown";
      readonly reason: string;
    };

export interface Assessment {
  readonly git: boolean;
  readonly liftoff: LiftoffState["kind"];
  readonly parts: readonly Part[];
  /** Development workflows in use: "openspec", "spec-kit", or "manual" for neither. */
  readonly workflows: readonly string[];
  /** Coding-agent hosts the project is set up for. */
  readonly agents: readonly string[];
  readonly findings: readonly AssessmentFinding[];
  readonly gaps: readonly Gap[];
  readonly next: readonly (NextAction & { readonly checks: readonly string[] })[];
  readonly summary: Readonly<Record<Status, number>>;
}

const listed = (file: string): Evidence => ({ path: file, how: "listed" });
const read = (file: string): Evidence => ({ path: file, how: "read" });
const within = (directory: string, file: string) =>
  directory === "." ? file : `${directory}/${file}`;
const parentOf = (file: string) => {
  const parent = path.posix.dirname(file);
  return parent === "" ? "." : parent;
};
const base = (file: string) => path.posix.basename(file);

/** A finding for something that should be there. */
function expect(
  check: string,
  area: Area,
  found: Presence,
  messages: { readonly found: string; readonly missing: string },
  next: NextAction,
  subject?: string,
): AssessmentFinding {
  const about = subject === undefined ? {} : { subject };
  if (found.found === true) {
    return {
      check,
      area,
      status: "compliant",
      message: messages.found,
      ...about,
      evidence: [listed(found.path)],
    };
  }
  if (found.found === "unknown") {
    return {
      check,
      area,
      status: found.status,
      message: `could not be checked: ${found.why}`,
      ...about,
      evidence: [],
      next: accessNext(found.status),
    };
  }
  return {
    check,
    area,
    status: "noncompliant",
    message: messages.missing,
    ...about,
    evidence: [],
    next,
  };
}

const accessNext = (status: "inaccessible" | "unknown"): NextAction =>
  status === "inaccessible"
    ? { category: "access", text: "Assess as a user who can read the whole project." }
    : {
        category: "project",
        text: "Look at what the assessment could not walk or read, listed under gaps.",
      };

// ---------------------------------------------------------------- detection

/** Manifests of ecosystems this release does not build. */
const OTHER_APPLICATIONS: readonly [(name: string) => boolean, string][] = [
  [(name) => name === "Cargo.toml", "Rust"],
  [(name) => ["pom.xml", "build.gradle", "build.gradle.kts"].includes(name), "Java or Kotlin"],
  [(name) => /\.(csproj|fsproj|sln)$/.test(name), ".NET"],
  [(name) => name === "Gemfile", "Ruby"],
  [(name) => name === "composer.json", "PHP"],
  [(name) => name === "mix.exs", "Elixir"],
  [(name) => name === "Package.swift", "Swift"],
];
const OTHER_INFRASTRUCTURE: readonly [(name: string) => boolean, string][] = [
  [(name) => name.endsWith(".bicep"), "Bicep"],
  [(name) => name === "Pulumi.yaml", "Pulumi"],
  [(name) => name === "cdk.json", "AWS CDK"],
  [(name) => name === "serverless.yml", "Serverless Framework"],
];
const PYTHON_WITHOUT_PYPROJECT = ["requirements.txt", "Pipfile", "setup.py", "setup.cfg"];
const OTHER_FRONTENDS = ["react", "@angular/core", "svelte", "next", "nuxt", "solid-js", "preact"];
const OTHER_NODE_APIS = ["express", "koa", "@nestjs/core", "@hapi/hapi"];

/** A declaration the assessment read, parsed; or why it cannot be. */
type Parsed<T> =
  | { readonly value: T }
  | { readonly status: "inaccessible" | "unknown"; readonly reason: string };

function parsed<T>(
  tree: Tree,
  file: string,
  parse: (text: string) => T | undefined,
  what: string,
): Parsed<T> {
  const declaration: Declaration | undefined = tree.declarations.get(file);
  if (declaration === undefined) {
    return { status: "unknown", reason: `${file} was not read` };
  }
  if ("status" in declaration) return declaration;
  const value = parse(declaration.text);
  return value === undefined
    ? { status: "unknown", reason: `${file} is not valid ${what}` }
    : { value };
}

interface Detected {
  readonly parts: readonly Part[];
  readonly findings: readonly AssessmentFinding[];
  readonly python: ReadonlyMap<string, PythonProject>;
  readonly node: ReadonlyMap<string, NodePackage>;
  readonly go: ReadonlyMap<string, GoModule>;
}

/** The project's applications, frontends and infrastructure. */
export function detectParts(tree: Tree): Detected {
  const parts: Part[] = [];
  const findings: AssessmentFinding[] = [];
  const python = new Map<string, PythonProject>();
  const node = new Map<string, NodePackage>();
  const go = new Map<string, GoModule>();
  const files = [...tree.entries]
    .filter(([file, kind]) => kind === "file" && !file.startsWith(".github/"))
    .map(([file]) => file);
  const cannotRead = (
    file: string,
    problem: { status: "inaccessible" | "unknown"; reason: string },
  ) =>
    findings.push({
      check: "structure.part",
      area: "structure",
      status: problem.status,
      message: `could not tell what ${parentOf(file)} holds: ${problem.reason}`,
      subject: parentOf(file),
      evidence: [listed(file)],
      next: accessNext(problem.status),
    });
  const pyprojectDirectories = new Set(
    files.filter((file) => base(file) === "pyproject.toml").map(parentOf),
  );
  const unsupportedPython = new Set<string>();
  const terraform = new Set<string>();

  for (const file of files) {
    const name = base(file);
    const directory = parentOf(file);
    const part = (component: Component, stack: string, supported: boolean, how = read(file)) =>
      parts.push({ component, path: directory, stack, supported, evidence: [how] });
    if (name === "pyproject.toml") {
      const project = parsed(tree, file, readPyproject, "TOML");
      if ("status" in project) {
        cannotRead(file, project);
        continue;
      }
      python.set(directory, project.value);
      if (hasPython(project.value, "fastapi")) {
        part(
          "backend",
          hasPython(project.value, "pydantic-ai", "pydantic-ai-slim")
            ? "python-pydanticai"
            : "python-fastapi",
          true,
        );
      } else {
        part("application", "Python without FastAPI", false);
      }
    } else if (PYTHON_WITHOUT_PYPROJECT.includes(name)) {
      if (!pyprojectDirectories.has(directory) && !unsupportedPython.has(directory)) {
        unsupportedPython.add(directory);
        part("application", "Python without pyproject.toml", false, listed(file));
      }
    } else if (name === "package.json") {
      const json = parsed(tree, file, readPackageJson, "JSON");
      if ("status" in json) {
        cannotRead(file, json);
        continue;
      }
      // A workspace root only lists its packages, which are found on their own.
      if (json.value.workspaces) continue;
      node.set(directory, json.value);
      const has = (...names: string[]) =>
        names.some((dependency) => json.value.dependencies.has(dependency));
      if (has("fastify")) part("backend", "node-fastify", true);
      else if (has("vue")) part("frontend", "vue", true);
      else if (has(...OTHER_FRONTENDS)) {
        part("frontend", OTHER_FRONTENDS.find((dependency) => has(dependency)) ?? "", false);
      } else if (has(...OTHER_NODE_APIS)) {
        part("backend", OTHER_NODE_APIS.find((dependency) => has(dependency)) ?? "", false);
      } else part("application", "Node.js without Fastify or Vue", false);
    } else if (name === "go.mod") {
      const module = parsed(tree, file, readGoMod, "go.mod");
      if ("status" in module) {
        cannotRead(file, module);
        continue;
      }
      go.set(directory, module.value);
      if (requiresGo(module.value, "github.com/danielgtaylor/huma/v2"))
        part("backend", "go-huma", true);
      else part("application", "Go without Huma", false);
    } else if (name.endsWith(".tf")) {
      terraform.add(directory);
    } else {
      const other = OTHER_APPLICATIONS.find(([matches]) => matches(name));
      if (other) part("application", other[1], false, listed(file));
      const infrastructure = OTHER_INFRASTRUCTURE.find(([matches]) => matches(name));
      if (infrastructure) part("infrastructure", infrastructure[1], false, listed(file));
    }
  }

  if (terraform.size > 0) {
    const roots = [...terraform].sort();
    let common = roots[0]?.split("/") ?? [];
    for (const root of roots) {
      const segments = root.split("/");
      let shared = 0;
      while (shared < common.length && common[shared] === segments[shared]) shared++;
      common = common.slice(0, shared);
    }
    const directory = common.join("/") || ".";
    const locks = files.filter(
      (file) => base(file) === ".terraform.lock.hcl" && terraform.has(parentOf(file)),
    );
    const providers = new Set<string>();
    for (const lock of locks) {
      const text = parsed(tree, lock, (value) => value, "text");
      if ("value" in text)
        for (const provider of lockedProviders(text.value)) providers.add(provider);
    }
    const evidence = locks.length > 0 ? locks.map(read) : roots.map((root) => listed(root));
    const azure = [...providers].some((provider) => provider.endsWith("/azurerm"));
    parts.push({
      component: "infrastructure",
      path: directory,
      stack: azure
        ? "azure"
        : providers.size > 0
          ? `OpenTofu or Terraform with ${[...providers].sort().join(", ")}`
          : "OpenTofu or Terraform with no provider locked",
      supported: azure,
      evidence,
    });
  }
  parts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.stack < b.stack ? -1 : 1));
  return { parts, findings, python, node, go };
}

/** The development workflows the project uses. */
export function detectWorkflows(tree: Tree): string[] {
  const workflows = [];
  if (presence(tree, "openspec").found === true) workflows.push("openspec");
  if (presence(tree, ".specify").found === true) workflows.push("spec-kit");
  return workflows.length > 0 ? workflows : ["manual"];
}

/** Where each coding-agent host keeps its files, and where it reads skills. */
const HOSTS = {
  claude: { markers: ["CLAUDE.md", ".claude"], skills: [".claude/skills"] },
  codex: { markers: [".codex", ".agents"], skills: [".agents/skills"] },
  copilot: {
    markers: [
      ".github/copilot-instructions.md",
      ".github/instructions",
      ".github/skills",
      ".github/agents",
    ],
    skills: [".github/skills", ".claude/skills", ".agents/skills"],
  },
} as const;

export function detectAgents(tree: Tree): (keyof typeof HOSTS)[] {
  return (Object.keys(HOSTS) as (keyof typeof HOSTS)[]).filter((host) =>
    HOSTS[host].markers.some((marker) => presence(tree, marker).found === true),
  );
}

// ------------------------------------------------------------------- checks

const LOCKFILES = {
  python: {
    standard: "uv.lock",
    others: ["poetry.lock", "Pipfile.lock", "pdm.lock"],
    next: "Lock dependencies with `uv lock`.",
  },
  node: {
    standard: "package-lock.json",
    others: ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"],
    next: "Lock dependencies with `npm install`, which writes package-lock.json.",
  },
  go: { standard: "go.sum", others: [], next: "Record module checksums with `go mod tidy`." },
} as const;

const ecosystem = (part: Part) =>
  part.stack.startsWith("python") ? "python" : part.stack === "go-huma" ? "go" : "node";

function partChecks(tree: Tree, part: Part, detected: Detected): AssessmentFinding[] {
  const findings: AssessmentFinding[] = [];
  const at = part.path;
  const kind = ecosystem(part);
  const subject = `${part.component} at ${at}`;
  const lock = LOCKFILES[kind];
  const locked = presence(tree, within(at, lock.standard));
  const other = lock.others.find((file) => presence(tree, within(at, file)).found === true);
  findings.push(
    locked.found === false && other !== undefined
      ? {
          check: "dependencies.lockfile",
          area: "dependencies",
          status: "noncompliant",
          message: `locks dependencies with ${other}; this release's standard is ${lock.standard}`,
          subject,
          evidence: [listed(within(at, other))],
          next: { category: "project", text: lock.next },
        }
      : expect(
          "dependencies.lockfile",
          "dependencies",
          locked,
          { found: `dependencies are locked in ${lock.standard}`, missing: `no ${lock.standard}` },
          { category: "project", text: lock.next },
          subject,
        ),
  );

  const python = detected.python.get(at);
  const pkg = detected.node.get(at);
  const module = detected.go.get(at);
  const runtimeFiles =
    kind === "python"
      ? [within(at, ".python-version"), ".python-version"]
      : kind === "node"
        ? [within(at, ".node-version"), within(at, ".nvmrc"), ".node-version", ".nvmrc"]
        : [];
  const declared =
    (kind === "python" && python?.requiresPython) ||
    (kind === "node" && pkg?.engine) ||
    (kind === "go" && module?.goVersion);
  const manifest = within(
    at,
    kind === "python" ? "pyproject.toml" : kind === "node" ? "package.json" : "go.mod",
  );
  findings.push(
    declared
      ? {
          check: "dependencies.runtime",
          area: "dependencies",
          status: "compliant",
          message: `${manifest} declares the runtime version`,
          subject,
          evidence: [read(manifest)],
        }
      : expect(
          "dependencies.runtime",
          "dependencies",
          firstPresent(tree, runtimeFiles),
          { found: "the runtime version is pinned", missing: "no runtime version declared" },
          {
            category: "project",
            text:
              kind === "python"
                ? "Declare requires-python in pyproject.toml, or pin it in .python-version."
                : kind === "node"
                  ? "Pin the Node.js version in .node-version, or declare engines.node in package.json."
                  : "Declare the go version in go.mod.",
          },
          subject,
        ),
  );

  const testPattern =
    kind === "python"
      ? /(^|\/)(test_[^/]*|[^/]*_test)\.py$/
      : kind === "node"
        ? /\.(test|spec)\.[cm]?[jt]sx?$/
        : /_test\.go$/;
  const tests = filesUnder(tree, at, (file) => testPattern.test(file));
  findings.push(
    tests.files.length > 0
      ? {
          check: "tests.present",
          area: "tests",
          status: "compliant",
          message: `${tests.files.length} test file${tests.files.length === 1 ? "" : "s"}`,
          subject,
          evidence: tests.files.slice(0, 3).map(listed),
        }
      : expect(
          "tests.present",
          "tests",
          tests.hidden ?? { found: false },
          { found: "", missing: "no tests" },
          { category: "project", text: "Add tests." },
          subject,
        ),
  );

  findings.push(coverageGate(tree, part, detected, subject));

  findings.push(
    expect(
      "build.container",
      "build",
      firstPresent(tree, [within(at, "Dockerfile"), within(at, "Containerfile")]),
      { found: "builds a container image", missing: "no Dockerfile" },
      { category: "project", text: "Add a Dockerfile that builds the application's image." },
      subject,
    ),
  );

  if (part.component === "backend") findings.push(...dataChecks(tree, part, detected, subject));
  return findings;
}

function coverageGate(
  tree: Tree,
  part: Part,
  detected: Detected,
  subject: string,
): AssessmentFinding {
  const check = "tests.coverage-gate";
  const at = part.path;
  const gate = (evidence: Evidence) => ({
    check,
    area: "tests" as const,
    status: "compliant" as const,
    message: "the tests fail below a coverage threshold",
    subject,
    evidence: [evidence],
  });
  const missing = (text: string): AssessmentFinding => ({
    check,
    area: "tests",
    status: "noncompliant",
    message: "no coverage threshold declared",
    subject,
    evidence: [],
    next: { category: "project", text },
  });
  const kind = ecosystem(part);
  if (kind === "python") {
    return detected.python.get(at)?.coverageGate
      ? gate(read(within(at, "pyproject.toml")))
      : missing("Set fail_under under [tool.coverage.report] in pyproject.toml.");
  }
  if (kind === "node") {
    if (detected.node.get(at)?.coverageGate) return gate(read(within(at, "package.json")));
    const configs = filesUnder(
      tree,
      at,
      (file) => /^vitest\.config\.[cm]?[jt]s$/.test(base(file)) && parentOf(file) === at,
    ).files;
    for (const config of configs) {
      const text = parsed(tree, config, (value) => value, "text");
      if ("status" in text) {
        return {
          check,
          area: "tests",
          status: text.status,
          message: `could not read ${config}: ${text.reason}`,
          subject,
          evidence: [listed(config)],
          next: accessNext(text.status),
        };
      }
      if (/\bthresholds\b/.test(text.value)) return gate(read(config));
    }
    return missing("Set coverage thresholds in vitest.config.ts.");
  }
  // Liftoff's Go projects gate coverage with a small tool of their own.
  const tool = presence(tree, within(at, "tools/coverage/main.go"));
  if (tool.found === true) return gate(listed(tool.path));
  if (tool.found === "unknown") {
    return {
      check,
      area: "tests",
      status: tool.status,
      message: `could not be checked: ${tool.why}`,
      subject,
      evidence: [],
      next: accessNext(tool.status),
    };
  }
  return {
    check,
    area: "tests",
    status: "unknown",
    message:
      "Go has no standard place to declare a coverage threshold, so one in a script or CI step is not seen",
    subject,
    evidence: [],
    next: {
      category: "project",
      text: "Make sure CI fails when coverage falls below a threshold.",
    },
  };
}

/** Database drivers, and the migration tool this release's standard uses with them. */
const DATABASE = {
  python: {
    drivers: ["sqlalchemy", "sqlmodel", "asyncpg", "psycopg", "psycopg2", "psycopg2-binary"],
    migrations: "alembic",
    tool: "Alembic",
  },
  node: {
    drivers: ["pg", "postgres", "drizzle-orm"],
    migrations: "drizzle-kit",
    tool: "drizzle-kit",
  },
  go: {
    drivers: ["github.com/jackc/pgx", "github.com/lib/pq"],
    migrations: "github.com/pressly/goose",
    tool: "Goose",
  },
} as const;

/** The name of an image, such as "postgres" for "docker.io/library/postgres:18@sha256:…". */
const imageName = (image: string) =>
  (image.split("@")[0] ?? "")
    .replace(/:[^/]*$/, "")
    .split("/")
    .at(-1) ?? "";

function dataChecks(
  tree: Tree,
  part: Part,
  detected: Detected,
  subject: string,
): AssessmentFinding[] {
  const kind = ecosystem(part);
  const at = part.path;
  const python = detected.python.get(at);
  const pkg = detected.node.get(at);
  const module = detected.go.get(at);
  const uses = (name: string) =>
    kind === "python"
      ? python !== undefined && hasPython(python, name)
      : kind === "node"
        ? pkg?.dependencies.has(name) === true
        : module !== undefined && requiresGo(module, name);
  const { drivers, migrations, tool } = DATABASE[kind];
  if (!drivers.some(uses)) return [];
  const manifest = within(
    at,
    kind === "python" ? "pyproject.toml" : kind === "node" ? "package.json" : "go.mod",
  );
  const findings: AssessmentFinding[] = [
    uses(migrations)
      ? {
          check: "data.migrations",
          area: "data",
          status: "compliant",
          message: `migrates the database with ${tool}`,
          subject,
          evidence: [read(manifest)],
        }
      : {
          check: "data.migrations",
          area: "data",
          status: "noncompliant",
          message: `uses a database, but not ${tool}, this release's standard for migrations`,
          subject,
          evidence: [read(manifest)],
          next: {
            category: "project",
            text: `Manage the schema with versioned migrations in ${tool}.`,
          },
        },
  ];
  const composeFiles = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
  ].flatMap((name) => (at === "." ? [name] : [name, within(at, name)]));
  const compose = firstPresent(tree, composeFiles);
  if (compose.found !== true) {
    findings.push(
      expect(
        "data.local-database",
        "data",
        compose,
        { found: "", missing: "no Compose file with a database to develop against" },
        {
          category: "project",
          text: "Add a Compose file that runs PostgreSQL for local development.",
        },
        subject,
      ),
    );
    return findings;
  }
  const images = parsed(tree, compose.path, composeImages, "YAML");
  if ("status" in images) {
    findings.push({
      check: "data.local-database",
      area: "data",
      status: images.status,
      message: `could not read ${compose.path}: ${images.reason}`,
      subject,
      evidence: [listed(compose.path)],
      next: accessNext(images.status),
    });
  } else {
    const database = images.value.some((image) =>
      /postgres|pgvector|postgis/.test(imageName(image)),
    );
    findings.push(
      database
        ? {
            check: "data.local-database",
            area: "data",
            status: "compliant",
            message: `${compose.path} runs PostgreSQL`,
            subject,
            evidence: [read(compose.path)],
          }
        : {
            check: "data.local-database",
            area: "data",
            status: "noncompliant",
            message: `${compose.path} runs no PostgreSQL service`,
            subject,
            evidence: [read(compose.path)],
            next: {
              category: "project",
              text: "Add a PostgreSQL service to the Compose file for local development.",
            },
          },
    );
  }
  return findings;
}

/** Instructions and review skills, for a project set up for coding agents. */
function agentChecks(tree: Tree, agents: readonly (keyof typeof HOSTS)[]): AssessmentFinding[] {
  // A project may use no coding agent at all.
  if (agents.length === 0) return [];
  const findings = [
    expect(
      "agents.instructions",
      "agents",
      presence(tree, "AGENTS.md"),
      {
        found: "AGENTS.md tells coding agents how to work in the project",
        missing: "no AGENTS.md",
      },
      { category: "project", text: "Add an AGENTS.md with the project's checks and conventions." },
    ),
  ];
  for (const host of agents) {
    findings.push(
      expect(
        "agents.review-skills",
        "agents",
        firstPresent(
          tree,
          HOSTS[host].skills.map((directory) => `${directory}/liftoff-code-review/SKILL.md`),
        ),
        { found: `${host} has the review skills`, missing: `no review skills for ${host}` },
        {
          category: "unavailable",
          text: "Adding Liftoff's skills to an existing project comes with adopting it, in a later release.",
        },
        host,
      ),
    );
  }
  return findings;
}

function ciChecks(tree: Tree): AssessmentFinding[] {
  const workflowFiles = [...tree.entries]
    .filter(([file, kind]) => kind === "file" && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))
    .map(([file]) => file);
  if (workflowFiles.length === 0) {
    return [
      expect(
        "ci.workflows",
        "ci",
        // Not there, unless .github/workflows could not be listed.
        presence(tree, ".github/workflows/ci.yml"),
        { found: "", missing: "no GitHub Actions workflows" },
        {
          category: "project",
          text: "Add a pull request workflow that runs the project's checks.",
        },
      ),
    ];
  }
  const workflows: [string, Workflow][] = [];
  const unread: AssessmentFinding[] = [];
  for (const file of workflowFiles) {
    const workflow = parsed(tree, file, readWorkflow, "YAML");
    if ("status" in workflow) {
      unread.push({
        check: "ci.workflows",
        area: "ci",
        status: workflow.status,
        message: `could not read ${file}: ${workflow.reason}`,
        subject: file,
        evidence: [listed(file)],
        next: accessNext(workflow.status),
      });
    } else workflows.push([file, workflow.value]);
  }
  // A check none of the workflows read satisfies is unknown, not missing,
  // while some could not be read.
  const otherwise = unread.length > 0 ? "unknown" : "noncompliant";
  const some = (
    check: string,
    holds: (workflow: Workflow) => boolean,
    found: string,
    missing: string,
    next: string,
  ): AssessmentFinding => {
    const matching = workflows
      .filter(([, workflow]) => holds(workflow))
      .map(([file]) => read(file));
    return matching.length > 0
      ? { check, area: "ci", status: "compliant", message: found, evidence: matching }
      : {
          check,
          area: "ci",
          status: otherwise,
          message: unread.length > 0 ? `${missing} in the workflows that could be read` : missing,
          evidence: workflows.map(([file]) => read(file)),
          next: { category: "project", text: next },
        };
  };
  const unpinned = workflows.flatMap(([file, workflow]) =>
    workflow.uses.filter((used) => !pinned(used)).map((used) => `${used} in ${file}`),
  );
  return [
    ...unread,
    some(
      "ci.pull-request",
      (workflow) => workflow.onPullRequest,
      "a workflow runs on pull requests",
      "no workflow runs on pull requests",
      "Run the project's checks in a workflow on pull_request.",
    ),
    some(
      "ci.gate",
      (workflow) => workflow.jobs.includes("ci-gate"),
      "a ci-gate job gathers the required checks",
      "no ci-gate job",
      "Add a ci-gate job that fails unless every check it needs passed, and require only it.",
    ),
    some(
      "ci.codeql",
      (workflow) => workflow.uses.some((used) => used.startsWith("github/codeql-action/")),
      "CodeQL scans the code",
      "no CodeQL scan",
      "Add a CodeQL workflow.",
    ),
    some(
      "ci.dependency-review",
      (workflow) =>
        workflow.uses.some((used) => used.startsWith("actions/dependency-review-action")),
      "pull requests are checked for vulnerable dependencies",
      "no dependency review",
      "Add actions/dependency-review-action to the pull request workflow.",
    ),
    unpinned.length > 0
      ? {
          check: "ci.pinned-actions",
          area: "ci",
          status: "noncompliant",
          message: `${unpinned.length} action${unpinned.length === 1 ? " is" : "s are"} not pinned to a full commit SHA: ${unpinned.slice(0, 3).join("; ")}${unpinned.length > 3 ? "; …" : ""}`,
          evidence: workflows.map(([file]) => read(file)),
          next: { category: "project", text: "Pin every action to a full commit SHA." },
        }
      : {
          check: "ci.pinned-actions",
          area: "ci",
          status: unread.length > 0 ? "unknown" : "compliant",
          message:
            unread.length > 0
              ? "every action in the workflows that could be read is pinned to a full commit SHA"
              : "every action is pinned to a full commit SHA",
          evidence: workflows.map(([file]) => read(file)),
        },
  ];
}

/** Why no ruleset can be seen, when that is not because there are none. */
function rulesetsHidden(tree: Tree, hidden: Presence | undefined): Presence {
  const directory = presence(tree, ".github/rulesets");
  return directory.found === "unknown" ? directory : (hidden ?? { found: false });
}

/**
 * Governance declarations. A Liftoff project that selects the "none"
 * profile has no rulesets or GOVERNANCE.md by choice.
 */
function governanceChecks(tree: Tree, profile: string | undefined): AssessmentFinding[] {
  const rulesets = filesUnder(
    tree,
    ".github/rulesets",
    (file) => file.endsWith(".json") && parentOf(file) === ".github/rulesets",
  );
  const project = (text: string): NextAction => ({ category: "project", text });
  return [
    expect(
      "governance.review-policy",
      "governance",
      presence(tree, ".github/review-policy.yml"),
      {
        found: "a review policy sets each change's risk tier",
        missing: "no .github/review-policy.yml",
      },
      project("Add a review policy that maps paths to risk tiers."),
    ),
    profile === "none"
      ? {
          check: "governance.rulesets",
          area: "governance",
          status: "compliant",
          message: "liftoff.yaml selects no governance profile, so no rulesets are expected",
          evidence: [read("liftoff.yaml")],
        }
      : rulesets.files.length > 0
        ? {
            check: "governance.rulesets",
            area: "governance",
            status: "compliant",
            message: "the branch rules are committed as rulesets",
            evidence: rulesets.files.map(listed),
          }
        : expect(
            "governance.rulesets",
            "governance",
            rulesetsHidden(tree, rulesets.hidden),
            { found: "", missing: "no rulesets in .github/rulesets" },
            project("Commit the branch rules as rulesets in .github/rulesets."),
          ),
    expect(
      "governance.pr-template",
      "governance",
      firstPresent(tree, [
        ".github/pull_request_template.md",
        "pull_request_template.md",
        "docs/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE",
      ]),
      {
        found: "a pull request template asks for testing, risk and how to revert",
        missing: "no pull request template",
      },
      project("Add a pull request template with Testing, Risk and How to revert sections."),
    ),
    expect(
      "governance.review-guide",
      "governance",
      presence(tree, "REVIEW.md"),
      { found: "REVIEW.md tells reviewers what matters", missing: "no REVIEW.md" },
      project("Add a REVIEW.md that says what reviewers look for."),
    ),
    profile === "none"
      ? {
          check: "governance.document",
          area: "governance",
          status: "compliant",
          message: "liftoff.yaml selects no governance profile, so no GOVERNANCE.md is expected",
          evidence: [read("liftoff.yaml")],
        }
      : expect(
          "governance.document",
          "governance",
          presence(tree, "GOVERNANCE.md"),
          { found: "GOVERNANCE.md says how changes merge", missing: "no GOVERNANCE.md" },
          project("Add a GOVERNANCE.md that says how changes merge."),
        ),
    expect(
      "governance.dependabot",
      "governance",
      firstPresent(tree, [".github/dependabot.yml", ".github/dependabot.yaml"]),
      { found: "Dependabot keeps dependencies current", missing: "no Dependabot configuration" },
      project("Add .github/dependabot.yml."),
    ),
  ];
}

function infrastructureChecks(tree: Tree, part: Part): AssessmentFinding[] {
  const roots = filesUnder(tree, part.path, (file) => file.endsWith(".tf"))
    .files.map(parentOf)
    .filter((directory, index, all) => all.indexOf(directory) === index)
    // Modules are locked by the roots that use them.
    .filter((directory) => !directory.split("/").includes("modules"));
  const unlocked = roots.filter(
    (root) => presence(tree, within(root, ".terraform.lock.hcl")).found !== true,
  );
  const subject = `infrastructure at ${part.path}`;
  return [
    unlocked.length === 0
      ? {
          check: "infrastructure.provider-lock",
          area: "infrastructure",
          status: "compliant",
          message: "every root module locks its providers",
          subject,
          evidence: roots.map((root) => listed(within(root, ".terraform.lock.hcl"))),
        }
      : {
          check: "infrastructure.provider-lock",
          area: "infrastructure",
          status: "noncompliant",
          message: `no .terraform.lock.hcl in ${unlocked.join(", ")}`,
          subject,
          evidence: unlocked.map(listed),
          next: {
            category: "project",
            text: "Commit each root module's .terraform.lock.hcl (tofu init writes it).",
          },
        },
  ];
}

function liftoffChecks(state: LiftoffState): AssessmentFinding[] {
  // What validate found, other than whether this is a Liftoff project at
  // all: in a project that is not Liftoff's, only a change that stopped
  // part way, such as an adoption before liftoff.yaml was written.
  const validated = state.findings
    .filter((finding) =>
      state.kind === "project"
        ? finding.severity !== "info"
        : finding.code === "interrupted-change",
    )
    .map(
      (finding): AssessmentFinding => ({
        check: `liftoff.${finding.code}`,
        area: "liftoff",
        status: "noncompliant",
        message: finding.message,
        ...(finding.path === undefined ? {} : { subject: finding.path }),
        evidence: finding.path === undefined ? [] : [read(finding.path)],
        next: {
          category: "liftoff",
          text: "See what validate reports about the project's Liftoff files.",
          command: "liftoff validate",
        },
      }),
    );
  if (state.kind === "none") {
    return [
      {
        check: "liftoff.project",
        area: "liftoff",
        status: "noncompliant",
        message: "not a Liftoff project: there is no liftoff.yaml",
        evidence: [],
        next: {
          category: "unavailable",
          text: "Adopting an existing project into Liftoff comes in a later release.",
        },
      },
      ...validated,
    ];
  }
  if (state.kind === "pre-rebuild") {
    const { records } = state.inventory;
    const how = (record: (typeof records)[number]): Evidence => ({
      path: record.path,
      how: record.opened ? "read" : "listed",
    });
    return [
      {
        check: "liftoff.project",
        area: "liftoff",
        status: "unsupported",
        message: `made by a Liftoff release before the rebuild, which left ${records.length} record${records.length === 1 ? "" : "s"}; this release changes and runs nothing in it`,
        evidence: records.map(how),
        next: {
          category: "unavailable",
          text: "Adopting a project from before the rebuild comes in a later release.",
        },
      },
      ...records
        .filter((record) => record.blocks !== undefined)
        .map(
          (record): AssessmentFinding => ({
            check: "liftoff.unfinished",
            area: "liftoff",
            status: "noncompliant",
            message: record.blocks ?? "",
            subject: record.path,
            evidence: [how(record)],
            next: {
              category: "project",
              text: "Finish or undo the old release's change with that release.",
            },
          }),
        ),
      ...validated,
    ];
  }
  if (validated.length > 0) return validated;
  return [
    {
      check: "liftoff.files",
      area: "liftoff",
      status: "compliant",
      message: "the configuration is valid and every file Liftoff manages is as Liftoff wrote it",
      evidence: [read("liftoff.yaml"), read(".liftoff/manifest.json")],
    },
  ];
}

function githubChecks(state: GitHubState): { findings: AssessmentFinding[]; gaps: Gap[] } {
  if (state.kind === "not-requested") {
    return {
      findings: [],
      gaps: [
        {
          kind: "not-checked",
          detail:
            "GitHub's branches, rulesets and check runs were not read; assess with --live to read them",
        },
      ],
    };
  }
  if (state.kind === "failed") {
    return {
      findings: [
        {
          check: "github.repository",
          area: "github",
          status: state.status,
          message: `could not read ${state.repository ?? "the repository"} on GitHub: ${state.reason}`,
          evidence: [],
          next:
            state.status === "inaccessible"
              ? {
                  category: "access",
                  text: "Sign in with `gh auth login` as someone who can read the repository, then assess again.",
                }
              : {
                  category: "project",
                  text: "Fix what stopped GitHub from being read, then assess again.",
                },
        },
      ],
      gaps: [],
    };
  }
  const evidence = [{ path: state.repository, how: "github" as const }];
  return {
    findings: state.checkpoints.map(
      (checkpoint): AssessmentFinding => ({
        check: `github.${checkpoint.id}`,
        area: "github",
        status: checkpoint.status === "done" ? "compliant" : "noncompliant",
        message: `${checkpoint.title}: ${checkpoint.detail}`,
        evidence,
        ...(checkpoint.status === "done"
          ? {}
          : {
              next: checkpoint.action
                ? {
                    category: "liftoff",
                    text: "Activate the governance one checkpoint at a time.",
                    command: "liftoff governance apply-next",
                  }
                : { category: "project", text: checkpoint.todo ?? checkpoint.detail },
            }),
      }),
    ),
    gaps: [],
  };
}

/** Assesses a walked project against this release's standard. */
export function assess(
  tree: Tree,
  state: { readonly git: boolean; readonly liftoff: LiftoffState; readonly github: GitHubState },
): Assessment {
  const detected = detectParts(tree);
  const agents = detectAgents(tree);
  const findings: AssessmentFinding[] = [...liftoffChecks(state.liftoff), ...detected.findings];
  for (const part of detected.parts) {
    findings.push(
      part.supported
        ? {
            check: "structure.part",
            area: "structure",
            status: "compliant",
            message: `${part.component} on ${part.stack}, which this release supports`,
            subject: part.path,
            evidence: part.evidence,
          }
        : {
            check: "structure.part",
            area: "structure",
            status: "unsupported",
            message: `${/^[aeiou]/.test(part.component) ? "an" : "a"} ${part.component} on ${part.stack}, which this release does not support`,
            subject: part.path,
            evidence: part.evidence,
            next: {
              category: "unavailable",
              text: "This release has no standard for this part, so it is not checked further.",
            },
          },
    );
  }
  if (detected.parts.length === 0 && detected.findings.length === 0) {
    findings.push({
      check: "structure.part",
      area: "structure",
      status: "unknown",
      message: "found no application, frontend or infrastructure declaration",
      evidence: [],
      next: {
        category: "project",
        text: "Check the gaps: the application may be somewhere the assessment did not walk.",
      },
    });
  }
  for (const part of detected.parts.filter((candidate) => candidate.supported)) {
    findings.push(
      ...(part.component === "infrastructure"
        ? infrastructureChecks(tree, part)
        : partChecks(tree, part, detected)),
    );
  }
  findings.push(
    ...agentChecks(tree, agents),
    ...ciChecks(tree),
    ...governanceChecks(
      tree,
      state.liftoff.kind === "project" ? state.liftoff.governance : undefined,
    ),
  );
  findings.push(
    expect(
      "docs.readme",
      "docs",
      presence(tree, "README.md"),
      { found: "README.md explains the project", missing: "no README.md" },
      { category: "project", text: "Add a README.md." },
    ),
  );
  const github = githubChecks(state.github);
  findings.push(...github.findings);

  const ordered = findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) => AREAS.indexOf(a.finding.area) - AREAS.indexOf(b.finding.area) || a.index - b.index,
    )
    .map(({ finding }) => finding);
  const gaps = [...tree.gaps, ...github.gaps];
  const next = new Map<string, NextAction & { checks: string[] }>();
  const nextFor = (action: NextAction, check: string) => {
    const key = `${action.category}\u0000${action.text}\u0000${action.command ?? ""}`;
    const known = next.get(key) ?? { ...action, checks: [] };
    if (!known.checks.includes(check)) known.checks.push(check);
    next.set(key, known);
  };
  for (const finding of ordered) if (finding.next) nextFor(finding.next, finding.check);
  if (gaps.some((gap) => gap.kind === "inaccessible")) {
    nextFor(accessNext("inaccessible"), "gaps");
  }
  const summary = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const finding of ordered) summary[finding.status]++;
  return {
    git: state.git,
    liftoff: state.liftoff.kind,
    parts: detected.parts,
    workflows: detectWorkflows(tree),
    agents,
    findings: ordered,
    gaps,
    next: [...next.values()].sort(
      (a, b) => NEXT_CATEGORIES.indexOf(a.category) - NEXT_CATEGORIES.indexOf(b.category),
    ),
    summary,
  };
}
