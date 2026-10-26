import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs, readUnchanged } from "../../src/adapters/project-fs.ts";

const fs = new LocalProjectFs();
let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-fs-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("LEGACY-003 reading a record follows no link and stays within its limit", () => {
  it("reads a regular file and tells other paths apart", async () => {
    const file = path.join(work, "record.json");
    writeFileSync(file, "{}");
    mkdirSync(path.join(work, "directory"));
    symlinkSync(path.join(work, "directory"), path.join(work, "link"), "junction");
    expect(await fs.readRegular(file, 10)).toEqual({ kind: "file", size: 2, text: "{}" });
    expect(await fs.readRegular(path.join(work, "directory"), 10)).toEqual({ kind: "directory" });
    expect(await fs.readRegular(path.join(work, "link"), 10)).toEqual({ kind: "other" });
    expect(await fs.readRegular(path.join(work, "missing.json"), 10)).toEqual({
      kind: "missing",
    });
    expect(await fs.entry(path.join(work, "link"))).toEqual({ kind: "other", size: 0 });
  });

  it("leaves the text out of a file over the limit", async () => {
    const file = path.join(work, "record.json");
    writeFileSync(file, "x".repeat(11));
    expect(await fs.readRegular(file, 10)).toEqual({ kind: "file", size: 11 });
    expect(await fs.readRegular(file, 11)).toMatchObject({ text: "x".repeat(11) });
  });

  /** Writes a file and returns what an inspection of it saw, taken from its own handle. */
  const inspectedAfterWriting = (file: string, content: string) => {
    const handle = openSync(file, "w");
    try {
      writeSync(handle, content);
      return { handle, inspected: fstatSync(handle, { bigint: true }) };
    } catch (error) {
      closeSync(handle);
      throw error;
    }
  };

  it("reads no more than the limit when the file grew after it was inspected", async () => {
    const file = path.join(work, "record.json");
    const { handle, inspected } = inspectedAfterWriting(file, "{}");
    writeSync(handle, "x".repeat(4096));
    closeSync(handle);
    expect(await readUnchanged(file, inspected, 10)).toEqual({ kind: "file", size: 4098 });
  });

  it("does not read another file swapped in after the inspection", async () => {
    const file = path.join(work, "record.json");
    const { handle, inspected } = inspectedAfterWriting(file, "{}");
    closeSync(handle);
    const other = path.join(work, "other.json");
    writeFileSync(other, '{"secret":true}');
    renameSync(other, file);
    expect(await readUnchanged(file, inspected, 100)).toEqual({ kind: "other" });
    rmSync(file);
    expect(await readUnchanged(file, inspected, 100)).toEqual({ kind: "missing" });
  });
});
