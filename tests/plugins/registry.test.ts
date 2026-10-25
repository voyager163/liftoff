import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/domain/project/config.ts";
import {
  chooseEngine,
  REVIEW_ENGINES,
  reviewAgentScript,
} from "../../src/plugins/builtin/review/engines.ts";
import {
  allPlugins,
  FRONTENDS,
  resolveSelection,
  SelectionError,
  STACKS,
} from "../../src/plugins/registry.ts";

const config = (overrides: Record<string, unknown> = {}) =>
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

describe("PROJ-003 selections are checked first", () => {
  it.each(["single-maintainer-gitflow", "team-gitflow", "risk-tiered-gitflow", "none"])(
    "resolves the %s profile",
    (governance) => {
      expect(resolveSelection(config({ governance })).profile).toBe(governance);
    },
  );

  it("resolves a supported selection in generation order", () => {
    const selection = resolveSelection(config({ agents: ["codex", "copilot"] }));
    expect(selection.stack.id).toBe("stack/python-fastapi");
    expect(selection.hosts).toEqual(["codex", "copilot"]);
    expect(selection.plugins.map((p) => p.id)).toEqual([
      "common/repository",
      "stack/python-fastapi",
      "common/delivery",
      "workflow/manual",
      "agents/integration",
      "review/layered",
      "governance/single-maintainer-gitflow",
    ]);
    expect(selection.frontend).toBeUndefined();
    expect(selection.components).toEqual([selection.stack]);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "refuses the inherited property name %s as a stack, frontend, workflow or agent",
    (name) => {
      for (const [field, value, message] of [
        ["stack", name, `unknown stack "${name}"`],
        ["frontend", name, `unknown frontend "${name}"`],
        ["workflow", name, `unknown workflow "${name}"`],
        ["agents", [name], `unknown agent "${name}"`],
      ] as const) {
        expect(() => resolveSelection(config({ [field]: value })), field).toThrow(message);
      }
    },
  );

  it("has components that share a tool ask for the same minimum version", () => {
    const tools = [...Object.values(STACKS), ...Object.values(FRONTENDS)].flatMap((c) => c.tools);
    for (const tool of tools) {
      const same = tools.filter((other) => other.command === tool.command);
      expect(new Set(same.map((other) => other.minimum)).size, tool.command).toBe(1);
    }
  });

  it("places a selected frontend after the stack", () => {
    const selection = resolveSelection(config({ stack: "go-huma", frontend: "vue" }));
    expect(selection.frontend?.id).toBe("frontend/vue");
    expect(selection.components.map((c) => c.id)).toEqual(["stack/go-huma", "frontend/vue"]);
    expect(selection.plugins.map((p) => p.id).slice(1, 4)).toEqual([
      "stack/go-huma",
      "frontend/vue",
      "common/delivery",
    ]);
  });

  it.each([
    [{ workload: "genai" }, /unknown workload "genai"/, false],
    [{ stack: "rust-axum" }, /unknown stack "rust-axum"/, false],
    [{ frontend: "react" }, /unknown frontend "react"; available: none, vue/, false],
    [{ workflow: "waterfall" }, /unknown workflow "waterfall"/, false],
    [{ workflow: "openspec" }, /OpenSpec workflow is not available in this release yet/, true],
    [{ workflow: "spec-kit" }, /Spec Kit workflow is not available/, true],
    [{ agents: ["cursor"] }, /unknown agent "cursor"/, false],
    [{ governance: "anarchy" }, /unknown governance profile/, false],
    [
      { agents: ["claude"], review: { ai: true, engine: "codex" } },
      /must be one of the selected agents/,
      false,
    ],
    [{ review: { ai: true } }, /needs at least one coding agent/, false],
  ])("rejects %j", (overrides, message, unsupported) => {
    const error = (() => {
      try {
        resolveSelection(config(overrides));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SelectionError);
    expect((error as Error).message).toMatch(message);
    expect((error as SelectionError).unsupported).toBe(unsupported);
  });

  it("lists every plugin once", () => {
    const ids = allPlugins().map((plugin) => plugin.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("governance/none");
  });
});

describe("PROJ-007 choosing the review engine", () => {
  it("prefers the configured host, then Copilot, Claude and Codex", () => {
    expect(chooseEngine(["codex", "claude"], "codex")?.host).toBe("codex");
    expect(chooseEngine(["codex", "claude"])?.host).toBe("claude");
    expect(chooseEngine(["codex", "copilot", "claude"])?.host).toBe("copilot");
    expect(chooseEngine(["codex"])?.host).toBe("codex");
    expect(chooseEngine([])).toBeUndefined();
    expect(chooseEngine(["claude"], "copilot")).toBeUndefined();
  });

  it.each(Object.values(REVIEW_ENGINES))("$host runs read-only with a pinned CLI", (engine) => {
    const script = reviewAgentScript(engine);
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(script).toContain("set -euo pipefail");
    expect(engine.cli).toMatch(/@\d+\.\d+\.\d+$/);
    const readOnly = {
      copilot: ["--deny-tool 'shell'", "--deny-tool 'write'", "--deny-tool 'url'"],
      claude: ["--tools 'Read,Grep,Glob'", "--permission-mode dontAsk"],
      codex: ["--sandbox read-only"],
    };
    for (const flag of readOnly[engine.host]) expect(script).toContain(flag);
    expect(script).not.toMatch(/--allow-all|Bash\(|--allowedTools/);
  });
});
