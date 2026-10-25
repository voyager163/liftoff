import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { generate } from "../../src/application/init/generation.ts";
import { type ProjectConfig, validateConfig } from "../../src/domain/project/config.ts";
import { parseManifest } from "../../src/domain/project/manifest.ts";
import { parsePolicy } from "../../src/domain/risk-policy/policy.ts";
import { GenerationError, generateProject } from "../../src/generators/project.ts";
import { renderTemplate } from "../../src/generators/template.ts";
import type {
  GenerationContext,
  ProjectPlugin,
} from "../../src/plugins/contracts/project-plugin.ts";
import { resolveSelection } from "../../src/plugins/registry.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const goldenDir = path.join(repoRoot, "tests/fixtures/golden");

const config = (overrides: Record<string, unknown> = {}): ProjectConfig =>
  validateConfig({
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

const CASES: Record<string, Record<string, unknown>> = {
  "manual-no-agents": {},
  "all-agents": {
    agents: ["copilot", "codex", "claude"],
    review: { ai: true },
    owners: ["octocat"],
  },
  "copilot-only": { agents: ["copilot"], review: { ai: true } },
  "claude-no-governance": { agents: ["claude"], review: { ai: true }, governance: "none" },
  "node-copilot": { stack: "node-fastify", agents: ["copilot"], review: { ai: true } },
  "go-codex": { stack: "go-huma", agents: ["codex"], review: { ai: true } },
  "team-two-owners": {
    governance: "team-gitflow",
    owners: ["alice", "bob"],
    agents: ["claude"],
    review: { ai: true },
  },
  "risk-tiered-copilot": {
    governance: "risk-tiered-gitflow",
    agents: ["copilot"],
    review: { ai: true },
  },
};

const files = async (overrides: Record<string, unknown> = {}) =>
  (await generate(assets, config(overrides), "0.0.0")).files;
const byPath = async (overrides: Record<string, unknown> = {}) =>
  new Map((await files(overrides)).map((file) => [file.path, file]));

describe("PROJ-004 deterministic, collision-free generation", () => {
  it.each(Object.keys(CASES))("matches the golden file inventory for %s", async (name) => {
    const inventory = (await files(CASES[name]))
      .map((file) => `${file.path} ${file.ownership} ${file.sha256}`)
      .join("\n");
    const golden = path.join(goldenDir, `${name}.txt`);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, `${inventory}\n`);
    expect(inventory).toBe(readFileSync(golden, "utf8").trimEnd());
  });

  it("reads only templates that Git tracks", () => {
    // A template file that .gitignore matches works locally but is missing
    // from every checkout and release.
    const ignored = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "assets"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(ignored.split("\n").filter(Boolean)).toEqual([]);
  });

  it("generates the same bytes twice", async () => {
    const first = await files(CASES["all-agents"]);
    const second = await files(CASES["all-agents"]);
    expect(second).toEqual(first);
  });

  const context = async (): Promise<{ context: GenerationContext; plugins: ProjectPlugin[] }> => {
    const selection = resolveSelection(config());
    return {
      plugins: [...selection.plugins],
      context: {
        config: config(),
        liftoffVersion: "0.0.0",
        hosts: [],
        profile: selection.profile,
        stack: selection.stack,
        templates: { read: () => "", list: () => [] },
        skills: [],
        agents: [],
        ciBundles: {},
      },
    };
  };

  const plugin = (id: string, paths: string[]): ProjectPlugin => ({
    id,
    kind: "common",
    version: "1",
    summary: "",
    templateRoots: [],
    artifacts: () => paths.map((p) => ({ path: p, ownership: "seeded", content: "x" })),
  });

  it("refuses two plugins writing the same path", async () => {
    const { context: ctx } = await context();
    const selection = {
      ...resolveSelection(config()),
      plugins: [plugin("a", ["x.txt"]), plugin("b", ["x.txt"])],
    };
    expect(() => generateProject(selection, ctx)).toThrow("b and a both write x.txt");
  });

  it.each([
    "/abs",
    "a/../b",
    "a\\b",
    "C:/x",
    "a//b",
    "./a",
    "liftoff.yaml",
    ".liftoff/manifest.json",
  ])("refuses the unsafe or reserved path %s", async (unsafe) => {
    const { context: ctx } = await context();
    const selection = { ...resolveSelection(config()), plugins: [plugin("p", [unsafe])] };
    expect(() => generateProject(selection, ctx)).toThrow(GenerationError);
  });

  it("fails on unknown template placeholders", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept verbatim.
    const actions = "${{ github.ref }}";
    expect(renderTemplate(`a {{liftoff.name}} ${actions}`, { name: "x" }, "t")).toBe(
      `a x ${actions}`,
    );
    expect(() => renderTemplate("{{liftoff.nope}}", {}, "t.md")).toThrow(
      "t.md: unknown placeholder {{liftoff.nope}}",
    );
  });
});

describe("PROJ-002 the generated manifest", () => {
  it("lists every other file with its hash and plugin, and no absolute paths", async () => {
    const generated = await files(CASES["all-agents"]);
    const manifestFile = generated.find((file) => file.path === ".liftoff/manifest.json");
    const manifest = parseManifest(manifestFile?.content ?? "");
    expect(manifest.files.map((f) => f.path)).toEqual(
      generated.filter((file) => file !== manifestFile).map((file) => file.path),
    );
    for (const entry of manifest.files) {
      expect(generated.find((file) => file.path === entry.path)?.sha256).toBe(entry.sha256);
    }
    expect(manifest.generatedBy.liftoff).toBe("0.0.0");
    for (const file of generated) {
      expect(file.content).not.toContain(repoRoot);
      expect(file.content).not.toMatch(/\/Users\/|C:\\Users\\/);
    }
  });
});

describe("PROJ-005 the Python API project contract", () => {
  it("contains the application, migrations, tests, lock, Dockerfile and Compose file", async () => {
    const project = await byPath();
    for (const required of [
      "backend/app/main.py",
      "backend/app/health.py",
      "backend/app/config.py",
      "backend/migrations/versions/20261025_0001_create_items.py",
      "backend/tests/test_health.py",
      "backend/tests/test_config.py",
      "backend/uv.lock",
      "backend/Dockerfile",
      "compose.yaml",
      "README.md",
      ".env.example",
      ".github/workflows/01-pr-ci.yml",
      ".github/workflows/02-codeql.yml",
      ".github/dependabot.yml",
    ]) {
      expect(project.has(required), required).toBe(true);
    }
    const text = (p: string) => project.get(p)?.content ?? "";
    expect(text("backend/app/config.py")).toContain("port: int = 8000");
    expect(text("backend/app/health.py")).toContain('@router.get("/ready"');
    expect(text("backend/app/main.py")).toContain("get_scalar_api_reference");
    expect(text("backend/app/main.py")).toContain('title="demo API"');
    expect(text("backend/pyproject.toml")).toContain('"--cov-fail-under=80"');
    expect(text("backend/Dockerfile")).toContain("USER 10001");
    expect(text("backend/Dockerfile")).toMatch(/FROM python:[^\s]+@sha256:[0-9a-f]{64}/);
    expect(text("compose.yaml")).toContain("name: demo");
    expect(text(".env.example")).not.toMatch(/PASSWORD=(?!change-me)/);
    expect(text("backend/pyproject.toml")).not.toMatch(
      /pydantic-ai|openai|anthropic|langfuse|pgvector/i,
    );
    expect(text(".github/workflows/01-pr-ci.yml")).toContain("name: ci-gate");
  });

  it("keeps generated text free of leftover placeholders", async () => {
    for (const file of await files(CASES["all-agents"])) {
      expect(file.content, file.path).not.toMatch(/\{\{liftoff\./);
    }
  });
});

describe("PROJ-009 the Node.js API project contract", () => {
  it("contains the application, migration, tests, lock, Dockerfile and Compose file", async () => {
    const project = await byPath({ stack: "node-fastify" });
    for (const required of [
      "backend/src/app.ts",
      "backend/src/health.ts",
      "backend/src/config.ts",
      "backend/src/server.ts",
      "backend/drizzle/0000_create_items.sql",
      "backend/drizzle/meta/_journal.json",
      "backend/test/health.test.ts",
      "backend/test/config.test.ts",
      "backend/test/integration/postgresql.test.ts",
      "backend/package.json",
      "backend/package-lock.json",
      "backend/Dockerfile",
      "compose.yaml",
      "README.md",
      ".env.example",
      ".github/workflows/01-pr-ci.yml",
      ".github/workflows/02-codeql.yml",
      ".github/dependabot.yml",
    ]) {
      expect(project.has(required), required).toBe(true);
    }
    const text = (p: string) => project.get(p)?.content ?? "";
    expect(text("backend/src/config.ts")).toContain("port: 8000");
    expect(text("backend/src/health.ts")).toContain('"/health/ready"');
    expect(text("backend/src/health.ts")).toContain("query_timeout");
    expect(text("backend/src/app.ts")).toContain("@scalar/fastify-api-reference");
    expect(text("backend/src/app.ts")).toContain('title: "demo API"');
    expect(text("backend/vitest.config.ts")).toContain(
      "thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 }",
    );
    expect(text("backend/Dockerfile")).toContain("USER 10001");
    expect(text("backend/Dockerfile")).toMatch(/FROM node:[^\s]+@sha256:[0-9a-f]{64}/);
    expect(text("compose.yaml")).toContain('command: ["node", "src/migrate.ts"]');
    const lock = JSON.parse(text("backend/package-lock.json"));
    const pkg = JSON.parse(text("backend/package.json"));
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
    for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
      for (const version of Object.values(dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(text("backend/package.json")).not.toMatch(/ai-sdk|openai|anthropic|langfuse|pgvector/i);
    expect(text(".github/workflows/01-pr-ci.yml")).toContain("name: ci-gate");
    expect(text(".github/workflows/02-codeql.yml")).toContain("javascript-typescript");
    expect(text(".github/dependabot.yml")).toContain("package-ecosystem: npm");
  });

  it("gets only its own stack's files and ignores", async () => {
    const node = [...(await byPath({ stack: "node-fastify" })).keys()];
    expect(node.filter((p) => p.endsWith(".py") || p.endsWith("uv.lock"))).toEqual([]);
    const python = [...(await byPath()).keys()];
    expect(python.filter((p) => p.endsWith(".ts") || p.endsWith("package.json"))).toEqual([]);
    expect((await byPath()).get("backend/.gitignore")?.content).toContain(".venv/");
    expect((await byPath({ stack: "node-fastify" })).get("backend/.gitignore")?.content).toContain(
      "node_modules/",
    );
  });
});

describe("PROJ-010 the Go API project contract", () => {
  it("contains the binary, migration, tests, modules, Dockerfile and Compose file", async () => {
    const project = await byPath({ stack: "go-huma" });
    for (const required of [
      "backend/cmd/api/main.go",
      "backend/internal/config/config.go",
      "backend/internal/health/health.go",
      "backend/internal/server/server.go",
      "backend/internal/database/migrations/00001_create_items.sql",
      "backend/internal/integration/postgresql_test.go",
      "backend/tools/coverage/main.go",
      "backend/go.mod",
      "backend/go.sum",
      "backend/Dockerfile",
      "compose.yaml",
      "README.md",
      ".env.example",
      ".github/workflows/01-pr-ci.yml",
      ".github/workflows/02-codeql.yml",
      ".github/dependabot.yml",
    ]) {
      expect(project.has(required), required).toBe(true);
    }
    const text = (p: string) => project.get(p)?.content ?? "";
    expect(text("backend/internal/config/config.go")).toContain("Port:                   8000");
    expect(text("backend/internal/health/health.go")).toContain('Path:        "/health/ready"');
    expect(text("backend/internal/health/health.go")).toContain("statement_timeout");
    expect(text("backend/internal/server/server.go")).toContain("huma.DocsRendererScalar");
    expect(text("backend/internal/server/server.go")).toContain('huma.DefaultConfig("demo API"');
    expect(text("backend/internal/database/migrations/00001_create_items.sql")).toContain(
      "-- +goose Down",
    );
    expect(text("backend/Dockerfile")).toContain("USER 10001:10001");
    expect(text("backend/Dockerfile")).toMatch(/FROM golang:[^\s]+@sha256:[0-9a-f]{64}/);
    expect(text("backend/Dockerfile")).toMatch(
      /FROM gcr\.io\/distroless\/[^\s]+@sha256:[0-9a-f]{64}/,
    );
    expect(text("compose.yaml")).toContain('command: ["migrate"]');
    const ci = text(".github/workflows/01-pr-ci.yml");
    expect(ci).toContain("go run ./tools/coverage cover.out 80");
    // A cached result would pass without contacting PostgreSQL.
    expect(ci).toContain("go test -count=1 -tags integration ./internal/integration");
    expect(ci).toContain("name: ci-gate");
    expect(ci).toMatch(/actions\/setup-go@[0-9a-f]{40} /);
    expect(text(".github/workflows/02-codeql.yml")).toContain("language: go");
    expect(text(".github/dependabot.yml")).toContain("package-ecosystem: gomod");
    const modules = text("backend/go.mod");
    for (const module of [
      "github.com/danielgtaylor/huma/v2",
      "github.com/go-chi/chi/v5",
      "github.com/jackc/pgx/v5",
      "github.com/pressly/goose/v3",
    ]) {
      expect(modules).toContain(module);
    }
    expect(modules).not.toMatch(/openai|anthropic|langfuse|pgvector|genai/i);
  });

  it("gets only Go files for its backend", async () => {
    const paths = [...(await byPath({ stack: "go-huma" })).keys()];
    expect(
      paths.filter((p) => /\.(py|ts)$|package\.json|uv\.lock/.test(p) && p.startsWith("backend/")),
    ).toEqual([]);
  });
});

describe("PROJ-007 coding-agent files", () => {
  it("adds nothing for a manual project without agents", async () => {
    const paths = [...(await byPath()).keys()];
    expect(
      paths.filter((p) =>
        /^(AGENTS\.md|CLAUDE\.md|\.claude\/|\.agents\/|\.codex\/|\.github\/(skills|agents)\/)/.test(
          p,
        ),
      ),
    ).toEqual([]);
    expect(paths).not.toContain(".github/workflows/04-ai-review.yml");
  });

  it("renders each host natively, including the setup skill", async () => {
    const project = await byPath(CASES["all-agents"]);
    for (const p of [
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/skills/liftoff-setup/SKILL.md",
      ".agents/skills/liftoff-code-review/SKILL.md",
      ".claude/agents/liftoff-verifier.md",
      ".github/agents/liftoff-verifier.agent.md",
      ".codex/agents/liftoff-verifier.toml",
    ]) {
      expect(project.has(p), p).toBe(true);
    }
    expect(project.get("AGENTS.md")?.content).toContain(
      "| `backend` | `uv run pytest` | Tests with coverage |",
    );
    expect(project.get(".github/liftoff/review-agent.sh")?.content).toContain("copilot -p");
    const workflow = project.get(".github/workflows/04-ai-review.yml")?.content ?? "";
    expect(workflow).toContain("secrets.COPILOT_GITHUB_TOKEN");
    expect(workflow).toContain('REVIEW_AGENT_CLI: "@github/copilot@');
  });

  it("uses the configured engine and leaves AI review out when it is off", async () => {
    const claude = await byPath({
      agents: ["copilot", "claude"],
      review: { ai: true, engine: "claude" },
    });
    expect(claude.get(".github/liftoff/review-agent.sh")?.content).toContain("claude -p");
    expect(claude.get(".github/workflows/04-ai-review.yml")?.content).toContain(
      "secrets.ANTHROPIC_API_KEY",
    );
    const off = await byPath({ agents: ["claude"], review: { ai: false } });
    expect(off.has(".github/workflows/04-ai-review.yml")).toBe(false);
    expect(off.has(".github/liftoff/ai-review.mjs")).toBe(false);
    expect(off.has(".github/workflows/03-review-policy.yml")).toBe(true);
  });
});

describe("PROJ-012 team and risk-tiered profiles", () => {
  const pullRequestRule = (content: string | undefined) =>
    JSON.parse(content ?? "{}").rules.find((rule: { type: string }) => rule.type === "pull_request")
      .parameters;

  it("requires one approval on every team change, from a code owner when there are two", async () => {
    const team = await byPath(CASES["team-two-owners"]);
    for (const branch of ["develop", "main"]) {
      expect(pullRequestRule(team.get(`.github/rulesets/${branch}.json`)?.content)).toMatchObject({
        required_approving_review_count: 1,
        require_last_push_approval: true,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
      });
    }
    expect(parsePolicy(team.get(".github/review-policy.yml")?.content ?? "").profile).toBe(
      "team-gitflow",
    );
    const governance = team.get("GOVERNANCE.md")?.content ?? "";
    expect(governance).toContain("required approvals: low 1, medium 1,\n   high 2");
    expect(governance).toContain("## Approvals");
    expect(governance).toContain("not the author");
    expect(governance).toContain("require one of them to approve");
    expect(team.get(".github/CODEOWNERS")?.content).toContain("* @alice @bob");
  });

  it("never requires a code owner's approval that a single owner could not give", async () => {
    const oneOwner = await byPath({ governance: "team-gitflow", owners: ["alice"] });
    expect(pullRequestRule(oneOwner.get(".github/rulesets/develop.json")?.content)).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: false,
    });
    expect(oneOwner.get("GOVERNANCE.md")?.content).toContain("names one owner");
    const noOwners = await byPath({ governance: "team-gitflow" });
    expect(noOwners.has(".github/CODEOWNERS")).toBe(false);
    expect(noOwners.get("GOVERNANCE.md")?.content).toContain("No code owners were given");
  });

  it("lets the review policy require risk-tiered approvals by tier", async () => {
    const tiered = await byPath({
      governance: "risk-tiered-gitflow",
      owners: ["alice", "bob"],
    });
    // Low-risk changes need no approval, so the rulesets require none.
    expect(pullRequestRule(tiered.get(".github/rulesets/develop.json")?.content)).toMatchObject({
      required_approving_review_count: 0,
      require_last_push_approval: false,
      require_code_owner_review: false,
      dismiss_stale_reviews_on_push: true,
    });
    expect(parsePolicy(tiered.get(".github/review-policy.yml")?.content ?? "").profile).toBe(
      "risk-tiered-gitflow",
    );
    const governance = tiered.get("GOVERNANCE.md")?.content ?? "";
    expect(governance).toContain("required approvals: low 0, medium 1,\n   high 2");
    expect(governance).toContain("## Approvals");
    // The text matches the rulesets: owners are requested, not required.
    expect(governance).toContain("do not require a code owner's");
    expect(governance).not.toContain("require one of them to approve");
  });

  it("keeps the single-maintainer handoff free of approval rules", async () => {
    const single = await byPath({ owners: ["alice", "bob"] });
    expect(single.get("GOVERNANCE.md")?.content).not.toContain("## Approvals");
    expect(pullRequestRule(single.get(".github/rulesets/develop.json")?.content)).toMatchObject({
      required_approving_review_count: 0,
      require_code_owner_review: false,
    });
  });
});

describe("PROJ-008 governance handoff", () => {
  it("writes rulesets and drift checks for GitFlow, and CODEOWNERS only with owners", async () => {
    const project = await byPath(CASES["all-agents"]);
    const develop = JSON.parse(project.get(".github/rulesets/develop.json")?.content ?? "{}");
    const main = JSON.parse(project.get(".github/rulesets/main.json")?.content ?? "{}");
    expect(develop.rules.map((r: { type: string }) => r.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
      "code_scanning",
      "copilot_code_review",
    ]);
    expect(main.rules[2].parameters.allowed_merge_methods).toEqual(["merge"]);
    expect(
      develop.rules[3].parameters.required_status_checks.map((c: { context: string }) => c.context),
    ).toEqual(["ci-gate", "review-policy"]);
    expect(project.get(".github/CODEOWNERS")?.content).toContain("* @octocat");
    expect(project.get("GOVERNANCE.md")?.content).toContain(
      "Copilot code review comments on every pull request",
    );
    expect(project.has(".github/workflows/90-governance-drift.yml")).toBe(true);
    expect(project.get(".github/workflows/03-review-policy-refresh.yml")?.content).toContain(
      "gh workflow run 03-review-policy.yml",
    );
    expect(project.has(".github/workflows/03-review-submitted.yml")).toBe(true);
    expect((await byPath()).has(".github/CODEOWNERS")).toBe(false);
    expect((await byPath()).get("GOVERNANCE.md")?.content).not.toContain("Copilot");
  });

  it("generates a policy that parses, with the stack's rules and owners trusted", async () => {
    const policyText =
      (await byPath(CASES["all-agents"])).get(".github/review-policy.yml")?.content ?? "";
    const policy = parsePolicy(policyText);
    expect(policy.profile).toBe("single-maintainer-gitflow");
    expect(policy.trusted_authors).toEqual(["octocat"]);
    expect(policy.rules.find((r) => r.paths.includes("backend/migrations/**"))?.always_human).toBe(
      true,
    );
    expect((await byPath()).get(".github/review-policy.yml")?.content).toContain(
      "Add your GitHub login",
    );
  });

  it("generates no governance files for the none profile", async () => {
    const project = await byPath(CASES["claude-no-governance"]);
    expect(
      [...project.keys()].filter((p) => /GOVERNANCE|rulesets|CODEOWNERS|governance-drift/.test(p)),
    ).toEqual([]);
    expect(project.get("README.md")?.content).not.toContain("GOVERNANCE.md");
    expect(parse(project.get("liftoff.yaml")?.content ?? "").governance).toBe("none");
  });
});
