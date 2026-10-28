import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProcesses } from "../../src/adapters/process.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { recoverChanges } from "../../src/application/change/apply-changes.ts";
import { ProjectChangeError } from "../../src/application/change/project-change.ts";
import {
  applyCleanup,
  type CleanupPlan,
  CleanupStoppedError,
  planCleanup,
  withoutCopies,
} from "../../src/application/migrate/cleanup.ts";
import { applyMigrate, planMigrate } from "../../src/application/migrate/migrate-project.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { CONFIG_FILE } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE } from "../../src/domain/project/manifest.ts";
import { projectFiles } from "../helpers/older-project.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const VERSION = "1.0.0";

let work: string;
let root: string;
let target: string;
beforeEach(async () => {
  // As the CLI resolves it: macOS's /var is /private/var, and Windows may
  // give a short name.
  work = await promises.realpath(mkdtempSync(path.join(tmpdir(), "liftoff-cleanup-")));
  root = path.join(work, "shop");
  target = path.join(work, "shop-liftoff");
  mkdirSync(root);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const old = projectFiles(() => root);
const made = projectFiles(() => target);

const PYPROJECT = '[project]\nname = "shop"\ndependencies = ["fastapi"]\n';

/** A FastAPI service with what a working copy also holds, migrated beside itself. */
async function migrated(): Promise<void> {
  old.write(".git/HEAD", "ref: refs/heads/main\n");
  old.write("pyproject.toml", PYPROJECT);
  old.write("app/main.py", "from fastapi import FastAPI\n");
  old.write("app/routes/items.py", "ITEMS = []\n");
  old.write("README.md", "# shop\n");
  old.write(".env", "SECRET=1\n");
  old.write("node_modules/left-pad/index.js", "module.exports = 1;\n");
  const plan = await planMigrate(
    { assets, fs },
    root,
    target,
    VERSION,
    {},
    {
      named: true,
      refused: [],
      cwd: work,
    },
  );
  await applyMigrate({ assets, fs }, plan, VERSION, { cwd: work });
}

const ports = { fs, processes: new LocalProcesses(), now: () => new Date().toISOString() };

const cleanup = (port: ProjectFsPort = fs, batch?: number) =>
  planCleanup(port, root, target, VERSION, {
    named: true,
    refused: [],
    ...(batch === undefined ? {} : { batch }),
  });

const fail = (): never => {
  throw new Error("expected a value");
};

const paths = (plan: CleanupPlan) => plan.removals.map((removal) => removal.path);

describe("MIGRATE-004 cleaning up the old project is a separate step that asks first", () => {
  it("removes what the new project holds copies of, and keeps everything else", async () => {
    await migrated();
    // Edited in the new project's copy, and one moved from it unchanged.
    made.write("legacy/README.md", "# shop, ported\n");
    mkdirSync(made.at("backend/app/old"), { recursive: true });
    renameSync(made.at("legacy/app/routes/items.py"), made.at("backend/app/old/items.py"));
    const newBefore = made.snapshot();
    const plan = await cleanup();
    expect(plan.blocked).toEqual([]);
    expect(plan.removals).toEqual([
      expect.objectContaining({ path: "app/main.py", copy: "legacy/app/main.py" }),
      expect.objectContaining({ path: "app/routes/items.py", copy: "backend/app/old/items.py" }),
      expect.objectContaining({ path: "pyproject.toml", copy: "legacy/pyproject.toml" }),
    ]);
    expect(plan.kept).toEqual([
      { path: ".env", why: expect.stringContaining("may hold secrets or state") },
      { path: ".git", why: "Git's own data" },
      { path: "README.md", why: "the new project holds no copy of it" },
      { path: "node_modules", why: "dependencies, caches or build output" },
    ]);
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0]).toMatchObject({
      operation: "migrate-cleanup",
      target: root,
      config: { migratedTo: target },
    });

    const result = await applyCleanup(ports, plan);
    expect(result).toMatchObject({
      removed: ["app/main.py", "app/routes/items.py", "pyproject.toml"],
      directories: ["app", "app/routes"],
      leftovers: [],
      cancelled: false,
    });
    expect(Object.keys(old.snapshot()).sort()).toEqual([
      ".env",
      ".git/HEAD",
      "README.md",
      "node_modules/left-pad/index.js",
    ]);
    // Nothing of the change is left behind, and the new project is as it was.
    expect(existsSync(old.at(".liftoff"))).toBe(false);
    expect(made.snapshot()).toEqual(newBefore);
    // Run again, there is nothing more to remove.
    expect((await cleanup()).removals).toEqual([]);
  });

  it("removes nothing until the new project is verified", async () => {
    await migrated();
    made.write(CONFIG_FILE, "not: [valid\n");
    const invalid = await cleanup();
    expect(invalid.blocked).toEqual([
      expect.stringMatching(
        /^the new project is not valid: liftoff\.yaml: [\s\S]*; fix it, as liftoff validate says, before cleaning up$/,
      ),
    ]);
    expect(invalid.plans).toEqual([]);
    expect(paths(invalid)).toContain("app/main.py");

    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(path.join(target, "notes.md"), "not a project\n");
    const unrelated = await cleanup();
    expect(unrelated.blocked[0]).toBe(
      `${target} was not made by liftoff migrate, so it is not a migration of this project to clean up after`,
    );
  });

  it("removes nothing for a new project made by init", async () => {
    await migrated();
    const manifest = JSON.parse(made.read(MANIFEST_FILE)) as { history: { operation: string }[] };
    manifest.history = [{ ...manifest.history[0], operation: "init" } as { operation: string }];
    made.write(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    const plan = await cleanup();
    expect(plan.blocked[0]).toContain("its manifest's history starts with init");
  });

  it("refuses directories that are not there, overlap or lead elsewhere, and an old project Liftoff has", async () => {
    await migrated();
    await expect(
      planCleanup(fs, root, path.join(work, "missing"), VERSION, { named: true, refused: [] }),
    ).rejects.toThrow("is not a directory; name it with --to");
    await expect(
      planCleanup(fs, root, path.join(root, "app"), VERSION, { named: true, refused: [] }),
    ).rejects.toThrow("overlap");
    symlinkSync(target, path.join(work, "alias"), "junction");
    await expect(
      planCleanup(fs, root, path.join(work, "alias"), VERSION, { named: true, refused: [] }),
    ).rejects.toThrow(`leads to ${target} through a link`);
    old.write(CHANGE_JOURNAL_FILE, "");
    await expect(cleanup()).rejects.toThrow("a change stopped part way");
    rmSync(old.at(".liftoff"), { recursive: true });
    old.write(CONFIG_FILE, "schema: liftoff.config/v1\n");
    await expect(cleanup()).rejects.toThrow("is already here, so this is a Liftoff project");
  });

  it("removes in bounded changes, and one that stops part way can be undone", async () => {
    await migrated();
    const plan = await cleanup(fs, 2);
    expect(plan.plans.map((change) => change.changes.length)).toEqual([2, 2]);
    // The second change stops after it began.
    let removals = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (to.includes(`${path.sep}removed${path.sep}`) && ++removals === 4) {
          throw new Error("no space left on the disk");
        }
        return fs.moveFile(from, to);
      },
    });
    const error = await applyCleanup({ ...ports, fs: failing }, plan).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(CleanupStoppedError);
    expect((error as CleanupStoppedError).removed).toEqual(["README.md", "app/main.py"]);
    expect((error as CleanupStoppedError).plan.hash).toBe(plan.plans[1]?.hash);
    expect(existsSync(old.at(CHANGE_JOURNAL_FILE))).toBe(true);
    const undone = await recoverChanges(ports, root, "undo");
    expect(undone.complete).toBe(true);
    // The second change is undone; the first had finished.
    expect(old.read("pyproject.toml")).toBe(PYPROJECT);
    expect(old.read("app/routes/items.py")).toBe("ITEMS = []\n");
    expect(existsSync(old.at("app/main.py"))).toBe(false);
  });

  it("removes nothing more when a copy it rests on changed, and stops between changes on Ctrl+C", async () => {
    await migrated();
    const plan = await cleanup(fs, 2);
    made.write("legacy/pyproject.toml", "changed\n");
    const changed = await applyCleanup(ports, plan).catch((thrown) => thrown);
    expect(changed).toBeInstanceOf(CleanupStoppedError);
    expect((changed as Error).message).toContain(
      "legacy/pyproject.toml in the new project changed since the cleanup was planned",
    );
    expect(old.read("pyproject.toml")).toBe(PYPROJECT);

    // The first change rests on a changed copy: nothing at all is removed.
    rmSync(target, { recursive: true });
    rmSync(root, { recursive: true });
    mkdirSync(root);
    await migrated();
    const first = await cleanup(fs, 2);
    made.write("legacy/app/main.py", "changed\n");
    await expect(applyCleanup(ports, first)).rejects.toThrow(ProjectChangeError);
    expect(old.read("app/main.py")).toBe("from fastapi import FastAPI\n");

    made.write("legacy/app/main.py", "from fastapi import FastAPI\n");
    const controller = new AbortController();
    const aborting = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        await fs.moveFile(from, to);
        // Pressed once the first change has removed its files.
        if (to.includes(`${path.sep}removed${path.sep}`) && from.endsWith("main.py")) {
          controller.abort();
        }
      },
    });
    const result = await applyCleanup({ ...ports, fs: aborting }, first, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ removed: ["README.md", "app/main.py"], cancelled: true });
    expect(old.read("pyproject.toml")).toBe(PYPROJECT);
  });

  it("stops on Ctrl+C before a later change touches a file, and tidies what the first emptied", async () => {
    await migrated();
    const plan = await cleanup(fs, 2);
    const controller = new AbortController();
    let hashes = 0;
    const aborting = Object.assign(Object.create(fs) as ProjectFsPort, {
      hashWithin: (directory: string, relative: string, max: number) => {
        // The second change's copies are about to be hashed again.
        if (directory === target && ++hashes === 3) controller.abort();
        return fs.hashWithin(directory, relative, max);
      },
    });
    const result = await applyCleanup({ ...ports, fs: aborting }, plan, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ removed: ["README.md", "app/main.py"], cancelled: true });
    expect(old.read("pyproject.toml")).toBe(PYPROJECT);
    expect(existsSync(old.at(CHANGE_JOURNAL_FILE))).toBe(false);
    expect(existsSync(old.at(".liftoff"))).toBe(false);
  });

  it("names the files a stopped change would still remove that the new project no longer holds", async () => {
    await migrated();
    const plan = await cleanup(fs, 2);
    const changes = (plan.plans[1] ?? fail()).changes;
    expect(await withoutCopies(fs, root, target, changes)).toEqual([]);
    rmSync(made.at("legacy"), { recursive: true });
    expect(await withoutCopies(fs, root, target, changes)).toEqual([
      "app/routes/items.py",
      "pyproject.toml",
    ]);
    // A new project that is not there, or overlaps, holds nothing.
    expect(await withoutCopies(fs, root, path.join(work, "missing"), changes)).toHaveLength(2);
    expect(await withoutCopies(fs, root, path.join(root, "app"), changes)).toHaveLength(2);
    // A file already removed is not asked about.
    rmSync(old.at("pyproject.toml"));
    expect(await withoutCopies(fs, root, target, changes)).toEqual(["app/routes/items.py"]);
  });

  it("tidies what finished changes emptied when a later one stops, and reports what it cannot remove", async () => {
    await migrated();
    const plan = await cleanup(fs, 3);
    expect(plan.plans.map((change) => change.changes.length)).toEqual([3, 1]);
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (to.includes(`${path.sep}removed${path.sep}`) && from.endsWith("pyproject.toml")) {
          throw new Error("no space left on the disk");
        }
        return fs.moveFile(from, to);
      },
    });
    await expect(applyCleanup({ ...ports, fs: failing }, plan)).rejects.toThrow(
      CleanupStoppedError,
    );
    // The first change emptied app/ and app/routes/, which are gone already.
    expect(existsSync(old.at("app"))).toBe(false);
    await recoverChanges(ports, root, "undo");

    // A directory that cannot be removed is left, and said so, not an error.
    rmSync(target, { recursive: true });
    rmSync(root, { recursive: true });
    mkdirSync(root);
    await migrated();
    const stuck = Object.assign(Object.create(fs) as ProjectFsPort, {
      removeEmptyDirectory: (directory: string, relative: string) =>
        relative === "app"
          ? Promise.reject(new Error("permission denied"))
          : fs.removeEmptyDirectory(directory, relative),
    });
    const result = await applyCleanup({ ...ports, fs: stuck }, await cleanup());
    expect(result.removed).toContain("app/main.py");
    expect(result.directories).toEqual(["app/routes"]);
    expect(result.leftovers).toEqual([
      "app is empty but could not be removed (permission denied); delete it",
    ]);
  });

  it("removes nothing more once a link leads either project elsewhere", async () => {
    await migrated();
    const plan = await cleanup(fs, 2);
    let calls = 0;
    const redirected = Object.assign(Object.create(fs) as ProjectFsPort, {
      realPath: async (directory: string) =>
        directory === target && ++calls === 2
          ? path.join(work, "elsewhere")
          : fs.realPath(directory),
    });
    const error = await applyCleanup({ ...ports, fs: redirected }, plan).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(CleanupStoppedError);
    expect((error as Error).message).toContain(
      `${target} now leads to ${path.join(work, "elsewhere")} through a link, so nothing more was removed`,
    );
    expect(old.read("pyproject.toml")).toBe(PYPROJECT);
  });

  it("keeps what the walk did not reach, and never reads the new project's secrets", async () => {
    await migrated();
    old.write("closed/notes.md", "private\n");
    made.write("legacy/closed/notes.md", "private\n");
    made.write(".env", "SECRET=1\n");
    const read: string[] = [];
    const closing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      listWithin: (directory: string, relative: string, max: number) =>
        directory === root && relative === "closed"
          ? Promise.resolve({ kind: "inaccessible", via: "closed" })
          : fs.listWithin(directory, relative, max),
      hashWithin: (directory: string, relative: string, max: number) => {
        if (directory === target) read.push(relative);
        return fs.hashWithin(directory, relative, max);
      },
    });
    const plan = await cleanup(closing);
    expect(plan.kept).toContainEqual({ path: "closed", why: "not walked: closed to this user" });
    expect(paths(plan)).not.toContain("closed/notes.md");
    expect(read).not.toContain(".env");
    expect((plan.plans[0] ?? fail()).changes.length).toBe(plan.removals.length);
  });
});
