// Builds Liftoff's npm package, the one artifact every channel installs:
//
//   node scripts/package/pack.ts [--dry-run] [--root <repository>]
//
// The package is made from the commit, never the working tree: git archive
// extracts the commit's sources, assets and build configuration into a
// stage, and dist/ is compiled there. So nothing untracked, ignored or
// uncommitted (a .env or .venv in a template, a local .ts file) can reach it,
// and package.json's gitHead records the commit it is. It writes
// out/<name>-<version>.tgz.
//
// npm leaves some files out of every package (.gitignore, .npmrc and
// others), so the packed list must be exactly what Git tracks under the
// shipped directories, the compiled files and package.json, LICENSE and
// README.md: a file npm drops, or one that should not be there, fails it.
//
// npm 12 never ships a lockfile in a package (not even npm-shrinkwrap.json),
// so npm installs get Liftoff's exact direct dependencies but resolve their
// dependencies afresh; the native bundle installs from the commit's
// package-lock.json.
//
// --dry-run skips compiling and writing the tarball and checks only the
// tracked files; --root packs another checkout (tests).
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { npm } from "./npm.ts";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1
    ? path.resolve(import.meta.dirname, "../..")
    : path.resolve(process.argv[rootFlag + 1] ?? "");
const dryRun = process.argv.includes("--dry-run");
const out = path.join(root, "out");
const SHIPPED = ["assets", ".github/liftoff"];
const ALWAYS = ["package.json", "LICENSE", "README.md"];
// What the build reads, besides package.json.
const BUILD = ["src", "tsconfig.json", "tsconfig.build.json"];
const TSC = path.resolve(import.meta.dirname, "../../node_modules/typescript/bin/tsc");

// Files as committed, whatever the host's line-ending settings.
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });

// Every later read names this commit, never HEAD, which can move meanwhile.
const commit = git("rev-parse", "--verify", "HEAD^{commit}").trim();
const tracked = git("ls-tree", "-r", "-z", "--name-only", commit, "--", ...SHIPPED)
  .split("\0")
  .filter(Boolean);

// A stage of its own, under out/ so the compiler finds this repository's
// type packages, so packs running at once never share or remove each
// other's files. The tarball is written there too and moved into out/ only
// once checked.
mkdirSync(out, { recursive: true });
const stage = mkdtempSync(path.join(out, ".pack-"));
try {
  // Extracted from inside the stage by bare name: Git for Windows' tar would
  // take a drive letter for a remote host.
  git(
    "archive",
    "--format=tar",
    "-o",
    path.join(stage, "source.tar"),
    commit,
    "--",
    ...ALWAYS,
    ...SHIPPED,
    ...(dryRun ? [] : BUILD),
  );
  execFileSync("tar", ["-xf", "source.tar"], { cwd: stage });
  rmSync(path.join(stage, "source.tar"));
  // Compiled in the stage, from the commit's sources only, with this
  // repository's TypeScript.
  if (!dryRun) {
    execFileSync(process.execPath, [TSC, "-p", path.join(stage, "tsconfig.build.json")], {
      cwd: stage,
      stdio: "inherit",
    });
  }
  const built = dryRun
    ? []
    : readdirSync(path.join(stage, "dist"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(stage, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
        );
  const manifest = JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8")) as {
    version: string;
  };
  writeFileSync(
    path.join(stage, "package.json"),
    `${JSON.stringify({ ...manifest, gitHead: commit }, null, 2)}\n`,
  );

  const report = JSON.parse(
    npm(
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        stage,
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
  if (missing.length > 0 || extra.length > 0) {
    for (const file of missing) console.error(`left out of the package: ${file}`);
    for (const file of extra) console.error(`not meant to be in the package: ${file}`);
    process.exitCode = 1;
  } else {
    if (!dryRun) renameSync(path.join(stage, packed.filename), path.join(out, packed.filename));
    console.log(
      dryRun
        ? `${inPackage.size} files would be packed for version ${manifest.version}`
        : `packed ${path.relative(root, path.join(out, packed.filename))} (${inPackage.size} files)`,
    );
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
