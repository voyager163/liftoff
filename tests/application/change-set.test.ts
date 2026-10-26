import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import {
  applyChanges,
  ChangeConflictError,
  ChangeError,
  type NewContent,
  recoverChanges,
} from "../../src/application/change/apply-changes.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { validateProject } from "../../src/application/project/validate-project.ts";
import {
  type ChangePlan,
  type FileChange,
  sealChangePlan,
} from "../../src/domain/plan/change-plan.ts";
import { PLAN_SCHEMA, PlanError, sha256Hex } from "../../src/domain/plan/plan.ts";

const fs = new LocalProjectFs();
let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "liftoff-change-"));
  root = path.join(parent, "demo");
  mkdirSync(root);
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const write = (relative: string, content: string | Buffer) => {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const read = (relative: string) => readFileSync(path.join(root, ...relative.split("/")));
const shaOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const now = () => "2026-10-26T12:00:00Z";

/** A binary original, to show originals are kept byte for byte. */
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);

/**
 * A project as a change finds it, and the change: README.md and the manifest
 * get new content, run.sh is added as executable, and data.bin is removed.
 */
function project(): { plan: ChangePlan; contents: Map<string, NewContent> } {
  write("README.md", "# Old\n");
  write("liftoff.yaml", "name: demo\n");
  write(".liftoff/manifest.json", "{}\n");
  write("data.bin", BINARY);
  const contents = new Map<string, NewContent>([
    ["README.md", { content: "# New\n", executable: false }],
    ["run.sh", { content: "#!/bin/sh\necho hi\n", executable: true }],
    ["liftoff.yaml", { content: "name: demo\nagents: [claude]\n", executable: false }],
    [".liftoff/manifest.json", { content: '{"files":[]}\n', executable: false }],
  ]);
  const kept = (relative: string, before: string | null): FileChange => {
    const content = contents.get(relative);
    if (content === undefined) throw new Error(relative);
    return {
      path: relative,
      before,
      after: sha256Hex(content.content),
      ownership: "managed",
      executable: content.executable,
    };
  };
  const plan = sealChangePlan({
    schema: PLAN_SCHEMA,
    operation: "agents-add",
    liftoff: "1.0.0",
    target: root,
    config: { name: "demo" },
    effects: ["modify-files"],
    changes: [
      kept(".liftoff/manifest.json", shaOf(read(".liftoff/manifest.json"))),
      kept("liftoff.yaml", shaOf(read("liftoff.yaml"))),
      kept("README.md", shaOf(read("README.md"))),
      kept("run.sh", null),
      { path: "data.bin", before: shaOf(BINARY), after: null },
    ],
  });
  return { plan, contents };
}

/** Files Liftoff left beside the project: there should be none once a change is done. */
const leftovers = () => readdirSync(parent).filter((name) => name !== "demo");

/** The local file system, recording each file moved into the project and failing on cue. */
function recording(options: { failOnMove?: number; afterMove?: (count: number) => void } = {}) {
  const moved: string[] = [];
  const port: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
    moveFile: async (from: string, to: string) => {
      if (moved.length + 1 === options.failOnMove) throw new Error("the machine stopped");
      await fs.moveFile(from, to);
      moved.push(path.relative(root, to).split(path.sep).join("/"));
      options.afterMove?.(moved.length);
    },
  });
  return { port, moved };
}

describe("CHANGE-002 a file changed since the plan is never overwritten", () => {
  it("makes every planned change", async () => {
    const { plan, contents } = project();
    expect(await applyChanges(fs, plan, contents, now)).toEqual({ changed: 5 });
    expect(read("README.md").toString()).toBe("# New\n");
    expect(read("run.sh").toString()).toBe("#!/bin/sh\necho hi\n");
    expect(existsSync(path.join(root, "data.bin"))).toBe(false);
    expect(read(".liftoff/manifest.json").toString()).toBe('{"files":[]}\n');
    if (process.platform !== "win32") {
      expect(statSync(path.join(root, "run.sh")).mode & 0o111).not.toBe(0);
      expect(statSync(path.join(root, "README.md")).mode & 0o111).toBe(0);
    }
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("changes nothing when a file changed since the plan, and names it", async () => {
    const { plan, contents } = project();
    write("README.md", "# Mine\n");
    write("run.sh", "mine");
    const error = await applyChanges(fs, plan, contents, now).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChangeConflictError);
    expect((error as ChangeConflictError).problems).toEqual([
      "README.md changed since the plan was made",
      "run.sh already exists",
    ]);
    expect(read("README.md").toString()).toBe("# Mine\n");
    expect(read("data.bin")).toEqual(BINARY);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a directory, or a missing file, where the plan expects one", async () => {
    const { plan, contents } = project();
    rmSync(path.join(root, "README.md"));
    mkdirSync(path.join(root, "README.md"));
    rmSync(path.join(root, "data.bin"));
    await expect(applyChanges(fs, plan, contents, now)).rejects.toThrow(
      "nothing was changed: README.md is not a regular file Liftoff can read; data.bin is missing; make a new plan",
    );
  });

  it("refuses new content the plan does not list", async () => {
    const { plan, contents } = project();
    const altered = new Map(contents).set("README.md", { content: "# Other\n", executable: false });
    await expect(applyChanges(fs, plan, altered, now)).rejects.toThrow(PlanError);
    const executable = new Map(contents).set("README.md", { content: "# New\n", executable: true });
    await expect(applyChanges(fs, plan, executable, now)).rejects.toThrow(
      "README.md would now differ from what the plan lists",
    );
    const fewer = new Map(contents);
    fewer.delete("run.sh");
    await expect(applyChanges(fs, plan, fewer, now)).rejects.toThrow(
      "the new files do not match the plan",
    );
    expect(read("README.md").toString()).toBe("# Old\n");
  });

  it("stops before a file edited while the change was being made", async () => {
    const { plan, contents } = project();
    // Changes are made in order: README.md, data.bin, run.sh, liftoff.yaml, the manifest.
    const { port } = recording({ afterMove: (count) => count === 1 && write("run.sh", "mine") });
    await expect(applyChanges(port, plan, contents, now)).rejects.toThrow(
      "run.sh changed while the change was being made, so it and the files after it were left alone; finish or undo the change with liftoff agents add --recover",
    );
    expect(read("run.sh").toString()).toBe("mine");
    expect(read("liftoff.yaml").toString()).toBe("name: demo\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
  });
});

describe("CHANGE-003 a change that stops part way can be finished or undone", () => {
  /** Stops the change after README.md and data.bin have changed. */
  async function interrupted() {
    const { plan, contents } = project();
    const { port } = recording({ failOnMove: 3 });
    await expect(applyChanges(port, plan, contents, now)).rejects.toThrow("the machine stopped");
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
    return { plan, contents };
  }

  it("is reported by validate, and blocks another change", async () => {
    const { plan, contents } = await interrupted();
    const result = await validateProject(fs, root);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      code: "interrupted-change",
      path: ".liftoff/change-journal.json",
      message: expect.stringContaining(
        "a change by liftoff agents add that began 2026-10-26T12:00:00Z stopped part way",
      ),
    });
    await expect(applyChanges(fs, plan, contents, now)).rejects.toThrow(
      "a change to this project stopped part way",
    );
  });

  it("finishes it", async () => {
    await interrupted();
    expect(await recoverChanges(fs, root, "finish")).toEqual({
      operation: "agents-add",
      changed: ["run.sh", "liftoff.yaml", ".liftoff/manifest.json"],
      conflicts: [],
      complete: true,
    });
    expect(read("run.sh").toString()).toBe("#!/bin/sh\necho hi\n");
    expect(read(".liftoff/manifest.json").toString()).toBe('{"files":[]}\n');
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("undoes it, restoring every original byte for byte", async () => {
    await interrupted();
    expect(await recoverChanges(fs, root, "undo")).toMatchObject({
      changed: ["README.md", "data.bin"],
      conflicts: [],
      complete: true,
    });
    expect(read("README.md").toString()).toBe("# Old\n");
    expect(read("data.bin")).toEqual(BINARY);
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
    expect(leftovers()).toEqual([]);
    await expect(recoverChanges(fs, root, "undo")).rejects.toThrow(ChangeError);
  });

  it("undoes a file the change added", async () => {
    const { plan, contents } = project();
    // Stops after README.md, data.bin and run.sh.
    const { port } = recording({ failOnMove: 4 });
    await expect(applyChanges(port, plan, contents, now)).rejects.toThrow("the machine stopped");
    expect(existsSync(path.join(root, "run.sh"))).toBe(true);
    await recoverChanges(fs, root, "undo");
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
  });

  it("never overwrites a file edited after the change stopped", async () => {
    await interrupted();
    write("README.md", "# Edited after\n");
    const result = await recoverChanges(fs, root, "undo");
    expect(result).toMatchObject({
      changed: ["data.bin"],
      conflicts: ["README.md"],
      complete: false,
    });
    expect(read("README.md").toString()).toBe("# Edited after\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
    // Once the person puts it back, recovery completes.
    write("README.md", "# New\n");
    expect(await recoverChanges(fs, root, "undo")).toMatchObject({
      changed: ["README.md"],
      complete: true,
    });
    expect(read("README.md").toString()).toBe("# Old\n");
  });

  it("leaves a file alone when what it should become is gone", async () => {
    await interrupted();
    const staging = leftovers()[0] ?? "";
    rmSync(path.join(parent, staging, "after", "run.sh"));
    const result = await recoverChanges(fs, root, "finish");
    expect(result).toMatchObject({ conflicts: ["run.sh"], complete: false });
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
  });

  it("switches between undoing and finishing until it completes", async () => {
    await interrupted();
    write("liftoff.yaml", "name: mine\n");
    expect(await recoverChanges(fs, root, "undo")).toMatchObject({
      changed: ["README.md", "data.bin"],
      conflicts: ["liftoff.yaml"],
      complete: false,
    });
    write("liftoff.yaml", "name: demo\n");
    expect(await recoverChanges(fs, root, "finish")).toMatchObject({
      changed: ["README.md", "data.bin", "run.sh", "liftoff.yaml", ".liftoff/manifest.json"],
      complete: true,
    });
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(path.join(root, "data.bin"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("does not recover a copy of the project with the original's journal", async () => {
    await interrupted();
    const copy = path.join(parent, "demo copy");
    cpSync(root, copy, { recursive: true });
    await expect(recoverChanges(fs, copy, "finish")).rejects.toThrow(
      "belongs to another copy of this project or another change",
    );
    expect(await recoverChanges(fs, root, "undo")).toMatchObject({ complete: true });
    expect(read("data.bin")).toEqual(BINARY);
  });

  it("does not follow a journal to a staging directory that is a link", async () => {
    await interrupted();
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-outside-"));
    try {
      const journalPath = path.join(root, ".liftoff", "change-journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { staging: string };
      const linked = ".demo.liftoff-staging-linked";
      symlinkSync(outside, path.join(parent, linked), "junction");
      writeFileSync(journalPath, JSON.stringify({ ...journal, staging: linked }));
      await expect(recoverChanges(fs, root, "finish")).rejects.toThrow(
        "are missing or not a directory, so it cannot be recovered",
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a journal that is not one as a problem, in validate too", async () => {
    write("liftoff.yaml", "name: demo\n");
    write(".liftoff/change-journal.json", '{"staging":"../../elsewhere"}');
    await expect(recoverChanges(fs, root, "finish")).rejects.toThrow(
      /change-journal.json is invalid/,
    );
    const result = await validateProject(fs, root);
    expect(result.findings[0]).toMatchObject({
      code: "interrupted-change",
      message: expect.stringContaining("its journal cannot be read"),
    });
  });
});

describe("CHANGE-003 only one change runs at a time", () => {
  it("sees a change that finished while this one was being staged", async () => {
    const { plan, contents } = project();
    const other = sealChangePlan({
      ...plan,
      operation: "repair",
      changes: [
        {
          path: "README.md",
          before: shaOf(read("README.md")),
          after: sha256Hex("# Repaired\n"),
          ownership: "managed",
          executable: false,
        },
      ],
    });
    let first = true;
    const racing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async (file: string, content: string) => {
        if (first) {
          first = false;
          await applyChanges(
            fs,
            other,
            new Map([["README.md", { content: "# Repaired\n", executable: false }]]),
            now,
          );
        }
        return fs.createExclusive(file, content);
      },
    });
    await expect(applyChanges(racing, plan, contents, now)).rejects.toThrow(
      "nothing was changed: README.md changed since the plan was made",
    );
    expect(read("README.md").toString()).toBe("# Repaired\n");
    expect(read("liftoff.yaml").toString()).toBe("name: demo\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("leaves nothing beside the project when the journal cannot be written", async () => {
    const { plan, contents } = project();
    const failing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      createExclusive: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    await expect(applyChanges(failing, plan, contents, now)).rejects.toThrow("ENOSPC");
    expect(leftovers()).toEqual([]);
  });

  it("is reported by validate when an adoption stopped before liftoff.yaml", async () => {
    write("app.py", "print('hi')\n");
    const plan = sealChangePlan({
      schema: PLAN_SCHEMA,
      operation: "adopt",
      liftoff: "1.0.0",
      target: root,
      config: { name: "demo" },
      effects: ["modify-files"],
      changes: ["AGENTS.md", "liftoff.yaml"].map((file) => ({
        path: file,
        before: null,
        after: sha256Hex(file),
        ownership: "managed" as const,
        executable: false,
      })),
    });
    const contents = new Map(
      ["AGENTS.md", "liftoff.yaml"].map((file) => [file, { content: file, executable: false }]),
    );
    const { port } = recording({ failOnMove: 2 });
    await expect(applyChanges(port, plan, contents, now)).rejects.toThrow("the machine stopped");
    const result = await validateProject(fs, root);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "interrupted-change",
      "not-a-liftoff-project",
    ]);
  });
});

describe("CHANGE-004 files change one at a time, the manifest last", () => {
  it("changes the project's files, then liftoff.yaml, then the manifest", async () => {
    const { plan, contents } = project();
    const { port, moved } = recording();
    await applyChanges(port, plan, contents, now);
    // data.bin is moved out of the project, beside it.
    expect(moved).toEqual([
      "README.md",
      expect.stringMatching(/^\.\.\/\.demo\.liftoff-staging-.+\/removed\/data\.bin$/),
      "run.sh",
      "liftoff.yaml",
      ".liftoff/manifest.json",
    ]);
  });
});
