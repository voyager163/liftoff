import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyWithin,
  hashWithin,
  type ListCalls,
  LocalProjectFs,
  listWithin,
  type ReadCalls,
  readWithin,
} from "../../src/adapters/project-fs.ts";

const fs = new LocalProjectFs();
let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-fs-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const write = (relative: string, content: string) => {
  const target = path.join(work, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

interface Hooks {
  /** Run ahead of the first lstat of a path, by its path under the test directory. */
  readonly beforeLstat?: Record<string, () => void>;
  /** Run once, after the inspections and before the file is opened. */
  readonly beforeOpen?: () => void | Promise<void>;
  /** Run once, after the opened file's first stat. */
  readonly afterStat?: () => void;
}

/** The real calls with hooks between them, and a count of what was read. */
function calls({ beforeLstat = {}, beforeOpen, afterStat }: Hooks = {}) {
  const done = new Set<string>();
  const read = { bytes: 0, calls: 0 };
  const wrapped: ReadCalls = {
    lstat: async (target) => {
      const key = path.relative(work, target).split(path.sep).join("/");
      if (!done.has(key)) {
        done.add(key);
        beforeLstat[key]?.();
      }
      return lstat(target, { bigint: true });
    },
    open: async (target, flags) => {
      await beforeOpen?.();
      const handle = await open(target, flags);
      let stats = 0;
      return new Proxy(handle, {
        get(real, property) {
          if (property === "read") {
            return async (...args: Parameters<FileHandle["read"]>) => {
              read.calls++;
              const result = await real.read(...args);
              read.bytes += result.bytesRead;
              return result;
            };
          }
          if (property === "stat") {
            return async (...args: Parameters<FileHandle["stat"]>) => {
              const result = await real.stat(...args);
              if (stats++ === 0) afterStat?.();
              return result;
            };
          }
          const value = Reflect.get(real, property);
          return typeof value === "function" ? value.bind(real) : value;
        },
      });
    },
  };
  return { calls: wrapped, read };
}

describe("LEGACY-003 reading a record follows no link and stays within its limit", () => {
  it("reads a regular file and tells other paths apart", async () => {
    write("governance/record.json", "{}");
    mkdirSync(path.join(work, "directory"));
    symlinkSync(path.join(work, "directory"), path.join(work, "link"), "junction");
    expect(await fs.readWithin(work, "governance/record.json", 10)).toEqual({
      kind: "file",
      size: 2,
      text: "{}",
    });
    expect(await fs.readWithin(work, "directory", 10)).toEqual({ kind: "directory" });
    expect(await fs.readWithin(work, "link", 10)).toEqual({ kind: "other" });
    expect(await fs.readWithin(work, "link/record.json", 10)).toEqual({
      kind: "other",
      via: "link",
    });
    expect(await fs.readWithin(work, "missing/record.json", 10)).toEqual({ kind: "missing" });
    expect(await fs.entry(path.join(work, "link"))).toEqual({ kind: "other", size: 0 });
  });

  it("does not read a file already over the limit", async () => {
    write("record.json", "x".repeat(11));
    const { calls: spied, read } = calls();
    expect(await readWithin(work, "record.json", 10, spied)).toEqual({ kind: "file", size: 11 });
    expect(read.calls).toBe(0);
    expect(await fs.readWithin(work, "record.json", 11)).toMatchObject({ text: "x".repeat(11) });
  });

  it("reads no more than the limit when the file grows as it is read", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    const { calls: spied, read } = calls({
      afterStat: () => appendFileSync(file, "x".repeat(4096)),
    });
    expect(await readWithin(work, "record.json", 10, spied)).toEqual({ kind: "file", size: 4098 });
    expect(read.bytes).toBeLessThanOrEqual(10);
  });

  it("does not read another file swapped in after the inspection", async () => {
    write("record.json", "{}");
    write("other.json", '{"secret":true}');
    const { calls: swapping, read } = calls({
      beforeOpen: () => renameSync(path.join(work, "other.json"), path.join(work, "record.json")),
    });
    expect(await readWithin(work, "record.json", 100, swapping)).toEqual({ kind: "other" });
    expect(read.calls).toBe(0);
  });

  it("does not read through a directory swapped for a link before the file is opened", async () => {
    write("governance/activation-state.json", "{}");
    const elsewhere = mkdtempSync(path.join(tmpdir(), "liftoff-elsewhere-"));
    try {
      writeFileSync(path.join(elsewhere, "activation-state.json"), '{"secret":true}');
      const { calls: spied, read } = calls({
        beforeLstat: {
          "governance/activation-state.json": () => {
            rmSync(path.join(work, "governance"), { recursive: true });
            symlinkSync(elsewhere, path.join(work, "governance"), "junction");
          },
        },
      });
      expect(await readWithin(work, "governance/activation-state.json", 100, spied)).toEqual({
        kind: "other",
        via: "governance",
      });
      expect(read.calls).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not wait on a FIFO swapped in after the inspection", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    // Windows has no FIFOs at a file path.
    if (process.platform === "win32") return;
    const { calls: swapping } = calls({
      beforeOpen: () => {
        rmSync(file);
        execFileSync("mkfifo", [file]);
      },
    });
    expect(await readWithin(work, "record.json", 100, swapping)).toEqual({ kind: "other" });
  }, 5_000);

  it("does not fail on a socket swapped in after the inspection", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    // Windows has no sockets at a file path.
    if (process.platform === "win32") return;
    const server = createServer();
    try {
      const { calls: swapping } = calls({
        beforeOpen: async () => {
          rmSync(file);
          await new Promise<void>((resolve) => server.listen(file, resolve));
        },
      });
      expect(await readWithin(work, "record.json", 100, swapping)).toEqual({ kind: "other" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("CHANGE-002 hashing a file follows no link and sees it change", () => {
  it("hashes a whole regular file and says whether it is executable", async () => {
    write("big.bin", "x".repeat(200 * 1024));
    write("run.sh", "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(path.join(work, "run.sh"), 0o755);
    expect(await fs.hashWithin(work, "big.bin", 1024 * 1024)).toEqual({
      kind: "file",
      size: 200 * 1024,
      sha256: createHash("sha256")
        .update("x".repeat(200 * 1024))
        .digest("hex"),
      executable: false,
    });
    expect(await fs.hashWithin(work, "run.sh", 100)).toMatchObject({
      executable: process.platform !== "win32",
    });
    expect(await fs.hashWithin(work, "big.bin", 10)).toEqual({ kind: "file", size: 200 * 1024 });
    expect(await fs.hashWithin(work, "missing", 10)).toEqual({ kind: "missing" });
    mkdirSync(path.join(work, "directory"));
    write("directory/record.json", "{}");
    symlinkSync(path.join(work, "directory"), path.join(work, "link"), "junction");
    expect(await fs.hashWithin(work, "link", 10)).toEqual({ kind: "other" });
    expect(await fs.hashWithin(work, "link/record.json", 10)).toEqual({
      kind: "other",
      via: "link",
    });
    expect(await fs.directoryIdentity(path.join(work, "link"))).toBeUndefined();
    // The inode alone, which stays when a disk is attached again under another device number.
    expect(await fs.directoryIdentity(path.join(work, "directory"))).toBe(
      `${statSync(path.join(work, "directory"), { bigint: true }).ino}`,
    );
  });

  it("never hashes a state the file was not in, nor past the limit, when it grows", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    const grown = calls({ afterStat: () => appendFileSync(file, "x") });
    const hashed = await hashWithin(work, "record.json", 100, grown.calls);
    // It sees the change, or (where the system does not show it to the open
    // file, as Windows may not) hashes the whole file as it now is.
    expect([
      { kind: "other" },
      {
        kind: "file",
        size: 3,
        sha256: createHash("sha256").update("{}x").digest("hex"),
        executable: false,
      },
    ]).toContainEqual(hashed);
    const runaway = calls({ afterStat: () => appendFileSync(file, "x".repeat(70 * 1024)) });
    expect(await hashWithin(work, "record.json", 100, runaway.calls)).toEqual({ kind: "other" });
    expect(runaway.read.bytes).toBeLessThanOrEqual(101);
  });
});

describe("CHANGE-003 copying an original as it is read", () => {
  it("copies a regular file with its mode, and its hash", async () => {
    write("run.sh", "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(path.join(work, "run.sh"), 0o750);
    const to = path.join(work, "kept", "run.sh");
    expect(await fs.copyWithin(work, "run.sh", 100, to)).toEqual({
      kind: "file",
      size: 10,
      sha256: createHash("sha256").update("#!/bin/sh\n").digest("hex"),
      executable: process.platform !== "win32",
    });
    expect(readFileSync(to, "utf8")).toBe("#!/bin/sh\n");
    if (process.platform !== "win32") expect(statSync(to).mode & 0o777).toBe(0o750);
    await expect(fs.copyWithin(work, "run.sh", 100, to)).rejects.toThrow(/EEXIST/);
  });

  it("leaves nothing when the file is over the limit, grows past it, or is replaced", async () => {
    write("record.json", "x".repeat(20));
    const to = path.join(work, "kept.json");
    expect(await fs.copyWithin(work, "record.json", 10, to)).toEqual({ kind: "file", size: 20 });
    expect(existsSync(to)).toBe(false);
    const file = path.join(work, "record.json");
    const growing = calls({ afterStat: () => appendFileSync(file, "x".repeat(100)) });
    expect(await copyWithin(work, "record.json", 50, to, growing.calls)).toEqual({
      kind: "file",
      size: 51,
    });
    expect(growing.read.bytes).toBeLessThanOrEqual(51);
    expect(existsSync(to)).toBe(false);
    writeFileSync(file, "{}");
    let replaced = false;
    const replacing = calls({ afterStat: () => (replaced = replace(file, '{"edited":true}')) });
    const copied = await copyWithin(work, "record.json", 100, to, replacing.calls);
    if (replaced) {
      expect(copied).toEqual({ kind: "other" });
      expect(existsSync(to)).toBe(false);
    } else {
      expect(copied).toMatchObject({ kind: "file", size: 2 });
    }
  });

  it("writes every byte when the disk takes fewer at a time, or fails", async () => {
    const content = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));
    writeFileSync(path.join(work, "data.bin"), content);
    const to = path.join(work, "kept.bin");
    expect(await copyWithin(work, "data.bin", 2000, to, shortWrites(7))).toMatchObject({
      kind: "file",
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(readFileSync(to)).toEqual(content);
    rmSync(to);
    await expect(copyWithin(work, "data.bin", 2000, to, shortWrites(0))).rejects.toThrow(
      "no progress",
    );
    expect(existsSync(to)).toBe(false);
  });

  it("does not take a file replaced while it was hashed for the one it opened", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    let replaced = false;
    const hashed = await hashWithin(
      work,
      "record.json",
      100,
      calls({ afterStat: () => (replaced = replace(file, '{"edited":true}')) }).calls,
    );
    const read = await readWithin(
      work,
      "record.json",
      100,
      calls({ afterStat: () => replace(file, "{}") }).calls,
    );
    if (replaced) {
      expect([hashed, read]).toEqual([{ kind: "other" }, { kind: "other" }]);
    } else {
      // Windows refused to replace the open file, so what was read stands.
      expect([hashed.kind, read.kind]).toEqual(["file", "file"]);
    }
  });
});

/**
 * Replaces a file in one step, as an editor saving it does: true if it was
 * replaced. Windows refuses to replace a file that is open, so there the
 * race cannot happen at all.
 */
function replace(file: string, content: string): boolean {
  const temporary = `${file}.saving`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, file);
    return true;
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
      throw error;
    rmSync(temporary);
    return false;
  }
}

/** The real calls, writing no more than a few bytes at a time to a file opened for writing. */
function shortWrites(limit: number): ReadCalls {
  const real = calls().calls;
  return {
    ...real,
    open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if ((flags & constants.O_WRONLY) === 0) return handle;
      return new Proxy(handle, {
        get(fileHandle, property) {
          if (property === "write") {
            return (buffer: Buffer, offset: number, length: number, position: number) =>
              fileHandle.write(buffer, offset, Math.min(length, limit), position);
          }
          const value = Reflect.get(fileHandle, property);
          return typeof value === "function" ? value.bind(fileHandle) : value;
        },
      });
    },
  };
}

describe("ASSESS-002 listing a directory follows no link and stays within its limit", () => {
  it("lists a directory's entries by name, with links as neither file nor directory", async () => {
    write("dir/b.txt", "");
    write("dir/a.txt", "");
    mkdirSync(path.join(work, "dir/sub"));
    symlinkSync(path.join(work, "dir/sub"), path.join(work, "dir/link"), "junction");
    expect(await fs.listWithin(work, "dir", 10)).toEqual({
      kind: "directory",
      complete: true,
      entries: [
        { name: "a.txt", kind: "file" },
        { name: "b.txt", kind: "file" },
        { name: "link", kind: "other" },
        { name: "sub", kind: "directory" },
      ],
    });
    expect(await fs.listWithin(work, ".", 10)).toEqual({
      kind: "directory",
      complete: true,
      entries: [{ name: "dir", kind: "directory" }],
    });
    expect(await fs.listWithin(work, "dir/link", 10)).toEqual({ kind: "other" });
    expect(await fs.listWithin(work, "dir/link/inner", 10)).toEqual({
      kind: "other",
      via: "dir/link",
    });
    expect(await fs.listWithin(work, "dir/a.txt", 10)).toEqual({ kind: "file" });
    expect(await fs.listWithin(work, "dir/a.txt/inner", 10)).toEqual({
      kind: "other",
      via: "dir/a.txt",
    });
    expect(await fs.listWithin(work, "missing", 10)).toEqual({ kind: "missing" });
  });

  it("lists no more than the limit", async () => {
    for (const name of ["1", "2", "3"]) write(`dir/${name}`, "");
    const listed = await fs.listWithin(work, "dir", 2);
    expect(listed).toMatchObject({ kind: "directory", complete: false });
    expect(listed.kind === "directory" ? listed.entries.length : 0).toBe(2);
    expect(await fs.listWithin(work, "dir", 3)).toMatchObject({ complete: true });
  });

  it("refuses a directory swapped for a link while it is listed", async () => {
    write("dir/mine.txt", "");
    const outside = mkdtempSync(path.join(tmpdir(), "liftoff-fs-outside-"));
    try {
      writeFileSync(path.join(outside, "theirs.txt"), "");
      const swapping: ListCalls = {
        lstat: (target) => lstat(target, { bigint: true }),
        opendir: async (target) => {
          renameSync(path.join(work, "dir"), path.join(work, "moved"));
          symlinkSync(outside, path.join(work, "dir"), "junction");
          return opendir(target);
        },
      };
      expect(await listWithin(work, "dir", 10, swapping)).toEqual({ kind: "other", via: "dir" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("tells a directory it may not read from one that failed", async () => {
    write("dir/x", "");
    const failing = (code: string): ListCalls => ({
      lstat: (target) => lstat(target, { bigint: true }),
      opendir: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    expect(await listWithin(work, "dir", 10, failing("EACCES"))).toEqual({ kind: "inaccessible" });
    expect(await listWithin(work, "dir", 10, failing("ENOENT"))).toEqual({ kind: "missing" });
    expect(await listWithin(work, "dir", 10, failing("ELOOP"))).toEqual({ kind: "other" });
    await expect(listWithin(work, "dir", 10, failing("EMFILE"))).rejects.toThrow("EMFILE");
  });
});
