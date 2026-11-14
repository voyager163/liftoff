import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { generate } from "../../src/application/init/generation.ts";
import { REGISTRY } from "../../src/cli/registry.ts";
import { runCli } from "../../src/cli/run.ts";
import {
  type ProjectConfig,
  parseConfig,
  serializeConfig,
  validateConfig,
} from "../../src/domain/project/config.ts";
import { resolveSelection, SelectionError } from "../../src/plugins/registry.ts";
import { captureIo } from "../helpers/io.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);

const config = (overrides: Record<string, unknown> = {}): ProjectConfig =>
  validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "go-huma",
    workflow: "manual",
    agents: ["claude"],
    governance: "single-maintainer-gitflow",
    review: { ai: true },
    ...overrides,
  });

const project = async (overrides: Record<string, unknown> = {}) =>
  new Map(
    (await generate(assets, config(overrides), "0.0.0")).files.map((file) => [
      file.path,
      file.content,
    ]),
  );
const AI = { frontend: "vue", ai: { pattern: "rag" } };

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-ai-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const exec = async (argv: string[]) => {
  const io = captureIo(work);
  const code = await runCli(argv, io, REGISTRY, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join("") };
};
const PLAN = ["plan", "--name", "demo", "--workflow", "manual", "--json"];

describe("AISVC-001 an API project may have one AI service, beside a stack that supports it", () => {
  it("records the AI service and its pattern, generic by default", async () => {
    const generic = await exec([...PLAN, "--stack", "go-huma", "--ai"]);
    expect(generic.code).toBe(0);
    expect(JSON.parse(generic.out).plan.config.ai).toEqual({ pattern: "generic" });
    const rag = await exec([...PLAN, "--stack", "go-huma", "--ai", "--ai-pattern", "rag"]);
    expect(JSON.parse(rag.out).plan.config.ai).toEqual({ pattern: "rag" });
    const without = await exec([...PLAN, "--stack", "go-huma"]);
    expect(JSON.parse(without.out).plan.config.ai).toBeUndefined();
  });

  it("says in liftoff capabilities beside which stacks it is available", async () => {
    const { code, out } = await exec(["capabilities", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).aiService).toEqual({ stacks: ["go-huma"], defaultPattern: "generic" });
  });

  it("writes and reads it in liftoff.yaml, with or without a pattern", () => {
    for (const ai of [{ pattern: "rag" }, {}]) {
      const written = serializeConfig(config({ ai }));
      expect(written).toContain(ai.pattern === undefined ? "ai: {}\n" : "ai:\n  pattern: rag\n");
      expect(parseConfig(written).ai).toEqual(ai);
    }
    expect(serializeConfig(config())).not.toMatch(/^ai:/m);
    expect(() => config({ ai: { pattern: "rag", model: "x" } })).toThrow(/ai/);
  });

  it("refuses an AI service where it does not belong, and says what is not available yet", async () => {
    expect((await exec([...PLAN, "--stack", "go-huma", "--ai-pattern", "rag"])).code).toBe(2);
    const genai = await exec([...PLAN, "--workload", "genai", "--ai"]);
    expect(genai.code).toBe(2);
    expect(genai.err).toContain("a genai project is one already");
    const unknown = () => resolveSelection(config({ ai: { pattern: "astrology" } }));
    expect(unknown).toThrow('unknown AI service pattern "astrology"');
    for (const [argv, message] of [
      [["--stack", "node-fastify", "--ai"], "not available beside node-fastify"],
      [["--stack", "python-fastapi", "--ai"], "not available beside python-fastapi"],
      [["--stack", "go-huma", "--ai", "--infrastructure", "azure"], "with azure infrastructure"],
    ] as const) {
      const refused = await exec([...PLAN, ...argv]);
      expect(refused.code, argv.join(" ")).toBe(6);
      expect(refused.err).toContain(message);
    }
    try {
      resolveSelection(config({ stack: "node-fastify", ai: {} }));
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionError);
      expect((error as SelectionError).unsupported).toBe(true);
    }
  });
});

describe("AISVC-002 the AI service is the GenAI stack, in its own directory", () => {
  it("puts the GenAI stack and the pattern in ai-service/, and leaves the backend as it is", async () => {
    const files = await project(AI);
    const genai = await generate(
      assets,
      config({
        workload: "genai",
        stack: "python-pydanticai",
        pattern: "rag",
        agents: [],
        review: { ai: false },
      }),
      "0.0.0",
    );
    const genaiBackend = genai.files.filter((file) => file.path.startsWith("backend/"));
    expect(genaiBackend.length).toBeGreaterThan(10);
    for (const file of genaiBackend) {
      const moved = `ai-service/${file.path.slice("backend/".length)}`;
      expect(files.get(moved), moved).toBe(file.content);
    }
    const plain = await project({ frontend: "vue" });
    const backend = (map: Map<string, string>) =>
      [...map].filter(([file]) => file.startsWith("backend/"));
    expect(backend(files)).toEqual(backend(plain));
    expect([...files.keys()].filter((file) => file.startsWith("ai-service/app/pattern"))).toEqual([
      "ai-service/app/pattern.py",
    ]);
  });

  it("runs the AI service in Compose with no published port, and no service waits for it", async () => {
    const files = await project(AI);
    const compose = parse(files.get("compose.yaml") ?? "") as {
      services: Record<string, { build?: string; ports?: unknown; depends_on?: object }>;
    };
    const service = compose.services["ai-service"];
    expect(service?.build).toBe("./ai-service");
    expect(service?.ports).toBeUndefined();
    for (const [name, other] of Object.entries(compose.services)) {
      expect(Object.keys(other.depends_on ?? {}), name).not.toContain("ai-service");
    }
    expect(files.get(".env.example")).toContain("APP_MODEL=test");
  });
});

describe("AISVC-003 Liftoff's shared files cover the AI service", () => {
  it("adds the AI service's CI jobs, which ci-gate needs, beside the backend's", async () => {
    const files = await project(AI);
    const ci = parse(files.get(".github/workflows/01-pr-ci.yml") ?? "") as {
      jobs: Record<
        string,
        { needs?: string[]; defaults?: { run?: { "working-directory"?: string } } }
      >;
    };
    for (const job of ["ai-lint", "ai-test", "ai-image"]) {
      expect(ci.jobs[job]?.defaults?.run?.["working-directory"], job).toBe("ai-service");
      expect(ci.jobs["ci-gate"]?.needs).toContain(job);
    }
    for (const job of ["lint", "test", "integration", "image"]) {
      expect(ci.jobs[job]?.defaults?.run?.["working-directory"], job).toBe("backend");
    }
  });

  it("covers it in CodeQL, Dependabot, the review policy, AGENTS.md, the README and the images", async () => {
    const files = await project(AI);
    const read = (file: string) => files.get(file) ?? "";
    expect(read(".github/workflows/02-codeql.yml")).toContain("language: python");
    const dependabot = parse(read(".github/dependabot.yml")) as {
      updates: { "package-ecosystem": string; directory: string }[];
    };
    expect(
      dependabot.updates
        .filter((update) => update.directory === "/ai-service")
        .map((update) => update["package-ecosystem"]),
    ).toEqual(["uv", "docker"]);
    expect(read(".github/review-policy.yml")).toContain("ai-service/app/ports/**");
    expect(read("AGENTS.md")).toContain("`ai-service/` the AI service");
    expect(read("AGENTS.md")).toContain("| `ai-service` | `uv run pytest` |");
    expect(read("README.md")).toContain("## The AI service");
    expect(read("README.md")).toContain("around the rag");
    const build = parse(read(".github/workflows/10-build.yml")) as {
      jobs: Record<
        string,
        { strategy?: { matrix?: { image?: { name: string; context: string }[] } } }
      >;
    };
    const images = Object.values(build.jobs).flatMap((job) => job.strategy?.matrix?.image ?? []);
    expect(images).toContainEqual({ name: "ai-service", context: "ai-service" });
    expect(read(".github/workflows/30-after-release.yml")).toContain("IMAGES: api ai-service web");
  });

  it("is a project that liftoff validate finds as Liftoff made it", async () => {
    const created = await exec([
      "init",
      "--name",
      "demo",
      "--stack",
      "go-huma",
      "--ai",
      "--ai-pattern",
      "rag",
      "--workflow",
      "manual",
      "--yes",
    ]);
    expect(created.code, created.err).toBe(0);
    const validated = await exec(["validate", "--dir", "demo", "--json"]);
    expect(validated.err).not.toContain("unknown-plugin");
    expect(validated.code, validated.out).toBe(0);
  });

  it("points its documentation at the AI service's directory, never the backend's", async () => {
    for (const [pattern, directory] of [
      ["rag", "ai-service/app/documents"],
      ["prompt", "ai-service/app/prompts"],
    ] as const) {
      const files = await project({ ai: { pattern } });
      const readme = files.get("README.md") ?? "";
      expect(readme, pattern).toContain(directory);
      expect(readme, pattern).not.toMatch(/backend\/app\/(documents|prompts)/);
      expect(files.get("AGENTS.md"), pattern).toContain(`\`${directory}/\``);
      expect(files.get("AGENTS.md"), pattern).not.toMatch(
        /backend\/app\/(documents|prompts|pattern)/,
      );
    }
  });

  it("adds nothing for an AI service to a project without one", async () => {
    const files = await project({ frontend: "vue" });
    expect([...files.keys()].some((file) => file.startsWith("ai-service/"))).toBe(false);
    expect(files.get(".github/workflows/01-pr-ci.yml")).not.toContain("ai-lint");
  });
});
