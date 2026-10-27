import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { applyChanges, ChangeConflictError } from "../../src/application/change/apply-changes.ts";
import { applyInit, planInit } from "../../src/application/init/init-project.ts";
import type { FileHash, ProjectFsPort } from "../../src/application/ports.ts";
import { validateProject } from "../../src/application/project/validate-project.ts";
import {
  planFromSaved,
  planUpdate,
  UpdateError,
  type UpdatePlan,
  UpdateUnsupportedError,
  updateAvailable,
} from "../../src/application/update/update-project.ts";
import {
  type ChangePlan,
  parseChangePlan,
  sealChangePlan,
} from "../../src/domain/plan/change-plan.ts";
import { PlanError } from "../../src/domain/plan/plan.ts";
import { CONFIG_FILE, serializeConfig, validateConfig } from "../../src/domain/project/config.ts";
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
  work = mkdtempSync(path.join(tmpdir(), "liftoff-update-"));
  root = path.join(work, "demo");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const { at, write, read, snapshot, age } = projectFiles(() => root);

const configOf = (overrides: Record<string, unknown> = {}) =>
  validateConfig({
    schema: "liftoff.config/v1",
    name: "demo",
    workload: "api",
    stack: "python-fastapi",
    workflow: "manual",
    agents: ["claude"],
    governance: "single-maintainer-gitflow",
    review: { ai: true },
    ...overrides,
  });

const generated = async () => {
  const plan = await planInit(
    { assets, fs },
    { config: configOf(), target: root, liftoffVersion: VERSION },
  );
  await applyInit({ assets, fs, initializer: new FakeInitializer() }, plan, VERSION);
};

const plan = (options: { add?: ReadonlySet<string> } = {}, port: ProjectFsPort = fs) =>
  planUpdate({ assets, fs: port }, root, VERSION, options);

const steps = (update: UpdatePlan) => update.files.map((file) => `${file.step} ${file.path}`);

const changePorts = {
  fs,
  processes: {
    pid: process.pid,
    host: "test-host",
    isRunning: (pid: number) => pid === process.pid,
  },
  now: () => "2026-10-27T12:00:00Z",
};

const apply = (update: UpdatePlan) => {
  if (update.plan === undefined) throw new Error("the update changes nothing");
  return applyChanges(changePorts, update.plan, update.contents);
};

/** A port that reports these files as hashWithin would see them, and the rest as they are. */
const seeing = (files: Record<string, FileHash>): ProjectFsPort =>
  Object.assign(Object.create(fs) as ProjectFsPort, {
    hashWithin: async (directory: string, relative: string, maxBytes: number) =>
      files[relative] ?? fs.hashWithin(directory, relative, maxBytes),
  });

const VERIFY = SKILL("liftoff-verify");
const PR = SKILL("liftoff-pr");
const ASSESS = SKILL("liftoff-assess");
const POLICY = ".github/liftoff/review-policy.mjs";
const AGENT = ".github/liftoff/review-agent.sh";

describe("UPDATE-001 update changes only the files Liftoff manages", () => {
  it("takes this release's version of each managed file still as Liftoff wrote it, and leaves the rest", async () => {
    await generated();
    const current = { verify: read(VERIFY), agent: read(AGENT), readme: read("README.md") };
    const config = read(CONFIG_FILE);
    const workflow = (name: string, content: string) => ({
      path: `.github/workflows/${name}`,
      ownership: "managed" as const,
      sha256: sha(content),
      plugin: "review/layered",
    });
    age((manifest) => {
      write(VERIFY, "old verify\n");
      entry(manifest, VERIFY).sha256 = sha("old verify\n");
      write(AGENT, "#!/bin/sh\nold\n");
      entry(manifest, AGENT).sha256 = sha("#!/bin/sh\nold\n");
      // Already as this release makes it.
      entry(manifest, POLICY).sha256 = sha("older policy\n");
      // Changed by hand.
      write(PR, "mine\n");
      entry(manifest, PR).sha256 = sha("older pr\n");
      // Files this release no longer makes: as written, changed, and gone.
      write(".github/workflows/99-old.yml", "old\n");
      write(".github/workflows/97-mine.yml", "mine\n");
      manifest.files.push(
        workflow("99-old.yml", "old\n"),
        workflow("97-mine.yml", "old\n"),
        workflow("98-gone.yml", "gone\n"),
      );
      // The project's own, whatever its template now says.
      entry(manifest, "README.md").sha256 = sha("older readme\n");
      // Managed then, the project's now: never changes owner.
      entry(manifest, ".gitattributes").ownership = "managed";
      entry(manifest, ".gitattributes").sha256 = sha("older\n");
      manifest.plugins = manifest.plugins.map((plugin) =>
        plugin.id === "review/layered" ? { ...plugin, version: "0" } : plugin,
      );
    });
    const history = parseManifest(read(MANIFEST_FILE)).history;

    const update = await plan();
    expect(steps(update)).toEqual([
      `hold ${PR}`,
      `update ${VERIFY}`,
      `update ${AGENT}`,
      `record ${POLICY}`,
      "hold .github/workflows/97-mine.yml",
      "record .github/workflows/98-gone.yml",
      "remove .github/workflows/99-old.yml",
    ]);
    expect(update.files.find((file) => file.path === PR)?.reason).toContain(
      "restore it from version control",
    );
    expect(
      update.files.find((file) => file.path === ".github/workflows/97-mine.yml")?.reason,
    ).toContain("no longer makes it");
    expect(update.plugins).toEqual([{ id: "review/layered", from: "0", to: "1" }]);
    expect(update.plan?.changes.map((change) => change.path)).toEqual([
      VERIFY,
      AGENT,
      ".github/workflows/99-old.yml",
      MANIFEST_FILE,
    ]);
    expect(updateAvailable(update)).toBe(true);

    await apply(update);
    expect(read(VERIFY)).toBe(current.verify);
    expect(read(AGENT)).toBe(current.agent);
    if (process.platform !== "win32") expect(statSync(at(AGENT)).mode & 0o111).not.toBe(0);
    expect(() => statSync(at(".github/workflows/99-old.yml"))).toThrow();
    expect(read(".github/workflows/97-mine.yml")).toBe("mine\n");
    expect(read(PR)).toBe("mine\n");
    expect(read("README.md")).toBe(current.readme);
    expect(read(CONFIG_FILE)).toBe(config);

    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.generatedBy).toEqual({ liftoff: VERSION });
    expect(manifest.history).toEqual([...history, { operation: "update", liftoff: VERSION }]);
    expect(manifest.plugins).toContainEqual({ id: "review/layered", version: "1" });
    expect(entry(manifest, PR).sha256).toBe(sha("older pr\n"));
    expect(entry(manifest, POLICY).sha256).toBe(sha(read(POLICY)));
    expect(entry(manifest, VERIFY).sha256).toBe(sha(current.verify));
    expect(entry(manifest, ".gitattributes").ownership).toBe("managed");
    expect(manifest.files.map((file) => file.path)).not.toContain(".github/workflows/98-gone.yml");
    expect(manifest.files.map((file) => file.path)).not.toContain(".github/workflows/99-old.yml");

    const again = await plan();
    expect(steps(again)).toEqual([`hold ${PR}`, "hold .github/workflows/97-mine.yml"]);
    expect(again.plan).toBeUndefined();
    expect(updateAvailable(again)).toBe(true);
    const findings = (await validateProject(fs, root)).findings.map(
      (finding) => `${finding.code} ${finding.path}`,
    );
    expect(findings).toEqual([
      `managed-file-changed ${PR}`,
      "managed-file-changed .gitattributes",
      "managed-file-changed .github/workflows/97-mine.yml",
    ]);
  });

  it("never changes liftoff.yaml, a file it now makes as the project's, or one listed in other letter case", async () => {
    await generated();
    const lower = (relative: string) => relative.replace("SKILL.md", "skill.md");
    age((manifest) => {
      entry(manifest, CONFIG_FILE).ownership = "managed";
      // Listed in other letter case: as this release makes it, and older.
      entry(manifest, VERIFY).path = lower(VERIFY);
      entry(manifest, PR).path = lower(PR);
      entry(manifest, lower(PR)).sha256 = sha("older pr\n");
      Object.assign(entry(manifest, "README.md"), { path: "Readme.md", ownership: "managed" });
    });
    const before = snapshot();
    const update = await plan();
    expect(update.files).toEqual([
      {
        path: lower(PR),
        step: "hold",
        reason: `this release names it ${PR}, in other letter case; rename it to take this release's version`,
      },
    ]);
    expect(update.plan).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });

  it("has nothing to change in a project this release made", async () => {
    await generated();
    const update = await plan();
    expect(update).toMatchObject({ files: [], plugins: [], name: "demo", directory: root });
    expect(update.plan).toBeUndefined();
    expect(updateAvailable(update)).toBe(false);
  });

  it("holds back a managed file that is missing, a directory, a link, closed or too large", async () => {
    await generated();
    const names = [
      "liftoff-pr",
      "liftoff-risk",
      "liftoff-simplify",
      "liftoff-verify",
      "liftoff-setup",
    ];
    const [missing, directory, link, closed, large] = names.map(SKILL) as [
      string,
      string,
      string,
      string,
      string,
    ];
    age((manifest) => {
      for (const name of names) entry(manifest, SKILL(name)).sha256 = sha("older\n");
    });
    rmSync(at(missing));
    rmSync(at(directory));
    mkdirSync(at(directory));
    rmSync(at(link));
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    symlinkSync(outside, at(link), "junction");
    const before = snapshot();
    const update = await plan(
      {},
      seeing({ [closed]: { kind: "inaccessible" }, [large]: { kind: "file", size: 1 } }),
    );
    expect(update.files.map((file) => [file.path, file.step, file.reason])).toEqual([
      [missing, "hold", expect.stringContaining("missing")],
      [directory, "hold", expect.stringContaining("a directory")],
      [large, "hold", expect.stringContaining("over 64 MiB")],
      [link, "hold", expect.stringContaining("a link")],
      [closed, "hold", expect.stringContaining("cannot be read by this user")],
    ]);
    expect(update.plan).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });
});

describe("UPDATE-002 update never switches what the project is made of", () => {
  const journal = {
    schema: "liftoff.change-journal/v1",
    operation: "repair",
    plan: "a".repeat(64),
    started: "2026-10-27T11:00:00Z",
    staging: ".demo.liftoff-staging-abc123",
    changes: [],
  };

  it.each<[string, () => void, RegExp]>([
    [
      "liftoff.yaml was changed",
      () => write(CONFIG_FILE, `${read(CONFIG_FILE)}# mine\n`),
      /liftoff\.yaml changed since Liftoff last wrote it/,
    ],
    [
      "the manifest does not record liftoff.yaml",
      () =>
        age((manifest) =>
          manifest.files.splice(manifest.files.indexOf(entry(manifest, CONFIG_FILE)), 1),
        ),
      /liftoff\.yaml changed since Liftoff last wrote it/,
    ],
    [
      "this release would add a plugin",
      () => age((manifest) => manifest.plugins.splice(0, 1)),
      /\(it adds agents\/integration\), and update never switches/,
    ],
    [
      "this release would drop a plugin",
      () => age((manifest) => manifest.plugins.push({ id: "workflow/openspec", version: "1" })),
      /it drops workflow\/openspec/,
    ],
    [
      "a change has not finished",
      () => write(".liftoff/change-journal.json", JSON.stringify(journal)),
      /a change by liftoff repair that began 2026-10-27T11:00:00Z has not finished; .* liftoff repair --recover first/,
    ],
    [
      "a change's journal cannot be read",
      () => write(".liftoff/change-journal.json", "{"),
      /its journal cannot be read: .*if it is empty/,
    ],
    [
      "liftoff.yaml is not valid",
      () => write(CONFIG_FILE, "name: ["),
      /not valid YAML[\s\S]*; liftoff validate says more/,
    ],
    ["the manifest is not valid", () => write(MANIFEST_FILE, "{}"), /manifest\.json is invalid/],
    ["the manifest is missing", () => rmSync(at(MANIFEST_FILE)), /manifest\.json is missing/],
    [
      "liftoff.yaml is a directory",
      () => {
        rmSync(at(CONFIG_FILE));
        mkdirSync(at(CONFIG_FILE));
      },
      /liftoff\.yaml is not a regular file of at most 1 MiB/,
    ],
    ["there is no liftoff.yaml", () => rmSync(at(CONFIG_FILE)), /there is no liftoff\.yaml in/],
  ])("refuses when %s, changing nothing", async (_, edit, message) => {
    await generated();
    edit();
    const before = snapshot();
    await expect(plan()).rejects.toThrow(UpdateError);
    await expect(plan()).rejects.toThrow(message);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a directory that is not there, and liftoff.yaml closed to this user", async () => {
    await expect(plan()).rejects.toThrow(/is not a directory Liftoff can update/);
    await generated();
    const closed = Object.assign(Object.create(fs) as ProjectFsPort, {
      readWithin: async (directory: string, relative: string, maxBytes: number) =>
        relative === CONFIG_FILE
          ? { kind: "inaccessible" }
          : fs.readWithin(directory, relative, maxBytes),
    });
    await expect(plan({}, closed)).rejects.toThrow("liftoff.yaml cannot be read by this user");
  });

  it("cannot update a project from before the rebuild, or one in another layout", async () => {
    mkdirSync(root);
    writeFileSync(
      at("liftoff.manifest.json"),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    await expect(plan()).rejects.toThrow(UpdateUnsupportedError);
    await expect(plan()).rejects.toThrow(/before the rebuild/);
    rmSync(root, { recursive: true });

    await generated();
    const bound = serializeConfig(configOf({ layout: { backend: "api" } }));
    write(CONFIG_FILE, bound);
    age((manifest) => {
      entry(manifest, CONFIG_FILE).sha256 = sha(bound);
    });
    await expect(plan()).rejects.toThrow(UpdateUnsupportedError);
    await expect(plan()).rejects.toThrow(/only projects in the standard layout/);
  });
});

describe("UPDATE-003 new files are added only when chosen", () => {
  it("offers each new file, adds only those named, and never adds over anything", async () => {
    await generated();
    const content = read(ASSESS);
    const governance = SKILL("liftoff-governance-assess");
    const [kept, directory, closed] = [
      SKILL("liftoff-setup"),
      SKILL("liftoff-risk"),
      SKILL("liftoff-simplify"),
    ];
    const added = [ASSESS, governance, kept, directory, closed, SKILL("liftoff-pr")];
    age((manifest) => {
      manifest.files = manifest.files.filter((file) => !added.includes(file.path));
      // Listed under another letter case, as the project's own.
      manifest.files.push({
        path: SKILL("liftoff-pr").toLowerCase(),
        ownership: "seeded",
        sha256: sha("mine\n"),
        plugin: "agents/integration",
      });
    });
    rmSync(at(ASSESS));
    rmSync(at(governance));
    rmSync(at(directory));
    mkdirSync(at(directory));
    const port = seeing({ [closed]: { kind: "inaccessible" } });

    const offered = await plan({}, port);
    expect(offered.files.map((file) => [file.step, file.path, file.ownership])).toEqual([
      ["offer", ASSESS, "managed"],
      ["offer", governance, "managed"],
      ["occupied", directory, "managed"],
      ["occupied", kept, "managed"],
      ["occupied", closed, "managed"],
    ]);
    expect(offered.files.find((file) => file.path === kept)?.reason).toBe(
      "a file is already there, and Liftoff never replaces what it did not write",
    );
    expect(offered.files.find((file) => file.path === closed)?.reason).toContain(
      "closed to this user",
    );
    expect(offered.plan).toBeUndefined();
    expect(updateAvailable(offered)).toBe(true);

    const update = await plan({ add: new Set([ASSESS]) }, port);
    expect(steps(update).slice(0, 2)).toEqual([`add ${ASSESS}`, `offer ${governance}`]);
    expect(update.plan?.changes[0]).toEqual({
      path: ASSESS,
      before: null,
      after: sha(content),
      ownership: "managed",
      executable: false,
    });
    await apply(update);
    expect(read(ASSESS)).toBe(content);
    expect(entry(parseManifest(read(MANIFEST_FILE)), ASSESS)).toMatchObject({
      ownership: "managed",
      sha256: sha(content),
    });
    expect(() => statSync(at(governance))).toThrow();
  });

  it("does not add through a link", async () => {
    await generated();
    age((manifest) => {
      manifest.files = manifest.files.filter((file) => !file.path.startsWith(".claude/skills/"));
    });
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    rmSync(at(".claude/skills"), { recursive: true });
    symlinkSync(outside, at(".claude/skills"), "junction");
    const update = await plan({ add: new Set([ASSESS]) });
    expect(update.files.find((file) => file.path === ASSESS)).toMatchObject({
      step: "occupied",
      reason: expect.stringContaining("a link"),
    });
    expect(update.plan).toBeUndefined();
  });
});

describe("UPDATE-004 a saved plan is applied exactly as it was made", () => {
  const older = async () => {
    await generated();
    age((manifest) => {
      write(VERIFY, "old verify\n");
      entry(manifest, VERIFY).sha256 = sha("old verify\n");
      manifest.files = manifest.files.filter((file) => file.path !== ASSESS);
    });
    rmSync(at(ASSESS));
  };
  const saved = async (add: ReadonlySet<string> = new Set()) => {
    const update = await plan({ add });
    return parseChangePlan(JSON.stringify(update.plan));
  };

  it("plans the same update again, with the same new files", async () => {
    await older();
    const kept = await saved(new Set([ASSESS]));
    const update = await planFromSaved({ assets, fs }, kept, VERSION);
    expect(update.plan).toEqual(kept);
    expect(steps(update)).toEqual([`add ${ASSESS}`, `update ${VERIFY}`]);
  });

  it("refuses a plan another release made, or for another command", async () => {
    await older();
    const kept = await saved();
    await expect(planFromSaved({ assets, fs }, kept, "1.0.1")).rejects.toThrow(
      "the plan was made by Liftoff 1.0.0, but this is 1.0.1; make a new plan",
    );
    const { hash: _, ...unsigned } = kept;
    const repair: ChangePlan = sealChangePlan({ ...unsigned, operation: "repair" });
    await expect(planFromSaved({ assets, fs }, repair, VERSION)).rejects.toThrow(
      "this plan is for liftoff repair, not liftoff update",
    );
  });

  it("refuses a plan for a project changed since, and never overwrites a file edited before it applies", async () => {
    await older();
    const kept = await saved();
    write(VERIFY, "edited\n");
    await expect(planFromSaved({ assets, fs }, kept, VERSION)).rejects.toThrow(PlanError);
    await expect(planFromSaved({ assets, fs }, kept, VERSION)).rejects.toThrow(
      /the project changed since the plan was made/,
    );

    write(VERIFY, "old verify\n");
    const update = await plan();
    write(VERIFY, "edited again\n");
    const before = snapshot();
    await expect(apply(update)).rejects.toThrow(ChangeConflictError);
    expect(snapshot()).toEqual(before);
  });
});
