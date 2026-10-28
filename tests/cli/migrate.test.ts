import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { makeMigrateCommand } from "../../src/cli/commands/migrate.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { runCli } from "../../src/cli/run.ts";
import { CONFIG_FILE } from "../../src/domain/project/config.ts";
import { captureIo } from "../helpers/io.ts";
import { projectFiles } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
beforeEach(async () => {
  // Resolved as the CLI resolves the project directory.
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-migrate-cli-")));
  mkdirSync(root());
  mkdirSync(at(".git"));
  write("pyproject.toml", '[project]\nname = "shop"\ndependencies = ["fastapi"]\n');
  write("app/main.py", "from fastapi import FastAPI\n");
  write(".env", "SECRET=1\n");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "shop");
const target = () => path.join(work, "shop-liftoff");
const { at, write, snapshot } = projectFiles(root);

const migrate = async (
  argv: string[] = [],
  options: { answer?: boolean; port?: ProjectFsPort; cwd?: string } = {},
) => {
  const ports = (cwd: string) => ({ ...defaultProjectPorts(cwd), fs: options.port ?? fs });
  const io = captureIo(options.cwd ?? root(), options.answer);
  const code = await runCli(
    ["migrate", ...argv],
    io,
    [makeMigrateCommand(ports, path.join(work, "home")), makeInitCommand(ports)],
    "1.0.0",
  );
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

describe("MIGRATE-003 migrating from the command line", () => {
  it("checks, asks with no as the default, and migrates with --yes", async () => {
    const before = snapshot();
    const check = await migrate(["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`Liftoff 1.0.0 migrates ${root()} to ${target()} as:\n`);
    expect(check.out).toContain(
      "  backend         python-fastapi in backend (found: pyproject.toml)\n",
    );
    expect(check.out).toContain(
      "Parts of the project, and where the new project keeps them:\n  backend on python-fastapi in .: into backend/\n",
    );
    expect(check.out).toContain(
      "It copies 2 files (1 KiB) into legacy/, leaving out:\n  .env: may hold secrets or state, so only its name was seen\n  .git: Git's own data\n",
    );
    expect(check.out).toMatch(
      /Plan [0-9a-f]{12}: creates \d+ files in .*shop-liftoff, 2 of them copied from .*shop\. Effects: write-files, copy-files/,
    );
    const declined = await migrate([], { answer: false });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual([`Create the new project in ${target()}?`]);
    expect(declined.out).toBe("Nothing was created.\n");
    const scripted = await migrate();
    expect(scripted.code).toBe(2);
    expect(scripted.err).toContain("migrate writes files; pass --yes to confirm");
    expect(existsSync(target())).toBe(false);

    const migrated = await migrate(["--yes", "--json"]);
    expect(migrated.code).toBe(0);
    const report = JSON.parse(migrated.out);
    expect(report).toMatchObject({
      migratable: true,
      created: true,
      copied: 2,
      differences: [],
      blocked: [],
    });
    expect(report.left).toEqual([
      expect.objectContaining({ path: ".env", kind: "secrets" }),
      expect.objectContaining({ path: ".git", kind: "git" }),
    ]);
    expect(snapshot()).toEqual(before);
    expect(existsSync(path.join(target(), CONFIG_FILE))).toBe(true);
    const again = await migrate(["--check"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already has files");
  });

  it("says where to go next, and puts the new project where --to names", async () => {
    const run = await migrate(["--yes", "--to", "../next"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(", 2 of them copied from ");
    expect(run.out).toContain(
      `which is unchanged.\n\nNext:\n  cd ${path.join("..", "next")}\n  follow MIGRATION.md`,
    );
    expect(readdirSync(work).sort()).toEqual(["shop", "next"].sort());
  });

  it("exits 3 when the project cannot be migrated, and 2 for an option's mistake", async () => {
    rmSync(at("pyproject.toml"));
    write("package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    const blocked = await migrate(["--check"]);
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(
      `Liftoff cannot migrate ${root()} as it is; nothing was created:\n`,
    );
    expect(blocked.out).toContain("name the stack to move it to with --stack\n");
    expect((await migrate(["--yes"])).code).toBe(3);
    expect((await migrate(["--check", "--stack", "node-fastify"])).code).toBe(0);
    for (const [argv, message] of [
      [["--check", "--agents", "gemini"], '--agents: unknown agent "gemini"'],
      [["--check", "--out", "../plan.json"], "--check writes nothing"],
      [["--plan", "../plan.json", "--stack", "go-huma"], "--plan goes without --stack"],
      [["--plan", "../plan.json", "--to", "../x"], "--plan goes without --to"],
      [["--layout", "backend=api"], "unknown option '--layout'"],
    ] as const) {
      const run = await migrate([...argv]);
      expect(run.code, argv.join(" ")).toBe(2);
      expect(run.err).toContain(message);
    }
    // Outside a Git repository's root, the directory must be named.
    const outside = await migrate(["--check"], { cwd: work });
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("is not the root of a Git repository; name it with --dir");
  });

  it("refuses a new project reached through a link into the old one, and a plan saved in either", async () => {
    const linked = path.join(work, "shoplink");
    symlinkSync(root(), linked, "junction");
    const through = await migrate(["--check", "--to", "../shoplink/next"]);
    expect(through.code).toBe(1);
    expect(through.err).toContain("overlaps the project it is made from");
    const deeper = await migrate(["--check", "--to", "../shoplink/new/project"]);
    expect(deeper.code).toBe(1);
    expect(deeper.err).toContain("where the new project goes, is not a directory; make it first");

    const before = snapshot();
    const inside = await migrate(["--out", "migrate.json"]);
    expect(inside.code).toBe(2);
    expect(inside.err).toContain(
      `--out migrate.json is in ${root()}, which migrating does not write to; save the plan elsewhere`,
    );
    mkdirSync(target());
    const inTarget = await migrate(["--out", "../shop-liftoff/plan.json"]);
    expect(inTarget.code).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(target())).toEqual([]);
  });

  it("refuses a target or a plan named with two dots inside the old project, and a plan written through a link", async () => {
    const before = snapshot();
    const dotted = await migrate(["--check", "--to", "./..next"]);
    expect(dotted.code).toBe(1);
    expect(dotted.err).toContain("overlaps the project it is made from");
    const plan = await migrate(["--out", "..plan.json"]);
    expect(plan.code).toBe(2);
    expect(plan.err).toContain("which migrating does not write to");
    expect(snapshot()).toEqual(before);
    // A plan saved where another name for one of the old project's files is
    // replaces that name, and leaves the file as it was.
    linkSync(at("app/main.py"), path.join(work, "hard.json"));
    const hard = await migrate(["--out", "../hard.json"]);
    expect(hard.code).toBe(0);
    expect(snapshot()).toEqual(before);
    // A link to a file is a privilege on Windows, so this part runs elsewhere.
    if (process.platform === "win32") return;
    symlinkSync(path.join(root(), "new-plan.json"), path.join(work, "plan.json"));
    const linked = await migrate(["--out", "../plan.json"]);
    expect(linked.code).toBe(2);
    expect(linked.err).toContain(
      "--out ../plan.json is a link, which Liftoff does not write through",
    );
    expect(snapshot()).toEqual(before);
  });

  it("cancels on Ctrl+C while it plans, even with --check", async () => {
    const io = captureIo(root());
    const aborting = Object.assign(Object.create(fs) as ProjectFsPort, {
      hashWithin: (directory: string, relative: string, maxBytes: number) => {
        io.controller.abort();
        return fs.hashWithin(directory, relative, maxBytes);
      },
    });
    const command = makeMigrateCommand(
      (cwd) => ({ ...defaultProjectPorts(cwd), fs: aborting }),
      path.join(work, "home"),
    );
    expect(await runCli(["migrate", "--check"], io, [command], "1.0.0")).toBe(4);
    expect(io.out.join("")).toBe("");
  });

  it("saves a plan, applies exactly that plan, and refuses it once the project changed", async () => {
    const before = snapshot();
    const saved = await migrate(["--out", "../migrate.json", "--agents", "claude"]);
    expect(saved.code).toBe(0);
    expect(saved.out).toContain("Apply it with: liftoff migrate --plan ../migrate.json\n");
    expect(snapshot()).toEqual(before);
    expect(existsSync(target())).toBe(false);
    const init = await migrate(["--plan", "../migrate.json", "--yes"]);
    expect(init.code).toBe(0);
    rmSync(target(), { recursive: true });

    write("app/main.py", "changed\n");
    const stale = await migrate(["--plan", "../migrate.json", "--yes"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("the project changed since the plan was made");
    expect(existsSync(target())).toBe(false);
    // Each command applies only its own plans.
    const io = captureIo(root());
    const asInit = await runCli(
      ["init", "--plan", "../migrate.json", "--yes"],
      io,
      [makeInitCommand((cwd) => ({ ...defaultProjectPorts(cwd), fs }))],
      "1.0.0",
    );
    expect(asInit).toBe(1);
    expect(io.err.join("")).toContain("this plan is for liftoff migrate, not liftoff init");
  });

  it("creates nothing when a file changes as it is copied, and exits 3 when the result differs", async () => {
    const changing = Object.assign(Object.create(fs) as ProjectFsPort, {
      copyWithin: (directory: string, relative: string, maxBytes: number, to: string) => {
        if (relative === "app/main.py") writeFileSync(at("app/main.py"), "edited meanwhile\n");
        return fs.copyWithin(directory, relative, maxBytes, to);
      },
    });
    const changed = await migrate(["--yes"], { port: changing });
    expect(changed.code).toBe(1);
    expect(changed.err).toContain(
      "app/main.py changed since the migration was planned, so nothing was created; plan it again",
    );
    expect(readdirSync(work)).toEqual(["shop"]);

    const tampering = Object.assign(Object.create(fs) as ProjectFsPort, {
      publish: async (staging: string, to: string) => {
        await fs.publish(staging, to);
        writeFileSync(path.join(to, "legacy", "pyproject.toml"), "edited\n");
      },
    });
    const differs = await migrate(["--yes"], { port: tampering });
    expect(differs.code).toBe(3);
    expect(differs.out).toContain(
      "Reading the new project back found:\n  - legacy/pyproject.toml is not as planned\n",
    );
  });
});
