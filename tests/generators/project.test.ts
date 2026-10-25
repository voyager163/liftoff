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
