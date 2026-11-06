// Builds the per-user Windows installer from a Windows bundle (DIST-006):
//
//   node scripts/package/build-msi.ts <bundle> [--version X.Y.Z] [--output <msi>] [--fail-for-test]
//
// The version is the bundle's own, from its release.json. Only the install
// checks use --version, to build another, and --fail-for-test, to build one
// that fails at the end of installing. The default output is
// out/liftoff-x86_64-pc-windows-msvc.msi. WiX is the version pinned in
// .config/dotnet-tools.json; building with it accepts its EULA, whose
// maintenance fee does not apply to a project with Liftoff's revenue.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MSI_NAME, msiVersion } from "./windows-installer.ts";

const root = path.resolve(import.meta.dirname, "../..");
const [bundleArgument, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
};
if (bundleArgument === undefined || process.platform !== "win32") {
  throw new Error(
    "usage, on Windows: node scripts/package/build-msi.ts <bundle> [--version X.Y.Z] [--output <msi>]",
  );
}
const bundle = path.resolve(bundleArgument);
const identity = JSON.parse(readFileSync(path.join(bundle, "release.json"), "utf8")) as {
  version: string;
  target: string;
};
if (identity.target !== "x86_64-pc-windows-msvc") {
  throw new Error(`${bundle} is a ${identity.target} bundle, not x86_64-pc-windows-msvc`);
}
const version = msiVersion(option("--version") ?? identity.version);
const output = path.resolve(option("--output") ?? path.join(root, "out", MSI_NAME));
mkdirSync(path.dirname(output), { recursive: true });

const run = (args: string[]) => execFileSync("dotnet", args, { cwd: root, stdio: "inherit" });
run(["tool", "restore"]);
run([
  "tool",
  "run",
  "wix",
  "build",
  path.join(root, "distribution", "windows", "liftoff.wxs"),
  "-arch",
  "x64",
  "-acceptEula",
  "wix7",
  "-d",
  `Version=${version}`,
  "-d",
  `BundleDir=${bundle}`,
  ...(rest.includes("--fail-for-test") ? ["-d", "FailForTest=1"] : []),
  "-pdbtype",
  "none",
  "-out",
  output,
]);
console.log(`built ${path.relative(root, output)} (MSI version ${version})`);
