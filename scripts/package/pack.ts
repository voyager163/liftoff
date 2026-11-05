// Builds Liftoff's npm package, the one artifact every channel installs:
//
//   node scripts/package/pack.ts [--dry-run] [--root <repository>]
//
// It packs a staging copy of the package and writes
// out/<name>-<version>.tgz. npm 12 never ships a lockfile in a package (not
// even npm-shrinkwrap.json), so npm installs get Liftoff's exact direct
// dependencies but resolve their dependencies afresh; the native bundle
// installs from package-lock.json. npm leaves some
// files out of every package (.gitignore, .npmrc and others), so the packed
// file list is checked against what Git tracks under the shipped directories,
// and against dist/: a file npm drops fails the build rather than going
// missing from installs. --dry-run skips building and writing the tarball
// and checks only the tracked files; --root packs another checkout (tests).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1
    ? path.resolve(import.meta.dirname, "../..")
    : path.resolve(process.argv[rootFlag + 1] ?? "");
const dryRun = process.argv.includes("--dry-run");
const isWindows = process.platform === "win32";
const out = path.join(root, "out");
const stage = path.join(out, ".pack-work");
const SHIPPED = ["dist", "assets", ".github/liftoff"];
const ALWAYS = ["package.json", "LICENSE", "README.md"];

const npm = (args: string[], cwd: string) =>
  execFileSync("npm", args, { cwd, encoding: "utf8", shell: isWindows });

const filesUnder = (directory: string): string[] =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    );

if (!dryRun)
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: isWindows });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ["package.json", "LICENSE", "README.md", ...SHIPPED]) {
  if (dryRun && entry === "dist") continue;
  cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}

mkdirSync(out, { recursive: true });
const report = JSON.parse(
  npm(
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      out,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    stage,
  ),
) as { filename: string; files: { path: string }[] }[];
const [packed] = report;
if (packed === undefined) throw new Error("npm pack reported no package");
const inPackage = new Set(packed.files.map((file) => file.path));

const tracked = execFileSync("git", ["ls-files", "-z", "--", "assets", ".github/liftoff"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const expected = [...ALWAYS, ...tracked, ...(dryRun ? [] : filesUnder("dist"))];
const missing = expected.filter((file) => !inPackage.has(file));
const extra = [...inPackage].filter(
  (file) => !ALWAYS.includes(file) && !SHIPPED.some((top) => file.startsWith(`${top}/`)),
);
rmSync(stage, { recursive: true, force: true });
if (missing.length > 0 || extra.length > 0) {
  for (const file of missing) console.error(`left out of the package: ${file}`);
  for (const file of extra) console.error(`not meant to be in the package: ${file}`);
  if (!dryRun) rmSync(path.join(out, packed.filename), { force: true });
  process.exit(1);
}
const version = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
).version;
console.log(
  dryRun
    ? `${inPackage.size} files would be packed for version ${version}`
    : `packed ${path.relative(root, path.join(out, packed.filename))} (${inPackage.size} files)`,
);
