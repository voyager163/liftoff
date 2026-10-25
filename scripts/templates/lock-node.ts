// Regenerates the canonical package-lock.json for the Node.js Fastify template.
//
// Versions are chosen with a cooldown: npm resolves every dependency, direct
// and transitive, to versions published at least 7 days ago (or before
// --cutoff YYYY-MM-DD). Security fixes are the exception: npm then moves any
// package with a known advisory to a fixed version its dependents already
// accept, however new. Fixes that need an incompatible version are left to
// an override in package.json. Nothing is installed and no install scripts
// run.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const backend = path.join(root, "assets/plugins/stack-node-fastify/files/backend");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const work = mkdtempSync(path.join(tmpdir(), "liftoff-lock-"));
try {
  const manifest = readFileSync(path.join(backend, "package.json"), "utf8").replaceAll(
    "{{liftoff.name}}",
    "project",
  );
  writeFileSync(path.join(work, "package.json"), manifest);
  const cutoff =
    argument("--cutoff") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const npm = (...args: string[]) =>
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: work,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
  const quiet = ["--package-lock-only", "--ignore-scripts", "--no-fund"];
  npm("install", ...quiet, "--no-audit", "--before", cutoff);
  npm("audit", "fix", ...quiet);
  copyFileSync(path.join(work, "package-lock.json"), path.join(backend, "package-lock.json"));
  console.log(
    `wrote package-lock.json with versions published before ${cutoff}, plus security fixes`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
