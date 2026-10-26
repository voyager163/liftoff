import { describe, expect, it } from "vitest";
import {
  classifyLegacy,
  LEGACY_CANDIDATES,
  type LegacyObservation,
  MAX_LEGACY_BYTES,
} from "../../src/domain/legacy/inventory.ts";

// Synthetic records with the shapes the releases before the rebuild wrote:
// only the fields that identify each format.
const MANIFEST = {
  artifactVersion: 7,
  generatedBy: "Mission Control Liftoff",
  liftoffVersion: "0.12.3",
  project: { name: "demo" },
  managedArtifacts: [],
  projectArtifacts: [],
};
const CONFIG = {
  projectName: "demo",
  projectType: "standard",
  apiStack: "python",
  cloud: "azure",
  region: "eastus",
  includeFrontend: false,
  environments: ["dev"],
  specWorkflow: "openspec",
  agents: ["claude"],
  governanceProfile: "single-maintainer-gitflow",
};

const file = (value: unknown): LegacyObservation => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { kind: "file", size: text.length, text };
};
const DIRECTORY: LegacyObservation = { kind: "directory" };
const inventory = (entries: Record<string, LegacyObservation>) =>
  classifyLegacy(new Map(Object.entries(entries)));
const record = (entries: Record<string, LegacyObservation>, path: string) =>
  inventory(entries).records.find((found) => found.path === path);

describe("LEGACY-001 records from before the rebuild are inventoried, never run", () => {
  it("finds a 0.12.3 project's manifest, configuration and activation records", () => {
    const found = inventory({
      "liftoff.manifest.json": file(MANIFEST),
      "liftoff.config.json": file(CONFIG),
      ".liftoff/governance": DIRECTORY,
      "governance/activation-state.json": file({ schemaVersion: 3, identity: {} }),
      "governance/evidence": DIRECTORY,
      "governance/approvals": DIRECTORY,
    });
    expect(found.project).toBe(true);
    expect(
      found.records.map(({ path, state, format, release }) => [path, state, format, release]),
    ).toEqual([
      ["liftoff.manifest.json", "migratable", "manifest v7", "0.12.3"],
      ["liftoff.config.json", "migratable", "configuration", undefined],
      [".liftoff/governance", "readable", undefined, undefined],
      ["governance/activation-state.json", "readable", "activation state v3", undefined],
      ["governance/evidence", "readable", undefined, undefined],
      ["governance/approvals", "readable", undefined, undefined],
    ]);
    expect(found.records.every((found) => found.state !== "executable")).toBe(true);
    expect(
      record(
        { "liftoff.manifest.json": file(MANIFEST), "governance/evidence": DIRECTORY },
        "governance/evidence",
      )?.reason,
    ).toContain("never counted as current proof");
  });

  it.each([2, 3, 4, 5, 6, 7])("can carry over a version %i manifest", (version) => {
    const found = record(
      { "liftoff.manifest.json": file({ ...MANIFEST, artifactVersion: version }) },
      "liftoff.manifest.json",
    );
    expect(found).toMatchObject({
      state: "migratable",
      format: `manifest v${version}`,
      opened: true,
    });
  });

  it("says to finish or undo an old change that did not finish", () => {
    for (const path of [
      ".liftoff/reviewed-update-transaction.json",
      ".liftoff/reviewed-repair-transaction.json",
    ]) {
      const found = record({ [path]: { kind: "file", size: 10 } }, path);
      expect(found).toMatchObject({ state: "readable", opened: false });
      expect(found?.blocks).toContain("run the same command again with Liftoff 0.12.3");
    }
  });

  it("does not take generic paths alone for a project from before the rebuild", () => {
    const generic = inventory({
      "governance/plans": DIRECTORY,
      "governance/activation-state.json": file({ schemaVersion: 3 }),
    });
    expect(generic).toEqual({ project: false, records: [] });
    expect(inventory({})).toEqual({ project: false, records: [] });
    // Each old-only path is enough on its own.
    for (const candidate of LEGACY_CANDIDATES.filter((candidate) => candidate.marker)) {
      const observed =
        candidate.kind === "directory" ? DIRECTORY : { kind: "file" as const, size: 2, text: "{}" };
      expect(inventory({ [candidate.path]: observed }).project).toBe(true);
    }
  });
});

describe("LEGACY-002 unknown and newer formats fail safely", () => {
  it.each([
    ["a newer manifest", { ...MANIFEST, artifactVersion: 8 }, "newer than any release"],
    ["an older manifest", { ...MANIFEST, artifactVersion: 1 }, "older than any format"],
    ["a manifest with no version", { ...MANIFEST, artifactVersion: "7" }, "missing or unknown"],
    [
      "another tool's manifest",
      { ...MANIFEST, generatedBy: "Other" },
      "not a manifest written by Liftoff",
    ],
    [
      "a manifest with no release",
      { ...MANIFEST, liftoffVersion: "latest" },
      "which release wrote it",
    ],
    ["a JSON array", [], "not a JSON object"],
    ["broken JSON", "{", "not valid JSON"],
  ])("rejects %s", (_name, value, reason) => {
    const found = record({ "liftoff.manifest.json": file(value) }, "liftoff.manifest.json");
    expect(found).toMatchObject({ state: "unsupported", opened: true });
    expect(found?.reason).toContain(reason);
  });

  it("rejects a configuration no old release wrote", () => {
    const extra = record(
      { "liftoff.config.json": file({ ...CONFIG, schema: 2, telemetry: true }) },
      "liftoff.config.json",
    );
    expect(extra).toMatchObject({ state: "unsupported" });
    expect(extra?.reason).toContain("schema, telemetry");
    const nameless = record(
      { "liftoff.config.json": file({ projectType: "standard" }) },
      "liftoff.config.json",
    );
    expect(nameless?.reason).toContain("lacks the project's name or type");
  });

  it.each([0, 4, "3"])("rejects activation state version %s", (version) => {
    const found = record(
      {
        "liftoff.manifest.json": file(MANIFEST),
        "governance/activation-state.json": file({ schemaVersion: version }),
      },
      "governance/activation-state.json",
    );
    expect(found).toMatchObject({ state: "unsupported" });
  });

  it("rejects links, and directories where a file belongs", () => {
    const linked = inventory({
      "liftoff.manifest.json": { kind: "other" },
      ".liftoff/governance": { kind: "file", size: 1 },
      "liftoff.config.json": DIRECTORY,
    });
    expect(linked.records.map(({ path, state, reason }) => [path, state, reason])).toEqual([
      ["liftoff.manifest.json", "unsupported", "a link or other special file; it is not followed"],
      ["liftoff.config.json", "unsupported", "a directory where the old release kept a file"],
      [".liftoff/governance", "unsupported", "a file where the old release kept a directory"],
    ]);
  });
});

describe("LEGACY-003 records that can hold files, credentials or state are never read", () => {
  it("reads only the manifest, configuration and activation state", () => {
    const opened = LEGACY_CANDIDATES.filter((candidate) => candidate.open).map(
      (candidate) => candidate.path,
    );
    expect(opened).toEqual([
      "liftoff.manifest.json",
      "liftoff.config.json",
      "governance/activation-state.json",
    ]);
  });

  it("does not read a record larger than 1 MiB", () => {
    const found = record(
      { "liftoff.manifest.json": { kind: "file", size: MAX_LEGACY_BYTES + 1 } },
      "liftoff.manifest.json",
    );
    expect(found).toMatchObject({ state: "unsupported", opened: false });
    expect(found?.reason).toContain("was not read");
  });

  it("notes credential and history records without reading them", () => {
    const found = inventory({
      "liftoff.manifest.json": file(MANIFEST),
      "governance/credentials": DIRECTORY,
      "governance/history": DIRECTORY,
      "governance/migration-state.json": { kind: "file", size: 10 },
      ".liftoff/repair-history": DIRECTORY,
    });
    expect(found.records.slice(1).map(({ path, opened, state }) => [path, opened, state])).toEqual([
      [".liftoff/repair-history", false, "readable"],
      ["governance/credentials", false, "readable"],
      ["governance/history", false, "readable"],
      ["governance/migration-state.json", false, "readable"],
    ]);
  });
});
