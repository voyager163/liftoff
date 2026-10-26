import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { inventoryLegacy } from "../../src/application/project/legacy-inventory.ts";

const fs = new LocalProjectFs();
let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-legacy-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const write = (relative: string, content: unknown) => {
  const target = path.join(work, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
};

/** Records every path read, so a test can show what was never opened. */
function spying(): { port: ProjectFsPort; read: string[] } {
  const read: string[] = [];
  const port: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
    readText: async (file: string) => {
      read.push(path.relative(work, file).split(path.sep).join("/"));
      return fs.readText(file);
    },
  });
  return { port, read };
}

const MANIFEST = {
  artifactVersion: 7,
  generatedBy: "Mission Control Liftoff",
  liftoffVersion: "0.12.3",
};

describe("LEGACY-001 records from before the rebuild are inventoried, never run", () => {
  it("inventories a project the old release left on disk", async () => {
    write("liftoff.manifest.json", MANIFEST);
    write(".liftoff/governance/context.json", { schemaVersion: 1 });
    write("governance/activation-state.json", { schemaVersion: 3 });
    write(".liftoff/reviewed-update-transaction.json", '{"schemaVersion":1}\n');
    const found = await inventoryLegacy(fs, work);
    expect(found.project).toBe(true);
    expect(found.records.map(({ path, state }) => [path, state])).toEqual([
      ["liftoff.manifest.json", "migratable"],
      [".liftoff/governance", "readable"],
      [".liftoff/reviewed-update-transaction.json", "readable"],
      ["governance/activation-state.json", "readable"],
    ]);
    expect(found.records[2]?.blocks).toContain("finish or undo it");
  });

  it("finds nothing in an ordinary directory", async () => {
    write("governance/plans/q3.md", "# Plans");
    expect(await inventoryLegacy(fs, work)).toEqual({ project: false, records: [] });
  });
});

describe("LEGACY-003 records that can hold files, credentials or state are never read", () => {
  it("opens only the manifest, configuration and activation state", async () => {
    write("liftoff.manifest.json", MANIFEST);
    write("liftoff.config.json", { projectName: "demo", projectType: "standard" });
    write("governance/activation-state.json", { schemaVersion: 3 });
    write(".liftoff/reviewed-repair-transaction.json", "secret file copies");
    write("governance/credentials/preflight-policy.json", "{}");
    write("governance/history/one/files/state.json", "{}");
    write("governance/migration-state.json", "{}");
    write(".liftoff/repair-history/abc/manifest.json", "{}");
    const { port, read } = spying();
    const found = await inventoryLegacy(port, work);
    expect(read).toEqual([
      "liftoff.manifest.json",
      "liftoff.config.json",
      "governance/activation-state.json",
    ]);
    expect(found.records).toHaveLength(8);
  });

  it("does not read a record larger than 1 MiB", async () => {
    write("liftoff.manifest.json", `{"pad":"${"x".repeat(1024 * 1024)}"}`);
    const { port, read } = spying();
    const found = await inventoryLegacy(port, work);
    expect(read).toEqual([]);
    expect(found.records[0]).toMatchObject({ state: "unsupported", opened: false });
  });

  it("follows no linked directory on the way to a record", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "liftoff-elsewhere-"));
    try {
      mkdirSync(path.join(elsewhere, "governance"));
      writeFileSync(path.join(elsewhere, "governance", "anything.json"), "{}");
      // A junction on Windows, which needs no special privilege; a symlink elsewhere.
      symlinkSync(elsewhere, path.join(work, ".liftoff"), "junction");
      write("liftoff.manifest.json", MANIFEST);
      const { port, read } = spying();
      const found = await inventoryLegacy(port, work);
      expect(read).toEqual(["liftoff.manifest.json"]);
      expect(found.records.map(({ path, state }) => [path, state])).toEqual([
        ["liftoff.manifest.json", "migratable"],
        [".liftoff", "unsupported"],
      ]);
      expect(found.records[1]?.reason).toContain("it is not followed");
      // The link alone does not make it a project from before the rebuild.
      rmSync(path.join(work, "liftoff.manifest.json"));
      expect((await inventoryLegacy(fs, work)).project).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
