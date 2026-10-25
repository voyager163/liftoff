// Renders Liftoff's canonical review skills and agents into this repository,
// so Liftoff is developed with the same skills it generates for projects.
// With --check, fails if the committed copies differ from a fresh render or
// a managed file is left over from a skill that no longer exists.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PackageAssets } from "../src/adapters/assets.ts";
import { agentFilesFor } from "../src/application/agents/agent-files.ts";
import type { AgentHostId } from "../src/plugins/contracts/agent-host.ts";

const root = path.resolve(import.meta.dirname, "..");
/** Claude Code for local work, GitHub Copilot for pull request review. */
const HOSTS: AgentHostId[] = ["claude", "copilot"];
const MANAGED_DIRECTORIES = [
  ".claude/skills",
  ".claude/agents",
  ".github/skills",
  ".github/agents",
  ".agents/skills",
  ".codex/agents",
];
const MARKER = "Managed by Liftoff.";

function managedFilesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (readFileSync(path.join(root, child), "utf8").includes(MARKER)) found.push(child);
    }
  };
  for (const directory of MANAGED_DIRECTORIES) walk(directory);
  return found.sort();
}

const files = await agentFilesFor(new PackageAssets(path.join(root, "assets")), HOSTS);
const wanted = new Set(files.map((file) => file.path));
const stale = managedFilesOnDisk().filter((file) => !wanted.has(file));

if (process.argv.includes("--check")) {
  const problems = files
    .filter((file) => {
      try {
        return readFileSync(path.join(root, file.path), "utf8") !== file.content;
      } catch {
        return true;
      }
    })
    .map((file) => `${file.path} is out of date`);
  problems.push(...stale.map((file) => `${file} is no longer generated`));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`skills: ${problem}`);
    console.error('skills: run "npm run render:skills" and commit the result');
    process.exit(1);
  }
  console.log(`skills: ${files.length} rendered files are up to date`);
} else {
  for (const file of stale) rmSync(path.join(root, file));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    writeFileSync(path.join(root, file.path), file.content);
  }
  console.log(`skills: wrote ${files.length} files, removed ${stale.length} stale files`);
}
