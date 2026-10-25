// Regenerates the canonical package-lock.json files for the Node.js templates:
// the Fastify API and the Vue frontend.
//
// Versions are chosen with a cooldown: npm resolves every dependency, direct
// and transitive, to versions published at least 7 days ago (or before
// --cutoff YYYY-MM-DD). Security fixes are the exception: npm then moves any
// package with a known advisory to a fixed version its dependents already
// accept, however new. Fixes that need an incompatible version are left to
// an override in package.json. Nothing is installed and no install scripts
// run.
//
// npm 12 refuses to fetch packages by URL unless --allow-remote says so, and
// it fetches packages that bundle their dependencies, such as Tailwind's
// WebAssembly build, by their registry URL to read them. So remote fetches
// are allowed here, and every package in the result must come from the npm
// registry.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const REGISTRY = "https://registry.npmjs.org/";
const templates = [
  "assets/plugins/stack-node-fastify/files/backend",
  "assets/plugins/frontend-vue/files/frontend",
].map((directory) => path.join(root, directory));
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cutoff =
  argument("--cutoff") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

for (const template of templates) {
  const work = mkdtempSync(path.join(tmpdir(), "liftoff-lock-"));
  try {
    const manifest = readFileSync(path.join(template, "package.json"), "utf8").replaceAll(
      "{{liftoff.name}}",
      "project",
    );
    writeFileSync(path.join(work, "package.json"), manifest);
    const npm = (...args: string[]) =>
      execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd: work,
        stdio: ["ignore", "inherit", "inherit"],
        shell: process.platform === "win32",
      });
    const quiet = ["--package-lock-only", "--ignore-scripts", "--no-fund", "--allow-remote=all"];
    npm("install", ...quiet, "--no-audit", "--before", cutoff);
    npm("audit", "fix", ...quiet);
    const lock = JSON.parse(readFileSync(path.join(work, "package-lock.json"), "utf8")) as {
      packages: Record<string, { resolved?: string; link?: boolean; inBundle?: boolean }>;
    };
    for (const [name, entry] of Object.entries(lock.packages)) {
      // Bundled packages come inside their parent's tarball.
      if (name === "" || entry.link || entry.inBundle) continue;
      if (!entry.resolved?.startsWith(REGISTRY)) {
        throw new Error(`${name} does not come from ${REGISTRY}: ${entry.resolved}`);
      }
    }
    copyFileSync(path.join(work, "package-lock.json"), path.join(template, "package-lock.json"));
    console.log(
      `wrote ${path.relative(root, template)}/package-lock.json with versions published before ${cutoff}, plus security fixes`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
