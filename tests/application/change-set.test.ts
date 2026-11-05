import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyWithin, LocalProjectFs, type ReadCalls } from "../../src/adapters/project-fs.ts";
import {
  applyChanges,
  ChangeConflictError,
  ChangeError,
  ChangeStoppedError,
  MAX_CHANGED_BYTES,
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
const HOST = "test-host";
/** Only this process is running, as far as the change lock can tell. */
const ports = (port: ProjectFsPort) => ({
  fs: port,
  processes: { pid: process.pid, host: HOST, isRunning: (pid: number) => pid === process.pid },
  now,
});

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

/** The real file calls, writing no more than three bytes at a time, as a nearly full disk may. */
const writingThreeBytesAtATime: ReadCalls = {
  lstat: (target) => lstat(target, { bigint: true }),
  open: async (target, flags, mode) => {
    const handle = await open(target, flags, mode);
    if ((flags & constants.O_WRONLY) === 0) return handle;
    return new Proxy(handle, {
      get(fileHandle, property) {
        if (property === "write") {
          return (buffer: Buffer, offset: number, length: number, position: number) =>
            fileHandle.write(buffer, offset, Math.min(length, 3), position);
        }
        const value = Reflect.get(fileHandle, property);
        return typeof value === "function" ? value.bind(fileHandle) : value;
      },
    });
  },
};

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
    expect(await applyChanges(ports(fs), plan, contents)).toEqual({ changed: 5, leftovers: [] });
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
    const error = await applyChanges(ports(fs), plan, contents).catch((caught: unknown) => caught);
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
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      "nothing was changed: README.md is not a regular file of at most 67108864 bytes that Liftoff can read; data.bin is missing; make a new plan",
    );
  });

  it("refuses new content the plan does not list", async () => {
    const { plan, contents } = project();
    const altered = new Map(contents).set("README.md", { content: "# Other\n", executable: false });
    await expect(applyChanges(ports(fs), plan, altered)).rejects.toThrow(PlanError);
    const executable = new Map(contents).set("README.md", { content: "# New\n", executable: true });
    await expect(applyChanges(ports(fs), plan, executable)).rejects.toThrow(
      "README.md would now differ from what the plan lists",
    );
    const fewer = new Map(contents);
    fewer.delete("run.sh");
    await expect(applyChanges(ports(fs), plan, fewer)).rejects.toThrow(
      "the new files do not match the plan",
    );
    expect(read("README.md").toString()).toBe("# Old\n");
  });

  it.each([
    ["its original is kept", "copyWithin", "README.md"],
    ["its replacement is prepared", "copyFile", "README.md"],
    // data.bin is moved into a directory in staging made for it.
    ["the directory it goes in is made", "makeDirectory", "data.bin"],
  ])("never overwrites an edit made while %s", async (_when, step, file) => {
    const { plan, contents } = project();
    let edited = false;
    const editing: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      [step]: async (...args: unknown[]) => {
        const done = await (fs[step as keyof ProjectFsPort] as (...a: unknown[]) => unknown).apply(
          fs,
          args,
        );
        // Not .liftoff, which a change makes before anything else.
        if (!edited && !String(args[0]).endsWith(".liftoff")) {
          edited = true;
          write(file, "# Mine\n");
        }
        return done;
      },
    });
    await expect(applyChanges(ports(editing), plan, contents)).rejects.toThrow(
      `${file} changed while the change was being made`,
    );
    expect(read(file).toString()).toBe("# Mine\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
  });

  it("refuses a plan too large to recover, or a file too large to change, before anything", async () => {
    const { plan } = project();
    const many = Array.from({ length: 12_000 }, (_, index) => `d/${"x".repeat(200)}${index}`);
    const huge = sealChangePlan({
      ...plan,
      changes: many.map((file) => ({
        path: file,
        before: null,
        after: sha256Hex(file),
        ownership: "managed" as const,
        executable: false,
      })),
    });
    const contents = new Map(many.map((file) => [file, { content: file, executable: false }]));
    await expect(applyChanges(ports(fs), huge, contents)).rejects.toThrow(
      "the plan changes too many files to recover if it stopped part way",
    );
    const big = "x".repeat(MAX_CHANGED_BYTES + 1);
    const large = sealChangePlan({
      ...plan,
      changes: [
        {
          path: "big.txt",
          before: null,
          after: sha256Hex(big),
          ownership: "managed",
          executable: false,
        },
      ],
    });
    await expect(
      applyChanges(ports(fs), large, new Map([["big.txt", { content: big, executable: false }]])),
    ).rejects.toThrow("big.txt would be larger than 67108864 bytes");
    expect(leftovers()).toEqual([]);
    expect(existsSync(path.join(root, ".liftoff", "change.lock"))).toBe(false);
  });

  it("stops when a later original is swapped for a FIFO, without waiting on it", async () => {
    const { plan, contents } = project();
    // Windows has no FIFOs at a file path.
    if (process.platform === "win32") return;
    const { port } = recording({
      afterMove: (count) => {
        if (count === 1) {
          rmSync(path.join(root, "data.bin"));
          execFileSync("mkfifo", [path.join(root, "data.bin")]);
        }
      },
    });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow(
      "data.bin changed while the change was being made",
    );
  }, 5_000);

  it("never makes a directory through a link swapped in on the way", async () => {
    write("docs/index.md", "# Docs\n");
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-outside-"));
    try {
      const plan = sealChangePlan({
        schema: PLAN_SCHEMA,
        operation: "update",
        liftoff: "1.0.0",
        target: root,
        config: { name: "demo" },
        effects: ["modify-files"],
        changes: [
          {
            path: "docs/new/guide.md",
            before: null,
            after: sha256Hex("# Guide\n"),
            ownership: "managed",
            executable: false,
          },
        ],
      });
      // Swapped as the new file is prepared, before its directory is made.
      const swapping: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
        copyFile: async (from: string, to: string) => {
          await fs.copyFile(from, to);
          rmSync(path.join(root, "docs"), { recursive: true });
          symlinkSync(outside, path.join(root, "docs"), "junction");
        },
      });
      await expect(
        applyChanges(
          ports(swapping),
          plan,
          new Map([["docs/new/guide.md", { content: "# Guide\n", executable: false }]]),
        ),
      ).rejects.toThrow("docs/new/guide.md changed while the change was being made");
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops before a file edited while the change was being made", async () => {
    const { plan, contents } = project();
    // Changes are made in order: README.md, data.bin, run.sh, liftoff.yaml, the manifest.
    const { port } = recording({ afterMove: (count) => count === 1 && write("run.sh", "mine") });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow(
      "run.sh changed while the change was being made, so it and the files after it were left alone; finish or undo the change with liftoff agents add --recover",
    );
    expect(read("run.sh").toString()).toBe("mine");
    expect(read("liftoff.yaml").toString()).toBe("name: demo\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
  });
});

describe("CHANGE-002 files a change rests on", () => {
  it("must still have the content seen, or still be absent, or nothing changes", async () => {
    const { plan, contents } = project();
    write("rests-on.txt", "edited\n");
    write("was-absent.txt", "appeared\n");
    const { hash: _, ...unsigned } = plan;
    const resting = sealChangePlan({
      ...unsigned,
      unchanged: [
        { path: "rests-on.txt", sha256: sha256Hex("as planned\n") },
        { path: "was-absent.txt", sha256: null },
      ],
    });
    const refused = applyChanges(ports(fs), resting, contents);
    await expect(refused).rejects.toThrow(ChangeConflictError);
    await expect(applyChanges(ports(fs), resting, contents)).rejects.toThrow(
      "rests-on.txt changed since the plan was made; was-absent.txt already exists",
    );
    expect(read("README.md").toString()).toBe("# Old\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe("CHANGE-003 a change that stops part way can be finished or undone", () => {
  /** Stops the change after README.md and data.bin have changed. */
  async function interrupted() {
    const { plan, contents } = project();
    const { port } = recording({ failOnMove: 3 });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow("the machine stopped");
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
    return { plan, contents };
  }

  it("keeps the copies of the project's files private", async () => {
    await interrupted();
    const staging = path.join(parent, leftovers()[0] ?? "");
    expect(existsSync(path.join(staging, "before", "README.md"))).toBe(true);
    // Windows keeps access in lists the directory inherits, not in its mode.
    if (process.platform !== "win32") expect(statSync(staging).mode & 0o077).toBe(0);
  });

  it("is reported by validate, and blocks another change", async () => {
    const { plan, contents } = await interrupted();
    const result = await validateProject(fs, root);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      code: "interrupted-change",
      path: ".liftoff/change-journal.json",
      message: expect.stringContaining(
        "a change by liftoff agents add that began 2026-10-26T12:00:00Z has not finished",
      ),
    });
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      "a change to this project stopped part way",
    );
  });

  it("finishes it", async () => {
    await interrupted();
    expect(await recoverChanges(ports(fs), root, "finish")).toEqual({
      operation: "agents-add",
      changed: ["run.sh", "liftoff.yaml", ".liftoff/manifest.json"],
      conflicts: [],
      waiting: [],
      complete: true,
      leftovers: [],
    });
    expect(read("run.sh").toString()).toBe("#!/bin/sh\necho hi\n");
    expect(read(".liftoff/manifest.json").toString()).toBe('{"files":[]}\n');
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("undoes it, restoring every original byte for byte", async () => {
    await interrupted();
    expect(await recoverChanges(ports(fs), root, "undo")).toMatchObject({
      changed: ["README.md", "data.bin"],
      conflicts: [],
      complete: true,
    });
    expect(read("README.md").toString()).toBe("# Old\n");
    expect(read("data.bin")).toEqual(BINARY);
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
    expect(leftovers()).toEqual([]);
    await expect(recoverChanges(ports(fs), root, "undo")).rejects.toThrow(ChangeError);
  });

  it("restores originals byte for byte however few bytes the disk takes at a time", async () => {
    const { plan, contents } = project();
    const { port } = recording({ failOnMove: 3 });
    const slow: ProjectFsPort = Object.assign(Object.create(port) as ProjectFsPort, {
      copyWithin: (directory: string, relative: string, maxBytes: number, to: string) =>
        copyWithin(directory, relative, maxBytes, to, writingThreeBytesAtATime),
    });
    await expect(applyChanges(ports(slow), plan, contents)).rejects.toThrow("the machine stopped");
    expect(await recoverChanges(ports(fs), root, "undo")).toMatchObject({ complete: true });
    expect(read("data.bin")).toEqual(BINARY);
    expect(read("README.md").toString()).toBe("# Old\n");
  });

  it("undoes a file the change added", async () => {
    const { plan, contents } = project();
    // Stops after README.md, data.bin and run.sh.
    const { port } = recording({ failOnMove: 4 });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow("the machine stopped");
    expect(existsSync(path.join(root, "run.sh"))).toBe(true);
    await recoverChanges(ports(fs), root, "undo");
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
  });

  it("never overwrites a file edited after the change stopped", async () => {
    await interrupted();
    write("README.md", "# Edited after\n");
    const result = await recoverChanges(ports(fs), root, "undo");
    expect(result).toMatchObject({
      changed: ["data.bin"],
      conflicts: ["README.md"],
      complete: false,
    });
    expect(read("README.md").toString()).toBe("# Edited after\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
    // Once the person puts it back, recovery completes.
    write("README.md", "# New\n");
    expect(await recoverChanges(ports(fs), root, "undo")).toMatchObject({
      changed: ["README.md"],
      complete: true,
    });
    expect(read("README.md").toString()).toBe("# Old\n");
  });

  it("leaves a file alone when what it should become is gone", async () => {
    await interrupted();
    const staging = leftovers()[0] ?? "";
    rmSync(path.join(parent, staging, "after", "run.sh"));
    const result = await recoverChanges(ports(fs), root, "finish");
    expect(result).toMatchObject({
      conflicts: ["run.sh"],
      waiting: ["liftoff.yaml", ".liftoff/manifest.json"],
      complete: false,
    });
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);
    // The manifest never describes a file that is not there.
    expect(read("liftoff.yaml").toString()).toBe("name: demo\n");
    expect(read(".liftoff/manifest.json").toString()).toBe("{}\n");
  });

  it("switches between undoing and finishing until it completes", async () => {
    await interrupted();
    write("liftoff.yaml", "name: mine\n");
    expect(await recoverChanges(ports(fs), root, "undo")).toMatchObject({
      changed: ["README.md", "data.bin"],
      conflicts: ["liftoff.yaml"],
      complete: false,
    });
    write("liftoff.yaml", "name: demo\n");
    expect(await recoverChanges(ports(fs), root, "finish")).toMatchObject({
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
    await expect(recoverChanges(ports(fs), copy, "finish")).rejects.toThrow(
      "belongs to another copy of this project or another change",
    );
    expect(await recoverChanges(ports(fs), root, "undo")).toMatchObject({ complete: true });
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
      await expect(recoverChanges(ports(fs), root, "finish")).rejects.toThrow(
        "are missing or not a directory, so it cannot be recovered",
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("says what to do about a journal that is empty", async () => {
    write("liftoff.yaml", "name: demo\n");
    write(".liftoff/change-journal.json", "");
    await expect(recoverChanges(ports(fs), root, "undo")).rejects.toThrow(
      "if it is empty, the change stopped before any file changed, so delete it",
    );
    expect((await validateProject(fs, root)).findings[0]?.message).toContain(
      "if it is empty, the change stopped before any file changed",
    );
  });

  it("finds no journal behind a linked .liftoff", async () => {
    write("liftoff.yaml", "name: demo\n");
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-outside-"));
    try {
      writeFileSync(path.join(outside, "change-journal.json"), "{}");
      symlinkSync(outside, path.join(root, ".liftoff"), "junction");
      const codes = (await validateProject(fs, root)).findings.map((finding) => finding.code);
      expect(codes).not.toContain("interrupted-change");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("creates nothing for a project that has moved since its plan", async () => {
    const { plan, contents } = project();
    renameSync(root, path.join(parent, "moved"));
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      `${root} is not a directory Liftoff can change`,
    );
    await expect(recoverChanges(ports(fs), root, "undo")).rejects.toThrow(
      "is not a directory Liftoff can change",
    );
    expect(existsSync(root)).toBe(false);
  });

  it("reads a journal that is not one as a problem, in validate too", async () => {
    write("liftoff.yaml", "name: demo\n");
    write(".liftoff/change-journal.json", '{"staging":"../../elsewhere"}');
    await expect(recoverChanges(ports(fs), root, "finish")).rejects.toThrow(
      /change-journal.json is invalid/,
    );
    const result = await validateProject(fs, root);
    expect(result.findings[0]).toMatchObject({
      code: "interrupted-change",
      message: expect.stringContaining("its journal cannot be read"),
    });
  });
});

describe("CHANGE-003 recovery acts only on the change approved, and stops when cancelled", () => {
  async function interrupted() {
    const { plan, contents } = project();
    const { port } = recording({ failOnMove: 3 });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow("the machine stopped");
    return plan;
  }

  it("refuses a journal for another plan than the one approved", async () => {
    await interrupted();
    await expect(recoverChanges(ports(fs), root, "undo", { plan: "b".repeat(64) })).rejects.toThrow(
      /no longer the one shown.*nothing was changed/,
    );
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
  });

  it("changes nothing when cancelled before a file, and stops recoverably after one", async () => {
    const plan = await interrupted();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      recoverChanges(ports(fs), root, "finish", { plan: plan.hash, signal: cancelled.signal }),
    ).rejects.toThrow(cancelled.signal.reason);
    expect(existsSync(path.join(root, "run.sh"))).toBe(false);

    const later = new AbortController();
    const { port } = recording({ afterMove: () => later.abort() });
    await expect(
      recoverChanges(ports(port), root, "finish", { signal: later.signal }),
    ).rejects.toThrow(ChangeStoppedError);
    expect(read("run.sh").toString()).toBe("#!/bin/sh\necho hi\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
    expect((await recoverChanges(ports(fs), root, "finish")).complete).toBe(true);
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
            ports(fs),
            other,
            new Map([["README.md", { content: "# Repaired\n", executable: false }]]),
          );
        }
        return fs.createExclusive(file, content);
      },
    });
    await expect(applyChanges(ports(racing), plan, contents)).rejects.toThrow(
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
      replaceFile: async (file: string, content: string) => {
        if (file.endsWith("change-journal.json"))
          throw new Error("ENOSPC: no space left on device");
        return fs.replaceFile(file, content);
      },
    });
    await expect(applyChanges(ports(failing), plan, contents)).rejects.toThrow("ENOSPC");
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
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow("the machine stopped");
    const result = await validateProject(fs, root);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "interrupted-change",
      "not-a-liftoff-project",
    ]);
  });
});

describe("CHANGE-003 a change and its recovery hold one lock", () => {
  const lockFile = () => path.join(root, ".liftoff", "change.lock");
  const holdLock = (pid: number, host = HOST) =>
    write(".liftoff/change.lock", JSON.stringify({ pid, host, started: "earlier" }));

  it("keeps its lock and journal only in a real .liftoff directory", async () => {
    write("README.md", "# Old\n");
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-outside-"));
    try {
      symlinkSync(outside, path.join(root, ".liftoff"), "junction");
      const plan = sealChangePlan({
        schema: PLAN_SCHEMA,
        operation: "repair",
        liftoff: "1.0.0",
        target: root,
        config: { name: "demo" },
        effects: ["modify-files"],
        changes: [
          {
            path: "README.md",
            before: sha256Hex("# Old\n"),
            after: sha256Hex("# New\n"),
            ownership: "managed",
            executable: false,
          },
        ],
      });
      const contents = new Map([["README.md", { content: "# New\n", executable: false }]]);
      await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
        ".liftoff is a link, or not a directory",
      );
      await expect(recoverChanges(ports(fs), root, "undo")).rejects.toThrow(
        ".liftoff is a link, or not a directory",
      );
      expect(readdirSync(outside)).toEqual([]);
      expect(read("README.md").toString()).toBe("# Old\n");
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never recovers a change that is still being made", async () => {
    const { plan, contents } = project();
    let recovery: unknown;
    const watching: ProjectFsPort = Object.assign(Object.create(fs) as ProjectFsPort, {
      copyFile: async (from: string, to: string) => {
        if (recovery === undefined) {
          recovery = await recoverChanges(ports(fs), root, "undo").catch((error: unknown) => error);
        }
        return fs.copyFile(from, to);
      },
    });
    await applyChanges(ports(watching), plan, contents);
    expect(String(recovery)).toContain(
      `process ${process.pid} on ${HOST}, which began at ${now()}, is changing this project`,
    );
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(lockFile())).toBe(false);
  });

  it("never takes over a lock, but says whether its process is still running", async () => {
    const { plan, contents } = project();
    holdLock(process.pid);
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      `process ${process.pid} on ${HOST}, which began at earlier, is changing this project; wait for it, or if it is not running, delete .liftoff/change.lock`,
    );
    holdLock(4_000_000, "another-host");
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      "on another-host, which began at earlier, is changing this project",
    );
    write(".liftoff/change.lock", "not a lock");
    await expect(applyChanges(ports(fs), plan, contents)).rejects.toThrow(
      "another liftoff command is changing this project; if none is, delete .liftoff/change.lock",
    );
    holdLock(4_000_000);
    await expect(recoverChanges(ports(fs), root, "undo")).rejects.toThrow(
      "process 4000000 on test-host, which began at earlier, stopped while changing this project; delete .liftoff/change.lock, then try again",
    );
    expect(read("README.md").toString()).toBe("# Old\n");
    rmSync(lockFile());
    expect(await applyChanges(ports(fs), plan, contents)).toEqual({ changed: 5, leftovers: [] });
    expect(readdirSync(path.join(root, ".liftoff"))).toEqual(["manifest.json"]);
  });
});

describe("CHANGE-004 files change one at a time, the manifest last", () => {
  it("changes the project's files, then liftoff.yaml, then the manifest", async () => {
    const { plan, contents } = project();
    const { port, moved } = recording();
    await applyChanges(ports(port), plan, contents);
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

describe("CHANGE-004 a file keeps the permissions of the file it replaces", () => {
  const mode = (relative: string) => statSync(path.join(root, relative)).mode & 0o777;

  /** Makes these files private, then stops the change after README.md and data.bin. */
  async function stoppedWithPrivateFiles() {
    const { plan, contents } = project();
    const { chmodSync } = await import("node:fs");
    for (const file of ["README.md", "liftoff.yaml", "data.bin"]) {
      chmodSync(path.join(root, file), 0o600);
    }
    const { port } = recording({ failOnMove: 3 });
    await expect(applyChanges(ports(port), plan, contents)).rejects.toThrow("the machine stopped");
  }

  it("keeps a private file private when it is changed, and when the change is finished", async () => {
    if (process.platform === "win32") {
      // Windows has no such permissions; the change still applies.
      const { plan, contents } = project();
      await applyChanges(ports(fs), plan, contents);
      expect(read("README.md").toString()).toBe("# New\n");
      return;
    }
    await stoppedWithPrivateFiles();
    expect(mode("README.md")).toBe(0o600);
    expect((await recoverChanges(ports(fs), root, "finish")).complete).toBe(true);
    expect(mode("liftoff.yaml")).toBe(0o600);
    expect(mode("run.sh") & 0o111).not.toBe(0);
  });

  it("puts back a private file private when the change is undone", async () => {
    if (process.platform === "win32") return;
    await stoppedWithPrivateFiles();
    expect((await recoverChanges(ports(fs), root, "undo")).complete).toBe(true);
    expect(mode("README.md")).toBe(0o600);
    expect(mode("data.bin")).toBe(0o600);
  });
});

describe("CHANGE-004 a change cancelled, or not tidied up, says where it stands", () => {
  it("changes nothing when cancelled before the first file, and stops recoverably after it", async () => {
    const { plan, contents } = project();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      applyChanges(ports(fs), plan, contents, { signal: cancelled.signal }),
    ).rejects.toThrow(cancelled.signal.reason);
    expect(read("README.md").toString()).toBe("# Old\n");
    expect(leftovers()).toEqual([]);

    const later = new AbortController();
    const { port } = recording({ afterMove: () => later.abort() });
    await expect(
      applyChanges(ports(port), plan, contents, { signal: later.signal }),
    ).rejects.toThrow("the change was cancelled after 1 of 5 files");
    expect(read("README.md").toString()).toBe("# New\n");
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(true);
  });

  it("completes, naming the kept copies and lock it could not remove", async () => {
    const { plan, contents } = project();
    const port = Object.assign(Object.create(fs) as ProjectFsPort, {
      remove: async (target: string) => {
        if (/\.liftoff-staging-[^/\\]+$/.test(target) || target.endsWith("change.lock")) {
          throw new Error("EPERM: operation not permitted");
        }
        return fs.remove(target);
      },
    });
    const result = await applyChanges(ports(port), plan, contents);
    expect(result.changed).toBe(5);
    expect(result.leftovers).toEqual([
      expect.stringMatching(
        /^the kept copies in \.demo\.liftoff-staging-\S+ beside the project could not be removed \(EPERM/,
      ),
      ".liftoff/change.lock could not be removed (EPERM: operation not permitted); delete it",
    ]);
    expect(read(".liftoff/manifest.json").toString()).toBe('{"files":[]}\n');
    expect(existsSync(path.join(root, ".liftoff", "change-journal.json"))).toBe(false);
  });
});
