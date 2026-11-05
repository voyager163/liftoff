// Builds the runtime-inclusive Liftoff bundle for the platform this runs on:
//
//   liftoff-package-<arch>-<os>/
//     bin/liftoff[.exe]   Node single executable that only starts lib/app
//     lib/app/            the npm package from scripts/package/pack.ts, with
//                         its production node_modules from package-lock.json
//     share/licenses/     Liftoff's and Node's licenses
//     release.json        version, platform, Node version, source commit and
//                         tree, and the signing identities (null when unsigned)
//
// The launcher carries no application code (Node single executables are
// still experimental), so native and npm installs run the same files.
// Unsigned: signing and notarization belong to the release workflow.
//
// It packs the npm package first, or takes one built earlier with
// --package <path>, so a release builds the package once and every channel
// ships the same files.
//
// The runtime is the Node that runs this script, or --node <path>. It must be
// an official nodejs.org build: some distributions (Homebrew's, for one) are
// built without single-executable support.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { npm } from "./npm.ts";
import { releaseIdentity } from "./release-identity.ts";

const root = path.resolve(import.meta.dirname, "../..");
const isWindows = process.platform === "win32";
const target = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}-${
  process.platform === "darwin" ? "apple-darwin" : isWindows ? "pc-windows-msvc" : process.platform
}`;
const name = `liftoff-package-${target}`;
const out = path.join(root, "out", name);
const app = path.join(out, "lib", "app");
const work = path.join(root, "out", `.${name}-work`);
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : path.resolve(process.argv[at + 1] ?? "");
};
const runtime = flag("--node") ?? process.execPath;

const run = (command: string, args: string[], cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
mkdirSync(work, { recursive: true });

const source = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const { version } = source;
let tarball = flag("--package");
if (tarball === undefined) {
  run(process.execPath, [path.join(root, "scripts", "package", "pack.ts")]);
  tarball = path.join(root, "out", `voyager163-liftoff-${version}.tgz`);
}
// Extracted from inside the work directory by its bare name: Git for
// Windows' tar would take a drive letter for a remote host.
cpSync(tarball, path.join(work, "package.tgz"));
run("tar", ["-xzf", "package.tgz"], work);
cpSync(path.join(work, "package"), app, { recursive: true });
// The bundle records this checkout's commit and installs from its lockfile,
// so the package must have been packed from the same commit.
const shipped = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as {
  name: string;
  version: string;
  gitHead?: string;
};
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (shipped.name !== source.name || shipped.version !== version || shipped.gitHead !== head) {
  throw new Error(
    `${tarball} is ${shipped.name}@${shipped.version} from ${shipped.gitHead ?? "an unknown commit"}, not ${source.name}@${version} from ${head}`,
  );
}
// The package carries no lockfile, so the bundle installs from Liftoff's.
for (const entry of ["package-lock.json", ".npmrc"]) {
  cpSync(path.join(root, entry), path.join(app, entry));
}
npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app, "inherit");
rmSync(path.join(app, ".npmrc"));

// The launcher resolves its real location (Homebrew links bin/liftoff from
// elsewhere) and loads the CLI from lib/app next to it.
writeFileSync(
  path.join(work, "launcher.cjs"),
  [
    '"use strict";',
    'const { realpathSync } = require("node:fs");',
    'const { createRequire } = require("node:module");',
    'const path = require("node:path");',
    'const app = path.join(path.dirname(realpathSync(process.execPath)), "..", "lib", "app");',
    'createRequire(path.join(app, "package.json"))("./dist/cli/main.js");',
    "",
  ].join("\n"),
);
const executable = path.join(out, "bin", isWindows ? "liftoff.exe" : "liftoff");
mkdirSync(path.dirname(executable), { recursive: true });
writeFileSync(
  path.join(work, "sea-config.json"),
  JSON.stringify({
    main: path.join(work, "launcher.cjs"),
    output: executable,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
run(runtime, ["--build-sea", path.join(work, "sea-config.json")]);
const nodeVersion = execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim();
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", executable]);

mkdirSync(path.join(out, "share", "licenses"), { recursive: true });
cpSync(path.join(root, "LICENSE"), path.join(out, "share", "licenses", "liftoff-LICENSE"));
// Official archives keep LICENSE beside bin/ (macOS) or beside node.exe (Windows).
const licenseCandidates = [
  path.join(path.dirname(runtime), "..", "LICENSE"),
  path.join(path.dirname(runtime), "LICENSE"),
];
const nodeLicense = licenseCandidates.find((candidate) => {
  try {
    return readFileSync(candidate, "utf8").includes("Node.js is licensed");
  } catch {
    return false;
  }
});
if (!nodeLicense) throw new Error(`cannot find the Node.js LICENSE next to ${runtime}`);
cpSync(nodeLicense, path.join(out, "share", "licenses", "node-LICENSE"));

writeFileSync(
  path.join(out, "release.json"),
  `${JSON.stringify(releaseIdentity(root, { version, target, node: nodeVersion }), null, 2)}\n`,
);
rmSync(work, { recursive: true, force: true });
console.log(`built ${path.relative(root, out)}`);
