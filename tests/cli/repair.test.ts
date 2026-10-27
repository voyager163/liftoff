import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { MAX_PATCH_BYTES, type RepairPlan } from "../../src/application/repair/repair-project.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeRepairCommand, renderRepair } from "../../src/cli/commands/repair.ts";
import { makeUpdateCommand } from "../../src/cli/commands/update.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { type Answers, captureIo } from "../helpers/io.ts";
import { projectFiles, SKILL } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
beforeEach(async () => {
  // Resolved as the CLI resolves the project directory.
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-repair-cli-")));
  const init = makeInitCommand((cwd) => ({
    ...defaultProjectPorts(cwd),
    initializer: new FakeInitializer(),
  }));
  await runCli(
    ["init", "--name", "demo", "--workflow", "manual", "--agents", "claude", "--yes"],
    captureIo(work),
    [init],
    "1.0.0",
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "demo");
const { at, write, read, snapshot } = projectFiles(root);
const VERIFY = SKILL("liftoff-verify");
const POLICY = ".github/liftoff/review-policy.mjs";

const repair = async (
  argv: string[] = [],
  options: { answer?: boolean; answers?: Answers; port?: ProjectFsPort } = {},
) => {
  const ports = (cwd: string) => ({ ...defaultProjectPorts(cwd), fs: options.port ?? fs });
  const io = captureIo(root(), options.answer, options.answers);
  const code = await runCli(
    ["repair", ...argv],
    io,
    [makeRepairCommand(ports), makeUpdateCommand(ports)],
    "1.0.0",
  );
  return {
    code,
    out: io.out.join(""),
    err: io.err.join(""),
    questions: io.questions,
    asked: io.asked,
  };
};

/** A deleted managed file and a hand-edited one. */
const damaged = () => {
  rmSync(at(VERIFY));
  write(POLICY, "mine\n");
};

/** A patch, as git diff writes one, appending a line to backend/app/main.py. */
const fix = (line = "# fixed") => {
  const main = read("backend/app/main.py").split("\n").slice(0, -1);
  const last = main.length;
  const text = [
    "diff --git a/backend/app/main.py b/backend/app/main.py",
    "--- a/backend/app/main.py",
    "+++ b/backend/app/main.py",
    `@@ -${last} +${last},2 @@`,
    ` ${main[last - 1]}`,
    `+${line}`,
    "",
  ].join("\n");
  writeFileSync(path.join(work, "fix.diff"), text);
  return "../fix.diff";
};

describe("REPAIR-001 the inventory from the command line", () => {
  it("exits 0 when every Liftoff file is as it should be, and 3 with a report when not", async () => {
    const clean = await repair(["--check"]);
    expect(clean.code).toBe(0);
    expect(clean.out).toBe(`Every file Liftoff wrote in demo in ${root()} is as it should be.\n`);
    damaged();
    const before = snapshot();
    const { code, out } = await repair(["--check", "--json"]);
    expect(code).toBe(3);
    expect(JSON.parse(out)).toMatchObject({
      schema: "liftoff.repair/v1",
      outcome: "attention",
      needed: true,
      changed: false,
      files: [
        { path: VERIFY, step: "offer", problem: "a file Liftoff manages is missing" },
        { path: POLICY, step: "offer", problem: "a file Liftoff manages was changed by hand" },
      ],
    });
    const text = await repair(["--check"]);
    expect(text.out).toContain(
      `2 files Liftoff wrote in demo in ${root()} are not as Liftoff left them:`,
    );
    expect(text.out).toContain(
      `Repair can put these back, if you choose them or name them with --restore:\n  ${VERIFY}: a file Liftoff manages is missing\n`,
    );
    expect(snapshot()).toEqual(before);
  });

  it("escapes what would change how a terminal shows a line", () => {
    const plan: RepairPlan = {
      directory: "/work/a\u001b[2Jb",
      name: "demo",
      files: [{ path: "x", step: "cannot", problem: "p", reason: "r‮eason" }],
      contents: new Map(),
      unchanged: [],
    };
    const text = renderRepair(plan).join("\n");
    expect(text).toContain("/work/a\\u001b[2Jb");
    expect(text).toContain("No recipe fixes these:\n  x: p; r\\u202eeason");
    expect(text).toContain(
      "1 file Liftoff wrote in demo in /work/a\\u001b[2Jb is not as Liftoff left it:",
    );
  });
});

describe("REPAIR-002 choosing what to put back", () => {
  it("asks which files to put back, none by default, then asks before changing anything", async () => {
    damaged();
    const before = snapshot();
    const declined = await repair([], { answer: false, answers: { restore: [VERIFY] } });
    expect(declined.asked).toEqual([expect.objectContaining({ flag: "restore", default: [] })]);
    expect(declined.questions).toEqual([`In ${root()}, change 1 file, then the manifest?`]);
    expect(declined.code).toBe(4);
    expect(snapshot()).toEqual(before);

    const none = await repair([], { answer: true });
    expect(none.out).toBe("Nothing was changed.\n");
    expect(none.code).toBe(3);

    const chosen = await repair([], { answer: true, answers: { restore: [VERIFY] } });
    expect(chosen.code).toBe(3);
    expect(chosen.out).toContain("Repaired demo: changed 1 file, then the manifest.");
    expect(chosen.out).toContain("Some files still need attention");
    expect(existsSync(at(VERIFY))).toBe(true);
    expect(read(POLICY)).toBe("mine\n");
  });

  it("needs --yes without a terminal, and names only files it can put back", async () => {
    damaged();
    expect((await repair(["--restore", VERIFY])).err).toContain("pass --yes");
    const unknown = await repair(["--restore", "README.md", "--yes"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("--restore names README.md, which repair cannot put back");
    const all = await repair(["--restore", `${VERIFY},${POLICY}`, "--yes"]);
    expect(all.code).toBe(0);
    expect((await repair(["--check"])).code).toBe(0);
  });

  it("cannot repair a project from before the rebuild", async () => {
    mkdirSync(path.join(work, "old"));
    writeFileSync(
      path.join(work, "old", "liftoff.manifest.json"),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    const { code, err } = await repair(["--check", "--dir", "../old"]);
    expect(code).toBe(6);
    expect(err).toContain("before the rebuild");
  });
});

describe("REPAIR-003 a reviewed patch from the command line", () => {
  it("applies a patch within its paths, and refuses one outside them", async () => {
    const patch = fix();
    const outside = await repair(["--patch", patch, "--paths", "frontend", "--yes"]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("outside the paths it may change (frontend)");
    const { code, out, err } = await repair(["--patch", patch, "--paths", "backend/app", "--yes"]);
    expect(code).toBe(0);
    expect(err).toContain("The patch changes demo in");
    expect(err).toContain("  change  backend/app/main.py (the project owns it)");
    expect(out).toBe("Repaired demo: changed 1 file, then the manifest.\n");
    expect(read("backend/app/main.py").endsWith("# fixed\n")).toBe(true);
  });

  it("refuses a patch that is not UTF-8, and says nothing of other files after a patch", async () => {
    writeFileSync(
      path.join(work, "latin.diff"),
      Buffer.concat([
        Buffer.from("--- /dev/null\n+++ b/backend/app/latin.txt\n@@ -0,0 +1 @@\n+r"),
        Buffer.from([0xe9, 0x0a]),
      ]),
    );
    const latin = await repair(["--patch", "../latin.diff", "--paths", "backend", "--yes"]);
    expect(latin.code).toBe(2);
    expect(latin.err).toContain("the patch ../latin.diff is not UTF-8 text");
    expect(existsSync(at("backend/app/latin.txt"))).toBe(false);

    // A patch removes a file Liftoff wrote for the project, on purpose.
    const readme = read("README.md").split("\n").slice(0, -1);
    writeFileSync(
      path.join(work, "remove.diff"),
      [
        "diff --git a/README.md b/README.md",
        "deleted file mode 100644",
        "--- a/README.md",
        "+++ /dev/null",
        `@@ -1,${readme.length} +0,0 @@`,
        ...readme.map((line) => `-${line}`),
        "",
      ].join("\n"),
    );
    const removed = await repair([
      "--patch",
      "../remove.diff",
      "--paths",
      "README.md",
      "--yes",
      "--json",
    ]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.out)).not.toHaveProperty("needed");
    const check = await repair(["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(
      "README.md: a file Liftoff wrote for the project is missing, which is fine",
    );
  });

  it("refuses options that do not go together, and a patch it cannot read", async () => {
    const patch = fix();
    writeFileSync(path.join(work, "big.diff"), "x".repeat(MAX_PATCH_BYTES + 1));
    for (const [argv, message] of [
      [["--patch", patch], "--patch needs --paths"],
      [["--paths", "backend"], "--paths goes with --patch"],
      [
        ["--patch", patch, "--paths", "backend", "--restore", VERIFY],
        "use --restore or --patch, not both",
      ],
      [["--check", "--restore", VERIFY], "--check lists what repair can put back"],
      [["--check", "--yes"], "--check and --out change nothing in the project"],
      [
        ["--patch", "../missing.diff", "--paths", "backend"],
        "cannot read the patch ../missing.diff",
      ],
      [["--patch", "../big.diff", "--paths", "backend"], "the patch ../big.diff is over 4 MiB"],
      [
        ["--recover", "finish", "--patch", patch],
        "--recover goes only with --dir and --yes, not --patch",
      ],
      [["--plan", "../x.json", "--dir", "."], "--plan goes without --dir"],
    ] as const) {
      const refused = await repair([...argv]);
      expect(refused.code, argv.join(" ")).toBe(2);
      expect(refused.err).toContain(message);
    }
  });
});

describe("REPAIR-004 saved plans and recovery", () => {
  it("saves a restore or a patch plan, and applies exactly that plan", async () => {
    damaged();
    const before = snapshot();
    const saved = await repair(["--out", "../restore.json", "--restore", VERIFY]);
    expect(saved.out).toContain("Apply it with: liftoff repair --plan ../restore.json\n");
    expect(snapshot()).toEqual(before);
    expect((await repair(["--plan", "../restore.json", "--yes"])).code).toBe(3);
    expect(existsSync(at(VERIFY))).toBe(true);

    const patch = fix();
    const patchPlan = await repair([
      "--out",
      "../patch.json",
      "--patch",
      patch,
      "--paths",
      "backend",
    ]);
    expect(patchPlan.out).toContain(
      "Apply it with: liftoff repair --plan ../patch.json --patch <the same patch> --paths <the same paths>",
    );
    const without = await repair(["--plan", "../patch.json", "--yes"]);
    expect(without.code).toBe(1);
    expect(without.err).toContain("give the same --patch and --paths again");
    const applied = await repair([
      "--plan",
      "../patch.json",
      "--patch",
      patch,
      "--paths",
      "backend",
      "--yes",
    ]);
    // A patch only changes what it names; --check still lists the other file.
    expect(applied.code).toBe(0);
    expect(read("backend/app/main.py").endsWith("# fixed\n")).toBe(true);
    expect((await repair(["--check"])).code).toBe(3);
    const nothing = await repair(["--out", "../nothing.json"]);
    expect(nothing.out).toContain("There is nothing to change, so no plan was saved.");
  });

  it("stops part way recoverably, and recovers only a repair", async () => {
    damaged();
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        moves += 1;
        if (moves === 2) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    const stopped = await repair(["--restore", `${VERIFY},${POLICY}`, "--yes"], { port: failing });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The repair stopped part way: no space left on the disk");
    expect(stopped.out).toContain("Finish it with liftoff repair --recover finish");
    const updating = await runCli(
      ["update", "--recover", "undo", "--yes"],
      captureIo(root()),
      [makeUpdateCommand((cwd) => ({ ...defaultProjectPorts(cwd), fs }))],
      "1.0.0",
    );
    expect(updating).toBe(2);
    const finished = await repair(["--recover", "finish", "--yes"]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("The repair is finished: 2 files changed.");
    expect(existsSync(path.join(root(), ...CHANGE_JOURNAL_FILE.split("/")))).toBe(false);
    expect((await repair(["--check"])).code).toBe(0);
    const nothing = await repair(["--recover", "undo", "--yes"]);
    expect(nothing.out).toContain("No repair to");
  });
});
