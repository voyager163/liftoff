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

  it("defaults owners and keeps an explicit review engine", () => {
    const { owners: _owners, ...withoutOwners } = config;
    expect(validateConfig(withoutOwners).owners).toEqual([]);
    const withEngine = validateConfig({ ...config, review: { ai: true, engine: "claude" } });
    expect(serializeConfig(withEngine)).toContain("engine: claude");
  });

  it.each([
    [{ ...config, surprise: 1 }, "surprise"],
    [{ ...config, name: "Not Valid" }, "name"],
    [{ ...config, schema: "liftoff.config/v2" }, "schema"],
    [{ ...config, agents: ["claude", "claude"] }, "each agent may be listed once"],
    [{ ...config, owners: ["a", "a"] }, "each owner may be listed once"],
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
