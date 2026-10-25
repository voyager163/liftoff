// Regenerates the canonical uv.lock files for the Python templates: the
// FastAPI API and the PydanticAI GenAI API.
//
// Versions are chosen with a cooldown: nothing published in the last 7 days
// (or after --cutoff YYYY-MM-DD). The lock is then re-resolved without the
// cutoff, keeping the same versions, so generated projects can update their
// dependencies normally. With --check, verifies the committed lock matches
// pyproject.toml instead of writing them.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const templates = [
  "assets/plugins/stack-python-fastapi/files/backend",
  "assets/plugins/stack-python-pydanticai/files/backend",
].map((directory) => path.join(root, directory));
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cutoff =
  argument("--cutoff") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

for (const backend of templates) {
  const name = path.relative(root, backend);
  const work = mkdtempSync(path.join(tmpdir(), "liftoff-lock-"));
  try {
    for (const file of ["pyproject.toml", ".python-version"]) {
      const text = readFileSync(path.join(backend, file), "utf8").replaceAll(
        "{{liftoff.name}}",
        "project",
      );
      writeFileSync(path.join(work, file), text);
    }
    const uv = (...args: string[]) =>
      execFileSync("uv", args, { cwd: work, stdio: ["ignore", "inherit", "inherit"] });

    if (process.argv.includes("--check")) {
      copyFileSync(path.join(backend, "uv.lock"), path.join(work, "uv.lock"));
      uv("lock", "--check");
      console.log(`${name}/uv.lock matches pyproject.toml`);
    } else {
      uv("lock", "--exclude-newer", `${cutoff}T00:00:00Z`);
      uv("lock");
      copyFileSync(path.join(work, "uv.lock"), path.join(backend, "uv.lock"));
      console.log(`wrote ${name}/uv.lock with versions published before ${cutoff}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
