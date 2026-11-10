import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UPGRADE_CODE } from "../../scripts/package/windows-installer.ts";
import {
  brewPackage,
  brewVersion,
  caskPlace,
  cellarPlace,
  commandCandidates,
  MSI_PRODUCTS_SCRIPT,
  MSI_UPGRADE_CODE,
  msiProducts,
  samePath,
  wingetNewestVersion,
  within,
} from "../../src/domain/install/channels.ts";
import { compareVersions, isNewer, parseVersion } from "../../src/domain/install/version.ts";

const order = (a: string, b: string) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) throw new Error(`${a} or ${b} is no version`);
  return compareVersions(left, right);
};

describe("UPGRADE-002 versions are compared as SemVer orders them", () => {
  it("orders releases and prereleases", () => {
    const sorted = [
      "0.1.0-alpha",
      "0.1.0-alpha.1",
      "0.1.0-alpha.beta",
      "0.1.0-beta",
      "0.1.0-beta.2",
      "0.1.0-beta.11",
      "0.1.0-rc.1",
      "0.1.0",
      "0.1.1",
      "0.2.0",
      "1.0.0",
    ];
    for (let index = 1; index < sorted.length; index++) {
      expect(order(sorted[index - 1] as string, sorted[index] as string)).toBe(-1);
      expect(order(sorted[index] as string, sorted[index - 1] as string)).toBe(1);
    }
    expect(order("v1.2.3", "1.2.3+build.5")).toBe(0);
    expect(parseVersion("01.0.0")).toBeUndefined();
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer(undefined, "0.1.0")).toBe(false);
    expect(isNewer("latest", "0.1.0")).toBe(false);
  });
});

describe("UPGRADE-001 channel records are read as each channel prints them", () => {
  it("asks Windows Installer as Windows PowerShell 5.1 can", () => {
    // 5.1 cannot call the Installer's methods by name.
    expect(MSI_PRODUCTS_SCRIPT).not.toMatch(/\$installer\.\w+\(/);
    expect(MSI_PRODUCTS_SCRIPT).toContain("InvokeMember($name, 'GetProperty'");
    expect(MSI_PRODUCTS_SCRIPT).toContain(`'RelatedProducts' @('${MSI_UPGRADE_CODE}')`);
  });

  it("shares the MSI's UpgradeCode", () => {
    expect(MSI_UPGRADE_CODE).toBe(UPGRADE_CODE);
    const wxs = readFileSync(
      path.resolve(import.meta.dirname, "../../distribution/windows/liftoff.wxs"),
      "utf8",
    );
    expect(wxs).toContain(`UpgradeCode="${MSI_UPGRADE_CODE.slice(1, -1)}"`);
  });

  it("finds Homebrew's places from the path alone, and nothing else", () => {
    expect(caskPlace("/opt/homebrew/Caskroom/liftoff/0.1.0/liftoff-package")).toEqual({
      prefix: "/opt/homebrew",
      token: "liftoff",
      version: "0.1.0",
    });
    expect(caskPlace("/Users/p/liftoff-package")).toBeUndefined();
    expect(
      cellarPlace(
        "/opt/homebrew/Cellar/liftoff/0.1.0/libexec/lib/node_modules/@voyager163/liftoff",
      ),
    ).toEqual({ prefix: "/opt/homebrew", name: "liftoff", version: "0.1.0" });
    expect(cellarPlace("/opt/homebrew/lib/node_modules/@voyager163/liftoff")).toBeUndefined();
    expect(brewVersion("1.2.0_1")).toBe("1.2.0");
    expect(brewVersion("1.2.0,42")).toBe("1.2.0");
  });

  it("reads brew, Windows Installer and WinGet output, and refuses anything else", () => {
    expect(brewPackage("nope", "cask", "liftoff")).toBeUndefined();
    expect(brewPackage('{"casks":[{"token":"liftoff"}]}', "cask", "liftoff")).toBeUndefined();
    expect(brewPackage('{"formulae":[{"name":"liftoff"}]}', "formula", "liftoff")).toBeUndefined();
    expect(
      brewPackage(
        '{"formulae":[{"name":"liftoff","full_name":"liftoff","versions":{"stable":"1"}}]}',
        "formula",
        "liftoff",
      ),
    ).toEqual({ fullName: "liftoff", tap: "", installed: [], offered: "1" });
    expect(msiProducts("nope")).toBeUndefined();
    expect(msiProducts('{"code":"x"}')).toBeUndefined();
    expect(msiProducts('[{"code":"x"}]')).toBeUndefined();
    expect(msiProducts("[]")).toEqual([]);
    expect(wingetNewestVersion("Gefunden x\nVersion\n-------\n1.2.0\n1.10.0\nnotes\n")).toBe(
      "1.10.0",
    );
    expect(wingetNewestVersion("Found x\nVersion: 1.2.0\n")).toBeUndefined();
  });

  it("compares paths as each platform does", () => {
    expect(samePath("win32", "C:\\Users\\R\\Liftoff\\", "c:\\users\\r\\liftoff")).toBe(true);
    expect(samePath("darwin", "/a/B", "/a/b")).toBe(false);
    expect(within("win32", "C:\\a", "D:\\a\\b")).toBe(false);
    expect(within("darwin", "/a", "/a/b/c")).toBe(true);
    expect(within("darwin", "/a", "/ab")).toBe(false);
  });

  it("looks for liftoff where each platform keeps it", () => {
    expect(
      commandCandidates("win32", "liftoff", {
        Path: 'C:\\a;;"C:\\b c";relative',
        PATHEXT: ".EXE;.CMD",
      }),
    ).toEqual([
      "C:\\a\\liftoff.exe",
      "C:\\a\\liftoff.cmd",
      "C:\\b c\\liftoff.exe",
      "C:\\b c\\liftoff.cmd",
    ]);
    expect(commandCandidates("darwin", "liftoff", { PATH: "/a:/b" })).toEqual([
      "/a/liftoff",
      "/b/liftoff",
    ]);
    expect(commandCandidates("win32", "liftoff", {})).toEqual([]);
  });
});
