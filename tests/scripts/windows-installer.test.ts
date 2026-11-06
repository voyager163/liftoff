import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  MSI_NAME,
  msiVersion,
  pathEntries,
  registryValue,
  UPGRADE_CODE,
} from "../../scripts/package/windows-installer.ts";
import { releaseAssets } from "../../scripts/release/release-rules.ts";

const repository = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(repository, file), "utf8");
const wxs = read("distribution/windows/liftoff.wxs");
/** The attributes of the one element `name` in the WiX source. */
const element = (name: string): Record<string, string> => {
  const found = [...wxs.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, "g"))];
  expect(found, `one <${name}>`).toHaveLength(1);
  return Object.fromEntries(
    [...(found[0]?.[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
};

interface Step {
  name?: string;
  if?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
}
const steps = (file: string, job: string): Step[] =>
  (parse(read(file)) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]?.steps ?? [];

describe("DIST-006 Windows users install Liftoff with an MSI, for themselves", () => {
  it("installs for the current user under their Programs folder, and refuses the machine", () => {
    const pkg = element("Package");
    // Dual-purpose, per-user by default: ProgramFiles64Folder is then the
    // user's %LOCALAPPDATA%\Programs.
    expect(pkg.Scope).toBe("perUserOrMachine");
    expect(element("StandardDirectory").Id).toBe("ProgramFiles64Folder");
    expect(element("Launch").Condition).toBe("Installed OR NOT (ALLUSERS = 1)");
    expect(element("Files").Include).toBe("$(var.BundleDir)\\**");
  });

  it("replaces any installed build, of the same version or older, and refuses a downgrade", () => {
    expect(`{${element("Package").UpgradeCode}}`).toBe(UPGRADE_CODE);
    expect(element("Package").ProductCode).toBeUndefined();
    const upgrade = element("MajorUpgrade");
    // Inside the transaction, so a failed upgrade restores the old product.
    expect(upgrade.Schedule).toBe("afterInstallInitialize");
    expect(upgrade.AllowSameVersionUpgrades).toBe("yes");
    expect(upgrade.AllowDowngrades).toBeUndefined();
    expect(upgrade.DowngradeErrorMessage).toBeTruthy();
  });

  it("adds bin to the user's PATH, never the system's, and records where it is", () => {
    const environment = element("Environment");
    expect(environment).toMatchObject({
      Name: "PATH",
      Value: "[INSTALLFOLDER]bin",
      Part: "last",
      System: "no",
      Permanent: "no",
    });
    expect(element("RegistryValue").Root).toBe("HKMU");
    expect(element("SetProperty")).toMatchObject({
      Id: "ARPINSTALLLOCATION",
      Value: "[INSTALLFOLDER]",
    });
  });

  it("fails on purpose only in the MSI the install check builds", () => {
    const block = /<\?ifdef FailForTest \?>[\s\S]*?<\?endif\?>/g;
    const guarded = (wxs.match(block) ?? []).join("\n");
    expect(guarded).toContain('<CustomAction Id="FailForTest"');
    // It fails only after the queued changes have been made.
    expect(guarded).toContain('<InstallExecute Before="FailForTest" />');
    expect(guarded).toContain('Name="failed-upgrade-marker.json"');
    expect(guarded).toContain('<ComponentRef Id="FailForTestMarker" />');
    // Nothing of it outside those blocks, so a release MSI has none of it.
    expect(wxs.replace(block, "")).not.toContain("FailForTest");
    expect(read(".github/workflows/release.yml")).not.toContain("--fail-for-test");
  });

  it("builds with an exactly pinned WiX", () => {
    const tools = JSON.parse(read(".config/dotnet-tools.json")) as {
      tools: Record<string, { version: string; rollForward: boolean }>;
    };
    expect(tools.tools.wix?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tools.tools.wix?.rollForward).toBe(false);
    expect(read("scripts/package/build-msi.ts")).toContain('"-acceptEula",\n  "wix7"');
  });

  it("gives the MSI the release's X.Y.Z, which Windows Installer can hold", () => {
    expect(msiVersion("0.1.0")).toBe("0.1.0");
    expect(msiVersion("0.1.0-rc.1")).toBe("0.1.0");
    expect(msiVersion("255.255.65535")).toBe("255.255.65535");
    expect(() => msiVersion("256.0.0")).toThrow("beyond the MSI version limit");
    expect(() => msiVersion("1.0.65536")).toThrow("beyond the MSI version limit");
    expect(() => msiVersion("1.0")).toThrow("not an X.Y.Z version");
    expect(() => msiVersion("01.0.0")).toThrow("not an X.Y.Z version");
  });

  it("reads the user's PATH as reg query prints it", () => {
    const output = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;;C:\\Users\\runner\\AppData\\Local\\Programs\\Liftoff\\bin",
      "    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp",
      "",
    ].join("\r\n");
    const value = registryValue(output, "PATH");
    expect(value).toBe(
      "%USERPROFILE%\\bin;;C:\\Users\\runner\\AppData\\Local\\Programs\\Liftoff\\bin",
    );
    expect(registryValue(output, "Missing")).toBeNull();
    expect(pathEntries(value ?? "", { UserProfile: "C:\\Users\\runner" })).toEqual([
      "C:\\Users\\runner\\bin",
      "C:\\Users\\runner\\AppData\\Local\\Programs\\Liftoff\\bin",
    ]);
    expect(pathEntries("%UNSET%\\bin", {})).toEqual(["%UNSET%\\bin"]);
  });

  it("is checked on Windows CI through install, upgrade, downgrade, per-machine and uninstall", () => {
    const check = steps(".github/workflows/ci.yml", "package").find((step) =>
      step.run?.includes("scripts/package/check-msi.ts"),
    );
    expect(check?.if).toBe("runner.os == 'Windows'");
    const script = read("scripts/package/check-msi.ts");
    for (const step of [
      'msiexec(["/i", current, "ALLUSERS=1"], 1603)',
      'msiexec(["/i", rebuilt], 0)',
      'msiexec(["/i", newer], 0)',
      'msiexec(["/i", failing], 1603)',
      'msiexec(["/i", current], 1603)',
      'msiexec(["/x", newer], 0)',
    ]) {
      expect(script).toContain(step);
    }
  });

  it("ships in every release, attested, and is installed from the draft", () => {
    expect(releaseAssets("0.1.0")).toContain(MSI_NAME);
    const bundle = steps(".github/workflows/release.yml", "bundle");
    const names = bundle.map((step) => step.name ?? "");
    const built = names.indexOf("Build the Windows installer");
    expect(built).toBeGreaterThan(names.indexOf("Build the bundle from the package"));
    expect(bundle[built]?.if).toBe("runner.os == 'Windows'");
    const draft = steps(".github/workflows/release.yml", "draft");
    const sbom = draft.find((step) => step.name === "Attest what the bundles contain");
    expect(String(sbom?.with?.["subject-path"])).toContain(`assets/${MSI_NAME}`);
    const install = steps(".github/workflows/release.yml", "verify").find(
      (step) => step.name === "Install Liftoff from the installer and run it",
    );
    expect(install?.if).toBe("runner.os == 'Windows'");
    expect(install?.run).toContain("'/x'");
    for (const workflow of [".github/workflows/release.yml", ".github/workflows/promote.yml"]) {
      expect(read(workflow)).toContain("liftoff-package-* liftoff-*.msi; do");
    }
  });
});
