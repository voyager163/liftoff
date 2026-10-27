import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import type { UpdatePlan } from "../../src/application/update/update-project.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeUpdateCommand, renderUpdate } from "../../src/cli/commands/update.ts";
import { makeValidateCommand } from "../../src/cli/commands/validate-doctor.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { type Answers, captureIo } from "../helpers/io.ts";
import { entry, projectFiles, SKILL, sha } from "../helpers/older-project.ts";

let work: string;
let fs: ProjectFsPort;
beforeEach(async () => {
  // The directory update names is the real one, resolved as the CLI does,
  // which on Windows gives long names rather than 8.3 short ones.
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-update-cli-")));
  fs = new LocalProjectFs();
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
const { write, read, snapshot, age } = projectFiles(root);
const VERIFY = SKILL("liftoff-verify");
const ASSESS = SKILL("liftoff-assess");
const PR = SKILL("liftoff-pr");

const exec = async (
  argv: string[],
  options: {
    answer?: boolean;
    answers?: Answers;
    /** The file system, or one made with a way to press Ctrl+C. */
    port?: ProjectFsPort | ((cancel: () => void) => ProjectFsPort);
  } = {},
) => {
  const io = captureIo(root(), options.answer, options.answers);
  const port =
    typeof options.port === "function" ? options.port(() => io.controller.abort()) : options.port;
  const command = makeUpdateCommand((cwd) => ({ ...defaultProjectPorts(cwd), fs: port ?? fs }));
  const code = await runCli(argv, io, [command, makeValidateCommand()], "1.0.0");
  return {
    code,
    out: io.out.join(""),
    err: io.err.join(""),
    questions: io.questions,
    asked: io.asked,
  };
};
const update = (argv: string[] = [], options: Parameters<typeof exec>[1] = {}) =>
  exec(["update", ...argv], options);

/** The project as an earlier release made it: an older skill, and no assess skill. */
const older = () => {
  age((manifest) => {
    write(VERIFY, "old verify\n");
    entry(manifest, VERIFY).sha256 = sha("old verify\n");
    manifest.files = manifest.files.filter((file) => file.path !== ASSESS);
  });
  rmSync(path.join(root(), ...ASSESS.split("/")));
};

describe("UPDATE-004 checking, previewing and approving an update", () => {
  it("exits 0 when there is nothing to update, and 3 with a report when there is", async () => {
    const current = await update(["--check"]);
    expect(current.code).toBe(0);
    expect(current.out).toBe(`demo in ${root()} is up to date with Liftoff 1.0.0.\n`);
    older();
    const before = snapshot();
    const { code, out } = await update(["--check", "--json"]);
    expect(code).toBe(3);
    expect(JSON.parse(out)).toMatchObject({
      schema: "liftoff.update/v1",
      outcome: "attention",
      directory: root(),
      available: true,
      changed: false,
      files: [
        { path: ASSESS, step: "offer", ownership: "managed" },
        { path: VERIFY, step: "update" },
      ],
      plugins: [],
      plan: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const text = await update(["--check"]);
    expect(text.out).toContain(`  update  ${VERIFY}\n`);
    expect(text.out).toContain(
      `New files this release makes, added only if you choose them or name them with --add:\n  ${ASSESS} (Liftoff keeps it current)\n`,
    );
    expect(text.out).toMatch(/Plan [0-9a-f]{12}: changes 1 file, then the manifest\./);
    expect(snapshot()).toEqual(before);
  });

  it("asks which new files to add, none by default, then asks before changing anything", async () => {
    older();
    const before = snapshot();
    const declined = await update([], { answer: false });
    expect(declined.asked).toEqual([
      expect.objectContaining({
        flag: "add",
        default: [],
        choices: [{ value: ASSESS, description: "Liftoff keeps it current" }],
      }),
    ]);
    expect(declined.questions).toEqual([`In ${root()}, change 1 file, then the manifest?`]);
    expect(declined.err.match(/Plan [0-9a-f]{12}/g)).toHaveLength(1);
    expect(declined.code).toBe(4);
    expect(declined.out).toBe("Nothing was changed.\n");
    expect(snapshot()).toEqual(before);

    const chosen = await update([], { answer: true, answers: { add: [ASSESS] } });
    expect(chosen.questions).toEqual([`In ${root()}, change 2 files, then the manifest?`]);
    expect(chosen.code).toBe(0);
    expect(chosen.out).toBe("Updated demo: changed 2 files, then the manifest.\n");
    expect(existsSync(path.join(root(), ...ASSESS.split("/")))).toBe(true);
    expect((await update(["--check"])).code).toBe(0);
  });

  it("needs --yes without a terminal, takes new files only from --add, and exits 3 when files are held back", async () => {
    older();
    write(PR, "mine\n");
    age((manifest) => {
      entry(manifest, PR).sha256 = sha("older pr\n");
    });
    const unconfirmed = await update();
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("pass --yes to confirm when no one can answer a prompt");
    const unknown = await update(["--add", "README.md", "--yes"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("--add names README.md, which this update does not offer");

    const { code, out } = await update(["--yes", "--json"]);
    expect(code).toBe(3);
    expect(JSON.parse(out)).toMatchObject({ changed: true, available: true, outcome: "attention" });
    expect(read(PR)).toBe("mine\n");
    expect(existsSync(path.join(root(), ...ASSESS.split("/")))).toBe(false);
    const again = await update(["--add", ` ${ASSESS} ,`, "--yes"]);
    expect(again.code).toBe(3);
    expect(again.out).toContain("Some files were left as they are");
    expect(existsSync(path.join(root(), ...ASSESS.split("/")))).toBe(true);
    const held = await update([]);
    expect(held.code).toBe(3);
    expect(held.out).toContain(
      `Liftoff 1.0.0 has nothing to change by itself in demo in ${root()}.\nLeft as they are:\n  ${PR}: it was changed since Liftoff wrote it`,
    );
  });

  it("saves a plan without changing anything, and applies exactly that plan", async () => {
    older();
    const before = snapshot();
    const saved = await update(["--out", "../update.plan.json", "--add", ASSESS]);
    expect(saved.code).toBe(0);
    expect(saved.out).toContain("Apply it with: liftoff update --plan ../update.plan.json");
    expect(snapshot()).toEqual(before);
    const applied = await update(["--plan", "../update.plan.json", "--yes"]);
    expect(applied.code).toBe(0);
    expect(read(ASSESS)).not.toBe("");
    const stale = await update(["--plan", "../update.plan.json", "--yes"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("the project changed since the plan was made");
    const nothing = await update(["--out", "../nothing.plan.json"]);
    expect(nothing.out).toContain("There is nothing to change, so no plan was saved.");
    expect(existsSync(path.join(work, "nothing.plan.json"))).toBe(false);
  });

  it("refuses a saved plan when a file it changes was edited, an init plan, and mixed options", async () => {
    older();
    await update(["--out", "../update.plan.json"]);
    write(VERIFY, "edited\n");
    const edited = await update(["--plan", "../update.plan.json", "--yes"]);
    expect(edited.code).toBe(1);
    expect(read(VERIFY)).toBe("edited\n");
    writeFileSync(path.join(work, "init.plan.json"), JSON.stringify({ operation: "init" }));
    const init = await update(["--plan", "../init.plan.json", "--yes"]);
    expect(init.err).toContain("this plan creates a project; apply it with liftoff init --plan");
    for (const [argv, message] of [
      [["--plan", "../update.plan.json", "--dir", "."], "--plan goes without --dir"],
      [["--plan", "../missing.json"], "cannot read the plan ../missing.json"],
      [["--check", "--yes"], "--check and --out change nothing in the project"],
      [["--check", "--out", "README.md"], "--check writes nothing, so it goes without --out"],
      [
        ["--recover", "undo", "--add", ASSESS],
        "--recover goes only with --dir and --yes, not --add",
      ],
      [["--recover", "again"], "--recover"],
    ] as const) {
      const refused = await update([...argv]);
      expect(refused.code, argv.join(" ")).toBe(2);
      expect(refused.err).toContain(message);
    }
    expect(read("README.md")).toContain("# demo");
  });

  it("refuses an edited liftoff.yaml, and cannot update a project from before the rebuild", async () => {
    write("liftoff.yaml", `${read("liftoff.yaml")}# mine\n`);
    const changed = await update(["--check"]);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("liftoff.yaml changed since Liftoff last wrote it");
    mkdirSync(path.join(work, "old"));
    writeFileSync(
      path.join(work, "old", "liftoff.manifest.json"),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: "Mission Control Liftoff",
        liftoffVersion: "0.12.3",
      }),
    );
    const old = await update(["--dir", "../old"]);
    expect(old.code).toBe(6);
    expect(old.err).toContain("made by a Liftoff release before the rebuild");
  });

  it("names an unknown stack as unsupported", async () => {
    const config = read("liftoff.yaml").replace("stack: python-fastapi", "stack: rust-axum");
    write("liftoff.yaml", config);
    age((manifest) => {
      entry(manifest, "liftoff.yaml").sha256 = sha(config);
    });
    const { code, err } = await update(["--check"]);
    expect(code).toBe(6);
    expect(err).toContain("rust-axum");
  });

  it("is not up to date while a new file cannot be added, and shows a declined plan once", async () => {
    age((manifest) => {
      manifest.files = manifest.files.filter((file) => file.path !== ASSESS);
    });
    const check = await update(["--check"]);
    expect(check.code).toBe(3);
    expect(check.out).toContain(
      `Liftoff 1.0.0 has nothing to change by itself in demo in ${root()}.`,
    );
    expect(check.out).toContain(`  ${ASSESS}: a file is already there`);
    expect(check.out).not.toContain("up to date");
    rmSync(path.join(root(), ...ASSESS.split("/")));
    const declined = await update([], { answer: true });
    expect(declined.code).toBe(0);
    expect(declined.out).toBe("Nothing was changed.\n");
    expect(declined.err.match(/New files this release makes/g)).toHaveLength(1);
    expect(declined.questions).toEqual([]);
  });

  it("escapes what would change how a terminal shows a line", () => {
    const plan: UpdatePlan = {
      directory: "/work/a\u001b[2Jb",
      name: "demo",
      files: [{ path: "x", step: "hold", reason: "r‮eason" }],
      plugins: [],
      contents: new Map(),
      unchanged: [],
    };
    const text = renderUpdate(plan, "1.0.0").join("\n");
    expect(text).toContain("/work/a\\u001b[2Jb");
    expect(text).toContain("r\\u202eeason");
  });
});

describe("UPDATE-004 an update that stops part way is finished or undone", () => {
  /** A file system that fails, or changes the next file, after `after` files are put in place. */
  const stopping = (after: number, how: "fail" | "edit") => {
    let moved = 0;
    return Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (moved === after && how === "fail") throw new Error("no space left on the disk");
        await fs.moveFile(from, to);
        moved += 1;
        if (moved === after && how === "edit") write(VERIFY, "edited meanwhile\n");
      },
    });
  };
  const olderTwo = () => {
    older();
    age((manifest) => {
      write(PR, "old pr\n");
      entry(manifest, PR).sha256 = sha("old pr\n");
    });
  };

  it("reports the stop as partial, and undoes it", async () => {
    olderTwo();
    const stopped = await update(["--yes"], { port: stopping(1, "fail") });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The update stopped part way: no space left on the disk");
    expect(stopped.out).toContain("liftoff update --recover finish");
    expect(read(PR)).not.toBe("old pr\n");
    expect(read(VERIFY)).toBe("old verify\n");
    const validated = await exec(["validate"]);
    expect(validated.out).toContain("finish or undo it with liftoff update --recover");
    const blocked = await update(["--check"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("finish or undo it with liftoff update --recover first");

    const unconfirmed = await update(["--recover", "undo"]);
    expect(unconfirmed.code).toBe(2);
    const declined = await update(["--recover", "undo"], { answer: false });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual(["Undo it?"]);
    const undone = await update(["--recover", "undo"], { answer: true });
    expect(undone.code).toBe(0);
    expect(undone.out).toContain("The update is undone: 1 file changed.");
    expect(read(PR)).toBe("old pr\n");
    expect(existsSync(path.join(root(), ...CHANGE_JOURNAL_FILE.split("/")))).toBe(false);
    const nothing = await update(["--recover", "undo", "--yes"]);
    expect(nothing.code).toBe(0);
    expect(nothing.out).toContain("there is nothing to recover");
  });

  it("finishes a stop caused by a file changed meanwhile, once that file is put back", async () => {
    olderTwo();
    const stopped = await update(["--yes", "--json"], { port: stopping(1, "edit") });
    expect(stopped.code).toBe(5);
    expect(JSON.parse(stopped.out).stopped).toContain(
      `${VERIFY} changed while the change was being made`,
    );
    const conflicted = await update(["--recover", "finish", "--yes"]);
    expect(conflicted.code).toBe(5);
    expect(conflicted.out).toContain(`Changed by something else meanwhile`);
    expect(conflicted.out).toContain(`  ${VERIFY}\n`);
    expect(conflicted.out).toContain("Waiting until those are resolved:\n  .liftoff/manifest.json");
    write(VERIFY, "old verify\n");
    const finished = await update(["--recover", "finish", "--yes"]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("The update is finished");
    expect((await update(["--check"])).code).toBe(3);
  });

  it("recovers only an update, and says what to do with a journal it cannot read", async () => {
    write(
      CHANGE_JOURNAL_FILE,
      JSON.stringify({
        schema: "liftoff.change-journal/v1",
        operation: "repair",
        plan: "a".repeat(64),
        started: "2026-10-27T11:00:00Z",
        staging: ".demo.liftoff-staging-abc123",
        changes: [],
      }),
    );
    const other = await update(["--recover", "finish", "--yes"]);
    expect(other.code).toBe(2);
    expect(other.err).toContain("recover it with liftoff repair --recover");
    write(CHANGE_JOURNAL_FILE, "");
    const unreadable = await update(["--recover", "finish", "--yes"]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.err).toContain("if it is empty, the change stopped before any file changed");
  });

  it("changes nothing when liftoff.yaml changes after the plan was shown", async () => {
    older();
    const before = snapshot();
    const config = `${read("liftoff.yaml")}# mine\n`;
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async (file: string, content: string) => {
        write("liftoff.yaml", config);
        return fs.createExclusive(file, content);
      },
    });
    const { code, err } = await update(["--yes"], { port });
    expect(code).toBe(1);
    expect(err).toContain("nothing was changed: liftoff.yaml changed since the plan was made");
    expect(snapshot()).toEqual({
      ...before,
      "liftoff.yaml": Buffer.from(config).toString("base64"),
    });
  });

  it("reports a recovery that stops after changing a file as partial, and recovers on the next run", async () => {
    olderTwo();
    const verify = read(VERIFY);
    expect((await update(["--yes"], { port: stopping(1, "fail") })).code).toBe(5);
    // Finishing changes the skill, then stops at the manifest.
    const stopped = await update(["--recover", "finish", "--yes"], {
      port: stopping(1, "fail"),
    });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("Recovery stopped: no space left on the disk");
    expect(stopped.out).toContain("run liftoff update --recover finish again");
    expect(read(VERIFY)).not.toBe(verify);
    expect(existsSync(path.join(root(), ...CHANGE_JOURNAL_FILE.split("/")))).toBe(true);
    const finished = await update(["--recover", "finish", "--yes"]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("The update is finished: 1 file changed.");
    expect((await update(["--check"])).code).toBe(3);
  });

  it("recovers only the stopped update it showed", async () => {
    olderTwo();
    expect((await update(["--yes"], { port: stopping(1, "fail") })).code).toBe(5);
    const journal = read(CHANGE_JOURNAL_FILE);
    const swapped = journal.replace(/"plan": "[0-9a-f]{64}"/, `"plan": "${"b".repeat(64)}"`);
    // Another update stops while the question is open.
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async (file: string, content: string) => {
        write(CHANGE_JOURNAL_FILE, swapped);
        return fs.createExclusive(file, content);
      },
    });
    const refused = await update(["--recover", "undo"], { answer: true, port });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("the change that stopped is no longer the one shown");
    expect(read(CHANGE_JOURNAL_FILE)).toBe(swapped);
    expect(read(PR)).not.toBe("old pr\n");
  });

  it.each([
    [
      "a file only the manifest changes for is edited",
      ".github/liftoff/review-policy.mjs",
      "changed since the plan was made",
    ],
    [
      "a file this release no longer makes appears again",
      ".github/workflows/98-gone.yml",
      "already exists",
    ],
  ])("changes nothing when %s after the plan was shown", async (_, file, problem) => {
    older();
    age((manifest) => {
      const policy = entry(manifest, ".github/liftoff/review-policy.mjs");
      policy.sha256 = sha("older policy\n");
      manifest.files.push({
        ...policy,
        path: ".github/workflows/98-gone.yml",
        sha256: sha("gone\n"),
      });
    });
    const before = snapshot();
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async (lock: string, content: string) => {
        write(file, "edited meanwhile\n");
        return fs.createExclusive(lock, content);
      },
    });
    const { code, err } = await update(["--yes"], { port });
    expect(code).toBe(1);
    expect(err).toContain(`nothing was changed: ${file} ${problem}`);
    expect(snapshot()).toEqual({
      ...before,
      [file]: Buffer.from("edited meanwhile\n").toString("base64"),
    });
  });

  it("changes nothing when cancelled before the first file, and stops recoverably after it", async () => {
    olderTwo();
    const before = snapshot();
    const cancelAt = (moves: number) => (cancel: () => void) => {
      let moved = 0;
      return Object.assign(Object.create(fs) as ProjectFsPort, {
        createExclusive: async (lock: string, content: string) => {
          if (moves === 0) cancel();
          return fs.createExclusive(lock, content);
        },
        moveFile: async (from: string, to: string) => {
          await fs.moveFile(from, to);
          moved += 1;
          if (moved === moves) cancel();
        },
      });
    };
    const cancelled = await update(["--yes"], { port: cancelAt(0) });
    expect(cancelled.code).toBe(4);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(work).filter((name) => name.includes("liftoff-staging"))).toEqual([]);

    const stopped = await update(["--yes"], { port: cancelAt(1) });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("the change was cancelled after 1 of 3 files");
    const notYet = await update(["--recover", "finish", "--yes"], { port: cancelAt(0) });
    expect(notYet.code).toBe(4);
    const halfway = await update(["--recover", "finish", "--yes"], { port: cancelAt(1) });
    expect(halfway.code).toBe(5);
    expect(halfway.out).toContain(
      "Recovery stopped: recovery was cancelled after 1 file; run it again",
    );
    const finished = await update(["--recover", "finish", "--yes"]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("The update is finished: 1 file changed.");
  });

  it("keeps the journal when recovery is cancelled with nothing left to change", async () => {
    older();
    const cancelling = (cancel: () => void) =>
      Object.assign(Object.create(fs) as ProjectFsPort, {
        createExclusive: async (lock: string, content: string) => {
          cancel();
          return fs.createExclusive(lock, content);
        },
      });
    // Every file changes, but the journal cannot be removed.
    const kept = Object.assign(Object.create(fs) as ProjectFsPort, {
      remove: async (target: string) => {
        if (target.endsWith("change-journal.json")) throw new Error("EIO: i/o error, unlink");
        return fs.remove(target);
      },
    });
    expect((await update(["--yes"], { port: kept })).code).toBe(5);
    const journal = path.join(root(), ...CHANGE_JOURNAL_FILE.split("/"));
    const cancelled = await update(["--recover", "finish", "--yes"], { port: cancelling });
    expect(cancelled.code).toBe(4);
    expect(existsSync(journal)).toBe(true);
    expect(readdirSync(work).filter((name) => name.includes("liftoff-staging"))).toHaveLength(1);
    const finished = await update(["--recover", "finish", "--yes"]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("The update is finished: 0 files changed.");
    expect(existsSync(journal)).toBe(false);
  });

  it("reports a failure after Ctrl+C as partial once recovery has changed a file", async () => {
    olderTwo();
    expect((await update(["--yes"], { port: stopping(1, "fail") })).code).toBe(5);
    // The second file's copy fails just after Ctrl+C.
    const failing = (cancel: () => void) => {
      let copies = 0;
      return Object.assign(Object.create(fs) as ProjectFsPort, {
        copyFile: async (from: string, to: string) => {
          copies += 1;
          if (copies === 2) {
            cancel();
            throw new Error("ENOSPC: no space left on device, copyfile");
          }
          return fs.copyFile(from, to);
        },
      });
    };
    const stopped = await update(["--recover", "finish", "--yes"], { port: failing });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("Recovery stopped: ENOSPC");
    expect(stopped.out).toContain("run liftoff update --recover finish again");
    expect((await update(["--recover", "finish", "--yes"])).code).toBe(0);
  });

  it("names what it could not remove once every file had changed", async () => {
    older();
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      remove: async (target: string) => {
        if (/\.liftoff-staging-[^/\\]+$/.test(target) || target.endsWith("change.lock")) {
          throw new Error(`EPERM: operation not permitted, rm '${path.basename(target)}'`);
        }
        return fs.remove(target);
      },
    });
    const { code, out } = await update(["--yes", "--json"], { port });
    expect(code).toBe(3);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ changed: true, outcome: "attention" });
    expect(report.leftovers).toEqual([
      expect.stringMatching(
        /^the kept copies in \.demo\.liftoff-staging-\S+ beside the project could not be removed \(EPERM/,
      ),
      expect.stringMatching(
        /^\.liftoff\/change\.lock could not be removed \(EPERM.*\); delete it$/,
      ),
    ]);
    expect(existsSync(path.join(root(), ...CHANGE_JOURNAL_FILE.split("/")))).toBe(false);
    expect(read(VERIFY)).not.toBe("old verify\n");
  });

  it("changes nothing when a file changes after the plan was shown", async () => {
    older();
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async (file: string, content: string) => {
        write(VERIFY, "edited meanwhile\n");
        return fs.createExclusive(file, content);
      },
    });
    const { code, err } = await update(["--yes"], { port });
    expect(code).toBe(1);
    expect(err).toContain(`nothing was changed: ${VERIFY} changed since the plan was made`);
    expect(existsSync(path.join(root(), ...CHANGE_JOURNAL_FILE.split("/")))).toBe(false);
  });
});
