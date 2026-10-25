import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { deliveryPlugin } from "../../src/plugins/builtin/delivery.ts";
import { vueFrontend } from "../../src/plugins/builtin/frontends/vue.ts";
import { maturityMarkdown, PATTERN_LIST } from "../../src/plugins/builtin/patterns.ts";
import type {
  ComponentPlugin,
  GenerationContext,
  ProjectPlugin,
} from "../../src/plugins/contracts/project-plugin.ts";
import { resolveSelection, STACKS } from "../../src/plugins/registry.ts";

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
  "genai-rag-copilot": {
    workload: "genai",
    stack: "python-pydanticai",
    pattern: "rag",
    agents: ["copilot"],
    review: { ai: true },
  },
  "go-vue-azure": {
    stack: "go-huma",
    frontend: "vue",
    infrastructure: "azure",
    environments: ["dev", "staging", "prod"],
    agents: ["claude"],
    review: { ai: true },
  },
  "node-vue-copilot": {
    stack: "node-fastify",
    frontend: "vue",
    agents: ["copilot"],
    review: { ai: true },
  },
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
  "openspec-claude": { workflow: "openspec", agents: ["claude"], review: { ai: true } },
  "spec-kit-codex-copilot": {
    workflow: "spec-kit",
    agents: ["codex", "copilot"],
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
        workflow: selection.workflow,
        stack: selection.stack,
        pattern: selection.pattern,
        frontend: selection.frontend,
        infrastructure: selection.infrastructure,
        environments: selection.environments,
        components: selection.components,
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
    expect(governance).toContain("enforce 1 approval on every change");
    expect(governance).toContain("anyone with write access could also publish it");
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
    expect(governance).toContain("enforce no approval on every change");
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

describe("PROJ-013 the Vue frontend", () => {
  const vue = { stack: "node-fastify", frontend: "vue", agents: ["claude"], review: { ai: true } };

  it("contains the application, tests, lock, container and web server", async () => {
    const project = await byPath(vue);
    for (const required of [
      "frontend/index.html",
      "frontend/src/main.ts",
      "frontend/src/App.vue",
      "frontend/src/api.ts",
      "frontend/src/__tests__/App.test.ts",
      "frontend/e2e/smoke.spec.ts",
      "frontend/package.json",
      "frontend/package-lock.json",
      "frontend/vite.config.ts",
      "frontend/vitest.config.ts",
      "frontend/playwright.config.ts",
      "frontend/eslint.config.js",
      "frontend/Dockerfile",
      "frontend/nginx/default.conf.template",
    ]) {
      expect(project.has(required), required).toBe(true);
    }
    const text = (p: string) => project.get(p)?.content ?? "";
    expect(text("frontend/index.html")).toContain("<title>demo</title>");
    expect(text("frontend/src/App.vue")).toContain('const title = "demo";');
    expect(text("frontend/src/api.ts")).toContain('const API = "/api";');
    expect(text("frontend/vite.config.ts")).toContain(
      'rewrite: (path: string) => path.replace(/^\\/api/, "")',
    );
    expect(text("frontend/vitest.config.ts")).toContain(
      "thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 }",
    );
    const nginx = text("frontend/nginx/default.conf.template");
    // A recreated API container gets a new address, so nginx resolves it per request.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: nginx template variables, kept verbatim.
    expect(nginx).toContain("resolver ${NGINX_LOCAL_RESOLVERS} valid=10s;");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: nginx template variables, kept verbatim.
    expect(nginx).toContain("set $api_upstream ${API_UPSTREAM};");
    expect(nginx).toContain("rewrite ^/api/(.*)$ /$1 break;");
    expect(nginx).toContain("proxy_pass $api_upstream;");
    expect(nginx).toContain(`Content-Security-Policy "default-src 'self';`);
    const dockerfile = text("frontend/Dockerfile");
    expect(dockerfile).toMatch(/FROM node:\S+@sha256:[0-9a-f]{64} AS build/);
    expect(dockerfile).toMatch(/FROM nginxinc\/nginx-unprivileged:\S+@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1");
    expect(text("frontend/.node-version")).toBe(
      readFileSync(path.join(repoRoot, ".node-version"), "utf8"),
    );

    const pkg = JSON.parse(text("frontend/package.json"));
    const lock = JSON.parse(text("frontend/package-lock.json"));
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
    for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
      for (const version of Object.values(dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const packages = lock.packages as Record<string, { resolved?: string; inBundle?: boolean }>;
    for (const [name, entry] of Object.entries(packages)) {
      if (name === "" || entry.inBundle) continue;
      expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });

  it("adds the frontend to Compose, CI, CodeQL, Dependabot and the README", async () => {
    const project = await byPath(vue);
    const yaml = (p: string) => parse(project.get(p)?.content ?? "");
    const compose = yaml("compose.yaml");
    expect(Object.keys(compose.services)).toEqual(["database", "migrate", "api", "web"]);
    expect(compose.services.web).toMatchObject({
      build: "./frontend",
      ports: ["127.0.0.1:8080:8080"],
      depends_on: { api: { condition: "service_healthy" } },
    });
    const ci = yaml(".github/workflows/01-pr-ci.yml");
    expect(Object.keys(ci.jobs)).toEqual([
      "lint",
      "test",
      "integration",
      "image",
      "frontend-lint",
      "frontend-test",
      "frontend-browser",
      "branch-policy",
      "release-lineage",
      "dependencies",
      "ci-gate",
    ]);
    const browser = ci.jobs["frontend-browser"].steps.map((step: { run?: string }) => step.run);
    expect(browser).toContain("npm run test:e2e");
    const codeql = project.get(".github/workflows/02-codeql.yml")?.content ?? "";
    expect(parse(codeql).jobs.analyze.strategy.matrix.include).toEqual([
      { language: "javascript-typescript", "build-mode": "none" },
      { language: "actions", "build-mode": "none" },
    ]);
    expect(codeql.replaceAll("\n# ", " ")).toContain(
      "for the TypeScript code, the frontend's TypeScript and Vue code and the GitHub Actions workflows.",
    );
    const python = parse(
      (await byPath({ frontend: "vue" })).get(".github/workflows/02-codeql.yml")?.content ?? "",
    );
    expect(
      python.jobs.analyze.strategy.matrix.include.map(
        (entry: { language: string }) => entry.language,
      ),
    ).toEqual(["python", "javascript-typescript", "actions"]);
    const updates = yaml(".github/dependabot.yml").updates.map(
      (update: Record<string, string>) => `${update["package-ecosystem"]} ${update.directory}`,
    );
    expect(updates).toEqual([
      "npm /backend",
      "docker /backend",
      "npm /frontend",
      "docker /frontend",
      "github-actions /",
    ]);
    const readme = project.get("README.md")?.content ?? "";
    expect(readme.indexOf("## Frontend")).toBeGreaterThan(readme.indexOf("## Checks"));
    expect(readme.indexOf("## Frontend")).toBeLessThan(readme.indexOf("## How changes are made"));
  });

  it("adds the frontend's checks, layout and review rules", async () => {
    const project = await byPath(vue);
    const agents = project.get("AGENTS.md")?.content ?? "";
    expect(agents).toContain(
      "TypeScript API with Fastify, Drizzle ORM and npm; Vue frontend with Vite, Tailwind CSS and TypeScript.",
    );
    expect(agents).toContain("| `frontend` | `npm run test:e2e` |");
    expect(agents).toContain("- `frontend/src/` the Vue application and its unit tests.");
    const policy = parsePolicy(project.get(".github/review-policy.yml")?.content ?? "");
    expect(policy.rules.find((rule) => rule.paths.includes("frontend/nginx/**"))?.tier).toBe(
      "high",
    );
  });

  it("adds nothing for a frontend by default", async () => {
    const project = await byPath({ stack: "node-fastify" });
    expect([...project.keys()].filter((p) => p.startsWith("frontend/"))).toEqual([]);
    expect(Object.keys(parse(project.get("compose.yaml")?.content ?? "").services)).toEqual([
      "database",
      "migrate",
      "api",
    ]);
    expect(project.get(".github/workflows/01-pr-ci.yml")?.content).not.toContain("frontend");
    expect(project.get("README.md")?.content).not.toContain("## Frontend");
  });
});

describe("PROJ-014 shared files are assembled from each component's parts", () => {
  it.each([
    [{}],
    [{ frontend: "vue" }],
    [{ stack: "node-fastify" }],
    [{ stack: "go-huma", frontend: "vue" }],
  ])("makes ci-gate need every other job for %j", async (overrides) => {
    const ci = parse(
      (await byPath(overrides)).get(".github/workflows/01-pr-ci.yml")?.content ?? "",
    );
    const jobs = Object.keys(ci.jobs).filter((job) => job !== "ci-gate");
    expect(ci.jobs["ci-gate"].needs).toEqual(jobs);
    expect(jobs).toContain("dependencies");
  });

  it.each([
    [{}],
    [{ governance: "none" }],
    [{ stack: "node-fastify", frontend: "vue" }],
    [{ stack: "go-huma", frontend: "vue" }],
  ])("links the README only to files the project has, for %j", async (overrides) => {
    const project = await byPath(overrides);
    const readme = project.get("README.md")?.content ?? "";
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(([, target]) => (target ?? "").replace(/#.*$/, "").replace(/\/$/, ""))
      .filter((target) => target !== "" && !/^[a-z]+:/.test(target));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const found =
        project.has(target) || [...project.keys()].some((p) => p.startsWith(`${target}/`));
      expect(found, target).toBe(true);
    }
  });

  const VALID: Record<string, string> = {
    "a/compose.yaml": "api:\n  image: a\n",
    "a/ci-jobs.yml": "lint:\n  runs-on: ubuntu-latest\n",
    "a/dependabot.yml": "- package-ecosystem: npm\n  directory: /a\n",
    "a/README.md": "# a\n",
    "b/compose.yaml":
      "web:\n  image: b\n  depends_on:\n    api:\n      condition: service_healthy\n",
    "b/ci-jobs.yml": "web-lint:\n  runs-on: ubuntu-latest\n",
    "b/dependabot.yml": "- package-ecosystem: npm\n  directory: /b\n",
    "b/README.md": "## b\n",
  };

  /** Runs the delivery plugin on two made-up components, a and b, with these parts. */
  const assemble = (parts: Record<string, string>) => {
    const stack = { ...STACKS["node-fastify"], id: "stack/a", parts: "a" } as ComponentPlugin;
    const frontend: ComponentPlugin = { ...vueFrontend, id: "frontend/b", parts: "b" };
    const selection = resolveSelection(config());
    const context: GenerationContext = {
      config: config(),
      liftoffVersion: "0.0.0",
      hosts: [],
      profile: selection.profile,
      workflow: selection.workflow,
      stack: selection.stack,
      pattern: undefined,
      frontend: undefined,
      infrastructure: undefined,
      environments: [],
      components: [stack, frontend],
      templates: {
        read: (p) => parts[p] ?? readFileSync(path.join(repoRoot, "assets", p), "utf8"),
        list: (directory) => Object.keys(parts).filter((p) => p.startsWith(`${directory}/`)),
      },
      skills: [],
      agents: [],
      ciBundles: {},
    };
    return () =>
      new Map(deliveryPlugin.artifacts(context).map((file) => [file.path, file.content]));
  };

  it("joins valid parts in component order", () => {
    const files = assemble(VALID)();
    expect(Object.keys(parse(files.get("compose.yaml") ?? "").services)).toEqual([
      "database",
      "api",
      "web",
    ]);
    expect(parse(files.get(".github/workflows/01-pr-ci.yml") ?? "").jobs["ci-gate"].needs).toEqual([
      "lint",
      "web-lint",
      "branch-policy",
      "release-lineage",
      "dependencies",
    ]);
    expect(files.get("README.md")).toMatch(/^# a\n\n## b\n\n## How changes are made\n/);
  });

  it.each([
    [{ "b/ci-jobs.yml": "lint: {}\n" }, 'frontend/b and stack/a both define the CI job "lint"'],
    [
      { "b/compose.yaml": "api:\n  image: b\n" },
      'frontend/b and stack/a both define the Compose service "api"',
    ],
    [
      { "b/ci-jobs.yml": "ci-gate: {}\n" },
      'frontend/b defines the CI job "ci-gate", which Liftoff adds itself',
    ],
    [
      { "b/ci-jobs.yml": "dependencies: {}\n" },
      'frontend/b defines the CI job "dependencies", which Liftoff adds itself',
    ],
    [
      { "b/compose.yaml": "database:\n  image: b\n" },
      'frontend/b defines the Compose service "database", which Liftoff adds itself',
    ],
    [
      { "b/dependabot.yml": "- package-ecosystem: npm\n  directory: /a\n" },
      'frontend/b and stack/a both define the Dependabot update "npm in /a"',
    ],
    [
      { "a/dependabot.yml": "- package-ecosystem: github-actions\n  directory: /\n" },
      'stack/a defines the Dependabot update "github-actions in /", which Liftoff adds itself',
    ],
    [
      { "b/compose.yaml": "web:\n  depends_on:\n    cache: {}\n" },
      `frontend/b's web service depends on unknown "cache"`,
    ],
    [{ "a/dependabot.yml": "npm: {}\n" }, "a/dependabot.yml must be a YAML list"],
    [{ "a/compose.yaml": "- api\n" }, "a/compose.yaml must be a YAML mapping"],
  ])("refuses parts that do not fit together %#", (change, message) => {
    expect(assemble({ ...VALID, ...change })).toThrow(message);
  });
});

describe("PROJ-015 Azure infrastructure as OpenTofu code", () => {
  const azure = {
    stack: "python-fastapi",
    frontend: "vue",
    infrastructure: "azure",
    environments: ["prod", "dev"],
    agents: ["claude"],
    review: { ai: true },
  };
  const base = "infrastructure/opentofu/azure";

  it("generates bootstrap, the modules and a root for each selected environment", async () => {
    const paths = [...(await byPath(azure)).keys()].filter((p) => p.startsWith(base));
    const roots = new Set(paths.map((p) => p.split("/").slice(3, 5).join("/")));
    expect([...roots].sort()).toEqual([
      ".gitignore",
      "bootstrap/.terraform.lock.hcl",
      "bootstrap/main.tf",
      "bootstrap/outputs.tf",
      "bootstrap/terraform.tfvars.example",
      "bootstrap/variables.tf",
      "bootstrap/versions.tf",
      "environments/dev",
      "environments/prod",
      "modules/app",
      "modules/naming",
    ]);
    for (const environment of ["dev", "prod"]) {
      for (const file of [
        ".terraform.lock.hcl",
        "backend.hcl.example",
        "main.tf",
        "outputs.tf",
        "terraform.tfvars.example",
        "variables.tf",
        "versions.tf",
      ]) {
        expect(paths, `${environment}/${file}`).toContain(
          `${base}/environments/${environment}/${file}`,
        );
      }
    }
    const project = await byPath(azure);
    expect(project.get(`${base}/bootstrap/variables.tf`)?.content).toContain(
      'environments = ["dev", "prod"]',
    );
  });

  it("gives each environment its settings and the stack's migrations and database URL", async () => {
    const project = await byPath(azure);
    const root = (environment: string) =>
      project.get(`${base}/environments/${environment}/main.tf`)?.content ?? "";
    expect(root("dev")).toContain('sku_name              = "B_Standard_B1ms"');
    expect(root("dev")).toContain("high_availability     = false");
    expect(root("dev")).toContain("api_min_replicas    = 0");
    expect(root("prod")).toContain('sku_name              = "GP_Standard_D2ds_v5"');
    expect(root("prod")).toContain("high_availability     = true");
    expect(root("prod")).toContain("backup_retention_days = 35");
    expect(root("prod")).toContain('migrate_command     = ["alembic", "upgrade", "head"]');
    expect(root("prod")).toContain('database_url_scheme = "postgresql+psycopg"');
    expect(project.get(`${base}/environments/prod/backend.hcl.example`)?.content).toContain(
      'key                  = "prod.tfstate"',
    );
    const node = await byPath({ ...azure, stack: "node-fastify", frontend: "none" });
    const nodeRoot = node.get(`${base}/environments/dev/main.tf`)?.content ?? "";
    expect(nodeRoot).toContain('migrate_command     = ["node", "src/migrate.ts"]');
    expect(nodeRoot).not.toContain("web_image");
    expect(node.get(`${base}/environments/dev/variables.tf`)?.content).not.toContain("web_image");
    expect(root("dev")).toContain("web_image = var.web_image");
  });

  it("grants state access, keeps a failover, and routes the frontend to the API in Azure", async () => {
    const project = await byPath(azure);
    const text = (file: string) => project.get(`${base}/${file}`)?.content ?? "";
    expect(text("bootstrap/main.tf")).toContain(
      'role_definition_name = "Storage Blob Data Contributor"',
    );
    expect(text("modules/app/main.tf")).toContain(
      "ignore_changes = [zone, high_availability[0].standby_availability_zone]",
    );
    expect(text("modules/app/main.tf")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an OpenTofu expression, kept verbatim.
      'value = "https://${azurerm_container_app.api.ingress[0].fqdn}"',
    );
    const nginx = project.get("frontend/nginx/default.conf.template")?.content ?? "";
    expect(nginx).toContain("proxy_set_header Host $proxy_host;");
    expect(nginx).toContain("proxy_ssl_server_name on;");
    expect(nginx).not.toContain("proxy_set_header Host $host;");
  });

  it("locks exactly the providers each root pins, for every platform", async () => {
    const project = await byPath(azure);
    const pins = (versions: string) =>
      Object.fromEntries(
        [...versions.matchAll(/source\s+= "hashicorp\/(\w+)"\s+version\s+= "([\d.]+)"/g)].map(
          ([, name, version]) => [name, version],
        ),
      );
    const locked = (lock: string) =>
      Object.fromEntries(
        [
          ...lock.matchAll(
            /provider "registry\.opentofu\.org\/hashicorp\/(\w+)" \{\s+version\s+= "([\d.]+)"/g,
          ),
        ].map(([, name, version]) => [name, version]),
      );
    for (const root of ["bootstrap", "environments/dev"]) {
      const text = (file: string) => project.get(`${base}/${root}/${file}`)?.content ?? "";
      expect(Object.keys(pins(text("versions.tf"))).length, root).toBeGreaterThan(0);
      expect(locked(text(".terraform.lock.hcl")), root).toEqual(pins(text("versions.tf")));
      // One h1 hash per platform: macOS arm64, Windows x64 and Linux x64.
      const hashes = /hashes = \[([^\]]*)\]/.exec(text(".terraform.lock.hcl"))?.[1] ?? "";
      expect(hashes.match(/"h1:/g)?.length ?? 0, root).toBeGreaterThanOrEqual(3);
    }
  });

  it("adds validation and a security scan to CI, provider updates and a review rule", async () => {
    const project = await byPath(azure);
    const ci = parse(project.get(".github/workflows/01-pr-ci.yml")?.content ?? "");
    expect(ci.jobs["ci-gate"].needs).toEqual(
      expect.arrayContaining(["infrastructure-validate", "infrastructure-scan"]),
    );
    const validate = ci.jobs["infrastructure-validate"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(validate).toContain("tofu fmt -check -recursive");
    expect(validate).toContain("-lockfile=readonly");
    const updates = parse(project.get(".github/dependabot.yml")?.content ?? "").updates;
    expect(updates).toContainEqual(
      expect.objectContaining({
        "package-ecosystem": "opentofu",
        directories: [`/${base}/bootstrap`, `/${base}/environments/*`],
      }),
    );
    const policy = parsePolicy(project.get(".github/review-policy.yml")?.content ?? "");
    expect(policy.rules.find((rule) => rule.paths.includes("infrastructure/**"))).toMatchObject({
      tier: "high",
      always_human: true,
    });
    expect(project.get("README.md")?.content).toContain("## Infrastructure");
    expect(project.get("AGENTS.md")?.content).toContain("tofu fmt -check -recursive");
  });

  it("adds nothing for infrastructure by default", async () => {
    const project = await byPath({ stack: "node-fastify" });
    expect([...project.keys()].filter((p) => p.startsWith("infrastructure/"))).toEqual([]);
    expect(project.get(".github/workflows/01-pr-ci.yml")?.content).not.toContain("tofu");
    expect(project.get(".github/dependabot.yml")?.content).not.toContain("opentofu");
  });
});

describe("PROJ-017 the GenAI project", () => {
  const genai = (pattern = "generic") => ({
    workload: "genai",
    stack: "python-pydanticai",
    pattern,
    agents: ["claude"],
    review: { ai: true },
  });

  it("is a FastAPI and PydanticAI API with offline defaults, a lock and a container", async () => {
    const project = await byPath(genai());
    const text = (p: string) => project.get(p)?.content ?? "";
    for (const required of [
      "backend/app/main.py",
      "backend/app/config.py",
      "backend/app/health.py",
      "backend/app/errors.py",
      "backend/app/ports/model.py",
      "backend/app/ports/tracing.py",
      "backend/app/pattern.py",
      "backend/tests/test_ports.py",
      "backend/tests/test_pattern.py",
      "backend/pyproject.toml",
      "backend/uv.lock",
      "backend/Dockerfile",
      "compose.yaml",
      ".env.example",
    ]) {
      expect(project.has(required), required).toBe(true);
    }
    expect(text("backend/app/config.py")).toContain('model: str = "test"');
    expect(text("backend/app/config.py")).toContain(
      'tracing: Literal["none", "langfuse"] = "none"',
    );
    expect(text("backend/pyproject.toml")).toContain('langfuse = ["langfuse>=5.0.2,<6"]');
    expect(text("backend/Dockerfile")).toContain("USER 10001");
    expect(text("backend/Dockerfile")).toMatch(/FROM python:\S+@sha256:[0-9a-f]{64}/);
    expect(text("backend/uv.lock")).toContain('name = "pydantic-ai-slim"');
    expect(text(".env.example")).toContain("APP_MODEL=test");
    expect(text(".env.example")).not.toContain("POSTGRES_PASSWORD");
  });

  it("has no database and no GenAI dependency leaks into API projects", async () => {
    const project = await byPath(genai());
    const compose = parse(project.get("compose.yaml")?.content ?? "");
    expect(Object.keys(compose.services)).toEqual(["api"]);
    expect(compose.volumes).toBeUndefined();
    expect([...project.keys()].filter((p) => /migrations|alembic|drizzle/.test(p))).toEqual([]);
    for (const stack of ["python-fastapi", "node-fastify", "go-huma"]) {
      const api = await byPath({ stack });
      const manifests = [...api.entries()]
        .filter(([p]) => /pyproject\.toml|package\.json|go\.mod/.test(p))
        .map(([, file]) => file.content)
        .join("\n");
      expect(manifests, stack).not.toMatch(/pydantic-ai|langfuse|openai|anthropic/);
    }
  });

  it("checks lint, format and offline tests in CI, and keeps the database out of Compose", async () => {
    const project = await byPath(genai());
    const ci = parse(project.get(".github/workflows/01-pr-ci.yml")?.content ?? "");
    expect(Object.keys(ci.jobs)).toEqual([
      "lint",
      "test",
      "image",
      "branch-policy",
      "release-lineage",
      "dependencies",
      "ci-gate",
    ]);
    expect(project.get("compose.yaml")?.content).toContain("# Local development: the application.");
    expect(project.get("README.md")?.content).toContain("## The model");
  });
});

describe("PROJ-018 GenAI patterns and their maturity", () => {
  it.each(PATTERN_LIST.map((pattern) => pattern.name))(
    "generates the %s pattern with its maturity in the README",
    async (name) => {
      const project = await byPath({
        workload: "genai",
        stack: "python-pydanticai",
        pattern: name,
      });
      const pattern = PATTERN_LIST.find((p) => p.name === name);
      expect(project.get("backend/app/pattern.py")?.content).toContain("def install(");
      expect(project.has("backend/tests/test_pattern.py")).toBe(true);
      const readme = project.get("README.md")?.content ?? "";
      expect(readme).toContain(`## Pattern: ${name}`);
      expect(readme).toContain(
        maturityMarkdown(
          pattern?.maturity ?? { level: "complete", implemented: [], notImplemented: [] },
        ),
      );
      expect(readme).not.toContain("{{liftoff.");
      const ports = [...project.keys()].filter((p) => p.startsWith("backend/app/ports/"));
      const messaging = ports.some((p) => p.endsWith("messaging.py"));
      expect(messaging, "messaging only where the pattern uses it").toBe(name === "workflow");
    },
  );

  it("lists every pattern in the committed maturity matrix", () => {
    const matrix = readFileSync(path.join(repoRoot, "docs/projects/genai-patterns.md"), "utf8");
    for (const pattern of PATTERN_LIST) {
      expect(matrix).toContain(`| \`${pattern.name}\` | ${pattern.maturity.level} |`);
      expect(pattern.maturity.implemented.length).toBeGreaterThan(0);
      expect(pattern.maturity.notImplemented.length).toBeGreaterThan(0);
    }
    expect(PATTERN_LIST.map((p) => p.name)).toEqual([
      "generic",
      "prompt",
      "chatbot",
      "rag",
      "agent",
      "multi-agent",
      "fine-tuned",
      "streaming",
      "workflow",
    ]);
  });
});

describe("FLOW-001 GitFlow projects check branches and release lineage in CI", () => {
  const ci = async (overrides: Record<string, unknown>) => {
    const generated = await byPath(overrides);
    const workflow = parse(generated.get(".github/workflows/01-pr-ci.yml")?.content ?? "") as {
      jobs: Record<
        string,
        {
          needs?: string[];
          permissions?: Record<string, string>;
          steps?: { env?: Record<string, string>; run?: string }[];
        }
      >;
    };
    return { generated, jobs: workflow.jobs };
  };

  it("adds both checks to CI and ci-gate, with the selected agents' branches", async () => {
    const { generated, jobs } = await ci({ agents: ["copilot", "codex"], review: { ai: true } });
    expect(jobs["ci-gate"]?.needs).toEqual(
      expect.arrayContaining(["branch-policy", "release-lineage"]),
    );
    const check = (step: { run?: string }) => step.run?.includes("branch-policy.mjs");
    const branch = jobs["branch-policy"]?.steps?.find(check);
    expect(branch?.run).toContain("node .github/liftoff/branch-policy.mjs branch\n");
    expect(branch?.env?.AUTOMATION_BRANCHES).toBe("dependabot,copilot,codex");
    expect(jobs["release-lineage"]?.steps?.find(check)?.run).toContain(
      "node .github/liftoff/branch-policy.mjs lineage\n",
    );
    // Both read the pull request through the API.
    for (const job of ["branch-policy", "release-lineage"]) {
      expect(jobs[job]?.permissions).toMatchObject({
        contents: "read",
        "pull-requests": "read",
      });
    }
    expect(generated.get(".github/liftoff/branch-policy.mjs")?.ownership).toBe("managed");
    // Both run the base branch's check, and run again when the description changes.
    const text = generated.get(".github/workflows/01-pr-ci.yml")?.content ?? "";
    expect(
      text.match(
        /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| steps\.pr\.outputs\.base \|\| github\.sha \}\}/g,
      ),
    ).toHaveLength(2);
    expect(text).toContain("types: [opened, synchronize, reopened, edited]");
  });

  // Runs the job's script in a checkout of the base branch holding `files`,
  // with node replaced by a function that prints what it was asked to run.
  const onBase = (script: string, files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "liftoff-base-"));
    try {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), content);
      }
      writeFileSync(path.join(dir, "check.sh"), `node() { echo "ran $*"; }\n${script}`);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "check.sh"], {
        cwd: dir,
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("lets only the pull request that adds the checks through without them", async () => {
    const { jobs } = await ci({});
    for (const [job, mode] of [
      ["branch-policy", "branch"],
      ["release-lineage", "lineage"],
    ] as const) {
      const script =
        jobs[job]?.steps?.find((step) => step.run?.includes("branch-policy.mjs"))?.run ?? "";
      const bundle = ".github/liftoff/branch-policy.mjs";
      const workflow = ".github/workflows/01-pr-ci.yml";
      const ran = onBase(script, { [bundle]: "", [workflow]: `run: node ${bundle}` });
      expect(ran).toEqual({ status: 0, stdout: `ran ${bundle} ${mode}\n` });

      const missing = onBase(script, { [workflow]: `run: node ${bundle}` });
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain("::error::The base branch's CI runs this check");

      for (const files of [{ [workflow]: "jobs: {}" }, {}]) {
        const first = onBase(script, files);
        expect(first.status).toBe(0);
        expect(first.stdout).toContain("::notice::The base branch does not have");
      }
    }
  });

  it("adds neither without a GitFlow profile", async () => {
    const { generated, jobs } = await ci({ governance: "none" });
    expect(Object.keys(jobs)).not.toContain("branch-policy");
    expect(jobs["ci-gate"]?.needs).not.toContain("release-lineage");
    expect(generated.has(".github/liftoff/branch-policy.mjs")).toBe(false);
  });
});

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

// Runs a workflow step's script with bash, after `shims`: shell functions
// standing in for gh, docker and the like, which record calls in $CALLS.
const runScript = (script: string, shims: string, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "liftoff-step-"));
  try {
    const calls = path.join(dir, "calls.txt");
    const output = path.join(dir, "output.txt");
    writeFileSync(path.join(dir, "step.sh"), `${shims}\n${script}`);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "step.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CALLS: calls,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "acme/app",
        ...env,
      },
    });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      status: result.status,
      stdout: result.stdout,
      calls: read(calls),
      output: read(output),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("FLOW-004 CI the release workflows start checks the pull request like GitHub's own", () => {
  // Runs a step that looks up the pull request, with gh printing `answer` as
  // `gh api --jq` would.
  const runStep = (step: Step | undefined, pullRequest: string, answer: string) =>
    runScript(step?.run ?? "", `gh() { printf '%s\\n' "$*" >> "$CALLS"; printf '${answer}'; }`, {
      PULL_REQUEST: pullRequest,
    });

  it("runs the branch checks from the dispatched pull request's base", async () => {
    const generated = await byPath({});
    const jobs = (
      parse(generated.get(".github/workflows/01-pr-ci.yml")?.content ?? "") as {
        jobs: Record<string, { steps: Step[] }>;
      }
    ).jobs;
    for (const job of ["branch-policy", "release-lineage"]) {
      const steps = jobs[job]?.steps ?? [];
      const find = steps.find((step) => step.id === "pr");
      expect(find?.if).toBe(
        "github.event_name == 'workflow_dispatch' && inputs.pull_request != ''",
      );
      expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(
        `\${{ github.event.pull_request.base.sha || steps.pr.outputs.base || github.sha }}`,
      );
      const found = runStep(find, "7", "base=b1\\n");
      expect(found).toMatchObject({ status: 0, output: "base=b1\n" });
      expect(found.calls).toBe('api repos/acme/app/pulls/7 --jq "base=\\(.base.sha)"\n');
      for (const bad of ["07", "7; true", "x"]) {
        const refused = runStep(find, bad, "");
        expect(refused.status).toBe(1);
        expect(refused.stdout).toContain("pull_request must be a pull request number");
        expect(refused.calls).toBe("");
      }
    }
  });

  it("reviews the dispatched pull request's dependencies between its base and head", async () => {
    const generated = await byPath({});
    const job = (
      parse(generated.get(".github/workflows/01-pr-ci.yml")?.content ?? "") as {
        jobs: { dependencies: { permissions: Record<string, string>; steps: Step[] } };
      }
    ).jobs.dependencies;
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const found = runStep(
      job.steps.find((step) => step.id === "pr"),
      "7",
      "base=b1\\nhead=h1\\n",
    );
    expect(found.output).toBe("base=b1\nhead=h1\n");
    const review = job.steps.find((step) =>
      step.uses?.startsWith("actions/dependency-review-action@"),
    );
    expect(review?.if).toBe("github.event_name == 'pull_request' || steps.pr.outputs.head != ''");
    expect(review?.with).toMatchObject({
      "base-ref": `\${{ steps.pr.outputs.base }}`,
      "head-ref": `\${{ steps.pr.outputs.head }}`,
    });
  });

  it("runs CodeQL for the dispatched pull request and reports on it", async () => {
    const generated = await byPath({});
    const codeql = parse(generated.get(".github/workflows/02-codeql.yml")?.content ?? "") as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: { analyze: { permissions: Record<string, string>; steps: Step[] } };
    };
    expect(Object.keys(codeql.on.workflow_dispatch.inputs)).toEqual(["pull_request"]);
    const { permissions, steps } = codeql.jobs.analyze;
    expect(permissions).toMatchObject({ "pull-requests": "read", "security-events": "write" });
    const found = runStep(
      steps.find((step) => step.id === "pr"),
      "7",
      "head=h1\\n",
    );
    expect(found.output).toBe("head=h1\nref=refs/pull/7/head\n");
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(
      `\${{ steps.pr.outputs.head }}`,
    );
    expect(
      steps.find((step) => step.uses?.startsWith("github/codeql-action/analyze@"))?.with,
    ).toMatchObject({ ref: `\${{ steps.pr.outputs.ref }}`, sha: `\${{ steps.pr.outputs.head }}` });
  });

  it("asks the release app's token to read the workflow runs it checks", async () => {
    // Without staging, and with it, where the release is qualified first.
    for (const options of [{}, { infrastructure: "azure", environments: ["staging"] }]) {
      const generated = await byPath(options);
      const release = parse(generated.get(".github/workflows/20-release.yml")?.content ?? "") as {
        jobs: { release: { steps: Step[] } };
      };
      const app = release.jobs.release.steps.find((step) => step.id === "app");
      expect(app?.with).toMatchObject({
        "permission-contents": "write",
        "permission-pull-requests": "write",
        "permission-actions": "read",
      });
    }
  });
});

describe("FLOW-003 GitFlow projects build once and release through main", () => {
  it("builds each image once, scans it with a checksum-verified Trivy and attests it", async () => {
    const generated = await byPath({ frontend: "vue" });
    const build = parse(generated.get(".github/workflows/10-build.yml")?.content ?? "") as {
      on: { push: { branches: string[] } };
      jobs: {
        image: {
          strategy: { matrix: { image: unknown[] } };
          env: Record<string, string>;
          steps: { uses?: string; run?: string }[];
        };
      };
    };
    expect(build.on.push.branches).toEqual(["develop", "hotfix/**"]);
    expect(build.jobs.image.strategy.matrix.image).toEqual([
      { name: "api", context: "backend" },
      { name: "web", context: "frontend" },
    ]);
    expect(build.jobs.image.env.TRIVY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const steps = build.jobs.image.steps;
    expect(steps.map((step) => step.uses ?? "").join("\n")).not.toContain("aquasecurity/");
    expect(steps.some((step) => step.run?.includes("sha256sum --check --strict"))).toBe(true);
    expect(steps.some((step) => step.run?.includes("--exit-code 1 --severity HIGH,CRITICAL"))).toBe(
      true,
    );
    for (const action of [
      "anchore/scan-action@",
      "actions/attest-build-provenance@",
      "actions/attest@",
    ]) {
      expect(steps.some((step) => step.uses?.startsWith(action))).toBe(true);
    }
    for (const file of ["11-after-build.yml", "20-release.yml", "30-after-release.yml"]) {
      expect(generated.get(`.github/workflows/${file}`)?.ownership).toBe("managed");
    }
    expect(generated.get(".github/liftoff/release.mjs")?.ownership).toBe("managed");
    const after = generated.get(".github/workflows/30-after-release.yml")?.content ?? "";
    expect(after).toContain("IMAGES: api web");
    const identify = (parse(after) as { jobs: { identify: { permissions: unknown } } }).jobs
      .identify;
    expect(identify.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(generated.get("GOVERNANCE.md")?.content).toContain("## Releases");
  });

  const workflowOf = async (file: string) =>
    parse((await byPath({})).get(`.github/workflows/${file}`)?.content ?? "") as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; needs?: string; permissions?: unknown; steps: Step[] }>;
    };

  it("keeps an image already built for the commit, finishing its attestations", async () => {
    const steps = (await workflowOf("10-build.yml")).jobs.image?.steps ?? [];
    const at = steps.findIndex((step) => step.id === "existing");
    expect(at).toBeGreaterThan(0);
    // Steps that make the image run only without one; the SBOM's, also
    // when an earlier run did not attest it.
    const sbom = ["Install Trivy", "Write the CycloneDX SBOM", "Attest what the image contains"];
    for (const step of steps.slice(at + 1)) {
      expect(step.if, step.name).toBe(
        sbom.includes(step.name ?? "")
          ? "steps.existing.outputs.sbom != 'true'"
          : "steps.existing.outputs.built != 'true'",
      );
    }
    expect(steps.at(-1)?.with?.["subject-digest"]).toBe(
      `\${{ steps.publish.outputs.digest || steps.existing.outputs.digest }}`,
    );

    const sha = "c".repeat(40);
    // docker answers the lookup with `inspect`; gh verifies the provenance
    // and, with --predicate-type, the SBOM.
    const look = (inspect: string, provenance: boolean, sbomAttested: boolean) =>
      runScript(
        steps[at]?.run ?? "",
        [
          `docker() { ${inspect}; }`,
          "gh() {",
          `  printf '%s\\n' "$*" >> "$CALLS"`,
          `  case "$*" in *--predicate-type*) ${sbomAttested} ;; *) ${provenance} ;; esac`,
          "}",
        ].join("\n"),
        { IMAGE: "ghcr.io/acme/app/api", GITHUB_SHA: sha },
      );
    const found = `printf '"sha256:abc"\\n'`;

    const missing = look(
      "echo 'ERROR: ghcr.io/acme/app/api:x: not found' >&2; return 1",
      true,
      true,
    );
    expect(missing).toMatchObject({ status: 0, output: "", calls: "" });

    const unreachable = look("echo 'ERROR: i/o timeout' >&2; return 1", true, true);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stdout).toContain("Could not look up ghcr.io/acme/app/api");

    const kept = look(found, true, true);
    expect(kept).toMatchObject({
      status: 0,
      output: "digest=sha256:abc\nbuilt=true\nsbom=true\n",
    });
    expect(kept.calls.split("\n")[0]).toBe(
      `attestation verify oci://ghcr.io/acme/app/api@sha256:abc --repo acme/app --signer-workflow acme/app/.github/workflows/10-build.yml --source-digest ${sha}`,
    );
    expect(kept.calls).toContain("--predicate-type https://cyclonedx.org/bom");

    const noSbom = look(found, true, false);
    expect(noSbom).toMatchObject({ status: 0, output: "digest=sha256:abc\nbuilt=true\n" });
    expect(noSbom.stdout).toContain("attesting the SBOM an earlier run did not");

    const unverified = look(found, false, true);
    expect(unverified).toMatchObject({ status: 1, output: "" });
    expect(unverified.stdout).toContain("It is kept, not replaced");
  });

  it("starts CI again for pull requests into main once Build passes", async () => {
    const after = await workflowOf("11-after-build.yml");
    expect(after.on).toEqual({ workflow_run: { workflows: ["Build"], types: ["completed"] } });
    const recheck = after.jobs.recheck;
    expect(recheck?.if).toBe("github.event.workflow_run.conclusion == 'success'");
    expect(recheck?.permissions).toEqual({ actions: "write", "pull-requests": "read" });
    const script = recheck?.steps[0]?.run ?? "";
    const shims = `gh() { printf '%s\\n' "$*" >> "$CALLS"; [ "$1" != api ] || printf '%b' "$PULLS"; }`;
    const env = { HEAD_SHA: "c".repeat(40) };
    const started = runScript(script, shims, {
      ...env,
      PULLS: "21\\trelease/1.2.0\\n22\\thotfix/1.2.1\\n",
    });
    expect(started.status).toBe(0);
    expect(started.calls).toContain("api --paginate repos/acme/app/pulls?state=open&base=main");
    expect(started.calls.split("\n").filter((call) => call.startsWith("workflow"))).toEqual([
      "workflow run 01-pr-ci.yml --repo acme/app --ref release/1.2.0 -f pull_request=21",
      "workflow run 01-pr-ci.yml --repo acme/app --ref hotfix/1.2.1 -f pull_request=22",
    ]);
    const none = runScript(script, shims, { ...env, PULLS: "" });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("No open pull request into main");
    expect(runScript(script, "gh() { return 1; }", env).status).not.toBe(0);
  });

  it("builds only the API without a frontend, and nothing without a GitFlow profile", async () => {
    const api = await byPath({ workload: "genai", stack: "python-pydanticai", pattern: "generic" });
    expect(api.get(".github/workflows/30-after-release.yml")?.content).toContain("IMAGES: api\n");
    const none = await byPath({ governance: "none" });
    for (const file of [
      "10-build.yml",
      "11-after-build.yml",
      "20-release.yml",
      "30-after-release.yml",
    ]) {
      expect(none.has(`.github/workflows/${file}`)).toBe(false);
    }
    expect(none.has(".github/liftoff/release.mjs")).toBe(false);
  });
});

describe("FLOW-007 projects with infrastructure deploy by digest, and fail closed until set up", () => {
  type Job = {
    if?: string;
    uses?: string;
    needs?: string[] | string;
    with?: Record<string, string>;
    steps?: { name?: string; uses?: string; run?: string }[];
  };
  const workflow = (files: Map<string, { content: string }>, name: string) =>
    parse(files.get(`.github/workflows/${name}`)?.content ?? "") as { jobs: Record<string, Job> };

  it("deploys dev from develop, qualifies staging before a release, and production on request", async () => {
    const files = await byPath({
      frontend: "vue",
      infrastructure: "azure",
      environments: ["dev", "staging", "prod"],
    });
    const build = workflow(files, "10-build.yml");
    expect(build.jobs["deploy-dev"]).toMatchObject({
      if: "github.ref == 'refs/heads/develop' && vars.AZURE_DEPLOYMENTS == 'on'",
      uses: "./.github/workflows/reusable-deploy.yml",
      with: { environment: "dev", candidate: "${{ github.sha }}" },
    });
    const release = workflow(files, "20-release.yml");
    expect(Object.keys(release.jobs)).toEqual(["candidate", "staging", "qualify", "release"]);
    expect(release.jobs.staging).toMatchObject({ if: "vars.AZURE_DEPLOYMENTS == 'on'" });
    const qualify = (release.jobs.qualify?.steps ?? [])
      .map((step) => step.run ?? step.uses ?? "")
      .join("\n");
    expect(qualify).toContain("npm run test:e2e");
    expect(qualify).toContain("zaproxy/action-baseline@");
    expect(release.jobs.release?.if).toContain("needs.qualify.result == 'success'");
    const production = workflow(files, "50-production.yml");
    expect(production.jobs.deploy).toMatchObject({
      uses: "./.github/workflows/reusable-deploy.yml",
      with: { environment: "prod" },
    });
    const deploy = files.get(".github/workflows/reusable-deploy.yml")?.content ?? "";
    expect(deploy).toContain("Deploy target not configured for ${ENVIRONMENT}");
    expect(deploy).toContain("APP_URL AZURE_WEB_APP; do");
    expect(deploy).toContain('"${APP_URL}/api/health/ready"');
    expect(files.get(".github/liftoff/resolve-images.sh")?.ownership).toBe("managed");
  });

  it("deploys only to the environments the infrastructure has", async () => {
    const prodOnly = await byPath({ infrastructure: "azure", environments: ["prod"] });
    expect(Object.keys(workflow(prodOnly, "10-build.yml").jobs)).toEqual(["image"]);
    expect(Object.keys(workflow(prodOnly, "20-release.yml").jobs)).toEqual(["release"]);
    expect(prodOnly.has(".github/workflows/50-production.yml")).toBe(true);
    expect(prodOnly.get(".github/workflows/reusable-deploy.yml")?.content).toContain(
      '"${APP_URL}/health/ready"',
    );
    const none = await byPath({});
    for (const file of ["reusable-deploy.yml", "50-production.yml"]) {
      expect(none.has(`.github/workflows/${file}`)).toBe(false);
    }
    expect(Object.keys(workflow(none, "10-build.yml").jobs)).toEqual(["image"]);
  });
});
