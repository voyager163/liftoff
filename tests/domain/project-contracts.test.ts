import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  PlanError,
  parsePlan,
  sealPlan,
  sha256Hex,
} from "../../src/domain/plan/plan.ts";
import {
  ConfigError,
  isStandardLayout,
  layoutOf,
  parseConfig,
  serializeConfig,
  validateConfig,
} from "../../src/domain/project/config.ts";
import {
  type Manifest,
  ManifestError,
  parseManifest,
  serializeManifest,
} from "../../src/domain/project/manifest.ts";

const config = {
  schema: "liftoff.config/v1",
  name: "demo",
  workload: "api",
  stack: "python-fastapi",
  workflow: "manual",
  agents: ["claude"],
  governance: "none",
  review: { ai: true },
  owners: ["octocat"],
};

describe("PROJ-001 project configuration", () => {
  it("round-trips through YAML to the same bytes", () => {
    const parsed = validateConfig(config);
    const text = serializeConfig(parsed);
    expect(parseConfig(text)).toEqual(parsed);
    expect(serializeConfig(parseConfig(text))).toBe(text);
    expect(text.startsWith("# Liftoff project configuration")).toBe(true);
  });

  it("defaults owners and the frontend, and keeps an explicit review engine", () => {
    const { owners: _owners, ...withoutOwners } = config;
    expect(validateConfig(withoutOwners).owners).toEqual([]);
    expect(validateConfig(config).frontend).toBe("none");
    expect(validateConfig(config).infrastructure).toBe("none");
    expect(validateConfig(config).environments).toEqual([]);
    expect(serializeConfig(validateConfig({ ...config, frontend: "vue" }))).toContain(
      "stack: python-fastapi\npattern: none\nfrontend: vue\n",
    );
    const withEngine = validateConfig({ ...config, review: { ai: true, engine: "claude" } });
    expect(serializeConfig(withEngine)).toContain("engine: claude");
  });

  it.each([
    [{ ...config, surprise: 1 }, "surprise"],
    [{ ...config, name: "Not Valid" }, "name"],
    [{ ...config, name: "demo--api" }, "single hyphens"],
    [{ ...config, name: "demo-" }, "single hyphens"],
    [{ ...config, name: `a${"b".repeat(50)}` }, "2 to 50"],
    [{ ...config, schema: "liftoff.config/v2" }, "schema"],
    [{ ...config, agents: ["claude", "claude"] }, "each agent may be listed once"],
    [{ ...config, environments: ["dev", "dev"] }, "each environment may be listed once"],
    [{ ...config, owners: ["a", "a"] }, "each owner may be listed once"],
    [
      { ...config, owners: ["alice", "Alice"] },
      "each owner may be listed once, in any letter case",
    ],
    [{ ...config, owners: ["not a login"] }, "GitHub login"],
  ])("rejects an invalid config %#", (raw, message) => {
    expect(() => validateConfig(raw)).toThrow(message);
  });

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("name: [")).toThrow(ConfigError);
  });
});

describe("PROJ-002 manifest", () => {
  const manifest: Manifest = {
    schema: "liftoff.manifest/v1",
    generatedBy: { liftoff: "1.0.0" },
    history: [{ operation: "init", liftoff: "1.0.0" }],
    plugins: [
      { id: "stack/python-fastapi", version: "1" },
      { id: "common/repository", version: "1" },
    ],
    files: [
      { path: "z.txt", ownership: "seeded", sha256: "a".repeat(64), plugin: "p" },
      { path: "a/b.txt", ownership: "managed", sha256: "b".repeat(64), plugin: "p" },
    ],
  };

  it("serializes sorted and parses back", () => {
    const text = serializeManifest(manifest);
    const parsed = parseManifest(text);
    expect(parsed.files.map((f) => f.path)).toEqual(["a/b.txt", "z.txt"]);
    expect(parsed.plugins.map((p) => p.id)).toEqual(["common/repository", "stack/python-fastapi"]);
  });

  it.each([["/etc/passwd"], ["C:\\\\file"], ["a/../b"]])("rejects the unsafe path %s", (path) => {
    const bad = { ...manifest, files: [{ ...manifest.files[0], path }] };
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(/repository-relative/);
  });

  it("rejects bad hashes, unknown ownership and malformed JSON", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], sha256: "x" }] }),
      ),
    ).toThrow(/sha256/);
    expect(() =>
      parseManifest(
        JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], ownership: "mine" }] }),
      ),
    ).toThrow(ManifestError);
    expect(() => parseManifest("{")).toThrow(/not valid JSON/);
  });
});

describe("PROJ-024 layout bindings say where each part of a project lives", () => {
  const withFrontend = { ...config, frontend: "vue", infrastructure: "azure" };

  it("binds parts to their own directories, and writes only bindings away from the standard", () => {
    const bound = validateConfig({
      ...withFrontend,
      layout: { backend: "services/api", frontend: "frontend", infrastructure: "deploy/azure" },
    });
    expect(bound.layout).toEqual({ backend: "services/api", infrastructure: "deploy/azure" });
    expect(layoutOf(bound)).toEqual({
      backend: "services/api",
      frontend: "frontend",
      infrastructure: "deploy/azure",
    });
    expect(isStandardLayout(bound)).toBe(false);
    const text = serializeConfig(bound);
    expect(text).toContain("layout:\n  backend: services/api\n  infrastructure: deploy/azure\n");
    expect(serializeConfig(parseConfig(text))).toBe(text);
    // The standard layout is not written at all.
    const standard = validateConfig({ ...config, layout: { backend: "backend" } });
    expect(isStandardLayout(standard)).toBe(true);
    expect(serializeConfig(standard)).not.toContain("layout");
    expect(layoutOf(standard)).toEqual({ backend: "backend" });
  });

  it("lets the repository root hold one part, with others inside it", () => {
    const rooted = validateConfig({ ...withFrontend, layout: { backend: ".", frontend: "web" } });
    expect(layoutOf(rooted)).toMatchObject({ backend: ".", frontend: "web" });
  });

  it.each([
    [{ frontend: "web" }, config, "frontend: the project has no frontend"],
    [{ backend: "../api" }, config, "backend: ../api is not a repository-relative path"],
    [{ backend: "/srv/api" }, config, "is not a repository-relative path"],
    [{ backend: "api." }, config, "has a name Windows would read as another file"],
    [{ backend: ".github/api" }, config, "is inside a directory Liftoff or Git keeps for itself"],
    [{ backend: ".Liftoff" }, config, "is inside a directory Liftoff or Git keeps for itself"],
    [{ backend: "services/.git" }, config, "is inside a .git directory"],
    [{ backend: "api\u0000x" }, config, "has a character Git or Windows cannot hold"],
    [{ backend: "api\nx" }, config, "has a character Git or Windows cannot hold"],
    [{ backend: "api|v2" }, config, "has a character Git or Windows cannot hold"],
    [{ backend: "api?" }, config, "has a character Git or Windows cannot hold"],
    [{ backend: "a".repeat(256) }, config, "has a name longer than 255 bytes"],
    [{ backend: "é".repeat(128) }, config, "has a name longer than 255 bytes"],
    [{ backend: "services/COM¹" }, config, "has a name Windows would read as another file"],
    [{ backend: "LPT²" }, config, "has a name Windows would read as another file"],
    [{ backend: "COM³.txt" }, config, "has a name Windows would read as another file"],
    // "é" composed, and "e" with a combining accent: one name to macOS.
    [{ backend: "\u00e9t\u00e9", frontend: "e\u0301te\u0301" }, withFrontend, "share a directory"],
    [
      { backend: "\u00e9t\u00e9", frontend: "E\u0301TE\u0301/web" },
      withFrontend,
      "inside backend's",
    ],
    [{ backend: "app", frontend: "App" }, withFrontend, "backend and frontend share a directory"],
    [
      { backend: "app", frontend: "app/web" },
      withFrontend,
      "frontend is inside backend's directory",
    ],
    [{ backend: ".", frontend: "." }, withFrontend, "share a directory"],
    [{ cli: "tools" }, config, "layout"],
  ])("refuses the layout %j", (layout, base, message) => {
    expect(() => validateConfig({ ...base, layout })).toThrow(message);
  });
});

describe("PROJ-025 the manifest records its history and anything from before the rebuild", () => {
  const base = {
    schema: "liftoff.manifest/v1",
    generatedBy: { liftoff: "1.1.0" },
    plugins: [],
    files: [],
  };

  it("reads a manifest from before history was recorded as having none", () => {
    expect(parseManifest(JSON.stringify(base))).toMatchObject({ history: [] });
    expect(parseManifest(JSON.stringify(base)).legacy).toBeUndefined();
  });

  it("records each operation and an adopted project's old records, in a fixed order", () => {
    const manifest = parseManifest(
      JSON.stringify({
        ...base,
        history: [
          { operation: "adopt", liftoff: "1.0.0" },
          { operation: "update", liftoff: "1.1.0" },
        ],
        legacy: {
          release: "0.12.3",
          records: [
            {
              path: "liftoff.manifest.json",
              record: "manifest",
              state: "migratable",
              format: "manifest v7",
              sha256: "a".repeat(64),
            },
            { path: ".liftoff/governance", record: "governance-handoff", state: "readable" },
          ],
        },
      }),
    );
    const text = serializeManifest(manifest);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schema",
      "generatedBy",
      "history",
      "plugins",
      "files",
      "legacy",
    ]);
    expect(parseManifest(text).legacy?.records.map((record) => record.path)).toEqual([
      ".liftoff/governance",
      "liftoff.manifest.json",
    ]);
    expect(serializeManifest(parseManifest(text))).toBe(text);
  });

  it("writes the same bytes however the manifest was built", () => {
    const built: Manifest = {
      ...base,
      schema: "liftoff.manifest/v1",
      history: [{ liftoff: "1.1.0", operation: "init" as const }],
      plugins: [{ version: "1", id: "p" }],
      files: [{ sha256: "a".repeat(64), plugin: "p", path: "x", ownership: "framework" as const }],
      legacy: { records: [{ state: "readable" as const, record: "config" as const, path: "y" }] },
    };
    const text = serializeManifest(parseManifest(JSON.stringify(built)));
    expect(serializeManifest(built)).toBe(text);
    expect(text).toContain('"path": "x",\n      "ownership": "framework",');
  });

  it.each([
    [{ history: [{ operation: "deploy", liftoff: "1.0.0" }] }, "history"],
    [{ legacy: { records: [{ path: "x", record: "manifest", state: "executable" }] } }, "legacy"],
    [{ legacy: { records: [{ path: "../x", record: "manifest", state: "readable" }] } }, "legacy"],
    [
      {
        legacy: {
          records: [{ path: "C:/outside/legacy.json", record: "manifest", state: "readable" }],
        },
      },
      "legacy",
    ],
    [
      { legacy: { records: [{ path: "C:legacy.json", record: "manifest", state: "readable" }] } },
      "legacy",
    ],
  ])("refuses a manifest with %j", (extra, message) => {
    expect(() => parseManifest(JSON.stringify({ ...base, ...extra }))).toThrow(message);
  });
});

describe("INIT-001 plans are tamper-evident", () => {
  const unsigned = {
    schema: "liftoff.plan/v1" as const,
    operation: "init" as const,
    liftoff: "1.0.0",
    target: "/tmp/demo",
    config,
    effects: ["write-files" as const],
    files: [{ path: "a", ownership: "seeded" as const, sha256: "c".repeat(64), bytes: 1 }],
  };

  it("hashes canonical JSON regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    expect(sha256Hex("x")).toHaveLength(64);
  });

  it("accepts a sealed plan and refuses an edited one", () => {
    const plan = sealPlan(unsigned);
    expect(parsePlan(JSON.stringify(plan))).toEqual(plan);
    const edited = { ...plan, target: "/tmp/elsewhere" };
    expect(() => parsePlan(JSON.stringify(edited))).toThrow(/changed after it was made/);
  });

  it("rejects malformed plans", () => {
    expect(() => parsePlan("nope")).toThrow(PlanError);
    expect(() =>
      parsePlan(JSON.stringify({ ...sealPlan(unsigned), effects: ["delete-everything"] })),
    ).toThrow(/invalid/);
  });
});
