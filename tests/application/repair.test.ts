import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyChanges } from "../../src/application/change/apply-changes.ts";
import { ProjectChangeError } from "../../src/application/change/project-change.ts";
import { applyInit, planInit } from "../../src/application/init/init-project.ts";
import type { FileHash, ProjectFsPort } from "../../src/application/ports.ts";
import {
  MAX_PATCH_BYTES,
  needsPerson,
  planPatch,
  planRepairFromSaved,
  planRestore,
  type RepairPlan,
  repairNeeded,
} from "../../src/application/repair/repair-project.ts";
import { parseChangePlan, sealChangePlan } from "../../src/domain/plan/change-plan.ts";
import { PlanError } from "../../src/domain/plan/plan.ts";
import { CONFIG_FILE, validateConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { entry, projectFiles, SKILL, sha } from "../helpers/older-project.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(
  path.join(repoRoot, "assets"),
  path.join(repoRoot, ".github/liftoff"),
);
const fs = new LocalProjectFs();
const VERSION = "1.0.0";

let work: string;
let root: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-repair-"));
  root = path.join(work, "demo");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const { at, write, read, snapshot, age } = projectFiles(() => root);

const generated = async () => {
  const config = validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "python-fastapi",
    workflow: "manual",
    agents: ["claude"],
    governance: "single-maintainer-gitflow",
    review: { ai: true },
  });
  const plan = await planInit({ assets, fs }, { config, target: root, liftoffVersion: VERSION });
  await applyInit({ assets, fs, initializer: new FakeInitializer() }, plan, VERSION);
};

const restore = (paths: string[] = [], port: ProjectFsPort = fs) =>
  planRestore({ assets, fs: port }, root, VERSION, { restore: new Set(paths) });
const patch = (text: string, paths: string[], port: ProjectFsPort = fs) =>
  planPatch({ fs: port }, root, VERSION, { text, paths });
const steps = (repair: RepairPlan) => repair.files.map((file) => `${file.step} ${file.path}`);

const changePorts = {
  fs,
  processes: {
    pid: process.pid,
    host: "test-host",
    isRunning: (pid: number) => pid === process.pid,
  },
  now: () => "2026-10-27T12:00:00Z",
};
const apply = (repair: RepairPlan) => {
  if (repair.plan === undefined) throw new Error("the repair changes nothing");
  return applyChanges(changePorts, repair.plan, repair.contents, { unchanged: repair.unchanged });
};

/** A port that reports these files as hashWithin would see them, and the rest as they are. */
const seeing = (files: Record<string, FileHash>): ProjectFsPort =>
  Object.assign(Object.create(fs) as ProjectFsPort, {
    hashWithin: async (directory: string, relative: string, maxBytes: number) =>
      files[relative] ?? fs.hashWithin(directory, relative, maxBytes),
  });

/** A patch that replaces a whole file, as git diff writes one. */
const diff = (file: string, before: string | null, after: string | null) => {
  const lines = (text: string | null) =>
    text === null || text === "" ? [] : text.slice(0, -1).split("\n");
  const [old, next] = [lines(before), lines(after)];
  return [
    `diff --git a/${file} b/${file}`,
    ...(before === null
      ? ["new file mode 100644"]
      : after === null
        ? ["deleted file mode 100644"]
        : []),
    before === null ? "--- /dev/null" : `--- a/${file}`,
    after === null ? "+++ /dev/null" : `+++ b/${file}`,
    `@@ -${old.length === 0 ? 0 : 1},${old.length} +${next.length === 0 ? 0 : 1},${next.length} @@`,
    ...old.map((line) => `-${line}`),
    ...next.map((line) => `+${line}`),
    "",
  ].join("\n");
};

const VERIFY = SKILL("liftoff-verify");
const PR = SKILL("liftoff-pr");
const POLICY = ".github/liftoff/review-policy.mjs";

describe("REPAIR-001 repair lists what needs attention, changing nothing", () => {
  it("lists missing and hand-edited Liftoff files, and none in a project as Liftoff wrote it", async () => {
    await generated();
    const clean = await restore();
    expect(clean.files).toEqual([]);
    expect(repairNeeded(clean)).toBe(false);

    rmSync(at(VERIFY));
    write(POLICY, "mine\n");
    rmSync(at("README.md"));
    // The project's own changes are not problems.
    write("backend/app/main.py", `${read("backend/app/main.py")}# mine\n`);
    const before = snapshot();
    const found = await restore();
    expect(found.files).toEqual([
      {
        path: VERIFY,
        step: "offer",
        ownership: "managed",
        problem: "a file Liftoff manages is missing",
      },
      {
        path: POLICY,
        step: "offer",
        ownership: "managed",
        problem: "a file Liftoff manages was changed by hand",
      },
      {
        path: "README.md",
        step: "offer",
        ownership: "seeded",
        problem:
          "a file Liftoff wrote for the project is missing, which is fine if it was removed on purpose",
      },
    ]);
    expect(found.plan).toBeUndefined();
    expect(repairNeeded(found)).toBe(true);
    expect(needsPerson(found)).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("says why no recipe fixes a file", async () => {
    await generated();
    const [directory, link, gone, cased, owner, older, large] = [
      SKILL("liftoff-risk"),
      SKILL("liftoff-simplify"),
      ".github/workflows/98-gone.yml",
      SKILL("liftoff-setup"),
      ".gitattributes",
      "backend/app/health.py",
      SKILL("liftoff-pr"),
    ];
    age((manifest) => {
      for (const file of [directory, link, large]) entry(manifest, file).sha256 = sha("older\n");
      manifest.files.push({
        path: gone,
        ownership: "managed",
        sha256: sha("gone\n"),
        plugin: "review/layered",
      });
      entry(manifest, cased).path = cased.replace("SKILL.md", "skill.md");
      Object.assign(entry(manifest, owner), { ownership: "managed", sha256: sha("older\n") });
      entry(manifest, older).sha256 = sha("as an earlier release wrote it\n");
      // A framework's files are its own.
      manifest.files.push({
        path: "openspec/x.md",
        ownership: "framework",
        sha256: sha("x"),
        plugin: "workflow/openspec",
      });
    });
    rmSync(at(directory));
    mkdirSync(at(directory));
    rmSync(at(link));
    symlinkSync(path.join(work), at(link), "junction");
    rmSync(at(cased));
    rmSync(at(older));
    const repair = await restore([], seeing({ [large]: { kind: "file", size: 1 } }));
    expect(repair.files.map((file) => [file.path, file.step, file.problem, file.reason])).toEqual([
      [
        large,
        "cannot",
        expect.stringContaining("over 64 MiB"),
        expect.stringContaining("never replaces"),
      ],
      [
        directory,
        "cannot",
        expect.stringContaining("a directory is where"),
        expect.stringContaining("never replaces"),
      ],
      [
        cased.replace("SKILL.md", "skill.md"),
        "cannot",
        "a file Liftoff manages is missing",
        expect.stringContaining("in other letter case; rename it, then run liftoff update"),
      ],
      [
        link,
        "cannot",
        expect.stringContaining("a link"),
        expect.stringContaining("never replaces"),
      ],
      [
        owner,
        "cannot",
        "a file Liftoff manages was changed by hand",
        expect.stringContaining("another owner"),
      ],
      [
        gone,
        "cannot",
        "a file Liftoff manages is missing",
        expect.stringContaining("no longer makes it"),
      ],
      [
        older,
        "cannot",
        "a file Liftoff wrote for the project is missing, which is fine if it was removed on purpose",
        expect.stringContaining("restore it from version control"),
      ],
    ]);
    expect(needsPerson(repair)).toBe(true);
  });
});

describe("REPAIR-002 recipes put back files Liftoff wrote, only those chosen", () => {
  it("puts back only the files named, as this release makes them, and records them", async () => {
    await generated();
    const current = { verify: read(VERIFY), policy: read(POLICY), readme: read("README.md") };
    const history = parseManifest(read(MANIFEST_FILE)).history;
    rmSync(at(VERIFY));
    write(POLICY, "mine\n");
    rmSync(at("README.md"));
    const repair = await restore([VERIFY, "README.md"]);
    expect(steps(repair)).toEqual([`restore ${VERIFY}`, `offer ${POLICY}`, "restore README.md"]);
    expect(repair.unchanged).toEqual([{ path: CONFIG_FILE, sha256: sha(read(CONFIG_FILE)) }]);
    await apply(repair);
    expect(read(VERIFY)).toBe(current.verify);
    expect(read("README.md")).toBe(current.readme);
    expect(read(POLICY)).toBe("mine\n");
    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.history).toEqual([...history, { operation: "repair", liftoff: VERSION }]);
    expect(steps(await restore())).toEqual([`offer ${POLICY}`]);
  });

  it("replaces a hand edit in a managed file, with this release's version", async () => {
    await generated();
    const current = read(PR);
    age((manifest) => {
      entry(manifest, PR).sha256 = sha("as an earlier release wrote it\n");
    });
    write(PR, "edited\n");
    const repair = await restore([PR]);
    expect(repair.plan?.changes[0]).toEqual({
      path: PR,
      before: sha("edited\n"),
      after: sha(current),
      ownership: "managed",
      executable: false,
    });
    await apply(repair);
    expect(read(PR)).toBe(current);
    expect(entry(parseManifest(read(MANIFEST_FILE)), PR).sha256).toBe(sha(current));
  });

  it("counts only files Liftoff manages as needing attention", async () => {
    await generated();
    rmSync(at("README.md"));
    const seeded = await restore();
    expect(steps(seeded)).toEqual(["offer README.md"]);
    expect(repairNeeded(seeded)).toBe(false);
    rmSync(at(VERIFY));
    expect(repairNeeded(await restore())).toBe(true);
  });

  it("leaves a managed file already as this release makes it to update", async () => {
    await generated();
    age((manifest) => {
      entry(manifest, POLICY).sha256 = sha("as an earlier release wrote it\n");
    });
    const listed = await restore();
    expect(listed.files).toEqual([
      {
        path: POLICY,
        step: "cannot",
        ownership: "managed",
        problem:
          "a file Liftoff manages is already as this release makes it, but the manifest records another version",
        reason:
          "there is nothing to put back; liftoff update records this release's version in the manifest",
      },
    ]);
    expect(listed.plan).toBeUndefined();
  });

  it("refuses a changed liftoff.yaml, as update does", async () => {
    await generated();
    write(CONFIG_FILE, `${read(CONFIG_FILE)}# mine\n`);
    await expect(restore()).rejects.toThrow(ProjectChangeError);
    await expect(restore()).rejects.toThrow(
      "liftoff.yaml changed since Liftoff last wrote it, and repair never applies a changed configuration",
    );
  });
});

describe("REPAIR-003 a reviewed patch changes only the project's own files, within its paths", () => {
  it("changes, adds and removes the project's own files, and records the repair", async () => {
    await generated();
    const main = read("backend/app/main.py");
    const readme = read("README.md");
    write("backend/app/old.py", "x = 1\n");
    const text = [
      diff("backend/app/main.py", main, `${main}# fixed\n`),
      diff("backend/app/extra.py", null, "y = 2\n"),
      diff("backend/app/old.py", "x = 1\n", null),
      diff("README.md", readme, `${readme}More.\n`),
    ].join("");
    const repair = await patch(text, ["backend/app", "readme.md"]);
    expect(repair.files).toEqual([
      { path: "backend/app/extra.py", step: "add", ownership: "project" },
      { path: "backend/app/main.py", step: "change", ownership: "seeded" },
      { path: "backend/app/old.py", step: "remove", ownership: "project" },
      { path: "README.md", step: "change", ownership: "seeded" },
    ]);
    expect(repair.unchanged).toEqual([]);
    await apply(repair);
    expect(read("backend/app/main.py")).toBe(`${main}# fixed\n`);
    expect(read("backend/app/extra.py")).toBe("y = 2\n");
    expect(() => statSync(at("backend/app/old.py"))).toThrow();
    expect(read("README.md")).toBe(`${readme}More.\n`);
    expect(parseManifest(read(MANIFEST_FILE)).history.at(-1)).toEqual({
      operation: "repair",
      liftoff: VERSION,
    });
  });

  it("keeps a changed file's mode, and makes a new one executable when the patch says", async () => {
    await generated();
    write("scripts/run.sh", "echo one\n");
    if (process.platform !== "win32") {
      const { chmodSync } = await import("node:fs");
      chmodSync(at("scripts/run.sh"), 0o755);
    }
    const added = diff("scripts/new.sh", null, "echo new\n").replace(
      "new file mode 100644",
      "new file mode 100755",
    );
    const repair = await patch(`${diff("scripts/run.sh", "echo one\n", "echo two\n")}${added}`, [
      "scripts",
    ]);
    const executable = process.platform !== "win32";
    expect(repair.plan?.changes.map((change) => [change.path, change.executable])).toEqual([
      ["scripts/new.sh", true],
      ["scripts/run.sh", executable],
      [MANIFEST_FILE, false],
    ]);
  });

  it.each<[string, () => string, string[], RegExp]>([
    [
      "a file Liftoff manages",
      () => diff(POLICY, read(POLICY), "x\n"),
      ["."],
      /which Liftoff manages; put it back with liftoff repair --restore/,
    ],
    [
      "liftoff.yaml",
      () => diff(CONFIG_FILE, read(CONFIG_FILE), "x\n"),
      ["."],
      /Liftoff's own records/,
    ],
    [".liftoff", () => diff(".liftoff/notes.txt", null, "x\n"), ["."], /Liftoff's own records/],
    [".git", () => diff(".git/config", null, "x\n"), ["."], /not a path in the project/],
    [
      "a file outside its paths",
      () => diff("README.md", read("README.md"), "x\n"),
      ["backend"],
      /outside the paths it may change \(backend\)/,
    ],
    [
      "a file that is not there",
      () => diff("missing.txt", "a\n", "b\n"),
      ["."],
      /which is not there/,
    ],
    [
      "a file that already exists",
      () => diff("README.md", null, "x\n"),
      ["."],
      /something is already there/,
    ],
    [
      "a file twice",
      () => `${diff("a.txt", null, "x\n")}${diff("A.txt", null, "y\n")}`,
      ["."],
      /changes A\.txt twice/,
    ],
    [
      "a file it does not change",
      () => diff("README.md", read("README.md"), read("README.md")),
      ["."],
      /does not change README\.md/,
    ],
  ])("refuses a patch that changes %s, changing nothing", async (_, text, paths, message) => {
    await generated();
    const before = snapshot();
    await expect(patch(text(), paths)).rejects.toThrow(message);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a patch that makes a path both a file and a directory", async () => {
    await generated();
    const nested = `${diff("backend/app/extra", null, "x\n")}${diff("backend/app/extra/y.py", null, "y\n")}`;
    await expect(patch(nested, ["backend"])).rejects.toThrow(
      "the patch makes backend/app/extra both a file and a directory of other files",
    );
  });

  it("refuses removing a file while leaving lines in it", async () => {
    await generated();
    write("two.txt", "one\ntwo\n");
    const partial = [
      "diff --git a/two.txt b/two.txt",
      "deleted file mode 100644",
      "--- a/two.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-one",
      "",
    ].join("\n");
    await expect(patch(partial, ["."])).rejects.toThrow(
      "the patch removes two.txt but leaves lines in it",
    );
  });

  it("refuses a framework's file, a link, text that is not UTF-8, large files and bad paths", async () => {
    await generated();
    age((manifest) => {
      manifest.files.push({
        path: "openspec/x.md",
        ownership: "framework",
        sha256: sha("x\n"),
        plugin: "workflow/openspec",
      });
    });
    write("openspec/x.md", "x\n");
    await expect(patch(diff("openspec/x.md", "x\n", "y\n"), ["."])).rejects.toThrow(
      "which workflow/openspec owns and Liftoff never changes",
    );
    mkdirSync(at("linked"));
    symlinkSync(at("backend"), at("linked/backend"), "junction");
    await expect(patch(diff("linked/backend/x.py", "a\n", "b\n"), ["."])).rejects.toThrow(
      /not a regular file of at most 4 MiB/,
    );
    writeFileSync(at("latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(patch(diff("latin.txt", "café\n", "cafe\n"), ["."])).rejects.toThrow(
      "which is not UTF-8 text, or changed as it was read",
    );
    const large = seeing({ "big.txt": { kind: "file", size: MAX_PATCH_BYTES + 1 } });
    await expect(patch(diff("big.txt", "a\n", "b\n"), ["."], large)).rejects.toThrow(
      /not a regular file of at most 4 MiB/,
    );
    await expect(patch("x".repeat(MAX_PATCH_BYTES + 1), ["."])).rejects.toThrow(
      "the patch is over 4 MiB",
    );
    await expect(patch(diff("a.txt", null, "x\n"), [])).rejects.toThrow(
      "a patch needs the paths it may change",
    );
    await expect(patch(diff("a.txt", null, "x\n"), ["../outside"])).rejects.toThrow(
      /\.\.\/outside cannot be a path a patch may change/,
    );
  });
});

describe("REPAIR-004 a saved repair is applied exactly as it was made", () => {
  it("plans the same restore or patch again, and refuses one for a project changed since", async () => {
    await generated();
    rmSync(at(VERIFY));
    const saved = parseChangePlan(JSON.stringify((await restore([VERIFY])).plan));
    expect((await planRepairFromSaved({ assets, fs }, saved, VERSION)).plan).toEqual(saved);

    const main = read("backend/app/main.py");
    const fix = { text: diff("backend/app/main.py", main, `${main}# fixed\n`), paths: ["backend"] };
    const patched = parseChangePlan(JSON.stringify((await patch(fix.text, fix.paths)).plan));
    expect((await planRepairFromSaved({ assets, fs }, patched, VERSION, fix)).plan).toEqual(
      patched,
    );
    await expect(planRepairFromSaved({ assets, fs }, patched, VERSION)).rejects.toThrow(
      "this plan applies a patch; give the same --patch and --paths again to apply it",
    );
    await expect(
      planRepairFromSaved({ assets, fs }, patched, VERSION, {
        ...fix,
        text: diff("backend/app/main.py", main, `${main}# other\n`),
      }),
    ).rejects.toThrow("the project or the patch changed since the plan was made");
    await expect(planRepairFromSaved({ assets, fs }, saved, "1.0.1")).rejects.toThrow(PlanError);
    const { hash: _, ...unsigned } = saved;
    const update = sealChangePlan({ ...unsigned, operation: "update" });
    await expect(planRepairFromSaved({ assets, fs }, update, VERSION)).rejects.toThrow(
      "this plan is for liftoff update, not liftoff repair",
    );
  });
});
