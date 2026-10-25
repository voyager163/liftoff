// Renders the files Liftoff generates for projects into Liftoff's own
// repository, so Liftoff is developed with exactly what it ships: the review
// skills and agents, the review-policy and AI review workflows, and the agent
// script. With --check, fails if a committed copy differs from a fresh render
// or a managed skill or agent is left over from a source that no longer exists.
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PackageAssets } from "../src/adapters/assets.ts";
import { agentFilesFor } from "../src/application/agents/agent-files.ts";
import { REVIEW_ENGINES } from "../src/plugins/builtin/review/engines.ts";
import { reviewWorkflowFiles, WORKFLOWS } from "../src/plugins/builtin/review/review.ts";
import type { AgentHostId } from "../src/plugins/contracts/agent-host.ts";
import type { TemplateSet } from "../src/plugins/contracts/project-plugin.ts";

const root = path.resolve(import.meta.dirname, "..");
/** Claude Code for local work, GitHub Copilot for pull request review. */
const HOSTS: AgentHostId[] = ["claude", "copilot"];
const SKILL_DIRECTORIES = [
  ".claude/skills",
  ".claude/agents",
  ".github/skills",
  ".github/agents",
  ".agents/skills",
  ".codex/agents",
];
const MARKER = "Managed by Liftoff.";

const assets = new PackageAssets(path.join(root, "assets"), path.join(root, ".github/liftoff"));
const texts = new Map<string, string>();
for (const file of await assets.listTree(WORKFLOWS)) texts.set(file, await assets.readText(file));
const templates: TemplateSet = {
  read: (file) => texts.get(file) ?? "",
  list: (directory) => [...texts.keys()].filter((file) => file.startsWith(`${directory}/`)),
};

const files = [
  ...(await agentFilesFor(assets, HOSTS)),
  ...reviewWorkflowFiles(
    templates,
    {
      policy: ".github/workflows/review-policy.yml",
      refresh: ".github/workflows/review-policy-refresh.yml",
      ai: ".github/workflows/ai-review.yml",
    },
    REVIEW_ENGINES.copilot,
  ),
].sort((a, b) => a.path.localeCompare(b.path));

function managedOnDisk(): string[] {
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
  for (const directory of SKILL_DIRECTORIES) walk(directory);
  return found.sort();
}

const wanted = new Set(files.map((file) => file.path));
const stale = managedOnDisk().filter((file) => !wanted.has(file));

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
    for (const problem of problems) console.error(`own files: ${problem}`);
    console.error('own files: run "npm run render:own" and commit the result');
    process.exit(1);
  }
  console.log(`own files: ${files.length} rendered files are up to date`);
} else {
  for (const file of stale) rmSync(path.join(root, file));
  for (const file of files) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    if (file.path.endsWith(".sh")) chmodSync(target, 0o755);
  }
  console.log(`own files: wrote ${files.length} files, removed ${stale.length} stale files`);
}
