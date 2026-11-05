// Builds Liftoff's npm package, the one artifact every channel installs:
//
//   node scripts/package/pack.ts [--dry-run] [--root <repository>]
//
// The package is staged from the committed tree (git archive), not the
// working tree, so nothing untracked or ignored, such as a .env or .venv left
// in a template, can reach it, and package.json's gitHead records the commit.
// dist/ is built from the same commit: packing refuses a checkout with
// uncommitted changes to tracked files. It writes out/<name>-<version>.tgz.
//
// npm leaves some files out of every package (.gitignore, .npmrc and
// others), so the packed list must be exactly what Git tracks under the
// shipped directories, the built files and package.json, LICENSE and
// README.md: a file npm drops, or one that should not be there, fails it.
//
// npm 12 never ships a lockfile in a package (not even npm-shrinkwrap.json),
// so npm installs get Liftoff's exact direct dependencies but resolve their
// dependencies afresh; the native bundle installs from package-lock.json.
//
// --dry-run skips building and writing the tarball, checks only the tracked
// files and allows uncommitted changes; --root packs another checkout (tests).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { npm } from "./npm.ts";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1
    ? path.resolve(import.meta.dirname, "../..")
    : path.resolve(process.argv[rootFlag + 1] ?? "");
const dryRun = process.argv.includes("--dry-run");
const out = path.join(root, "out");
const stage = path.join(out, ".pack-work");
const SHIPPED = ["assets", ".github/liftoff"];
const ALWAYS = ["package.json", "LICENSE", "README.md"];

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

if (!dryRun && git("status", "--porcelain", "--untracked-files=no").trim() !== "") {
  console.error("refusing to pack: commit or discard the changes to tracked files first");
  process.exit(1);
}
const commit = git("rev-parse", "HEAD").trim();
const tracked = git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...SHIPPED)
  .split("\0")
  .filter(Boolean);

if (!dryRun) npm(["run", "build"], root, "inherit");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// Extracted from inside the stage by bare name: Git for Windows' tar would
// take a drive letter for a remote host.
git(
  "archive",
  "--format=tar",
  "-o",
  path.join(stage, "source.tar"),
  "HEAD",
  "--",
  ...ALWAYS,
  ...SHIPPED,
);
execFileSync("tar", ["-xf", "source.tar"], { cwd: stage });
rmSync(path.join(stage, "source.tar"));
const built = dryRun
  ? []
  : readdirSync(path.join(root, "dist"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
      );
if (!dryRun) cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8")) as {
  version: string;
};
writeFileSync(
  path.join(stage, "package.json"),
  `${JSON.stringify({ ...manifest, gitHead: commit }, null, 2)}\n`,
);

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
const expected = new Set([...ALWAYS, ...tracked, ...built]);
const missing = [...expected].filter((file) => !inPackage.has(file));
const extra = [...inPackage].filter((file) => !expected.has(file));
rmSync(stage, { recursive: true, force: true });
if (missing.length > 0 || extra.length > 0) {
  for (const file of missing) console.error(`left out of the package: ${file}`);
  for (const file of extra) console.error(`not meant to be in the package: ${file}`);
  if (!dryRun) rmSync(path.join(out, packed.filename), { force: true });
  process.exit(1);
}
console.log(
  dryRun
    ? `${inPackage.size} files would be packed for version ${manifest.version}`
    : `packed ${path.relative(root, path.join(out, packed.filename))} (${inPackage.size} files)`,
);
