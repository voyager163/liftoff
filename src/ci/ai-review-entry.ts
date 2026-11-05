// Entry point for the bundled AI review pipeline (.github/liftoff/ai-review.mjs).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../adapters/process.ts";
import { main } from "./ai-review.ts";

process.exitCode = await main(process.argv[2], {
  env: process.env,
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
  listFiles: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
  appendFile: (file, text) => appendFileSync(file, text),
  log: (text) => process.stdout.write(text),
  git: async (args) => {
    const result = await run("git", ["-c", "core.quotepath=off", ...args], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    return result.exitCode === 0 && !result.truncated ? result.stdout : undefined;
  },
});
