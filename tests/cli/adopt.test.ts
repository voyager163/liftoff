import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { makeAdoptCommand } from "../../src/cli/commands/adopt.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeRepairCommand } from "../../src/cli/commands/repair.ts";
import { makeValidateCommand } from "../../src/cli/commands/validate-doctor.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { CONFIG_FILE } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE } from "../../src/domain/project/manifest.ts";
import { captureIo } from "../helpers/io.ts";
import { projectFiles } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
beforeEach(async () => {
  // Resolved as the CLI resolves the project directory.
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-adopt-cli-")));
  mkdirSync(root());
  mkdirSync(at(".git"));
  write("pyproject.toml", '[project]\nname = "shop"\ndependencies = ["fastapi"]\n');
  write(".gitignore", ".venv/\n");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "shop");
const { at, write, snapshot } = projectFiles(root);

const adopt = async (
  argv: string[] = [],
  options: { answer?: boolean; port?: ProjectFsPort; cwd?: string } = {},
) => {
  const ports = (cwd: string) => ({ ...defaultProjectPorts(cwd), fs: options.port ?? fs });
  const io = captureIo(options.cwd ?? root(), options.answer);
  const code = await runCli(
    ["adopt", ...argv],
    io,
    [makeAdoptCommand(ports, path.join(work, "home")), makeRepairCommand(ports)],
    "1.0.0",
  );
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

describe("ADOPT-005 adopting from the command line", () => {
  it("checks, asks with no as the default, and adopts with --yes", async () => {
    const before = snapshot();
    const check = await adopt(["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`Liftoff 1.0.0 adopts ${root()} as:\n`);
    expect(check.out).toContain("  backend         python-fastapi in . (found: pyproject.toml)\n");
    expect(check.out).toContain(
      "Already there, so kept as the project's and not added:\n  .gitignore: the project has a file there\n",
    );
    expect(check.out).toContain(
      "Application changes the standard expects, which adopting does not make:\n",
    );
    expect(check.out).toMatch(/Plan [0-9a-f]{12}: changes \d+ files, then the manifest\./);
    const declined = await adopt([], { answer: false });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual([expect.stringMatching(/^In .*shop, change \d+ files/)]);
    expect(snapshot()).toEqual(before);
    const scripted = await adopt();
    expect(scripted.code).toBe(2);
    expect(scripted.err).toContain("adopt changes files; pass --yes to confirm");

    const adopted = await adopt(["--yes", "--json"]);
    expect(adopted.code).toBe(0);
    const report = JSON.parse(adopted.out);
    expect(report).toMatchObject({ adoptable: true, changed: true, blocked: [] });
    expect(report.config.layout).toEqual({ backend: "." });
    expect(existsSync(at(CONFIG_FILE))).toBe(true);
    expect(existsSync(at(MANIFEST_FILE))).toBe(true);
    const again = await adopt(["--check"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("liftoff.yaml is already here, so this is a Liftoff project");
  });

  it("exits 3 when a part cannot be placed, and 6 when no backend is supported", async () => {
    write("orders/pyproject.toml", '[project]\nname = "orders"\ndependencies = ["fastapi"]\n');
    const blocked = await adopt(["--check"]);
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(
      `Liftoff cannot adopt ${root()} as it is; nothing was changed:\n`,
    );
    expect(blocked.out).toContain(
      "  - 2 directories hold a backend (python-fastapi in ., python-fastapi in orders); name the one to adopt with --layout backend=<directory>\n",
    );
    expect((await adopt(["--yes"])).code).toBe(3);
    expect((await adopt(["--check", "--layout", "backend=./orders/"])).code).toBe(0);
    rmSync(at("pyproject.toml"));
    rmSync(at("orders"), { recursive: true });
    write("package.json", '{"dependencies":{"express":"^5.0.0"}}\n');
    const unsupported = await adopt(["--check", "--json"]);
    expect(unsupported.code).toBe(6);
    expect(JSON.parse(unsupported.out)).toMatchObject({ adoptable: false, changed: false });
  });

  it("refuses options it cannot use", async () => {
    for (const [argv, message] of [
      [["--layout", "api"], "--layout takes part=directory pairs"],
      [["--layout", "cli=tools"], "--layout takes part=directory pairs"],
      [["--layout", "backend=a,backend=b"], "--layout binds the backend twice"],
      [["--check", "--out", "../plan.json"], "--check writes nothing"],
      [
        ["--recover", "undo", "--name", "x"],
        "--recover goes only with --dir and --yes, not --name",
      ],
      [["--plan", "../plan.json", "--agents", "claude"], "--plan goes without --agents"],
      [["--check", "--agents", "gemini"], "gemini"],
      [["--check", "--owners", "bad!login"], "an option is invalid: owners"],
    ] as const) {
      const run = await adopt([...argv]);
      expect(run.code, argv.join(" ")).toBe(2);
      expect(run.err).toContain(message);
    }
    // Outside a Git repository's root, the directory must be named.
    const outside = await adopt(["--check"], { cwd: work });
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("is not the root of a Git repository; name it with --dir");
  });

  it("saves a plan and applies exactly that plan", async () => {
    const before = snapshot();
    const saved = await adopt(["--out", "../adopt.json", "--agents", "claude"]);
    expect(saved.code).toBe(0);
    expect(saved.out).toContain("Apply it with: liftoff adopt --plan ../adopt.json\n");
    expect(snapshot()).toEqual(before);
    write("Dockerfile", "FROM scratch\n");
    write(".github/workflows/01-pr-ci.yml", "name: ours\n");
    const stale = await adopt(["--plan", "../adopt.json", "--yes"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("the project changed since the plan was made");
    rmSync(at(".github"), { recursive: true });
    const applied = await adopt(["--plan", "../adopt.json", "--yes"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Adopted shop: added ");
  });

  it("stops part way recoverably, and validate reports it before liftoff.yaml is there", async () => {
    const before = snapshot();
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        moves += 1;
        if (moves === 3) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    const stopped = await adopt(["--yes"], { port: failing });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The adoption stopped part way: no space left on the disk");
    expect(stopped.out).toContain("Finish it with liftoff adopt --recover finish");
    expect(existsSync(at(CONFIG_FILE))).toBe(false);
    const io = captureIo(root());
    const validate = makeValidateCommand(() => ({ ...defaultProjectPorts(root()), fs }));
    expect(await runCli(["validate"], io, [validate], "1.0.0")).toBe(3);
    expect(io.out.join("")).toContain(
      "a change by liftoff adopt that began 20", // its start time follows
    );
    const repairing = await adopt([]);
    expect(repairing.code).toBe(1);
    expect(repairing.err).toContain("has not finished; unless it is still running");
    const undone = await adopt(["--recover", "undo", "--yes"]);
    expect(undone.code).toBe(0);
    expect(undone.out).toContain("The adoption is undone:");
    expect(existsSync(at(CHANGE_JOURNAL_FILE))).toBe(false);
    // Every file is as it was; only the empty directories made for them stay.
    expect(snapshot()).toEqual(before);
    const nothing = await adopt(["--recover", "finish", "--yes"]);
    expect(nothing.out).toContain("No adoption to");
    expect((await adopt(["--yes"])).code).toBe(0);
  });
});
