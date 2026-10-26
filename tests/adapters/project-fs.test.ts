import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashWithin,
  LocalProjectFs,
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
  });

  it("does not hash a file that changed while it was being hashed", async () => {
    write("record.json", "{}");
    const file = path.join(work, "record.json");
    const grown = calls({ afterStat: () => appendFileSync(file, "x") });
    expect(await hashWithin(work, "record.json", 100, grown.calls)).toEqual({ kind: "other" });
    const runaway = calls({ afterStat: () => appendFileSync(file, "x".repeat(70 * 1024)) });
    expect(await hashWithin(work, "record.json", 100, runaway.calls)).toEqual({ kind: "other" });
    expect(runaway.read.bytes).toBeLessThanOrEqual(101);
  });
});
