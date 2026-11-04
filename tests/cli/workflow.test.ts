import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeRepairCommand } from "../../src/cli/commands/repair.ts";
import { makeUpdateCommand } from "../../src/cli/commands/update.ts";
import { makeValidateCommand } from "../../src/cli/commands/validate-doctor.ts";
import { makeWorkflowSetCommand } from "../../src/cli/commands/workflow.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { CONFIG_FILE, parseConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { captureIo } from "../helpers/io.ts";
import { projectFiles } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
/** What OpenSpec's initializer writes, here without downloading anything. */
const OPENSPEC = {
  "openspec/project.md": "# Project\n",
  "openspec/specs/.gitkeep": "",
  ".claude/commands/opsx/propose.md": "propose\n",
};
let initializer: FakeInitializer;
beforeEach(async () => {
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-workflow-")));
  initializer = new FakeInitializer(() => ({ files: OPENSPEC }));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "demo");
const { at, read, write, snapshot } = projectFiles(root);

const ports =
  (port: ProjectFsPort = fs) =>
  (cwd: string) => ({
    ...defaultProjectPorts(cwd),
    fs: port,
    initializer,
  });

async function init(workflow: string): Promise<void> {
  const io = captureIo(work);
  const argv = ["init", "--name", "demo", "--workflow", workflow, "--agents", "claude", "--yes"];
  expect(await runCli(argv, io, [makeInitCommand(ports())], "1.0.0")).toBe(0);
}

const workflowSet = async (
  argv: string[],
  options: { answer?: boolean; port?: ProjectFsPort } = {},
) => {
  const io = captureIo(root(), options.answer);
  const commands = [
    makeWorkflowSetCommand(ports(options.port)),
    makeValidateCommand(ports(options.port)),
    makeUpdateCommand(ports(options.port)),
    makeRepairCommand(ports(options.port)),
  ];
  const code = await runCli(argv, io, commands, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

const manifest = () => parseManifest(read(MANIFEST_FILE));

describe("WORKFLOW-001 switching the workflow is a reviewed change of its own", () => {
  it("checks, asks with no as the default, and switches with --yes", async () => {
    await init("manual");
    const before = snapshot();
    const check = await workflowSet(["workflow", "set", "openspec", "--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`Switch ${root()} from Manual to OpenSpec:\n`);
    expect(check.out).toContain("  rewrite AGENTS.md\n");
    expect(check.out).toContain("  rewrite liftoff.yaml\n");
    expect(check.out).toContain("Once approved, it runs OpenSpec 1.14.3's own initializer");
    expect(initializer.runs).toEqual([]);
    const declined = await workflowSet(["workflow", "set", "openspec"], { answer: false });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual([
      `Switch ${root()} to openspec, running and downloading OpenSpec's initializer first?`,
    ]);
    expect((await workflowSet(["workflow", "set", "openspec"])).code).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(initializer.runs).toEqual([]);

    const switched = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(switched.code).toBe(0);
    expect(parseConfig(read(CONFIG_FILE)).workflow).toBe("openspec");
    // The initializer ran apart from the project, and its directory is gone.
    expect(initializer.runs).toHaveLength(1);
    expect(path.dirname(initializer.runs[0]?.directory ?? "")).toBe(work);
    expect(readdirSync(work)).toEqual(["demo"]);
    expect(read("openspec/project.md")).toBe("# Project\n");
    const after = manifest();
    expect(after.history.map((entry) => entry.operation)).toEqual(["init", "workflow-set"]);
    expect(after.plugins.map((plugin) => plugin.id)).toContain("workflow/openspec");
    expect(after.plugins.map((plugin) => plugin.id)).not.toContain("workflow/manual");
    expect(
      after.files
        .filter((file) => file.ownership === "framework")
        .map((file) => file.path)
        .sort(),
    ).toEqual(Object.keys(OPENSPEC).sort());
    // The project is as this release makes an OpenSpec project.
    expect((await workflowSet(["validate"])).code).toBe(0);
    expect((await workflowSet(["update", "--check"])).code).toBe(0);
    const same = await workflowSet(["workflow", "set", "openspec"]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("already uses openspec");
  });

  it("leaves a file changed since Liftoff wrote it, and names it", async () => {
    await init("manual");
    write("AGENTS.md", "# Our own instructions\n");
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(
      "  left AGENTS.md: changed since Liftoff wrote it, so it still describes manual; bring it up to date by hand\n",
    );
    expect(read("AGENTS.md")).toBe("# Our own instructions\n");
  });

  it("refuses what it cannot switch, changing nothing", async () => {
    await init("manual");
    const before = snapshot();
    const unknown = await workflowSet(["workflow", "set", "waterfall"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown workflow "waterfall"');
    expect((await workflowSet(["workflow", "set"])).code).toBe(2);
    expect((await workflowSet(["workflow", "set", "manual", "--check", "--yes"])).code).toBe(2);
    write(CONFIG_FILE, read(CONFIG_FILE).replace("agents:\n  - claude", "agents: []"));
    const edited = await workflowSet(["workflow", "set", "spec-kit", "--yes"]);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain("changed since Liftoff last wrote it");
    expect(snapshot()).not.toEqual(before);
  });

  it("refuses Spec Kit for a project with no coding agent", async () => {
    const io = captureIo(work);
    const argv = ["init", "--name", "demo", "--workflow", "manual", "--yes"];
    expect(await runCli(argv, io, [makeInitCommand(ports())], "1.0.0")).toBe(0);
    const run = await workflowSet(["workflow", "set", "spec-kit", "--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("Spec Kit needs at least one coding agent");
  });

  it("stops part way recoverably, and undoes the switch", async () => {
    await init("openspec");
    const before = snapshot();
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (++moves === 2) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    const stopped = await workflowSet(["workflow", "set", "manual", "--yes"], { port: failing });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The workflow switch stopped part way");
    expect(existsSync(at(CHANGE_JOURNAL_FILE))).toBe(true);
    const undone = await workflowSet(["workflow", "set", "--recover", "undo", "--yes"]);
    expect(undone.code).toBe(0);
    expect(snapshot()).toEqual(before);
    expect((await workflowSet(["workflow", "set", "manual", "--recover", "undo"])).code).toBe(2);
  });
});

describe("WORKFLOW-002 leaving a framework keeps its files and uninstalls nothing", () => {
  it("keeps OpenSpec's files byte for byte, as the project's own", async () => {
    await init("openspec");
    write("openspec/specs/auth/spec.md", "# Auth\n");
    const framework = Object.fromEntries(
      Object.entries(snapshot()).filter(
        ([file]) => file.startsWith("openspec/") || file.startsWith(".claude/commands/"),
      ),
    );
    const run = await workflowSet(["workflow", "set", "manual", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain("OpenSpec's 3 files stay as they are, as the project's own");
    const now = snapshot();
    for (const [file, bytes] of Object.entries(framework)) expect(now[file], file).toBe(bytes);
    expect(manifest().files.filter((file) => file.ownership === "framework")).toEqual([]);
    expect(parseConfig(read(CONFIG_FILE)).workflow).toBe("manual");
    expect(initializer.runs).toHaveLength(1);
    expect((await workflowSet(["validate"])).code).toBe(0);
  });
});

describe("WORKFLOW-003 entering a framework runs its own pinned initializer, apart from the project", () => {
  it("changes nothing when the project already has something where a framework file goes", async () => {
    await init("manual");
    write("openspec/project.md", "# Ours\n");
    const before = snapshot();
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      "OpenSpec's initializer writes openspec/project.md, where the project already has something, so nothing was changed",
    );
    expect(snapshot()).toEqual(before);
    expect(readdirSync(work)).toEqual(["demo"]);
  });

  it("changes nothing when the initializer fails, and leaves no directory behind", async () => {
    await init("manual");
    initializer = new FakeInitializer(() => ({ outcome: { exitCode: 1, output: "no network" } }));
    const before = snapshot();
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("failed with exit code 1");
    expect(snapshot()).toEqual(before);
    expect(readdirSync(work)).toEqual(["demo"]);
  });
});

describe("WORKFLOW-003 the framework's files, as its initializer wrote them", () => {
  it("keeps whether each file runs, and refuses one that is not UTF-8 text", async () => {
    await init("manual");
    const chmodding = new FakeInitializer(() => ({
      files: { "openspec/project.md": "# Project\n", "openspec/run.py": "print(1)\n" },
    }));
    const run = chmodding.run.bind(chmodding);
    chmodding.run = async (step, directory, options) => {
      const outcome = await run(step, directory, options);
      if (process.platform !== "win32")
        chmodSync(path.join(directory, "openspec", "run.py"), 0o755);
      return outcome;
    };
    initializer = chmodding;
    expect((await workflowSet(["workflow", "set", "openspec", "--yes"])).code).toBe(0);
    if (process.platform !== "win32")
      expect(statSync(at("openspec/run.py")).mode & 0o111).not.toBe(0);
    expect(statSync(at("openspec/project.md")).mode & 0o111).toBe(0);

    rmSync(work, { recursive: true, force: true });
    work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-workflow-")));
    await init("manual");
    const binary = new FakeInitializer(() => ({ files: { "openspec/project.md": "# Project\n" } }));
    const runBinary = binary.run.bind(binary);
    binary.run = async (step, directory, options) => {
      const outcome = await runBinary(step, directory, options);
      writeFileSync(
        path.join(directory, "openspec", "logo.bin"),
        Buffer.from([0xff, 0xfe, 0x00, 0x80]),
      );
      return outcome;
    };
    initializer = binary;
    const before = snapshot();
    const refused = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("openspec/logo.bin, which is not UTF-8 text");
    expect(snapshot()).toEqual(before);
  });

  it("says a file Liftoff wrote was removed rather than changed, and counts one file as one", async () => {
    await init("manual");
    rmSync(at("AGENTS.md"));
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.err).toContain(
      "  left AGENTS.md: removed since Liftoff wrote it; liftoff repair --restore AGENTS.md puts it back\n",
    );
    // And it does, with this workflow's version.
    expect((await workflowSet(["repair", "--restore", "AGENTS.md", "--yes"])).code).toBe(0);
    expect(read("AGENTS.md")).toContain("OpenSpec");
    expect((await workflowSet(["repair", "--check"])).code).toBe(0);
    initializer = new FakeInitializer(() => ({ files: { "openspec/project.md": "# Project\n" } }));
    rmSync(work, { recursive: true, force: true });
    work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-workflow-")));
    await init("openspec");
    const left = await workflowSet(["workflow", "set", "manual", "--yes"]);
    expect(left.err).toContain("OpenSpec's 1 file stay as they are");
  });
});

describe("WORKFLOW-001 switching back and forth", () => {
  it("never takes a workflow typed into liftoff.yaml by hand for one switched to", async () => {
    await init("manual");
    write(CONFIG_FILE, read(CONFIG_FILE).replace("workflow: manual", "workflow: openspec"));
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("changed since Liftoff last wrote it");
    expect(initializer.runs).toEqual([]);
  });

  it("switches back when a file left by the first switch was put back as it was", async () => {
    await init("manual");
    const original = read("AGENTS.md");
    write("AGENTS.md", "# Ours\n");
    expect((await workflowSet(["workflow", "set", "openspec", "--yes"])).code).toBe(0);
    write("AGENTS.md", original);
    const back = await workflowSet(["workflow", "set", "manual", "--yes"]);
    expect(back.code).toBe(0);
    expect(read("AGENTS.md")).toBe(original);
    expect(parseConfig(read(CONFIG_FILE)).workflow).toBe("manual");
    expect((await workflowSet(["validate"])).code).toBe(0);
  });
});

describe("WORKFLOW-003 the framework's empty directories", () => {
  it("makes them in the project, and refuses a file in the way of one", async () => {
    await init("manual");
    initializer = new FakeInitializer(() => ({
      files: { "openspec/config.yaml": "schema: spec-driven\n" },
      directories: ["openspec/specs", "openspec/changes/archive"],
    }));
    write("openspec/specs", "not a directory\n");
    const before = snapshot();
    const refused = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("writes openspec/specs, where the project already has something");
    expect(snapshot()).toEqual(before);

    rmSync(at("openspec"), { recursive: true });
    expect((await workflowSet(["workflow", "set", "openspec", "--yes"])).code).toBe(0);
    expect(statSync(at("openspec/specs")).isDirectory()).toBe(true);
    expect(statSync(at("openspec/changes/archive")).isDirectory()).toBe(true);
    expect(read("openspec/config.yaml")).toBe("schema: spec-driven\n");
  });
});

describe("WORKFLOW-003 the framework's empty directories, before any file", () => {
  it("are there when an interrupted switch is finished later, and one that cannot be made changes no file", async () => {
    await init("manual");
    initializer = new FakeInitializer(() => ({
      files: { "openspec/config.yaml": "schema: spec-driven\n" },
      directories: ["openspec/specs"],
    }));
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (++moves === 2) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    expect(
      (await workflowSet(["workflow", "set", "openspec", "--yes"], { port: failing })).code,
    ).toBe(5);
    expect((await workflowSet(["workflow", "set", "--recover", "finish", "--yes"])).code).toBe(0);
    expect(statSync(at("openspec/specs")).isDirectory()).toBe(true);
    expect(parseConfig(read(CONFIG_FILE)).workflow).toBe("openspec");

    rmSync(work, { recursive: true, force: true });
    work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-workflow-")));
    await init("manual");
    const before = snapshot();
    const closed = Object.assign(Object.create(fs) as ProjectFsPort, {
      makeDirectory: (target: string) =>
        target.endsWith("specs")
          ? Promise.reject(new Error("permission denied"))
          : fs.makeDirectory(target),
    });
    const refused = await workflowSet(["workflow", "set", "openspec", "--yes"], { port: closed });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "openspec/specs, an empty directory the framework's initializer made, could not be made (permission denied), so no file was changed",
    );
    expect(snapshot()).toEqual(before);
  });
});

describe("WORKFLOW-003 a refused switch leaves nothing", () => {
  it("removes the empty directories it made when the change is refused", async () => {
    await init("manual");
    initializer = new FakeInitializer(() => {
      // Edited while the initializer runs, so the change is refused.
      write("AGENTS.md", "# Edited meanwhile\n");
      return {
        files: { "openspec/config.yaml": "schema: spec-driven\n" },
        directories: ["openspec/specs"],
      };
    });
    const run = await workflowSet(["workflow", "set", "openspec", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("nothing was changed");
    expect(existsSync(at("openspec"))).toBe(false);
  });
});
