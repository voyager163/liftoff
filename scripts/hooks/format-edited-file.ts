// Claude Code PostToolUse hook: formats the file an edit just touched with
// Biome. Reads the hook event on stdin; never fails the edit.
import { spawnSync } from "node:child_process";
import path from "node:path";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

let file: string | undefined;
try {
  const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    tool_input?: { file_path?: string };
  };
  file = event.tool_input?.file_path;
} catch {
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "../..");
if (!file || path.relative(root, path.resolve(file)).startsWith("..")) process.exit(0);

const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
spawnSync(
  process.execPath,
  [biome, "check", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", file],
  {
    cwd: root,
    stdio: "ignore",
    timeout: 20_000,
  },
);
