// Shows that the macOS executable needs every entitlement it is signed with,
// and nothing else (DIST-005):
//
//   node scripts/package/check-entitlements.ts <bundle directory>
//
// It signs the bundle's executable ad hoc with the hardened runtime, as a
// release signs it, once without each entitlement in
// distribution/macos/entitlements.plist, and checks Liftoff then fails to
// start. Signed last with them all, it must run, and it is left that way
// for the rest of CI to use.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { entitlementKeys, entitlementsPlist, machOFiles } from "./macos-signing.ts";

const root = path.resolve(import.meta.dirname, "../..");
const bundle = path.resolve(process.argv[2] ?? "");
const granted = entitlementKeys(
  readFileSync(path.join(root, "distribution", "macos", "entitlements.plist"), "utf8"),
);
const executables = machOFiles(bundle).filter(({ kind }) => kind === "executable");
if (executables.length !== 1 || executables[0] === undefined) {
  throw new Error(`${bundle} must hold one Mach-O executable, not ${executables.length}`);
}
const executable = executables[0].file;
const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "liftoff-entitlements-"));

const signWith = (keys: readonly string[]) => {
  const plist = path.join(work, "entitlements.plist");
  writeFileSync(plist, entitlementsPlist(keys));
  execFileSync("codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    plist,
    executable,
  ]);
};
const starts = () =>
  spawnSync(executable, ["--version"], { cwd: work, encoding: "utf8", timeout: 60_000 });

const unneeded: string[] = [];
try {
  for (const key of granted) {
    signWith(granted.filter((other) => other !== key));
    const result = starts();
    if (result.status === 0) unneeded.push(key);
    else console.log(`without ${key}, Liftoff does not start (exit ${result.status})`);
  }
  signWith(granted);
  const result = starts();
  if (result.status !== 0) {
    throw new Error(`signed with ${granted.join(", ")}, Liftoff does not start:\n${result.stderr}`);
  }
  console.log(`with ${granted.join(", ")}, Liftoff ${result.stdout.trim()} starts`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (unneeded.length > 0) {
  console.error(
    `::error::Liftoff starts without ${unneeded.join(", ")}; remove it from entitlements.plist`,
  );
  process.exit(1);
}
