import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const relative = (file: string) => path.relative(work, file).split(path.sep).join("/");

/** Records every path whose text was read, so a test can show what was never opened. */
function spying(): { port: ProjectFsPort; read: string[] } {
  const read: string[] = [];
  const port: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
    readText: async (file: string) => {
      read.push(`unbounded ${relative(file)}`);
      return fs.readText(file);
    },
    readWithin: async (directory: string, file: string, maxBytes: number) => {
      const result = await fs.readWithin(directory, file, maxBytes);
      if (result.kind === "file" && result.text !== undefined) read.push(file);
      return result;
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

  it("looks at generic paths only in a project the old records mark", async () => {
    write("governance/activation-state.json", { schemaVersion: 3 });
    const looked: string[] = [];
    const refusing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      entry: async (file: string) => {
        looked.push(relative(file));
        if (relative(file).startsWith("governance")) throw new Error("EACCES: permission denied");
        return fs.entry(file);
      },
      readWithin: async (directory: string, file: string, maxBytes: number) => {
        looked.push(file);
        if (file.startsWith("governance")) throw new Error("EACCES: permission denied");
        return fs.readWithin(directory, file, maxBytes);
      },
    });
    expect(await inventoryLegacy(refusing, work)).toEqual({ project: false, records: [] });
    expect(looked.filter((file) => file.startsWith("governance"))).toEqual([]);
  });

  it("does not take a directory it may not search for old records", async () => {
    // As the file system answers when .liftoff may be listed but not searched.
    const closed: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      entry: async (file: string) =>
        relative(file).startsWith(".liftoff/")
          ? { kind: "inaccessible" as const, size: 0 }
          : fs.entry(file),
    });
    mkdirSync(path.join(work, ".liftoff"));
    expect(await inventoryLegacy(closed, work)).toEqual({ project: false, records: [] });
    write("liftoff.manifest.json", MANIFEST);
    const found = await inventoryLegacy(closed, work);
    expect(found.records.map(({ path, state, reason }) => [path, state, reason])).toEqual([
      ["liftoff.manifest.json", "migratable", expect.any(String)],
      [
        ".liftoff",
        "unsupported",
        "Liftoff is not allowed to look inside it, so nothing under it was looked at",
      ],
    ]);
  });

  it("reports a directory it may not search once, on a real file system", async () => {
    write("liftoff.manifest.json", MANIFEST);
    write("governance/activation-state.json", { schemaVersion: 3 });
    mkdirSync(path.join(work, ".liftoff"));
    // Windows does not restrict reading by mode, and root reads anything.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    chmodSync(path.join(work, ".liftoff"), 0o000);
    chmodSync(path.join(work, "governance"), 0o000);
    try {
      const found = await inventoryLegacy(fs, work);
      expect(found.records.map(({ path, state }) => [path, state])).toEqual([
        ["liftoff.manifest.json", "migratable"],
        [".liftoff", "unsupported"],
        ["governance", "unsupported"],
      ]);
      rmSync(path.join(work, "liftoff.manifest.json"));
      expect((await inventoryLegacy(fs, work)).project).toBe(false);
    } finally {
      chmodSync(path.join(work, ".liftoff"), 0o755);
      chmodSync(path.join(work, "governance"), 0o755);
    }
  });

  it("reports a record Liftoff is not allowed to read", async () => {
    write("liftoff.manifest.json", MANIFEST);
    const denied: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      readWithin: async () => ({ kind: "inaccessible" as const }),
    });
    const found = await inventoryLegacy(denied, work);
    expect(found.records[0]).toMatchObject({
      path: "liftoff.manifest.json",
      state: "unsupported",
      reason: "Liftoff is not allowed to read it",
    });
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
