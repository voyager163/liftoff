// Checks the Windows installer as a user meets it (DIST-006), on a Windows
// runner, as the runner's own user:
//
//   node scripts/package/check-msi.ts <bundle>
//
// It builds four MSIs from the bundle: two of its own version (as two
// prereleases of one version would be), one newer, and one built to fail at
// the end of installing. It installs, upgrades, rolls a failed upgrade back,
// refuses a downgrade and a per-machine install, and uninstalls, checking
// after each step where Liftoff is, what Windows Installer records, the
// user's PATH, and that Liftoff runs from it. After uninstalling, nothing of
// it is left. It changes the runner user's PATH and installed programs, so
// it runs only on a CI runner.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathEntries, registryValue, UPGRADE_CODE } from "./windows-installer.ts";

const root = path.resolve(import.meta.dirname, "../..");
const bundleArgument = process.argv[2];
if (bundleArgument === undefined || process.platform !== "win32" || process.env.CI !== "true") {
  throw new Error("usage, on a Windows CI runner: node scripts/package/check-msi.ts <bundle>");
}
const bundle = path.resolve(bundleArgument);
const { version } = JSON.parse(readFileSync(path.join(bundle, "release.json"), "utf8")) as {
  version: string;
};
const localAppData = process.env.LOCALAPPDATA ?? "";
const installed = path.join(localAppData, "Programs", "Liftoff");
const perMachine = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Liftoff");
const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? root, "liftoff-msi-"));

const fail = (message: string): never => {
  throw new Error(message);
};
const build = (name: string, msiVersion?: string, ...flags: string[]): string => {
  const output = path.join(work, name);
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "package", "build-msi.ts"),
      bundle,
      "--output",
      output,
      ...(msiVersion === undefined ? [] : ["--version", msiVersion]),
      ...flags,
    ],
    { stdio: "inherit" },
  );
  return output;
};
let logs = 0;
/** Runs msiexec quietly and returns its exit code, printing its log when it is not expected. */
const msiexec = (args: string[], expected: number): void => {
  const log = path.join(work, `msiexec-${++logs}.log`);
  const result = spawnSync("msiexec", [...args, "/qn", "/norestart", "/l*v", log], {
    stdio: "inherit",
  });
  if (result.status !== expected) {
    if (existsSync(log)) {
      // Windows Installer writes its log as UTF-16 or as ANSI.
      const bytes = readFileSync(log);
      const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("latin1");
      console.log(text.split("\n").slice(-60).join("\n"));
    }
    fail(`msiexec ${args.join(" ")} exited ${result.status}, not ${expected}`);
  }
};

interface Product {
  code: string;
  version: string;
  location: string;
  /** 0 when installed for the user, 1 for the machine. */
  assignment: string;
}
/** Every product Windows Installer has with Liftoff's UpgradeCode, for this user or the machine. */
const products = (): Product[] => {
  const script = [
    "$installer = New-Object -ComObject WindowsInstaller.Installer",
    `$codes = @($installer.RelatedProducts('${UPGRADE_CODE}'))`,
    // -InputObject keeps an array of none or one an array; -AsArray would
    // wrap it in another.
    "ConvertTo-Json -InputObject @($codes | ForEach-Object { [pscustomobject]@{",
    "  code = $_",
    "  version = $installer.ProductInfo($_, 'VersionString')",
    "  location = $installer.ProductInfo($_, 'InstallLocation')",
    "  assignment = $installer.ProductInfo($_, 'AssignmentType')",
    "} })",
  ].join("\n");
  const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const parsed: unknown = JSON.parse(output);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof (entry as Partial<Product> | null)?.code === "string")
  ) {
    fail(`Windows Installer's products are not a list of products: ${output}`);
  }
  return parsed as Product[];
};
const userPath = (): string[] => {
  const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], {
    encoding: "utf8",
  });
  const value = result.status === 0 ? registryValue(result.stdout, "Path") : null;
  return value === null ? [] : pathEntries(value, process.env);
};
const bin = path.join(installed, "bin");
const same = (left: string, right: string) =>
  path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();

/** Liftoff is installed once, for this user, at that version, and runs from the user's PATH. */
const expectInstalled = (msiVersion: string) => {
  const found = products();
  if (found.length !== 1) fail(`expected one Liftoff product, found ${JSON.stringify(found)}`);
  const [product] = found as [Product];
  if (product.version !== msiVersion) fail(`installed ${product.version}, not ${msiVersion}`);
  if (product.assignment !== "0")
    fail(`installed for the machine, not the user: ${product.assignment}`);
  if (!same(product.location, installed))
    fail(`InstallLocation is ${product.location}, not ${installed}`);
  if (!existsSync(path.join(installed, "lib", "app", ".github", "liftoff", "review-policy.mjs"))) {
    fail("the installed bundle lacks lib/app/.github/liftoff, so dotfiles were left out");
  }
  const entries = userPath();
  if (entries.filter((entry) => same(entry, bin)).length !== 1) {
    fail(`the user's PATH should hold ${bin} once: ${entries.join(";")}`);
  }
  // As a new terminal would find it: the user's PATH, then Windows' own.
  const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env = { ...process.env, PATH: [...entries, system32].join(";") };
  const where =
    execFileSync("where.exe", ["liftoff"], { encoding: "utf8", env }).split(/\r?\n/)[0] ?? "";
  if (!same(where, path.join(bin, "liftoff.exe"))) fail(`liftoff resolves to ${where}`);
  const smoke = mkdtempSync(path.join(work, "smoke-"));
  const liftoff = (...args: string[]) =>
    execFileSync(where, args, { cwd: smoke, encoding: "utf8", env });
  if (liftoff("--version").trim() !== version) fail(`liftoff --version is not ${version}`);
  liftoff("init", "--name", "smoke", "--workflow", "manual", "--agents", "claude", "--yes");
  liftoff("validate", "--dir", "smoke");
};
const expectNothingLeft = () => {
  if (products().length !== 0) fail(`Liftoff is still installed: ${JSON.stringify(products())}`);
  if (existsSync(installed)) fail(`${installed} is still there`);
  if (existsSync(perMachine)) fail(`${perMachine} exists`);
  if (userPath().some((entry) => same(entry, bin))) fail(`the user's PATH still has ${bin}`);
  const key = spawnSync("reg", ["query", "HKCU\\Software\\voyager163\\Liftoff"], {
    stdio: "ignore",
  });
  if (key.status === 0) fail("HKCU\\Software\\voyager163\\Liftoff is still there");
};

const current = build("current.msi");
const rebuilt = build("rebuilt.msi");
const newer = build("newer.msi", "255.0.0");
const failing = build("failing.msi", "255.0.0", "--fail-for-test");
const ownVersion = /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? fail(`${version} has no X.Y.Z`);

expectNothingLeft();
console.log("A per-machine install is refused");
msiexec(["/i", current, "ALLUSERS=1"], 1603);
expectNothingLeft();

console.log(`Install ${ownVersion} for the user`);
msiexec(["/i", current], 0);
expectInstalled(ownVersion);

console.log("Another build of the same version replaces it");
msiexec(["/i", rebuilt], 0);
expectInstalled(ownVersion);

console.log("A newer version upgrades it in place");
msiexec(["/i", newer], 0);
expectInstalled("255.0.0");

console.log("A failed upgrade rolls back to what was installed");
msiexec(["/i", failing], 1603);
expectInstalled("255.0.0");

console.log("An older version is refused");
msiexec(["/i", current], 1603);
expectInstalled("255.0.0");

console.log("Uninstall leaves nothing behind");
msiexec(["/x", newer], 0);
expectNothingLeft();
console.log("the MSI installs, upgrades and uninstalls for the current user");
