import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside } from "../../scripts/inside.ts";

describe("repository scripts touch only files inside the repository", () => {
  it("takes a path below the root, on Windows and elsewhere", () => {
    expect(isInside("C:\\work\\liftoff", "C:\\work\\liftoff\\dist", path.win32)).toBe(true);
    expect(isInside("C:\\work\\liftoff", "dist", path.win32)).toBe(true);
    expect(isInside("/work/liftoff", "/work/liftoff/dist", path.posix)).toBe(true);
    expect(isInside("/work/liftoff", "..dist", path.posix)).toBe(true);
  });

  it("refuses the root itself, however its drive letter is written", () => {
    expect(isInside("C:\\work\\liftoff", "c:\\work\\liftoff", path.win32)).toBe(false);
    expect(isInside("C:\\work\\liftoff", "C:\\work\\liftoff\\", path.win32)).toBe(false);
    expect(isInside("/work/liftoff", ".", path.posix)).toBe(false);
  });

  it("refuses another drive and anything outside", () => {
    expect(isInside("C:\\work\\liftoff", "D:\\work\\liftoff\\dist", path.win32)).toBe(false);
    expect(isInside("C:\\work\\liftoff", "..\\other", path.win32)).toBe(false);
    expect(isInside("/work/liftoff", "../other", path.posix)).toBe(false);
    expect(isInside("/work/liftoff", "/etc", path.posix)).toBe(false);
  });
});
